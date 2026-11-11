// 运行台账的纯逻辑(需求文档 D26 第 3–5 节与第 8.3/8.5/8.6 节,AC-43;开发手册原则 63、64)。不做 I/O,时间都由调用方给(毫秒)。
//   - 单元四层五类:联系人轮次 → Compute 会话 → 会话里的轮次 → 后台任务 / 子代理;每行带 parent_id、来源(会话 + #seq)、属于谁(联系人)。
//   - 状态集合固定:queued / running / waiting_user / done / failed / interrupted / orphaned;failed、interrupted 必带原因类别与原文。
//   - 父子一致:子单元还在跑,父单元不能记 done;父单元失败/中断/成孤儿时,还在跑的子单元一起标 orphaned,不留「运行中」。
//   - 存活核对:上一次宿主启动留下的、或执行进程已不在的 running 单元,一个核对周期内变 orphaned 并写明原因。
//   - 卡死判失败:只有真实事件算进展;harness 的「正在重试」公告、心跳、进程存活都不刷新计时;合法等待(等人回答、工具子进程在跑、
//     首字节窗口内、休眠唤醒宽限期)不计时;到阈值给出 failed + 原因类别(stalled / no_response / stream_dropped)+ 用时 + 最后进展时间 + 判定阈值。
//   - 阈值默认 15 分钟 / 120 秒(#2827),可按联系人或按上游单独设;两边都设取更宽的那个(少误判),并记下按哪个判。
//   - 可见范围:私聊只看该联系人在这个私聊里的单元;群里看本群全部成员在本群的单元;别处不返回;用户本人全看。
//   - 重跑规则(#2628):只接受 failed / interrupted / orphaned;人停的拒绝(用户本人这次明确要求除外);平台拒绝、上下文超长、会话丢失开新会话;
//     同一单元同时只一个重跑(租约);自己名下自动重跑有上限(默认 2 次,是助手建议、用户未定,做成参数,#2646);别人名下不自动重跑,
//     明确发起才执行并在群里留记录;每次重跑给出一条事件。
//   - 同一会话里同一上游同一原因的多条失败合并成一条群级提示。
import { type AutoRerun, classifyFailure, type FailureClass, type ReasonClass, type RetryClass } from "./failure-class.ts";
import { DEFAULT_WAKE_POLICY } from "./retry-policy.ts";

export type RunLayer = "contact-round" | "compute-session" | "compute-turn" | "background" | "subagent";
export type RunStatus = "queued" | "running" | "waiting_user" | "done" | "failed" | "interrupted" | "orphaned";
export const RUN_LAYERS: readonly RunLayer[] = Object.freeze(["contact-round", "compute-session", "compute-turn", "background", "subagent"]);
export const RUN_STATUSES: readonly RunStatus[] = Object.freeze(["queued", "running", "waiting_user", "done", "failed", "interrupted", "orphaned"]);
const LIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "running", "waiting_user"]);
const RERUNNABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(["failed", "interrupted", "orphaned"]);
/** 卡死计时的对象:在跑的轮次(联系人轮次、Compute 会话里的轮次) */
const TIMED: ReadonlySet<RunLayer> = new Set<RunLayer>(["contact-round", "compute-turn"]);

export const isLiveRun = (s: RunStatus) => LIVE.has(s);

export interface StallThresholds {
  readonly stallMs: number;
  readonly firstByteMs: number;
}
/** 用户 #2827 定:一轮 15 分钟无进展判失败,首字节等 120 秒 */
export const DEFAULT_STALL_THRESHOLDS: Readonly<StallThresholds> = Object.freeze({ stallMs: 15 * 60_000, firstByteMs: 120_000 });
/** 自己名下自动重跑上限:助手建议 2 次,用户未定(#2646),是参数 */
export const DEFAULT_RERUN_LIMIT = 2;
/** 重跑租约默认有效期 */
export const DEFAULT_RERUN_LEASE_MS = 10 * 60_000;
/** 休眠唤醒后的宽限期默认值(D15.1 第六层 ① 举例 3 分钟);只有一个来源:内核休眠门 DEFAULT_WAKE_POLICY.graceMs */
export const DEFAULT_SLEEP_GRACE_MS = DEFAULT_WAKE_POLICY.graceMs;

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
export const runFailure = (c: FailureClass): RunFailure =>
  Object.freeze({
    reasonClass: c.reasonClass,
    retryClass: c.retryClass,
    autoRerun: c.autoRerun,
    label: c.label,
    raw: c.raw,
    rulesVersion: c.rulesVersion,
    autoRerunCap: c.autoRerunCap,
    sameUpstreamStop: c.sameUpstreamStop,
  });

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

const nonEmpty = (x: unknown) => typeof x === "string" && x.length > 0;
const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const freezeUnit = (u: RunUnit): RunUnit => {
  Object.freeze(u.progress.toolsRunning);
  Object.freeze(u.progress);
  return Object.freeze(u);
};

export function newRun(input: NewRun): RunUnit {
  if (!nonEmpty(input.id)) throw new RangeError("单元 id 不能为空");
  if (!RUN_LAYERS.includes(input.layer)) throw new RangeError(`未知单元层 ${String(input.layer)}`);
  if (!nonEmpty(input.roomId) || !nonEmpty(input.contactId) || !nonEmpty(input.bootId)) throw new RangeError("单元必须带来源会话、属于谁和宿主启动号");
  if (!finite(input.at)) throw new RangeError("开始时间必须是有限数");
  const status = input.status ?? "running";
  if (!LIVE.has(status)) throw new RangeError(`新单元只能是 queued / running / waiting_user,收到 ${status}`);
  return freezeUnit({
    id: input.id,
    layer: input.layer,
    parentId: input.parentId,
    roomId: input.roomId,
    sourceSeq: input.sourceSeq,
    contactId: input.contactId,
    taskId: input.taskId ?? null,
    computeId: input.computeId ?? null,
    upstream: input.upstream ?? null,
    status,
    startedAt: input.at,
    endedAt: null,
    bootId: input.bootId,
    pid: input.pid ?? null,
    progress: { lastProgressAt: input.at, awaitingSince: null, toolsRunning: [], retries: 0, lastRetry: null, resumedAt: null },
    failure: null,
    note: null,
    verdict: null,
    rerunOf: input.rerunOf ?? null,
    attempt: input.attempt ?? 0,
  });
}

/** harness 上报的一件事。只有 progress / tool_start / tool_end 是真实进展;model_call 开始首字节窗口;retry、heartbeat、alive 不算进展 */
export type RunActivity =
  | { readonly kind: "progress"; readonly what: "text" | "thinking" | "tool_output" | "subagent" | "semantic" | "output" }
  | { readonly kind: "tool_start"; readonly toolId: string }
  | { readonly kind: "tool_end"; readonly toolId: string }
  | { readonly kind: "model_call" }
  | { readonly kind: "retry"; readonly error: string; readonly httpStatus?: number | null }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "alive" };

export function noteActivity(unit: RunUnit, a: RunActivity, at: number): RunUnit {
  if (!LIVE.has(unit.status)) return unit;
  const p = unit.progress;
  const progressed = (tools: readonly string[]): RunProgress => ({ ...p, lastProgressAt: Math.max(p.lastProgressAt, at), awaitingSince: null, retries: 0, lastRetry: null, toolsRunning: tools });
  let next: RunProgress = p;
  if (a.kind === "progress") next = progressed([...p.toolsRunning]);
  else if (a.kind === "tool_start") next = progressed(p.toolsRunning.includes(a.toolId) ? [...p.toolsRunning] : [...p.toolsRunning, a.toolId]);
  else if (a.kind === "tool_end") next = progressed(p.toolsRunning.filter((t) => t !== a.toolId));
  else if (a.kind === "model_call") next = { ...p, toolsRunning: [...p.toolsRunning], awaitingSince: p.awaitingSince ?? at };
  else if (a.kind === "retry") next = { ...p, toolsRunning: [...p.toolsRunning], retries: p.retries + 1, lastRetry: typeof a.error === "string" ? a.error : null };
  // heartbeat / alive:进程活着、心跳都不代表在进展,不刷新
  if (next === p) return unit;
  return freezeUnit({ ...unit, progress: next });
}

/** 重试公告带的错误若确定不会自愈(鉴权、额度、上下文超长等),不等阈值立即判失败 */
export function failFastOf(a: RunActivity): RunFailure | null {
  if (a.kind !== "retry") return null;
  const c = classifyFailure({ text: a.error, httpStatus: a.httpStatus ?? null });
  return c.failFast ? runFailure(c) : null;
}

export type Transition = { readonly ok: true; readonly changed: readonly RunUnit[] } | { readonly ok: false; readonly reason: "not-found" | "terminal" | "children-running" | "failure-required" | "note-required" };

const descendants = (units: readonly RunUnit[], id: string): RunUnit[] => {
  const out: RunUnit[] = [];
  const walk = (pid: string) => {
    for (const u of units) {
      if (u.parentId === pid && !out.includes(u)) {
        out.push(u);
        walk(u.id);
      }
    }
  };
  walk(id);
  return out;
};
export const childrenOf = (units: readonly RunUnit[], id: string): readonly RunUnit[] => units.filter((u) => u.parentId === id);

const ended = (u: RunUnit, status: RunStatus, at: number, extra: Partial<RunUnit>): RunUnit =>
  freezeUnit({ ...u, ...extra, status, endedAt: at, progress: { ...u.progress, toolsRunning: [...u.progress.toolsRunning] } });

/**
 * 改一个单元的状态。返回这次一起改动的单元(本身 + 级联成孤儿的子孙),调用方整批落盘。
 * done:子孙里还有在跑的就拒绝;failed / interrupted:必须带 failure;orphaned:必须带 note。
 */
export function setStatus(units: readonly RunUnit[], id: string, to: RunStatus, at: number, extra: { readonly failure?: RunFailure; readonly note?: string; readonly verdict?: StallVerdict } = {}): Transition {
  const u = units.find((x) => x.id === id);
  if (!u) return { ok: false, reason: "not-found" };
  if (!LIVE.has(u.status)) return { ok: false, reason: "terminal" };
  if (LIVE.has(to)) {
    const progress: RunProgress =
      u.status === "waiting_user" && to !== "waiting_user" ? { ...u.progress, toolsRunning: [...u.progress.toolsRunning], resumedAt: at } : { ...u.progress, toolsRunning: [...u.progress.toolsRunning] };
    return { ok: true, changed: [freezeUnit({ ...u, status: to, progress })] };
  }
  const live = descendants(units, id).filter((d) => LIVE.has(d.status));
  if (to === "done") {
    if (live.length) return { ok: false, reason: "children-running" };
    return { ok: true, changed: [ended(u, "done", at, {})] };
  }
  if ((to === "failed" || to === "interrupted") && !extra.failure) return { ok: false, reason: "failure-required" };
  if (to === "orphaned" && !nonEmpty(extra.note)) return { ok: false, reason: "note-required" };
  const self = ended(u, to, at, { failure: extra.failure ?? null, note: extra.note ?? null, verdict: extra.verdict ?? null });
  const cascade = live.map((d) => ended(d, "orphaned", at, { note: `父单元已结束(${to})` }));
  return { ok: true, changed: [self, ...cascade] };
}

/**
 * 存活核对:上一次宿主启动留下的在跑单元记「宿主进程退出」,同一启动里执行进程已不在的 running 单元记「执行进程已不在」,子孙一并成孤儿。
 * 进程存活只核对 running(D26 第 3 节):等人回答的单元进程可以不在(一次性进程停在受阻就退出,常驻进程空闲回收),用户回答后按会话 id 续接。
 * 只返回改动了的单元。
 */
export function reconcileOrphans(units: readonly RunUnit[], probe: { readonly bootId: string; readonly at: number; readonly alive: (pid: number) => boolean }): readonly RunUnit[] {
  const out = new Map<string, RunUnit>();
  for (const u of units) {
    if (!LIVE.has(u.status)) continue;
    let note: string | null = null;
    if (u.bootId !== probe.bootId) note = "宿主进程退出";
    else if (u.pid !== null && u.status === "running" && !probe.alive(u.pid)) note = "执行进程已不在";
    if (note) out.set(u.id, ended(u, "orphaned", probe.at, { note }));
  }
  for (const id of [...out.keys()]) {
    for (const d of descendants(units, id)) if (LIVE.has(d.status) && !out.has(d.id)) out.set(d.id, ended(d, "orphaned", probe.at, { note: "父单元已结束(orphaned)" }));
  }
  return units.filter((u) => out.has(u.id)).map((u) => out.get(u.id)!);
}

export type ThresholdSource = "default" | "contact" | "upstream";
export interface ThresholdConfig {
  readonly defaults?: Partial<StallThresholds>;
  readonly byContact?: Readonly<Record<string, Partial<StallThresholds>>>;
  readonly byUpstream?: Readonly<Record<string, Partial<StallThresholds>>>;
}
export interface ResolvedThresholds extends StallThresholds {
  readonly source: { readonly stallMs: ThresholdSource; readonly firstByteMs: ThresholdSource };
}
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

export function resolveThresholds(cfg: ThresholdConfig, contactId: string, upstream: string | null): ResolvedThresholds {
  const pick = (k: keyof StallThresholds): [number, ThresholdSource] => {
    const d = positive(cfg.defaults?.[k]) ? cfg.defaults![k]! : DEFAULT_STALL_THRESHOLDS[k];
    const c = cfg.byContact && Object.hasOwn(cfg.byContact, contactId) ? cfg.byContact[contactId]?.[k] : undefined;
    const up = upstream !== null && cfg.byUpstream && Object.hasOwn(cfg.byUpstream, upstream) ? cfg.byUpstream[upstream]?.[k] : undefined;
    const cs = positive(c) ? c : null;
    const us = positive(up) ? up : null;
    if (cs !== null && us !== null) return us > cs ? [us, "upstream"] : [cs, "contact"];
    if (cs !== null) return [cs, "contact"];
    if (us !== null) return [us, "upstream"];
    return [d, "default"];
  };
  const [stallMs, s1] = pick("stallMs");
  const [firstByteMs, s2] = pick("firstByteMs");
  return Object.freeze({ stallMs, firstByteMs, source: Object.freeze({ stallMs: s1, firstByteMs: s2 }) });
}

export interface StallCheck {
  readonly verdict: StallVerdict | null;
  /** 正处于哪种合法等待(不计时) */
  readonly waiting: "waiting_user" | "tool_running" | "first_byte" | "sleep_grace" | null;
  /** 已计入的无进展时长 */
  readonly idleMs: number;
}
const SRC_TEXT: Readonly<Record<ThresholdSource, string>> = Object.freeze({ default: "按默认值", contact: "按联系人单独设的值", upstream: "按上游单独设的值" });
const mins = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

/** 判一个单元此刻是否卡死。sleep.awakeSince 是最近一次检测到休眠唤醒的时刻(由调用方按时钟跳变检出) */
export function stallCheck(unit: RunUnit, now: number, th: ResolvedThresholds, sleep: { readonly awakeSince: number | null; readonly graceMs?: number } = { awakeSince: null }): StallCheck {
  const none = (waiting: StallCheck["waiting"], idleMs = 0): StallCheck => ({ verdict: null, waiting, idleMs });
  if (unit.status === "waiting_user") return none("waiting_user");
  if (unit.status !== "running" || !TIMED.has(unit.layer)) return none(null);
  const p = unit.progress;
  if (p.toolsRunning.length) return none("tool_running");
  const awake = sleep.awakeSince;
  if (awake !== null && now < awake + (sleep.graceMs ?? DEFAULT_SLEEP_GRACE_MS)) return none("sleep_grace");
  const verdict = (kind: StallVerdict["kind"], thresholdMs: number, source: ThresholdSource, idleMs: number, raw: string): StallCheck => {
    const failure = runFailure(classifyFailure({ text: raw, stall: kind }));
    return { verdict: Object.freeze({ kind, failure, thresholdMs, thresholdSource: source, lastProgressAt: p.lastProgressAt, judgedAt: now, durationMs: now - unit.startedAt, idleMs }), waiting: null, idleMs };
  };
  // 首字节窗口:调用发出后还没有任何回应、也没有重试公告(有重试说明上游回了错,不再是「等首字节」)
  if (p.awaitingSince !== null && p.retries === 0) {
    const waited = now - Math.max(p.awaitingSince, awake ?? Number.NEGATIVE_INFINITY);
    if (waited < th.firstByteMs) return none("first_byte", 0);
    return verdict("no_response", th.firstByteMs, th.source.firstByteMs, waited, `模型调用发出后 ${Math.round(waited / 1000)} 秒没有任何回应(首字节窗口 ${Math.round(th.firstByteMs / 1000)} 秒,${SRC_TEXT[th.source.firstByteMs]})`);
  }
  const from = Math.max(p.lastProgressAt, p.resumedAt ?? Number.NEGATIVE_INFINITY, awake ?? Number.NEGATIVE_INFINITY);
  const idle = now - from;
  if (idle < th.stallMs) return none(null, idle);
  const limit = `阈值 ${mins(th.stallMs)} 分钟,${SRC_TEXT[th.source.stallMs]}`;
  if (p.retries > 0) return verdict("stream_dropped", th.stallMs, th.source.stallMs, idle, `harness 重试 ${p.retries} 次之间一直没有输出,${mins(idle)} 分钟没有进展(${limit});最近一次重试:${p.lastRetry ?? "(无原文)"}`);
  return verdict("stalled", th.stallMs, th.source.stallMs, idle, `一轮 ${mins(idle)} 分钟没有任何进展(${limit})`);
}

export type RunViewer = { readonly kind: "user" } | { readonly kind: "contact"; readonly contactId: string; readonly roomId: string; readonly roomKind: "dm" | "group" };

/** 查询工具的可见范围,由宿主机械过滤,不看联系人自报 */
export function visibleRuns(units: readonly RunUnit[], viewer: RunViewer): readonly RunUnit[] {
  if (viewer.kind === "user") return [...units];
  if (viewer.roomKind === "dm") return units.filter((u) => u.roomId === viewer.roomId && u.contactId === viewer.contactId);
  return units.filter((u) => u.roomId === viewer.roomId);
}

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

export function planRerun(ctx: RerunContext, req: RerunRequest): RerunPlan {
  const u = ctx.unit;
  const no = (reason: RerunRefusal, notDone: string | null = null): RerunPlan => ({ ok: false, reason, notDone });
  if (!RERUNNABLE.has(u.status)) return no("not-rerunnable");
  const f = u.failure;
  const byUser = req.initiator.kind === "user";
  if (f?.reasonClass === "user_stopped" && !(byUser && req.trigger === "explicit")) return no("user-stopped");
  if (ctx.lease && ctx.lease.until > req.at) return no("lease-held");
  const owner = req.initiator.kind === "contact" && req.initiator.id === u.contactId;
  if (req.trigger === "auto") {
    if (!owner) return no("not-owner-auto");
    if (f?.autoRerun === "never") return no("never-auto", `未做:${f.label},${f.reasonClass === "auth_or_quota" ? "人先修配置" : "改模型配置"}后再重跑`);
    const sameStop = (f?.autoRerun === "not_same_upstream" && ctx.sameUpstreamFailures >= 1) || (f?.sameUpstreamStop === true && ctx.sameUpstreamFailures >= 2);
    if (sameStop && !ctx.upstreamChanged) return no("same-upstream", `未做:同一上游连续失败(${f?.label}),等用户换上游`);
    const limit = Math.min(ctx.limit ?? DEFAULT_RERUN_LIMIT, f?.autoRerunCap ?? Number.POSITIVE_INFINITY);
    if (ctx.autoReruns >= limit) return no("limit-reached", `未做:自动重跑已到上限 ${limit} 次(${f?.label ?? u.note ?? "没跑完"})`);
  }
  const mode = f?.autoRerun === "new_session_only" ? "new_session" : "same_session";
  const event: RerunEvent = Object.freeze({
    kind: "rerun",
    unitId: u.id,
    initiator: Object.freeze({ ...req.initiator }),
    owner: u.contactId,
    trigger: req.trigger,
    basis: Object.freeze({ unitId: u.id, taskId: u.taskId, status: u.status, reasonClass: f?.reasonClass ?? null, raw: f?.raw ?? null, note: u.note }),
    mode,
    attempt: u.attempt + 1,
    at: req.at,
  });
  return Object.freeze({
    ok: true,
    mode,
    announce: !owner,
    explainFirst: f?.retryClass === "UnknownEffect",
    countsTowardLimit: req.trigger === "auto" && owner,
    event,
    lease: Object.freeze({ holder: req.initiator.id, until: req.at + (req.leaseMs ?? DEFAULT_RERUN_LEASE_MS) }),
  });
}

export interface FailureGroup {
  readonly key: string;
  readonly roomId: string;
  readonly upstream: string;
  readonly reasonClass: ReasonClass;
  readonly label: string;
  readonly unitIds: readonly string[];
}
/** 同一会话里同一上游同一原因的失败合并成一条群级提示(只看 failed、带上游的单元) */
export function failureGroups(units: readonly RunUnit[]): readonly FailureGroup[] {
  const m = new Map<string, { roomId: string; upstream: string; reasonClass: ReasonClass; label: string; unitIds: string[] }>();
  for (const u of units) {
    if (u.status !== "failed" || !u.failure || u.upstream === null) continue;
    const key = `${u.roomId}|${u.upstream}|${u.failure.reasonClass}`;
    const g = m.get(key) ?? { roomId: u.roomId, upstream: u.upstream, reasonClass: u.failure.reasonClass, label: u.failure.label, unitIds: [] };
    g.unitIds.push(u.id);
    m.set(key, g);
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, g]) => Object.freeze({ key, ...g, unitIds: Object.freeze(g.unitIds) }));
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};
export type RunTone = "queued" | "running" | "waiting" | "done" | "failed" | "stopped" | "orphaned";
/** 画板一行:失败「失败 · 原因 · 用时」,人停的「已停止」(色调与失败不同),孤儿「没跑完 · 原因」 */
export function runDisplay(unit: RunUnit, now: number): { readonly tone: RunTone; readonly text: string } {
  const took = dur((unit.endedAt ?? now) - unit.startedAt);
  switch (unit.status) {
    case "queued":
      return { tone: "queued", text: "排队中" };
    case "running":
      return { tone: "running", text: `运行中 · 已跑 ${took}` };
    case "waiting_user":
      return { tone: "waiting", text: `等你回答 · 已跑 ${took}` };
    case "done":
      return { tone: "done", text: `完成 · 用时 ${took}` };
    case "orphaned":
      return { tone: "orphaned", text: `没跑完 · ${unit.note ?? "原因不明"}` };
    default: {
      if (unit.failure?.reasonClass === "user_stopped") return { tone: "stopped", text: "已停止" };
      return { tone: "failed", text: `${unit.status === "interrupted" ? "中断" : "失败"} · ${unit.failure?.label ?? "原因不明"} · 用时 ${took}` };
    }
  }
}
