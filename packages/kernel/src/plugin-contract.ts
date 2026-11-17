// 三类插件契约的类型(AC-35 阶段 I 宿主契约桩)。只有类型和常量,行为在 plugins.ts。
// DataSource 只回答"从哪取",OutboundChannel 只回答"往哪发",UIExtension 只声明挂载点。
// 定时不是插件:到点醒来是联系人自己的承诺(概念卡 v2 第 11 张,#1286)。插件之间互不依赖,只依赖宿主。

export type PluginKind = "data-source" | "outbound-channel" | "ui-extension";
export type ExternalEventType = "create" | "edit" | "delete";

/** 附件只传引用,不传内容。 */
export interface AttachmentRef { readonly ref: string; readonly name?: string; readonly mime?: string }

/** 插件交给宿主的外部事件(需求 D04.1 ExternalEventEnvelope 的插件侧)。插件自报的 trust 等多余字段一律丢弃。 */
export interface RawExternalEvent {
  readonly nativeId: string;
  /** 源端版本号:同一 nativeId 的每次 create/edit/delete 各有一个 */
  readonly sourceVersion: string;
  readonly eventType: ExternalEventType;
  readonly author: string;
  /** delete 可以为空串 */
  readonly content: string;
  /** 源端发生时间(ISO 8601),与宿主收到时间分开保存,供迟到对账 */
  readonly occurredAt: string;
  readonly attachments: readonly AttachmentRef[];
}

/** 宿主盖过章的外部事件:来源可追溯,内容永远是不可信数据(R-10 / AC-20 的入口前提)。 */
export interface ExternalEnvelope {
  readonly origin: { readonly plugin: string; readonly source: string; readonly nativeId: string };
  readonly sourceVersion: string;
  readonly eventType: ExternalEventType;
  readonly author: string;
  readonly content: string;
  readonly occurredAt: string;
  /** 宿主时钟,不取插件自报 */
  readonly receivedAt: string;
  readonly attachments: readonly AttachmentRef[];
  readonly trust: "untrusted";
}

/** 宿主交给插件的发送请求;endpoint 是首次投递时绑定的接收端,插件必须按它发,不要读自身可变状态 */
export interface SendRequest { readonly action_id: string; readonly payload: string; readonly endpoint: string }
export interface SendReceipt { readonly action_id: string; readonly receiptId: string }

/**
 * 外发幂等能力(需求 D04.2 / D15.1 维度 B):
 * - "action-id"(B1):接收端按 action_id 去重,且只在服务商幂等保留期 idempotencyWindowMs 内有效;
 *   结果未知时,只有首次尝试仍在保留期内才允许用同一 action_id 重试;
 * - "none"(B2):接收端不去重,结果未知时宿主拒绝再发,等人工对账。
 */
export type ChannelIdempotency = "action-id" | "none";

export interface DataSource {
  readonly kind: "data-source";
  readonly id: string;
  readonly sources: readonly string[];
  pull(sourceId: string): Promise<readonly RawExternalEvent[]>;
}
export interface OutboundChannel {
  readonly kind: "outbound-channel";
  readonly id: string;
  readonly idempotency: ChannelIdempotency;
  /** B1 必填:服务商对同一 action_id 去重的保留期(毫秒);B2 不填 */
  readonly idempotencyWindowMs?: number;
  /** 接收端/渠道身份(如 smtp://mx.example 或 gmail:me@x);注册时快照,绑定到每个动作 */
  readonly endpoint: string;
  /** 这一片只支持返回 Promise 的发送,宿主 await 它 */
  send(req: SendRequest): Promise<SendReceipt>;
}
export interface UIExtension {
  readonly kind: "ui-extension";
  readonly id: string;
  readonly mounts: readonly string[];
}
export type Plugin = DataSource | OutboundChannel | UIExtension;

export type RegisterRejection =
  | "invalid-kind"
  | "invalid-contract"
  | "duplicate-id"
  | "unknown-plugin"
  | "kind-change-not-allowed"
  | "schedule-not-allowed"
  | "plugin-dependency-not-allowed"
  | "unsupported-instance";
/** 插件注册入口只接受普通数据对象:非 Proxy,原型为 Object.prototype 或 null(数组为 Array.prototype),
 *  所有自有属性(含不可枚举、Symbol 键与数组元素)都是数据属性;只有顶层字段可以是函数。
 *  不承诺防御任意 JS 元编程对象,遇到就拒绝,注册入口不会抛错。 */
export type RegisterResult = { ok: true } | { ok: false; reason: RegisterRejection; detail: string };

export interface RejectedEvent { readonly index: number; readonly reason: string }
export type PullResult =
  | { ok: true; events: ExternalEnvelope[]; rejected: RejectedEvent[] }
  | { ok: false; reason: "unknown-plugin" | "source-not-declared" | "pull-failed" | "invalid-batch" | "clock-invalid"; detail: string };

export type DeliveryState = "in-flight" | "confirmed" | "delivery-unknown";
export type SendResult =
  | { ok: true; state: "confirmed"; receipt: SendReceipt; deduplicated: boolean }
  | {
    ok: false; state: "delivery-unknown";
    reason: "timeout" | "send-threw" | "invalid-receipt" | "non-promise-send" | "retry-refused" | "retry-window-expired" | "channel-changed" | "clock-untrusted";
    detail: string;
  }
  | { ok: false; state: "rejected"; reason: "unknown-plugin" | "missing-action-id" | "invalid-payload" | "payload-mismatch" | "in-flight" | "clock-invalid"; detail: string };

/** 一个外发动作首次投递时绑定的渠道:之后的重试只认这一版,reregister 换不掉它 */
export interface DeliveryBinding {
  readonly pluginId: string;
  /** 宿主快照版本:register / reregister 每次递增 */
  readonly channelVersion: number;
  readonly idempotency: ChannelIdempotency;
  readonly windowMs: number;
  /** 首次投递时快照里的接收端身份 */
  readonly endpoint: string;
  /** 首次尝试的墙钟时间(只用于展示与对账) */
  readonly firstAttemptAt: number;
  /** 首次尝试的单调时钟读数;保留期按它算,墙钟回拨不延长窗口 */
  readonly firstAttemptMonotonic: number;
  /** 载荷 UTF-8 字节的 sha256 */
  readonly payloadSha256: string;
}

/** 一个动作的账目视图;clockTrusted 一旦为 false 就不会恢复 */
export interface DeliveryView {
  readonly state: DeliveryState;
  readonly binding: DeliveryBinding;
  readonly attempts: number;
  /** 这个动作见过的最大单调读数 */
  readonly maxMonotonic: number;
  /** 单调读数从没倒退过;任何一次读数小于已见最大值就永久置 false,之后不再自动重试 */
  readonly clockTrusted: boolean;
}

export interface RegistryOptions {
  /** 宿主墙钟(毫秒),receivedAt 与 firstAttemptAt 用它 */
  readonly now?: () => number;
  /** 单调时钟(毫秒),B1 保留期用它;默认 performance.now。某个动作见到读数倒退后,该动作永久不再自动重试 */
  readonly monotonic?: () => number;
  /** await send 的上限,超时记 DeliveryUnknown */
  readonly sendTimeoutMs?: number;
}

export interface PluginRegistry {
  register(candidate: unknown): RegisterResult;
  /** 显式更新已注册插件:重新走完整校验,类型不能变;失败时旧快照不动 */
  reregister(candidate: unknown): RegisterResult;
  list(): readonly { readonly id: string; readonly kind: PluginKind }[];
  pull(pluginId: string, sourceId: string): Promise<PullResult>;
  send(pluginId: string, req: { action_id?: unknown; payload: string }): Promise<SendResult>;
  delivery(pluginId: string, actionId: string): DeliveryView | undefined;
  mounts(point: string): readonly string[];
}

export const SCHEDULE_REASON = "定时归联系人:插件只提供数据源和输出渠道,不能自带 schedule/cron(概念卡 v2 第 11 张,#1286)";
