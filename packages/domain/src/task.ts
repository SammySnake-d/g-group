import { type Vendor, vendorOf } from "./vendor.ts";
// 第三台状态机:任务生命周期(需求文档 D20.3 第三台表,本片覆盖主干)。
// 状态×事件表是一张穷尽的对象字面量:少一格 TypeScript 就报错(AC-09);每格要么转移,要么写明拒绝/忽略原因。
// 纯函数:apply 不改入参,返回新任务和要宿主执行的副作用(恢复/新开/停止 Compute、释放槽位)。
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

const ok = (task: Task, effects: Effect[] = []): Outcome => ({ ok: true, task, effects });
const no = (reason: string): Outcome => ({ ok: false, reason });
const go = (run: (t: Task, e: TaskEvent) => Outcome): Cell => ({ kind: "go", run });
const rej = (reason: string): Cell => ({ kind: "reject", reason });
const ign = (reason: string): Cell => ({ kind: "ignore", reason });
/** 表格按事件种类分发,这里再核对一次,防止表格接错列时静默读到别的字段。 */
const as = <K extends EventKind>(e: TaskEvent, k: K): Extract<TaskEvent, { kind: K }> => {
  if (e.kind !== k) throw new Error(`状态表接错:期望 ${k},收到 ${e.kind}`);
  return e as Extract<TaskEvent, { kind: K }>;
};
const set = (t: Task, patch: Partial<Task>): Task => Object.freeze({ ...t, ...patch, producerModels: Object.freeze([...(patch.producerModels ?? t.producerModels)]) });

export function newTask(id: string, requester: string): Task {
  return set({
    id, requester, state: "T1_Open", owner: null, constraintVer: 0, computeId: null, producerModels: [],
    pendingQ: null, reviewedCommit: null, reviewGate: "none", badge: "none", stopReason: null,
  }, {});
}

/** 用户改条件:版本单调递增;阻塞卡片与当前评审作废,回到执行。 */
const amend = go((t) => ok(set(t, { constraintVer: t.constraintVer + 1, pendingQ: null, reviewedCommit: null, reviewGate: "none", state: t.computeId ? "T3_Running" : t.state })));
/** 有活跃 Compute 时先请求停止,等真实停止确认;没有就直接进终态。 */
const stopThenRun = (t: Task, reason: "cancel" | "fail"): Outcome => t.computeId
  ? ok(set(t, { state: "T9_StopRequested", stopReason: reason }), [{ kind: "stop-compute", computeId: t.computeId }])
  : ok(set(t, { state: reason === "cancel" ? "T10_Cancelled" : "T11_Failed", stopReason: reason }));
const stopThen = (reason: "cancel" | "fail") => go((t) => stopThenRun(t, reason));
const cancel = stopThen("cancel");
const execFailed = stopThen("fail");
const addModel = go((t, e) => {
  const m = as(e, "ProducerModelAdded").model;
  return ok(set(t, { producerModels: t.producerModels.includes(m) ? t.producerModels : [...t.producerModels, m] }));
});
/** 退回返工:默认恢复原 Compute;原实例不可恢复时带交接摘要新开(AC-28 / #820 / #865)。 */
const rework = (t: Task, resumable: boolean): Outcome => {
  const effects: Effect[] = resumable && t.computeId ? [{ kind: "resume-compute", computeId: t.computeId }] : [{ kind: "spawn-compute", withHandoff: true }];
  return ok(set(t, { state: "T3_Running", constraintVer: t.constraintVer + 1, reviewedCommit: null, reviewGate: "none", badge: "none", computeId: resumable ? t.computeId : null }), effects);
};
const userReject = go((t, e) => {
  const ev = as(e, "UserReject");
  return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);
});

/** T5 守卫(AC-26 / R-01):审查人≠作者;审查厂商不在累积生产厂商集合里;任何一方 unknown 都拒;提出者本人可豁免同厂商,记为 Waived。 */
const review = go((t, e) => {
  const ev = as(e, "Review");
  if (ev.reviewerId === t.owner) return no(`审查人 ${ev.reviewerId} 就是作者,不能自审`);
  const producers = new Set<Vendor>(t.producerModels.map(vendorOf));
  const reviewer = vendorOf(ev.reviewerModel);
  if (producers.size === 0) return no("没有记录到生产模型,无法判定跨厂商");
  if (producers.has("unknown")) return no("有生产模型认不出厂商(unknown)");
  if (reviewer === "unknown") return no(`审查模型 ${ev.reviewerModel} 认不出厂商(unknown)`);
  let gate: ReviewGate = "compliant";
  if (producers.has(reviewer)) {
    if (ev.waiverBy !== t.requester) return no(`审查厂商 ${reviewer} 在生产厂商集合 {${[...producers].join(",")}} 里,且没有提出者本人的豁免`);
    gate = "waived-by-user";
  }
  if (ev.verdict === "reject") return rework(set(t, { reviewGate: "none" }), true);
  return ok(set(t, { state: "T7_Delivering", reviewGate: gate }));
});

type Row = { readonly [E in EventKind]: Cell };
const TERMINAL = "终态,迟到事件幂等忽略,不复活任务";
const terminalRow = (): Row => Object.fromEntries(EVENT_KINDS.map((k) => [k, ign(TERMINAL)])) as unknown as Row;
const NOT_RUNNING = "当前不在执行,没有可接收这一事件的 Compute";
const NO_CARD = "当前没有待回复的确认卡";
const NOT_DELIVERED = "当前不在待验收状态";

export const TABLE: TransitionTable = {
  T1_Open: {
    Claim: go((t, e) => ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by }))),
    Dispatch: rej("尚未认领,不能派发"), ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: rej(NOT_RUNNING),
    HumanReply: ign(NO_CARD), Amend: go((t) => ok(set(t, { constraintVer: t.constraintVer + 1 }))),
    SubmitForReview: rej(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign(NOT_RUNNING),
  },
  T2_Claimed: {
    Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),
    Dispatch: go((t, e) => { const ev = as(e, "Dispatch"); return ok(set(t, { state: "T3_Running", computeId: ev.computeId, producerModels: [...new Set([...t.producerModels, ev.model])] })); }),
    ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: rej(NOT_RUNNING), HumanReply: ign(NO_CARD),
    Amend: go((t) => ok(set(t, { constraintVer: t.constraintVer + 1 }))),
    SubmitForReview: rej(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign("尚未派发"),
  },
  T3_Running: {
    Claim: rej("已在执行,拒绝重复认领"), Dispatch: rej("已有 Compute 在执行"), ProducerModelAdded: addModel,
    NeedHuman: go((t, e) => ok(set(t, { state: "T4b_BlockedOnHuman", pendingQ: { qId: as(e, "NeedHuman").qId, constraintVer: t.constraintVer } }))),
    HumanReply: ign("卡片已作废或已处理,迟到的点击幂等忽略"), Amend: amend,
    SubmitForReview: go((t, e) => ok(set(t, { state: "T5_InReview", reviewedCommit: as(e, "SubmitForReview").commit }))),
    Review: rej("不在审查中"), DeliveredCard: rej("还没审查,不能直接交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: execFailed,
  },
  T4b_BlockedOnHuman: {
    Claim: rej("已在执行,拒绝重复认领"), Dispatch: rej("已有 Compute 在执行"), ProducerModelAdded: addModel, NeedHuman: rej("已有一张待回复的卡"),
    HumanReply: go((t, e) => {
      const ev = as(e, "HumanReply");
      const q = t.pendingQ;
      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);
      // 回复绑定 (task_id, q_id, constraint_ver):版本对不上说明是旧卡上的点击,幂等忽略,当前卡继续等(AC-19)
      if (ev.constraintVer !== q.constraintVer) return ok(t);
      const cleared = set(t, { pendingQ: null });
      return ev.answer === "approve" ? ok(set(cleared, { state: "T3_Running" })) : stopThenRun(cleared, "cancel");
    }),
    Amend: amend, SubmitForReview: rej("等人确认中,不能提审"), Review: rej("不在审查中"), DeliveredCard: rej("等人确认中"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: execFailed,
  },
  T5_InReview: {
    Claim: rej("审查中,拒绝重复认领"), Dispatch: rej("已有 Compute"), ProducerModelAdded: addModel, NeedHuman: rej("审查中不再向人提问"),
    HumanReply: ign(NO_CARD), Amend: amend, SubmitForReview: go((t, e) => ok(set(t, { reviewedCommit: as(e, "SubmitForReview").commit, reviewGate: "none" }))),
    Review: review, DeliveredCard: rej("还没审过,不能交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: execFailed,
  },
  T7_Delivering: {
    Claim: rej("交付中,拒绝重复认领"), Dispatch: rej("已有 Compute"), ProducerModelAdded: rej("已审完,不能再加生产模型"), NeedHuman: rej("交付中"),
    HumanReply: ign(NO_CARD), Amend: go((t) => rework(t, true)), SubmitForReview: rej("已审完"), Review: ign("已审完,迟到的审查结论忽略"),
    DeliveredCard: go((t) => ok(set(t, { state: "T8a_Delivered" }))),
    UserAccept: rej("卡片还没发到群里"), UserReject: rej("卡片还没发到群里"), AcceptTimeout: ign("卡片还没发到群里"),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign("工件已落盘,只重发卡片,不回去重跑"),
  },
  T8a_Delivered: {
    Claim: rej("已交付"), Dispatch: rej("已交付"), ProducerModelAdded: rej("已交付"), NeedHuman: rej("已交付"),
    HumanReply: ign(NO_CARD), Amend: go((t) => rework(t, true)), SubmitForReview: rej("已交付"), Review: ign("已交付,迟到的审查结论忽略"),
    DeliveredCard: ign("卡片已发出,重复发送幂等"),
    UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),
    UserReject: userReject,
    AcceptTimeout: go((t) => ok(set(t, { state: "T8_ArchivedUnverified", badge: "unverified" }))),
    Cancel: ign("已交付,取消只停后续动作"), StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign("已交付"),
  },
  T8_Accepted: { ...terminalRow(), Amend: go((t) => rework(t, true)), UserReject: userReject },
  T8_ArchivedUnverified: {
    ...terminalRow(), Amend: go((t) => rework(t, true)), UserReject: userReject,
    UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),
  },
  T9_StopRequested: {
    ...Object.fromEntries(EVENT_KINDS.map((k) => [k, ign("正在等真实停止,其他事件不中断停止流程")])) as unknown as Row,
    Claim: rej("停止期间禁止把任务重新指派给他人"), Dispatch: rej("停止期间禁止重新派发"),
    Cancel: ign("已在停止中,不重复发停止信号"),
    StoppedConfirmed: go((t) => ok(set(t, { state: t.stopReason === "fail" ? "T11_Failed" : "T10_Cancelled", computeId: null }), t.computeId ? [{ kind: "release-slot", computeId: t.computeId }] : [])),
  },
  T10_Cancelled: terminalRow(),
  T11_Failed: terminalRow(),
};

/** 把一串事件依次套到任务上(事件回放);遇到第一个被拒的事件就停,返回它的原因,副作用按顺序累积。 */
export function applyAll(t: Task, events: readonly TaskEvent[]): Outcome {
  let cur = t;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = apply(cur, e);
    if (!r.ok) return r;
    cur = r.task;
    effects.push(...r.effects);
  }
  return ok(cur, effects);
}

export function apply(t: Task, e: TaskEvent): Outcome {
  const cell = TABLE[t.state][e.kind];
  if (cell.kind === "reject") return no(`${t.state} × ${e.kind}:${cell.reason}`);
  if (cell.kind === "ignore") return ok(t);
  return cell.run(t, e);
}
