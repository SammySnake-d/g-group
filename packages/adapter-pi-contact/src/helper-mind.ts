// Helper「脑子」的 pi 实现(AC-52,U04;D07.0 Helper 专属 MCP):用 pi-agent-core 的工具循环跑一次,工具来自 Helper MCP 的 tools/list,
// 每次调用走 MCP tools/call(宿主进程内是内存传输)——工具是真执行,结果回给模型继续,直到给出文字回复。
// 和联系人脑子(mind.ts)同一套写法:prepareRequest 每次发请求前整体替换上下文(system + 本次 user 消息 + 本次的工具往返),
// 每次新建 Agent、用完即弃;每次最多发 maxRequestsPerRound 次请求,到上限模型仍在调工具则整次失败(request-limit);错误码与 mind.ts 一致。
// 密钥只由调用方传入,只在发请求时交给 pi-ai;不读环境变量,不进返回值、错误信息和日志。
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, type SimpleStreamOptions, type SystemMessage, toToolDeclaration, type UserMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { HELPER_MCP_PROTOCOL, type HelperMind, type HelperMindInput, type HelperMindOutput, type McpClient, plainData, renderHelperPrompt } from "@g-group/kernel";
import { PiContactMindError, type PiContactMindOptions, RoundAbortedError } from "./mind.ts";

export type PiHelperMindOptions = Omit<PiContactMindOptions, "cacheRetention">;

const KEYS = new Set(["api", "provider", "model", "baseUrl", "apiKey", "authHeader", "maxTokens", "contextWindow", "maxRequestsPerRound", "fetch"]);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function resolve(opts: unknown) {
  const bad = (why: string): never => {
    throw new PiContactMindError("invalid-options", `createPiHelperMind 选项不合格:${why}`);
  };
  const p = plainData(opts, "opts", { topFunctions: true });
  if (!p.ok) return bad(`${p.path} ${p.why}`);
  const o = p.value;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return bad("必须是对象");
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KEYS.has(k)) bad(`未知字段 ${k}`);
  const text = (k: string): string => (typeof r[k] === "string" && (r[k] as string).trim() !== "" ? (r[k] as string) : bad(`${k} 必须是非空字符串`));
  if (r.api !== undefined && r.api !== "anthropic-messages") bad("api 只能是 anthropic-messages");
  if (r.authHeader !== undefined && r.authHeader !== "x-api-key" && r.authHeader !== "bearer") bad("authHeader 只能是 x-api-key / bearer");
  if (r.fetch !== undefined && typeof r.fetch !== "function") bad("fetch 必须是函数");
  const int = (k: string, d: number, max: number): number => {
    const v = r[k];
    if (v === undefined) return d;
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : bad(`${k} 必须是 1–${max} 的整数`);
  };
  const baseUrl = text("baseUrl");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return bad("baseUrl 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad("baseUrl 必须是 http(s)");
  return {
    provider: text("provider"),
    model: text("model"),
    baseUrl,
    apiKey: text("apiKey"),
    bearer: r.authHeader === "bearer",
    maxTokens: int("maxTokens", 4096, 1_000_000),
    contextWindow: int("contextWindow", 200_000, 100_000_000),
    maxRequestsPerRound: int("maxRequestsPerRound", 8, 64),
    fetch: r.fetch as typeof globalThis.fetch | undefined,
  };
}

/** 校验一次输入:模型必须等于绑定的模型(不静默换模)。 */
function readInput(input: unknown, model: string): HelperMindInput {
  const bad = (why: string): never => {
    throw new PiContactMindError("invalid-request", `Helper 输入不合格:${why}`);
  };
  const p = plainData(input, "input");
  if (!p.ok) return bad(`${p.path} ${p.why}`);
  const x = p.value as Partial<HelperMindInput> | null;
  if (!x || typeof x !== "object") return bad("input 必须是对象");
  if (typeof x.model !== "string") return bad("model 必须是字符串");
  if (x.model !== model) throw new PiContactMindError("model-mismatch", `Helper 要用的模型是 ${x.model},这个 mind 绑定的是 ${model};不静默换模`);
  if (typeof x.text !== "string" || !x.text.trim()) bad("text 必须是非空字符串");
  if (typeof x.context !== "string" || typeof x.skill !== "string") bad("context 与 skill 必须是字符串");
  if (!Array.isArray(x.history)) bad("history 必须是数组");
  if (!x.route || typeof x.route !== "object") bad("route 必须是对象");
  return x as HelperMindInput;
}

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
/** 从 Helper MCP 取工具清单(initialize → tools/list)。 */
async function listTools(mcp: McpClient): Promise<ListedTool[]> {
  const bad = (why: string): never => {
    throw new PiContactMindError("invalid-request", `Helper MCP 工具清单不合格:${why}`);
  };
  await mcp.request("initialize", { protocolVersion: HELPER_MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "g-group-helper-pi", version: "0.1.0" } });
  const r = (await mcp.request("tools/list", {})) as { tools?: unknown } | null;
  if (!r || !Array.isArray(r.tools)) return bad("tools/list 没有 tools 数组");
  const seen = new Set<string>();
  return r.tools.map((t: unknown) => {
    const x = t as Partial<ListedTool> | null;
    if (!x || typeof x.name !== "string" || !TOOL_NAME.test(x.name)) return bad(`工具名 ${String(x?.name)} 不合规`);
    if (seen.has(x.name)) bad(`工具名 ${x.name} 重复`);
    seen.add(x.name);
    if (!x.inputSchema || typeof x.inputSchema !== "object") bad(`${x.name} 缺 inputSchema`);
    return { name: x.name, description: typeof x.description === "string" ? x.description : "", inputSchema: x.inputSchema as Readonly<Record<string, unknown>> };
  });
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const textOf = (m: AssistantMessage): string =>
  m.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

export function createPiHelperMind(opts: PiHelperMindOptions): HelperMind {
  const cfg = resolve(opts);
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

  async function run(raw: HelperMindInput, signal: AbortSignal, mcp: McpClient): Promise<HelperMindOutput> {
    if (!(signal instanceof AbortSignal)) throw new PiContactMindError("invalid-request", "signal 必须是 AbortSignal");
    if (signal.aborted) throw new RoundAbortedError();
    if (!mcp || typeof mcp.request !== "function") throw new PiContactMindError("invalid-request", "缺 Helper MCP 客户端");
    const input = readInput(raw, cfg.model);
    let tools: ListedTool[];
    try {
      tools = await listTools(mcp);
    } catch (e) {
      if (e instanceof PiContactMindError) throw e;
      throw new PiContactMindError("internal", `Helper MCP 不可用:${describe(e)}`);
    }
    const { system: sysText, user: userText } = renderHelperPrompt(input);
    const declarations = tools.map((t) => toToolDeclaration({ name: t.name, description: t.description, parameters: t.inputSchema }));
    const now = Date.now();
    const system: SystemMessage = { role: "system", content: sysText, toolsAdded: declarations, timestamp: now };
    const fresh: UserMessage = { role: "user", content: [{ type: "text", text: userText }], timestamp: now };
    const base: readonly AgentMessage[] = [system, fresh];

    const calls: { name: string; args: unknown; ok: boolean; text: string }[] = [];
    const agentTools: AgentTool[] = tools.map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.inputSchema,
      executionMode: "sequential",
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<null>> => {
        let r: { ok: boolean; text: string };
        try {
          const got = (await mcp.request("tools/call", { name: t.name, arguments: params })) as { content?: { type: string; text?: string }[]; isError?: boolean } | null;
          const text = (got?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
          r = { ok: got?.isError !== true, text };
        } catch (e) {
          r = { ok: false, text: `Helper MCP 调用失败:${describe(e)}` };
        }
        calls.push({ name: t.name, args: params, ok: r.ok, text: r.text });
        return { content: [{ type: "text", text: r.text || (r.ok ? "完成" : "失败") }], details: null, ...(r.ok ? {} : { isError: true }) };
      },
    }));

    const exchange: AgentMessage[] = [];
    let requests = 0;
    let limitHit = false;
    let last: AssistantMessage | undefined;
    const keyOpts: Partial<SimpleStreamOptions> = cfg.bearer ? {} : { apiKey: cfg.apiKey };
    const streamFn: StreamFn = (m, ctx, o) =>
      api.streamSimple(m, ctx, {
        ...o,
        ...keyOpts,
        ...(cfg.bearer ? { headers: { ...o?.headers, authorization: `Bearer ${cfg.apiKey}` } } : {}),
        ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
        maxTokens: cfg.maxTokens,
        cacheRetention: "none",
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
      } else if (m.role === "toolResult") exchange.push(m);
    });
    const onAbort = () => agent.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(fresh);
    } catch (e) {
      if (signal.aborted) throw new RoundAbortedError();
      throw new PiContactMindError("internal", redact(describe(e)));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new RoundAbortedError();
    if (limitHit) throw new PiContactMindError("request-limit", `这次已发 ${requests} 次请求,模型仍在调工具;上限 ${cfg.maxRequestsPerRound}`);
    const end = last as AssistantMessage | undefined;
    if (!end) throw new PiContactMindError("internal", "这次没有收到模型回复");
    if (end.stopReason === "error" || end.stopReason === "aborted") {
      throw new PiContactMindError("provider-error", redact(`模型请求失败(${end.stopReason}):${end.errorMessage ?? "无错误信息"}`));
    }
    return Object.freeze({ reply: textOf(end), calls: Object.freeze(calls.map((c) => Object.freeze(c))) });
  }

  return Object.freeze({ run });
}
