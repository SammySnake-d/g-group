// AC-23 临时 Compute 不跨群、停止确认后归还(宿主一侧):取消请求与实际停止分开;确认前不把槽位给冲突后继;
// 慢工具运行中不释放;群临时槽位只给本群;停不干净就不归还并写明。用确定性替身,不起真实进程(真实进程见适配器 quiesce 测试)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { QuiesceResult } from "@g-group/adapter-cc-compute";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-lease-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(root, `h${++n}.db`);
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await tick();
  }
}
/** 一直跑、不自己结束的 Compute(慢工具);停止确认由测试手动放行 */
function longRunning() {
  const gates = new Map<string, (r: QuiesceResult) => void>();
  const asked: string[] = [];
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }],
    quiesce: (id) => {
      asked.push(id);
      return new Promise((r) => gates.set(id, r));
    },
  });
  return { compute, asked, finish: (id: string, r: QuiesceResult = { ok: true, killed: 1 }) => gates.get(id)?.(r) };
}
const taskOf = (host: Host, roomId: string) => host.listTasks({ roomId })[0]!;

test("取消后进程没确认退出前:任务停在 T9、槽位不归还、排队的不开工;确认后才 T10、归还并让排队的开工", async () => {
  const lr = longRunning();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个很慢的脚本" });
  await until(() => lr.compute.spawned.length === 1 && taskOf(host, dm.id)?.state === "T3_Running", "第一个任务开跑");
  const t1 = taskOf(host, dm.id);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我再写个文件" });
  await until(() => host.listTasks({ roomId: dm.id }).length === 2, "第二个任务建好");
  const t2 = host.listTasks({ roomId: dm.id }).find((t) => t.id !== t1.id)!;
  assert.equal(lr.compute.spawned.length, 1, "个人槽位只有 1 个,第二个排队");
  assert.equal(host.taskView(host.taskDoc(t2.id).value).waitingFor, `个人算力正被 ${dm.id} 里的任务占用;排队等,或转交别人`);

  host.taskDecision(t1.id, "cancel", "c1");
  await until(() => lr.asked.length === 1, "宿主去确认停止");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(host.taskDoc(t1.id).value.task.state, "T9_StopRequested", "停止请求发出 ≠ 已停止");
  assert.equal(host.quota.leaseOf(t1.id)?.stopping, true);
  assert.equal(lr.compute.spawned.length, 1, "确认前不把槽位给后继");

  lr.finish(lr.asked[0]!);
  await until(() => host.taskDoc(t1.id).value.task.state === "T10_Cancelled", "确认后落 T10");
  await until(() => lr.compute.spawned.length === 2, "排队的开工");
  assert.equal(host.quota.leaseOf(t1.id), undefined);
  assert.equal(host.quota.leaseOf(t2.id)?.scope, `personal:${c.id}`);
  assert.equal(host.taskView(host.taskDoc(t2.id).value).waitingFor, null);
  lr.compute.close();
  await host.close();
});

test("停不干净(进程没全退出):不确认停止、不归还槽位,任务视图写明停止未确认", async () => {
  const lr = longRunning();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个很慢的脚本" });
  await until(() => taskOf(host, dm.id)?.state === "T3_Running", "开跑");
  const t1 = taskOf(host, dm.id);
  host.taskDecision(t1.id, "cancel", "c1");
  await until(() => lr.asked.length === 1, "宿主去确认停止");
  lr.finish(lr.asked[0]!, { ok: false, reason: "还有 1 个进程没退出", remaining: [4242] });
  await until(() => host.taskView(host.taskDoc(t1.id).value).waitingFor !== null, "写明原因");
  assert.equal(host.taskView(host.taskDoc(t1.id).value).waitingFor, "停止未确认:还有 1 个进程没退出(pid 4242)");
  assert.equal(host.taskDoc(t1.id).value.task.state, "T9_StopRequested");
  assert.ok(host.quota.leaseOf(t1.id), "槽位仍占着");
  lr.compute.close();
  await host.close();
});

test("群临时 Compute 不跨群:个人满了借本群临时槽位;B 群没有临时槽位就排队,不挪用 A 群的", async () => {
  const lr = longRunning();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小前" });
  host.updateContact(c.id, { computeSlots: 1 });
  const ga = host.createGroup("A 群", [{ kind: "contact", id: c.id }]);
  const gb = host.createGroup("B 群", [{ kind: "contact", id: c.id }]);
  assert.equal(host.updateRoom(ga.id, { tempComputeSlots: 2 }).tempComputeSlots, 2);
  assert.equal(host.roomView(gb.id).tempComputeSlots, 0);
  const at = [{ id: c.id, source: "manual" as const }];
  host.send({ roomId: ga.id, clientActionId: "a1", text: "帮我改组件一", mentions: at });
  await until(() => lr.compute.spawned.length === 1, "A1 开跑");
  host.send({ roomId: ga.id, clientActionId: "a2", text: "帮我改组件二", mentions: at });
  await until(() => lr.compute.spawned.length === 2, "A2 借 A 群临时槽位开跑");
  host.send({ roomId: gb.id, clientActionId: "b1", text: "帮我修个 bug", mentions: at });
  await until(() => host.listTasks({ roomId: gb.id }).length === 1, "B1 建好");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(lr.compute.spawned.length, 2, "A 群还有 1 个临时空位,B 群也不能用");
  const [a1, a2] = host.listTasks({ roomId: ga.id }).sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  assert.deepEqual([host.quota.leaseOf(a1!.id)?.scope, host.quota.leaseOf(a2!.id)?.scope].sort(), [`group:${ga.id}`, `personal:${c.id}`].sort());
  const b1 = taskOf(host, gb.id);
  assert.equal(host.taskView(host.taskDoc(b1.id).value).waitingFor, `个人算力正被 ${ga.id} 里的任务占用,本群临时 Compute 也满了;排队等,或转交别人`);
  assert.throws(() => host.updateRoom(host.openDm(c.id).id, { tempComputeSlots: 1 }), /私聊没有群临时/);
  lr.compute.close();
  await host.close();
});

test("排队中的任务被取消:不再排队、直接落 T10,之后空出的槽位不会再起它", async () => {
  const lr = longRunning();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个很慢的脚本" });
  await until(() => taskOf(host, dm.id)?.state === "T3_Running", "开跑");
  const t1 = taskOf(host, dm.id);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我再写个文件" });
  await until(() => host.listTasks({ roomId: dm.id }).length === 2, "第二个任务建好");
  const t2 = host.listTasks({ roomId: dm.id }).find((t) => t.id !== t1.id)!;
  host.taskDecision(t2.id, "cancel", "c2");
  await until(() => host.taskDoc(t2.id).value.task.state === "T10_Cancelled", "排队的取消即落 T10");
  host.taskDecision(t1.id, "cancel", "c1");
  await until(() => lr.asked.length === 1, "确认停止");
  lr.finish(lr.asked[0]!);
  await until(() => host.taskDoc(t1.id).value.task.state === "T10_Cancelled", "T1 落 T10");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(lr.compute.spawned.length, 1, "取消了的排队任务不再被起");
  assert.deepEqual(host.quota.view(), { leases: [], waiting: [] });
  lr.compute.close();
  await host.close();
});

test("正常完成:CLI 主进程退出(settled)后才归还槽位", async () => {
  let exit: () => void = () => {};
  const exited = new Promise<void>((r) => (exit = r));
  const compute = scriptedCompute({ settle: () => exited });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => taskOf(host, dm.id)?.state === "T8a_Delivered", "交付");
  const t1 = taskOf(host, dm.id);
  assert.ok(host.quota.leaseOf(t1.id), "主进程还没退出,槽位还占着");
  exit();
  await until(() => host.quota.leaseOf(t1.id) === undefined, "主进程退出后归还");
  compute.close();
  await host.close();
});

test("AC-23 重启:未确认停止的个人槽保留原租约,同联系人新任务不能开工", async () => {
  const f = file();
  const lr = longRunning();
  let before: Host | undefined;
  let afterRestart: Host | undefined;
  try {
    const options = { file: f, mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 };
    before = new Host(options);
    const c = before.createContact({ name: "重启个人槽" });
    const dm = before.openDm(c.id).id;
    before.send({ roomId: dm, clientActionId: "before", text: "帮我写一个报告" });
    await until(() => lr.compute.spawned.length === 1 && taskOf(before!, dm)?.state === "T3_Running", "首个任务开工");
    const first = taskOf(before, dm);
    before.taskDecision(first.id, "cancel", "stop-before");
    await until(() => lr.asked.length === 1, "开始确认停止");
    lr.finish(lr.asked[0]!, { ok: false, reason: "停止无法确认", remaining: [] });
    await until(() => before!.taskView(before!.taskDoc(first.id).value).waitingFor?.includes("停止未确认") === true, "停止未确认");
    const oldLease = before.quota.leaseOf(first.id);
    assert.ok(oldLease && oldLease.stopping);
    await before.close();
    before = undefined;

    afterRestart = new Host(options);
    afterRestart.send({ roomId: dm, clientActionId: "after", text: "帮我再写一份报告" });
    await until(() => afterRestart!.listTasks({ roomId: dm }).length === 2, "重启后第二个任务已创建");
    await afterRestart.idle();
    await tick();
    assert.deepEqual(afterRestart.quota.leaseOf(first.id), oldLease, "原 lease_id、作用域及 stopping 状态须保留");
    assert.equal(afterRestart.taskDoc(first.id).value.task.state, "T9_StopRequested");
    assert.ok("queued" in afterRestart.quota.acquire({ taskId: first.id, contactId: c.id, roomId: dm, isGroup: false }), "重启后不可复用未经确认的旧租约重跑同一任务");
    assert.equal(lr.compute.spawned.length, 1, "未确认的唯一槽位不能授给后继");
  } finally {
    if (before) await before.close();
    if (afterRestart) await afterRestart.close();
    lr.compute.close();
  }
});

test("AC-23 重启:个人与群临时槽按原租约恢复,不跨联系人或跨群占用", async () => {
  const f = file();
  const lr = longRunning();
  let before: Host | undefined;
  let afterRestart: Host | undefined;
  try {
    const options = { file: f, mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 };
    before = new Host(options);
    const c = before.createContact({ name: "重启群槽" });
    const other = before.createContact({ name: "另一联系人" });
    const ga = before.createGroup("重启 A 群", [{ kind: "contact", id: c.id }, { kind: "contact", id: other.id }]);
    const gb = before.createGroup("重启 B 群", [{ kind: "contact", id: c.id }]);
    before.updateRoom(ga.id, { tempComputeSlots: 1 });
    const mentions = [{ id: c.id, source: "manual" as const }];
    before.send({ roomId: ga.id, clientActionId: "a1", text: "帮我写组件一", mentions });
    await until(() => lr.compute.spawned.length === 1, "第一个任务开工");
    before.send({ roomId: ga.id, clientActionId: "a2", text: "帮我写组件二", mentions });
    await until(() => lr.compute.spawned.length === 2, "第二个任务借群临时槽");
    const oldLeases = before.quota.view().leases.filter((l) => l.contactId === c.id);
    assert.deepEqual(oldLeases.map((l) => l.scope).sort(), [`group:${ga.id}`, `personal:${c.id}`].sort());
    for (const lease of oldLeases) before.taskDecision(lease.taskId, "cancel", `stop-${lease.taskId}`);
    await until(() => lr.asked.length === 2, "两条停止均待确认");
    for (const computeId of lr.asked) lr.finish(computeId, { ok: false, reason: "停止无法确认", remaining: [] });
    await until(() => oldLeases.every((l) => before!.taskView(before!.taskDoc(l.taskId).value).waitingFor?.includes("停止未确认")), "两条停止均未确认");
    const stoppedLeases = oldLeases.map((l) => before!.quota.leaseOf(l.taskId)!);
    await before.close();
    before = undefined;

    afterRestart = new Host(options);
    assert.deepEqual(stoppedLeases.map((l) => afterRestart!.quota.leaseOf(l.taskId)), stoppedLeases, "租约归属和作用域不能猜测或互换");
    assert.ok("queued" in afterRestart.quota.acquire({ taskId: "new-a", contactId: c.id, roomId: ga.id, isGroup: true }));
    assert.ok("queued" in afterRestart.quota.acquire({ taskId: "new-b", contactId: c.id, roomId: gb.id, isGroup: true }));
    const independent = afterRestart.quota.acquire({ taskId: "new-other", contactId: other.id, roomId: ga.id, isGroup: true });
    assert.ok("granted" in independent && independent.granted.scope === `personal:${other.id}`, "不同联系人个人槽不受影响");
  } finally {
    if (before) await before.close();
    if (afterRestart) await afterRestart.close();
    lr.compute.close();
  }
});

test("AC-23 重启:已确认停止并归还的租约不复活,后继可开工", async () => {
  const f = file();
  const lr = longRunning();
  let before: Host | undefined;
  let afterRestart: Host | undefined;
  try {
    const options = { file: f, mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 };
    before = new Host(options);
    const c = before.createContact({ name: "正常停止" });
    const dm = before.openDm(c.id).id;
    before.send({ roomId: dm, clientActionId: "one", text: "帮我写一个报告" });
    await until(() => lr.compute.spawned.length === 1 && taskOf(before!, dm)?.state === "T3_Running", "首任务开工");
    const first = taskOf(before, dm);
    before.taskDecision(first.id, "cancel", "stop");
    await until(() => lr.asked.length === 1, "等待停止确认");
    lr.finish(lr.asked[0]!);
    await until(() => before!.taskDoc(first.id).value.task.state === "T10_Cancelled" && !before!.quota.leaseOf(first.id), "确认且归还");
    await before.close();
    before = undefined;
    afterRestart = new Host(options);
    assert.equal(afterRestart.quota.leaseOf(first.id), undefined);
    afterRestart.send({ roomId: dm, clientActionId: "two", text: "帮我再写一份报告" });
    await until(() => lr.compute.spawned.length === 2, "新任务可用已释放槽位");
    assert.equal(afterRestart.taskDoc(first.id).value.task.state, "T10_Cancelled");
  } finally {
    if (before) await before.close();
    if (afterRestart) await afterRestart.close();
    lr.compute.close();
  }
});

test("AC-23 升级旧库:未知原槽位的 T9 保守拦截相关个人和原群,不堵其他群", async () => {
  const f = file();
  const lr = longRunning();
  let before: Host | undefined;
  let afterRestart: Host | undefined;
  try {
    const options = { file: f, mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 };
    before = new Host(options);
    const c = before.createContact({ name: "旧库联系人" });
    const other = before.createContact({ name: "其他人" });
    before.updateContact(other.id, { computeSlots: 0 });
    const ga = before.createGroup("旧任务原群", [{ kind: "contact", id: c.id }, { kind: "contact", id: other.id }]);
    const gb = before.createGroup("无关群", [{ kind: "contact", id: other.id }]);
    before.updateRoom(ga.id, { tempComputeSlots: 1 });
    before.updateRoom(gb.id, { tempComputeSlots: 1 });
    before.send({ roomId: ga.id, clientActionId: "old", text: "帮我写一份报告", mentions: [{ id: c.id, source: "manual" }] });
    await until(() => lr.compute.spawned.length === 1 && taskOf(before!, ga.id)?.state === "T3_Running", "旧任务开工");
    const task = taskOf(before, ga.id);
    before.taskDecision(task.id, "cancel", "old-stop");
    await until(() => lr.asked.length === 1, "旧任务停止待确认");
    lr.finish(lr.asked[0]!, { ok: false, reason: "停止无法确认", remaining: [] });
    await until(() => before!.taskView(before!.taskDoc(task.id).value).waitingFor?.includes("停止未确认") === true, "旧任务未确认");
    await before.close();
    before = undefined;
    // 旧版本只有任务和 Compute 数据,没有任何精确槽位记录;模拟升级前真实状态。
    const oldDb = new DatabaseSync(f);
    try { oldDb.exec("DROP TABLE IF EXISTS gg_compute_leases"); } finally { oldDb.close(); }
    afterRestart = new Host(options);
    assert.equal(afterRestart.taskDoc(task.id).value.task.state, "T9_StopRequested");
    assert.ok("queued" in afterRestart.quota.acquire({ taskId: "other-personal", contactId: c.id, roomId: `dm-${c.id}`, isGroup: false }), "原联系人个人槽有可能仍被占用");
    assert.ok("queued" in afterRestart.quota.acquire({ taskId: "other-group-a", contactId: other.id, roomId: ga.id, isGroup: true }), "原群临时槽也有可能仍被占用");
    const independent = afterRestart.quota.acquire({ taskId: "other-group-b", contactId: other.id, roomId: gb.id, isGroup: true });
    assert.ok("granted" in independent && independent.granted.scope === `group:${gb.id}`, "不无故阻断无关群");
  } finally {
    if (before) await before.close();
    if (afterRestart) await afterRestart.close();
    lr.compute.close();
  }
});
