// 第三台状态机(任务生命周期)主干。
// AC-09 状态×事件表无空白格,且每格的处理对照一份独立于实现的需求期望(TEST-01);
// AC-26 写审分离 + 跨厂商审查(含累积生产厂商集合),审查回包绑定被审 commit 与条件版本(CORR-01);
// AC-28 / R-09 交付待确认、超时只算未核验、所有返工入口共用可恢复性契约并能回绑新 Compute(CORR-02/03);
// AC-19 确认卡绑定版本,卡片是不可变快照(CORR-04)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, applyAll, type Effect, EVENT_KINDS, type EventKind, newTask, type Outcome, STATES, TABLE, type Task, type TaskEvent, type TaskState } from "./task.ts";

const must = (r: Outcome) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const PRODUCER = "claude-opus-5-5";
const running = () => must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "cc-1", model: PRODUCER }])).task;
const inReview = (commit = "abc") => must(apply(running(), { kind: "SubmitForReview", commit, computeId: "cc-1", constraintVer: 0 })).task;
const approve = (commit: string, constraintVer: number, round = 1): TaskEvent => ({ kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round, commit, constraintVer, verdict: "approve" });
const delivered = () => must(applyAll(inReview(), [approve("abc", 0), { kind: "DeliveredCard" }])).task;

const SAMPLE: { [K in EventKind]: Extract<TaskEvent, { kind: K }> } = {
  Claim: { kind: "Claim", by: "x" }, Dispatch: { kind: "Dispatch", computeId: "c", model: "gpt-6" },
  ProducerModelAdded: { kind: "ProducerModelAdded", model: "gpt-6", computeId: "cc" }, NeedHuman: { kind: "NeedHuman", qId: "q", computeId: "cc", constraintVer: 0 },
  HumanReply: { kind: "HumanReply", qId: "q", constraintVer: 0, answer: "approve" }, Amend: { kind: "Amend", by: "u1", computeResumable: true },
  SubmitForReview: { kind: "SubmitForReview", commit: "c2", computeId: "cc", constraintVer: 0 },
  Review: { kind: "Review", reviewerId: "r", reviewerModel: "gpt-6", round: 1, commit: "c", constraintVer: 0, verdict: "approve" },
  DeliveredCard: { kind: "DeliveredCard" }, UserAccept: { kind: "UserAccept", by: "u1" }, UserReject: { kind: "UserReject", by: "u1", computeResumable: true },
  AcceptTimeout: { kind: "AcceptTimeout" }, Cancel: { kind: "Cancel", by: "u1" }, StoppedConfirmed: { kind: "StoppedConfirmed", computeId: "cc" }, ExecFailed: { kind: "ExecFailed", computeId: "cc" },
};
/** 各状态的代表性任务:未派发的 T1/T2 没有 Compute;T4b 带一张当前版本的卡;T5 正在审第 1 轮的 commit "c"。 */
const inState = (s: TaskState): Task => ({
  ...newTask("t", "u1"), state: s, owner: "o",
  computeId: s === "T1_Open" || s === "T2_Claimed" ? null : "cc",
  producerModels: [PRODUCER], reviewedCommit: s === "T5_InReview" ? "c" : null, reviewRound: s === "T5_InReview" ? 1 : 0,
  pendingQ: s === "T4b_BlockedOnHuman" ? { qId: "q", constraintVer: 0 } : null,
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
const SPEC: { [S in TaskState]: { [E in EventKind]: Exp } } = {
  T1_Open: {
    Claim: { to: "T2_Claimed", owner: "x" }, Dispatch: "rej", ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign",
    Amend: { to: "T1_Open", ver: 1 }, SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T10_Cancelled", fx: [] }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T2_Claimed: {
    Claim: "rej", Dispatch: { to: "T3_Running", pm: PM2 }, ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign",
    Amend: { to: "T2_Claimed", ver: 1 }, SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T10_Cancelled", fx: [] }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T3_Running: {
    Claim: "rej", Dispatch: "rej", ProducerModelAdded: { to: "T3_Running", pm: PM2 }, NeedHuman: { to: "T4b_BlockedOnHuman" }, HumanReply: "ign",
    Amend: { to: "T3_Running", fx: [{ kind: "update-constraints", computeId: "cc", constraintVer: 1 }], ver: 1 }, SubmitForReview: { to: "T5_InReview", fx: [{ kind: "request-review", round: 1, commit: "c2", constraintVer: 0 }] }, Review: "rej", DeliveredCard: "rej",
    UserAccept: "rej", UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T4b_BlockedOnHuman: {
    Claim: "rej", Dispatch: "rej", ProducerModelAdded: { to: "T4b_BlockedOnHuman", pm: PM2 }, NeedHuman: "rej", HumanReply: { to: "T3_Running", fx: [] },
    Amend: { to: "T3_Running", fx: [{ kind: "update-constraints", computeId: "cc", constraintVer: 1 }], ver: 1 }, SubmitForReview: "rej", Review: "rej", DeliveredCard: "rej", UserAccept: "rej",
    UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T5_InReview: {
    Claim: "rej", Dispatch: "rej", ProducerModelAdded: { to: "T5_InReview", pm: PM2 }, NeedHuman: "rej", HumanReply: "ign",
    Amend: REWORK, SubmitForReview: { to: "T5_InReview", fx: [{ kind: "request-review", round: 2, commit: "c2", constraintVer: 0 }] }, Review: { to: "T7_Delivering", fx: [] }, DeliveredCard: "rej",
    UserAccept: "rej", UserReject: "rej", AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign",
    ExecFailed: { to: "T9_StopRequested", fx: STOP },
  },
  T7_Delivering: {
    Claim: "rej", Dispatch: "rej", ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign", Amend: REWORK,
    SubmitForReview: "rej", Review: "ign", DeliveredCard: { to: "T8a_Delivered", fx: [] }, UserAccept: "rej", UserReject: "rej",
    AcceptTimeout: "ign", Cancel: { to: "T9_StopRequested", fx: STOP }, StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T8a_Delivered: {
    Claim: "rej", Dispatch: "rej", ProducerModelAdded: "rej", NeedHuman: "rej", HumanReply: "ign", Amend: REWORK,
    SubmitForReview: "rej", Review: "ign", DeliveredCard: "ign", UserAccept: { to: "T8_Accepted", fx: [] }, UserReject: REWORK,
    AcceptTimeout: { to: "T8_ArchivedUnverified", fx: [] }, Cancel: "ign", StoppedConfirmed: "ign", ExecFailed: "ign",
  },
  T8_Accepted: { ...allIgn(), Amend: REWORK, UserReject: REWORK },
  T8_ArchivedUnverified: { ...allIgn(), Amend: REWORK, UserReject: REWORK, UserAccept: { to: "T8_Accepted", fx: [] } },
  T9_StopRequested: { ...allIgn(), Claim: "rej", Dispatch: "rej", StoppedConfirmed: { to: "T10_Cancelled", fx: [{ kind: "release-slot", computeId: "cc" }] } },
  T10_Cancelled: allIgn(),
  T11_Failed: allIgn(),
};
test("AC-09 每个状态×每个事件都有明确处理:拒绝格实际拒绝并给出原因,忽略格实际不改任务", () => {
  for (const s of STATES) for (const e of EVENT_KINDS) {
    const cell = TABLE[s][e];
    assert.ok(cell && ["go", "reject", "ignore"].includes(cell.kind), `${s} × ${e} 是空白格`);
    const t = inState(s);
    const r = apply(t, SAMPLE[e]);
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
  ...(["T5_InReview", "T7_Delivering", "T8a_Delivered", "T8_Accepted", "T8_ArchivedUnverified"] as const).map((s) => ({ s, e: (r: boolean): TaskEvent => ({ kind: "Amend", by: "u1", computeResumable: r }) })),
  ...(["T8a_Delivered", "T8_Accepted", "T8_ArchivedUnverified"] as const).map((s) => ({ s, e: (r: boolean): TaskEvent => ({ kind: "UserReject", by: "u1", computeResumable: r }) })),
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
    { kind: "Dispatch", computeId: "cc-1", model: PRODUCER },
    { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 },
    { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" },
    { kind: "DeliveredCard" },
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
  const t = must(applyAll(newTask("t2", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "c", model: "stealth/crouton-alpha" }, { kind: "SubmitForReview", commit: "abc", computeId: "c", constraintVer: 0 }])).task;
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

const respawned = () => must(apply(delivered(), { kind: "UserReject", by: "u1", computeResumable: false })).task;
const L1 = "t1#L1";
const up = (computeId: string, requestId: string | undefined = L1): TaskEvent => ({ kind: "Dispatch", computeId, model: "gemini-4-argon", ...(requestId ? { requestId } : {}) });

test("CORR-02 不可恢复返工后新 Compute 回绑:记录新实例、保留负责人并累积生产模型", () => {
  const r = must(apply(respawned(), up("cc-2")));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-2");
  assert.equal(r.task.launch, null);
  assert.equal(r.task.owner, "claude");
  assert.deepEqual(r.task.producerModels, [PRODUCER, "gemini-4-argon"]);
  assert.equal(apply(r.task, { kind: "Dispatch", computeId: "cc-3", model: "gpt-6" }).ok, false);
});

test("R2-CORR-01 回绑必须对上当前启动请求号:不带号的回包被拒,别的请求号的实例被立即停止", () => {
  const t = respawned();
  assert.equal(apply(t, { kind: "Dispatch", computeId: "cc-2", model: "gemini-4-argon" }).ok, false);
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
  const r2 = must(apply(r1.task, { kind: "StoppedConfirmed", computeId: "cc-2" }));
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
  const done = must(apply(late.task, { kind: "StoppedConfirmed", computeId: "cc-2" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-2" }]);
});

test("R2-CORR-01 启动途中取消后,旧实例的迟到停止确认不终结任务,新实例仍会被停止回收", () => {
  const stopping = must(apply(respawned(), { kind: "Cancel", by: "u1" })).task;
  const oldAck = must(apply(stopping, { kind: "StoppedConfirmed", computeId: "cc-1" }));
  assert.equal(oldAck.task.state, "T9_StopRequested");
  assert.deepEqual(oldAck.effects, []);
  const bare = must(apply(stopping, { kind: "StoppedConfirmed" }));
  assert.equal(bare.task.state, "T9_StopRequested");
  const late = must(apply(oldAck.task, up("cc-2")));
  assert.deepEqual(late.effects, [{ kind: "stop-compute", computeId: "cc-2" }]);
  assert.equal(must(apply(late.task, { kind: "StoppedConfirmed", requestId: L1 })).task.state, "T9_StopRequested");
  const done = must(apply(late.task, { kind: "StoppedConfirmed", computeId: "cc-2" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-2" }]);
});

test("R2-CORR-01 启动撤销被确认(实例从未上线):凭这次的请求号进终态,重复确认幂等", () => {
  const stopping = must(apply(respawned(), { kind: "Cancel", by: "u1" })).task;
  const done = must(apply(stopping, { kind: "StoppedConfirmed", requestId: L1 }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, []);
  const again = must(apply(done.task, { kind: "StoppedConfirmed", requestId: L1 }));
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
  const t8a = must(apply(t7, { kind: "DeliveredCard" })).task;
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
  const l2 = must(apply(orphan.task, { kind: "StoppedConfirmed", requestId: "t1#L2" }));
  assert.equal(l2.task.state, "T9_StopRequested");
  const dup = must(apply(l2.task, { kind: "StoppedConfirmed", requestId: "t1#L2" }));
  assert.equal(dup.task.state, "T9_StopRequested");
  const done = must(apply(l2.task, { kind: "StoppedConfirmed", computeId: "old-worker" }));
  assert.equal(done.task.state, "T10_Cancelled");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
});

test("R3-CORR-02 乱序:孤儿先确认、L2 后确认也进终态;旧 L1 只确认撤销从未上线也算清掉", () => {
  const stopping = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, { kind: "Cancel", by: "u1" }])).task;
  const a = must(applyAll(stopping, [up("old-worker", L1), { kind: "StoppedConfirmed", computeId: "old-worker" }]));
  assert.equal(a.task.state, "T9_StopRequested");
  assert.equal(must(apply(a.task, { kind: "StoppedConfirmed", requestId: "t1#L2" })).task.state, "T10_Cancelled");
  const b = must(applyAll(stopping, [{ kind: "StoppedConfirmed", requestId: "t1#L2" }]));
  assert.equal(b.task.state, "T9_StopRequested");
  assert.equal(must(apply(b.task, { kind: "StoppedConfirmed", requestId: L1 })).task.state, "T10_Cancelled");
});

test("R3-CORR-02 失败终态同样要等所有旧启动与孤儿;旧实例的确认不能代替当前实例的确认", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2"), up("old-worker", L1)])).task;
  const failing = must(apply(t, { kind: "ExecFailed", computeId: "cc-new" }));
  assert.equal(failing.task.state, "T9_StopRequested");
  assert.deepEqual(failing.effects, [{ kind: "stop-compute", computeId: "cc-new" }]);
  const oldAck = must(apply(failing.task, { kind: "StoppedConfirmed", computeId: "old-worker" }));
  assert.equal(oldAck.task.state, "T9_StopRequested");
  assert.equal(oldAck.task.computeId, "cc-new");
  assert.deepEqual(oldAck.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
  const done = must(apply(oldAck.task, { kind: "StoppedConfirmed", computeId: "cc-new" }));
  assert.equal(done.task.state, "T11_Failed");
  assert.deepEqual(done.effects, [{ kind: "release-slot", computeId: "cc-new" }]);
});

test("R3-CORR-02 运行中孤儿确认停止后释放它的槽位,任务不受影响;没有未决对象时取消直接终态(阴性对照)", () => {
  const t = must(applyAll(respawned(), [{ kind: "Amend", by: "u1", computeResumable: true }, up("cc-new", "t1#L2"), up("old-worker", L1)])).task;
  const r = must(apply(t, { kind: "StoppedConfirmed", computeId: "old-worker" }));
  assert.equal(r.task.state, "T3_Running");
  assert.deepEqual(r.task.orphans, []);
  assert.deepEqual(r.effects, [{ kind: "release-slot", computeId: "old-worker" }]);
  assert.deepEqual(must(apply(r.task, { kind: "StoppedConfirmed", computeId: "old-worker" })).effects, []);
  const open = must(applyAll(newTask("t9", "u1"), [{ kind: "Claim", by: "c" }, { kind: "Cancel", by: "u1" }]));
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
  const done = must(apply(r.task, { kind: "StoppedConfirmed", computeId: "old-worker" }));
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
  const again = must(applyAll(bound2(), [{ kind: "SubmitForReview", commit: "y", computeId: "cc-2", constraintVer: 1 }, approve("y", 1, 2), { kind: "DeliveredCard" }, { kind: "UserReject", by: "u1", computeResumable: false }]));
  assert.deepEqual(again.task.launch, { requestId: "t1#L2", constraintVer: 2 });
  assert.equal(again.task.launchSeq, 2);
  assert.equal(apply(again.task, up("cc-3", L1)).ok && must(apply(again.task, up("cc-3", L1))).task.computeId, null);
});

test("CORR-02 新实例未回绑前不能向人提问或提审,不会形成无卡阻塞态", () => {
  const t = respawned();
  assert.equal(apply(t, { kind: "NeedHuman", qId: "q1", computeId: "cc-1", constraintVer: 1 }).ok, false);
  assert.equal(apply(t, { kind: "SubmitForReview", commit: "x", computeId: "cc-1", constraintVer: 1 }).ok, false);
});

test("CORR-02 新实例未回绑前执行失败:撤销启动,凭请求号确认后进失败终态", () => {
  const r = must(applyAll(respawned(), [{ kind: "ExecFailed", requestId: L1 }]));
  assert.deepEqual(r.effects, [{ kind: "cancel-spawn", requestId: L1 }]);
  const done = must(apply(r.task, { kind: "StoppedConfirmed", requestId: L1 }));
  assert.equal(done.task.state, "T11_Failed");
});

test("R-09 用户确认才算验收通过", () => {
  const t = must(applyAll(delivered(), [{ kind: "UserAccept", by: "u1" }])).task;
  assert.equal(t.state, "T8_Accepted");
  assert.equal(t.badge, "accepted");
});

test("R-09 只有提出者本人能确认验收", () => {
  const r = apply(delivered(), { kind: "UserAccept", by: "argon" });
  assert.equal(r.ok, false);
});

test("R-09 未核验归档后也只有提出者本人能补确认验收", () => {
  const archived = must(apply(delivered(), { kind: "AcceptTimeout" })).task;
  assert.equal(apply(archived, { kind: "UserAccept", by: "argon" }).ok, false);
  const r = must(apply(archived, { kind: "UserAccept", by: "u1" }));
  assert.equal(r.task.state, "T8_Accepted");
});

test("R-09 用户不说话超时只归档为未人工核验,绝不算通过(阳性埋雷)", () => {
  const t = must(applyAll(delivered(), [{ kind: "AcceptTimeout" }])).task;
  assert.equal(t.state, "T8_ArchivedUnverified");
  assert.equal(t.badge, "unverified");
  assert.notEqual(t.state, "T8_Accepted");
});

test("R-09 未核验归档后用户仍可退回", () => {
  const r = must(applyAll(delivered(), [{ kind: "AcceptTimeout" }, { kind: "UserReject", by: "u1", computeResumable: true }]));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.badge, "none");
});

test("R-09 只有提出者本人能退回验收", () => {
  assert.equal(apply(delivered(), { kind: "UserReject", by: "argon", computeResumable: true }).ok, false);
  const accepted = must(apply(delivered(), { kind: "UserAccept", by: "u1" })).task;
  assert.equal(apply(accepted, { kind: "UserReject", by: "argon", computeResumable: true }).ok, false);
});

test("AC-28 条件 A:原 Compute 可恢复 → 恢复原实例,不新开(阳性埋雷)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: true }]));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-1");
  assert.equal(r.task.reviewedCommit, null);
  assert.equal(r.task.reviewGate, "none");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1", constraintVer: 1 }]);
});

test("AC-28 条件 B:原 Compute 不可恢复 → 清掉旧实例并带交接摘要新开(阴性对照)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: false }]));
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
  const r2 = must(applyAll(r1.task, [{ kind: "StoppedConfirmed", computeId: "cc-1" }]));
  assert.equal(r2.task.state, "T10_Cancelled");
  assert.deepEqual(r2.effects, [{ kind: "release-slot", computeId: "cc-1" }]);
});

test("停止期间禁止把任务重新指派或重新派发给他人", () => {
  const stopping = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }])).task;
  assert.equal(apply(stopping, { kind: "Claim", by: "argon" }).ok, false);
  assert.equal(apply(stopping, { kind: "Dispatch", computeId: "cc-2", model: "gpt-6" }).ok, false);
});

test("未派发的任务取消直接进终态,不发停止信号", () => {
  const r = must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Cancel", by: "u1" }]));
  assert.equal(r.task.state, "T10_Cancelled");
  assert.deepEqual(r.effects, []);
  const open = must(apply(newTask("t2", "u1"), { kind: "Cancel", by: "u1" }));
  assert.equal(open.task.state, "T10_Cancelled");
});

test("停止期间重复取消幂等,终态后迟到的事件不复活任务", () => {
  const stopping = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }])).task;
  const again = must(applyAll(stopping, [{ kind: "Cancel", by: "u1" }]));
  assert.equal(again.task.state, "T9_StopRequested");
  assert.deepEqual(again.effects, []);
  const done = must(applyAll(stopping, [{ kind: "StoppedConfirmed", computeId: "cc-1" }])).task;
  const late = must(applyAll(done, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }, { kind: "ExecFailed", computeId: "cc-1" }]));
  assert.equal(late.task.state, "T10_Cancelled");
});

test("执行失败先停止再进失败终态", () => {
  const r = must(applyAll(running(), [{ kind: "ExecFailed", computeId: "cc-1" }, { kind: "StoppedConfirmed", computeId: "cc-1" }]));
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
