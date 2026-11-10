// AC-15 按交付版本恢复，A-1/A-2 接缝；不按消息或数组顺序。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FollowUps, rebindOut, confirmRollbackStopped, rebindFollowUp } from "./followups.ts";
import { newTask, applyAll } from "./task.ts";
function links(): FollowUps {
  return { taskId: "A", bindingVer: 0, pendingRollback: null, links: [1, 3, 2, 2].map((v, i) => ({ roomId: "r", seq: i + 1, text: `要求${i}`, state: "Applied", ver: v, appliedVer: v, appliedIn: `git:v${v}`, reboundTo: null })) };
}
const input = { roomId: "r", seq: 4, toTaskId: "B", expectedBindingVer: 0 };
function task(id: string) {
  const r = applyAll(newTask(id, "u"), [{ kind: "Claim", by: "c" }, { kind: "Dispatch", computeId: `cp-${id}`, model: "claude-opus-5-5", requestId: `q-${id}` }]);
  if (!r.ok) throw new Error(r.reason);
  return { ...r.task, constraintVer: 3 };
}
test("A01 同一交付中挂得更早的补充也退回 Received", () => {
  const r = rebindOut(links(), input, 4, null);
  assert.ok(r.ok);
  assert.equal(r.value.links[2]!.state, "Received");
});
test("A02 严格按 appliedVer 回退而非挂入顺序", () => {
  const r = rebindOut(links(), input, 4, null);
  assert.ok(r.ok);
  assert.deepEqual(r.value.links.map(l => l.state), ["Applied", "Received", "Received", "Rebound"]);
});
test("A03 恢复携带原交付身份且重放不等于落实", () => {
  const r = rebindOut(links(), input, 4, null);
  assert.ok(r.ok);
  assert.deepEqual(r.effects.map(e => [e.kind, Reflect.get(e, "fromAppliedVer"), Reflect.get(e, "fromArtifact")]), [["restore-workspace", 2, "git:v2"]]);
  assert.equal(r.value.links[2]!.appliedIn, null);
});
test("A04 停止确认前无恢复且确认透传原交付身份", () => {
  const r = rebindOut(links(), input, 4, "cp-A");
  assert.ok(r.ok);
  assert.deepEqual(r.effects.map(e => e.kind), ["stop-for-rollback"]);
  const wait = confirmRollbackStopped(r.value, "other");
  assert.ok(wait.ok); assert.equal(wait.effects.length, 0);
  const stopped = confirmRollbackStopped(r.value, "cp-A");
  assert.ok(stopped.ok);
  assert.equal(Reflect.get(stopped.effects[0]!, "fromArtifact"), "git:v2");
});
test("A18 已合入只移走并升版其余 Applied 不动也不重放", () => {
  const r = rebindFollowUp({ task: task("A"), followUps: links() }, { task: task("B"), followUps: { taskId: "B", bindingVer: 0, links: [], pendingRollback: null } }, { roomId: "r", seq: 4, expectedBindingVer: 0, by: "u", computeResumable: true, recoveryMode: "merged" });
  assert.ok(r.ok);
  assert.equal(r.from.task.constraintVer, 4);
  assert.deepEqual(r.from.effects, []);
  assert.deepEqual(r.from.taskEffects, []);
  assert.equal(r.from.followUps.links[2]!.state, "Applied");
});
test("A19 宿主不核验仍按交付版本退回而不拒绝改挂", () => {
  const r = rebindFollowUp({ task: task("A"), followUps: links() }, { task: task("B"), followUps: { taskId: "B", bindingVer: 0, links: [], pendingRollback: null } }, { roomId: "r", seq: 4, expectedBindingVer: 0, by: "u", computeResumable: true, recoveryMode: "unverified" });
  assert.ok(r.ok);
  assert.equal(r.from.followUps.links[1]!.state, "Received");
});
