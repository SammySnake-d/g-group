// 联系人层可用的四种模型协议(需求文档 U33、D07 §2):pi-ai 是「四协议统一 LLM 通信层」,
// 这里只做一张表加三件小事——把选项里的 api 名字翻成 pi-ai 的适配器入口与 Model.api、按协议校验密钥头、
// 把端点根地址补成该协议惯用的形状。协议之间的请求体差异(工具声明摆在哪儿、工具结果怎么回填)由 pi-ai 的
// 对应适配器自己转,这里不重写协议,也不新加依赖。
// 适配器一律用 pi-ai 现成的懒加载入口(@earendil-works/pi-ai/api/*.lazy):模块在第一次发请求时才真正加载。
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";

/** 选项里 api 能取的四个值。与 pi-ai 的 api 标识不完全同名:openai-chat 在 pi-ai 里叫 openai-completions。 */
export type PiModelApi = Exclude<PiProtocol, "openai-chat"> | "openai-completions";
export type PiProtocol = "anthropic-messages" | "openai-chat" | "openai-responses" | "google-generative-ai";
export const PI_PROTOCOLS: readonly PiProtocol[] = Object.freeze(["anthropic-messages", "openai-chat", "openai-responses", "google-generative-ai"]);

/**
 * 密钥放哪个请求头。
 * anthropic: x-api-key(API 密钥)或 Authorization: Bearer(网关令牌),由调用方选;
 * openai: Authorization: Bearer;google: x-goog-api-key。
 * 协议只认自己那一种,给别的直接判选项不合格,不静默换头。
 */
export type PiAuthHeader = "x-api-key" | "bearer" | "x-goog-api-key";

/** 一种协议在 pi-ai 里怎么接。 */
export interface ProtocolSpec {
  /** 写进 Model.api 的 pi-ai 标识,适配器据此摆请求体。 */
  readonly api: PiModelApi;
  /** 该协议认的密钥头;不在这里面的值判选项不合格。 */
  readonly authHeaders: readonly PiAuthHeader[];
  /** 不给 authHeader 时用哪个。 */
  readonly defaultAuthHeader: PiAuthHeader;
  /** pi-ai 的懒加载入口:第一次发请求才真正加载适配器模块。 */
  readonly load: () => ProviderStreams;
}

export const PROTOCOLS: Readonly<Record<PiProtocol, ProtocolSpec>> = Object.freeze({
  "anthropic-messages": Object.freeze({ api: "anthropic-messages", authHeaders: Object.freeze(["x-api-key", "bearer"] as const), defaultAuthHeader: "x-api-key", load: anthropicMessagesApi }),
  "openai-chat": Object.freeze({ api: "openai-completions", authHeaders: Object.freeze(["bearer"] as const), defaultAuthHeader: "bearer", load: openAICompletionsApi }),
  "openai-responses": Object.freeze({ api: "openai-responses", authHeaders: Object.freeze(["bearer"] as const), defaultAuthHeader: "bearer", load: openAIResponsesApi }),
  "google-generative-ai": Object.freeze({ api: "google-generative-ai", authHeaders: Object.freeze(["x-goog-api-key"] as const), defaultAuthHeader: "x-goog-api-key", load: googleGenerativeAIApi }),
});

/** 选项里的 api:只认四个值;不给就是 anthropic-messages(模型目录里查不到时的默认)。 */
export function protocolFor(given: unknown, bad: (why: string) => never): PiProtocol {
  if (given === undefined) return "anthropic-messages";
  if (typeof given !== "string" || !(PI_PROTOCOLS as readonly string[]).includes(given)) bad(`api 只能是 ${PI_PROTOCOLS.join(" / ")}`);
  return given as PiProtocol;
}

/** 密钥头:按协议收窄到该协议认的那几个;不给就用该协议的默认。 */
export function authHeaderFor(protocol: PiProtocol, given: unknown, bad: (why: string) => never): PiAuthHeader {
  const spec = PROTOCOLS[protocol];
  const value = given === undefined ? spec.defaultAuthHeader : given;
  if (typeof value !== "string" || !(spec.authHeaders as readonly string[]).includes(value)) bad(`authHeader 在 ${protocol} 下只能是 ${spec.authHeaders.join(" / ")}`);
  return value as PiAuthHeader;
}

/**
 * 把密钥放进 pi-ai 的调用选项。openai 的 Authorization: Bearer 与 google 的 x-goog-api-key 都由适配器从 apiKey 发,
 * 所以这两种(以及 anthropic 的 x-api-key)只给 apiKey;只有 anthropic 要 Bearer 时才改成显式头
 * (Anthropic 的 SDK 把 apiKey 发成 x-api-key,发不成 Bearer)。
 */
export function keyOptions(protocol: PiProtocol, authHeader: PiAuthHeader, apiKey: string): { readonly apiKey?: string; readonly headers?: Record<string, string> } {
  if (authHeader === "bearer" && protocol === "anthropic-messages") return { headers: { authorization: `Bearer ${apiKey}` } };
  return { apiKey };
}

/**
 * 各协议的端点根地址。anthropic 与 google 原样用(适配器自己接 /v1/messages、/models/<id>:streamGenerateContent);
 * openai 兼容口按惯例挂在 /v1 下,没带路径就补上,已带路径(如 .../v1)原样用,不重复加。
 */
export function baseUrlForApi(protocol: PiProtocol, baseUrl: string): string {
  if (protocol === "anthropic-messages" || protocol === "google-generative-ai") return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (url.pathname !== "" && url.pathname !== "/") return baseUrl;
  return new URL("/v1", url).toString();
}

/**
 * 模型名 → 协议。只在调用方没显式给 api 时用:认得出厂商前缀的按前缀走(google/gemini → google-generative-ai,
 * openai/gpt/o1–o4 → openai-chat),认不出的用 anthropic-messages 默认(不静默换模型,只挑协议)。
 * openai-responses 与 openai-chat 同名同厂商,前缀分不出来,只能用显式 api 选。
 */
export function apiForModel(model: string): PiProtocol {
  const id = model.trim().toLowerCase();
  const head = id.split("/")[0] ?? "";
  if (head === "google" || head === "gemini" || head.startsWith("gemini-")) return "google-generative-ai";
  if (head === "openai" || head === "gpt" || head.startsWith("gpt-") || /^o[1-9]($|-)/.test(id)) return "openai-chat";
  return "anthropic-messages";
}

/** Translate advertised paths, not model names. */
export function protocolForEndpoint(endpoint: string): PiProtocol | undefined {
  const path = endpoint.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") ?? "";
  if (/\/v1\/responses$/i.test(path)) return "openai-responses";
  if (/\/v1\/chat\/completions$/i.test(path)) return "openai-chat";
  if (/\/v1\/messages$/i.test(path)) return "anthropic-messages";
  if (/\/v1beta\d*\/models(?:\/|$)|\/models\/[^?]+:(?:stream)?generateContent$/i.test(path)) return "google-generative-ai";
  return undefined;
}

export interface ModelConfig {
  readonly model: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly reasoning?: boolean;
  readonly sessionAffinity?: boolean;
}

export function modelForProtocol(protocol: PiProtocol, cfg: ModelConfig): Model<PiModelApi> {
  // Discovery returns the gateway root (possibly with a deployment path), not a codec URL.
  const magpieVersion = protocol === "google-generative-ai" ? "v1beta" : protocol.startsWith("openai-") ? "v1" : undefined;
  const baseUrl = cfg.provider === "magpie" && magpieVersion
    ? `${cfg.baseUrl.replace(/\/+$/, "")}/${magpieVersion}` : baseUrlForApi(protocol, cfg.baseUrl);
  const base: Omit<Model<PiModelApi>, "api" | "compat"> = {
    id: cfg.model, name: cfg.model, provider: cfg.provider, baseUrl, reasoning: cfg.reasoning ?? false,
    contextWindow: cfg.contextWindow, maxTokens: cfg.maxTokens, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const affinity = cfg.sessionAffinity !== false;
  switch (protocol) {
    case "anthropic-messages": return { ...base, api: "anthropic-messages", compat: { sendSessionAffinityHeaders: affinity } } satisfies Model<"anthropic-messages">;
    case "openai-chat": return { ...base, api: "openai-completions", compat: { sendSessionAffinityHeaders: affinity, sessionAffinityFormat: "openai" } } satisfies Model<"openai-completions">;
    case "openai-responses": return { ...base, api: "openai-responses", compat: { sessionAffinityFormat: "openai" } } satisfies Model<"openai-responses">;
    case "google-generative-ai": return { ...base, api: "google-generative-ai" } satisfies Model<"google-generative-ai">;
  }
}

const COOLDOWNS = [60_000, 120_000, 300_000, 600_000] as const;
type CooldownsByProtocol = Map<PiProtocol, { count: number; retryAt: number }>;
type CooldownsByModel = Map<string, CooldownsByProtocol>;

/** Health is shared by callers, not global. If every candidate is cooling, probe only the one due first. */
export class ProtocolHealthCache {
  #now: () => number;
  #failed = new Map<string, CooldownsByModel>();
  constructor(opts?: { now?: () => number }) { this.#now = opts?.now ?? Date.now; }
  static isCache(value: unknown): value is ProtocolHealthCache { return typeof value === "object" && value !== null && #failed in value; }
  failure(baseUrl: string, model: string, api: PiProtocol): void {
    const { origin } = new URL(baseUrl);
    const models = this.#failed.get(origin) ?? new Map<string, CooldownsByProtocol>();
    const protocols = models.get(model) ?? new Map<PiProtocol, { count: number; retryAt: number }>();
    const count = Math.min((protocols.get(api)?.count ?? 0) + 1, COOLDOWNS.length);
    protocols.set(api, { count, retryAt: this.#now() + COOLDOWNS[count - 1]! });
    models.set(model, protocols);
    this.#failed.set(origin, models);
  }
  success(baseUrl: string, model: string, api: PiProtocol): void {
    const { origin } = new URL(baseUrl);
    const models = this.#failed.get(origin);
    const protocols = models?.get(model);
    if (!models || !protocols) return;
    protocols.delete(api);
    if (!protocols.size) models.delete(model);
    if (!models.size) this.#failed.delete(origin);
  }
  candidates(baseUrl: string, model: string, apis: readonly PiProtocol[]): readonly PiProtocol[] {
    const now = this.#now();
    const protocols = this.#failed.get(new URL(baseUrl).origin)?.get(model);
    const retryAt = (api: PiProtocol) => protocols?.get(api)?.retryAt ?? now;
    const healthy = apis.filter((api) => retryAt(api) <= now);
    if (healthy.length > 0 || apis.length === 0) return healthy;
    return [apis.reduce((first, api) => retryAt(api) < retryAt(first) ? api : first)];
  }
}
