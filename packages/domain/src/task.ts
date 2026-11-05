// 第三台状态机:任务生命周期(需求文档 D20.3,本片覆盖主干)。—— 红提交:空壳
export const STATES = ["T1_Open", "T2_Claimed", "T3_Running", "T4b_BlockedOnHuman", "T5_InReview", "T7_Delivering", "T8a_Delivered", "T8_Accepted", "T8_ArchivedUnverified", "T9_StopRequested", "T10_Cancelled", "T11_Failed"] as const;
export type TaskState = (typeof STATES)[number];
export const EVENT_KINDS = ["Claim", "Dispatch", "ProducerModelAdded", "NeedHuman", "HumanReply", "Amend", "SubmitForReview", "Review", "DeliveredCard", "UserAccept", "UserReject", "AcceptTimeout", "Cancel", "StoppedConfirmed", "ExecFailed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type TaskEvent =
  | { kind: "Claim"; by: string }
  | { kind: "Dispatch"; computeId: string; model: string }
  | { kind: "ProducerModelAdded"; model: string }
  | { kind: "NeedHuman"; qId: string }
  | { kind: "HumanReply"; qId: string; constraintVer: number; answer: "approve" | "reject" }
  | { kind: "Amend"; by: string }
  | { kind: "SubmitForReview"; commit: string }
  | { kind: "Review"; reviewerId: string; reviewerModel: string; verdict: "approve" | "reject"; waiverBy?: string }
  | { kind: "DeliveredCard" }
  | { kind: "UserAccept"; by: string }
  | { kind: "UserReject"; by: string; computeResumable: boolean }
  | { kind: "AcceptTimeout" }
  | { kind: "Cancel"; by: string }
  | { kind: "StoppedConfirmed" }
  | { kind: "ExecFailed" };

export type ReviewGate = "none" | "compliant" | "waived-by-user";
export type VerificationBadge = "none" | "accepted" | "unverified";
export interface Task {
  readonly id: string;
  readonly requester: string;
  readonly state: TaskState;
  readonly owner: string | null;
  readonly constraintVer: number;
  readonly computeId: string | null;
  readonly producerModels: readonly string[];
  readonly pendingQ: { qId: string; constraintVer: number } | null;
  readonly reviewedCommit: string | null;
  readonly reviewGate: ReviewGate;
  readonly badge: VerificationBadge;
  readonly stopReason: "cancel" | "fail" | null;
}
export type Effect =
  | { kind: "resume-compute"; computeId: string }
  | { kind: "spawn-compute"; withHandoff: boolean }
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
export function apply(_t: Task, _e: TaskEvent): Outcome { throw new Error("未实现"); }
export function applyAll(_t: Task, _events: readonly TaskEvent[]): Outcome { throw new Error("未实现"); }
