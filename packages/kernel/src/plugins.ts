// 三类插件契约(AC-35 阶段 I 宿主契约桩):DataSource 只回答"从哪取",OutboundChannel 只回答"往哪发",UIExtension 只声明挂载点。
// 定时不是插件:到点醒来是联系人自己的承诺(概念卡 v2 第 11 张,#1286)。插件之间互不依赖,只依赖宿主。

export type PluginKind = "data-source" | "outbound-channel" | "ui-extension";

/** 插件拉回来的原始外部消息;插件自己说的 trust 一律不认,由宿主盖章。 */
export interface RawExternalMessage { readonly nativeId: string; readonly author: string; readonly content: string }
export interface DataSource {
  readonly kind: "data-source";
  readonly id: string;
  readonly sources: readonly string[];
  pull(sourceId: string): readonly RawExternalMessage[];
}
export interface SendRequest { readonly action_id: string; readonly payload: string }
export interface SendReceipt { readonly action_id: string; readonly receiptId: string }
export interface OutboundChannel {
  readonly kind: "outbound-channel";
  readonly id: string;
  send(req: SendRequest): SendReceipt;
}
export interface UIExtension {
  readonly kind: "ui-extension";
  readonly id: string;
  readonly mounts: readonly string[];
}
export type Plugin = DataSource | OutboundChannel | UIExtension;

/** 宿主盖过章的外部消息:来源可追溯,内容永远是不可信数据(R-10 / AC-20 的入口前提)。 */
export interface ExternalEnvelope {
  readonly origin: { readonly plugin: string; readonly source: string; readonly nativeId: string };
  readonly author: string;
  readonly content: string;
  readonly trust: "untrusted";
}

export type RegisterRejection =
  | "invalid-kind"
  | "invalid-contract"
  | "duplicate-id"
  | "schedule-not-allowed"
  | "plugin-dependency-not-allowed";
export type RegisterResult = { ok: true } | { ok: false; reason: RegisterRejection; detail: string };

export type PullResult = { ok: true; messages: ExternalEnvelope[] } | { ok: false; reason: "unknown-plugin" | "source-not-declared"; detail: string };
export type SendResult =
  | { ok: true; receipt: SendReceipt; deduplicated: boolean }
  | { ok: false; reason: "unknown-plugin" | "missing-action-id"; detail: string };

export interface PluginRegistry {
  register(candidate: unknown): RegisterResult;
  list(): readonly { id: string; kind: PluginKind }[];
  pull(pluginId: string, sourceId: string): PullResult;
  send(pluginId: string, req: { action_id?: unknown; payload: string }): SendResult;
  mounts(point: string): readonly string[];
}

export const SCHEDULE_REASON = "定时归联系人:插件只提供数据源和输出渠道,不能自带 schedule/cron(概念卡 v2 第 11 张,#1286)";

const KINDS: ReadonlySet<string> = new Set<PluginKind>(["data-source", "outbound-channel", "ui-extension"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string" && s !== "");
const reject = (reason: RegisterRejection, detail: string): RegisterResult => ({ ok: false, reason, detail });

function check(c: unknown, taken: ReadonlySet<string>): RegisterResult {
  if (!isObj(c) || typeof c.kind !== "string" || !KINDS.has(c.kind)) return reject("invalid-kind", `类型必须是 ${[...KINDS].join(" / ")}`);
  if (typeof c.id !== "string" || c.id.trim() === "") return reject("invalid-contract", "缺 id");
  if (taken.has(c.id)) return reject("duplicate-id", c.id);
  if ("schedule" in c || "cron" in c) return reject("schedule-not-allowed", SCHEDULE_REASON);
  if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return reject("plugin-dependency-not-allowed", "插件只能依赖宿主接口,不能依赖其他插件");
  if (c.kind === "data-source" && !(isStrList(c.sources) && typeof c.pull === "function")) return reject("invalid-contract", "DataSource 需要 sources 与 pull");
  if (c.kind === "outbound-channel" && typeof c.send !== "function") return reject("invalid-contract", "OutboundChannel 需要 send");
  if (c.kind === "ui-extension" && !isStrList(c.mounts)) return reject("invalid-contract", "UIExtension 需要 mounts");
  return { ok: true };
}

/** 外部内容由宿主盖章:只取契约字段,trust 固定为不可信,插件自报的一律丢弃。 */
function stamp(plugin: string, source: string, m: RawExternalMessage): ExternalEnvelope {
  return { origin: { plugin, source, nativeId: String(m.nativeId) }, author: String(m.author), content: String(m.content), trust: "untrusted" };
}

export function createRegistry(): PluginRegistry {
  const plugins = new Map<string, Plugin>();
  const sent = new Map<string, SendReceipt>(); // `${plugin}\u0000${action_id}` → 首次回执
  return {
    register(candidate) {
      const r = check(candidate, new Set(plugins.keys()));
      if (r.ok) { const p = candidate as Plugin; plugins.set(p.id, p); }
      return r;
    },
    list: () => [...plugins.values()].map((p) => ({ id: p.id, kind: p.kind })),
    pull(pluginId, sourceId) {
      const p = plugins.get(pluginId);
      if (p?.kind !== "data-source") return { ok: false, reason: "unknown-plugin", detail: pluginId };
      if (!p.sources.includes(sourceId)) return { ok: false, reason: "source-not-declared", detail: sourceId };
      return { ok: true, messages: p.pull(sourceId).map((m) => stamp(p.id, sourceId, m)) };
    },
    send(pluginId, req) {
      const p = plugins.get(pluginId);
      if (p?.kind !== "outbound-channel") return { ok: false, reason: "unknown-plugin", detail: pluginId };
      const actionId = req.action_id;
      if (typeof actionId !== "string" || actionId === "") return { ok: false, reason: "missing-action-id", detail: "外发动作必须带 action_id,宿主按它幂等" };
      const key = `${pluginId}\u0000${actionId}`;
      const prior = sent.get(key);
      if (prior) return { ok: true, receipt: prior, deduplicated: true };
      const receipt = p.send({ action_id: actionId, payload: req.payload });
      sent.set(key, receipt);
      return { ok: true, receipt, deduplicated: false };
    },
    mounts: (point) => [...plugins.values()].filter((p): p is UIExtension => p.kind === "ui-extension" && p.mounts.includes(point)).map((p) => p.id),
  };
}
