// Q09 最小闭环:交活后没有审查(找不到合格审查人,或审查没做成)也进 T8a 待确认(需求 §8.1 已定 1、AC-28);
// 不说话不算通过、没有超时出口;提出者本人验收这件没经审查的交付时如实记 waived-by-user,不记合规(AC-26 ⑤)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, applyAll, newTask, type Outcome, type TaskEvent, validateEvent } from "./task.ts";

const must = (r: Outcome) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const running = () => must(applyAll(newTask("t1", "u1"), [{ kind: "Claim", by: "claude" }, { kind: "Dispatch", computeId: "cc-1", model: "claude-opus-5-5", requestId: "t1#L0" }])).task;
const inReview = () => must(apply(running(), { kind: "SubmitForReview", commit: "abc", computeId: "cc-1", constraintVer: 0 })).task;
const NO_REVIEW: TaskEvent = { kind: "ReviewUnavailable", round: 1, commit: "abc", constraintVer: 0 };
const unreviewedDelivered = () => must(applyAll(inReview(), [NO_REVIEW, { kind: "DeliveredCard", taskId: "t1", deliveryRound: 1, commit: "abc" }])).task;

test("Q09 A0 没有审查:提审这一轮无审查 → 分配交付代次并发卡,发出后进 T8a 待确认,门禁如实留 none", () => {
  const r = must(apply(inReview(), NO_REVIEW));
  assert.equal(r.task.state, "T7_Delivering");
  assert.equal(r.task.reviewGate, "none", "没审过不能记合规");
  assert.equal(r.task.approval, null);
  assert.deepEqual(r.task.delivery, { round: 1, commit: "abc" });
  assert.deepEqual(r.effects, [{ kind: "send-card", taskId: "t1", deliveryRound: 1, commit: "abc", constraintVer: 0 }]);
  const t = unreviewedDelivered();
  assert.equal(t.state, "T8a_Delivered");
  assert.equal(t.badge, "none", "交付不等于验收");
  // 事件形状:round 必须是正整数、commit 非空、constraintVer 非负整数
  assert.equal(validateEvent(NO_REVIEW), null);
  assert.notEqual(validateEvent({ kind: "ReviewUnavailable", round: 0, commit: "abc", constraintVer: 0 }), null);
  assert.notEqual(validateEvent({ kind: "ReviewUnavailable", round: 1, commit: " ", constraintVer: 0 }), null);
  assert.notEqual(validateEvent({ kind: "ReviewUnavailable", round: 1, commit: "abc" }), null);
});

test("Q09 A0 沉默:T8a 待确认的超时事件被拒,任何时长后都不自动通过", () => {
  const t = unreviewedDelivered();
  const r = apply(t, { kind: "AcceptTimeout", taskId: "t1", deliveryRound: 1, commit: "abc" });
  assert.equal(r.ok, false);
  assert.equal(t.state, "T8a_Delivered");
});

test("Q09 A2 提出者本人验收没经审查的交付 → T8_Accepted,记 waived-by-user(本人豁免,不算合规)", () => {
  const r = must(apply(unreviewedDelivered(), { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 1, commit: "abc" }));
  assert.equal(r.task.state, "T8_Accepted");
  assert.equal(r.task.badge, "accepted");
  assert.equal(r.task.reviewGate, "waived-by-user");
  // 对照:合规审查过的交付被本人验收,门禁仍是 compliant,不被改记成豁免
  const reviewed = must(applyAll(inReview(), [
    { kind: "Review", reviewerId: "astra", reviewerModel: "gpt-6-astra", round: 1, commit: "abc", constraintVer: 0, verdict: "approve" },
    { kind: "DeliveredCard", taskId: "t1", deliveryRound: 1, commit: "abc" },
    { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 1, commit: "abc" },
  ])).task;
  assert.equal(reviewed.state, "T8_Accepted");
  assert.equal(reviewed.reviewGate, "compliant");
});

test("Q09 A2 阴性 他人验收被拒:不是提出者的确认不推进,任务留在 T8a、门禁仍 none", () => {
  const t = unreviewedDelivered();
  const r = apply(t, { kind: "UserAccept", taskId: "t1", by: "someone-else", deliveryRound: 1, commit: "abc" });
  assert.equal(r.ok, false);
  assert.equal(t.state, "T8a_Delivered");
  assert.equal(t.reviewGate, "none");
});

test("Q09 A2 阴性 旧版本:退回返工后再交付,上一代次的验收回包被忽略,只认当前代次", () => {
  const back = must(apply(unreviewedDelivered(), { kind: "UserReject", taskId: "t1", by: "u1", computeResumable: true, deliveryRound: 1, commit: "abc" })).task;
  assert.equal(back.state, "T3_Running");
  const again = must(applyAll(back, [
    { kind: "SubmitForReview", commit: "def", computeId: "cc-1", constraintVer: 1 },
    { kind: "ReviewUnavailable", round: 2, commit: "def", constraintVer: 1 },
    { kind: "DeliveredCard", taskId: "t1", deliveryRound: 2, commit: "def" },
  ])).task;
  assert.equal(again.state, "T8a_Delivered");
  const stale = must(apply(again, { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 1, commit: "abc" })).task;
  assert.equal(stale.state, "T8a_Delivered", "第一版的通过不算第二版的验收");
  assert.equal(stale.badge, "none");
  const cur = must(apply(again, { kind: "UserAccept", taskId: "t1", by: "u1", deliveryRound: 2, commit: "def" })).task;
  assert.equal(cur.state, "T8_Accepted");
});

test("Q09 A0 过期的无审查结论被忽略:轮次、commit 或条件版本对不上都不推进,当前提审继续等", () => {
  const t = inReview();
  for (const e of [
    { kind: "ReviewUnavailable", round: 2, commit: "abc", constraintVer: 0 },
    { kind: "ReviewUnavailable", round: 1, commit: "zzz", constraintVer: 0 },
    { kind: "ReviewUnavailable", round: 1, commit: "abc", constraintVer: 1 },
  ] as TaskEvent[]) {
    const r = must(apply(t, e));
    assert.equal(r.task.state, "T5_InReview");
    assert.deepEqual(r.effects, []);
  }
});

test("Q09 A0 不在审查中时无审查结论不生效:执行中被拒;已交付后迟到的忽略,不改状态", () => {
  assert.equal(apply(running(), { kind: "ReviewUnavailable", round: 1, commit: "abc", constraintVer: 0 }).ok, false);
  const t = unreviewedDelivered();
  const r = must(apply(t, NO_REVIEW));
  assert.equal(r.task.state, "T8a_Delivered");
  assert.deepEqual(r.task.delivery, { round: 1, commit: "abc" }, "不重复分配交付代次");
});
