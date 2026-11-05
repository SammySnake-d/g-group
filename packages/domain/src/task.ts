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
  // requestId:新实例回报的是哪一次启动请求;返工后新开的实例必须带上并对上当前启动(R2-CORR-01/02)
  | { kind: "Dispatch"; computeId: string; model: string; requestId?: string }
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
  | { kind: "DeliveredCard" }
  | { kind: "UserAccept"; by: string }
  | { kind: "UserReject"; by: string; computeResumable: boolean }
  | { kind: "AcceptTimeout" }
  | { kind: "Cancel"; by: string }
  // 停止确认必须指明确认的是哪个实例(computeId)或哪次启动撤销(requestId);对不上当前等待对象的是迟到回包(R2-CORR-01)
  | { kind: "StoppedConfirmed"; computeId?: string; requestId?: string }
  // 执行失败来自当前实例(computeId)或当前在途启动(requestId);别的来源的失败不影响当前代次(R3-CORR-03)
  | { kind: "ExecFailed"; computeId?: string; requestId?: string };

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
  /** 当前 computeId 是由哪个启动请求回绑的(首次派发为 null);同一请求同一实例的重复上线回包据此幂等(R3-CORR-01)。 */
  readonly boundRequest: string | null;
  /** 已发 cancel-spawn、还没确认撤销也没见到实例上线的旧启动请求(R3-CORR-02)。 */
  readonly revoked: readonly string[];
  /** 已发 stop-compute、还没确认停止的孤儿实例(R3-CORR-02)。 */
  readonly orphans: readonly string[];
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
const set = (t: Task, patch: Partial<Task>): Task => {
  const q = "pendingQ" in patch ? patch.pendingQ ?? null : t.pendingQ;
  const l = "launch" in patch ? patch.launch ?? null : t.launch;
  return Object.freeze({
    ...t, ...patch, producerModels: Object.freeze([...(patch.producerModels ?? t.producerModels)]), pendingQ: snapQ(q), launch: snapL(l),
    revoked: Object.freeze([...(patch.revoked ?? t.revoked)]), orphans: Object.freeze([...(patch.orphans ?? t.orphans)]),
  });
};

export function newTask(id: string, requester: string): Task {
  return set({
    id, requester, state: "T1_Open", owner: null, constraintVer: 0, computeId: null, launch: null, boundRequest: null, revoked: [], orphans: [], launchSeq: 0, reviewRound: 0, producerModels: [],
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
/** 换模只认当前实例报来的;不核对条件版本:当前实例换过的模型都参与了产出,累积集合宁多勿少(AC-26)。 */
const addModel = go((t, e) => {
  const ev = as(e, "ProducerModelAdded");
  if (!t.computeId || ev.computeId !== t.computeId) return ok(t);
  const m = ev.model;
  return ok(set(t, { producerModels: t.producerModels.includes(m) ? t.producerModels : [...t.producerModels, m] }));
});
/**
 * 所有返工入口(审查打回、T5/T7/T8 改条件、用户退回)共用的可恢复性契约(AC-28 / #820 / #865 / CORR-03):
 * 可恢复 → 恢复原实例;不可恢复 → 清掉旧 computeId、带交接新开,等新实例 Dispatch 回绑(CORR-02)。
 * 负责人与累积生产模型保留;版本推进,评审与验收标记作废。
 */
const rework = (t: Task, resumable: boolean): Outcome => {
  const base = { state: "T3_Running", constraintVer: t.constraintVer + 1, pendingQ: null, reviewedCommit: null, reviewGate: "none", badge: "none" } as const;
  if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }), [{ kind: "resume-compute", computeId: t.computeId, constraintVer: base.constraintVer }]);
  return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), []);
};
/** 发起一次新的启动请求:requestId 永不复用,绑定当前条件版本;pre 是要先执行的副作用(如撤销旧启动)。 */
const relaunch = (t: Task, pre: Effect[]): Outcome => {
  const seq = t.launchSeq + 1;
  const launch: Launch = { requestId: `${t.id}#L${seq}`, constraintVer: t.constraintVer };
  return ok(set(t, { launch, launchSeq: seq }), [...pre, { kind: "spawn-compute", withHandoff: true, ...launch }]);
};
/** 执行中/阻塞中改条件:Compute 仍在运行,版本单调递增、阻塞卡片作废,回到执行;启动在途时旧启动按旧版本发出,撤销它并按新版本重新发起(R2-CORR-02)。 */
const amendLive = go((t) => {
  const ver = t.constraintVer + 1;
  if (!t.launch) return ok(set(t, { constraintVer: ver, pendingQ: null, state: "T3_Running" }), t.computeId ? [{ kind: "update-constraints", computeId: t.computeId, constraintVer: ver }] : []);
  // 旧启动记入 revoked,直到确认撤销或它的实例上线后被停止,任务才可能终态(R3-CORR-02)
  return relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, t.launch.requestId] }), [{ kind: "cancel-spawn", requestId: t.launch.requestId }]);
});
/** 带启动请求号、却不是当前在途启动的实例:不绑定,立即停止,不让它带着过期授权运行(R2-CORR-01/02)。 */
const orphan = (t: Task, e: TaskEvent): Outcome | null => {
  const ev = as(e, "Dispatch");
  if (ev.requestId === undefined || ev.requestId === t.launch?.requestId) return null;
  // 当前实例的重复上线回包(或冒用当前实例 ID 的回包):绝不停当前实例,幂等忽略(R3-CORR-01)
  if (ev.computeId === t.computeId) return ok(t);
  // 已经下过停止的孤儿:不重复登记
  if (t.orphans.includes(ev.computeId)) return ok(t);
  return ok(set(t, { orphans: [...t.orphans, ev.computeId], revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: "stop-compute", computeId: ev.computeId }]);
};
/** 孤儿实例或旧启动的停止确认:从未决集合里划掉,孤儿实例释放槽位;其余确认幂等忽略(R3-CORR-02)。 */
const ackStale = (t: Task, e: TaskEvent): Outcome => {
  const ev = as(e, "StoppedConfirmed");
  if (ev.computeId !== undefined && t.orphans.includes(ev.computeId)) return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId) }), [{ kind: "release-slot", computeId: ev.computeId }]);
  if (ev.requestId !== undefined && t.revoked.includes(ev.requestId)) return ok(set(t, { revoked: t.revoked.filter((r) => r !== ev.requestId) }));
  return ok(t);
};
const ack = go(ackStale);
const dispatchElse = (reason: string, otherwise: "reject" | "ignore" = "reject") => go((t, e) => orphan(t, e) ?? (otherwise === "reject" ? no(reason) : ok(t)));
const amendRework = go((t, e) => rework(t, as(e, "Amend").computeResumable));
/** 新实例回绑:只在已发出 spawn、还没有实例时接受;模型并入累积生产集合。 */
const bind = (t: Task, e: TaskEvent): Task => {
  const ev = as(e, "Dispatch");
  return set(t, { computeId: ev.computeId, boundRequest: ev.requestId ?? null, launch: null, producerModels: [...new Set([...t.producerModels, ev.model])] });
};
/** 回绑只接受当前在途启动的实例(requestId 对上),没有启动在途或已有实例都拒。 */
const canBind = (t: Task, e: TaskEvent): boolean => !t.computeId && !!t.launch && as(e, "Dispatch").requestId === t.launch.requestId;
const NO_COMPUTE = "新 Compute 尚未回绑";
const userReject = go((t, e) => {
  const ev = as(e, "UserReject");
  return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);
});

/** T5 守卫(AC-26 / R-01):审查人≠作者;审查厂商不在累积生产厂商集合里;任何一方 unknown 都拒;提出者本人可豁免同厂商,记为 Waived。 */
const review = go((t, e) => {
  const ev = as(e, "Review");
  // 过期回包:审的不是当前提审的 commit 或条件版本,幂等忽略,当前提审继续等(CORR-01)
  if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);
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
  if (ev.verdict === "reject") return rework(t, ev.computeResumable);
  return ok(set(t, { state: "T7_Delivering", reviewGate: gate }));
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
  if (!t.computeId) return no(NO_COMPUTE);
  // 旧执行器(别的实例)或按旧条件版本做出的产物:幂等忽略,不发起新一轮审查(R3-CORR-03)
  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);
  const commit = ev.commit;
  const round = t.reviewRound + 1;
  return ok(set(t, { state: "T5_InReview", reviewedCommit: commit, reviewRound: round, reviewGate: "none" }), [{ kind: "request-review", round, commit, constraintVer: t.constraintVer }]);
};
/** 尚未派发时改条件:只推进版本。 */
const bumpVer = go((t) => ok(set(t, { constraintVer: t.constraintVer + 1 })));

export const TABLE: TransitionTable = {
  T1_Open: {
    Claim: go((t, e) => ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by }))),
    Dispatch: rej("尚未认领,不能派发"), ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: rej(NOT_RUNNING),
    HumanReply: ign(NO_CARD), Amend: bumpVer,
    SubmitForReview: rej(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign(NOT_RUNNING),
  },
  T2_Claimed: {
    Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),
    Dispatch: go((t, e) => { const ev = as(e, "Dispatch"); return ok(set(t, { state: "T3_Running", computeId: ev.computeId, boundRequest: null, producerModels: [...new Set([...t.producerModels, ev.model])] })); }),
    ProducerModelAdded: rej(NOT_RUNNING), NeedHuman: rej(NOT_RUNNING), HumanReply: ign(NO_CARD),
    Amend: bumpVer,
    SubmitForReview: rej(NOT_RUNNING), Review: rej("不在审查中"), DeliveredCard: rej("没有工件可交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ign("没有在停止的 Compute"), ExecFailed: ign("尚未派发"),
  },
  T3_Running: {
    Claim: rej("已在执行,拒绝重复认领"),
    Dispatch: go((t, e) => canBind(t, e) ? ok(bind(t, e)) : orphan(t, e) ?? no("已有 Compute 在执行")),
    ProducerModelAdded: addModel,
    NeedHuman: go((t, e) => {
      const ev = as(e, "NeedHuman");
      if (!t.computeId) return no(NO_COMPUTE);
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
    Claim: rej("已在执行,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute 在执行"), ProducerModelAdded: addModel, NeedHuman: rej("已有一张待回复的卡"),
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
    Amend: amendLive, SubmitForReview: rej("等人确认中,不能提审"), Review: rej("不在审查中"), DeliveredCard: rej("等人确认中"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T5_InReview: {
    Claim: rej("审查中,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute"), ProducerModelAdded: addModel, NeedHuman: rej("审查中不再向人提问"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: go(submit),
    Review: review, DeliveredCard: rej("还没审过,不能交付"),
    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,
  },
  T7_Delivering: {
    Claim: rej("交付中,拒绝重复认领"), Dispatch: dispatchElse("已有 Compute"), ProducerModelAdded: rej("已审完,不能再加生产模型"), NeedHuman: rej("交付中"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: rej("已审完"), Review: ign("已审完,迟到的审查结论忽略"),
    DeliveredCard: go((t) => ok(set(t, { state: "T8a_Delivered" }))),
    UserAccept: rej("卡片还没发到群里"), UserReject: rej("卡片还没发到群里"), AcceptTimeout: ign("卡片还没发到群里"),
    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: ign("工件已落盘,只重发卡片,不回去重跑"),
  },
  T8a_Delivered: {
    Claim: rej("已交付"), Dispatch: dispatchElse("已交付"), ProducerModelAdded: rej("已交付"), NeedHuman: rej("已交付"),
    HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: rej("已交付"), Review: ign("已交付,迟到的审查结论忽略"),
    DeliveredCard: ign("卡片已发出,重复发送幂等"),
    UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),
    UserReject: userReject,
    AcceptTimeout: go((t) => ok(set(t, { state: "T8_ArchivedUnverified", badge: "unverified" }))),
    Cancel: ign("已交付,取消只停后续动作"), StoppedConfirmed: ack, ExecFailed: ign("已交付"),
  },
  T8_Accepted: { ...terminalRow(), Amend: amendRework, UserReject: userReject },
  T8_ArchivedUnverified: {
    ...terminalRow(), Amend: amendRework, UserReject: userReject,
    UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),
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
      if (t.computeId && ev.computeId === t.computeId) r = ok(set(t, { computeId: null, boundRequest: null }), [{ kind: "release-slot", computeId: t.computeId }]);
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

export function apply(t: Task, e: TaskEvent): Outcome {
  const cell = TABLE[t.state][e.kind];
  if (cell.kind === "reject") return no(`${t.state} × ${e.kind}:${cell.reason}`);
  if (cell.kind === "ignore") return ok(t);
  return cell.run(t, e);
}
