// 说话侧装配(T-177 G2 = D;AC-32 ③):生产入口 start.ts 与开发入口 cli.ts 共用这一个函数,不各写一套默认值。
//   - 宿主级端点配置只从这里按环境变量解析一次(provider / baseUrl / authRef / maxOutputTokens / contextWindow;reasoning 默认空)。
//   - 联系人脑子与压缩器的工厂都收宿主每轮解析出的同一份 EffectiveSpeakingConfig,按 fingerprint 缓存无状态客户端,不按模型名缓存。
//   - 密钥不进快照、不进指纹:只在这里的私有调用边界按 authRef 现取,交给适配器;报错与说明不回显密钥值。
import type { ContactView } from "@g-group/api-contract";
import { modelConfig } from "@g-group/domain";
import type { ContactCompactor, ContactMind } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";

type Env = Readonly<Record<string, string | undefined>>;
export type SpeakingFactory<T> = (contact: ContactView, speaking: modelConfig.EffectiveSpeakingConfig) => T;
/** pi 适配器模块的形状(按需动态加载;测试可换成录参数的替身)。 */
export interface PiSpeakingModule {
  createPiContactMind(opts: Record<string, unknown>): ContactMind;
  createPiCompactor(opts: Record<string, unknown>): ContactCompactor;
}
export interface SpeakingAssemblyOptions {
  /** fake:规则替身(不连模型);pi:真实联系人脑子与压缩器。 */
  readonly kind: string;
  readonly env: Env;
  /** HTTP 传输,默认 globalThis.fetch;代理、录制与测试用,原样交给 pi 适配器。 */
  readonly fetch?: typeof globalThis.fetch;
  /** 换掉 pi 模块加载(测试录参数用);默认动态 import @g-group/adapter-pi-contact。 */
  readonly load?: () => Promise<PiSpeakingModule>;
}
export interface SpeakingAssembly {
  /** 宿主级端点配置;交给 Host 的 speakingEndpoint,宿主每轮据此解析快照。 */
  readonly endpoint: modelConfig.SpeakingEndpoint;
  readonly mind: SpeakingFactory<ContactMind>;
  readonly compactor?: SpeakingFactory<ContactCompactor>;
}

const positive = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1) throw new modelConfig.SpeakingConfigError(`说话侧配置不合格:${name} 必须是正整数`);
  return n;
};

/** 宿主级端点配置:两个入口共用。网关令牌(ANTHROPIC_AUTH_TOKEN)走 Bearer,API 密钥(ANTHROPIC_API_KEY)走 x-api-key;都没有就是 none。 */
export function speakingEndpointFromEnv(env: Env): modelConfig.SpeakingEndpoint {
  const d = modelConfig.DEFAULT_SPEAKING_ENDPOINT;
  const authRef = env.ANTHROPIC_AUTH_TOKEN ? "bearer:env:ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "x-api-key:env:ANTHROPIC_API_KEY" : "none";
  const e: modelConfig.SpeakingEndpoint = {
    provider: d.provider,
    baseUrl: env.ANTHROPIC_BASE_URL ?? d.baseUrl,
    authRef,
    maxOutputTokens: positive(env, "GG_SPEAKING_MAX_OUTPUT_TOKENS", d.maxOutputTokens),
    contextWindow: positive(env, "GG_SPEAKING_CONTEXT_WINDOW", d.contextWindow),
    reasoning: {},
  };
  return Object.freeze(modelConfig.checkSpeakingEndpoint(e));
}

/** 私有调用边界:按认证引用现取密钥。引用格式已由 checkSpeakingEndpoint 校验;取不到就拒绝,说明里只报引用名。 */
function credential(env: Env, authRef: string): { readonly apiKey: string; readonly authHeader: "bearer" | "x-api-key" } {
  const [header, source, name] = authRef.split(":");
  if (authRef === "none" || source !== "env" || !name) throw new modelConfig.SpeakingConfigError(`说话侧配置不合格:认证引用 ${authRef} 没有可用的密钥来源`);
  const v = env[name];
  if (v === undefined || v === "") throw new modelConfig.SpeakingConfigError(`说话侧配置不合格:认证引用 ${authRef} 指向的环境变量为空`);
  return { apiKey: v, authHeader: header === "bearer" ? "bearer" : "x-api-key" };
}

/** pi 适配器只接 Anthropic Messages 兼容端点,没有声明任何推理参数:给了就显式拒绝,不丢弃后假装继承。 */
function adapterOptions(env: Env, s: modelConfig.EffectiveSpeakingConfig, fetchFn: typeof globalThis.fetch | undefined): Record<string, unknown> {
  if (Object.keys(s.reasoning).length > 0) throw new modelConfig.SpeakingConfigError(`说话侧配置不合格:pi 适配器不支持推理参数 ${Object.keys(s.reasoning).join("、")},拒绝这份配置`);
  const c = credential(env, s.authRef);
  return { provider: s.provider, model: s.model, baseUrl: s.baseUrl, apiKey: c.apiKey, authHeader: c.authHeader, maxTokens: s.maxOutputTokens, contextWindow: s.contextWindow, ...(fetchFn ? { fetch: fetchFn } : {}) };
}

/** 两个入口的唯一装配函数。 */
export async function assembleSpeaking(o: SpeakingAssemblyOptions): Promise<SpeakingAssembly> {
  const endpoint = speakingEndpointFromEnv(o.env);
  if (o.kind === "fake") return { endpoint, mind: () => scriptedMind() };
  if (o.kind !== "pi") throw new modelConfig.SpeakingConfigError(`说话侧配置不合格:未知联系人脑子 ${o.kind}(只有 fake / pi)`);
  if (endpoint.authRef === "none") throw new modelConfig.SpeakingConfigError("说话侧配置不合格:mind=pi 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
  // 字面量动态 import:按需加载 pi 依赖,G-LAYER 也能核对依赖方向
  const mod = o.load ? await o.load() : ((await import("@g-group/adapter-pi-contact")) as unknown as PiSpeakingModule);
  const minds = new Map<string, ContactMind>();
  const compactors = new Map<string, ContactCompactor>();
  return {
    endpoint,
    mind: (_c, s) => {
      let m = minds.get(s.fingerprint);
      if (!m) {
        m = mod.createPiContactMind(adapterOptions(o.env, s, o.fetch));
        minds.set(s.fingerprint, m);
      }
      return m;
    },
    // 状态笔记补写与记忆检查:与对话同一份快照的独立调用(AC-32 ③)
    compactor: (_c, s) => {
      let k = compactors.get(s.fingerprint);
      if (!k) {
        k = mod.createPiCompactor(adapterOptions(o.env, s, o.fetch));
        compactors.set(s.fingerprint, k);
      }
      return k;
    },
  };
}
