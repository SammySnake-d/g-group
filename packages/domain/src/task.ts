// 第三台状态机:任务生命周期(需求文档 D20.3 第三台表,本片覆盖主干)。—— 红提交:空壳
// 状态×事件表是一张穷尽的对象字面量:少一格 TypeScript 就报错(AC-09);每格要么转移,要么写明拒绝/忽略原因。
// 纯函数:apply 不改入参,返回新任务和要宿主执行的副作用(恢复/新开/停止 Compute、释放槽位)。
export const STATES = ["T1_Open", "T2_Claimed", "T3_Running", "T4b_BlockedOnHuman", "T5_InReview", "T7_Delivering", "T8a_Delivered", "T8_Accepted", "T8_ArchivedUnverified", "T9_StopRequested", "T10_Cancelled", "T11_Failed"] as const;
export type TaskState = (typeof STATES)[number];
export const EVENT_KINDS = ["Claim", "Dispatch", "ProducerModelAdded", "NeedHuman", "HumanReply", "Amend", "SubmitForReview", "Review", "DeliveredCard", "UserAccept", "UserReject", "AcceptTimeout", "Cancel", "StoppedConfirmed", "ExecFailed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type TaskEvent =
  | { kind: "Claim"; by: string }
  // requestId:新实例回报的是哪一次启动请求;返工后新开的实例必须带上并对上当前启动(R2-CORR-01/02)
  | { kind: "Dispatch"; computeId: string; model: string; requestId?: string }
  | { kind: "ProducerModelAdded"; model: string }
  | { kind: "NeedHuman"; qId: string }
  | { kind: "HumanReply"; qId: string; constraintVer: number; answer: "approve" | "reject" }
  // computeResumable:宿主报告当前 Compute 实例能否恢复;只有需要返工的入口(T5/T7/T8 改条件)读它,T1–T4b 的改条件不涉及恢复
  | { kind: "Amend"; by: string; computeResumable: boolean }
  | { kind: "SubmitForReview"; commit: string }
  // 审查回包绑定被审对象 (round, commit, constraintVer):round 是每次提审新分配、永不复用的轮次号,对不上就是过期回包(CORR-01 / R2-CORR-04)
  | ({ kind: "Review"; reviewerId: string; reviewerModel: string; round: number; commit: string; constraintVer: number; waiverBy?: string }
    & ({ verdict: "approve" } | { verdict: "reject"; computeResumable: boolean }))
  | { kind: "DeliveredCard" }
  | { kind: "UserAccept"; by: string }
  | { kind: "UserReject"; by: string; computeResumable: boolean }
  | { kind: "AcceptTimeout" }
  | { kind: "Cancel"; by: string }
  // 停止确认必须指明确认的是哪个实例(computeId)或哪次启动撤销(requestId);对不上当前等待对象的是迟到回包(R2-CORR-01)
  | { kind: "StoppedConfirmed"; computeId?: string; requestId?: string }
  | { kind: "ExecFailed" };

/** 确认卡绑定快照:创建后冻结,不与其它 Task 共享(CORR-04)。 */
export interface PendingQuestion { readonly qId: string; readonly constraintVer: number }
export interface Launch { readonly requestId: string; readonly constraintVer: number }
export type ReviewGate = "none" | "compliant" | "waived-by-user";
export type VerificationBadge = "none" | "accepted" | "unverified";
export interface Task {
  readonly id: string;
  readonly requester: string;
  readonly state: TaskState;
  readonly owner: string | null;
  readonly constraintVer: number;
  readonly computeId: string | null;
  /** 已发出、尚未回绑的启动请求,绑定发起时的条件版本(CORR-02 / R2-CORR-01/02)。 */
  readonly launch: Launch | null;
  /** 已分配过的启动请求个数,只增不减,用来生成永不复用的 requestId。 */
  readonly launchSeq: number;
  /** 已分配过的审查轮次号,只增不减;处于 T5 时就是当前提审的轮次(R2-CORR-04)。 */
  readonly reviewRound: number;
  readonly producerModels: readonly string[];
  readonly pendingQ: PendingQuestion | null;
  readonly reviewedCommit: string | null;
  readonly reviewGate: ReviewGate;
  readonly badge: VerificationBadge;
  readonly stopReason: "cancel" | "fail" | null;
}
export type Effect =
  | { kind: "resume-compute"; computeId: string }
  | { kind: "spawn-compute"; withHandoff: boolean; requestId: string; constraintVer: number }
  | { kind: "cancel-spawn"; requestId: string }
  | { kind: "request-review"; round: number; commit: string; constraintVer: number }
  | { kind: "stop-compute"; computeId: string }
  | { kind: "release-slot"; computeId: string };
export type Outcome =
  | { ok: true; task: Task; effects: Effect[] }
  | { ok: false; reason: string };
export type Cell =
  | { kind: "go"; run: (t: Task, e: TaskEvent) => Outcome }
  | { kind: "reject"; reason: string }
  | { kind: "ignore"; reason: string };
export type TransitionTable = { readonly [S in TaskState]: { readonly [E in EventKind]: Cell } };


export const TABLE: TransitionTable = undefined as unknown as TransitionTable;
export function newTask(_id: string, _requester: string): Task { throw new Error("未实现"); }
export function applyAll(_t: Task, _events: readonly TaskEvent[]): Outcome { throw new Error("未实现"); }
export function apply(_t: Task, _e: TaskEvent): Outcome { throw new Error("未实现"); }
