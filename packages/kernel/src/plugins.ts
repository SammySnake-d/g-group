/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
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

export function createRegistry(): PluginRegistry {
  throw new Error("未实现");
}
