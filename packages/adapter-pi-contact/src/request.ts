import { createHash } from "node:crypto";
import { types } from "node:util";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { plainData, type ModelUsage, type UsageSink } from "@g-group/kernel";
import { PiContactMindError, isRoundAborted, RoundAbortedError } from "./errors.ts";
import { authHeaderFor, keyOptions, modelForProtocol, PROTOCOLS, type ModelConfig, type PiAuthHeader, type PiProtocol, ProtocolHealthCache, protocolFor } from "./protocols.ts";
import { placeBreakpoints, probeRequest, recordUsage, type RequestProbe, usageLine, usageOf } from "./usage.ts";

export interface Resolved extends ModelConfig {
  readonly apiKey: string;
  readonly auth: ReadonlyMap<PiProtocol, PiAuthHeader>;
  readonly protocols: readonly PiProtocol[];
  readonly healthCache: ProtocolHealthCache;
  readonly maxRequestsPerRound: number;
  readonly cacheRetention: "short" | "long";
  readonly fetch: typeof globalThis.fetch | undefined;
  redact(message: string): string;
}

const COMMON = new Set(["api", "protocols", "healthCache", "sessionAffinity", "reasoning", "provider", "model", "baseUrl", "apiKey", "authHeader", "maxTokens", "contextWindow", "fetch"]);
export const describe = (e: unknown): string => e instanceof Error ? e.message : String(e);

export function resolveOptions(opts: unknown, profile: "mind" | "compactor" | "probe"): Resolved {
  const bad = (why: string): never => { throw new PiContactMindError("invalid-options", `${profile} 选项不合格:${why}`); };
  if (typeof opts !== "object" || opts === null || types.isProxy(opts)) return bad("必须是普通对象");
  const proto = Object.getPrototypeOf(opts);
  if (proto !== Object.prototype && proto !== null) return bad("必须是普通对象");
  // Only this one explicitly branded mutable capability is exempt from the plain-data check.
  const descriptors = Object.getOwnPropertyDescriptors(opts);
  const health = Object.getOwnPropertyDescriptor(opts, "healthCache");
  const cache: unknown = health?.value;
  if (health && (!Object.hasOwn(health, "value") || !health.enumerable || (cache !== undefined && !ProtocolHealthCache.isCache(cache)))) return bad("healthCache 必须是 ProtocolHealthCache");
  delete descriptors.healthCache;
  const plain = plainData(Object.defineProperties(Object.create(null), descriptors), "opts", { topFunctions: true });
  if (!plain.ok) return bad(`${plain.path} ${plain.why}`);
  const r = plain.value as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!COMMON.has(k) && !(profile !== "compactor" && (k === "cacheRetention" || k === "maxRequestsPerRound"))) bad(`未知字段 ${k}`);
  }
  const text = (key: string): string => {
    const v = r[key];
    return typeof v === "string" && v.trim() !== "" ? v : bad(`${key} 必须是非空字符串`);
  };
  const int = (key: string, dflt: number, max: number): number => {
    const v = r[key];
    if (v === undefined) return dflt;
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : bad(`${key} 必须是 1–${max} 的整数`);
  };
  const flag = (key: string, dflt: boolean): boolean => {
    const v = r[key];
    return v === undefined ? dflt : typeof v === "boolean" ? v : bad(`${key} 必须是布尔值`);
  };
  const explicit = r.api === undefined ? undefined : protocolFor(r.api, bad);
  let protocols: PiProtocol[];
  if (r.protocols === undefined) protocols = [explicit ?? "anthropic-messages"];
  else {
    if (!Array.isArray(r.protocols) || r.protocols.length === 0) return bad("protocols 必须是非空协议列表");
    protocols = [...new Set(r.protocols.map((p) => protocolFor(p, bad)))];
    if (explicit !== undefined) protocols = [explicit, ...protocols.filter((p) => p !== explicit)];
  }
  const given = r.authHeader;
  if (given !== undefined && !protocols.some((p) => PROTOCOLS[p].authHeaders.some((h) => h === given))) bad("authHeader 与所选协议不兼容");
  const auth = new Map(protocols.map((p) => [p, authHeaderFor(p, protocols.length === 1 || PROTOCOLS[p].authHeaders.some((h) => h === given) ? given : undefined, bad)]));
  const baseUrl = text("baseUrl");
  let url: URL;
  try { url = new URL(baseUrl); } catch { return bad("baseUrl 不是合法 URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad("baseUrl 必须是 http(s)");
  const apiKey = text("apiKey");
  if (r.fetch !== undefined && typeof r.fetch !== "function") bad("fetch 必须是函数");
  const cacheRetention = r.cacheRetention ?? "short";
  if (cacheRetention !== "short" && cacheRetention !== "long") return bad("cacheRetention 只能是 short / long");
  return {
    provider: text("provider"), model: text("model"), baseUrl, apiKey, auth, protocols,
    healthCache: cache as ProtocolHealthCache | undefined ?? new ProtocolHealthCache(),
    maxTokens: int("maxTokens", 4096, 1_000_000), contextWindow: int("contextWindow", 200_000, 100_000_000),
    maxRequestsPerRound: int("maxRequestsPerRound", 8, 64), cacheRetention,
    reasoning: flag("reasoning", false), sessionAffinity: flag("sessionAffinity", true),
    fetch: r.fetch as typeof globalThis.fetch | undefined,
    redact: (message) => redactEndpointError(message, baseUrl, apiKey),
  };
}

/** Error bodies can echo keys, URLs or upstream account identifiers. Never copy those into receipts/errors. */
export function redactEndpointError(message: string, baseUrl: string, apiKey: string): string {
  const marker = "[密钥已隐去]";
  let safe = apiKey ? message.split(apiKey).join(marker) : message;
  const url = new URL(baseUrl);
  const secretParts = [url.username, url.password, ...url.pathname.split("/").filter((p) => p && !/^v1(?:beta\d*)?$/.test(p)), ...url.searchParams.values()];
  for (const part of new Set(secretParts.filter(Boolean))) safe = safe.split(part).join(marker);
  return safe.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL已隐去]").replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[账号已隐去]").slice(0, 2000);
}

export function sessionFor(cfg: ModelConfig, scope: "contact" | "note" | "probe", id: string): string | undefined {
  return cfg.sessionAffinity === false ? undefined : createHash("sha256").update(`gg-pi:${scope}:${id}`).digest("hex");
}

export interface Attempt {
  readonly protocol: PiProtocol;
  committed: boolean;
}

/** Retry the same model and only when nothing observable left this attempt. */
export async function withProtocols<T>(cfg: Resolved, signal: AbortSignal | undefined, run: (attempt: Attempt) => Promise<T>, onFailure?: (protocol: PiProtocol, error: string) => void): Promise<{ protocol: PiProtocol; value: T }> {
  const choices = cfg.healthCache.candidates(cfg.baseUrl, cfg.model, cfg.protocols);
  for (const [index, protocol] of choices.entries()) {
    if (signal?.aborted) throw new RoundAbortedError();
    const attempt: Attempt = { protocol, committed: false };
    try {
      const value = await run(attempt);
      cfg.healthCache.success(cfg.baseUrl, cfg.model, protocol);
      return { protocol, value };
    } catch (e) {
      if (signal?.aborted || isRoundAborted(e)) throw new RoundAbortedError();
      if (!(e instanceof PiContactMindError)) throw e;
      onFailure?.(protocol, e.message);
      if (attempt.committed) throw new PiContactMindError(e.code, e.message, true, e.retryableTruncation);
      if (e.code !== "provider-error") throw e;
      cfg.healthCache.failure(cfg.baseUrl, cfg.model, protocol);
      if (index === choices.length - 1) throw e;
    }
  }
  throw new PiContactMindError("provider-error", "没有可用的协议候选");
}

function commits(ev: AssistantMessageEvent): boolean {
  switch (ev.type) {
    case "text_delta": case "thinking_delta": case "toolcall_start": case "toolcall_delta": case "toolcall_end": return true;
    case "text_end": case "thinking_end": return ev.content !== "";
    default: return false;
  }
}

interface StreamConfig {
  readonly request: number;
  readonly sessionId: string | undefined;
  readonly cache: boolean;
  readonly options?: SimpleStreamOptions | undefined;
  readonly sink?: UsageSink;
  readonly observeUsage?: (u: ModelUsage) => void;
}

export function streamRequest(cfg: Resolved, attempt: Attempt, context: TranscriptContext, s: StreamConfig): AssistantMessageEventStream {
  const protocol = attempt.protocol;
  const model = modelForProtocol(protocol, cfg);
  const keys = keyOptions(protocol, cfg.auth.get(protocol)!, cfg.apiKey);
  const cacheRetention = protocol === "anthropic-messages" && s.cache ? cfg.cacheRetention : "none";
  // In pi-ai 1.5 the OpenAI SDK affinity headers are gated by cacheRetention.
  // Retain transport affinity without opting into any explicit cache-retention payload fields.
  const sessionId = s.sessionId;
  let headers = { ...s.options?.headers, ...keys.headers };
  if (sessionId && protocol === "openai-chat" && (model.compat as Model<"openai-completions">["compat"])?.sendSessionAffinityHeaders) {
    headers = { ...headers, session_id: sessionId, "x-client-request-id": sessionId, "x-session-affinity": sessionId };
  } else if (sessionId && protocol === "openai-responses" && model.compat?.sessionAffinityFormat === "openai") {
    headers = { ...headers, session_id: sessionId, "x-client-request-id": sessionId };
  }
  let probe: RequestProbe | null = null;
  const source = PROTOCOLS[protocol].load().streamSimple(model, context, {
    ...s.options, ...keys, headers, ...(sessionId ? { sessionId } : {}), maxTokens: cfg.maxTokens, cacheRetention, maxRetries: 0,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    onPayload: (payload) => {
      const outgoing = protocol === "anthropic-messages" ? placeBreakpoints(payload) : payload;
      probe = probeRequest(outgoing, protocol);
      return outgoing;
    },
  });
  const commit = () => { attempt.committed = true; };
  const sink = (m: AssistantMessage) => {
    if (m.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text !== "") || (b.type === "thinking" && b.thinking !== ""))) commit();
    const u = usageOf(usageLine(protocol === "anthropic-messages" ? cfg.provider : `${cfg.provider}/${protocol}`, cfg.baseUrl, cfg.model, cfg.apiKey), s.request, probe, m.usage);
    if (u) s.observeUsage?.(u);
    recordUsage(s.sink, u, commit);
  };
  const watched = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const ev of source) {
        if (commits(ev)) commit();
        if (ev.type === "done" || ev.type === "error") sink(ev.type === "done" ? ev.message : ev.error);
        watched.push(ev);
      }
      watched.end(await source.result());
    } catch (error) {
      // SDK streams normally push a typed error. Handle an iterator exception as the same provider failure.
      const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, content: [], stopReason: "error", errorMessage: cfg.redact(describe(error)), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      watched.push({ type: "error", reason: "error", error: message });
      watched.end(message);
    }
  })();
  return watched;
}
