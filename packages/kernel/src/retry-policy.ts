// 失败轮次 A×B 双维容错的纯策略(AC-36,需求文档 D15.1 第六层、U75、AC-P0-12)。不做 I/O,时钟与随机数由调用方注入。
//   维度 A(同样输入重试能否成功):A1 可能自愈(5xx、断流、429、超时、子进程意外退出)、A2 需人先修配置/配额(401/403、额度、模型不存在)、
//     A3 永久拒绝(内容违规、平台拒绝)、unknown 认不出;用户主动中断不是失败(F7)。
//   维度 B(失败前是否已有外部效果):B0 无外部动作、B1 已发动作但接收端按 action_id 幂等去重、B2 已在飞行且外部不幂等/结果未知。
// 组合裁决:A1×(B0|B1) 静默指数退避(次数、基数、封顶、抖动是参数,harness 已重试的次数计入同一预算,F3);unknown×(B0|B1) 最多 1 次(F8);
//   任意×B2 0 次自动重发、置 DeliveryUnknown(F9);A2/A3 任意 B 0 次立即出卡(F2);整轮已由宿主判卡死不再静默重试同一轮(D26 §8.3)。
// 另含:共享上游熔断器(F10)、启动回收防毒丸崩溃循环(F12)、OS 休眠唤醒宽限门与执行者存活判定(F11)、可恢复失败卡的 CAS 领取与跳过范围(A27-05)。
// 所有入口先按普通数据对象合同判定(plainData:Proxy、访问器一律拒收且不调用),合法 JSON 的 null 返回拒绝结果不抛错;导出的表与默认参数冻结。
// 默认参数里的数字(重试上限、退避基数与封顶、熔断阈值与冷却、休眠跳变与宽限)是占位,验收文档第 9 节「F8/F10 阈值待定」,不是用户定案。
import { plainData } from "./plain.ts";

export type HealClass = "A1" | "A2" | "A3" | "unknown";
export type EffectClass = "B0" | "B1" | "B2";
export const HEAL_CLASSES: readonly HealClass[] = Object.freeze(["A1", "A2", "A3", "unknown"] as const);
export const EFFECT_CLASSES: readonly EffectClass[] = Object.freeze(["B0", "B1", "B2"] as const);

/** 失败原因类别(D26 §8.4,由失败分类器给出)→ 维度 A。user_stopped 不是失败,单独返回;表里没有的一律 unknown。 */
const HEAL_BY_REASON: ReadonlyMap<string, HealClass | "user_stopped"> = new Map<string, HealClass | "user_stopped">([
  ["upstream_unavailable", "A1"],
  ["rate_limited", "A1"],
  ["no_response", "A1"],
  ["stream_dropped", "A1"],
  ["stalled", "A1"],
  ["harness_crashed", "A1"],
  ["auth_or_quota", "A2"],
  ["invalid_request", "A2"],
  ["context_overflow", "A2"],
  ["session_lost", "A2"],
  ["platform_refused", "A3"],
  ["user_stopped", "user_stopped"],
  ["unknown", "unknown"],
]);
export function healOf(reasonClass: unknown): HealClass | "user_stopped" {
  return typeof reasonClass === "string" ? (HEAL_BY_REASON.get(reasonClass) ?? "unknown") : "unknown";
}
/** 维度 B:宿主按本轮已发出的动作给出 hint;分类器判「不知道副作用做没做完」(UnknownEffect)时一律按 B2。 */
export function effectOf(hint: unknown, retryClass?: unknown): EffectClass {
  if (retryClass === "UnknownEffect") return "B2";
  return hint === "B0" || hint === "B1" || hint === "B2" ? hint : "B2";
}

// ======================= 重试裁决 =======================
export interface RetryPolicy {
  /** A1×(B0|B1) 自动重试上限;harness 在同一轮内部已经重试的次数也算在里面(统一重试权,F3)。 */
  readonly maxAutoRetries: number;
  /** unknown×(B0|B1) 的上限,只能是 0 或 1(F8:有界重试 ≤ 1 次)。 */
  readonly unknownMaxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** 0–1:延迟在 [raw×(1−jitter), raw] 之间,随机数由调用方注入。 */
  readonly jitter: number;
}
/** 占位默认值(第 9 节 F8/F10 阈值待实测校准,不是用户定案)。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ maxAutoRetries: 3, unknownMaxRetries: 1, baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0.2 });

const isNat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isPosFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type Rec = Record<string, unknown>;
/** 判定为普通数据对象并返回冻结副本;不合格返回原因。 */
function record(x: unknown, at: string): { ok: true; v: Rec } | { ok: false; reason: string } {
  const p = plainData(x, at);
  if (!p.ok) return { ok: false, reason: `${p.path}:${p.why}` };
  if (typeof p.value !== "object" || p.value === null || Array.isArray(p.value)) return { ok: false, reason: `${at} 必须是对象` };
  return { ok: true, v: p.value as Rec };
}

export function checkRetryPolicy(x: unknown): { ok: true; policy: RetryPolicy } | { ok: false; reason: string } {
  if (x === undefined) return { ok: true, policy: DEFAULT_RETRY_POLICY };
  const r = record(x, "重试参数");
  if (!r.ok) return r;
  const v = { ...DEFAULT_RETRY_POLICY, ...r.v } as Rec;
  if (!isNat(v.maxAutoRetries)) return { ok: false, reason: "maxAutoRetries 必须是非负整数" };
  if (!isNat(v.unknownMaxRetries) || v.unknownMaxRetries > 1) return { ok: false, reason: "unknownMaxRetries 只能是 0 或 1" };
  if (!isPosFinite(v.baseDelayMs) || !isPosFinite(v.maxDelayMs) || v.maxDelayMs < v.baseDelayMs) return { ok: false, reason: "baseDelayMs、maxDelayMs 必须是正数且封顶不小于基数" };
  if (!isFiniteNum(v.jitter) || v.jitter < 0 || v.jitter > 1) return { ok: false, reason: "jitter 必须在 0–1 之间" };
  return { ok: true, policy: Object.freeze({ maxAutoRetries: v.maxAutoRetries, unknownMaxRetries: v.unknownMaxRetries, baseDelayMs: v.baseDelayMs, maxDelayMs: v.maxDelayMs, jitter: v.jitter }) };
}

/** 第 attempt 次(从 0 起)自动重试前等多久:min(封顶, 基数×2^attempt),再按抖动往下收;随机数不合法按 0。 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, rand: () => number = Math.random): number {
  const k = isNat(attempt) ? attempt : 0;
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(k, 52));
  let r = 0;
  try {
    const x = rand();
    if (isFiniteNum(x) && x >= 0 && x < 1) r = x;
  } catch {
    /* 注入的随机数出错按 0 */
  }
  return Math.floor(raw * (1 - policy.jitter * r));
}

export type RetryDecision =
  /** 用户主动中断:不是失败,0 重试 0 出卡,清掉本轮残留的瞬态错误快照(F7)。 */
  | { readonly kind: "aborted"; readonly clearTransient: true }
  /** 静默退避重试:状态行显示「重连中 attempt/limit」,不出卡。 */
  | { readonly kind: "retry"; readonly attempt: number; readonly limit: number; readonly delayMs: number }
  /** 出 1 张原位可恢复失败卡。 */
  | { readonly kind: "card"; readonly cause: "exhausted" | "permanent" | "delivery-unknown" | "stall"; readonly deliveryUnknown: boolean; readonly attempts: number }
  | { readonly kind: "invalid"; readonly reason: string };

export interface FailureFacts {
  readonly heal: HealClass;
  readonly effect: EffectClass;
  /** 这一失败批次宿主已经自动重试过的次数。 */
  readonly attempts: number;
  /** harness(CLI、模型 SDK)在这一轮内部已经重试的次数,与宿主共用预算。 */
  readonly harnessAttempts?: number;
  readonly userAborted?: boolean;
  /** 整轮已由宿主判卡死(D26 §8.3):不再静默重试同一轮。 */
  readonly stallJudged?: boolean;
}

export function decideRetry(facts: unknown, policy?: unknown, rand: () => number = Math.random): RetryDecision {
  const f = record(facts, "失败事实");
  if (!f.ok) return { kind: "invalid", reason: f.reason };
  const p = checkRetryPolicy(policy);
  if (!p.ok) return { kind: "invalid", reason: p.reason };
  const { heal, effect, attempts } = f.v;
  const harness = f.v.harnessAttempts ?? 0;
  if (f.v.userAborted !== undefined && typeof f.v.userAborted !== "boolean") return { kind: "invalid", reason: "userAborted 必须是布尔" };
  if (f.v.stallJudged !== undefined && typeof f.v.stallJudged !== "boolean") return { kind: "invalid", reason: "stallJudged 必须是布尔" };
  if (f.v.userAborted === true) return { kind: "aborted", clearTransient: true };
  if (typeof heal !== "string" || !(HEAL_CLASSES as readonly string[]).includes(heal)) return { kind: "invalid", reason: "heal 必须是 A1/A2/A3/unknown" };
  if (typeof effect !== "string" || !(EFFECT_CLASSES as readonly string[]).includes(effect)) return { kind: "invalid", reason: "effect 必须是 B0/B1/B2" };
  if (!isNat(attempts) || !isNat(harness)) return { kind: "invalid", reason: "attempts、harnessAttempts 必须是非负整数" };
  const card = (cause: "exhausted" | "permanent" | "delivery-unknown" | "stall"): RetryDecision => ({ kind: "card", cause, deliveryUnknown: effect === "B2", attempts });
  // A2/A3:0 次自动重试,立即由宿主机械出卡(不依赖已挂的联系人脑子自报)
  if (heal === "A2" || heal === "A3") return card("permanent");
  // 已在飞行、外部不幂等:严禁自动重发,交用户确认
  if (effect === "B2") return card("delivery-unknown");
  if (f.v.stallJudged === true) return card("stall");
  const budget = heal === "A1" ? p.policy.maxAutoRetries : p.policy.unknownMaxRetries;
  if (attempts + harness >= budget) return card("exhausted");
  return { kind: "retry", attempt: attempts + 1, limit: budget - harness, delayMs: backoffDelay(attempts, p.policy, rand) };
}

// ======================= 共享上游熔断器(F10) =======================
export interface BreakerPolicy {
  /** 自上次成功以来,有多少个不同成员(联系人、任务)在同一上游上可自愈地失败(A1/unknown)就打开。
   *  同一个成员自己反复失败不触发共享熔断,由它自己的重试上限出卡;A2(鉴权/额度)第一次就打开。 */
  readonly memberThreshold: number;
  /** 打开后多久放一个半开探测(只对可自愈的打开原因;A2 打开的只能由用户在群级卡上发起探测)。 */
  readonly cooldownMs: number;
}
/** 占位默认值(第 9 节 F10 阈值待定)。 */
export const DEFAULT_BREAKER_POLICY: BreakerPolicy = Object.freeze({ memberThreshold: 2, cooldownMs: 30000 });
export type BreakerStatus = "closed" | "open" | "half-open";
export interface BreakerState {
  readonly status: BreakerStatus;
  /** 自上次成功以来的连续失败次数。 */
  readonly failures: number;
  readonly openedAt: number | null;
  readonly probeInFlight: boolean;
  /** 打开原因里有 A2(鉴权/额度):不自动半开探测,严禁对 403/401 自动重试,只能由用户发起。 */
  readonly manualOnly: boolean;
  /** 打开时的原因(给群级卡写人话用)。 */
  readonly reason: string | null;
  /** 自上次成功以来在这个上游上失败、被暂停、恢复后要续跑的成员,按首次失败顺序去重。 */
  readonly members: readonly string[];
}
export const BREAKER_CLOSED: BreakerState = Object.freeze({ status: "closed", failures: 0, openedAt: null, probeInFlight: false, manualOnly: false, reason: null, members: Object.freeze([]) as readonly string[] });
/** 交互关键路径优先于后台 Compute(本片只做接口:优先级被校验并记录,两者在熔断时同样暂停)。 */
export type BreakerPriority = "interactive" | "background";

const freezeState = (s: BreakerState): BreakerState => Object.freeze({ ...s, members: Object.freeze([...s.members]) });
function checkBreakerPolicy(x: unknown): { ok: true; policy: BreakerPolicy } | { ok: false; reason: string } {
  if (x === undefined) return { ok: true, policy: DEFAULT_BREAKER_POLICY };
  const r = record(x, "熔断参数");
  if (!r.ok) return r;
  const v = { ...DEFAULT_BREAKER_POLICY, ...r.v } as Rec;
  if (!isNat(v.memberThreshold) || v.memberThreshold < 1) return { ok: false, reason: "memberThreshold 必须是正整数" };
  if (!isNat(v.cooldownMs)) return { ok: false, reason: "cooldownMs 必须是非负整数" };
  return { ok: true, policy: Object.freeze({ memberThreshold: v.memberThreshold, cooldownMs: v.cooldownMs }) };
}
function checkBreakerState(x: unknown): { ok: true; state: BreakerState } | { ok: false; reason: string } {
  const r = record(x, "熔断状态");
  if (!r.ok) return r;
  const v = r.v;
  if (v.status !== "closed" && v.status !== "open" && v.status !== "half-open") return { ok: false, reason: "status 非法" };
  if (!isNat(v.failures) || !(v.openedAt === null || isFiniteNum(v.openedAt)) || typeof v.probeInFlight !== "boolean" || typeof v.manualOnly !== "boolean") return { ok: false, reason: "熔断状态字段非法" };
  if (!(v.reason === null || typeof v.reason === "string") || !Array.isArray(v.members) || !v.members.every((m) => typeof m === "string")) return { ok: false, reason: "熔断状态字段非法" };
  return { ok: true, state: v as unknown as BreakerState };
}

export type BreakerFailureResult =
  | { readonly ok: true; readonly state: BreakerState; /** 本次刚从关闭转为打开:全群合并只出这 1 张群级卡 */ readonly opened: boolean }
  | { readonly ok: false; readonly reason: string };
/**
 * 记一次失败。A3(内容拒绝)只关乎这次请求,不计入上游;A2 第一次就打开且之后只能由用户发起探测;
 * A1/unknown 在不同成员数到阈值时打开;已打开再失败只并入成员;半开探测失败回到打开、重新计冷却,都不再出卡。
 */
export function breakerFailure(state: unknown, ev: unknown, policy?: unknown): BreakerFailureResult {
  const s = checkBreakerState(state);
  if (!s.ok) return s;
  const e = record(ev, "熔断失败事件");
  if (!e.ok) return e;
  const p = checkBreakerPolicy(policy);
  if (!p.ok) return p;
  const { nowMs, heal, member, reason } = e.v;
  if (!isFiniteNum(nowMs) || typeof member !== "string" || !member || typeof reason !== "string") return { ok: false, reason: "nowMs、member、reason 必填" };
  if (typeof heal !== "string" || !(HEAL_CLASSES as readonly string[]).includes(heal)) return { ok: false, reason: "heal 必须是 A1/A2/A3/unknown" };
  const cur = s.state;
  if (heal === "A3") return { ok: true, state: freezeState(cur), opened: false };
  const members = cur.members.includes(member) ? cur.members : [...cur.members, member];
  const failures = cur.failures + 1;
  const manualOnly = cur.manualOnly || heal === "A2";
  if (cur.status === "open") return { ok: true, state: freezeState({ ...cur, failures, manualOnly, members }), opened: false };
  if (cur.status === "half-open") return { ok: true, state: freezeState({ ...cur, status: "open", failures, openedAt: nowMs, probeInFlight: false, manualOnly, members }), opened: false };
  if (heal === "A2" || members.length >= p.policy.memberThreshold) {
    return { ok: true, state: freezeState({ status: "open", failures, openedAt: nowMs, probeInFlight: false, manualOnly, reason, members }), opened: true };
  }
  return { ok: true, state: freezeState({ ...cur, failures, members }), opened: false };
}

export type BreakerSuccessResult =
  | { readonly ok: true; readonly state: BreakerState; /** 从打开/半开恢复 */ readonly recovered: boolean; /** 恢复后要续跑的成员 */ readonly resume: readonly string[] }
  | { readonly ok: false; readonly reason: string };
/** 记一次成功:回到关闭、清零;从打开/半开恢复时交回被暂停的成员续跑。 */
export function breakerSuccess(state: unknown): BreakerSuccessResult {
  const s = checkBreakerState(state);
  if (!s.ok) return s;
  const recovered = s.state.status !== "closed";
  return { ok: true, state: BREAKER_CLOSED, recovered, resume: Object.freeze(recovered ? [...s.state.members] : []) };
}

export type BreakerAdmitResult =
  | {
      readonly ok: true;
      readonly admit: boolean;
      readonly probe: boolean;
      /** 不放行时还要等多久(毫秒);等用户处理时为 0 且 needsUser 为 true。 */
      readonly waitMs: number;
      readonly needsUser: boolean;
      readonly state: BreakerState;
      readonly priority: BreakerPriority;
    }
  | { readonly ok: false; readonly reason: string };
/**
 * 要不要放行一次调用:关闭放行;打开时冷却未到一律暂停;冷却到期转半开,只放 1 个探测。
 * A2 打开的(manualOnly)冷却到期也不自动探测,只有用户在群级卡上点[重试](manual: true)才放 1 个探测;
 * 用户发起的探测不等冷却。
 */
export function breakerAdmit(state: unknown, req: unknown, policy?: unknown): BreakerAdmitResult {
  const s = checkBreakerState(state);
  if (!s.ok) return s;
  const q = record(req, "熔断放行请求");
  if (!q.ok) return q;
  const p = checkBreakerPolicy(policy);
  if (!p.ok) return p;
  const { nowMs } = q.v;
  const priority = q.v.priority ?? "interactive";
  const manual = q.v.manual ?? false;
  if (!isFiniteNum(nowMs)) return { ok: false, reason: "nowMs 必填" };
  if (priority !== "interactive" && priority !== "background") return { ok: false, reason: "priority 只能是 interactive/background" };
  if (typeof manual !== "boolean") return { ok: false, reason: "manual 必须是布尔" };
  const cur = s.state;
  const res = (admit: boolean, probe: boolean, waitMs: number, needsUser: boolean, st: BreakerState): BreakerAdmitResult => ({ ok: true, admit, probe, waitMs, needsUser, state: freezeState(st), priority });
  if (cur.status === "closed") return res(true, false, 0, false, cur);
  if (cur.probeInFlight) return res(false, false, p.policy.cooldownMs, false, cur);
  const probe = { ...cur, status: "half-open" as const, probeInFlight: true };
  if (manual) return res(true, true, 0, false, probe);
  if (cur.manualOnly) return res(false, false, 0, true, cur);
  if (cur.status === "half-open") return res(true, true, 0, false, probe);
  const due = (cur.openedAt ?? nowMs) + p.policy.cooldownMs;
  if (nowMs < due) return res(false, false, due - nowMs, false, cur);
  return res(true, true, 0, false, probe);
}

// ======================= 启动回收防毒丸崩溃循环(F12) =======================
export interface CrashState {
  /** 上一次在途未提交轮次的输入位点(同一 processed_seq 即同一输入)。 */
  readonly key: string | null;
  /** crash_recovery_count:同一输入已被启动回收的次数。 */
  readonly count: number;
}
export const CRASH_CLEAN: CrashState = Object.freeze({ key: null, count: 0 });
export type CrashRecoverResult =
  | { readonly ok: true; readonly state: CrashState; readonly decision: "resume" | "blocked"; readonly why: "first-recovery" | "crash-loop" | "delivery-unknown" }
  | { readonly ok: false; readonly reason: string };
/** 宿主重启后发现上次在途、未提交的轮次:递增 crash_recovery_count;只有不超过上限且属 B0/B1 才自动续跑,否则 CrashLoopBlocked 出卡。 */
export function crashRecover(state: unknown, found: unknown, maxRecoveries: number = 1): CrashRecoverResult {
  const s = record(state, "崩溃计数");
  if (!s.ok) return s;
  const f = record(found, "在途轮次");
  if (!f.ok) return f;
  if (!(s.v.key === null || typeof s.v.key === "string") || !isNat(s.v.count)) return { ok: false, reason: "崩溃计数字段非法" };
  if (typeof f.v.key !== "string" || !f.v.key) return { ok: false, reason: "key 必填" };
  const effect = f.v.effect ?? "B0";
  if (effect !== "B0" && effect !== "B1" && effect !== "B2") return { ok: false, reason: "effect 必须是 B0/B1/B2" };
  if (!isNat(maxRecoveries)) return { ok: false, reason: "maxRecoveries 必须是非负整数" };
  const count = s.v.key === f.v.key ? (s.v.count as number) + 1 : 1;
  const next: CrashState = Object.freeze({ key: f.v.key, count });
  if (effect === "B2") return { ok: true, state: next, decision: "blocked", why: "delivery-unknown" };
  if (count > maxRecoveries) return { ok: true, state: next, decision: "blocked", why: "crash-loop" };
  return { ok: true, state: next, decision: "resume", why: "first-recovery" };
}
/** 新的成功轮次:计数清零。 */
export function crashCommitted(): CrashState {
  return CRASH_CLEAN;
}

// ======================= OS 休眠唤醒宽限门与存活判定(F11) =======================
export interface WakePolicy {
  /** 相邻两次时钟采样的间隔超过它就判为刚从休眠醒来(系统时钟跳变)。 */
  readonly jumpMs: number;
  /** 醒来后的宽限期:期间不判 stopped-beating。 */
  readonly graceMs: number;
}
/** 占位默认值(需求文档举例「如 3 分钟」)。 */
export const DEFAULT_WAKE_POLICY: WakePolicy = Object.freeze({ jumpMs: 60000, graceMs: 180000 });
export interface WakeState {
  readonly lastTickMs: number | null;
  /** 最近一次检测到醒来的时刻;null 表示没检测到过。 */
  readonly awakeSince: number | null;
}
export const WAKE_INITIAL: WakeState = Object.freeze({ lastTickMs: null, awakeSince: null });
/** 休眠门参数合同(宿主构造运行台账时校验,不合格当场拒绝):未给的字段取默认值,返回冻结副本。空壳,待实现。 */
export function checkWakePolicy(x: unknown): { ok: true; policy: WakePolicy } | { ok: false; reason: string } {
  void x;
  throw new Error("未实现");
}
function checkWake(state: unknown, policy: unknown): { ok: true; s: WakeState; p: WakePolicy } | { ok: false; reason: string } {
  const s = record(state, "休眠门状态");
  if (!s.ok) return s;
  if (!(s.v.lastTickMs === null || isFiniteNum(s.v.lastTickMs)) || !(s.v.awakeSince === null || isFiniteNum(s.v.awakeSince))) return { ok: false, reason: "休眠门状态字段非法" };
  let p: WakePolicy = DEFAULT_WAKE_POLICY;
  if (policy !== undefined) {
    const r = record(policy, "休眠门参数");
    if (!r.ok) return r;
    const v = { ...DEFAULT_WAKE_POLICY, ...r.v } as Rec;
    if (!isPosFinite(v.jumpMs) || !isNat(v.graceMs)) return { ok: false, reason: "jumpMs 必须是正数、graceMs 必须是非负整数" };
    p = { jumpMs: v.jumpMs, graceMs: v.graceMs };
  }
  return { ok: true, s: s.v as unknown as WakeState, p };
}
/** 周期采样一次时钟:与上次采样相隔超过 jumpMs(合盖休眠、时钟跳变)就记 awakeSince = now。时钟回拨也按跳变处理。 */
export function wakeTick(state: unknown, nowMs: number, policy?: unknown): WakeState {
  const c = checkWake(state, policy);
  if (!c.ok || !isFiniteNum(nowMs)) return WAKE_INITIAL;
  const { lastTickMs, awakeSince } = c.s;
  const jumped = lastTickMs !== null && (nowMs - lastTickMs > c.p.jumpMs || nowMs < lastTickMs);
  return Object.freeze({ lastTickMs: nowMs, awakeSince: jumped ? nowMs : awakeSince });
}
/** 现在能不能把在途执行者判为 stopped-beating:醒来后的宽限期内一律不能;状态不合法时保守地不判。 */
export function mayJudgeStale(state: unknown, nowMs: number, policy?: unknown): boolean {
  const c = checkWake(state, policy);
  if (!c.ok || !isFiniteNum(nowMs)) return false;
  const { awakeSince } = c.s;
  return awakeSince === null || nowMs - awakeSince >= c.p.graceMs;
}
export type RunnerLiveness = "live" | "pid-dead" | "pid-reused" | "stopped-beating";
/**
 * 证据驱动的执行者存活判定:进程 PID 是否还在、启动编号 runOwnerBoot 是否对得上、心跳是否超时。
 * 心跳超时但处在休眠唤醒宽限期内 → 仍判 live(F11);宽限期过后真停滞照常判 stopped-beating。
 */
export function judgeRunner(input: unknown, wake: unknown, policy?: unknown): RunnerLiveness | { readonly invalid: string } {
  const r = record(input, "存活证据");
  if (!r.ok) return { invalid: r.reason };
  const { pidAlive, bootMatches, lastBeatMs, nowMs, staleAfterMs } = r.v;
  if (typeof pidAlive !== "boolean" || typeof bootMatches !== "boolean" || !isFiniteNum(lastBeatMs) || !isFiniteNum(nowMs) || !isPosFinite(staleAfterMs)) {
    return { invalid: "pidAlive、bootMatches 必须是布尔,lastBeatMs、nowMs、staleAfterMs 必须是数字" };
  }
  if (!pidAlive) return "pid-dead";
  if (!bootMatches) return "pid-reused";
  if (nowMs - lastBeatMs < staleAfterMs) return "live";
  return mayJudgeStale(wake, nowMs, policy) ? "stopped-beating" : "live";
}

// ======================= 可恢复失败卡:CAS 领取与跳过范围(A27-05) =======================
export type FailureCardStatus = "open" | "claimed" | "done" | "expired";
export type FailureCardAction = "retry" | "switch-model" | "skip" | "give-up";
export const FAILURE_CARD_ACTIONS: readonly FailureCardAction[] = Object.freeze(["retry", "switch-model", "skip", "give-up"] as const);
export interface FailureCardRecord {
  readonly status: FailureCardStatus;
  readonly ownerUserId: string;
  readonly contactId: string;
  /** 本卡对应的尝试代次;重跑产生新代次后,旧代次的迟到点击一律丢弃。 */
  readonly attemptSeq: number;
  /** 可显式选用的备用模型(用户选了才换,严禁静默换模)。 */
  readonly allowedModels: readonly string[];
}
export interface FailureCardClaim {
  readonly by: { readonly kind: "user" | "auto"; readonly id: string };
  readonly attemptSeq: number;
  readonly action: FailureCardAction;
  readonly targetModel?: string | null;
}
export type ClaimRefusal = "invalid" | "not-open" | "stale-attempt" | "forbidden" | "auto-not-allowed" | "model-required" | "model-not-allowed" | "model-not-explicit";
export type ClaimResult = { readonly ok: true; readonly card: FailureCardRecord; readonly targetModel: string | null } | { readonly ok: false; readonly reason: ClaimRefusal; readonly detail: string };
/**
 * 原子领取的判定规则(宿主用同一规则做数据库 CAS:open → claimed):
 * 非 open(已被连点或自动恢复领走)拒绝;代次对不上拒绝;用户点击须是卡片主人;自动恢复只能「重试」,不能换模、不能跳过;
 * 只有「换模型重试」能带目标模型,且必须在可选清单里;别的动作带模型一律拒绝(严禁静默换模)。
 */
export function claimFailureCard(card: unknown, claim: unknown): ClaimResult {
  const bad = (reason: ClaimRefusal, detail: string): ClaimResult => ({ ok: false, reason, detail });
  const c = record(card, "失败卡");
  if (!c.ok) return bad("invalid", c.reason);
  const q = record(claim, "领取请求");
  if (!q.ok) return bad("invalid", q.reason);
  const k = c.v;
  if (!["open", "claimed", "done", "expired"].includes(k.status as string) || typeof k.ownerUserId !== "string" || typeof k.contactId !== "string" || !isNat(k.attemptSeq)) return bad("invalid", "失败卡字段非法");
  if (!Array.isArray(k.allowedModels) || !k.allowedModels.every((m) => typeof m === "string")) return bad("invalid", "allowedModels 必须是字符串数组");
  const by = q.v.by as Rec | null;
  if (typeof by !== "object" || by === null || (by.kind !== "user" && by.kind !== "auto") || typeof by.id !== "string") return bad("invalid", "by 必须是 {kind:user|auto,id}");
  if (!isNat(q.v.attemptSeq)) return bad("invalid", "attemptSeq 必须是非负整数");
  const action = q.v.action;
  if (typeof action !== "string" || !(FAILURE_CARD_ACTIONS as readonly string[]).includes(action)) return bad("invalid", "action 非法");
  const target = q.v.targetModel ?? null;
  if (target !== null && typeof target !== "string") return bad("invalid", "targetModel 必须是字符串");
  if (k.status !== "open") return bad("not-open", `卡片已是 ${String(k.status)}`);
  if (q.v.attemptSeq !== k.attemptSeq) return bad("stale-attempt", `代次 ${q.v.attemptSeq} 不是当前代次 ${k.attemptSeq}`);
  if (by.kind === "user" && by.id !== k.ownerUserId) return bad("forbidden", "只有卡片主人能处理");
  if (by.kind === "auto" && action !== "retry") return bad("auto-not-allowed", "自动恢复只能重试本轮");
  if (action === "switch-model") {
    if (!target) return bad("model-required", "换模型重试要选一个模型");
    if (!(k.allowedModels as string[]).includes(target)) return bad("model-not-allowed", `模型 ${target} 不在可选清单里`);
  } else if (target !== null) return bad("model-not-explicit", "只有「换模型重试」能换模型");
  return { ok: true, card: Object.freeze({ ...(k as unknown as FailureCardRecord), status: "claimed" }), targetModel: action === "switch-model" ? target : null };
}
/**
 * [跳过本轮] 之后每个会话的处理位置:只推到引发失败的那一批的末尾 failed_batch_end_seq,绝不推到最新;
 * 已处理位置已经更靠后的不回退。失败期间新到的消息(seq > failed_batch_end_seq)留给下一轮。
 */
export function skipTarget(processed: unknown, failedBatchEnd: unknown): { ok: true; cursors: Readonly<Record<string, number>> } | { ok: false; reason: string } {
  const p = record(processed, "处理位置");
  if (!p.ok) return p;
  const f = record(failedBatchEnd, "失败批次末尾");
  if (!f.ok) return f;
  const out: Record<string, number> = Object.create(null);
  for (const [room, seq] of Object.entries(f.v)) {
    if (!isNat(seq)) return { ok: false, reason: `失败批次末尾 ${room} 必须是非负整数` };
    const cur = p.v[room] ?? 0;
    if (!isNat(cur)) return { ok: false, reason: `处理位置 ${room} 必须是非负整数` };
    out[room] = Math.max(cur, seq);
  }
  return { ok: true, cursors: Object.freeze(out) };
}
