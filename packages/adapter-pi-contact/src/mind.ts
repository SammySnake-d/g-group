// 联系人「脑子」的 pi 实现:用 pi-agent-core 的工具循环跑一轮,上下文完全由宿主的五块决定。
// 需求文档 D06 第 2 小节、D07 第 4 节第 8 条、S-1 实测结论:
//   - prepareRequest 在每次发给模型前回调,返回的 context.messages 整体替换本次请求;
//   - 每轮第一次请求 = 五块:第 1 块作 system(固定前缀,带工具声明 toolsAdded,缓存断点在它末尾),第 2–5 块按顺序放进一条 user 消息;
//   - 同一轮里模型调了工具,之后的请求 = 五块 + 本轮的工具调用与结果,不能清空;五块只在轮与轮之间重拼;
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type SystemMessage, toToolDeclaration, type UserMessage } from "@earendil-works/pi-ai";
import { BLOCK_LABELS, type BlockNo, type ContactMind, type MindAction, plainData, type RoundBlock, type RoundInput, type RoundOutput, type RoundTools, type UsageSink } from "@g-group/kernel";
import { PiContactMindError, RoundAbortedError } from "./errors.ts";
import { modelForProtocol, type PiAuthHeader, type PiProtocol, type ProtocolHealthCache } from "./protocols.ts";
import { type Attempt, describe, resolveOptions, sessionFor, streamRequest, withProtocols } from "./request.ts";
import { parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

export interface PiContactMindOptions {
  readonly api?: PiProtocol;
  readonly protocols?: readonly PiProtocol[];
  readonly healthCache?: ProtocolHealthCache;
  readonly sessionAffinity?: boolean;
  readonly reasoning?: boolean;
  readonly provider: string;
  /** 模型 id,原样发给端点;必须与 RoundInput.contact.speakingModel 一致,不一致整轮拒绝(不静默换模)。 */
  readonly model: string;
  /** 服务端根地址,由所选协议拼接请求路径。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly authHeader?: PiAuthHeader;
  readonly maxTokens?: number;
  /** 模型上下文窗口,默认 200000(只用于 pi 的模型描述)。 */
  readonly contextWindow?: number;
  readonly cacheRetention?: "short" | "long";
  /** 一轮最多发几次请求(含工具往返),默认 8;到上限模型仍在调工具则整轮失败。 */
  readonly maxRequestsPerRound?: number;
  /** HTTP 传输,默认 globalThis.fetch。代理、录制与测试用;请求体由 pi-ai 的原生协议适配器构造。 */
  readonly fetch?: typeof globalThis.fetch;
}

export { PiContactMindError, type PiContactMindErrorCode, RoundAbortedError, isRoundAborted } from "./errors.ts";

export function renderBlock(b: RoundBlock): string {
  return `<block n="${b.block}" label="${b.label}">\n${b.text}\n</block>`;
}

/** 校验并取出本轮的五块(冻结副本)。块号必须正好 1–5 依次出现,标签与 BLOCK_LABELS 一致;缓存断点只允许在第 1 块。 */
function readRound(input: unknown, model: string): { blocks: readonly RoundBlock[]; contactId: string } {
  const bad = (why: string): never => { throw new PiContactMindError("invalid-request", `本轮输入不合格:${why}`); };
  const p = plainData(input, "input");
  if (!p.ok) return bad(`${p.path} ${p.why}`);
  const x = p.value as { contact?: { speakingModel?: unknown; id?: unknown }; request?: { blocks?: unknown } } | null;
  if (!x || typeof x !== "object") return bad("input 必须是对象");
  const speaking = x.contact?.speakingModel;
  if (typeof speaking !== "string") return bad("contact.speakingModel 必须是字符串");
  if (speaking !== model) throw new PiContactMindError("model-mismatch", `联系人的说话模型是 ${speaking},这个 mind 绑定的是 ${model};不静默换模`);
  const blocks = x.request?.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 5) return bad("request.blocks 必须正好 5 块");
  for (const [i, b] of (blocks as unknown[]).entries()) {
    const n = (i + 1) as BlockNo;
    const rb = b as Partial<RoundBlock> | null;
    if (!rb || typeof rb !== "object") bad(`第 ${n} 项不是对象`);
    else {
      if (rb.block !== n) bad(`第 ${n} 项的块号是 ${String(rb.block)},块必须按 1–5 依次排列`);
      if (rb.label !== BLOCK_LABELS[n]) bad(`第 ${n} 块的标签应为 ${BLOCK_LABELS[n]}`);
      if (typeof rb.text !== "string") bad(`第 ${n} 块的 text 必须是字符串`);
      if (typeof rb.cacheBreakpoint !== "boolean") bad(`第 ${n} 块的 cacheBreakpoint 必须是布尔值`);
      if (n > 1 && rb.cacheBreakpoint) bad(`缓存断点只能在第 1 块末尾,第 ${n} 块不行`);
    }
  }
  if ((blocks[0] as RoundBlock).text.trim() === "") bad("第 1 块(固定前缀)不能为空");
  return { blocks: blocks as readonly RoundBlock[], contactId: typeof x.contact?.id === "string" ? x.contact.id : model };
}

export function createPiContactMind(opts: PiContactMindOptions): ContactMind {
  const cfg = resolveOptions(opts, "mind");
  const redact = cfg.redact;
  const declarations = TOOL_DECLARATIONS.map((d) => toToolDeclaration({ name: d.name, description: d.description, parameters: d.parameters }));

  async function round(input: RoundInput, signal: AbortSignal, tools?: RoundTools, usage?: UsageSink): Promise<RoundOutput> {
    if (!(signal instanceof AbortSignal)) throw new PiContactMindError("invalid-request", "signal 必须是 AbortSignal");
    if (signal.aborted) throw new RoundAbortedError();
    const { blocks, contactId } = readRound(input, cfg.model);
    const sessionId = sessionFor(cfg, "contact", contactId);
    return (await withProtocols(cfg, signal, (attempt) => run(blocks, attempt, sessionId, signal, tools, usage))).value;
  }

  async function run(blocks: readonly RoundBlock[], attempt: Attempt, sessionId: string | undefined, signal: AbortSignal, tools?: RoundTools, usage?: UsageSink): Promise<RoundOutput> {
    const [b1, ...rest] = blocks as [RoundBlock, ...RoundBlock[]];
    const now = Date.now();
    const system: SystemMessage = { role: "system", content: b1.text, toolsAdded: declarations, timestamp: now };
    const fresh: UserMessage = { role: "user", content: rest.map((b) => ({ type: "text" as const, text: renderBlock(b) })), timestamp: now };
    const base: readonly AgentMessage[] = [system, fresh];

    const actions: MindAction[] = [];
    let stateNote: string | null = null;
    const agentTools: AgentTool[] = TOOL_DECLARATIONS.map((d) => ({
      name: d.name,
      label: d.name,
      description: d.description,
      parameters: d.parameters,
      executionMode: "sequential",
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<null>> => {
        const r = parseToolCall(d.name, params);
        if (!r.ok) return { content: [{ type: "text", text: `未登记:参数不合形状(${r.why})。请按工具说明修正后重新调用。` }], details: null, isError: true };
        if (r.value.kind === "read-task") {
          const task = await tools?.readTask?.(r.value.id);
          return { content: [{ type: "text", text: task ?? "本轮读不到这个任务" }], details: null, ...(task ? {} : { isError: true }) };
        }
        if (r.value.kind === "query-history") {
          const q = r.value.query;
          if (!tools?.queryHistory) return { content: [{ type: "text", text: "本轮没有找旧消息的查询口" }], details: null, isError: true };
          let got: string | null;
          try {
            got = await tools.queryHistory(q);
          } catch (e) {
            return { content: [{ type: "text", text: `找旧消息出错(不代表没说过):${redact(describe(e))}` }], details: null, isError: true };
          }
          if (got === null) return { content: [{ type: "text", text: q.kind === "search" ? `${q.roomId ?? "本轮"}不在本轮可查的会话里` : `读不到 ${q.roomId} #${q.seq}(不在本轮会话里或没有这条)` }], details: null, isError: true };
          return { content: [{ type: "text", text: got }], details: null };
        }
        if (r.value.kind === "read-linked") {
          if (!tools?.readLinked) return { content: [{ type: "text", text: "本轮没有关联查询口" }], details: null, isError: true };
          const got = await tools.readLinked(r.value.query);
          if (got === null) return { content: [{ type: "text", text: `读不到关联记录(${r.value.query.linkedRoomId ?? r.value.query.roomId} 不在本轮可查的范围里,或没有这个关联)` }], details: null, isError: true };
          return { content: [{ type: "text", text: got }], details: null };
        }
        if (r.value.kind === "read-quote") {
          const got = tools?.readQuoteParent ? await tools.readQuoteParent(r.value.roomId, r.value.seq) : null;
          if (got === null) return { content: [{ type: "text", text: tools?.readQuoteParent ? `读不到 ${r.value.roomId} #${r.value.seq}` : "本轮没有引用链查询口" }], details: null, isError: true };
          return { content: [{ type: "text", text: got }], details: null };
        }
        if (r.value.kind === "read") {
          const got = tools ? await tools.readMemory(r.value.id) : null;
          if (got === null) return { content: [{ type: "text", text: tools ? `没有这条记忆:${r.value.id}` : "本轮没有可用的记忆查询口" }], details: null, isError: true };
          return { content: [{ type: "text", text: got }], details: null };
        }
        if (r.value.kind === "progress-get") {
          const got = tools?.progressGet ? await tools.progressGet(r.value.id, r.value.roomId) : null;
          if (got === null) return { content: [{ type: "text", text: tools?.progressGet ? `在 ${r.value.roomId} 看不到单元 ${r.value.id}` : "本轮没有运行台账查询口" }], details: null, isError: true };
          return { content: [{ type: "text", text: got }], details: null };
        }
        if (r.value.kind === "note") {
          stateNote = r.value.note;
          return { content: [{ type: "text", text: "状态笔记已登记。" }], details: null };
        }
        actions.push(r.value.action);
        return { content: [{ type: "text", text: `已登记(本轮第 ${actions.length} 个动作:${r.value.action.kind})。宿主会在本轮结束后校验并执行,这里不会有执行结果。` }], details: null };
      },
    }));

    // 本轮的工具往返:第一次请求之后出现的 assistant / toolResult 消息,按出现顺序
    const exchange: AgentMessage[] = [];
    let requests = 0;
    let limitHit = false;
    let truncated = false;
    let last: AssistantMessage | undefined;
    const model = modelForProtocol(attempt.protocol, cfg);
    const streamFn: StreamFn = (_m, ctx, options) => streamRequest(cfg, attempt, ctx, {
      options, cache: b1.cacheBreakpoint, request: requests, sessionId, ...(usage ? { sink: usage } : {}),
    });
    const agent = new Agent({
      initialState: { model, tools: agentTools, thinkingLevel: "off" },
      streamFn,
      toolExecution: "sequential",
      prepareRequest: ({ context }) => {
        requests++;
        if (requests > 1) attempt.committed = true;
        return { context: { ...context, messages: [...base, ...exchange] } };
      },
      finishTurn: (turn) => {
        if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
        if (turn.message.stopReason === "length") {
          truncated = true;
          return { action: "end" };
        }
        if (turn.toolResults.length > 0 && requests >= cfg.maxRequestsPerRound) {
          limitHit = true;
          return { action: "end" };
        }
        return undefined;
      },
    });
    agent.subscribe((ev) => {
      if (ev.type !== "message_end" || requests === 0) return;
      const m = ev.message;
      if (m.role === "assistant") { exchange.push(m); last = m; }
      else if (m.role === "toolResult") exchange.push(m);
    });
    const onAbort = () => agent.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(fresh);
    } catch (e) {
      if (signal.aborted) throw new RoundAbortedError();
      if (e instanceof PiContactMindError) throw e;
      throw new PiContactMindError("internal", redact(describe(e)));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new RoundAbortedError();
    if (truncated) {
      const retryableTruncation = cfg.protocols.length === 1 && requests === 1 && last?.content.length === 0;
      throw new PiContactMindError("provider-error", "模型回复达到输出上限而被截断,整轮未提交", false, retryableTruncation);
    }
    if (limitHit) throw new PiContactMindError("request-limit", `本轮已发 ${requests} 次请求,模型仍在调工具;上限 ${cfg.maxRequestsPerRound}`);
    const end = last as AssistantMessage | undefined;
    if (!end) throw new PiContactMindError("internal", "本轮没有收到模型回复");
    if (end.stopReason === "error" || end.stopReason === "aborted") {
      throw new PiContactMindError("provider-error", redact(`模型请求失败(${end.stopReason}):${end.errorMessage ?? "无错误信息"}`));
    }
    return Object.freeze({ actions: Object.freeze([...actions]), stateNote });
  }

  return Object.freeze({ round });
}
