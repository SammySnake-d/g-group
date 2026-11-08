// 失败轮次 A×B 双维容错的纯策略(AC-36,需求文档 D15.1 第六层、U75、AC-P0-12)。不做 I/O,时钟与随机数由调用方注入。
//   维度 A(同样输入重试能否成功):A1 可能自愈(5xx、断流、429、超时、子进程意外退出)、A2 需人先修配置/配额(401/403、额度、模型不存在)、
//     A3 永久拒绝(内容违规、平台拒绝)、unknown 认不出;用户主动中断不是失败(F7)。
//   维度 B(失败前是否已有外部效果):B0 无外部动作、B1 已发动作但接收端按 action_id 幂等去重、B2 已在飞行且外部不幂等/结果未知。
// 组合裁决:A1×(B0|B1) 静默指数退避(次数、基数、封顶、抖动是参数,harness 已重试的次数计入同一预算,F3);unknown×(B0|B1) 最多 1 次(F8);
//   任意×B2 0 次自动重发、置 DeliveryUnknown(F9);A2/A3 任意 B 0 次立即出卡(F2);整轮已由宿主判卡死不再静默重试同一轮(D26 §8.3)。
// 另含:共享上游熔断器(F10)、启动回收防毒丸崩溃循环(F12)、OS 休眠唤醒宽限门与执行者存活判定(F11)、可恢复失败卡的 CAS 领取与跳过范围(A27-05)。
// 所有入口先按普通数据对象合同判定(plainData:Proxy、访问器一律拒收且不调用),合法 JSON 的 null 返回拒绝结果不抛错;导出的表与默认参数冻结。
// 默认参数里的数字(重试上限、退避基数与封顶、熔断阈值与冷却、休眠跳变与宽限)是占位,验收文档第 9 节「F8/F10 阈值待定」,不是用户定案。

export type HealClass = "A1" | "A2" | "A3" | "unknown";
export type EffectClass = "B0" | "B1" | "B2";
export const HEAL_CLASSES: readonly HealClass[] = Object.freeze(["A1", "A2", "A3", "unknown"] as const);
export const EFFECT_CLASSES: readonly EffectClass[] = Object.freeze(["B0", "B1", "B2"] as const);

/** 失败原因类别(D26 §8.4,由失败分类器给出)→ 维度 A。user_stopped 不是失败,单独返回;表里没有的一律 unknown。 */
export function healOf(reasonClass: unknown): HealClass | "user_stopped" {
  void reasonClass;
  return "unknown";
}
/** 维度 B:宿主按本轮已发出的动作给出 hint;分类器判「不知道副作用做没做完」(UnknownEffect)时一律按 B2。 */
export function effectOf(hint: unknown, retryClass?: unknown): EffectClass {
  void hint;
  void retryClass;
  return "B0";
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



export function checkRetryPolicy(x: unknown): { ok: true; policy: RetryPolicy } | { ok: false; reason: string } {
  void x;
  return { ok: false, reason: "未实现" };
}

/** 第 attempt 次(从 0 起)自动重试前等多久:min(封顶, 基数×2^attempt),再按抖动往下收;随机数不合法按 0。 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, rand: () => number = Math.random): number {
  void attempt;
  void policy;
  void rand;
  return 0;
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
  void facts;
  void policy;
  void rand;
  return { kind: "invalid", reason: "未实现" };
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


export type BreakerFailureResult =
  | { readonly ok: true; readonly state: BreakerState; /** 本次刚从关闭转为打开:全群合并只出这 1 张群级卡 */ readonly opened: boolean }
  | { readonly ok: false; readonly reason: string };
/**
 * 记一次失败。A3(内容拒绝)只关乎这次请求,不计入上游;A2 第一次就打开且之后只能由用户发起探测;
 * A1/unknown 在不同成员数到阈值时打开;已打开再失败只并入成员;半开探测失败回到打开、重新计冷却,都不再出卡。
 */
export function breakerFailure(state: unknown, ev: unknown, policy?: unknown): BreakerFailureResult {
  void state;
  void ev;
  void policy;
  return { ok: false, reason: "未实现" };
}

export type BreakerSuccessResult =
  | { readonly ok: true; readonly state: BreakerState; /** 从打开/半开恢复 */ readonly recovered: boolean; /** 恢复后要续跑的成员 */ readonly resume: readonly string[] }
  | { readonly ok: false; readonly reason: string };
/** 记一次成功:回到关闭、清零;从打开/半开恢复时交回被暂停的成员续跑。 */
export function breakerSuccess(state: unknown): BreakerSuccessResult {
  void state;
  return { ok: false, reason: "未实现" };
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
  void state;
  void req;
  void policy;
  return { ok: false, reason: "未实现" };
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
  void state;
  void found;
  void maxRecoveries;
  return { ok: false, reason: "未实现" };
}
/** 新的成功轮次:计数清零。 */
export function crashCommitted(): CrashState {
  return { key: "未实现", count: -1 };
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
/** 周期采样一次时钟:与上次采样相隔超过 jumpMs(合盖休眠、时钟跳变)就记 awakeSince = now。时钟回拨也按跳变处理。 */
export function wakeTick(state: unknown, nowMs: number, policy?: unknown): WakeState {
  void state;
  void nowMs;
  void policy;
  return WAKE_INITIAL;
}
/** 现在能不能把在途执行者判为 stopped-beating:醒来后的宽限期内一律不能;状态不合法时保守地不判。 */
export function mayJudgeStale(state: unknown, nowMs: number, policy?: unknown): boolean {
  void state;
  void nowMs;
  void policy;
  return false;
}
export type RunnerLiveness = "live" | "pid-dead" | "pid-reused" | "stopped-beating";
/**
 * 证据驱动的执行者存活判定:进程 PID 是否还在、启动编号 runOwnerBoot 是否对得上、心跳是否超时。
 * 心跳超时但处在休眠唤醒宽限期内 → 仍判 live(F11);宽限期过后真停滞照常判 stopped-beating。
 */
export function judgeRunner(input: unknown, wake: unknown, policy?: unknown): RunnerLiveness | { readonly invalid: string } {
  void input;
  void wake;
  void policy;
  return { invalid: "未实现" };
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
  void card;
  void claim;
  return { ok: false, reason: "invalid", detail: "未实现" };
}
/**
 * [跳过本轮] 之后每个会话的处理位置:只推到引发失败的那一批的末尾 failed_batch_end_seq,绝不推到最新;
 * 已处理位置已经更靠后的不回退。失败期间新到的消息(seq > failed_batch_end_seq)留给下一轮。
 */
export function skipTarget(processed: unknown, failedBatchEnd: unknown): { ok: true; cursors: Readonly<Record<string, number>> } | { ok: false; reason: string } {
  void processed;
  void failedBatchEnd;
  return { ok: false, reason: "未实现" };
}
