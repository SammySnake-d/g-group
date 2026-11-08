// 运行台账的纯逻辑(需求文档 D26,AC-43)。空壳:签名在,返回假值。
import type { AutoRerun, FailureClass, ReasonClass, RetryClass } from "./failure-class.ts";

export type RunLayer = "contact-round" | "compute-session" | "compute-turn" | "background" | "subagent";

export type RunStatus = "queued" | "running" | "waiting_user" | "done" | "failed" | "interrupted" | "orphaned";

export interface StallThresholds {
  readonly stallMs: number;
  readonly firstByteMs: number;
}

export interface RunFailure {
  readonly reasonClass: ReasonClass;
  readonly retryClass: RetryClass;
  readonly autoRerun: AutoRerun;
  readonly label: string;
  readonly raw: string;
  readonly rulesVersion: string;
  readonly autoRerunCap: number | null;
  readonly sameUpstreamStop: boolean;
}

export interface RunProgress {
  /** 最后一次真实进展 */
  readonly lastProgressAt: number;
  /** 模型调用已发出、还没收到任何回应的起点(首字节窗口);收到真实事件即清空 */
  readonly awaitingSince: number | null;
  /** 在跑的工具调用(工具子进程在跑是合法等待) */
  readonly toolsRunning: readonly string[];
  /** 上次进展以来 harness 报了几次「正在重试」 */
  readonly retries: number;
  /** 最近一次重试公告带的原文 */
  readonly lastRetry: string | null;
  /** 最近一次合法等待(等人回答)结束的时刻:计时从这里重新开始 */
  readonly resumedAt: number | null;
}


export interface StallVerdict {
  readonly kind: "stalled" | "no_response" | "stream_dropped";
  readonly failure: RunFailure;
  readonly thresholdMs: number;
  readonly thresholdSource: ThresholdSource;
  readonly lastProgressAt: number;
  readonly judgedAt: number;
  readonly durationMs: number;
  readonly idleMs: number;
}


export interface RunUnit {
  readonly id: string;
  readonly layer: RunLayer;
  readonly parentId: string | null;
  readonly roomId: string;
  readonly sourceSeq: number | null;
  readonly contactId: string;
  readonly taskId: string | null;
  readonly computeId: string | null;
  /** 上游键(网关 + 模型等),合并群级提示与「同一上游连续失败」用 */
  readonly upstream: string | null;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly bootId: string;
  readonly pid: number | null;
  readonly progress: RunProgress;
  readonly failure: RunFailure | null;
  /** 孤儿原因等说明 */
  readonly note: string | null;
  readonly verdict: StallVerdict | null;
  readonly rerunOf: string | null;
  readonly attempt: number;
}


export interface NewRun {
  readonly id: string;
  readonly layer: RunLayer;
  readonly parentId: string | null;
  readonly roomId: string;
  readonly sourceSeq: number | null;
  readonly contactId: string;
  readonly bootId: string;
  readonly at: number;
  readonly taskId?: string | null;
  readonly computeId?: string | null;
  readonly upstream?: string | null;
  readonly pid?: number | null;
  readonly status?: "queued" | "running" | "waiting_user";
  readonly rerunOf?: string | null;
  readonly attempt?: number;
}


export type RunActivity =
  | { readonly kind: "progress"; readonly what: "text" | "thinking" | "tool_output" | "subagent" | "semantic" | "output" }
  | { readonly kind: "tool_start"; readonly toolId: string }
  | { readonly kind: "tool_end"; readonly toolId: string }
  | { readonly kind: "model_call" }
  | { readonly kind: "retry"; readonly error: string; readonly httpStatus?: number | null }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "alive" };


export type Transition = { readonly ok: true; readonly changed: readonly RunUnit[] } | { readonly ok: false; readonly reason: "not-found" | "terminal" | "children-running" | "failure-required" | "note-required" };


export type ThresholdSource = "default" | "contact" | "upstream";

export interface ThresholdConfig {
  readonly defaults?: Partial<StallThresholds>;
  readonly byContact?: Readonly<Record<string, Partial<StallThresholds>>>;
  readonly byUpstream?: Readonly<Record<string, Partial<StallThresholds>>>;
}

export interface ResolvedThresholds extends StallThresholds {
  readonly source: { readonly stallMs: ThresholdSource; readonly firstByteMs: ThresholdSource };
}

export interface StallCheck {
  readonly verdict: StallVerdict | null;
  /** 正处于哪种合法等待(不计时) */
  readonly waiting: "waiting_user" | "tool_running" | "first_byte" | "sleep_grace" | null;
  /** 已计入的无进展时长 */
  readonly idleMs: number;
}

export type RunViewer = { readonly kind: "user" } | { readonly kind: "contact"; readonly contactId: string; readonly roomId: string; readonly roomKind: "dm" | "group" };


export interface RerunLease {
  readonly holder: string;
  readonly until: number;
}

export interface RerunRequest {
  readonly at: number;
  /** 谁发起:用户本人或某位联系人 */
  readonly initiator: { readonly kind: "user" | "contact"; readonly id: string };
  /** auto:联系人自己决定重跑;explicit:有人明确要求(用户发话、或联系人依据一条明确请求) */
  readonly trigger: "auto" | "explicit";
  readonly leaseMs?: number;
}

export interface RerunContext {
  readonly unit: RunUnit;
  /** 这个单元(含之前重跑出的)已经由主人自动重跑了几次 */
  readonly autoReruns: number;
  readonly limit?: number;
  readonly lease: RerunLease | null;
  /** 这条任务在同一上游上连续失败了几次(含这一次) */
  readonly sameUpstreamFailures: number;
  /** 这次重跑会换到别的上游 */
  readonly upstreamChanged?: boolean;
}

export interface RerunEvent {
  readonly kind: "rerun";
  readonly unitId: string;
  readonly initiator: { readonly kind: "user" | "contact"; readonly id: string };
  readonly owner: string;
  readonly trigger: "auto" | "explicit";
  readonly basis: { readonly unitId: string; readonly taskId: string | null; readonly status: RunStatus; readonly reasonClass: ReasonClass | null; readonly raw: string | null; readonly note: string | null };
  readonly mode: "same_session" | "new_session";
  readonly attempt: number;
  readonly at: number;
}

export type RerunRefusal = "not-rerunnable" | "user-stopped" | "lease-held" | "not-owner-auto" | "never-auto" | "same-upstream" | "limit-reached";

export type RerunPlan =
  | { readonly ok: true; readonly mode: "same_session" | "new_session"; readonly announce: boolean; readonly explainFirst: boolean; readonly countsTowardLimit: boolean; readonly event: RerunEvent; readonly lease: RerunLease }
  | { readonly ok: false; readonly reason: RerunRefusal; readonly notDone: string | null };


export interface FailureGroup {
  readonly key: string;
  readonly roomId: string;
  readonly upstream: string;
  readonly reasonClass: ReasonClass;
  readonly label: string;
  readonly unitIds: readonly string[];
}

export const RUN_LAYERS: readonly RunLayer[] = [];
export const RUN_STATUSES: readonly RunStatus[] = [];
export const isLiveRun = (_s: RunStatus) => false;
export const DEFAULT_STALL_THRESHOLDS: Readonly<StallThresholds> = { stallMs: 0, firstByteMs: 0 };
export const DEFAULT_RERUN_LIMIT = 0;
export const DEFAULT_RERUN_LEASE_MS = 0;
export const DEFAULT_SLEEP_GRACE_MS = 0;
export const runFailure = (c: FailureClass): RunFailure => ({ reasonClass: c.reasonClass, retryClass: c.retryClass, autoRerun: c.autoRerun, label: "", raw: "", rulesVersion: "", autoRerunCap: null, sameUpstreamStop: false });
export function newRun(input: NewRun): RunUnit {
  return { id: input.id, layer: input.layer, parentId: null, roomId: "", sourceSeq: null, contactId: "", taskId: null, computeId: null, upstream: null, status: "queued", startedAt: 0, endedAt: null, bootId: "", pid: null, progress: { lastProgressAt: 0, awaitingSince: null, toolsRunning: [], retries: 0, lastRetry: null, resumedAt: null }, failure: null, note: null, verdict: null, rerunOf: null, attempt: 0 };
}
export function noteActivity(unit: RunUnit, _a: RunActivity, _at: number): RunUnit {
  return unit;
}
export function failFastOf(_a: RunActivity): RunFailure | null {
  return null;
}
export const childrenOf = (_units: readonly RunUnit[], _id: string): readonly RunUnit[] => [];
export function setStatus(_units: readonly RunUnit[], _id: string, _to: RunStatus, _at: number, _extra: { readonly failure?: RunFailure; readonly note?: string; readonly verdict?: StallVerdict } = {}): Transition {
  return { ok: false, reason: "not-found" };
}
export function reconcileOrphans(_units: readonly RunUnit[], _probe: { readonly bootId: string; readonly at: number; readonly alive: (pid: number) => boolean }): readonly RunUnit[] {
  return [];
}
export function resolveThresholds(_cfg: ThresholdConfig, _contactId: string, _upstream: string | null): ResolvedThresholds {
  return { stallMs: 0, firstByteMs: 0, source: { stallMs: "default", firstByteMs: "default" } };
}
export function stallCheck(_unit: RunUnit, _now: number, _th: ResolvedThresholds, _sleep: { readonly awakeSince: number | null; readonly graceMs?: number } = { awakeSince: null }): StallCheck {
  return { verdict: null, waiting: null, idleMs: 0 };
}
export function visibleRuns(_units: readonly RunUnit[], _viewer: RunViewer): readonly RunUnit[] {
  return [];
}
export function planRerun(_ctx: RerunContext, _req: RerunRequest): RerunPlan {
  return { ok: false, reason: "not-rerunnable", notDone: null };
}
export function failureGroups(_units: readonly RunUnit[]): readonly FailureGroup[] {
  return [];
}
export type RunTone = "queued" | "running" | "waiting" | "done" | "failed" | "stopped" | "orphaned";
export function runDisplay(_unit: RunUnit, _now: number): { readonly tone: RunTone; readonly text: string } {
  return { tone: "queued", text: "" };
}
