import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import type { RoomView } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { roomBlockedSummary } from "./room-blocked-summary.ts";
import { createService } from "./service.ts";
import { cleanupKit, closeKitHosts, setup } from "./test-kit.ts";

afterEach(() => closeKitHosts());
after(() => cleanupKit());

async function settle(host: Host, compute: { drained(): boolean }) {
  for (let n = 0; n < 100; n++) {
    await Promise.race([host.idle(), new Promise((resolve) => setTimeout(resolve, 50))]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (compute.drained() && !host.loop.busy()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (compute.drained() && !host.loop.busy()) return;
    }
  }
  throw new Error("阻塞夹具未在有界等待内结束");
}

async function blocked() {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "fixture", resumed: false }, { kind: "blocked", needs: "请给中性验证码", summary: "等待测试输入" }] });
  const s = setup({ compute: () => compute.adapter });
  const c = s.host.createContact({ name: "测试联系人" });
  const dm = s.host.openDm(c.id);
  s.host.send({ roomId: dm.id, clientActionId: "create-blocked", text: "帮我登录测试页面" });
  await settle(s.host, compute);
  const task = s.host.listTasks({ roomId: dm.id })[0]!;
  assert.equal(task.state, "T4b_BlockedOnHuman", "夹具必须真正走到等待用户");
  return { ...s, compute, dm, task };
}

test("阻塞摘要按最早消息顺序选择并给出其余项数量", () => {
  const result = roomBlockedSummary([{ taskId: "later", seq: 9, text: "第二项" }, { taskId: "first", seq: 3, text: "第一项" }]);
  assert.equal(result, "等待你：第一项（另有 1 项）");
});

test("没有阻塞时不给出虚构摘要", () => {
  const result = roomBlockedSummary([]);
  assert.equal(result, null);
});

test("阻塞摘要折为一行并限制为合同允许的长度", () => {
  const result = roomBlockedSummary([{ taskId: "task", seq: 1, text: `  需要\n输入\t${"中".repeat(600)} ` }]);
  assert.equal(result, `等待你：需要 输入 ${"中".repeat(489)}…`);
});

test("rooms.get 返回真实阻塞原因且读取不改变任务与已读游标", async () => {
  const s = await blocked();
  try {
    const before = [s.host.taskViewById(s.task.id).stateVer, s.host.readSeq(s.dm.id, { kind: "user", id: s.host.userId })];
    const got = await s.svc.handle("rooms.get", { roomId: s.dm.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, "等待你：请给中性验证码");
    assert.deepEqual([s.host.taskViewById(s.task.id).stateVer, s.host.readSeq(s.dm.id, { kind: "user", id: s.host.userId })], before);
  } finally { s.compute.close(); }
});

test("回答生效后阻塞摘要消失并经 room.updated 推送", async () => {
  const s = await blocked();
  try {
    const updates: RoomView[] = [];
    const unsubscribe = s.svc.subscribe((event) => { if (event.type === "room.updated" && event.room.id === s.dm.id) updates.push(event.room); });
    const answered = await s.svc.handle("tasks.answer", { taskId: s.task.id, qId: s.task.pendingQuestion!.qId, clientActionId: "answer-once", answer: "NEUTRAL_FIXTURE" });
    assert.ok(answered.ok);
    await settle(s.host, s.compute);
    const got = await s.svc.handle("rooms.get", { roomId: s.dm.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, null);
    assert.equal(updates.at(-1)?.blockedSummary, null);
    unsubscribe();
  } finally { s.compute.close(); }
});

test("其他会话没有本会话的阻塞摘要", async () => {
  const s = await blocked();
  try {
    const other = s.host.createGroup("另一个群", []);
    // 两个会话可以有同号消息；不能靠 seq 碰巧不重合代替会话作用域校验。
    const last = s.host.lastSeq(s.dm.id);
    for (let i = 0; i < last; i++) s.host.send({ roomId: other.id, clientActionId: `other-${i}`, text: "另一个会话的中性消息" });
    const got = await s.svc.handle("rooms.get", { roomId: other.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, null);
  } finally { s.compute.close(); }
});

test("重启回收后的失败任务不再显示已过期的待答摘要", async () => {
  const s = await blocked();
  s.compute.close();
  await s.host.close();
  const reopened = new Host({ mind: () => scriptedMind(), file: `${s.root}/gg.db`, dataDir: `${s.root}/data`, catalogFile: `${s.catalog}/catalog.json` });
  try {
    assert.equal(reopened.taskViewById(s.task.id).state, "T11_Failed", "现有宿主会把失联 Compute 回收为失败，不能显示旧的待答缓存");
    const got = await createService(reopened).handle("rooms.get", { roomId: s.dm.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, null);
  } finally { await reopened.close(); }
});
