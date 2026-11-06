// 第三台状态机(任务生命周期)主干。
// AC-09 状态×事件表无空白格,且每格的处理对照一份独立于实现的需求期望(TEST-01);
// AC-26 写审分离 + 跨厂商审查(含累积生产厂商集合),审查回包绑定被审 commit 与条件版本(CORR-01);
// AC-28 / R-09 交付待确认不超时、不归档(#2273),所有返工入口共用可恢复性契约并能回绑新 Compute(CORR-02/03);
// AC-19 确认卡绑定版本,卡片是不可变快照(CORR-04)。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { apply, applyAll, type Effect, EVENT_KINDS, type EventKind, newTask, type Outcome, STATES, TABLE, type Task, type TaskEvent, type TaskState, normalizeEvent, validateEvent } from "./task.ts";

const must = (r: Outcome) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const PRODUCER = "claude-opus-5-5";
const running = () => must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" }])).task;
const inReview = (commit = "abc") => must(apply(running(), { kind: "SubmitForReview", commit, computeId: "cc-1", constraintVer: 0 })).task;
const approve = (commit: string, constraintVer: number, round = 1): TaskEvent => ({ kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round, commit, constraintVer, verdict: "approve" });
const delivered = () => must(applyAll(inReview(), [approve("abc", 0), { kind: "DeliveredCard", ...D1 }])).task;

/** 第一次交付的代次与 commit(delivered() 链);DC1 是 inState 代表性交付(commit "c")。 */
const D1 = { taskId: "t1", deliveryRound: 1, commit: "abc" } as const;
const DC1 = { taskId: "t", deliveryRound: 1, commit: "c" } as const;
const SAMPLE: { [K in EventKind]: Extract<TaskEvent, { kind: K }> } = {
  Claim: { kind: "Claim", by: "x" }, Dispatch: { kind: "Dispatch", computeId: "c", model: "gpt-6", requestId: "t#L0" },
  ProducerModelAdded: { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc" }, NeedHuman: { kind: "NeedHuman", qId: "q", computeId: "cc", constraintVer: 0 },
  HumanReply: { kind: "HumanReply", qId: "q", constraintVer: 0, answer: "approve" }, Amend: { kind: "Amend", by: "u1", computeResumable: true },
  SubmitForReview: { kind: "SubmitForReview", commit: "c2", computeId: "cc", constraintVer: 0 },
  Review: { kind: "Review", reviewerId: "r", reviewerModel: "gpt-6", round: 1, commit: "c", constraintVer: 0, verdict: "approve" },
  DeliveredCard: { kind: "DeliveredCard", ...DC1 }, UserAccept: { kind: "UserAccept", by: "u1", ...DC1 }, UserReject: { kind: "UserReject", by: "u1", computeResumable: true, ...DC1 },
  AcceptTimeout: { kind: "AcceptTimeout", ...DC1 }, Cancel: { kind: "Cancel", by: "u1" }, StoppedConfirmed: { kind: "StoppedConfirmed", taskId: "t", computeId: "cc" }, ExecFailed: { kind: "ExecFailed", computeId: "cc" },
};
/** 各状态的代表性任务:T1 没有 Compute;T2 有在途首派请求 t#L0;其余由 cc 执行;T4b 带一张当前版本的卡;T5 正在审第 1 轮的 commit "c"。 */
const inState = (s: TaskState): Task => ({
  ...newTask("t", "u1"), state: s, owner: "o",
  computeId: s === "T1_Open" || s === "T2_Claimed" ? null : "cc",
  instances: s === "T1_Open" || s === "T2_Claimed" ? [] : ["cc"],
  launch: s === "T2_Claimed" ? { requestId: "t#L0", constraintVer: 0 } : null,
  producerModels: [PRODUCER], reviewedCommit: s === "T5_InReview" ? "c" : null, reviewRound: s === "T5_InReview" ? 1 : 0,
  pendingQ: s === "T4b_BlockedOnHuman" ? { qId: "q", constraintVer: 0 } : null,
  ...(["T7_Delivering", "T8a_Delivered", "T8_Accepted"].includes(s) ? { delivery: { round: 1, commit: "c" }, deliverySeq: 1 } : {}),
});

// 独立需求期望(D20.3 第三台表主干 + AC-19/26/28 + R-09),不读生产 TABLE:
// "rej" = 必须被拒;"ign" = 必须原样忽略;对象 = 必须转到 to,副作用恰为 fx,版本为 ver(给出时);
// 负责人默认不变(给出 owner 时为该值),累积生产模型默认不变(给出 pm 时为该值)——身份与厂商集合每格都查(R2-TEST-01)。
type Exp = "rej" | "ign" | { to: TaskState; fx?: Effect[]; ver?: number; owner?: string; pm?: string[] };
const PM2 = [PRODUCER, "gpt-6"];
const STOP: Effect[] = [{ kind: "stop-compute", computeId: "cc" }];
const RESUME: Effect[] = [{ kind: "resume-compute", computeId: "cc", constraintVer: 1 }];
const REWORK: Exp = { to: "T3_Running", fx: RESUME, ver: 1 };
const allIgn = (): { [E in EventKind]: Exp } => Object.fromEntries(EVENT_KINDS.map((k) => [k, "ign"])) as { [E in EventKind]: Exp };
/** 带着不认识的启动请求号上线的实例:不绑定,立即停止(R2-CORR-01 / R4-CORR-03)。 */
const ORPHAN_STOP = (s: TaskState): Exp => ({ to: s, fx: [{ kind: "stop-compute", computeId: "c" }] });
const SPEC: { [S in TaskState]: { [E in EventKind]: Exp } } = {
  T1_Open: {
    Claim: { to: "T2_Claimed", owner: "x" }, Dispatch: "rej", ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign",
    Amend: { to: "T1_Open", ver: 1 }, SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T10_Cancelled", fx: [] }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T2_Claimed: {
    Claim: "rej", Dispatch: { to: "T3_Running", pm: PM2 }, ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign",
    Amend: { to: "T2_Claimed", ver: 1, fx: [{ kind: "cancel-spawn", requestId: "t#L0" }, { kind: "spawn-compute", withHandoff: false, requestId: "t#L1", constraintVer: 1 }] },
    SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: [{ kind: "cancel-spawn", requestId: "t#L0" }] }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T3_Running: {
    Claim: "rej", Dispatch: ORPHAN_STOP("T3_Running"), ProducerModelAdded: { to: "T3_Running", pm: PM2 }, NeedHuman: { to: "T4b_BlockedOnHuman" }, HumanReply: "ign",
    Amend: { to: "T3_Running", fx: [{ kind: "update-constraints", computeId: "cc", constraintVer: 1 }], ver: 1 }, SubmitForReview: { to: "T5_InReview", fx: [{ kind: "request-review", round: 1, commit: "c2", constraintVer: 0 }] }, Review: "rej", DeliveredCard: "rej",
    UserAccept: "rej", UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T4b_BlockedOnHuman: {
    Claim: "rej", Dispatch: ORPHAN_STOP("T4b_BlockedOnHuman"), ProducerModelAdded: { to: "T4b_BlockedOnHuman", pm: PM2 }, NeedHuman: "rej", HumanReply: { to: "T3_Running", fx: [] },
    Amend: { to: "T3_Running", fx: [{ kind: "update-constraints", computeId: "cc", constraintVer: 1 }], ver: 1 }, SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T5_InReview: {
    Claim: "rej", Dispatch: ORPHAN_STOP("T5_InReview"), ProducerModelAdded: { to: "T5_InReview", pm: PM2 }, NeedHuman: "rej", HumanReply: "ign",
    Amend: REWORK, SubmitForReview: { to: "T5_InReview", fx: [{ kind: "request-review", round: 2, commit: "c2", constraintVer: 0 }] }, Review: { to: "T7_Delivering", fx: [{ kind: "send-card", taskId: "t", deliveryRound: 1, commit: "c", constraintVer: 0 }] }, DeliveredCard: "rej",
    UserAccept: "rej", UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T7_Delivering: {
    Claim: "rej", Dispatch: ORPHAN_STOP("T7_Delivering"), ProducerModelAdded: { to: "T7_Delivering", pm: PM2, fx: [] }, NeedHuman: "rej", HumanReply: "ign", Amend: REWORK,
    SubmitForReview: "rej", Review: "ign", DeliveredCard: { to: "T8a_Delivered", fx: [] }, UserAccept: "rej", UserReject: "rej",
    AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T8a_Delivered: {
    Claim: "rej", Dispatch: ORPHAN_STOP("T8a_Delivered"), ProducerModelAdded: { to: "T8a_Delivered", pm: PM2, fx: [] }, NeedHuman: "rej", HumanReply: "ign", Amend: REWORK,
    SubmitForReview: "rej", Review: "ign", DeliveredCard: "ign", UserAccept: { to: "T8_Accepted", fx: [] }, UserReject: REWORK,
    AcceptTimeout: "rej", Cancel: "ign", StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T8_Accepted: { ...allIgn(), Dispatch: ORPHAN_STOP("T8_Accepted"), ProducerModelAdded: { to: "T8_Accepted", pm: PM2, fx: [] }, Amend: REWORK, UserReject: REWORK },
  T9_StopRequested: { ...allIgn(), Claim: "rej", Dispatch: ORPHAN_STOP("T9_StopRequested"), StoppedConfirmed: { to: "T10_Cancelled", fx: [{ kind: "release-slot", computeId: "cc" }] } },
  T10_Cancelled: { ...allIgn(), Dispatch: ORPHAN_STOP("T10_Cancelled") },
  T11_Failed: { ...allIgn(), Dispatch: ORPHAN_STOP("T11_Failed") },
};
// 这些状态的代表性任务从未分配过交付代次,样例里的第 1 代次是未分配的未来代次:四类交付事件在任何状态都必须拒绝(R7-CORR-02)
for (const s of ["T1_Open", "T2_Claimed", "T3_Running", "T4b_BlockedOnHuman", "T5_InReview", "T9_StopRequested", "T10_Cancelled", "T11_Failed"] as const) {
  for (const k of ["DeliveredCard", "UserAccept", "UserReject", "AcceptTimeout"] as const) SPEC[s][k] = "rej";
}
test("AC-09 每个状态×每个事件都有明确处理:拒绝格实际拒绝并给出原因,忽略格实际不改任务", () => {
  for (const s of STATES) for (const e of EVENT_KINDS) {
    const cell = TABLE[s][e];
    assert.ok(cell && ["go", "reject", "ignore"].includes(cell.kind), `${s} × ${e} 是空白格`);
    const t = inState(s);
    const r = apply(t, SAMPLE[e]);
    // 入口先于状态表:本任务未分配过的交付代次直接拒绝,轮不到表格(R7-CORR-02)
    if (["DeliveredCard", "UserAccept", "UserReject", "AcceptTimeout"].includes(e) && t.deliverySeq === 0) {
      assert.ok(!r.ok && /未分配/.test(r.reason), `${s} × ${e} 未分配的交付代次应在入口拒绝`);
      continue;
    }
    if (cell.kind === "reject") assert.ok(!r.ok && r.reason.includes(cell.reason) && cell.reason.length > 0, `${s} × ${e} 拒绝但没给出表里的原因`);
    if (cell.kind === "ignore") {
      assert.ok(cell.reason.length > 0, `${s} × ${e} 忽略但没写原因`);
      assert.deepEqual(r, { ok: true, task: t, effects: [] }, `${s} × ${e} 应原样忽略`);
    }
  }
});

test("AC-09 每格的实际处理符合独立需求期望(目标状态、副作用、版本、负责人、累积生产模型),不以生产表为判据", () => {
  for (const s of STATES) for (const e of EVENT_KINDS) {
    const want = SPEC[s][e];
    const t = inState(s);
    const r = apply(t, SAMPLE[e]);
    const at = `${s} × ${e}`;
    if (want === "rej") { assert.equal(r.ok, false, `${at} 应拒绝`); continue; }
    if (want === "ign") { assert.deepEqual(r, { ok: true, task: t, effects: [] }, `${at} 应原样忽略`); continue; }
    assert.ok(r.ok, `${at} 应转移,实际被拒:${!r.ok ? r.reason : ""}`);
    assert.equal(r.ok && r.task.state, want.to, `${at} 目标状态`);
    if (want.fx) assert.deepEqual(r.ok && r.effects, want.fx, `${at} 副作用`);
    if (want.ver !== undefined) assert.equal(r.ok && r.task.constraintVer, want.ver, `${at} 条件版本`);
    assert.equal(r.ok && r.task.owner, want.owner ?? t.owner, `${at} 负责人`);
    assert.deepEqual(r.ok && r.task.producerModels, want.pm ?? t.producerModels, `${at} 累积生产模型`);
  }
});

// 所有返工入口 × 可恢复两侧的独立期望:可恢复 → 恢复原实例;不可恢复 → 清掉旧实例、按新版本带交接新开(AC-28 / R2-TEST-01)
type ReworkEntry = { s: TaskState; e: (resumable: boolean) => TaskEvent };
const REWORK_ENTRIES: ReworkEntry[] = [
  ...(["T5_InReview", "T7_Delivering", "T8a_Delivered", "T8_Accepted"] as const).map((s) => ({ s, e: (r: boolean): TaskEvent => ({ kind: "Amend", by: "u1", computeResumable: r }) })),
  ...(["T8a_Delivered", "T8_Accepted"] as const).map((s) => ({ s, e: (r: boolean): TaskEvent => ({ kind: "UserReject", by: "u1", computeResumable: r, ...DC1 }) })),
  { s: "T5_InReview", e: (r: boolean): TaskEvent => ({ kind: "Review", reviewerId: "r", reviewerModel: "gemini-4-argon", round: 1, commit: "c", constraintVer: 0, verdict: "reject", computeResumable: r }) },
];

test("AC-28 每个返工入口两侧:可恢复恢复原实例,不可恢复按新版本带交接新开,负责人与生产集合不变", () => {
  for (const { s, e } of REWORK_ENTRIES) for (const resumable of [true, false]) {
    const t = { ...inState(s), producerModels: PM2 };
    const ev = e(resumable);
    const at = `${s} × ${ev.kind}(${resumable})`;
    const r = must(apply(t, ev));
    assert.equal(r.task.state, "T3_Running", at);
    assert.equal(r.task.constraintVer, 1, at);
    assert.equal(r.task.owner, "o", at);
    assert.deepEqual(r.task.producerModels, PM2, at);
    assert.equal(r.task.reviewedCommit, null, at);
    assert.equal(r.task.reviewGate, "none", at);
    assert.equal(r.task.badge, "none", at);
    if (resumable) {
      assert.equal(r.task.computeId, "cc", at);
      assert.equal(r.task.launch, null, at);
      assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc", constraintVer: 1 }], at);
    } else {
      assert.equal(r.task.computeId, null, at);
      assert.deepEqual(r.task.launch, { requestId: "t#L1", constraintVer: 1 }, at);
      assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: true, requestId: "t#L1", constraintVer: 1 }], at);
    }
  }
});

test("applyAll 遇到第一个被拒的事件就停,返回原因,不应用后面的事件", () => {
  const r = applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "a" }, { kind: "Claim", by: "b" }, { kind: "Cancel", by: "u1" }]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /重复认领/);
});

test("主干:认领 → 派发 → 提审 → 跨厂商通过 → 交付待确认", () => {
  const r = applyAll(newTask("t1", "u1"), [
    { kind: "Claim", by: "claude" },
    { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" },
    { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 },
    { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" },
    { kind: "DeliveredCard", ...D1 },
  ]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.task.state, "T8a_Delivered");
  assert.equal(r.ok && r.task.owner, "claude");
  assert.equal(r.ok && r.task.reviewedCommit, "abc");
  assert.equal(r.ok && r.task.reviewGate, "compliant");
});

test("重复认领被原子拒绝(C-US10)", () => {
  const t = must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }])).task;
  const r = apply(t, { kind: "Claim", by: "argon" });
  assert.equal(r.ok, false);
});

const rv = (reviewerId: string, reviewerModel: string, extra: { waiverBy?: string } = {}): TaskEvent => ({ kind: "Review", reviewerId, reviewerModel, round: 1, commit: "abc", constraintVer: 0, verdict: "approve", ...extra });

test("AC-26 ① 作者自审被拒,任务停在 T5", () => {
  const r = apply(inReview(), rv("claude", "gpt-6-astra"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /作者/);
});

test("AC-26 ② 审查模型与生产模型同厂商被拒", () => {
  const r = apply(inReview(), rv("argon", "claude-sonnet-5-5"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /anthropic/);
});

test("AC-26 ② 半途换模:审查厂商落在累积生产厂商集合里也被拒,不只看末次模型", () => {
  const t = must(applyAll(running(), [{ kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" }, { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 }])).task;
  assert.deepEqual(t.producerModels, [PRODUCER, "gpt-6"]);
  const r = apply(t, rv("astra", "gpt-6-astra"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /openai/);
});

test("AC-26 ② 审查厂商只和早先的生产模型同厂商,也要拦(不能只看末次模型)", () => {
  const t = must(applyAll(running(), [{ kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" }, { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 }])).task;
  const r = apply(t, rv("argon", "claude-sonnet-5-5"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /anthropic/);
});

test("AC-26 ③ 审查或生产模型厂商认不出(unknown)被拒", () => {
  const a = apply(inReview(), rv("x", "stealth/crouton-alpha"));
  assert.equal(a.ok, false);
  const t = must(applyAll(newTask("t2", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "c", model: "stealth/crouton-alpha", requestId: "t2#L0" }, { kind: "SubmitForReview", commit: "abc", computeId: "c", constraintVer: 0 }])).task;
  const b = apply(t, rv("astra", "gpt-6-astra"));
  assert.equal(b.ok, false);
});

test("AC-26 ④ 不同联系人、不同已知厂商 → 合规通过进入交付", () => {
  const r = apply(inReview(), rv("argon", "gemini-4-argon"));
  assert.ok(r.ok);
  assert.equal(r.ok && r.task.state, "T7_Delivering");
  assert.equal(r.ok && r.task.reviewGate, "compliant");
});

test("AC-26 ⑤ 提出者本人豁免同厂商:允许推进但记为 Waived,不是合规", () => {
  const r = apply(inReview(), rv("argon", "claude-sonnet-5-5", { waiverBy: "u1" }));
  assert.ok(r.ok);
  assert.equal(r.ok && r.task.reviewGate, "waived-by-user");
  const other = apply(inReview(), rv("argon", "claude-sonnet-5-5", { waiverBy: "argon" }));
  assert.equal(other.ok, false);
});
test("CORR-01 新提交后投递旧 commit 的审查回包:幂等忽略,不推进、不批准新提交", () => {
  const newer = must(apply(inReview("sha-a"), { kind: "SubmitForReview", commit: "sha-b", computeId: "cc-1", constraintVer: 0 })).task;
  assert.equal(newer.reviewedCommit, "sha-b");
  const r = must(apply(newer, approve("sha-a", 0, 1)));
  assert.equal(r.task.state, "T5_InReview");
  assert.equal(r.task.reviewGate, "none");
  assert.deepEqual(r.effects, []);
});

test("CORR-01 改条件后再次提审,旧条件版本的审查回包被忽略", () => {
  const back = must(applyAll(inReview("sha-a"), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "SubmitForReview", commit: "sha-a", computeId: "cc-1", constraintVer: 1 }])).task;
  assert.equal(back.constraintVer, 1);
  const stale = must(apply(back, approve("sha-a", 0, 2)));
  assert.equal(stale.task.state, "T5_InReview");
  assert.equal(stale.task.reviewGate, "none");
});

test("CORR-01 当前轮次、当前 commit 与当前版本的审查回包正常生效(阴性对照)", () => {
  const newer = must(apply(inReview("sha-a"), { kind: "SubmitForReview", commit: "sha-b", computeId: "cc-1", constraintVer: 0 })).task;
  const r = must(apply(newer, approve("sha-b", 0, 2)));
  assert.equal(r.task.state, "T7_Delivering");
  assert.equal(r.task.reviewedCommit, "sha-b");
  assert.equal(r.task.reviewGate, "compliant");
});

test("R2-CORR-04 审查对象 ABA:sha-a → sha-b → sha-a 后,第一轮 sha-a 的迟到批准不复活,只认第三轮", () => {
  const aba = must(applyAll(inReview("sha-a"), [{ kind: "SubmitForReview", commit: "sha-b", computeId: "cc-1", constraintVer: 0 }, { kind: "SubmitForReview", commit: "sha-a", computeId: "cc-1", constraintVer: 0 }]));
  assert.equal(aba.task.reviewRound, 3);
  assert.deepEqual(aba.effects, [{ kind: "request-review", round: 2, commit: "sha-b", constraintVer: 0 }, { kind: "request-review", round: 3, commit: "sha-a", constraintVer: 0 }]);
  const stale = must(apply(aba.task, approve("sha-a", 0, 1)));
  assert.equal(stale.task.state, "T5_InReview");
  assert.equal(stale.task.reviewGate, "none");
  const fresh = must(apply(aba.task, approve("sha-a", 0, 3)));
  assert.equal(fresh.task.state, "T7_Delivering");
});

test("R2-CORR-04 改条件退回再提审同一 commit:轮次号继续递增不复用,旧轮次回包无效", () => {
  const again = must(applyAll(inReview("sha-a"), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }])).task;
  const re = must(apply({ ...again, constraintVer: 0 }, { kind: "SubmitForReview", commit: "sha-a", computeId: "cc-1", constraintVer: 0 }));
  assert.equal(re.task.reviewRound, 2);
  assert.equal(must(apply(re.task, approve("sha-a", 0, 1))).task.state, "T5_InReview");
});

test("审查中再次提审:换成新 commit 与新轮次,评审结论清空并发出新审查请求", () => {
  const r = must(apply(inReview("sha-a"), { kind: "SubmitForReview", commit: "sha-b", computeId: "cc-1", constraintVer: 0 }));
  assert.equal(r.task.state, "T5_InReview");
  assert.equal(r.task.reviewedCommit, "sha-b");
  assert.equal(r.task.reviewRound, 2);
  assert.deepEqual(r.effects, [{ kind: "request-review", round: 2, commit: "sha-b", constraintVer: 0 }]);
});

const reject = (computeResumable: boolean): TaskEvent => ({ kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "reject", computeResumable });

test("审查打回且原 Compute 可恢复:回到执行中,恢复原实例,清掉评审对象", () => {
  const r = must(apply(inReview(), reject(true)));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-1");
  assert.equal(r.task.reviewedCommit, null);
  assert.equal(r.task.reviewGate, "none");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

test("CORR-03 审查打回且原 Compute 不可恢复:带交接新开,不向失效 ID 发 resume", () => {
  const r = must(apply(inReview(), reject(false)));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, null);
  assert.deepEqual(r.task.launch, { requestId: "t1#L1", constraintVer: 1 });
  assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: true, requestId: "t1#L1", constraintVer: 1 }]);
});

test("CORR-03 提审中改条件:作废评审、退回执行并恢复原 Compute", () => {
  const r = must(apply(inReview(), { kind: "Amend", by: "u1", computeResumable: true }));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.constraintVer, 1);
  assert.equal(r.task.reviewedCommit, null);
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

test("CORR-03 已交付后追加条件且原 Compute 不可恢复:带交接新开", () => {
  const r = must(apply(delivered(), { kind: "Amend", by: "u1", computeResumable: false }));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, null);
  assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: true, requestId: "t1#L1", constraintVer: 1 }]);
});

test("CORR-03 交付中追加条件且原 Compute 可恢复:恢复原实例,版本推进", () => {
  const delivering = must(apply(inReview(), approve("abc", 0))).task;
  const r = must(apply(delivering, { kind: "Amend", by: "u1", computeResumable: true }));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.constraintVer, 1);
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

const respawned = () => must(apply(delivered(), { kind: "UserReject", by: "u1", computeResumable: false, ...D1 })).task;
const L1 = "t1#L1";
const up = (computeId: string, requestId: string = L1): TaskEvent => ({ kind: "Dispatch", computeId, model: "gemini-4-argon", requestId });

test("CORR-02 不可恢复返工后新 Compute 回绑:记录新实例、保留负责人并累积生产模型", () => {
  const r = must(apply(respawned(), up("cc-2")));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-2");
  assert.equal(r.task.launch, null);
  assert.equal(r.task.owner, "claude");
  assert.deepEqual(r.task.producerModels, [PRODUCER, "gemini-4-argon"]);
  const second = must(apply(r.task, { kind: "Dispatch", computeId: "cc-3", model: "gpt-6", requestId: L1 }));
  assert.equal(second.task.computeId, "cc-2");
  assert.deepEqual(second.task.orphans, ["cc-3"]);
  assert.deepEqual(second.task.producerModels, [PRODUCER, "gemini-4-argon"]);
  assert.deepEqual(second.effects, [{ kind: "stop-compute", computeId: "cc-3" }]);
});

test("R2-CORR-01 回绑必须对上当前启动请求号:已用过的旧请求号与别的请求号的实例都被立即停止", () => {
  const t = respawned();
  const reused = must(apply(t, up("cc-2", "t1#L0")));
  assert.equal(reused.task.computeId, null);
  assert.deepEqual(reused.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
  const wrong = must(apply(t, up("cc-x", "t1#L9")));
  assert.equal(wrong.task.computeId, null);
  assert.deepEqual(wrong.task.launch, { requestId: L1, constraintVer: 1 });
  assert.deepEqual(wrong.effects, [{ kind: "stop-compute", computeId: "cc-x" }]);
});

test("CORR-02 回绑后取消:停止的是新实例,真实停止后释放它的槽位", () => {
  const bound = must(apply(respawned(), up("cc-2"))).task;
  const r1 = must(apply(bound, { kind: "Cancel", by: "u1" }));
  assert.equal(r1.task.state, "T9_StopRequested");
  assert.deepEqual(r1.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
  const r2 = must(apply(r1.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-2" }));
  assert.equal(r2.task.state, "T10_Cancelled");
  assert.deepEqual(r2.effects, [{ kind: "release-slot", computeId: "cc-2" }]);
});

test("CORR-02 新实例启动途中取消:撤销这次启动,确认前上线的实例被立即停止且负责人不变", () => {
  const r1 = must(apply(respawned(), { kind: "Cancel", by: "u1" }));
  assert.equal(r1.task.state, "T9_StopRequested");
  assert.deepEqual(r1.effects, [{ kind: "cancel-spawn", requestId: L1 }]);
  const late = must(apply(r1.task, up("cc-2")));
  assert.equal(late.task.state, "T9_StopRequested");
  assert.equal(late.task.owner, "claude");
  assert.deepEqual(late.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
  const done = must(apply(late.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-2" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-2" }]);
});

test("R2-CORR-01 启动途中取消后,旧实例的迟到停止确认不终结任务,新实例仍会被停止回收", () => {
  const stopping = must(apply(respawned(), { kind: "Cancel", by: "u1" })).task;
  const oldAck = must(apply(stopping, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-1" }));
  assert.equal(oldAck.task.state, "T9_StopRequested");
  assert.deepEqual(oldAck.effects, []);
  const bare = must(apply(stopping, { kind: "StoppedConfirmed", taskId: "t1" }));
  assert.equal(bare.task.state, "T9_StopRequested");
  const late = must(apply(oldAck.task, up("cc-2")));
  assert.deepEqual(late.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
  assert.equal(must(apply(late.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: L1 })).task.state, "T9_StopRequested");
  const done = must(apply(late.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-2" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-2" }]);
});

test("R2-CORR-01 启动撤销被确认(实例从未上线):凭这次的请求号进终态,重复确认幂等", () => {
  const stopping = must(apply(respawned(), { kind: "Cancel", by: "u1" })).task;
  const done = must(apply(stopping, { kind: "StoppedConfirmed", taskId: "t1", requestId: L1 }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, []);
  const again = must(apply(done.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: L1 }));
  assert.equal(again.task.state, "T10_Cancelled");
  const zombie = must(apply(done.task, up("cc-2")));
  assert.equal(zombie.task.state, "T10_Cancelled");
  assert.deepEqual(zombie.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
});

test("R2-CORR-02 启动在途时改条件:撤销旧启动、按新版本重新发起,旧启动迟到上线被停止,只认新启动", () => {
  const t = respawned();
  const r = must(apply(t, { kind: "Amend", by: "u1", computeResumable: true }));
  assert.equal(r.task.constraintVer, 2);
  assert.deepEqual(r.task.launch, { requestId: "t1#L2", constraintVer: 2 });
  assert.deepEqual(r.effects, [{ kind: "cancel-spawn", requestId: L1 }, { kind: "spawn-compute", withHandoff: true, requestId: "t1#L2", constraintVer: 2 }]);
  const old = must(apply(r.task, up("cc-old", L1)));
  assert.equal(old.task.computeId, null);
  assert.deepEqual(old.effects, [{ kind: "stop-compute", computeId: "cc-old" }]);
  const fresh = must(apply(old.task, up("cc-new", "t1#L2")));
  assert.equal(fresh.task.computeId, "cc-new");
  assert.equal(fresh.task.constraintVer, 2);
});

test("R2-CORR-02 已有实例时改条件只推进版本并通知该实例新版本,不重启(阴性对照)", () => {
  const r = must(apply(running(), { kind: "Amend", by: "u1", computeResumable: true }));
  assert.equal(r.task.constraintVer, 1);
  assert.equal(r.task.computeId, "cc-1");
  assert.deepEqual(r.effects, [{ kind: "update-constraints", computeId: "cc-1", constraintVer: 1 }]);
});

const bound2 = () => must(apply(respawned(), up("cc-2"))).task;

test("R3-CORR-01 当前实例的重复上线回包在 T3/T4b/T5 都幂等,绝不停当前实例", () => {
  const t3 = bound2();
  assert.equal(t3.boundRequest, L1);
  const t4b = must(apply(t3, { kind: "NeedHuman", qId: "q1", computeId: "cc-2", constraintVer: 1 })).task;
  const t5 = must(apply(t3, { kind: "SubmitForReview", commit: "x", computeId: "cc-2", constraintVer: 1 })).task;
  for (const t of [t3, t4b, t5]) {
    const r = must(apply(t, up("cc-2")));
    assert.equal(r.task.state, t.state, t.state);
    assert.equal(r.task.computeId, "cc-2", t.state);
    assert.deepEqual(r.effects, [], t.state);
  }
});

test("R3-CORR-01 绑定后不同旧请求的不同实例在 T3/T4b/T5/T7/T8a 仍被停止并登记待确认(阴性对照)", () => {
  const t3 = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2")])).task;
  const t4b = must(apply(t3, { kind: "NeedHuman", qId: "q1", computeId: "cc-new", constraintVer: 2 })).task;
  const t5 = must(apply(t3, { kind: "SubmitForReview", commit: "x", computeId: "cc-new", constraintVer: 2 })).task;
  const t7 = must(apply(t5, approve("x", 2, 2))).task;
  const t8a = must(apply(t7, { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "x" })).task;
  for (const t of [t3, t4b, t5, t7, t8a]) {
    const r = must(apply(t, up("cc-old", L1)));
    assert.equal(r.task.state, t.state, t.state);
    assert.equal(r.task.computeId, "cc-new", t.state);
    assert.deepEqual(r.task.orphans, ["cc-old"], t.state);
    assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "cc-old" }], t.state);
    assert.deepEqual(must(apply(r.task, up("cc-old", L1))).effects, [], `${t.state} 重复孤儿回包`);
  }
});

test("R3-CORR-02 撤销重发后取消:L2 确认了,旧 L1 的孤儿实例没确认停止前不进终态", () => {
  const stopping = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Cancel", by: "u1" }]));
  assert.deepEqual(stopping.task.revoked, [L1]);
  assert.deepEqual(stopping.effects, [{ kind: "cancel-spawn", requestId: L1 }, { kind: "spawn-compute", withHandoff: true, requestId: "t1#L2", constraintVer: 2 }, { kind: "cancel-spawn", requestId: "t1#L2" }]);
  const orphan = must(apply(stopping.task, up("old-worker", L1)));
  assert.deepEqual(orphan.effects, [{ kind: "stop-compute", computeId: "old-worker" }]);
  assert.deepEqual(orphan.task.revoked, []);
  assert.deepEqual(orphan.task.orphans, ["old-worker"]);
  const l2 = must(apply(orphan.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L2" }));
  assert.equal(l2.task.state, "T9_StopRequested");
  const dup = must(apply(l2.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L2" }));
  assert.equal(dup.task.state, "T9_StopRequested");
  const done = must(apply(l2.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "old-worker" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
});

test("R3-CORR-02 乱序:孤儿先确认、L2 后确认也进终态;旧 L1 只确认撤销从未上线也算清掉", () => {
  const stopping = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Cancel", by: "u1" }])).task;
  const a = must(applyAll(stopping, [up("old-worker", L1), { kind: "StoppedConfirmed", taskId: "t1", computeId: "old-worker" }]));
  assert.equal(a.task.state, "T9_StopRequested");
  assert.equal(must(apply(a.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L2" })).task.state, "T10_Cancelled");
  const b = must(applyAll(stopping, [{ kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L2" }]));
  assert.equal(b.task.state, "T9_StopRequested");
  assert.equal(must(apply(b.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: L1 })).task.state, "T10_Cancelled");
});

test("R3-CORR-02 失败终态同样要等所有旧启动与孤儿;旧实例的确认不能代替当前实例的确认", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2"), up("old-worker", L1)])).task;
  const failing = must(apply(t, { kind: "ExecFailed", computeId: "cc-new" }));
  assert.equal(failing.task.state, "T9_StopRequested");
  assert.deepEqual(failing.effects, [{ kind: "stop-compute", computeId: "cc-new" }]);
  const oldAck = must(apply(failing.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "old-worker" }));
  assert.equal(oldAck.task.state, "T9_StopRequested");
  assert.equal(oldAck.task.computeId, "cc-new");
  assert.deepEqual(oldAck.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
  const done = must(apply(oldAck.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-new" }));
  assert.equal(done.task.state, "T11_Failed");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-new" }]);
});

test("R3-CORR-02 运行中孤儿确认停止后释放它的槽位,任务不受影响;没有未决对象时取消直接终态(阴性对照)", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2"), up("old-worker", L1)])).task;
  const r = must(apply(t, { kind: "StoppedConfirmed", taskId: "t1", computeId: "old-worker" }));
  assert.equal(r.task.state, "T3_Running");
  assert.deepEqual(r.task.orphans, []);
  assert.deepEqual(r.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
  assert.deepEqual(must(apply(r.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "old-worker" })).effects, []);
  const open = must(apply(newTask("t9", "u1"), { kind: "Cancel", by: "u1" }));
  assert.equal(open.task.state, "T10_Cancelled");
});

test("R3-CORR-03 旧执行器的提审、提问、换模、失败回包都不影响当前代次", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2")])).task;
  assert.equal(t.constraintVer, 2);
  const sub = must(apply(t, { kind: "SubmitForReview", commit: "old-L1-artifact", computeId: "old-worker", constraintVer: 1 }));
  assert.equal(sub.task.state, "T3_Running");
  assert.deepEqual(sub.effects, []);
  const ask = must(apply(t, { kind: "NeedHuman", qId: "qx", computeId: "old-worker", constraintVer: 1 }));
  assert.equal(ask.task.state, "T3_Running");
  const pm = must(apply(t, { kind: "ProducerModelAdded", model: "gpt-6", computeId: "old-worker" }));
  assert.deepEqual(pm.task.producerModels, t.producerModels);
  const fail = must(apply(t, { kind: "ExecFailed", computeId: "old-worker" }));
  assert.equal(fail.task.state, "T3_Running");
  assert.deepEqual(fail.effects, []);
  const pendingFail = must(apply(respawned(), { kind: "ExecFailed", requestId: "t1#L9" }));
  assert.equal(pendingFail.task.state, "T3_Running");
});

test("R3-CORR-03 旧实例即使报的是当前条件版本,它的提审与提问也被忽略(来源单独把关)", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2")])).task;
  const sub = must(apply(t, { kind: "SubmitForReview", commit: "forged", computeId: "old-worker", constraintVer: 2 }));
  assert.equal(sub.task.state, "T3_Running");
  assert.deepEqual(sub.effects, []);
  const ask = must(apply(t, { kind: "NeedHuman", qId: "qx", computeId: "old-worker", constraintVer: 2 }));
  assert.equal(ask.task.state, "T3_Running");
  assert.equal(ask.task.pendingQ, null);
});

test("R3-CORR-02 没有实例也没有在途启动、但还有未确认的孤儿时取消:进 T9 等它,不直接终态", () => {
  const t: Task = { ...newTask("t", "u1"), state: "T3_Running", owner: "o", producerModels: [PRODUCER], orphans: ["old-worker"] };
  const r = must(apply(t, { kind: "Cancel", by: "u1" }));
  assert.equal(r.task.state, "T9_StopRequested");
  assert.deepEqual(r.effects, []);
  const done = must(apply(r.task, { kind: "StoppedConfirmed", taskId: "t", computeId: "old-worker" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
});

test("R3-CORR-03 当前实例按旧条件版本做出的提审与提问也被忽略,按当前版本的才生效", () => {
  const t = must(apply(running(), { kind: "Amend", by: "u1", computeResumable: true })).task;
  assert.equal(must(apply(t, { kind: "SubmitForReview", commit: "v0", computeId: "cc-1", constraintVer: 0 })).task.state, "T3_Running");
  assert.equal(must(apply(t, { kind: "NeedHuman", qId: "q", computeId: "cc-1", constraintVer: 0 })).task.state, "T3_Running");
  const ok1 = must(apply(t, { kind: "SubmitForReview", commit: "v1", computeId: "cc-1", constraintVer: 1 }));
  assert.equal(ok1.task.state, "T5_InReview");
  assert.deepEqual(ok1.effects, [{ kind: "request-review", round: 1, commit: "v1", constraintVer: 1 }]);
  const pm = must(apply(t, { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" }));
  assert.deepEqual(pm.task.producerModels, [PRODUCER, "gpt-6"]);
});

test("R3-TEST-01 审查轮次:未来轮次与旧轮次的 approve/reject 都被忽略,只认当前轮", () => {
  const t = must(apply(inReview("sha-a"), { kind: "SubmitForReview", commit: "sha-a", computeId: "cc-1", constraintVer: 0 })).task;
  assert.equal(t.reviewRound, 2);
  for (const round of [1, 3]) {
    assert.equal(must(apply(t, approve("sha-a", 0, round))).task.state, "T5_InReview", `approve round ${round}`);
    const rj = must(apply(t, { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round, commit: "sha-a", constraintVer: 0, verdict: "reject", computeResumable: true }));
    assert.equal(rj.task.state, "T5_InReview", `reject round ${round}`);
    assert.deepEqual(rj.effects, [], `reject round ${round}`);
  }
  assert.equal(must(apply(t, approve("sha-a", 0, 2))).task.state, "T7_Delivering");
});

test("R3-TEST-01 多次改条件后卡片与审查请求都绑定当时的当前版本", () => {
  const t = must(applyAll(running(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }])).task;
  assert.equal(t.constraintVer, 3);
  const q = must(apply(t, { kind: "NeedHuman", qId: "q", computeId: "cc-1", constraintVer: 3 })).task;
  assert.deepEqual(q.pendingQ, { qId: "q", constraintVer: 3 });
  assert.equal(must(apply(q, { kind: "HumanReply", qId: "q", constraintVer: 3, answer: "approve" })).task.state, "T3_Running");
  const s = must(apply(t, { kind: "SubmitForReview", commit: "z", computeId: "cc-1", constraintVer: 3 }));
  assert.deepEqual(s.effects, [{ kind: "request-review", round: 1, commit: "z", constraintVer: 3 }]);
});

test("R3-TEST-01 回绑后再次不可恢复返工:启动请求号继续递增不复用", () => {
  const again = must(applyAll(bound2(), [{ kind: "SubmitForReview", commit: "y", computeId: "cc-2", constraintVer: 1 }, approve("y", 1, 2), { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "y" }, { kind: "UserReject", taskId: "t1", by: "u1", computeResumable: false, deliveryRound: 2, commit: "y" }]));
  assert.deepEqual(again.task.launch, { requestId: "t1#L2", constraintVer: 2 });
  assert.equal(again.task.launchSeq, 2);
  assert.equal(apply(again.task, up("cc-3", L1)).ok && must(apply(again.task, up("cc-3", L1))).task.computeId, null);
});

test("CORR-02 新实例未回绑前不能向人提问或提审,不会形成无卡阻塞态", () => {
  const t = respawned();
  // 来源还没回绑、版本是当前版本:无法证明是旧回包,保守拒绝
  assert.equal(apply(t, { kind: "NeedHuman", qId: "q1", computeId: "cc-2", constraintVer: 1 }).ok, false);
  assert.equal(apply(t, { kind: "SubmitForReview", commit: "x", computeId: "cc-2", constraintVer: 1 }).ok, false);
  // 来自已被替换的旧实例 cc-1:可证明是旧回包,幂等忽略,任务不变(R5-CORR-03)
  assert.deepEqual(must(apply(t, { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 1 })).task, t);
  assert.deepEqual(must(apply(t, { kind: "SubmitForReview", commit: "x", computeId: "cc-1", constraintVer: 1 })).effects, []);
});

test("CORR-02 新实例未回绑前执行失败:撤销启动,凭请求号确认后进失败终态", () => {
  const r = must(applyAll(respawned(), [{ kind: "ExecFailed", requestId: L1 }]));
  assert.deepEqual(r.effects, [{ kind: "cancel-spawn", requestId: L1 }]);
  const done = must(apply(r.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: L1 }));
  assert.equal(done.task.state, "T11_Failed");
});

test("R-09 用户确认才算验收通过", () => {
  const t = must(applyAll(delivered(), [{ kind: "UserAccept", by: "u1", ...D1 }])).task;
  assert.equal(t.state, "T8_Accepted");
  assert.equal(t.badge, "accepted");
});

test("R-09 只有提出者本人能确认验收", () => {
  const r = apply(delivered(), { kind: "UserAccept", by: "argon", ...D1 });
  assert.equal(r.ok, false);
});

test("AC-28① 交付待确认没有归档出口:状态集合里没有归档状态,T8a 只有用户确认能到 T8_Accepted,任何事件都不把它带进终态(用户定案 2273)", () => {
  assert.ok(!(STATES as readonly string[]).some((s) => /Archiv/.test(s)), STATES.join(","));
  const t = inState("T8a_Delivered");
  for (const e of EVENT_KINDS) {
    const r = apply(t, SAMPLE[e]);
    if (!r.ok || r.task.state === "T8a_Delivered") continue;
    assert.ok(["UserAccept", "UserReject", "Amend", "ProducerModelAdded"].includes(e), `${e} 不应让 T8a 离开到 ${r.task.state}`);
    if (r.task.state === "T8_Accepted") assert.equal(e, "UserAccept");
    assert.ok(!["T10_Cancelled", "T11_Failed"].includes(r.task.state), `${e} 把 T8a 带进了终态`);
  }
  assert.equal(apply(t, SAMPLE.AcceptTimeout).ok, false);
});

test("AC-28① 用户一直不说话:当前代次的 AcceptTimeout 在 T8a 被拒(用户定案 2273),任务原样停在 T8a,不归档、不算通过、不清当前交付(阳性埋雷)", () => {
  const t = delivered();
  const r = apply(t, { kind: "AcceptTimeout", ...D1 });
  assert.ok(!r.ok && r.reason.includes("#2273"), JSON.stringify(r));
  assert.deepEqual(applyAll(t, [{ kind: "AcceptTimeout", ...D1 }]), r);
  assert.equal(t.state, "T8a_Delivered");
  assert.equal(t.badge, "none");
  assert.deepEqual(t.delivery, { round: 1, commit: "abc" });
  const acc = must(apply(t, { kind: "UserAccept", by: "u1", ...D1 }));
  assert.equal(acc.task.state, "T8_Accepted");
  assert.equal(acc.task.badge, "accepted");
});

test("AC-28① 等过超时也只能由用户退回:被拒的 AcceptTimeout 之后,提出者退回照常恢复原实例", () => {
  const t = delivered();
  assert.equal(apply(t, { kind: "AcceptTimeout", ...D1 }).ok, false);
  const r = must(apply(t, { kind: "UserReject", by: "u1", computeResumable: true, ...D1 }));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.badge, "none");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

test("R-09 只有提出者本人能退回验收", () => {
  assert.equal(apply(delivered(), { kind: "UserReject", by: "argon", computeResumable: true, ...D1 }).ok, false);
  const accepted = must(apply(delivered(), { kind: "UserAccept", by: "u1", ...D1 })).task;
  assert.equal(apply(accepted, { kind: "UserReject", by: "argon", computeResumable: true, ...D1 }).ok, false);
});

test("AC-28 条件 A:原 Compute 可恢复 → 恢复原实例,不新开(阳性埋雷)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: true, ...D1 }]));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-1");
  assert.equal(r.task.reviewedCommit, null);
  assert.equal(r.task.reviewGate, "none");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

test("AC-28 条件 B:原 Compute 不可恢复 → 清掉旧实例并带交接摘要新开(阴性对照)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: false, ...D1 }]));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, null);
  assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: true, requestId: "t1#L1", constraintVer: 1 }]);
});
test("AC-19 确认卡绑定版本:用户中途改条件后,旧卡的回复作废不执行", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }])).task;
  assert.equal(blocked.state, "T4b_BlockedOnHuman");
  const amended = must(applyAll(blocked, [{ kind: "Amend", by: "u1", computeResumable: true }])).task;
  assert.equal(amended.state, "T3_Running");
  assert.equal(amended.constraintVer, 1);
  const stale = apply(amended, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" });
  assert.ok(stale.ok);
  assert.equal(stale.ok && stale.task.state, "T3_Running");
  assert.equal(stale.ok && stale.task.pendingQ, null);
});

test("AC-19 同一张卡在新版本下重新发出后,旧版本的回复被忽略,新卡仍待回复", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }])).task;
  const reasked = must(applyAll(blocked, [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 1 }])).task;
  assert.deepEqual(reasked.pendingQ, { qId: "q1", constraintVer: 1 });
  const staleApprove = must(applyAll(reasked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }])).task;
  assert.equal(staleApprove.state, "T4b_BlockedOnHuman");
  assert.deepEqual(staleApprove.pendingQ, { qId: "q1", constraintVer: 1 });
  const staleReject = must(applyAll(reasked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "reject" }])).task;
  assert.equal(staleReject.state, "T4b_BlockedOnHuman");
});

test("AC-19 拒绝当前版本的卡会停止任务", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }])).task;
  const r = must(applyAll(blocked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "reject" }]));
  assert.equal(r.task.state, "T9_StopRequested");
  assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "cc-1" }]);
});

test("AC-19 版本未变的确认正常放行(阴性对照)", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }])).task;
  const r = must(applyAll(blocked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }])).task;
  assert.equal(r.state, "T3_Running");
  assert.equal(r.pendingQ, null);
});

test("AC-19 绑定的卡片号不对的回复被拒", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }])).task;
  assert.equal(apply(blocked, { kind: "HumanReply", qId: "q9", constraintVer: 0, answer: "approve" }).ok, false);
});

test("R2-CORR-03 旧卡号+旧版本的迟到回复幂等忽略,不打断同一批里随后的当前卡有效回复", () => {
  const reasked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }, { kind: "Amend", by: "u1", computeResumable: true }, { kind: "NeedHuman", qId: "q2", computeId: "cc-1", constraintVer: 1 }])).task;
  assert.deepEqual(reasked.pendingQ, { qId: "q2", constraintVer: 1 });
  const stale = must(apply(reasked, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }));
  assert.equal(stale.task.state, "T4b_BlockedOnHuman");
  assert.deepEqual(stale.task.pendingQ, { qId: "q2", constraintVer: 1 });
  const batch = must(applyAll(reasked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "reject" }, { kind: "HumanReply", qId: "q2", constraintVer: 1, answer: "approve" }]));
  assert.equal(batch.task.state, "T3_Running");
  assert.equal(batch.task.pendingQ, null);
});

test("R2-CORR-03 当前版本但卡号不对的回复仍被拒(阴性对照)", () => {
  const reasked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 }, { kind: "Amend", by: "u1", computeResumable: true }, { kind: "NeedHuman", qId: "q2", computeId: "cc-1", constraintVer: 1 }])).task;
  const r = apply(reasked, { kind: "HumanReply", qId: "q1", constraintVer: 1, answer: "approve" });
  assert.equal(r.ok, false);
});

test("CORR-04 返回任务里的确认卡是冻结快照,直接改写它的版本不生效", () => {
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  assert.ok(Object.isFrozen(blocked.pendingQ));
  assert.throws(() => { (blocked.pendingQ as { constraintVer: number }).constraintVer = 99; }, TypeError);
  assert.deepEqual(blocked.pendingQ, { qId: "q1", constraintVer: 0 });
  const r = must(apply(blocked, { kind: "HumanReply", qId: "q1", constraintVer: 99, answer: "approve" }));
  assert.equal(r.task.state, "T4b_BlockedOnHuman");
  assert.deepEqual(r.task.pendingQ, { qId: "q1", constraintVer: 0 });
});

test("CORR-04 新旧 Task 不共享确认卡对象,外部伪造的可变卡片也被重新快照", () => {
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  const next = must(apply(blocked, { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" })).task;
  assert.ok(Object.isFrozen(next.pendingQ));
  const forgedQ = { qId: "q1", constraintVer: 0 };
  const forged = must(apply({ ...blocked, pendingQ: forgedQ }, { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" })).task;
  assert.notEqual(forged.pendingQ, forgedQ);
  forgedQ.constraintVer = 99;
  assert.deepEqual(forged.pendingQ, { qId: "q1", constraintVer: 0 });
});

test("CORR-04 卡片绑定版本与任务当前版本不一致时,回复被拒而不是放行", () => {
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  const tampered: Task = { ...blocked, pendingQ: { qId: "q1", constraintVer: 99 } };
  const forgedVer = must(apply(tampered, { kind: "HumanReply", qId: "q1", constraintVer: 99, answer: "approve" }));
  assert.equal(forgedVer.task.state, "T4b_BlockedOnHuman");
  const r = apply(tampered, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /不一致/);
});

test("取消在途任务:先请求停止,真实停止确认后才进终态并释放槽位", () => {
  const r1 = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }]));
  assert.equal(r1.task.state, "T9_StopRequested");
  assert.deepEqual(r1.effects, [{ kind: "stop-compute", computeId: "cc-1" }]);
  const r2 = must(applyAll(r1.task, [{ kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-1" }]));
  assert.equal(r2.task.state, "T10_Cancelled");
  assert.deepEqual(r2.effects, [{ kind: "release-slot", computeId: "cc-1" }]);
});

test("停止期间禁止把任务重新指派或重新派发给他人", () => {
  const stopping = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }])).task;
  assert.equal(apply(stopping, { kind: "Claim", by: "argon" }).ok, false);
  const late = must(apply(stopping, { kind: "Dispatch", computeId: "cc-2", model: "gpt-6", requestId: "t1#L0" }));
  assert.equal(late.task.computeId, "cc-1");
  assert.deepEqual(late.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
});

test("尚未认领(没发出任何派发请求)的任务取消直接进终态,不发停止信号", () => {
  const open = must(apply(newTask("t2", "u1"), { kind: "Cancel", by: "u1" }));
  assert.equal(open.task.state, "T10_Cancelled");
  assert.deepEqual(open.effects, []);
});

test("停止期间重复取消幂等,终态后迟到的事件不复活任务", () => {
  const stopping = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }])).task;
  const again = must(applyAll(stopping, [{ kind: "Cancel", by: "u1" }]));
  assert.equal(again.task.state, "T9_StopRequested");
  assert.deepEqual(again.effects, []);
  const done = must(applyAll(stopping, [{ kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-1" }])).task;
  const late = must(applyAll(done, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }, { kind: "ExecFailed", computeId: "cc-1" }]));
  assert.equal(late.task.state, "T10_Cancelled");
});

test("执行失败先停止再进失败终态", () => {
  const r = must(applyAll(running(), [{ kind: "ExecFailed", computeId: "cc-1" }, { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-1" }]));
  assert.equal(r.task.state, "T11_Failed");
});

test("交付中发卡失败不重跑 Compute:任务留在交付中,无副作用", () => {
  const delivering = must(apply(inReview(), approve("abc", 0))).task;
  const r = must(apply(delivering, { kind: "ExecFailed", computeId: "cc-1" }));
  assert.equal(r.task.state, "T7_Delivering");
  assert.deepEqual(r.effects, []);
});

test("改条件让版本单调递增,提审中改条件作废当前评审并回到执行", () => {
  const t = must(applyAll(inReview(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }])).task;
  assert.equal(t.constraintVer, 2);
  assert.equal(t.state, "T3_Running");
  assert.equal(t.reviewedCommit, null);
});

test("状态转移不改入参任务", () => {
  const t = inReview();
  const saved = JSON.stringify(t);
  const reviewed = apply(t, approve("abc", 0));
  const amended = apply(t, { kind: "Amend", by: "u1", computeResumable: true });
  assert.equal(JSON.stringify(t), saved);
  assert.equal(reviewed.ok && reviewed.task.state, "T7_Delivering");
  assert.equal(amended.ok && amended.task.constraintVer, 1);
});

// ---- 第四轮 ----
const deliveredBy = (reviewerModel: string) => must(applyAll(inReview(), [{ kind: "Review", reviewerId: "astra", reviewerModel, round: 1, commit: "abc", constraintVer: 0, verdict: "approve" }, { kind: "DeliveredCard", ...D1 }])).task;

test("R4-CORR-01 旧生产实例的换模记录在新实例回绑后迟到:仍计入累积集合,后续同厂商审查被拒", () => {
  const t = must(applyAll(respawned(), [up("cc-2"), { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" }])).task;
  assert.deepEqual(t.instances, ["cc-1", "cc-2"]);
  assert.deepEqual(t.producerModels, [PRODUCER, "gemini-4-argon", "gpt-6"]);
  const sub = must(apply(t, { kind: "SubmitForReview", commit: "v1", computeId: "cc-2", constraintVer: 1 })).task;
  const r = apply(sub, { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 2, commit: "v1", constraintVer: 1, verdict: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /openai/);
});

test("R4-CORR-01 从未回绑过的孤儿实例的换模记录不计入(阴性对照)", () => {
  const t = must(applyAll(respawned(), [up("cc-2"), up("cc-x", "t1#L9"), { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-x" }]));
  assert.deepEqual(t.task.producerModels, [PRODUCER, "gemini-4-argon"]);
  assert.deepEqual(t.effects, [{ kind: "stop-compute", computeId: "cc-x" }]);
});

test("R4-CORR-01 审查通过后迟到的生产记录让结论不再成立:作废审查,同一产物以新轮次重新送审", () => {
  for (const t of [deliveredBy("deepseek-v4"), must(apply(deliveredBy("deepseek-v4"), { kind: "UserAccept", by: "u1", ...D1 })).task]) {
    assert.equal(t.reviewGate, "compliant", t.state);
    const r = must(apply(t, { kind: "ProducerModelAdded", model: "deepseek-v4-coder", computeId: "cc-1" }));
    assert.equal(r.task.state, "T5_InReview", t.state);
    assert.equal(r.task.reviewGate, "none", t.state);
    assert.equal(r.task.badge, "none", t.state);
    assert.equal(r.task.reviewRound, 2, t.state);
    assert.deepEqual(r.effects, [{ kind: "request-review", round: 2, commit: "abc", constraintVer: 0 }], t.state);
    const again = apply(r.task, { kind: "Review", reviewerId: "astra", reviewerModel: "deepseek-v4", round: 2, commit: "abc", constraintVer: 0, verdict: "approve" });
    assert.equal(again.ok, false, t.state);
  }
});

test("R4-CORR-01 交付中迟到的生产记录不改变结论:并入集合,留在原状态,无副作用(阴性对照)", () => {
  const delivering = must(apply(inReview(), approve("abc", 0))).task;
  const r = must(apply(delivering, { kind: "ProducerModelAdded", model: "gemini-4-x", computeId: "cc-1" }));
  assert.equal(r.task.state, "T7_Delivering");
  assert.equal(r.task.reviewGate, "compliant");
  assert.deepEqual(r.task.producerModels, [PRODUCER, "gemini-4-x"]);
  assert.deepEqual(r.effects, []);
  assert.deepEqual(must(apply(r.task, { kind: "ProducerModelAdded", model: "gemini-4-x", computeId: "cc-1" })).task, r.task);
});

test("R4-CORR-01 迟到记录把合规变成同厂商、原审查有提出者豁免:改记 Waived,不重审", () => {
  const waived = must(applyAll(inReview(), [{ kind: "Review", reviewerId: "argon", reviewerModel: "gemini-4-argon", round: 1, commit: "abc", constraintVer: 0, verdict: "approve", waiverBy: "u1" }, { kind: "DeliveredCard", ...D1 }])).task;
  assert.equal(waived.reviewGate, "compliant");
  const r = must(apply(waived, { kind: "ProducerModelAdded", model: "gemini-4-pro", computeId: "cc-1" }));
  assert.equal(r.task.state, "T8a_Delivered");
  assert.equal(r.task.reviewGate, "waived-by-user");
  assert.deepEqual(r.effects, []);
});

test("R4-CORR-02 等当前确认卡时,旧执行器的提问与提审回包幂等忽略,不打断同批随后的有效回复", () => {
  const blocked = must(applyAll(respawned(), [up("cc-2"), { kind: "NeedHuman", qId: "q2", computeId: "cc-2", constraintVer: 1 }])).task;
  for (const stale of [
    { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 },
    { kind: "SubmitForReview", commit: "old", computeId: "cc-1", constraintVer: 0 },
    { kind: "NeedHuman", qId: "q1", computeId: "cc-2", constraintVer: 0 },
  ] as TaskEvent[]) {
    const r = must(applyAll(blocked, [stale, { kind: "HumanReply", qId: "q2", constraintVer: 1, answer: "approve" }]));
    assert.equal(r.task.state, "T3_Running", stale.kind);
    assert.equal(r.task.pendingQ, null, stale.kind);
  }
});

test("R4-CORR-02 当前实例当前版本的重复提问/提审在 T4b/T5/T7/T8a 仍被拒(阴性对照)", () => {
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  assert.equal(apply(blocked, { kind: "NeedHuman", qId: "q2", computeId: "cc-1", constraintVer: 0 }).ok, false);
  assert.equal(apply(blocked, { kind: "SubmitForReview", commit: "x", computeId: "cc-1", constraintVer: 0 }).ok, false);
  assert.equal(apply(inReview(), { kind: "NeedHuman", qId: "q", computeId: "cc-1", constraintVer: 0 }).ok, false);
  const delivering = must(apply(inReview(), approve("abc", 0))).task;
  for (const t of [delivering, delivered()]) {
    assert.equal(apply(t, { kind: "SubmitForReview", commit: "x", computeId: "cc-1", constraintVer: 0 }).ok, false, t.state);
    assert.equal(apply(t, { kind: "NeedHuman", qId: "q", computeId: "cc-1", constraintVer: 0 }).ok, false, t.state);
    assert.deepEqual(must(apply(t, { kind: "SubmitForReview", commit: "x", computeId: "old", constraintVer: 0 })).task, t, t.state);
  }
});

const claimed = () => must(apply(newTask("t1", "u1"), { kind: "Claim", by: "claude" }));

test("R4-CORR-03 认领即发出首派请求 L0;首派实例只凭这个请求号回绑", () => {
  const c = claimed();
  assert.equal(c.task.state, "T2_Claimed");
  assert.deepEqual(c.task.launch, { requestId: "t1#L0", constraintVer: 0 });
  assert.deepEqual(c.effects, [{ kind: "spawn-compute", withHandoff: false, requestId: "t1#L0", constraintVer: 0 }]);
  const bad = must(apply(c.task, { kind: "Dispatch", computeId: "x", model: PRODUCER, requestId: "t1#L5" }));
  assert.equal(bad.task.state, "T2_Claimed");
  assert.deepEqual(bad.effects, [{ kind: "stop-compute", computeId: "x" }]);
  const ok1 = must(apply(c.task, { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" }));
  assert.equal(ok1.task.state, "T3_Running");
  assert.equal(ok1.task.boundRequest, "t1#L0");
  assert.deepEqual(ok1.task.instances, ["cc-1"]);
});

test("R4-CORR-03 首派在途取消:进 T9 撤销 L0,晚到的首派实例被停止,确认停止后才终态", () => {
  const stopping = must(apply(claimed().task, { kind: "Cancel", by: "u1" }));
  assert.equal(stopping.task.state, "T9_StopRequested");
  assert.deepEqual(stopping.effects, [{ kind: "cancel-spawn", requestId: "t1#L0" }]);
  const late = must(apply(stopping.task, { kind: "Dispatch", computeId: "first-worker", model: PRODUCER, requestId: "t1#L0" }));
  assert.equal(late.task.state, "T9_StopRequested");
  assert.deepEqual(late.effects, [{ kind: "stop-compute", computeId: "first-worker" }]);
  assert.equal(must(apply(late.task, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L0" })).task.state, "T9_StopRequested");
  const done = must(apply(late.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "first-worker" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "first-worker" }]);
});

test("R4-CORR-03 首派在途取消、宿主确认撤销成功(实例从未上线):凭 L0 进终态;之后迟到上线的实例仍被停止", () => {
  const stopping = must(apply(claimed().task, { kind: "Cancel", by: "u1" })).task;
  const done = must(apply(stopping, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L0" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, []);
  const zombie = must(apply(done.task, { kind: "Dispatch", computeId: "first-worker", model: PRODUCER, requestId: "t1#L0" }));
  assert.equal(zombie.task.state, "T10_Cancelled");
  assert.deepEqual(zombie.effects, [{ kind: "stop-compute", computeId: "first-worker" }]);
});

test("R4-CORR-03 首派在途改条件:撤销 L0、按新版本重发首派(不带交接),只认新请求;在途首派失败也先停", () => {
  const r = must(apply(claimed().task, { kind: "Amend", by: "u1", computeResumable: true }));
  assert.equal(r.task.state, "T2_Claimed");
  assert.deepEqual(r.task.revoked, ["t1#L0"]);
  assert.deepEqual(r.effects, [{ kind: "cancel-spawn", requestId: "t1#L0" }, { kind: "spawn-compute", withHandoff: false, requestId: "t1#L1", constraintVer: 1 }]);
  const old = must(apply(r.task, { kind: "Dispatch", computeId: "w0", model: PRODUCER, requestId: "t1#L0" }));
  assert.deepEqual(old.effects, [{ kind: "stop-compute", computeId: "w0" }]);
  assert.equal(must(apply(old.task, { kind: "Dispatch", computeId: "w1", model: PRODUCER, requestId: "t1#L1" })).task.computeId, "w1");
  const failed = must(apply(claimed().task, { kind: "ExecFailed", requestId: "t1#L0" }));
  assert.equal(failed.task.state, "T9_StopRequested");
  assert.deepEqual(failed.effects, [{ kind: "cancel-spawn", requestId: "t1#L0" }]);
});

/** 运行中、有两个孤儿 o1/o2 的任务(由两次撤销重发产生)。 */
const twoOrphans = () => must(applyAll(respawned(), [
  { kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L3"), up("o1", L1), up("o2", "t1#L2"),
]));

test("R4-TEST-01 多个孤儿:每个都被停止并登记,确认一个只划掉它自己并释放它的槽位", () => {
  const r = twoOrphans();
  assert.deepEqual(r.task.orphans, ["o1", "o2"]);
  assert.deepEqual(r.task.revoked, []);
  assert.deepEqual(r.effects.filter((e) => e.kind === "stop-compute"), [{ kind: "stop-compute", computeId: "o1" }, { kind: "stop-compute", computeId: "o2" }]);
  const a = must(apply(r.task, { kind: "StoppedConfirmed", taskId: "t1", computeId: "o1" }));
  assert.deepEqual(a.task.orphans, ["o2"]);
  assert.deepEqual(a.effects, [{ kind: "release-slot", computeId: "o1" }]);
});

test("R4-TEST-01 多个旧启动:确认一个只划掉它自己,全部与当前启动都确认后才终态", () => {
  const stopping = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }, { kind: "Cancel", by: "u1" }])).task;
  assert.deepEqual(stopping.revoked, [L1, "t1#L2"]);
  const a = must(applyAll(stopping, [{ kind: "StoppedConfirmed", taskId: "t1", requestId: L1 }, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L3" }])).task;
  assert.equal(a.state, "T9_StopRequested");
  assert.deepEqual(a.revoked, ["t1#L2"]);
  assert.equal(must(apply(a, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L2" })).task.state, "T10_Cancelled");
});

test("R4-TEST-01 孤儿的停止确认在 T4b/T5/T7/T8a 都被消费并释放槽位", () => {
  const base = twoOrphans().task;
  const t4b = must(apply(base, { kind: "NeedHuman", qId: "q", computeId: "cc-new", constraintVer: 3 })).task;
  const t5 = must(apply(base, { kind: "SubmitForReview", commit: "z", computeId: "cc-new", constraintVer: 3 })).task;
  const t7 = must(apply(t5, approve("z", 3, 2))).task;
  const t8a = must(apply(t7, { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "z" })).task;
  for (const t of [t4b, t5, t7, t8a]) {
    const r = must(apply(t, { kind: "StoppedConfirmed", taskId: "t1", computeId: "o2" }));
    assert.equal(r.task.state, t.state, t.state);
    assert.deepEqual(r.task.orphans, ["o1"], t.state);
    assert.deepEqual(r.effects, [{ kind: "release-slot", computeId: "o2" }], t.state);
  }
});

test("R4-TEST-01 待确认集合是冻结快照;返工不丢掉尚未停止的孤儿", () => {
  const t = twoOrphans().task;
  assert.ok(Object.isFrozen(t.orphans));
  assert.ok(Object.isFrozen(t.revoked));
  assert.ok(Object.isFrozen(t.instances));
  assert.throws(() => { (t.orphans as string[]).length = 0; }, TypeError);
  assert.throws(() => { (t.revoked as string[]).push("x"); }, TypeError);
  const t5 = must(apply(t, { kind: "SubmitForReview", commit: "z", computeId: "cc-new", constraintVer: 3 })).task;
  for (const resumable of [true, false]) {
    const r = must(apply(t5, { kind: "Amend", by: "u1", computeResumable: resumable }));
    assert.deepEqual(r.task.orphans, ["o1", "o2"], String(resumable));
  }
});

test("R4-TEST-01 反复改条件:每次 update-constraints 都带当时的新版本", () => {
  let t = running();
  for (const v of [1, 2, 3, 4]) {
    const r = must(apply(t, { kind: "Amend", by: "u1", computeResumable: true }));
    assert.deepEqual(r.effects, [{ kind: "update-constraints", computeId: "cc-1", constraintVer: v }]);
    t = r.task;
  }
});

test("R4-CORR-03 首派撤销重发后,旧首派实例在 T2 上线被停止,它的停止确认在 T2 被消费并释放槽位", () => {
  const t = must(applyAll(claimed().task, [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Dispatch", computeId: "w0", model: PRODUCER, requestId: "t1#L0" }])).task;
  assert.equal(t.state, "T2_Claimed");
  assert.deepEqual(t.orphans, ["w0"]);
  const r = must(apply(t, { kind: "StoppedConfirmed", taskId: "t1", computeId: "w0" }));
  assert.equal(r.task.state, "T2_Claimed");
  assert.deepEqual(r.task.orphans, []);
  assert.deepEqual(r.effects, [{ kind: "release-slot", computeId: "w0" }]);
  const revokedAck = must(apply(must(apply(claimed().task, { kind: "Amend", by: "u1", computeResumable: true })).task, { kind: "StoppedConfirmed", taskId: "t1", requestId: "t1#L0" }));
  assert.deepEqual(revokedAck.task.revoked, []);
});

// ---- 第五轮 ----
/** v0 交付(代次 1,commit abc)后改条件,v1 重新提审 sha-v1 并交付(代次 2)。 */
const redelivered = () => must(applyAll(delivered(), [
  { kind: "Amend", by: "u1", computeResumable: true },
  { kind: "SubmitForReview", commit: "sha-v1", computeId: "cc-1", constraintVer: 1 },
  approve("sha-v1", 1, 2),
  { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "sha-v1" },
])).task;

test("R5-CORR-01 旧交付卡的接受、退回、超时作用不到新版本交付:幂等忽略", () => {
  const t = redelivered();
  assert.equal(t.state, "T8a_Delivered");
  assert.deepEqual(t.delivery, { round: 2, commit: "sha-v1" });
  for (const old of [
    { kind: "UserAccept", by: "u1", ...D1 },
    { kind: "UserReject", by: "u1", computeResumable: true, ...D1 },
    { kind: "AcceptTimeout", ...D1 },
    { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 2, commit: "abc" },
  ] as TaskEvent[]) {
    const r = must(apply(t, old));
    assert.deepEqual(r, { ok: true, task: t, effects: [] }, JSON.stringify(old));
  }
});

test("R5-CORR-01 当前交付代次的接受、退回正常生效(阴性对照),超时按用户定案 2273 拒绝;未发过的代次被拒", () => {
  const t = redelivered();
  const D2 = { taskId: "t1", deliveryRound: 2, commit: "sha-v1" };
  assert.equal(must(apply(t, { kind: "UserAccept", by: "u1", ...D2 })).task.state, "T8_Accepted");
  const to = apply(t, { kind: "AcceptTimeout", ...D2 });
  assert.ok(!to.ok && to.reason.includes("#2273"));
  const rj = must(apply(t, { kind: "UserReject", by: "u1", computeResumable: true, ...D2 }));
  assert.equal(rj.task.state, "T3_Running");
  assert.equal(rj.task.delivery, null);
  assert.equal(apply(t, { kind: "UserAccept", by: "argon", ...D2 }).ok, false);
  assert.equal(apply(t, { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 3, commit: "sha-v1" }).ok, false);
});

test("R5-CORR-01 旧代次的退回在已验收的新版本上也被忽略", () => {
  const D2 = { taskId: "t1", deliveryRound: 2, commit: "sha-v1" };
  for (const t of [must(apply(redelivered(), { kind: "UserAccept", by: "u1", ...D2 })).task]) {
    assert.deepEqual(must(apply(t, { kind: "UserReject", by: "u1", computeResumable: false, ...D1 })).task, t, t.state);
    assert.deepEqual(must(apply(t, { kind: "UserAccept", by: "u1", ...D1 })).task, t, t.state);
  }
});

test("R5-CORR-02 审查通过分配交付代次并请求发卡;上一轮的发送确认不能把新一轮标成已交付", () => {
  const t7 = must(applyAll(delivered(), [
    { kind: "Amend", by: "u1", computeResumable: true },
    { kind: "SubmitForReview", commit: "sha-v1", computeId: "cc-1", constraintVer: 1 },
  ]));
  const passed = must(apply(t7.task, approve("sha-v1", 1, 2)));
  assert.equal(passed.task.state, "T7_Delivering");
  assert.deepEqual(passed.effects, [{ kind: "send-card", taskId: "t1", deliveryRound: 2, commit: "sha-v1", constraintVer: 1 }]);
  const old = must(apply(passed.task, { kind: "DeliveredCard", ...D1 }));
  assert.equal(old.task.state, "T7_Delivering");
  assert.equal(must(apply(passed.task, { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "sha-v1" })).task.state, "T8a_Delivered");
  assert.equal(must(apply(delivered(), { kind: "DeliveredCard", ...D1 })).task.state, "T8a_Delivered");
});

test("R5-CORR-02 迟到生产记录触发重审后,同批的旧发送确认被忽略,重审结果与 request-review 不丢", () => {
  const t7 = must(applyAll(inReview(), [{ kind: "Review", reviewerId: "astra", reviewerModel: "deepseek-v4", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" }])).task;
  const r = must(applyAll(t7, [{ kind: "ProducerModelAdded", model: "deepseek-v4-coder", computeId: "cc-1" }, { kind: "DeliveredCard", ...D1 }]));
  assert.equal(r.task.state, "T5_InReview");
  assert.equal(r.task.delivery, null);
  assert.deepEqual(r.effects, [{ kind: "request-review", round: 2, commit: "abc", constraintVer: 0 }]);
  assert.equal(r.task.owner, "claude");
  assert.equal(r.task.approval, null);
});

test("R5-CORR-03 首派重发时,旧版本的提问/提审回包幂等忽略,同批随后的新请求实例正常上线", () => {
  const t = must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Amend", by: "u1", computeResumable: true }])).task;
  for (const stale of [
    { kind: "NeedHuman", qId: "q", computeId: "w0", constraintVer: 0 },
    { kind: "SubmitForReview", commit: "old", computeId: "w0", constraintVer: 0 },
  ] as TaskEvent[]) {
    const r = must(applyAll(t, [stale, { kind: "Dispatch", computeId: "w1", model: PRODUCER, requestId: "t1#L1" }]));
    assert.equal(r.task.state, "T3_Running", stale.kind);
    assert.equal(r.task.computeId, "w1", stale.kind);
  }
  assert.equal(apply(t, { kind: "NeedHuman", qId: "q", computeId: "w1", constraintVer: 1 }).ok, false);
});

test("R5-TEST-01 三次换实例后,最早实例的迟到换模记录仍计入,审前审后都生效", () => {
  const t = must(applyAll(respawned(), [up("cc-2"),
    { kind: "SubmitForReview", commit: "s2", computeId: "cc-2", constraintVer: 1 }, approve("s2", 1, 2), { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "s2" },
    { kind: "UserReject", taskId: "t1", by: "u1", computeResumable: false, deliveryRound: 2, commit: "s2" }, up("cc-3", "t1#L2")])).task;
  assert.deepEqual(t.instances, ["cc-1", "cc-2", "cc-3"]);
  assert.deepEqual(must(apply(t, { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc-1" })).task.producerModels, [PRODUCER, "gemini-4-argon", "gpt-6"]);
  const t7 = must(applyAll(t, [{ kind: "SubmitForReview", commit: "s3", computeId: "cc-3", constraintVer: 2 }, { kind: "Review", reviewerId: "x", reviewerModel: "deepseek-v4", round: 3, commit: "s3", constraintVer: 2, verdict: "approve" }])).task;
  assert.equal(must(apply(t7, { kind: "ProducerModelAdded", model: "deepseek-r2", computeId: "cc-1" })).task.state, "T5_InReview");
});

test("R5-TEST-01 审后迟到的 unknown 厂商生产记录也触发重审", () => {
  const t7 = must(apply(inReview(), approve("abc", 0))).task;
  const r = must(apply(t7, { kind: "ProducerModelAdded", model: "stealth/crouton-alpha", computeId: "cc-1" }));
  assert.equal(r.task.state, "T5_InReview");
  assert.equal(r.task.reviewGate, "none");
});

test("R5-TEST-01 审查批准与交付是冻结快照,不沿用调用方的可变对象", () => {
  const t7 = must(apply(inReview(), approve("abc", 0))).task;
  assert.ok(Object.isFrozen(t7.approval));
  assert.ok(Object.isFrozen(t7.delivery));
  const forgedA = { reviewerModel: "gpt-6-astra", waiverBy: null };
  const forgedD = { round: 1, commit: "abc" };
  const next = must(apply({ ...t7, approval: forgedA, delivery: forgedD }, { kind: "ProducerModelAdded", model: "gemini-4-x", computeId: "cc-1" })).task;
  assert.notEqual(next.approval, forgedA);
  assert.notEqual(next.delivery, forgedD);
  forgedA.reviewerModel = "claude-opus-5-5";
  assert.equal(next.approval?.reviewerModel, "gpt-6-astra");
});

test("R5-TEST-01 T1 改条件后再认领:首派请求绑定当时的新版本", () => {
  const r = must(applyAll(newTask("t1", "u1"), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Amend", by: "u1", computeResumable: true }, { kind: "Claim", by: "claude" }]));
  assert.deepEqual(r.task.launch, { requestId: "t1#L0", constraintVer: 2 });
  assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: false, requestId: "t1#L0", constraintVer: 2 }]);
});

test("R5-TEST-01 当前实例报来的非当前(未来)版本提问在 T4b 被忽略,不挡后续有效回复", () => {
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  const r = must(applyAll(blocked, [{ kind: "NeedHuman", qId: "q9", computeId: "cc-1", constraintVer: 5 }, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }]));
  assert.equal(r.task.state, "T3_Running");
});

// ---- 第六轮 ----
const SC = (x: { computeId?: string; requestId?: string }): TaskEvent => ({ kind: "StoppedConfirmed", taskId: "t1", ...x });

test("R6-CORR-01 T2 已确认停止的孤儿:迟到的当前版本提问/提审仍被忽略,同批随后的首派实例正常上线", () => {
  const t = must(applyAll(claimed().task, [{ kind: "Dispatch", computeId: "stopped-orphan", model: PRODUCER, requestId: "t1#L9" }, SC({ computeId: "stopped-orphan" })])).task;
  assert.deepEqual(t.orphans, []);
  assert.deepEqual(t.retired, ["stopped-orphan"]);
  for (const stale of [
    { kind: "NeedHuman", qId: "q", computeId: "stopped-orphan", constraintVer: 0 },
    { kind: "SubmitForReview", commit: "x", computeId: "stopped-orphan", constraintVer: 0 },
  ] as TaskEvent[]) {
    const r = must(applyAll(t, [stale, { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" }]));
    assert.equal(r.task.state, "T3_Running", stale.kind);
    assert.equal(r.task.computeId, "cc-1", stale.kind);
  }
});

test("R6-CORR-01 T3 新启动在途时,已确认停止的孤儿迟到回包不阻断新实例回绑", () => {
  const t = must(applyAll(respawned(), [up("zombie", "t1#L9"), SC({ computeId: "zombie" })])).task;
  const r = must(applyAll(t, [{ kind: "NeedHuman", qId: "q", computeId: "zombie", constraintVer: 1 }, up("cc-2")]));
  assert.equal(r.task.computeId, "cc-2");
});

test("R6-CORR-01 同一孤儿重复上线与重复确认:T2 与 T9 都只释放一次槽位", () => {
  const up9 = { kind: "Dispatch", computeId: "dup", model: PRODUCER, requestId: "t1#L9" } as TaskEvent;
  for (const start of [claimed().task, must(apply(claimed().task, { kind: "Cancel", by: "u1" })).task]) {
    const r = must(applyAll(start, [up9, SC({ computeId: "dup" }), up9, SC({ computeId: "dup" })]));
    assert.equal(r.effects.filter((e) => e.kind === "release-slot").length, 1, start.state);
    assert.deepEqual(r.effects.filter((e) => e.kind === "stop-compute"), [{ kind: "stop-compute", computeId: "dup" }, { kind: "stop-compute", computeId: "dup" }], start.state);
    assert.deepEqual(r.task.orphans, [], start.state);
  }
});

test("R6-CORR-01 当前实例确认停止后被记为已退役,它的重放上线与确认在 T9 不再二次释放", () => {
  const t = must(applyAll(respawned(), [up("cc-2"), up("o1", "t1#L9"), { kind: "Cancel", by: "u1" }, SC({ computeId: "cc-2" })])).task;
  assert.equal(t.state, "T9_StopRequested");
  assert.deepEqual(t.retired, ["cc-2"]);
  const r = must(applyAll(t, [up("cc-2"), SC({ computeId: "cc-2" }), SC({ computeId: "o1" })]));
  assert.equal(r.task.state, "T10_Cancelled");
  assert.deepEqual(r.effects.filter((e) => e.kind === "release-slot"), [{ kind: "release-slot", computeId: "o1" }]);
});

test("R6-CORR-01 退役之后另一个不同的孤儿仍被登记、停止并释放一次(阴性对照)", () => {
  const t = must(applyAll(claimed().task, [{ kind: "Dispatch", computeId: "a", model: PRODUCER, requestId: "t1#L9" }, SC({ computeId: "a" })])).task;
  const r = must(applyAll(t, [{ kind: "Dispatch", computeId: "b", model: PRODUCER, requestId: "t1#L8" }, SC({ computeId: "b" })]));
  assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "b" }, { kind: "release-slot", computeId: "b" }]);
  assert.deepEqual(r.task.retired, ["a", "b"]);
});

test("R6-CORR-02 交付代次为 0、负数、小数、非有限值时按非法拒绝;已分配的旧代次仍幂等忽略", () => {
  const t = delivered();
  for (const round of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = apply(t, { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: round, commit: "abc" });
    assert.equal(r.ok, false, String(round));
    assert.match(!r.ok ? r.reason : "", /正整数/, String(round));
  }
  assert.equal(apply(t, { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 2, commit: "abc" }).ok, false);
  assert.equal(must(apply(t, { kind: "UserAccept", by: "u1", ...D1 })).task.state, "T8_Accepted");
  const re = redelivered();
  assert.deepEqual(must(apply(re, { kind: "UserAccept", by: "u1", ...D1 })).task, re);
});

test("R6 跨任务:别的任务的验收、退回、发送确认、停止确认投到本任务都被拒,不改状态", () => {
  const t = delivered();
  for (const ev of [
    { kind: "UserAccept", taskId: "B", by: "u1", deliveryRound: 1, commit: "abc" },
    { kind: "UserReject", taskId: "B", by: "u1", computeResumable: true, deliveryRound: 1, commit: "abc" },
    { kind: "AcceptTimeout", taskId: "B", deliveryRound: 1, commit: "abc" },
    { kind: "DeliveredCard", taskId: "B", deliveryRound: 1, commit: "abc" },
  ] as TaskEvent[]) {
    const r = apply(t, ev);
    assert.equal(r.ok, false, ev.kind);
    assert.match(!r.ok ? r.reason : "", /任务 B/, ev.kind);
  }
  const stopping = must(apply(running(), { kind: "Cancel", by: "u1" })).task;
  assert.equal(apply(stopping, { kind: "StoppedConfirmed", taskId: "B", computeId: "cc-1" }).ok, false);
  assert.equal(must(apply(stopping, SC({ computeId: "cc-1" }))).task.state, "T10_Cancelled");
});

test("R6-TEST-01 首派重发时已登记(未确认)孤儿的当前版本回包也被忽略,不挡新请求上线", () => {
  const t = must(applyAll(claimed().task, [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Dispatch", computeId: "w0", model: PRODUCER, requestId: "t1#L0" }])).task;
  assert.deepEqual(t.orphans, ["w0"]);
  const r = must(applyAll(t, [{ kind: "NeedHuman", qId: "q", computeId: "w0", constraintVer: 1 }, { kind: "Dispatch", computeId: "w1", model: PRODUCER, requestId: "t1#L1" }]));
  assert.equal(r.task.computeId, "w1");
});

const D2s = { taskId: "t1", deliveryRound: 2, commit: "s2" } as const;
/** 交付两次后再次不可恢复返工,回绑 cc-3 并提审 s3(第三次交付前)。 */
const toThird = () => must(applyAll(respawned(), [up("cc-2"),
  { kind: "SubmitForReview", commit: "s2", computeId: "cc-2", constraintVer: 1 }, approve("s2", 1, 2), { kind: "DeliveredCard", ...D2s },
  { kind: "UserReject", by: "u1", computeResumable: false, ...D2s }, up("cc-3", "t1#L2"),
  { kind: "SubmitForReview", commit: "s3", computeId: "cc-3", constraintVer: 2 }])).task;

test("R6-TEST-01 第三次交付:send-card 带第 3 代次、当时 commit 与条件版本;最早代次的迟到回包不挡当前确认", () => {
  const passed = must(apply(toThird(), approve("s3", 2, 3)));
  assert.deepEqual(passed.effects, [{ kind: "send-card", taskId: "t1", deliveryRound: 3, commit: "s3", constraintVer: 2 }]);
  const D3 = { taskId: "t1", deliveryRound: 3, commit: "s3" } as const;
  const r = must(applyAll(passed.task, [{ kind: "DeliveredCard", ...D3 }, { kind: "UserAccept", by: "u1", ...D1 }, { kind: "UserReject", by: "u1", computeResumable: true, ...D2s }, { kind: "UserAccept", by: "u1", ...D3 }]));
  assert.equal(r.task.state, "T8_Accepted");
});

test("R6-TEST-01 三个历史实例后再次新开:最早实例的当前版本提审被忽略,新实例同批上线", () => {
  const t = must(applyAll(toThird(), [approve("s3", 2, 3), { kind: "DeliveredCard", taskId: "t1", deliveryRound: 3, commit: "s3" },
    { kind: "UserReject", by: "u1", computeResumable: false, taskId: "t1", deliveryRound: 3, commit: "s3" }])).task;
  assert.deepEqual(t.instances, ["cc-1", "cc-2", "cc-3"]);
  const r = must(applyAll(t, [{ kind: "SubmitForReview", commit: "old", computeId: "cc-1", constraintVer: 3 }, up("cc-4", "t1#L3")]));
  assert.equal(r.task.computeId, "cc-4");
});

test("R6-TEST-01 已验收后退回再交付同一 commit:交付代次不归零,旧代次点击不会验收新版本", () => {
  const accepted = must(apply(delivered(), { kind: "UserAccept", by: "u1", ...D1 })).task;
  const t = must(applyAll(accepted, [{ kind: "UserReject", by: "u1", computeResumable: true, ...D1 },
    { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 1 }, approve("abc", 1, 2)])).task;
  assert.deepEqual(t.delivery, { round: 2, commit: "abc" });
  const r = must(applyAll(t, [{ kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "abc" }, { kind: "UserAccept", by: "u1", ...D1 }]));
  assert.equal(r.task.state, "T8a_Delivered");
});

test("R6-TEST-01 当前代次号但 commit 不符的退回被当作旧回包忽略,不打断同批当前确认", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", taskId: "t1", by: "u1", computeResumable: true, deliveryRound: 1, commit: "other" }, { kind: "UserAccept", by: "u1", ...D1 }]));
  assert.equal(r.task.state, "T8_Accepted");
});

// ---- 第七轮 ----
// 独立于实现的事件形状期望:每种事件的必填字段与取值域(s=非空字符串,n=非负整数,p=正整数,b=布尔,数组=枚举)。
type Dom = "s" | "n" | "p" | "b" | readonly string[];
const SHAPES: { [K in EventKind]: { req: Record<string, Dom>; opt?: Record<string, Dom> } } = {
  Claim: { req: { by: "s" } },
  Dispatch: { req: { computeId: "s", model: "s", requestId: "s" } },
  ProducerModelAdded: { req: { model: "s", computeId: "s" } },
  NeedHuman: { req: { qId: "s", computeId: "s", constraintVer: "n" } },
  HumanReply: { req: { qId: "s", constraintVer: "n", answer: ["approve", "reject"] } },
  Amend: { req: { by: "s", computeResumable: "b" } },
  SubmitForReview: { req: { commit: "s", computeId: "s", constraintVer: "n" } },
  Review: { req: { reviewerId: "s", reviewerModel: "s", round: "p", commit: "s", constraintVer: "n", verdict: ["approve", "reject"] }, opt: { waiverBy: "s" } },
  DeliveredCard: { req: { taskId: "s", deliveryRound: "p", commit: "s" } },
  UserAccept: { req: { taskId: "s", by: "s", deliveryRound: "p", commit: "s" } },
  UserReject: { req: { taskId: "s", by: "s", computeResumable: "b", deliveryRound: "p", commit: "s" } },
  AcceptTimeout: { req: { taskId: "s", deliveryRound: "p", commit: "s" } },
  Cancel: { req: { by: "s" } },
  StoppedConfirmed: { req: { taskId: "s" }, opt: { computeId: "s", requestId: "s" } },
  ExecFailed: { req: {}, opt: { computeId: "s", requestId: "s" } },
};
/** 每种取值域的非法值:缺失、null、错类型、越界。 */
const BAD: Record<"s" | "n" | "p" | "b" | "enum", unknown[]> = {
  s: [undefined, null, 1, true, "", ["x"], {}],
  n: [undefined, null, "1", true, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2],
  p: [undefined, null, "1", true, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY],
  b: [undefined, null, 0, 1, "true"],
  enum: [undefined, null, 1, "", "maybe"],
};
const badOf = (d: Dom) => (typeof d === "string" ? BAD[d] : BAD.enum);
const raw = (e: TaskEvent, patch: Record<string, unknown>): TaskEvent => {
  const o: Record<string, unknown> = { ...e, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete o[k];
  return o as unknown as TaskEvent;
};

test("R7-TEST-01 形状校验:每种事件的合法样例通过", () => {
  for (const k of EVENT_KINDS) assert.equal(validateEvent(SAMPLE[k]), null, k);
  assert.equal(validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: 1, commit: "c", constraintVer: 0, verdict: "reject", computeResumable: false }), null);
  assert.equal(validateEvent({ kind: "ExecFailed" }), null);
  assert.equal(validateEvent({ kind: "StoppedConfirmed", taskId: "t" }), null);
});

test("R7-TEST-01 形状校验:每种事件 × 每个必填字段 × 缺失/null/错类型/越界都被拒,并点名字段", () => {
  for (const k of EVENT_KINDS) for (const [f, d] of Object.entries(SHAPES[k].req)) for (const v of badOf(d)) {
    const why = validateEvent(raw(SAMPLE[k], { [f]: v }));
    assert.ok(why?.includes(`${k}.${f}`), `${k}.${f}=${String(v)} 应被拒,实际 ${why}`);
  }
});

test("R7-TEST-01 形状校验:可选字段可以省略,出现时取值非法也被拒;reject 审查必须带 computeResumable", () => {
  for (const k of EVENT_KINDS) for (const [f, d] of Object.entries(SHAPES[k].opt ?? {})) {
    assert.equal(validateEvent(raw(SAMPLE[k], { [f]: undefined })), null, `${k}.${f} 省略`);
    for (const v of badOf(d).filter((x) => x !== undefined)) assert.ok(validateEvent(raw(SAMPLE[k], { [f]: v })) !== null, `${k}.${f}=${String(v)}`);
  }
  assert.ok(validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: 1, commit: "c", constraintVer: 0, verdict: "reject" }) !== null);
  for (const bad of [null, 1, "x", [], { kind: "Nope" }, { by: "u" }]) assert.ok(validateEvent(bad) !== null, JSON.stringify(bad));
});

test("R7-TEST-01 形状非法的事件经 apply 被拒,任务不变也不发副作用(每种事件各一例)", () => {
  for (const s of STATES) for (const k of EVENT_KINDS) {
    const [f, d] = Object.entries(SHAPES[k].req)[0] ?? ["computeId", "s" as Dom];
    const r = apply(inState(s), raw(SAMPLE[k], { [f]: badOf(d)[2] }));
    assert.equal(r.ok, false, `${s} × ${k}.${f}`);
  }
});

const STOPPING = () => must(apply(running(), { kind: "Cancel", by: "u1" })).task;

test("R7-CORR-01 五类必带 taskId 的事件:缺失/null/错类型/空串/别的任务都被拒,任务不变", () => {
  const cases: [Task, TaskEvent][] = [
    [delivered(), { kind: "UserAccept", by: "u1", ...D1 }],
    [delivered(), { kind: "UserReject", by: "u1", computeResumable: true, ...D1 }],
    [must(apply(inReview(), approve("abc", 0))).task, { kind: "DeliveredCard", ...D1 }],
    [STOPPING(), { kind: "StoppedConfirmed", taskId: "t1", computeId: "cc-1" }],
  ];
  for (const [t, ev] of cases) {
    assert.ok(must(apply(t, ev)).task !== t, `${ev.kind} 当前任务正例应生效`);
    for (const v of [undefined, null, 7, "", "B"]) {
      const r = apply(t, raw(ev, { taskId: v }));
      assert.equal(r.ok, false, `${ev.kind} taskId=${String(v)}`);
    }
  }
});

test("R7-CORR-01 AcceptTimeout 的 taskId:正确时到状态表按用户定案 2273 拒绝,缺失/错误时在入口就被拒", () => {
  const t = delivered();
  const ev: TaskEvent = { kind: "AcceptTimeout", ...D1 };
  const good = apply(t, ev);
  assert.ok(!good.ok && good.reason.includes("#2273"));
  for (const v of [undefined, null, 7, "", "B"]) {
    const r = apply(t, raw(ev, { taskId: v }));
    assert.ok(!r.ok && !r.reason.includes("#2273"), `taskId=${String(v)}`);
  }
});

test("R7-CORR-01 缺 taskId 的 JSON 输入(经 JSON.parse)不能验收或终结本任务", () => {
  const t = delivered();
  const json = JSON.parse(JSON.stringify({ kind: "UserAccept", by: "u1", deliveryRound: 1, commit: "abc" })) as TaskEvent;
  assert.equal(apply(t, json).ok, false);
  const stopJson = JSON.parse(JSON.stringify({ kind: "StoppedConfirmed", computeId: "cc-1" })) as TaskEvent;
  const stopping = STOPPING();
  assert.equal(apply(stopping, stopJson).ok, false);
  assert.equal(apply(stopping, stopJson).ok || stopping.state, "T9_StopRequested");
});

test("R7-CORR-02 未分配的未来代次在 T7/T8a/T8_Accepted 的四类交付事件都被拒;已分配旧代次仍忽略", () => {
  const D2 = { taskId: "t1", deliveryRound: 2, commit: "abc" } as const;
  const t7 = must(apply(inReview(), approve("abc", 0))).task;
  const t8a = delivered();
  const acc = must(apply(t8a, { kind: "UserAccept", by: "u1", ...D1 })).task;
  for (const t of [t7, t8a, acc]) for (const ev of [
    { kind: "DeliveredCard", ...D2 }, { kind: "UserAccept", by: "u1", ...D2 },
    { kind: "UserReject", by: "u1", computeResumable: true, ...D2 }, { kind: "AcceptTimeout", ...D2 },
  ] as TaskEvent[]) {
    const r = apply(t, ev);
    assert.ok(!r.ok && /未分配/.test(r.reason), `${t.state} × ${ev.kind}`);
  }
  const re = redelivered();
  for (const ev of [{ kind: "DeliveredCard", ...D1 }, { kind: "UserAccept", by: "u1", ...D1 }, { kind: "AcceptTimeout", ...D1 }] as TaskEvent[]) {
    assert.deepEqual(must(apply(re, ev)).task, re, ev.kind);
  }
});

test("R7-TEST-01 错任务 ID 的交付事件在 T7/T8a/T8_Accepted 全被拒;错任务停止确认在取消与失败停止中都被拒", () => {
  const B = { taskId: "B", deliveryRound: 1, commit: "abc" } as const;
  const t8a = delivered();
  const states = [must(apply(inReview(), approve("abc", 0))).task, t8a, must(apply(t8a, { kind: "UserAccept", by: "u1", ...D1 })).task];
  for (const t of states) for (const ev of [
    { kind: "DeliveredCard", ...B }, { kind: "UserAccept", by: "u1", ...B },
    { kind: "UserReject", by: "u1", computeResumable: true, ...B }, { kind: "AcceptTimeout", ...B },
  ] as TaskEvent[]) assert.equal(apply(t, ev).ok, false, `${t.state} × ${ev.kind}`);
  for (const t of [STOPPING(), must(apply(running(), { kind: "ExecFailed", computeId: "cc-1" })).task]) {
    assert.equal(t.state, "T9_StopRequested");
    assert.equal(apply(t, { kind: "StoppedConfirmed", taskId: "B", computeId: "cc-1" }).ok, false, t.stopReason ?? "");
    assert.equal(must(apply(t, SC({ computeId: "cc-1" }))).task.state, t.stopReason === "fail" ? "T11_Failed" : "T10_Cancelled");
  }
});

const upT2 = (id: string, req: string): TaskEvent => ({ kind: "Dispatch", computeId: id, model: PRODUCER, requestId: req });
/** T2 里依次登记并确认停止三个孤儿 a/b/c。 */
const threeRetired = () => must(applyAll(claimed().task, [upT2("a", "t1#L7"), SC({ computeId: "a" }), upT2("b", "t1#L8"), SC({ computeId: "b" }), upT2("c", "t1#L9"), SC({ computeId: "c" })])).task;

test("R7-TEST-01 退役账本:三个孤儿全部保留且冻结,最早的重放上线与确认都不再释放槽位", () => {
  const t = threeRetired();
  assert.deepEqual(t.retired, ["a", "b", "c"]);
  assert.ok(Object.isFrozen(t.retired));
  assert.throws(() => { (t.retired as string[]).length = 0; }, TypeError);
  const r = must(applyAll(t, [upT2("a", "t1#L7"), SC({ computeId: "a" })]));
  assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "a" }]);
  assert.deepEqual(r.task.retired, ["a", "b", "c"]);
});

test("R7-TEST-01 未回绑时最早退役实例的迟到回包被忽略,首派实例同批上线", () => {
  const r = must(applyAll(threeRetired(), [{ kind: "NeedHuman", qId: "q", computeId: "a", constraintVer: 0 }, upT2("cc-1", "t1#L0")]));
  assert.equal(r.task.computeId, "cc-1");
});

test("R7-TEST-01 当前实例停止时追加进退役账本,不覆盖更早的退役记录", () => {
  const t = must(applyAll(threeRetired(), [upT2("cc-1", "t1#L0"), { kind: "Cancel", by: "u1" }, SC({ computeId: "cc-1" })])).task;
  assert.equal(t.state, "T10_Cancelled");
  assert.deepEqual(t.retired, ["a", "b", "c", "cc-1"]);
  const r = must(applyAll(t, [upT2("a", "t1#L7"), SC({ computeId: "a" })]));
  assert.equal(r.effects.filter((e) => e.kind === "release-slot").length, 0);
});

test("R7-TEST-01 有另一个活动实例时,退役实例重放上线只停它自己,不停当前实例", () => {
  const t = must(applyAll(threeRetired(), [upT2("cc-1", "t1#L0")])).task;
  const r = must(apply(t, upT2("b", "t1#L8")));
  assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "b" }]);
  assert.equal(r.task.computeId, "cc-1");
});

// ---- 第八轮 ----
const PROTO_KINDS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__"];

test("R8-CORR-01 标准 JSON 的异常 kind:validateEvent、apply、applyAll 都返回拒绝,绝不抛异常", () => {
  const t = newTask("t1", "u1");
  for (const j of ['{"kind":{"toString":null}}', '{"kind":{"toString":{},"valueOf":{}}}', '{"kind":[{"toString":null}]}', '{"kind":{}}', '{"kind":null}', '{"kind":7}', '{"kind":true}', '{}', '{"__proto__":{"kind":"Cancel","by":"u1"}}']) {
    const e = JSON.parse(j) as TaskEvent;
    assert.equal(validateEvent(e), "事件种类缺失或不是字符串", j);
    const r = apply(t, e);
    assert.ok(!r.ok && r.reason === "事件种类缺失或不是字符串", j);
    assert.equal(applyAll(t, [e]).ok, false, j);
  }
});

test("R8-CORR-01 原型链上的名字作为 kind 一律按未知种类拒绝,并在原因里原样点名", () => {
  for (const k of PROTO_KINDS) {
    const e = JSON.parse(JSON.stringify({ kind: k, by: "u1" })) as TaskEvent;
    assert.equal(validateEvent(e), `未知的事件种类 ${JSON.stringify(k)}`, k);
    assert.equal(apply(newTask("t1", "u1"), e).ok, false, k);
  }
  assert.equal(validateEvent({ kind: "Nope" }), '未知的事件种类 "Nope"');
  assert.equal(validateEvent({ kind: "" }), '未知的事件种类 ""');
});

test("R8-CORR-01 字段读取只认自有属性:原型上继承来的同名字段不算数", () => {
  assert.equal(polluted("by", "u1", () => validateEvent({ kind: "Claim" })), "Claim.by 缺失或取值非法(应为非空字符串)");
  const evil = { kind: "Claim", get by(): string { throw new Error("boom"); } };
  assert.equal(validateEvent(evil), "只接受普通数据对象(含访问器属性 by)");
  assert.equal(apply(newTask("t1", "u1"), evil as unknown as TaskEvent).ok, false);
});

test("R8-TEST-01 取值域边界正反对照:非负整数、正整数、安全整数上界", () => {
  const nh = (v: unknown) => validateEvent({ kind: "NeedHuman", qId: "q", computeId: "c", constraintVer: v });
  assert.equal(nh(0), null);
  assert.equal(nh(Number.MAX_SAFE_INTEGER), null);
  assert.equal(nh(-1), "NeedHuman.constraintVer 缺失或取值非法(应为非负整数)");
  assert.equal(nh(Number.MAX_SAFE_INTEGER + 1), "NeedHuman.constraintVer 缺失或取值非法(应为非负整数)");
  assert.equal(nh(2 ** 60), "NeedHuman.constraintVer 缺失或取值非法(应为非负整数)");
  const rv = (v: unknown) => validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: v, commit: "c", constraintVer: 0, verdict: "approve" });
  assert.equal(rv(1), null);
  assert.equal(rv(Number.MAX_SAFE_INTEGER), null);
  assert.equal(rv(0), "Review.round 缺失或取值非法(应为正整数)");
  assert.equal(rv(Number.MAX_SAFE_INTEGER + 1), "Review.round 缺失或取值非法(应为正整数)");
  assert.equal(rv(2 ** 60), "Review.round 缺失或取值非法(应为正整数)");
});

test("R8-TEST-01 字符串边界:非 ASCII 合法,空串与全空白拒绝;多余字段不拒绝", () => {
  const c = (by: unknown) => validateEvent({ kind: "Claim", by });
  for (const ok1 of ["联系人小旅", "a", " x ", "é"]) assert.equal(c(ok1), null, ok1);
  for (const bad of ["", " ", "\t\n", "　"]) assert.equal(c(bad), "Claim.by 缺失或取值非法(应为非空字符串)", JSON.stringify(bad));
  assert.equal(validateEvent({ kind: "Claim", by: "u", extra: 1, note: { x: 1 } }), null);
  assert.equal(must(apply(newTask("t1", "u1"), { kind: "Claim", by: "联系人小旅" })).task.owner, "联系人小旅");
});

test("R8-TEST-01 布尔边界:true/false 合法;数组、对象、字符串、数字一律拒绝,并点名字段", () => {
  const am = (v: unknown) => validateEvent({ kind: "Amend", by: "u1", computeResumable: v });
  assert.equal(am(true), null);
  assert.equal(am(false), null);
  for (const bad of [[], [true], {}, "false", "true", 0, 1, null]) assert.equal(am(bad), "Amend.computeResumable 缺失或取值非法(应为布尔)", JSON.stringify(bad));
  const urj = (v: unknown) => ({ kind: "UserReject", by: "u1", computeResumable: v, ...D1 }) as unknown as TaskEvent;
  for (const bad of ["false", [], 1]) {
    const r = apply(delivered(), urj(bad));
    assert.ok(!r.ok && r.reason === "UserReject.computeResumable 缺失或取值非法(应为布尔)", JSON.stringify(bad));
  }
});

test("R8-TEST-01 枚举边界:只认表内原样取值,大小写变体和表外值都拒绝", () => {
  const hr = (v: unknown) => validateEvent({ kind: "HumanReply", qId: "q", constraintVer: 0, answer: v });
  assert.equal(hr("approve"), null);
  assert.equal(hr("reject"), null);
  for (const bad of ["yes", "no", "APPROVE", "Approve", "approve ", "", 1]) assert.equal(hr(bad), "HumanReply.answer 缺失或取值非法(应为approve/reject)", JSON.stringify(bad));
  const blocked = must(apply(running(), { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 0 })).task;
  const r = apply(blocked, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "REJECT" } as unknown as TaskEvent);
  assert.equal(r.ok, false);
  const rv = (v: unknown) => validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: 1, commit: "c", constraintVer: 0, verdict: v, computeResumable: true });
  for (const bad of ["yes", "Approve", "REJECT"]) assert.equal(rv(bad), "Review.verdict 缺失或取值非法(应为approve/reject)", bad);
});

test("R8-TEST-01 审查打回的 computeResumable:每种非法类型都拒绝,经 apply 也不发恢复副作用", () => {
  const base = { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "reject" };
  assert.equal(validateEvent({ ...base, computeResumable: false }), null);
  for (const bad of [undefined, null, "false", "true", 0, 1, [], {}]) {
    const e = { ...base, computeResumable: bad } as unknown as TaskEvent;
    assert.equal(validateEvent(e), "Review.computeResumable 缺失或取值非法(应为布尔)", JSON.stringify(bad));
    assert.equal(apply(inReview(), e).ok, false, JSON.stringify(bad));
  }
});

test("R8-TEST-01 非对象与非字符串 kind 的拒绝原因精确", () => {
  for (const bad of [null, undefined, 1, "Claim", [], [{ kind: "Claim", by: "u" }]]) assert.equal(validateEvent(bad), "事件不是对象", String(bad));
  for (const k of [1, 0, true, null, {}, []]) assert.equal(validateEvent({ kind: k, by: "u" }), "事件种类缺失或不是字符串", JSON.stringify(k));
});

// ---- 第九轮 ----
/** 自定义原型的事件:领域层只接受普通数据对象,这类输入整体拒绝。 */
const withProto = (own: Record<string, unknown>, inherited: Record<string, unknown>): TaskEvent => Object.assign(Object.create(inherited), own) as TaskEvent;
/** 在 Object.prototype 上临时放一个同名字段(模拟原型污染),让普通对象"继承"它;fn 结束后一定删掉。 */
const polluted = <T>(key: string, value: unknown, fn: () => T): T => {
  Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false });
  try { return fn(); } finally { delete (Object.prototype as Record<string, unknown>)[key]; }
};
const PLAIN_ONLY = "只接受普通数据对象";

test("R9-CORR-01 ExecFailed 的 computeId 只从原型继承:不停当前实例;省略同样不停;自有才停", () => {
  const t = running();
  const inh = polluted("computeId", "cc-1", () => must(apply(t, { kind: "ExecFailed" })));
  assert.equal(inh.task.state, "T3_Running");
  assert.deepEqual(inh.effects, []);
  const batch = polluted("computeId", "cc-1", () => must(applyAll(t, [{ kind: "ExecFailed" }, { kind: "NeedHuman", qId: "q", computeId: "cc-1", constraintVer: 0 }])));
  assert.equal(batch.task.state, "T4b_BlockedOnHuman");
  assert.deepEqual(batch.effects, []);
  const omit = must(apply(t, { kind: "ExecFailed" }));
  assert.equal(omit.task.state, "T3_Running");
  assert.deepEqual(omit.effects, []);
  const own = must(apply(t, { kind: "ExecFailed", computeId: "cc-1" }));
  assert.equal(own.task.state, "T9_StopRequested");
  assert.deepEqual(own.effects, [{ kind: "stop-compute", computeId: "cc-1" }]);
  const custom = apply(t, withProto({ kind: "ExecFailed" }, { computeId: "cc-1" }));
  assert.ok(!custom.ok && custom.reason === PLAIN_ONLY);
});

test("R9-CORR-01 StoppedConfirmed 的 computeId 只从原型继承:不确认停止、不释放;省略同样;自有才确认", () => {
  const t = STOPPING();
  const inh = polluted("computeId", "cc-1", () => must(apply(t, { kind: "StoppedConfirmed", taskId: "t1" })));
  assert.equal(inh.task.state, "T9_StopRequested");
  assert.deepEqual(inh.effects, []);
  const omit = must(apply(t, { kind: "StoppedConfirmed", taskId: "t1" }));
  assert.equal(omit.task.state, "T9_StopRequested");
  assert.deepEqual(omit.effects, []);
  const own = must(apply(t, SC({ computeId: "cc-1" })));
  assert.equal(own.task.state, "T10_Cancelled");
  assert.deepEqual(own.effects, [{ kind: "release-slot", computeId: "cc-1" }]);
  const custom = apply(t, withProto({ kind: "StoppedConfirmed", taskId: "t1" }, { computeId: "cc-1" }));
  assert.ok(!custom.ok && custom.reason === PLAIN_ONLY);
});

test("R9-CORR-01 同厂商审查的 waiverBy 只从原型继承:不算豁免,照样拒绝;自有提出者豁免才记 Waived", () => {
  const base = { kind: "Review", reviewerId: "argon", reviewerModel: "claude-sonnet-5-5", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" };
  const inh = polluted("waiverBy", "u1", () => apply(inReview(), { ...base } as TaskEvent));
  assert.ok(!inh.ok && /豁免/.test(inh.reason));
  const omit = apply(inReview(), base as TaskEvent);
  assert.ok(!omit.ok && /豁免/.test(omit.reason));
  const own = must(apply(inReview(), { ...base, waiverBy: "u1" } as TaskEvent));
  assert.equal(own.task.reviewGate, "waived-by-user");
  assert.equal(own.effects[0]?.kind, "send-card");
  const custom = apply(inReview(), withProto(base, { waiverBy: "u1" }));
  assert.ok(!custom.ok && custom.reason === PLAIN_ONLY);
});

test("R9-CORR-01/02 Claim 不声明 taskId:继承的或自有的多余 taskId 都被丢弃,正常认领", () => {
  const inh = polluted("taskId", "B", () => must(apply(newTask("t1", "u1"), { kind: "Claim", by: "claude" })));
  assert.equal(inh.task.state, "T2_Claimed");
  assert.equal(inh.task.owner, "claude");
  for (const ev of [{ kind: "Claim", by: "claude", taskId: "B" } as unknown as TaskEvent, { kind: "Claim", by: "claude" } as TaskEvent]) {
    const r = must(apply(newTask("t1", "u1"), ev));
    assert.equal(r.task.state, "T2_Claimed");
    assert.equal(r.task.owner, "claude");
  }
  const custom = apply(newTask("t1", "u1"), withProto({ kind: "Claim", by: "claude" }, { taskId: "B" }));
  assert.ok(!custom.ok && custom.reason === PLAIN_ONLY);
});

test("R9-CORR-02 标准 JSON 的多余 taskId(含无法转字符串的对象)不让 apply/applyAll 抛异常,照常认领", () => {
  for (const j of ['{"kind":"Claim","by":"author","taskId":{"toString":null}}', '{"kind":"Claim","by":"author","taskId":"B"}', '{"kind":"Claim","by":"author","extra":1}']) {
    const e = JSON.parse(j) as TaskEvent;
    assert.equal(validateEvent(e), null, j);
    assert.equal(must(apply(newTask("t1", "u1"), e)).task.owner, "author", j);
    assert.equal(must(applyAll(newTask("t1", "u1"), [e])).task.state, "T2_Claimed", j);
  }
  const bad = JSON.parse('{"kind":"UserAccept","by":"u1","deliveryRound":1,"commit":"abc","taskId":{"toString":null}}') as TaskEvent;
  const r = apply(delivered(), bad);
  assert.ok(!r.ok && r.reason === "UserAccept.taskId 缺失或取值非法(应为非空字符串)");
});

/** 在普通对象上挂一个访问器属性;calls 记录 getter/setter 被调用的次数(新契约下必须始终为 0)。 */
const withAccessor = (fixed: Record<string, unknown>, key: PropertyKey, calls: { n: number }, opts: { enumerable?: boolean; setterOnly?: boolean } = {}) => {
  const o: Record<PropertyKey, unknown> = { ...fixed };
  const getter = { get() { calls.n++; return (fixed as Record<PropertyKey, unknown>)[key]; } };
  const setter = { set(_v: unknown) { calls.n++; } };
  Object.defineProperty(o, key, { enumerable: opts.enumerable ?? true, configurable: true, ...(opts.setterOnly ? setter : { ...getter, ...setter }) });
  return o as unknown as TaskEvent;
};
const accessorReason = (key: string) => `只接受普通数据对象(含访问器属性 ${key})`;

test("R10-CORR-01 每种事件 × 每个声明字段换成访问器:四个入口都按含访问器拒绝,getter 调用 0 次", () => {
  for (const k of EVENT_KINDS) {
    const fields = ["kind", ...Object.keys(SHAPES[k].req), ...Object.keys(SHAPES[k].opt ?? {})];
    for (const f of fields) {
      const calls = { n: 0 };
      const ev = withAccessor({ ...SAMPLE[k], [f]: (SAMPLE[k] as Record<string, unknown>)[f] ?? "x" }, f, calls);
      const no = { ok: false, reason: accessorReason(f) };
      assert.deepEqual(normalizeEvent(ev), no, `${k}.${f}`);
      assert.equal(validateEvent(ev), no.reason, `${k}.${f}`);
      assert.deepEqual(apply(inState("T3_Running"), ev), no, `${k}.${f}`);
      assert.deepEqual(applyAll(inState("T3_Running"), [ev]), no, `${k}.${f}`);
      assert.equal(calls.n, 0, `${k}.${f} 的 getter 不应被调用`);
    }
  }
});

test("R10-CORR-01 未声明字段、不可枚举字段、symbol 键、只有 setter 的访问器同样拒绝,且从不调用", () => {
  for (const k of EVENT_KINDS) {
    const calls = { n: 0 };
    assert.equal(validateEvent(withAccessor({ ...SAMPLE[k], extra: 1 }, "extra", calls)), accessorReason("extra"), k);
    assert.equal(calls.n, 0, k);
  }
  const calls = { n: 0 };
  assert.equal(validateEvent(withAccessor({ kind: "Claim", by: "claude" }, "hidden", calls, { enumerable: false })), accessorReason("hidden"));
  const sym = Symbol("s");
  assert.equal(validateEvent(withAccessor({ kind: "Claim", by: "claude" }, sym, calls)), accessorReason("Symbol(s)"));
  assert.equal(validateEvent(withAccessor({ kind: "Claim", by: "claude" }, "w", calls, { setterOnly: true })), accessorReason("w"));
  assert.equal(calls.n, 0);
});

test("R10-CORR-01 getter 自身的 call 被遮蔽也不影响:访问器直接拒绝,不经任何 call", () => {
  let calls = 0;
  const get = () => { calls++; return "claude"; };
  Object.defineProperty(get, "call", { value: () => "attacker" });
  const ev = Object.defineProperty({ kind: "Claim" }, "by", { get, enumerable: true });
  const no = { ok: false, reason: accessorReason("by") };
  assert.deepEqual(normalizeEvent(ev), no);
  assert.equal(validateEvent(ev), no.reason);
  assert.deepEqual(apply(newTask("t1", "u1"), ev as unknown as TaskEvent), no);
  assert.deepEqual(applyAll(newTask("t1", "u1"), [ev as unknown as TaskEvent]), no);
  assert.equal(calls, 0);
});

test("R10-CORR-01 数据属性的值原样进入快照:描述符 value 就是快照值", () => {
  const ev = Object.defineProperty({ kind: "Claim" }, "by", { value: "claude", enumerable: false });
  const r = must(apply(newTask("t1", "u1"), ev as unknown as TaskEvent));
  assert.equal(r.task.owner, "claude");
});

test("R9 快照:冻结、原型为 null、只含声明字段,值与首次读取一致", () => {
  const n = normalizeEvent({ kind: "Claim", by: "claude", taskId: "B", extra: 1 });
  assert.ok(n.ok);
  const e = n.ok ? (n.event as unknown as Record<string, unknown>) : {};
  assert.ok(Object.isFrozen(e));
  assert.equal(Object.getPrototypeOf(e), null);
  assert.deepEqual(Object.keys(e).sort(), ["by", "kind"]);
  const n2 = normalizeEvent({ kind: "ExecFailed" });
  assert.ok(n2.ok && Object.keys(n2.event).length === 1);
  assert.deepEqual(normalizeEvent(null), { ok: false, reason: "事件不是对象" });
});

test("R10-TEST-01 每种事件的快照:冻结、原型为 null、只含声明字段且值相同,多余数据字段丢弃", () => {
  const full: { [K in EventKind]: Record<string, unknown> } = { ...SAMPLE, StoppedConfirmed: { ...SAMPLE.StoppedConfirmed, requestId: "t#L0" }, ExecFailed: { ...SAMPLE.ExecFailed, requestId: "t#L0" }, Review: { ...SAMPLE.Review, waiverBy: "u1" } };
  for (const k of EVENT_KINDS) {
    const n = normalizeEvent({ ...full[k], extra: 1, taskId: (full[k] as Record<string, unknown>).taskId ?? "B" });
    assert.ok(n.ok, k);
    const e = n.ok ? (n.event as unknown as Record<string, unknown>) : {};
    assert.ok(Object.isFrozen(e), `${k} 快照应冻结`);
    assert.equal(Object.getPrototypeOf(e), null, `${k} 快照原型应为 null`);
    const declared = ["kind", ...Object.keys(SHAPES[k].req), ...Object.keys(SHAPES[k].opt ?? {})];
    assert.deepEqual(Object.keys(e).sort(), declared.filter((f) => full[k][f] !== undefined).sort(), k);
    for (const f of Object.keys(e)) assert.equal(e[f], full[k][f], `${k}.${f}`);
  }
});

test("R9-TEST-01 继承的 kind 不算:按种类缺失拒绝", () => {
  assert.equal(polluted("kind", "Claim", () => validateEvent({ by: "u1" })), "事件种类缺失或不是字符串");
  assert.equal(polluted("kind", "Claim", () => apply(newTask("t1", "u1"), { by: "u1" } as unknown as TaskEvent)).ok, false);
});

test("R9-TEST-01 继承的非法可选字段被忽略,不导致拒绝", () => {
  assert.equal(polluted("computeId", 5, () => validateEvent({ kind: "ExecFailed" })), null);
  assert.equal(polluted("requestId", [], () => validateEvent({ kind: "ExecFailed" })), null);
  assert.equal(polluted("computeId", {}, () => validateEvent({ kind: "StoppedConfirmed", taskId: "t1" })), null);
  assert.equal(polluted("waiverBy", 1, () => validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: 1, commit: "c", constraintVer: 0, verdict: "approve" })), null);
});

test("R9-TEST-01 审查打回所需的 computeResumable 只从原型继承:按缺失拒绝", () => {
  const base = { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "reject" };
  assert.equal(polluted("computeResumable", true, () => validateEvent({ ...base })), "Review.computeResumable 缺失或取值非法(应为布尔)");
  assert.equal(polluted("computeResumable", true, () => apply(inReview(), { ...base } as TaskEvent)).ok, false);
});

test("R9-TEST-01 非负整数接受 -0(JSON 可表示),正整数仍拒绝 -0", () => {
  assert.equal(validateEvent({ kind: "NeedHuman", qId: "q", computeId: "c", constraintVer: -0 }), null);
  assert.equal(validateEvent(JSON.parse('{"kind":"HumanReply","qId":"q","constraintVer":-0,"answer":"approve"}')), null);
  assert.equal(validateEvent({ kind: "Review", reviewerId: "r", reviewerModel: "m", round: -0, commit: "c", constraintVer: 0, verdict: "approve" }), "Review.round 缺失或取值非法(应为正整数)");
});

test("R9 契约边界:Proxy 事件拒绝且不触发任何陷阱;自定义原型、类实例也拒绝", () => {
  let traps = 0;
  const handler: ProxyHandler<object> = new Proxy({}, { get: () => () => { traps++; return undefined; } });
  const proxied = new Proxy({ kind: "Claim", by: "claude" }, handler);
  assert.equal(validateEvent(proxied), PLAIN_ONLY);
  const r = apply(newTask("t1", "u1"), proxied as TaskEvent);
  assert.ok(!r.ok && r.reason === PLAIN_ONLY);
  assert.equal(traps, 0);
  assert.equal(validateEvent(Object.assign(Object.create({}), { kind: "Claim", by: "claude" })), PLAIN_ONLY);
  class Ev { kind = "Claim"; by = "claude"; }
  assert.equal(validateEvent(new Ev()), PLAIN_ONLY);
  assert.equal(applyAll(newTask("t1", "u1"), [new Ev() as unknown as TaskEvent]).ok, false);
});

test("R10-CORR-02 各类 Proxy(对象、数组、函数、已撤销)在四个入口给同一原因,且不触发陷阱", () => {
  let traps = 0;
  const handler: ProxyHandler<object> = new Proxy({}, { get: () => () => { traps++; return undefined; } });
  const revocable = Proxy.revocable({ kind: "Claim", by: "claude" }, {});
  revocable.revoke();
  const revokedFn = Proxy.revocable(() => undefined, {});
  revokedFn.revoke();
  const proxies = [
    new Proxy({ kind: "Claim", by: "claude" }, handler),
    new Proxy([], handler),
    new Proxy(() => undefined, handler),
    new Proxy(Object.create(null), handler),
    revocable.proxy,
    revokedFn.proxy,
  ];
  const no = { ok: false, reason: PLAIN_ONLY };
  for (const [i, p] of proxies.entries()) {
    assert.deepEqual(normalizeEvent(p), no, `Proxy #${i}`);
    assert.equal(validateEvent(p), PLAIN_ONLY, `Proxy #${i}`);
    assert.deepEqual(apply(newTask("t1", "u1"), p as TaskEvent), no, `Proxy #${i}`);
    assert.deepEqual(applyAll(newTask("t1", "u1"), [p as TaskEvent]), no, `Proxy #${i}`);
  }
  assert.equal(traps, 0);
});

test("R10-CORR-02 非 Proxy 的数组、函数仍按不是对象拒绝", () => {
  const no = { ok: false, reason: "事件不是对象" };
  for (const v of [[], [1], () => undefined, "Claim", 1]) {
    assert.deepEqual(normalizeEvent(v), no, String(v));
    assert.equal(validateEvent(v), no.reason, String(v));
    assert.deepEqual(apply(newTask("t1", "u1"), v as unknown as TaskEvent), no, String(v));
    assert.deepEqual(applyAll(newTask("t1", "u1"), [v as unknown as TaskEvent]), no, String(v));
  }
});

test("R10-CORR-03 审查通过时 computeResumable 是未声明字段:任意数据值都通过、被丢弃,照常进入交付", () => {
  for (const extra of ["metadata", 1, null, {}, true]) {
    const ev = { ...approve("abc", 0), computeResumable: extra } as unknown as TaskEvent;
    assert.equal(validateEvent(ev), null, String(extra));
    const n = normalizeEvent(ev);
    assert.ok(n.ok && !Object.hasOwn(n.event, "computeResumable"), String(extra));
    const r = must(apply(inReview(), ev));
    assert.equal(r.task.state, "T7_Delivering");
    assert.equal(r.effects[0]?.kind, "send-card");
  }
});

test("R10-CORR-03 审查打回时 computeResumable 是声明字段:非法值拒绝,合法值进入快照", () => {
  const base = { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "reject" };
  for (const v of ["metadata", 1, null, {}]) assert.equal(validateEvent({ ...base, computeResumable: v }), "Review.computeResumable 缺失或取值非法(应为布尔)", String(v));
  const n = normalizeEvent({ ...base, computeResumable: false });
  assert.ok(n.ok && (n.event as unknown as Record<string, unknown>).computeResumable === false);
});

test("R9 契约边界:普通对象、Object.create(null) 对象、JSON.parse 结果都接受", () => {
  const nullProto = Object.assign(Object.create(null), { kind: "Claim", by: "claude" });
  for (const ev of [{ kind: "Claim", by: "claude" }, nullProto, JSON.parse('{"kind":"Claim","by":"claude"}')]) {
    assert.equal(validateEvent(ev), null);
    assert.equal(must(apply(newTask("t1", "u1"), ev as TaskEvent)).task.owner, "claude");
  }
});

// ---- 第十一轮 ----
const TASK_URL = new URL("./task.ts", import.meta.url).href;
/**
 * 在单独的 Node 子进程里跑一段脚本(脚本里 m 是同一份 task.ts 模块),返回它 stdout 的 JSON。
 * Object.prototype 只在子进程里被临时改动,子进程在 finally 中删除并核对已恢复;测试主进程的原型从不被改动。
 */
const inChild = (body: string): unknown => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(process.env.TASK_URL);\n${CHILD_PRELUDE}\n${body}`], { env: { ...process.env, TASK_URL }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`子进程失败(exit ${r.status}):${r.stderr}`);
  return JSON.parse(r.stdout);
};
/** 子进程共用:under(key, cond, value, fn) 按四种条件之一在 Object.prototype 上放同名属性,fn 结束后一定删掉;safe 把异常记成 { threw }。 */
const CHILD_PRELUDE = `
const { newTask, apply, applyAll, normalizeEvent, validateEvent } = m;
let calls = 0;
const restored = [];
const under = (key, cond, value, fn) => {
  if (Object.getOwnPropertyDescriptor(Object.prototype, key)) throw new Error("Object.prototype 上已有 " + key);
  const d = cond === "none" ? null
    : cond === "data" ? { value, writable: true, configurable: true }
    : cond === "setter" ? { set(_v) { calls++; }, configurable: true }
    : { value, writable: false, configurable: true };
  if (d) Object.defineProperty(Object.prototype, key, d);
  try { return fn(); } finally {
    if (d) delete Object.prototype[key];
    restored.push(Object.getOwnPropertyDescriptor(Object.prototype, key) === undefined);
  }
};
const safe = (fn) => { try { return fn(); } catch (err) { return { threw: String(err && err.message) }; } };
`;
const PROTO_CONDS = ["none", "data", "setter", "readonly"] as const;
const R11_REVIEW = { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "reject" } as const;
const R11_T5 = [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" }, { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 }];
/** computeResumable 取 true / false / 缺失;有无豁免人各一份(waiverBy 是提出者本人,跨厂商下不影响结论)。 */
const r11Review = (v: "true" | "false" | "missing", w: "plain" | "waiver"): Record<string, unknown> =>
  ({ ...R11_REVIEW, ...(v === "missing" ? {} : { computeResumable: v === "true" }), ...(w === "waiver" ? { waiverBy: "u1" } : {}) });
const R11_MISSING = "Review.computeResumable 缺失或取值非法(应为布尔)";

test("R11-CORR-01 审查打回经受 Object.prototype 同名 computeResumable(无/可写数据/setter/不可写):四个入口与无污染一致,true 恢复原实例、false 新开、缺失拒绝", () => {
  const cases: [string, Record<string, unknown>][] = [];
  for (const v of ["true", "false", "missing"] as const) for (const w of ["plain", "waiver"] as const) cases.push([`${v}/${w}`, r11Review(v, w)]);
  const got = inChild(`
const T5 = applyAll(newTask("t1", "u1"), ${JSON.stringify(R11_T5)}).task;
const out = {};
for (const [id, raw] of ${JSON.stringify(cases)}) for (const cond of ${JSON.stringify(PROTO_CONDS)}) {
  const ev = JSON.parse(JSON.stringify(raw));
  const r = under("computeResumable", cond, true, () => ({ normalize: safe(() => normalizeEvent(ev)), validate: safe(() => validateEvent(ev)), apply: safe(() => apply(T5, ev)), applyAll: safe(() => applyAll(T5, [ev])) }));
  out[cond + "/" + id] = JSON.parse(JSON.stringify(r));
}
console.log(JSON.stringify({ out, calls, restored: restored.length > 0 && restored.every(Boolean) }));
`) as { out: Record<string, unknown>; calls: number; restored: boolean };
  for (const [id, raw] of cases) {
    const ev = raw as unknown as TaskEvent;
    const want = JSON.parse(JSON.stringify({ normalize: normalizeEvent(ev), validate: validateEvent(ev), apply: apply(inReview(), ev), applyAll: applyAll(inReview(), [ev]) }));
    const v = id.split("/")[0];
    if (v === "missing") {
      const no = { ok: false, reason: R11_MISSING };
      assert.deepEqual(want.normalize, no, id);
      assert.equal(want.validate, R11_MISSING, id);
      assert.deepEqual(want.apply, no, id);
      assert.deepEqual(want.applyAll, no, id);
    } else {
      const fx = v === "true" ? [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }] : [{ kind: "spawn-compute", withHandoff: true, requestId: "t1#L1", constraintVer: 1 }];
      assert.equal(want.validate, null, id);
      assert.equal(want.normalize.event.computeResumable, v === "true", id);
      for (const r of [want.apply, want.applyAll]) {
        assert.equal(r.ok, true, id);
        assert.equal(r.task.state, "T3_Running", id);
        assert.equal(r.task.computeId, v === "true" ? "cc-1" : null, id);
        assert.deepEqual(r.effects, fx, id);
      }
    }
    for (const cond of PROTO_CONDS) assert.deepEqual(got.out[`${cond}/${id}`], want, `${cond}/${id}`);
  }
  assert.equal(got.calls, 0, "继承的 setter 不应被调用");
  assert.equal(got.restored, true, "子进程每次都应恢复 Object.prototype");
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, "computeResumable"), undefined, "主进程原型未被改动");
});

/** 跑遍交付、退回、新开回绑、提问:产生 delivery、approval、launch、instances、producerModels、pendingQ 的读写。 */
const R11_PATH = [...R11_T5,
  { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" },
  { kind: "DeliveredCard", taskId: "t1", deliveryRound: 1, commit: "abc" },
  { kind: "UserReject", taskId: "t1", by: "u1", computeResumable: false, deliveryRound: 1, commit: "abc" },
  { kind: "Dispatch", computeId: "cc-2", model: "gemini-4-argon", requestId: "t1#L1" },
  { kind: "NeedHuman", qId: "q", computeId: "cc-2", constraintVer: 1 }];
const R11_TASK_KEYS = ["delivery", "pendingQ", "launch", "approval", "producerModels", "revoked", "orphans", "retired", "instances", "opt"];

test("R11-CORR-01 同类:Object.prototype 上有任务字段或形状表 opt 的同名属性(可写数据/setter/不可写)时,新建任务、状态转移与形状校验结果不变", () => {
  const junk = { by: "pint", round: 9, commit: "z", requestId: "t1#L9", constraintVer: 9, reviewerModel: "gpt-6", waiverBy: "u1", qId: "q9" };
  const got = inChild(`
const out = {};
for (const key of ${JSON.stringify(R11_TASK_KEYS)}) for (const cond of ["data", "setter", "readonly"]) {
  const r = under(key, cond, ${JSON.stringify(junk)}, () => ({ run: safe(() => applyAll(newTask("t1", "u1"), ${JSON.stringify(R11_PATH)})), claim: safe(() => validateEvent({ kind: "Claim", by: "claude" })) }));
  out[cond + "/" + key] = JSON.parse(JSON.stringify(r));
}
console.log(JSON.stringify({ out, calls, restored: restored.length > 0 && restored.every(Boolean) }));
`) as { out: Record<string, unknown>; calls: number; restored: boolean };
  const run = must(applyAll(newTask("t1", "u1"), R11_PATH as TaskEvent[]));
  assert.equal(run.task.state, "T4b_BlockedOnHuman");
  assert.deepEqual(run.task.instances, ["cc-1", "cc-2"]);
  assert.deepEqual(run.task.producerModels, [PRODUCER, "gemini-4-argon"]);
  assert.deepEqual(run.task.pendingQ, { qId: "q", constraintVer: 1 });
  assert.equal(run.task.delivery, null);
  assert.equal(run.task.approval, null);
  assert.equal(run.task.launch, null);
  assert.deepEqual(run.effects.map((e) => e.kind), ["spawn-compute", "request-review", "send-card", "spawn-compute"]);
  const want = JSON.parse(JSON.stringify({ run, claim: validateEvent({ kind: "Claim", by: "claude" }) }));
  assert.equal(want.claim, null);
  for (const key of R11_TASK_KEYS) for (const cond of ["data", "setter", "readonly"]) assert.deepEqual(got.out[`${cond}/${key}`], want, `${cond}/${key}`);
  assert.equal(got.calls, 0, "继承的 setter 不应被调用");
  assert.equal(got.restored, true);
  for (const key of R11_TASK_KEYS) assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, key), undefined, `主进程原型未被改动:${key}`);
});

test("R11-TEST-01 symbol 键的不可枚举访问器、仅 setter 访问器:四个入口都按含访问器拒绝,从不调用", () => {
  for (const opts of [{ enumerable: false }, { setterOnly: true }, { enumerable: false, setterOnly: true }]) {
    const calls = { n: 0 };
    const ev = withAccessor({ kind: "Claim", by: "claude" }, Symbol("hidden"), calls, opts);
    const no = { ok: false, reason: accessorReason("Symbol(hidden)") };
    const tag = JSON.stringify(opts);
    assert.deepEqual(normalizeEvent(ev), no, tag);
    assert.equal(validateEvent(ev), no.reason, tag);
    assert.deepEqual(apply(newTask("t1", "u1"), ev), no, tag);
    assert.deepEqual(applyAll(newTask("t1", "u1"), [ev]), no, tag);
    assert.equal(calls.n, 0, tag);
  }
});

test("R11-TEST-01 外层兜底可达:未初始化的模块命名空间取描述符会抛错,四个入口都返回事件无法校验而不抛出", async () => {
  await assert.rejects(import("./fixtures/tdz-namespace.mjs"), /stop/);
  const ns = Reflect.get(globalThis, "__r11TdzNamespace") as TaskEvent;
  try {
    assert.throws(() => Object.getOwnPropertyDescriptor(ns, "kind"), ReferenceError);
    const no = { ok: false, reason: "事件无法校验" };
    assert.deepEqual(normalizeEvent(ns), no);
    assert.equal(validateEvent(ns), no.reason);
    assert.deepEqual(apply(newTask("t1", "u1"), ns), no);
    assert.deepEqual(applyAll(newTask("t1", "u1"), [ns]), no);
  } finally {
    Reflect.deleteProperty(globalThis, "__r11TdzNamespace");
  }
});

// ---- 第十三轮:导出的策略对象不可改写(用户 #2662)----
test("R13 导出的策略对象深冻结:STATES、EVENT_KINDS、TABLE、每一行、每一格都冻结,冻结后的表照常驱动转移", () => {
  assert.equal(apply(newTask("t1", "u1"), { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" }).ok, false);
  assert.equal(must(apply(newTask("t1", "u1"), { kind: "Claim", by: "claude" })).task.state, "T2_Claimed");
  assert.ok(Object.isFrozen(STATES));
  assert.ok(Object.isFrozen(EVENT_KINDS));
  assert.ok(Object.isFrozen(TABLE));
  for (const s of STATES) {
    assert.ok(Object.isFrozen(TABLE[s]), `${s} 行未冻结`);
    for (const e of EVENT_KINDS) assert.ok(Object.isFrozen(TABLE[s][e]), `${s} × ${e} 格未冻结`);
  }
});

test("R13 进程内改写 TABLE/行/格/STATES/EVENT_KINDS 都抛 TypeError,未认领任务的 Dispatch 仍被拒", () => {
  const forged = { kind: "go", run: (t: Task) => ({ ok: true, task: { ...t, state: "T3_Running" }, effects: [] }) };
  assert.throws(() => { (TABLE.T1_Open as unknown as Record<string, unknown>).Dispatch = forged; }, TypeError);
  assert.throws(() => { (TABLE as unknown as Record<string, unknown>).T1_Open = { ...TABLE.T1_Open, Dispatch: forged }; }, TypeError);
  assert.throws(() => { (TABLE.T1_Open.Dispatch as unknown as Record<string, unknown>).kind = "go"; }, TypeError);
  assert.throws(() => { (STATES as unknown as string[]).push("T99"); }, TypeError);
  assert.throws(() => { (EVENT_KINDS as unknown as string[])[0] = "Forged"; }, TypeError);
  const r = apply(newTask("t1", "u1"), { kind: "Dispatch", computeId: "cc-1", model: PRODUCER, requestId: "t1#L0" });
  assert.equal(r.ok, false);
  assert.equal(TABLE.T1_Open.Dispatch.kind, "reject");
  assert.equal(STATES.length, 11);
  assert.equal(EVENT_KINDS[0], "Claim");
});

test("R13-CORR-01 每个 go 格的 run 函数本体冻结:逐格 Object.isFrozen(cell.run),改写或新增属性都抛 TypeError,转移结果不变", () => {
  const runs = new Set<unknown>();
  for (const s of STATES) for (const e of EVENT_KINDS) {
    const cell = TABLE[s][e];
    if (cell.kind !== "go") continue;
    assert.ok(Object.isFrozen(cell.run), `${s} × ${e} 的 run 未冻结`);
    assert.ok(!Object.isExtensible(cell.run), `${s} × ${e} 的 run 仍可扩展`);
    runs.add(cell.run);
  }
  assert.ok(runs.size > 0);
  const claim = TABLE.T1_Open.Claim;
  assert.equal(claim.kind, "go");
  const run = (claim as { run: unknown }).run as Record<string, unknown>;
  assert.throws(() => { run.call = () => "forged"; }, TypeError);
  assert.throws(() => { Object.defineProperty(run, "forged", { value: 1 }); }, TypeError);
  assert.throws(() => { run.name = "forged"; }, TypeError);
  assert.equal(Object.hasOwn(run, "call"), false);
  assert.equal(must(apply(newTask("t1", "u1"), { kind: "Claim", by: "claude" })).task.state, "T2_Claimed");
});
