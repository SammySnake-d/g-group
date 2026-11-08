// 状态笔记压缩器的 pi 实现(D06 第 2 小节第 3 块、D25 第 8 节;AC-32 ③)。
// 一次独立、无状态的模型调用:system = 压缩说明(含 STATE_NOTE_GUIDE),user = 旧笔记 + 本轮材料(+ 字节上限);不带工具、
// 不带联系人五块与人设,所以不进联系人会话、不动第 1 块缓存前缀。模型必须等于请求里联系人的说话模型,不一致一次都不发;
// 端点报错如实抛出(隐去密钥),不换模型或厂商重试。压缩用哪个模型、配置失配怎么拦截归 D 件(AC-32),这里只按联系人的说话模型调用。
import { type AssistantMessage, type Model, normalizeContext, type SystemMessage, type UserMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { type CompactRequest, type ContactCompactor, plainData, type ReflectRequest, type ReflectResult, STATE_NOTE_GUIDE } from "@g-group/kernel";
import { PiContactMindError, type PiContactMindOptions } from "./mind.ts";

export type PiCompactorOptions = Omit<PiContactMindOptions, "maxRequestsPerRound" | "cacheRetention">;

const KEYS = new Set(["api", "provider", "model", "baseUrl", "apiKey", "authHeader", "maxTokens", "contextWindow", "fetch"]);

function resolve(opts: unknown) {
  const bad = (why: string): never => { throw new PiContactMindError("invalid-options", `createPiCompactor 选项不合格:${why}`); };
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
  try { new URL(baseUrl); } catch { bad("baseUrl 不是合法 URL"); }
  return {
    provider: text("provider"),
    model: text("model"),
    baseUrl,
    apiKey: text("apiKey"),
    bearer: r.authHeader === "bearer",
    maxTokens: int("maxTokens", 4096, 1_000_000),
    contextWindow: int("contextWindow", 200_000, 100_000_000),
    fetch: r.fetch as typeof globalThis.fetch | undefined,
  };
}

const SYSTEM = [
  "你替一位联系人整理它的状态笔记。你不和任何人对话,只输出新的状态笔记正文,不加解释、不加前后缀。",
  STATE_NOTE_GUIDE,
  "旧笔记里仍然有效的事实保留;本轮材料里新出现的要求、改动和结果并进去;已经了结的事删掉。不要编造材料里没有的进展。",
].join("\n");

function userText(req: CompactRequest): string {
  const prev = req.previous === null ? "(没有旧笔记)" : req.previous;
  const limit = req.maxBytes === null ? "" : `\n新笔记不超过 ${req.maxBytes} 字节(UTF-8)。`;
  if (req.kind === "shrink") return `[旧状态笔记]\n${prev}\n\n请在不丢掉仍有效的要求、对象、数值和条件的前提下缩写这份笔记。${limit}`;
  return `[旧状态笔记]\n${prev}\n\n${req.material}\n请据此写出新的状态笔记。${limit}`;
}

export function createPiCompactor(opts: PiCompactorOptions): ContactCompactor {
  const cfg = resolve(opts);
  const redact = (s: string) => s.split(cfg.apiKey).join("[密钥已隐去]");
  const model: Model<"anthropic-messages"> = {
    id: cfg.model, name: cfg.model, api: "anthropic-messages", provider: cfg.provider, baseUrl: cfg.baseUrl, reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: cfg.contextWindow, maxTokens: cfg.maxTokens,
  };
  const api = anthropicMessagesApi();
  async function compact(input: CompactRequest, signal: AbortSignal): Promise<string> {
    const p = plainData(input, "压缩请求");
    if (!p.ok) throw new PiContactMindError("invalid-request", `压缩请求不合格:${p.path} ${p.why}`);
    const req = p.value as CompactRequest;
    const speaking = req?.contact?.speakingModel;
    if (typeof speaking !== "string") throw new PiContactMindError("invalid-request", "contact.speakingModel 必须是字符串");
    if (speaking !== cfg.model) throw new PiContactMindError("model-mismatch", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};压缩只用说话模型,不静默换模`);
    if (req.kind !== "round-note" && req.kind !== "shrink") throw new PiContactMindError("invalid-request", "kind 只能是 round-note 或 shrink");
    const now = Date.now();
    const system: SystemMessage = { role: "system", content: SYSTEM, timestamp: now };
    const user: UserMessage = { role: "user", content: [{ type: "text", text: userText(req) }], timestamp: now };
    let msg: AssistantMessage;
    try {
      msg = await api
        .streamSimple(model, normalizeContext({ messages: [system, user] }), {
          signal,
          maxTokens: cfg.maxTokens,
          cacheRetention: "none",
          ...(cfg.bearer ? { headers: { authorization: `Bearer ${cfg.apiKey}` } } : { apiKey: cfg.apiKey }),
          ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
        })
        .result();
    } catch (e) {
      throw new PiContactMindError("provider-error", redact(`压缩请求失败:${e instanceof Error ? e.message : String(e)}`));
    }
    if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new PiContactMindError("provider-error", redact(`压缩请求失败(${msg.stopReason}):${msg.errorMessage ?? "无错误信息"}`));
    const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    if (text === "") throw new PiContactMindError("provider-error", "压缩器返回了空笔记");
    return text;
  }
  async function reflect(_req: ReflectRequest, _signal: AbortSignal): Promise<ReflectResult> {
    throw new PiContactMindError("internal", "红提交:空壳");
  }
  return Object.freeze({ compact, reflect });
}
