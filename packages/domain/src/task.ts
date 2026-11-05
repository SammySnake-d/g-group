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
  // requestId:实例回报的是哪一次启动请求;首派与返工新开都必须带上并对上当前启动(R2-CORR-01/02 / R4-CORR-03)
  | { kind: "Dispatch"; computeId: string; model: string; requestId: string }
  // 执行侧回包都带来源实例 computeId;提问/提审还带它所依据的条件版本。对不上当前实例(或当前版本)的是旧执行器的迟到回包(R3-CORR-03)
  | { kind: "ProducerModelAdded"; model: string; computeId: string }
  | { kind: "NeedHuman"; qId: string; computeId: string; constraintVer: number }
  | { kind: "HumanReply"; qId: string; constraintVer: number; answer: "approve" | "reject" }
  // computeResumable:宿主报告当前 Compute 实例能否恢复;只有需要返工的入口(T5/T7/T8 改条件)读它,T1–T4b 的改条件不涉及恢复
  | { kind: "Amend"; by: string; computeResumable: boolean }
  | { kind: "SubmitForReview"; commit: string; computeId: string; constraintVer: number }
  // 审查回包绑定被审对象 (round, commit, constraintVer):round 是每次提审新分配、永不复用的轮次号,对不上就是过期回包(CORR-01 / R2-CORR-04)
  | ({ kind: "Review"; reviewerId: string; reviewerModel: string; round: number; commit: string; constraintVer: number; waiverBy?: string }
    & ({ verdict: "approve" } | { verdict: "reject"; computeResumable: boolean }))
  // 交付侧事件都绑定交付代次 (deliveryRound, commit):代次在每次审查通过时新分配、永不复用;
  // 已发过但不是当前交付的代次是旧卡回包,一律幂等忽略,不打断批次(R5-CORR-01/02)
  // taskId:回包所属任务;与本任务不符即错投,拒绝(R6 跨任务边界)。deliveryRound 必须是本任务分配过的正整数(R6-CORR-02)
  | { kind: "DeliveredCard"; taskId: string; deliveryRound: number; commit: string }
  | { kind: "UserAccept"; taskId: string; by: string; deliveryRound: number; commit: string }
  | { kind: "UserReject"; taskId: string; by: string; computeResumable: boolean; deliveryRound: number; commit: string }
  | { kind: "AcceptTimeout"; taskId: string; deliveryRound: number; commit: string }
  | { kind: "Cancel"; by: string }
  // 停止确认必须指明确认的是哪个实例(computeId)或哪次启动撤销(requestId);对不上当前等待对象的是迟到回包(R2-CORR-01)
  | { kind: "StoppedConfirmed"; taskId: string; computeId?: string; requestId?: string }
  // 执行失败来自当前实例(computeId)或当前在途启动(requestId);别的来源的失败不影响当前代次(R3-CORR-03)
  | { kind: "ExecFailed"; computeId?: string; requestId?: string };

/** 确认卡绑定快照:创建后冻结,不与其它 Task 共享(CORR-04)。 */
export interface PendingQuestion { readonly qId: string; readonly constraintVer: number }
export interface Launch { readonly requestId: string; readonly constraintVer: number }
/** 当前交付:代次与被交付的 commit(T7/T8 有效,其余为 null)。 */
export interface Delivery { readonly round: number; readonly commit: string }
/** 通过审查时的审查人模型与豁免人;交付后迟到的生产模型记录据此重判合规(R4-CORR-01)。 */
export interface Approval { readonly reviewerModel: string; readonly waiverBy: string | null }
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
  /** 当前 computeId 是由哪个启动请求回绑的(首次派发为 null);同一请求同一实例的重复上线回包据此幂等(R3-CORR-01)。 */
  readonly boundRequest: string | null;
  /** 曾经回绑到本任务的全部实例;它们报来的生产模型都计入累积集合,哪怕已不是当前实例(R4-CORR-01)。 */
  readonly instances: readonly string[];
  /** 当前通过的审查(T7/T8 有效);其余状态为 null。 */
  readonly approval: Approval | null;
  /** 当前交付(T7/T8 有效);其余状态为 null(R5-CORR-01)。 */
  readonly delivery: Delivery | null;
  /** 已分配过的交付代次个数,只增不减。 */
  readonly deliverySeq: number;
  /** 已发 cancel-spawn、还没确认撤销也没见到实例上线的旧启动请求(R3-CORR-02)。 */
  readonly revoked: readonly string[];
  /** 已发 stop-compute、还没确认停止的孤儿实例(R3-CORR-02)。 */
  readonly orphans: readonly string[];
  /** 已确认停止的实例(当前实例停止或孤儿停止);它们的迟到回包可证明是旧的,重复上线/确认不再登记、不再释放槽位(R6-CORR-01)。 */
  readonly retired: readonly string[];
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
  | { kind: "resume-compute"; computeId: string; constraintVer: number }
  | { kind: "update-constraints"; computeId: string; constraintVer: number }
  | { kind: "spawn-compute"; withHandoff: boolean; requestId: string; constraintVer: number }
  | { kind: "cancel-spawn"; requestId: string }
  | { kind: "request-review"; round: number; commit: string; constraintVer: number }
  | { kind: "send-card"; taskId: string; deliveryRound: number; commit: string; constraintVer: number }
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
const snapQ = (q: PendingQuestion | null): PendingQuestion | null => q ? Object.freeze({ qId: String(q.qId), constraintVer: Number(q.constraintVer) }) : null;
const snapL = (l: Launch | null): Launch | null => l ? Object.freeze({ requestId: String(l.requestId), constraintVer: Number(l.constraintVer) }) : null;
const snapA = (a: Approval | null): Approval | null => a ? Object.freeze({ reviewerModel: String(a.reviewerModel), waiverBy: a.waiverBy === null ? null : String(a.waiverBy) }) : null;
const snapD = (d: Delivery | null): Delivery | null => d ? Object.freeze({ round: Number(d.round), commit: String(d.commit) }) : null;
const set = (t: Task, patch: Partial<Task>): Task => {
  const d = "delivery" in patch ? patch.delivery ?? null : t.delivery;
  const q = "pendingQ" in patch ? patch.pendingQ ?? null : t.pendingQ;
  const l = "launch" in patch ? patch.launch ?? null : t.launch;
  const a = "approval" in patch ? patch.approval ?? null : t.approval;
  return Object.freeze({
    ...t, ...patch, producerModels: Object.freeze([...(patch.producerModels ?? t.producerModels)]), pendingQ: snapQ(q), launch: snapL(l),
    revoked: Object.freeze([...(patch.revoked ?? t.revoked)]), orphans: Object.freeze([...(patch.orphans ?? t.orphans)]),
    retired: Object.freeze([...(patch.retired ?? t.retired)]),
    instances: Object.freeze([...(patch.instances ?? t.instances)]), approval: snapA(a), delivery: snapD(d),
  });
};

export function newTask(id: string, requester: string): Task {
  return set({
    id, requester, state: "T1_Open", owner: null, constraintVer: 0, computeId: null, launch: null, boundRequest: null, instances: [], approval: null, delivery: null, deliverySeq: 0, revoked: [], orphans: [], retired: [], launchSeq: 0, reviewRound: 0, producerModels: [],
    pendingQ: null, reviewedCommit: null, reviewGate: "none", badge: "none", stopReason: null,
  }, {});
}

/** 有活跃 Compute 时先请求停止;新实例还在启动途中就撤销启动;两者都等真实停止确认。都没有才直接进终态。 */
const stopThenRun = (t: Task, reason: "cancel" | "fail"): Outcome => {
  if (t.computeId) return ok(set(t, { state: "T9_StopRequested", stopReason: reason }), [{ kind: "stop-compute", computeId: t.computeId }]);
  if (t.launch) return ok(set(t, { state: "T9_StopRequested", stopReason: reason }), [{ kind: "cancel-spawn", requestId: t.launch.requestId }]);
  if (t.revoked.length || t.orphans.length) return ok(set(t, { state: "T9_StopRequested", stopReason: reason }));
  return ok(set(t, { state: reason === "cancel" ? "T10_Cancelled" : "T11_Failed", stopReason: reason }));
};
const stopThen = (reason: "cancel" | "fail") => go((t) => stopThenRun(t, reason));
const cancel = stopThen("cancel");
/** 执行失败只认当前实例或当前在途启动报来的;旧执行器的失败幂等忽略,不停当前实例(R3-CORR-03)。 */
const execFailed = go((t, e) => {
  const ev = as(e, "ExecFailed");
  const current = t.computeId ? ev.computeId === t.computeId : !!t.launch && ev.requestId === t.launch.requestId;
  return current ? stopThenRun(t, "fail") : ok(t);
});
/**
 * 换模记录认任何曾回绑到本任务的实例(含已被替换的旧实例),不核对条件版本:它们换过的模型都可能进了产物或交接,累积集合宁多勿少(AC-26 / R4-CORR-01);
 * 从未回绑过的孤儿实例没有参与产出,它的记录忽略。
 */
const addModel = go((t, e) => {
  const ev = as(e, "ProducerModelAdded");
  if (!t.instances.includes(ev.computeId)) return ok(t);
  const m = ev.model;
  return ok(set(t, { producerModels: t.producerModels.includes(m) ? t.producerModels : [...t.producerModels, m] }));
});
/**
 * 所有返工入口(审查打回、T5/T7/T8 改条件、用户退回)共用的可恢复性契约(AC-28 / #820 / #865 / CORR-03):
 * 可恢复 → 恢复原实例;不可恢复 → 清掉旧 computeId、带交接新开,等新实例 Dispatch 回绑(CORR-02)。
 * 负责人与累积生产模型保留;版本推进,评审与验收标记作废。
 */
const rework = (t: Task, resumable: boolean): Outcome => {
  const base = { state: "T3_Running", constraintVer: t.constraintVer + 1, pendingQ: null, reviewedCommit: null, reviewGate: "none", badge: "none", approval: null, delivery: null } as const;
  if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }), [{ kind: "resume-compute", computeId: t.computeId, constraintVer: base.constraintVer }]);
  return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), [], true);
};
/** 发起一次新的启动请求:requestId 永不复用,绑定当前条件版本;pre 是要先执行的副作用(如撤销旧启动)。 */
const relaunch = (t: Task, pre: Effect[], withHandoff: boolean): Outcome => {
  const seq = t.launchSeq + 1;
  const launch: Launch = { requestId: `${t.id}#L${seq}`, constraintVer: t.constraintVer };
  return ok(set(t, { launch, launchSeq: seq }), [...pre, { kind: "spawn-compute", withHandoff, ...launch }]);
};
/** 启动在途时改条件:旧启动按旧版本发出,撤销并登记它(直到确认撤销或其实例被停止),按新版本重新发起(R2-CORR-02 / R3-CORR-02);首派(T2)不带交接,返工新开带交接。 */
const revokeAndRelaunch = (t: Task, launch: Launch, ver: number): Outcome =>
  relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, launch.requestId] }), [{ kind: "cancel-spawn", requestId: launch.requestId }], t.state !== "T2_Claimed");
/** 执行中/阻塞中改条件:Compute 仍在运行,版本单调递增、阻塞卡片作废,回到执行;启动在途时旧启动按旧版本发出,撤销它并按新版本重新发起(R2-CORR-02)。 */
const amendLive = go((t) => {
  const ver = t.constraintVer + 1;
  if (!t.launch) return ok(set(t, { constraintVer: ver, pendingQ: null, state: "T3_Running" }), t.computeId ? [{ kind: "update-constraints", computeId: t.computeId, constraintVer: ver }] : []);
  return revokeAndRelaunch(t, t.launch, ver);
});
/** 已认领、首派请求已发出但未回绑时改条件:撤销重发,留在 T2(R4-CORR-03)。 */
const amendQueued = go((t) => t.launch ? revokeAndRelaunch(t, t.launch, t.constraintVer + 1) : ok(set(t, { constraintVer: t.constraintVer + 1 })));
/** 带启动请求号、却不是当前在途启动的实例:不绑定,立即停止,不让它带着过期授权运行(R2-CORR-01/02)。 */
const orphan = (t: Task, e: TaskEvent): Outcome | null => {
  const ev = as(e, "Dispatch");
  if (ev.requestId === t.launch?.requestId) return null;
  // 当前实例的重复上线回包(或冒用当前实例 ID 的回包):绝不停当前实例,幂等忽略(R3-CORR-01)
  if (ev.computeId === t.computeId) return ok(t);
  // 已经下过停止的孤儿:不重复登记
  if (t.orphans.includes(ev.computeId)) return ok(t);
  // 已确认停止过的实例又回报上线:是重放或已停实例,再发一次停止(幂等)但不重新登记,之后的确认不会再释放槽位(R6-CORR-01)
  if (t.retired.includes(ev.computeId)) return ok(t, [{ kind: "stop-compute", computeId: ev.computeId }]);
  return ok(set(t, { orphans: [...t.orphans, ev.computeId], revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: "stop-compute", computeId: ev.computeId }]);
};
/** 孤儿实例或旧启动的停止确认:从未决集合里划掉,孤儿实例释放槽位;其余确认幂等忽略(R3-CORR-02)。 */
const ackStale = (t: Task, e: TaskEvent): Outcome => {
  const ev = as(e, "StoppedConfirmed");
  if (ev.computeId !== undefined && t.orphans.includes(ev.computeId)) return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId), retired: [...t.retired, ev.computeId] }), [{ kind: "release-slot", computeId: ev.computeId }]);
  if (ev.requestId !== undefined && t.revoked.includes(ev.requestId)) return ok(set(t, { revoked: t.revoked.filter((r) => r !== ev.requestId) }));
  return ok(t);
};
const ack = go(ackStale);
const dispatchElse = (reason: string, otherwise: "reject" | "ignore" = "reject") => go((t, e) => orphan(t, e) ?? (otherwise === "reject" ? no(reason) : ok(t)));
const amendRework = go((t, e) => rework(t, as(e, "Amend").computeResumable));
/** 新实例回绑:只在已发出 spawn、还没有实例时接受;模型并入累积生产集合。 */
const bind = (t: Task, e: TaskEvent): Task => {
  const ev = as(e, "Dispatch");
  return set(t, { computeId: ev.computeId, boundRequest: ev.requestId, launch: null, instances: t.instances.includes(ev.computeId) ? t.instances : [...t.instances, ev.computeId], producerModels: [...new Set([...t.producerModels, ev.model])] });
};
/** 回绑只接受当前在途启动的实例(requestId 对上),没有启动在途或已有实例都拒。 */
const canBind = (t: Task, e: TaskEvent): boolean => !t.computeId && !!t.launch && as(e, "Dispatch").requestId === t.launch.requestId;
const NO_COMPUTE = "新 Compute 尚未回绑";
const userRejectRun = (t: Task, e: TaskEvent): Outcome => {
  const ev = as(e, "UserReject");
  return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);
};
const accept = (t: Task, e: TaskEvent): Outcome => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`);

/** T5 守卫(AC-26 / R-01):审查人≠作者;审查厂商不在累积生产厂商集合里;任何一方 unknown 都拒;提出者本人可豁免同厂商,记为 Waived。 */
/** 跨厂商判定:返回门禁结论,或不通过的原因(以 Error 包装区分)。 */
const vendorGate = (t: Task, reviewerModel: string, waiverBy: string | null | undefined): ReviewGate | Error => {
  const producers = new Set<Vendor>(t.producerModels.map(vendorOf));
  const reviewer = vendorOf(reviewerModel);
  if (producers.size === 0) return new Error("没有记录到生产模型,无法判定跨厂商");
  if (producers.has("unknown")) return new Error("有生产模型认不出厂商(unknown)");
  if (reviewer === "unknown") return new Error(`审查模型 ${reviewerModel} 认不出厂商(unknown)`);
  if (!producers.has(reviewer)) return "compliant";
  if (waiverBy !== t.requester) return new Error(`审查厂商 ${reviewer} 在生产厂商集合 {${[...producers].join(",")}} 里,且没有提出者本人的豁免`);
  return "waived-by-user";
};
const review = go((t, e) => {
  const ev = as(e, "Review");
  // 过期回包:审的不是当前提审的 commit 或条件版本,幂等忽略,当前提审继续等(CORR-01)
  if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);
  if (ev.reviewerId === t.owner) return no(`审查人 ${ev.reviewerId} 就是作者,不能自审`);
  const gate = vendorGate(t, ev.reviewerModel, ev.waiverBy);
  if (gate instanceof Error) return no(gate.message);
  if (ev.verdict === "reject") return rework(t, ev.computeResumable);
  // 每次通过分配新的交付代次并请求发卡;旧代次的发送确认与验收回包从此无效(R5-CORR-01/02)
  const round = t.deliverySeq + 1;
  const delivery: Delivery = { round, commit: t.reviewedCommit! };
  return ok(set(t, { state: "T7_Delivering", reviewGate: gate, approval: { reviewerModel: ev.reviewerModel, waiverBy: ev.waiverBy ?? null }, delivery, deliverySeq: round }),
    [{ kind: "send-card", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);
});
/** 同一产物重新送审:新轮次、清掉结论与验收标记(R4-CORR-01)。 */
const reReview = (t: Task): Outcome => {
  const round = t.reviewRound + 1;
  return ok(set(t, { state: "T5_InReview", reviewRound: round, reviewGate: "none", approval: null, delivery: null, badge: "none" }), [{ kind: "request-review", round, commit: t.reviewedCommit!, constraintVer: t.constraintVer }]);
};
/**
 * 审查通过后才到的生产模型记录(来自曾回绑的实例):并入累积集合并用原审查人模型重判。
 * 结论不变就留在原状态;变成需豁免就改记 Waived;不再通过就作废这次审查、同一产物重新送审(R4-CORR-01)。
 */
const lateModel = go((t, e) => {
  const ev = as(e, "ProducerModelAdded");
  if (!t.instances.includes(ev.computeId) || t.producerModels.includes(ev.model)) return ok(t);
  const t2 = set(t, { producerModels: [...t.producerModels, ev.model] });
  if (!t.approval) return ok(t2);
  const gate = vendorGate(t2, t.approval.reviewerModel, t.approval.waiverBy);
  if (gate instanceof Error) return reReview(t2);
  return ok(gate === t.reviewGate ? t2 : set(t2, { reviewGate: gate }));
});

type Row = { readonly [E in EventKind]: Cell };
const TERMINAL = "终态,迟到事件幂等忽略,不复活任务";
const terminalRow = (): Row => ({ ...(Object.fromEntries(EVENT_KINDS.map((k) => [k, ign(TERMINAL)])) as unknown as Row), Dispatch: dispatchElse(TERMINAL, "ignore"), StoppedConfirmed: ack });
const NOT_RUNNING = "当前不在执行,没有可接收这一事件的 Compute";
const NO_CARD = "当前没有待回复的确认卡";
const NOT_DELIVERED = "当前不在待验收状态";

/** 提审:分配新的、永不复用的审查轮次,清掉旧结论;只有这一轮的回包能生效(R2-CORR-04)。 */
const submit = (t: Task, e: TaskEvent): Outcome => {
  const ev = as(e, "SubmitForReview");
  if (!t.computeId) return provablyStale(t, e) ? ok(t) : no(NO_COMPUTE);
  // 旧执行器(别的实例)或按旧条件版本做出的产物:幂等忽略,不发起新一轮审查(R3-CORR-03)
  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);
  const commit = ev.commit;
  const round = t.reviewRound + 1;
  return ok(set(t, { state: "T5_InReview", reviewedCommit: commit, reviewRound: round, reviewGate: "none", approval: null }), [{ kind: "request-review", round, commit, constraintVer: t.constraintVer }]);
};
/** 执行侧回包在不接受它的状态:旧实例或旧版本的迟到回包幂等忽略,不打断后续有效操作;当前实例当前版本的才按非法拒绝(R4-CORR-02)。 */
const staleOr = (reason: string) => go((t, e) => {
  const ev = e as { computeId?: string; constraintVer?: number };
  const current = !!t.computeId && ev.computeId === t.computeId && (ev.constraintVer === undefined || ev.constraintVer === t.constraintVer);
  return current ? no(reason) : ok(t);
});
/** 没有已绑定实例(首派或返工新开在途)时:能证明是旧的回包(旧条件版本,或来自曾绑定/已停止的别的实例)幂等忽略,不阻断随后新实例上线;来源无法判定的保守拒绝(R5-CORR-03)。 */
const provablyStale = (t: Task, e: TaskEvent): boolean => {
  const ev = e as { computeId?: string; constraintVer?: number };
  if (ev.constraintVer !== undefined && ev.constraintVer < t.constraintVer) return true;
  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));
};
const unboundOr = (reason: string) => go((t, e) => provablyStale(t, e) ? ok(t) : no(reason));
/** 交付侧事件:必须对上当前交付代次与 commit;未发过的代次按非法拒绝(已发过的旧代次在 apply 入口已被忽略)。 */
const forDelivery = (run: (t: Task, e: TaskEvent) => Outcome) => go((t, e) => {
  const ev = e as { deliveryRound: number; commit: string };
  if (!t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit) return no(`交付代次 ${ev.deliveryRound} 不是当前交付`);
  return run(t, e);
});
/** 认领:原子地发出首派请求(requestId 带 L0,不与返工启动号冲突);从此 T2 总有一个在途首派请求,取消必须等它确认撤销(R4-CORR-03)。 */
const claim = go((t, e) => {
  const launch: Launch = { requestId: `${t.id}#L0`, constraintVer: t.constraintVer };
  return ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by, launch }), [{ kind: "spawn-compute", withHandoff: false, ...launch }]);
});
/** 尚未派发时改条件:只推进版本。 */
const bumpVer = go((t) => ok(set(t, { constraintVer: t.constraintVer + 1 })));

export const TABLE: TransitionTable = {
  T1_Open: {
    Claim: claim,
    Dispatch: rej("尚未认领,不能派发"), ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: rej(NOT_RUNNING),
    HumanReply: ign(NO_CARD), Amend: bumpVer,
    SubmitForReview: rej(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign(NOT_RUNNING),
  },
  T2_Claimed: {
    Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),
    // 首派实例上线:只认当前首派请求号;别的请求号的实例停止(R4-CORR-03)
    Dispatch: go((t, e) => canBind(t, e) ? ok(set(bind(t, e), { state: "T3_Running" })) : orphan(t, e) ?? no("首派回包对不上")),
    ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: unboundOr(NOT_RUNNING), HumanReply: ign(NO_CARD),
    Amend: amendQueued,
    SubmitForReview: unboundOr(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T3_Running: {
    Claim: rej("已在执行,拒绝重复认领"),
    Dispatch: go((t, e) => canBind(t, e) ? ok(bind(t, e)) : orphan(t, e) ?? no("已有 Compute 在执行")),
    ProducerModelAdded: addModel,
    NeedHuman: go((t, e) => {
      const ev = as(e, "NeedHuman");
      if (!t.computeId) return provablyStale(t, e) ? ok(t) : no(NO_COMPUTE);
      // 旧执行器或按旧条件版本发起的提问:幂等忽略,不形成绑定旧依据的卡片(R3-CORR-03)
      if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);
      return ok(set(t, { state: "T4b_BlockedOnHuman", pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));
    }),
    HumanReply: ign("卡片已作废或已处理,迟到的点击幂等忽略"), Amend: amendLive,
    SubmitForReview: go(submit),
    Review: rej("不在审查中"), DeliveredCard: rej("还没审查,不能直接交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T4b_BlockedOnHuman: {
    Claim: rej("已在执行,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute 在执行"), ProducerModelAdded: addModel, NeedHuman: staleOr("已有一张待回复的卡"),
    HumanReply: go((t, e) => {
      const ev = as(e, "HumanReply");
      const q = t.pendingQ;
      // 回复绑定 (task_id, q_id, constraint_ver):版本不是任务当前版本,就是旧卡上的点击(不论卡号),幂等忽略,当前卡继续等(AC-19 / R2-CORR-03)
      if (ev.constraintVer !== t.constraintVer) return ok(t);
      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);
      if (q.constraintVer !== t.constraintVer) return no(`卡片绑定版本 ${q.constraintVer} 与任务当前版本 ${t.constraintVer} 不一致`);
      const cleared = set(t, { pendingQ: null });
      return ev.answer === "approve" ? ok(set(cleared, { state: "T3_Running" })) : stopThenRun(cleared, "cancel");
    }),
    Amend: amendLive, SubmitForReview: staleOr("等人确认中,不能提审"), Review: rej("不在审查中"), DeliveredCard: rej("等人确认中"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T5_InReview: {
    Claim: rej("审查中,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute"), ProducerModelAdded: addModel, NeedHuman: staleOr("审查中不再向人提问"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: go(submit),
    Review: review, DeliveredCard: rej("还没审过,不能交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T7_Delivering: {
    Claim: rej("交付中,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute"), ProducerModelAdded: lateModel, NeedHuman: staleOr("交付中"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: staleOr("已审完"), Review: ign("已审完,迟到的审查结论忽略"),
    DeliveredCard: forDelivery((t) => ok(set(t, { state: "T8a_Delivered" }))),
    UserAccept: rej("卡片还没发到群里"), UserReject: rej("卡片还没发到群里"), AcceptTimeout: ign("卡片还没发到群里"),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: ign("工件已落盘,只重发卡片,不回去重跑"),
  },
  T8a_Delivered: {
    Claim: rej("已交付"), Dispatch: dispatchElse("已交付"), ProducerModelAdded: lateModel, NeedHuman: staleOr("已交付"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: staleOr("已交付"), Review: ign("已交付,迟到的审查结论忽略"),
    DeliveredCard: forDelivery((t) => ok(t)),
    UserAccept: forDelivery(accept),
    UserReject: forDelivery(userRejectRun),
    AcceptTimeout: forDelivery((t) => ok(set(t, { state: "T8_ArchivedUnverified", badge: "unverified" }))),
    Cancel: ign("已交付,取消只停后续动作"), StoppedConfirmed: ack, ExecFailed: ign("已交付"),
  },
  T8_Accepted: { ...terminalRow(), ProducerModelAdded: lateModel, Amend: amendRework, UserReject: forDelivery(userRejectRun) },
  T8_ArchivedUnverified: {
    ...terminalRow(), ProducerModelAdded: lateModel, Amend: amendRework, UserReject: forDelivery(userRejectRun),
    UserAccept: forDelivery(accept),
  },
  T9_StopRequested: {
    ...Object.fromEntries(EVENT_KINDS.map((k) => [k, ign("正在等真实停止,其他事件不中断停止流程")])) as unknown as Row,
    Claim: rej("停止期间禁止把任务重新指派给他人"),
    // 撤销启动没赶上、新实例仍回报上线:登记它并立即停止,不让它带着旧授权继续跑
    Dispatch: go((t, e) => {
      if (!canBind(t, e)) return orphan(t, e) ?? no("停止期间禁止重新派发");
      const b = bind(t, e);
      return ok(b, [{ kind: "stop-compute", computeId: b.computeId! }]);
    }),
    Cancel: ign("已在停止中,不重复发停止信号"),
    // 只认对当前等待对象的确认:有实例就要 computeId 对上,只有在途启动就要 requestId 对上;其余是迟到回包(R2-CORR-01)
    // 当前实例、当前在途启动、撤销过的旧启动、孤儿实例,每一个都要各自的确认;全部清空才进终态(R2-CORR-01 / R3-CORR-02)
    StoppedConfirmed: go((t, e) => {
      const ev = as(e, "StoppedConfirmed");
      let r: Outcome;
      if (t.computeId && ev.computeId === t.computeId) r = ok(set(t, { computeId: null, boundRequest: null, retired: [...t.retired, t.computeId] }), [{ kind: "release-slot", computeId: t.computeId }]);
      else if (!t.computeId && t.launch && ev.requestId === t.launch.requestId) r = ok(set(t, { launch: null }));
      else r = ackStale(t, e);
      if (!r.ok) return r;
      const c = r.task;
      if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;
      return ok(set(c, { state: t.stopReason === "fail" ? "T11_Failed" : "T10_Cancelled" }), r.effects);
    }),
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

const DELIVERY_EVENTS: ReadonlySet<EventKind> = new Set(["DeliveredCard", "UserAccept", "UserReject", "AcceptTimeout"]);
/** 已分配过、但不是当前交付(代次或 commit 对不上)的交付侧事件:旧卡回包,任何状态下都幂等忽略,不打断批次(R5-CORR-01/02)。 */
const staleDelivery = (t: Task, e: TaskEvent): boolean => {
  if (!DELIVERY_EVENTS.has(e.kind)) return false;
  const ev = e as { deliveryRound: number; commit: string };
  return !t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit;
};

// ---- 运行时事件形状校验(R7-CORR-01 / R7-TEST-01)----
// 事件常来自 JSON 等未经类型检查的外部输入,静态类型的必填不等于运行时存在。入口按下表逐字段核对:
// str = 非空字符串;nat = 非负安全整数;pint = 正安全整数;bool = 布尔;字符串数组 = 枚举取值。多余字段不拒绝。
type FieldSpec = "str" | "nat" | "pint" | "bool" | readonly string[];
type Shape = { readonly req: Readonly<Record<string, FieldSpec>>; readonly opt?: Readonly<Record<string, FieldSpec>> };
const DELIVERY_SHAPE = { taskId: "str", deliveryRound: "pint", commit: "str" } as const;
const EVENT_SHAPES: { readonly [K in EventKind]: Shape } = {
  Claim: { req: { by: "str" } },
  Dispatch: { req: { computeId: "str", model: "str", requestId: "str" } },
  ProducerModelAdded: { req: { model: "str", computeId: "str" } },
  NeedHuman: { req: { qId: "str", computeId: "str", constraintVer: "nat" } },
  HumanReply: { req: { qId: "str", constraintVer: "nat", answer: ["approve", "reject"] } },
  Amend: { req: { by: "str", computeResumable: "bool" } },
  SubmitForReview: { req: { commit: "str", computeId: "str", constraintVer: "nat" } },
  Review: { req: { reviewerId: "str", reviewerModel: "str", round: "pint", commit: "str", constraintVer: "nat", verdict: ["approve", "reject"] }, opt: { waiverBy: "str" } },
  DeliveredCard: { req: DELIVERY_SHAPE },
  UserAccept: { req: { ...DELIVERY_SHAPE, by: "str" } },
  UserReject: { req: { ...DELIVERY_SHAPE, by: "str", computeResumable: "bool" } },
  AcceptTimeout: { req: DELIVERY_SHAPE },
  Cancel: { req: { by: "str" } },
  StoppedConfirmed: { req: { taskId: "str" }, opt: { computeId: "str", requestId: "str" } },
  ExecFailed: { req: {}, opt: { computeId: "str", requestId: "str" } },
};
const fieldOk = (v: unknown, f: FieldSpec): boolean => {
  if (f === "str") return typeof v === "string" && v.length > 0;
  if (f === "nat") return Number.isSafeInteger(v) && (v as number) >= 0;
  if (f === "pint") return Number.isSafeInteger(v) && (v as number) >= 1;
  if (f === "bool") return typeof v === "boolean";
  return typeof v === "string" && f.includes(v);
};
const label = (f: FieldSpec): string => f === "str" ? "非空字符串" : f === "nat" ? "非负整数" : f === "pint" ? "正整数" : f === "bool" ? "布尔" : f.join("/");
/** 校验一个(可能来自 JSON 的)事件的运行时形状:种类已知、必填字段存在且取值合法、可选字段若出现也合法。合法返回 null,否则返回原因。 */
export function validateEvent(e: unknown): string | null {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return "事件不是对象";
  const o = e as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) return `未知的事件种类 ${String(kind)}`;
  const shape = EVENT_SHAPES[kind as EventKind];
  for (const [k, f] of Object.entries(shape.req)) if (!fieldOk(o[k], f)) return `${kind}.${k} 缺失或取值非法(应为${label(f)})`;
  for (const [k, f] of Object.entries(shape.opt ?? {})) if (o[k] !== undefined && !fieldOk(o[k], f)) return `${kind}.${k} 取值非法(应为${label(f)})`;
  if (kind === "Review" && o.verdict === "reject" && !fieldOk(o.computeResumable, "bool")) return "Review.computeResumable 缺失或取值非法(应为布尔)";
  return null;
}

/**
 * 入口校验(先于状态表):形状合法;带 taskId 的事件必须属于本任务;交付代次必须是本任务已分配过的——
 * 从未分配的(未来)代次在任何状态都拒绝(R7-CORR-02),已分配的旧代次随后幂等忽略。
 */
const misrouted = (t: Task, e: TaskEvent): string | null => {
  const shape = validateEvent(e);
  if (shape) return shape;
  const ev = e as { taskId?: string; deliveryRound?: number };
  if ("taskId" in ev && ev.taskId !== t.id) return `事件属于任务 ${ev.taskId},不是本任务 ${t.id}`;
  if (DELIVERY_EVENTS.has(e.kind) && (ev.deliveryRound as number) > t.deliverySeq) return `交付代次 ${ev.deliveryRound} 本任务未分配过`;
  return null;
};

export function apply(t: Task, e: TaskEvent): Outcome {
  const bad = misrouted(t, e);
  if (bad) return no(bad);
  if (staleDelivery(t, e)) return ok(t);
  const cell = TABLE[t.state][e.kind];
  if (cell.kind === "reject") return no(`${t.state} × ${e.kind}:${cell.reason}`);
  if (cell.kind === "ignore") return ok(t);
  return cell.run(t, e);
}
