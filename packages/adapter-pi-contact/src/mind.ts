// 联系人「脑子」的 pi 实现:用 pi-agent-core 的工具循环跑一轮,上下文完全由宿主的五块决定。
// 需求文档 D06 第 2 小节、D07 第 4 节第 8 条、S-1 实测结论:
//   - prepareRequest 在每次发给模型前回调,返回的 context.messages 整体替换本次请求;
//   - 每轮第一次请求 = 五块:第 1 块作 system(固定前缀,带工具声明 toolsAdded,缓存断点在它末尾),第 2–5 块按顺序放进一条 user 消息;
//   - 同一轮里模型调了工具,之后的请求 = 五块 + 本轮的工具调用与结果,不能清空;五块只在轮与轮之间重拼;
//   - pi 自己累积的 agent.state.messages 只当缓冲,不当真源:每轮新建 Agent,用完即弃。
// 工具只登记动作、不做 I/O(tools.ts);宿主校验、分配 action_id、落盘后才执行。
// 密钥只由调用方传入,只在发请求时交给 pi-ai;不读环境变量,不进返回值、错误信息和日志。
// 用量(AC-39 ⑤):每次请求结束把 usage 连同线路(服务商|主机名|模型,不含路径里的令牌)、请求序号、前缀哈希交给宿主的回执口(usage.ts)。
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, type SimpleStreamOptions, type SystemMessage, toToolDeclaration, type UserMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { BLOCK_LABELS, type BlockNo, type ContactMind, type MindAction, plainData, type RoundBlock, type RoundInput, type RoundOutput, type RoundTools, type UsageSink } from "@g-group/kernel";
import { parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";
import { placeBreakpoints, probeRequest, type RequestProbe, report, usageLine, usageOf } from "./usage.ts";

export interface PiContactMindOptions {
  /** 模型协议。本片只接 Anthropic Messages 兼容端点(默认即此)。 */
  readonly api?: "anthropic-messages";
  /** 服务商标识(进 pi 的 provider 字段,不含密钥),例如 "anthropic"、"magpie"。 */
  readonly provider: string;
  /** 模型 id,原样发给端点;必须与 RoundInput.contact.speakingModel 一致,不一致整轮拒绝(不静默换模)。 */
  readonly model: string;
  /** Anthropic 兼容端点根地址(SDK 会接 /v1/messages)。 */
  readonly baseUrl: string;
  /** 密钥,由调用方传入。适配器不读环境变量。 */
  readonly apiKey: string;
  /** 密钥放哪个请求头:x-api-key(默认,Anthropic API 密钥)或 Authorization: Bearer(网关令牌)。 */
  readonly authHeader?: "x-api-key" | "bearer";
  /** 单次回复的输出上限,默认 4096。 */
  readonly maxTokens?: number;
  /** 模型上下文窗口,默认 200000(只用于 pi 的模型描述)。 */
  readonly contextWindow?: number;
  /** 第 1 块缓存断点的保留时长,默认 "short"。第 1 块 cacheBreakpoint 为 false 时不设缓存。 */
  readonly cacheRetention?: "short" | "long";
  /** 一轮最多发几次请求(含工具往返),默认 8;到上限模型仍在调工具则整轮失败。 */
  readonly maxRequestsPerRound?: number;
  /** HTTP 传输,默认 globalThis.fetch。代理、录制与测试用;请求体由 pi-ai 的 Anthropic 适配照常构造。 */
  readonly fetch?: typeof globalThis.fetch;
}

export type PiContactMindErrorCode = "invalid-options" | "invalid-request" | "model-mismatch" | "provider-error" | "request-limit" | "internal";
/** 可辨认的失败。message 已隐去密钥。 */
export class PiContactMindError extends Error {
  readonly code: PiContactMindErrorCode;
  constructor(code: PiContactMindErrorCode, message: string) {
    super(message);
    this.name = "PiContactMindError";
    this.code = code;
  }
}
/** 宿主中止本轮(signal abort)。name 为 AbortError,便于按惯例识别。 */
export class RoundAbortedError extends Error {
  readonly code = "aborted" as const;
  constructor() {
    super("本轮已被宿主中止");
    this.name = "AbortError";
  }
}
export const isRoundAborted = (e: unknown): e is RoundAbortedError => e instanceof RoundAbortedError;

/** 第 2–5 块在 user 消息里的呈现:每块一个文本段,带块号与标签,空块也占位。 */
export function renderBlock(b: RoundBlock): string {
  return `<block n="${b.block}" label="${b.label}">\n${b.text}\n</block>`;
}

interface Resolved {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly authHeader: "x-api-key" | "bearer";
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly cacheRetention: "short" | "long";
  readonly maxRequestsPerRound: number;
  readonly fetch: typeof globalThis.fetch | undefined;
}

const OPTION_KEYS = new Set(["api", "provider", "model", "baseUrl", "apiKey", "authHeader", "maxTokens", "contextWindow", "cacheRetention", "maxRequestsPerRound", "fetch"]);

function resolveOptions(opts: unknown): Resolved {
  const bad = (why: string): never => { throw new PiContactMindError("invalid-options", `createPiContactMind 选项不合格:${why}`); };
  const p = plainData(opts, "opts", { topFunctions: true });
  if (!p.ok) return bad(`${p.path} ${p.why}`);
  const o = p.value;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return bad("必须是对象");
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!OPTION_KEYS.has(k)) bad(`未知字段 ${k}`);
  const text = (k: string): string => {
    const v = r[k];
    if (typeof v !== "string" || v.trim() === "") return bad(`${k} 必须是非空字符串`);
    return v;
  };
  const int = (k: string, dflt: number, min: number, max: number): number => {
    const v = r[k];
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return bad(`${k} 必须是 ${min}–${max} 的整数`);
    return v;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[], dflt: T): T => {
    const v = r[k];
    if (v === undefined) return dflt;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return bad(`${k} 只能是 ${allowed.join(" / ")}`);
    return v as T;
  };
  oneOf("api", ["anthropic-messages"], "anthropic-messages");
  const fetchFn = r.fetch;
  if (fetchFn !== undefined && typeof fetchFn !== "function") bad("fetch 必须是函数");
  const baseUrl = text("baseUrl");
  let url: URL;
  try { url = new URL(baseUrl); } catch { return bad("baseUrl 不是合法 URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad("baseUrl 必须是 http(s)");
  return {
    provider: text("provider"),
    model: text("model"),
    baseUrl,
    apiKey: text("apiKey"),
    authHeader: oneOf("authHeader", ["x-api-key", "bearer"], "x-api-key"),
    maxTokens: int("maxTokens", 4096, 1, 1_000_000),
    contextWindow: int("contextWindow", 200_000, 1, 100_000_000),
    cacheRetention: oneOf("cacheRetention", ["short", "long"], "short"),
    maxRequestsPerRound: int("maxRequestsPerRound", 8, 1, 64),
    fetch: fetchFn as typeof globalThis.fetch | undefined,
  };
}

/** 校验并取出本轮的五块(冻结副本)。块号必须正好 1–5 依次出现,标签与 BLOCK_LABELS 一致;缓存断点只允许在第 1 块。 */
function readRound(input: unknown, model: string): { blocks: readonly RoundBlock[] } {
  const bad = (why: string): never => { throw new PiContactMindError("invalid-request", `本轮输入不合格:${why}`); };
  const p = plainData(input, "input");
  if (!p.ok) return bad(`${p.path} ${p.why}`);
  const x = p.value as { contact?: { speakingModel?: unknown }; request?: { blocks?: unknown } } | null;
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
  return { blocks: blocks as readonly RoundBlock[] };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createPiContactMind(opts: PiContactMindOptions): ContactMind {
  const cfg = resolveOptions(opts);
  const redact = (s: string): string => s.split(cfg.apiKey).join("[密钥已隐去]");
  const model: Model<"anthropic-messages"> = {
    id: cfg.model,
    name: cfg.model,
    api: "anthropic-messages",
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  };
  const api = anthropicMessagesApi();
  const declarations = TOOL_DECLARATIONS.map((d) => toToolDeclaration({ name: d.name, description: d.description, parameters: d.parameters }));
  const line = usageLine(cfg.provider, cfg.baseUrl, cfg.model, cfg.apiKey);

  async function round(input: RoundInput, signal: AbortSignal, tools?: RoundTools, usage?: UsageSink): Promise<RoundOutput> {
    if (!(signal instanceof AbortSignal)) throw new PiContactMindError("invalid-request", "signal 必须是 AbortSignal");
    if (signal.aborted) throw new RoundAbortedError();
    const { blocks } = readRound(input, cfg.model);
    const [b1, ...rest] = blocks as [RoundBlock, ...RoundBlock[]];
    const now = Date.now();
    // 第 1 块:system,带工具声明(S-1:宿主拼装要带上 system 里的 toolsAdded,provider 从这里取工具清单)
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
    let last: AssistantMessage | undefined;
    // 本次请求的实际请求体探测(前缀哈希、断点个数):onPayload 里算,这次请求的 assistant 消息结束时连同 usage 回报
    let probe: RequestProbe | null = null;
    const keyOpts: Partial<SimpleStreamOptions> = cfg.authHeader === "bearer" ? {} : { apiKey: cfg.apiKey };
    const streamFn: StreamFn = (m, ctx, o) => api.streamSimple(m, ctx, {
      ...o,
      ...keyOpts,
      ...(cfg.authHeader === "bearer" ? { headers: { ...o?.headers, authorization: `Bearer ${cfg.apiKey}` } } : {}),
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
      maxTokens: cfg.maxTokens,
      cacheRetention: b1.cacheBreakpoint ? cfg.cacheRetention : "none",
      onPayload: async (payload, m) => {
        const prior = await o?.onPayload?.(payload, m);
        const placed = placeBreakpoints(prior === undefined ? payload : prior);
        probe = probeRequest(placed);
        return placed;
      },
    });
    const agent = new Agent({
      initialState: { model, tools: agentTools, thinkingLevel: "off" },
      streamFn,
      toolExecution: "sequential",
      prepareRequest: ({ context }) => {
        requests++;
        return { context: { ...context, messages: [...base, ...exchange] } };
      },
      finishTurn: (turn) => {
        if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
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
      if (m.role === "assistant") {
        exchange.push(m);
        last = m;
        report(usage, usageOf(line, requests, probe, m.usage));
        probe = null;
      }
      else if (m.role === "toolResult") exchange.push(m);
    });
    const onAbort = () => agent.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // 起始消息只是触发;真正发出的内容由 prepareRequest 换成五块
      await agent.prompt(fresh);
    } catch (e) {
      if (signal.aborted) throw new RoundAbortedError();
      throw new PiContactMindError("internal", redact(describe(e)));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new RoundAbortedError();
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
