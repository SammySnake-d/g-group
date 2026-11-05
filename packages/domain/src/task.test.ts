// 第三台状态机(任务生命周期)主干。
// AC-09 状态×事件表无空白格;AC-26 写审分离 + 跨厂商审查(含累积生产厂商集合);
// AC-28 / R-09 交付待确认、超时只算未核验、退回默认恢复原 Compute;AC-19 确认卡绑定版本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, applyAll, EVENT_KINDS, type EventKind, newTask, type Outcome, STATES, TABLE, type Task, type TaskEvent, type TaskState } from "./task.ts";

const must = (r: Outcome) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const running = () => must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "cc-1", model: "claude-opus-5-5" }])).task;
const inReview = () => must(applyAll(running(), [{ kind: "SubmitForReview", commit: "abc" }])).task;
const delivered = () => must(applyAll(inReview(), [{ kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "approve" }, { kind: "DeliveredCard" }])).task;

const SAMPLE: { [K in EventKind]: Extract<TaskEvent, { kind: K }> } = {
  Claim: { kind: "Claim", by: "x" }, Dispatch: { kind: "Dispatch", computeId: "c", model: "gpt-6" },
  ProducerModelAdded: { kind: "ProducerModelAdded", model: "gpt-6" }, NeedHuman: { kind: "NeedHuman", qId: "q" },
  HumanReply: { kind: "HumanReply", qId: "q", constraintVer: 0, answer: "approve" }, Amend: { kind: "Amend", by: "u1" },
  SubmitForReview: { kind: "SubmitForReview", commit: "c" }, Review: { kind: "Review", reviewerId: "r", reviewerModel: "gpt-6", verdict: "approve" },
  DeliveredCard: { kind: "DeliveredCard" }, UserAccept: { kind: "UserAccept", by: "u1" }, UserReject: { kind: "UserReject", by: "u1", computeResumable: true },
  AcceptTimeout: { kind: "AcceptTimeout" }, Cancel: { kind: "Cancel", by: "u1" }, StoppedConfirmed: { kind: "StoppedConfirmed" }, ExecFailed: { kind: "ExecFailed" },
};
const inState = (s: TaskState): Task => ({ ...newTask("t", "u1"), state: s, owner: "o", computeId: "cc" });

test("AC-09 每个状态×每个事件都有明确处理:拒绝格实际拒绝并给出原因,忽略格实际不改任务", () => {
  for (const s of STATES) for (const e of EVENT_KINDS) {
    const cell = TABLE[s][e];
    assert.ok(cell && ["go", "reject", "ignore"].includes(cell.kind), `${s} × ${e} 是空白格`);
    const t = inState(s);
    const r = apply(t, SAMPLE[e]);
    if (cell.kind === "reject") {
      assert.equal(r.ok, false, `${s} × ${e} 应拒绝`);
      assert.ok(!r.ok && r.reason.includes(cell.reason) && cell.reason.length > 0, `${s} × ${e} 拒绝但没给出表里的原因`);
    }
    if (cell.kind === "ignore") {
      assert.ok(cell.reason.length > 0, `${s} × ${e} 忽略但没写原因`);
      assert.deepEqual(r, { ok: true, task: t, effects: [] }, `${s} × ${e} 应原样忽略`);
    }
  }
});

test("applyAll 遇到第一个被拒的事件就停,返回原因,不应用后面的事件", () => {
  const r = applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "a" }, { kind: "Claim", by: "b" }, { kind: "Cancel", by: "u1" }]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /重复认领/);
});

test("AC-09 表外的组合被拒并给出原因,不会悄悄改状态", () => {
  const t = newTask("t1", "u1");
  const r = apply(t, { kind: "UserAccept", by: "u1" });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.length > 0);
});

test("主干:认领 → 派发 → 提审 → 跨厂商通过 → 交付待确认", () => {
  const r = applyAll(newTask("t1", "u1"), [
    { kind: "Claim", by: "claude" },
    { kind: "Dispatch", computeId: "cc-1", model: "claude-opus-5-5" },
    { kind: "SubmitForReview", commit: "abc" },
    { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "approve" },
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

test("AC-26 ① 作者自审被拒,任务停在 T5", () => {
  const r = apply(inReview(), { kind: "Review", reviewerId: "claude", reviewerModel: "gpt-6-astra", verdict: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /作者/);
});

test("AC-26 ② 审查模型与生产模型同厂商被拒", () => {
  const r = apply(inReview(), { kind: "Review", reviewerId: "argon", reviewerModel: "claude-sonnet-5-5", verdict: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /anthropic/);
});

test("AC-26 ② 半途换模:审查厂商落在累积生产厂商集合里也被拒,不只看末次模型", () => {
  const t = must(applyAll(running(), [{ kind: "ProducerModelAdded", model: "gpt-6" }, { kind: "SubmitForReview", commit: "abc" }])).task;
  assert.deepEqual(t.producerModels, ["claude-opus-5-5", "gpt-6"]);
  const r = apply(t, { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /openai/);
});

test("AC-26 ② 审查厂商只和早先的生产模型同厂商,也要拦(不能只看末次模型)", () => {
  const t = must(applyAll(running(), [{ kind: "ProducerModelAdded", model: "gpt-6" }, { kind: "SubmitForReview", commit: "abc" }])).task;
  const r = apply(t, { kind: "Review", reviewerId: "argon", reviewerModel: "claude-sonnet-5-5", verdict: "approve" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /anthropic/);
});

test("AC-26 ③ 审查或生产模型厂商认不出(unknown)被拒", () => {
  const a = apply(inReview(), { kind: "Review", reviewerId: "x", reviewerModel: "stealth/crouton-alpha", verdict: "approve" });
  assert.equal(a.ok, false);
  const t = must(applyAll(newTask("t2", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "c", model: "stealth/crouton-alpha" }, { kind: "SubmitForReview", commit: "x" }])).task;
  const b = apply(t, { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "approve" });
  assert.equal(b.ok, false);
});

test("AC-26 ④ 不同联系人、不同已知厂商 → 合规通过进入交付", () => {
  const r = apply(inReview(), { kind: "Review", reviewerId: "argon", reviewerModel: "gemini-4-argon", verdict: "approve" });
  assert.ok(r.ok);
  assert.equal(r.ok && r.task.state, "T7_Delivering");
  assert.equal(r.ok && r.task.reviewGate, "compliant");
});

test("AC-26 ⑤ 提出者本人豁免同厂商:允许推进但记为 Waived,不是合规", () => {
  const r = apply(inReview(), { kind: "Review", reviewerId: "argon", reviewerModel: "claude-sonnet-5-5", verdict: "approve", waiverBy: "u1" });
  assert.ok(r.ok);
  assert.equal(r.ok && r.task.reviewGate, "waived-by-user");
  const other = apply(inReview(), { kind: "Review", reviewerId: "argon", reviewerModel: "claude-sonnet-5-5", verdict: "approve", waiverBy: "argon" });
  assert.equal(other.ok, false);
});

test("审查打回:回到执行中,默认恢复原 Compute", () => {
  const r = must(applyAll(inReview(), [{ kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "reject" }]));
  assert.equal(r.task.state, "T3_Running");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1" }]);
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

test("AC-28 条件 A:原 Compute 可恢复 → 恢复原实例,不新开(阳性埋雷)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: true }]));
  assert.equal(r.task.state, "T3_Running");
  assert.equal(r.task.computeId, "cc-1");
  assert.deepEqual(r.effects, [{ kind: "resume-compute", computeId: "cc-1" }]);
});

test("AC-28 条件 B:原 Compute 不可恢复 → 带交接摘要新开(阴性对照)", () => {
  const r = must(applyAll(delivered(), [{ kind: "UserReject", by: "u1", computeResumable: false }]));
  assert.equal(r.task.state, "T3_Running");
  assert.deepEqual(r.effects, [{ kind: "spawn-compute", withHandoff: true }]);
});

test("AC-19 确认卡绑定版本:用户中途改条件后,旧卡的回复作废不执行", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1" }])).task;
  assert.equal(blocked.state, "T4b_BlockedOnHuman");
  const amended = must(applyAll(blocked, [{ kind: "Amend", by: "u1" }])).task;
  assert.equal(amended.state, "T3_Running");
  assert.equal(amended.constraintVer, 1);
  const stale = apply(amended, { kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" });
  assert.ok(stale.ok);
  assert.equal(stale.ok && stale.task.state, "T3_Running");
  assert.equal(stale.ok && stale.task.pendingQ, null);
});

test("AC-19 同一张卡在新版本下重新发出后,旧版本的回复被忽略,新卡仍待回复", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1" }])).task;
  const reasked = must(applyAll(blocked, [{ kind: "Amend", by: "u1" }, { kind: "NeedHuman", qId: "q1" }])).task;
  assert.deepEqual(reasked.pendingQ, { qId: "q1", constraintVer: 1 });
  const staleApprove = must(applyAll(reasked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }])).task;
  assert.equal(staleApprove.state, "T4b_BlockedOnHuman");
  assert.deepEqual(staleApprove.pendingQ, { qId: "q1", constraintVer: 1 });
  const staleReject = must(applyAll(reasked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "reject" }])).task;
  assert.equal(staleReject.state, "T4b_BlockedOnHuman");
});

test("AC-19 拒绝当前版本的卡会停止任务", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1" }])).task;
  const r = must(applyAll(blocked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "reject" }]));
  assert.equal(r.task.state, "T9_StopRequested");
  assert.deepEqual(r.effects, [{ kind: "stop-compute", computeId: "cc-1" }]);
});

test("AC-19 版本未变的确认正常放行(阴性对照)", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1" }])).task;
  const r = must(applyAll(blocked, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }])).task;
  assert.equal(r.state, "T3_Running");
  assert.equal(r.pendingQ, null);
});

test("AC-19 绑定的卡片号不对的回复被拒", () => {
  const blocked = must(applyAll(running(), [{ kind: "NeedHuman", qId: "q1" }])).task;
  assert.equal(apply(blocked, { kind: "HumanReply", qId: "q9", constraintVer: 0, answer: "approve" }).ok, false);
});

test("取消在途任务:先请求停止,真实停止确认后才进终态并释放槽位", () => {
  const r1 = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }]));
  assert.equal(r1.task.state, "T9_StopRequested");
  assert.deepEqual(r1.effects, [{ kind: "stop-compute", computeId: "cc-1" }]);
  const r2 = must(applyAll(r1.task, [{ kind: "StoppedConfirmed" }]));
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
});

test("停止期间重复取消幂等,终态后迟到的事件不复活任务", () => {
  const stopping = must(applyAll(running(), [{ kind: "Cancel", by: "u1" }])).task;
  const again = must(applyAll(stopping, [{ kind: "Cancel", by: "u1" }]));
  assert.equal(again.task.state, "T9_StopRequested");
  assert.deepEqual(again.effects, []);
  const done = must(applyAll(stopping, [{ kind: "StoppedConfirmed" }])).task;
  const late = must(applyAll(done, [{ kind: "HumanReply", qId: "q1", constraintVer: 0, answer: "approve" }, { kind: "ExecFailed" }]));
  assert.equal(late.task.state, "T10_Cancelled");
});

test("执行失败先停止再进失败终态", () => {
  const r = must(applyAll(running(), [{ kind: "ExecFailed" }, { kind: "StoppedConfirmed" }]));
  assert.equal(r.task.state, "T11_Failed");
});

test("改条件让版本单调递增,提审中改条件作废当前评审并回到执行", () => {
  const t = must(applyAll(inReview(), [{ kind: "Amend", by: "u1" }, { kind: "Amend", by: "u1" }])).task;
  assert.equal(t.constraintVer, 2);
  assert.equal(t.state, "T3_Running");
  assert.equal(t.reviewedCommit, null);
});

test("状态转移不改入参任务", () => {
  const t = inReview();
  const saved = JSON.stringify(t);
  const reviewed = apply(t, { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", verdict: "approve" });
  const amended = apply(t, { kind: "Amend", by: "u1" });
  assert.equal(JSON.stringify(t), saved);
  assert.equal(reviewed.ok && reviewed.task.state, "T7_Delivering");
  assert.equal(amended.ok && amended.task.constraintVer, 1);
});
