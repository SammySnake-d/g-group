import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import type { RoomView } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { one } from "./db.ts";
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
  const svc = createService(s.host);
  try {
    const before = [s.host.taskViewById(s.task.id).stateVer, s.host.readSeq(s.dm.id, { kind: "user", id: s.host.userId })];
    const got = await svc.handle("rooms.get", { roomId: s.dm.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, "等待你：请给中性验证码");
    assert.deepEqual([s.host.taskViewById(s.task.id).stateVer, s.host.readSeq(s.dm.id, { kind: "user", id: s.host.userId })], before);
  } finally { s.compute.close(); }
});

test("回答生效后阻塞摘要消失并经 room.updated 推送", async () => {
  const s = await blocked();
  const svc = createService(s.host);
  try {
    const updates: RoomView[] = [];
    const unsubscribe = svc.subscribe((event) => { if (event.type === "room.updated" && event.room.id === s.dm.id) updates.push(event.room); });
    const answered = await svc.handle("tasks.answer", { taskId: s.task.id, qId: s.task.pendingQuestion!.qId, clientActionId: "answer-once", answer: "NEUTRAL_FIXTURE" });
    assert.ok(answered.ok);
    await settle(s.host, s.compute);
    const got = await svc.handle("rooms.get", { roomId: s.dm.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, null);
    assert.equal(updates.at(-1)?.blockedSummary, null);
    unsubscribe();
  } finally { s.compute.close(); }
});

test("其他会话没有本会话的阻塞摘要", async () => {
  const s = await blocked();
  const svc = createService(s.host);
  try {
    const other = s.host.createGroup("另一个群", []);
    // 两个会话可以有同号消息；不能靠 seq 碰巧不重合代替会话作用域校验。
    const last = s.host.lastSeq(s.dm.id);
    for (let i = 0; i < last; i++) s.host.send({ roomId: other.id, clientActionId: `other-${i}`, text: "另一个会话的中性消息" });
    const got = await svc.handle("rooms.get", { roomId: other.id });
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

test("R2-05 长问题截断保留另有 N 项尾注且整行不超过500", () => {
  const result = roomBlockedSummary([{ taskId: "first", seq: 1, text: "中".repeat(600) }, { taskId: "later", seq: 2, text: "下一项" }]);
  assert.equal(result, `等待你：${"中".repeat(487)}…（另有 1 项）`);
  assert.equal(result.length, 500);
});

test("R2-01 宿主最早问题与另有一项在回答后切换为剩余问题", async () => {
  let n = 0;
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: `two-${++n}`, resumed: false }, { kind: "blocked", needs: `问题${n}`, summary: "等待测试输入" }] });
  const s = setup({ compute: () => compute.adapter });
  const svc = createService(s.host);
  try {
    const a = s.host.createContact({ name: "甲" });
    const b = s.host.createContact({ name: "乙" });
    const room = s.host.createGroup("两个独立问题", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
    s.host.send({ roomId: room.id, clientActionId: "first", text: "帮我登录页面甲", mentions: [{ id: a.id, source: "manual" }] });
    await settle(s.host, compute);
    s.host.send({ roomId: room.id, clientActionId: "later", text: "帮我登录页面乙", mentions: [{ id: b.id, source: "manual" }] });
    await settle(s.host, compute);
    const tasks = s.host.listTasks({ roomId: room.id });
    assert.equal(tasks.filter((t) => t.state === "T4b_BlockedOnHuman").length, 2);
    const got = await svc.handle("rooms.get", { roomId: room.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, "等待你：问题1（另有 1 项）");
    const first = tasks.find((t) => t.pendingQuestion?.text === "问题1")!;
    const answered = await svc.handle("tasks.answer", { taskId: first.id, qId: first.pendingQuestion!.qId, clientActionId: "answer-first", answer: "中性输入" });
    assert.ok(answered.ok);
    await settle(s.host, compute);
    const next = await svc.handle("rooms.get", { roomId: room.id });
    assert.equal(next.ok && (next.value as RoomView).blockedSummary, "等待你：问题2");
  } finally { compute.close(); }
});

test("R2-02a 整行499字符不截断", () => {
  const result = roomBlockedSummary([{ taskId: "a", seq: 1, text: "中".repeat(495) }]);
  assert.equal(result, `等待你：${"中".repeat(495)}`);
  assert.equal(result.length, 499);
});

test("R2-02b 整行恰500字符不截断", () => {
  const result = roomBlockedSummary([{ taskId: "a", seq: 1, text: "中".repeat(496) }]);
  assert.equal(result, `等待你：${"中".repeat(496)}`);
  assert.equal(result.length, 500);
});

test("R2-02c 整行501字符截为499加省略号", () => {
  const result = roomBlockedSummary([{ taskId: "a", seq: 1, text: "中".repeat(497) }]);
  assert.equal(result, `等待你：${"中".repeat(495)}…`);
  assert.equal(result.length, 500);
});

test("R2-03 授权提问摘要取真实授权请求action而不是不存在的needs", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "authorization", resumed: false }, { kind: "blocked", needs: "要改 app.ts 加导出函数", summary: "读完准备修改" }] });
  const s = setup({ compute: () => compute.adapter });
  const svc = createService(s.host);
  try {
    const c = s.host.createContact({ name: "受群规约束的联系人" });
    const room = s.host.createGroup("授权问题", [{ kind: "contact", id: c.id }]);
    s.host.updateRoom(room.id, { rules: "改代码前先问我" });
    s.host.send({ roomId: room.id, clientActionId: "needs-consent", text: "帮我给 app.ts 加个导出", mentions: [{ id: c.id, source: "manual" }] });
    await settle(s.host, compute);
    const task = s.host.listTasks({ roomId: room.id })[0]!;
    assert.equal(task.state, "T4b_BlockedOnHuman");
    assert.equal(task.authorizations?.[0]?.action, "要改 app.ts 加导出函数");
    const card = one<{ meta: string }>(s.host.db, "SELECT meta FROM gg_cards WHERE task_id = ? AND kind = 'question'", task.id)!;
    assert.equal(JSON.parse(card.meta).authz, true);
    assert.equal(JSON.parse(card.meta).needs, undefined);
    const got = await svc.handle("rooms.get", { roomId: room.id });
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, "等待你：要改 app.ts 加导出函数");
  } finally { compute.close(); }
});

test("R2-04b 取消后旧问题仍可见且保留pendingQ但过期卡不能生成摘要", async () => {
  const s = await blocked();
  try {
    assert.equal(s.host.roomView(s.dm.id).blockedSummary, "等待你：请给中性验证码");
    s.host.stopTask(s.task.id, s.host.userId);
    const doc = s.host.taskDoc(s.task.id).value;
    assert.equal(doc.task.state, "T9_StopRequested");
    assert.ok(doc.task.pendingQ);
    const card = one<{ seq: number; state: string }>(s.host.db, "SELECT seq, state FROM gg_cards WHERE task_id = ? AND kind = 'question'", s.task.id)!;
    assert.equal(card.state, "expired");
    assert.ok(s.host.listMessages(s.dm.id, {}).messages.some((m) => m.seq === card.seq && !m.retracted));
    assert.equal(s.host.roomView(s.dm.id).blockedSummary, null);
  } finally { s.compute.close(); }
});

test("R2-04c 当前宿主拒绝用户撤回联系人提问且当前open卡仍可见", async () => {
  const s = await blocked();
  const svc = createService(s.host);
  try {
    assert.equal(s.host.roomView(s.dm.id).blockedSummary, "等待你：请给中性验证码");
    const card = one<{ seq: number; state: string }>(s.host.db, "SELECT seq, state FROM gg_cards WHERE task_id = ? AND kind = 'question'", s.task.id)!;
    const retracted = await svc.handle("messages.retract", { roomId: s.dm.id, seq: card.seq });
    assert.ok(!retracted.ok);
    assert.equal(retracted.error.code, "forbidden");
    assert.equal(s.host.taskDoc(s.task.id).value.task.state, "T4b_BlockedOnHuman");
    assert.equal(one<{ state: string }>(s.host.db, "SELECT state FROM gg_cards WHERE task_id = ? AND kind = 'question'", s.task.id)!.state, "open");
    assert.ok(s.host.listMessages(s.dm.id, {}).messages.some((m) => m.seq === card.seq && !m.retracted));
    assert.equal(s.host.roomView(s.dm.id).blockedSummary, "等待你：请给中性验证码");
  } finally { s.compute.close(); }
});

test("R2-06 rooms.get不产生幂等数据库写入也不发送事件", async () => {
  const s = await blocked();
  const svc = createService(s.host);
  try {
    const events: unknown[] = [];
    const unsubscribe = svc.subscribe((event) => events.push(event));
    const before = one<{ n: number }>(s.host.db, "SELECT total_changes() AS n")!.n;
    const got = await svc.handle("rooms.get", { roomId: s.dm.id });
    const afterRead = one<{ n: number }>(s.host.db, "SELECT total_changes() AS n")!.n;
    unsubscribe();
    assert.equal(got.ok && (got.value as RoomView).blockedSummary, "等待你：请给中性验证码");
    assert.equal(afterRead, before);
    assert.deepEqual(events, []);
  } finally { s.compute.close(); }
});

test("R2-07 Unicode截断不留下孤立高代理码元", () => {
  const result = roomBlockedSummary([{ taskId: "a", seq: 1, text: `${"中".repeat(494)}😀😀😀` }]);
  assert.equal(result, `等待你：${"中".repeat(494)}…`);
  assert.equal(result.length, 499);
  assert.doesNotMatch(result, /[\uD800-\uDFFF]/u);
});
