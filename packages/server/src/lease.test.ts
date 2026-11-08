// AC-23 临时 Compute 不跨群、停止确认后归还(宿主一侧):取消请求与实际停止分开;确认前不把槽位给冲突后继;
// 慢工具运行中不释放;群临时槽位只给本群;停不干净就不归还并写明。用确定性替身,不起真实进程(真实进程见适配器 quiesce 测试)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  await until(() => taskOf(host, dm.id)?.state === "T5_InReview", "交付");
  const t1 = taskOf(host, dm.id);
  assert.ok(host.quota.leaseOf(t1.id), "主进程还没退出,槽位还占着");
  exit();
  await until(() => host.quota.leaseOf(t1.id) === undefined, "主进程退出后归还");
  compute.close();
  await host.close();
});
