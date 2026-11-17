// 群聊与「从群聊私信」侧边栏是同一实体(AC-02,US10-View、U46):两个入口读的是同一份权威任务文档,读到同一任务、同一 stateVer;
// 侧边栏发言 = 在群里 @ 这个联系人(复用 messages.send + mentions,不另建入口);无新事件 → 两边都不刷新。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type ServerEvent, type TaskView, checkEvent } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-same-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
type Svc = ReturnType<typeof createService>;
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method, params);
  if (!r.ok) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.value as T;
}
/** 群入口(群聊主窗口的任务列表)与侧边栏入口(从群聊私信:这个联系人在这个群里的任务 + 单个任务详情)各读一次 */
async function bothEntrances(svc: Svc, roomId: string, contactId: string, taskId: string) {
  const group = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId })).tasks.find((t) => t.id === taskId);
  const side = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId, contactId })).tasks.find((t) => t.id === taskId);
  const detail = await call<TaskView>(svc, "tasks.get", { taskId });
  return { group, side, detail };
}

/** 建群、在群里 @ 小前派一件活并等它跑完交付;宿主与服务由测试自己 new 出来再交进来 */
async function seedGroup(host: Host, svc: Svc, compute: { drained(): boolean }) {
  const events: ServerEvent[] = [];
  host.bus.subscribe((e) => events.push(e));
  const a = host.createContact({ name: "小前" });
  const b = host.createContact({ name: "小后" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  // 侧边栏输入框发的话 = 在群里 @ 这个联系人:同一个 messages.send,roomId 是群,mentions 带上他
  const sent = await call<{ seq: number; roomId: string }>(svc, "messages.send", { roomId: g.id, clientActionId: "side-1", text: "帮我整理接口清单", mentions: [{ id: a.id, source: "auto" }] });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: g.id });
  assert.ok(task, "群里 @ 小前派的活建成了任务");
  return { events, a, b, g, sent, task };
}
const newHost = (compute: ReturnType<typeof scriptedCompute>) => new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });

test("侧边栏发言就是群里 @ 他:消息进群时间线,任务挂在群上;群入口、侧边栏入口、任务详情读到同一任务、同一 stateVer", async () => {
  const compute = scriptedCompute();
  const host = newHost(compute);
  const svc = createService(host);
  const { a, g, sent, task } = await seedGroup(host, svc, compute);
  assert.equal(sent.roomId, g.id);
  const timeline = (await call<{ messages: { seq: number; text: string }[] }>(svc, "messages.list", { roomId: g.id })).messages;
  assert.equal(timeline.find((m) => m.seq === sent.seq)?.text, "帮我整理接口清单", "侧边栏发的话就在群时间线里,没有另一份");
  const { group, side, detail } = await bothEntrances(svc, g.id, a.id, task.id);
  assert.ok(group && side, "两个入口都看到这个任务");
  assert.equal(typeof detail.stateVer, "number");
  assert.ok((detail.stateVer ?? 0) >= 1);
  assert.deepEqual([group.stateVer, side.stateVer], [detail.stateVer, detail.stateVer]);
  assert.deepEqual([group.state, side.state], [detail.state, detail.state]);
  assert.deepEqual(side, group, "侧边栏和群入口拿到的是同一个任务视图");
  assert.equal(detail.stateVer, host.taskDoc(task.id).ver, "stateVer 就是权威任务文档的版本");
  compute.close();
  await host.close();
});

test("任务每推进一步 stateVer 增大,task.updated 事件带的 stateVer 与随后两个入口读到的一致;用户在群里回复通过后两边同时看到新版本", async () => {
  const compute = scriptedCompute();
  const host = newHost(compute);
  const svc = createService(host);
  const { events, a, g, task } = await seedGroup(host, svc, compute);
  const vers = events.filter((e): e is Extract<ServerEvent, { type: "task.updated" }> => e.type === "task.updated" && e.task.id === task.id).map((e) => e.task.stateVer ?? 0);
  assert.ok(vers.length >= 3, "派活、执行、交付各有 task.updated");
  for (let i = 1; i < vers.length; i++) assert.ok(vers[i]! >= vers[i - 1]!, `事件里的 stateVer 不回退:${vers.join(",")}`);
  assert.ok(vers[0]! >= 1 && vers.at(-1)! > vers[0]!, `stateVer 随推进增大:${vers.join(",")}`);
  const before = await bothEntrances(svc, g.id, a.id, task.id);
  assert.equal(before.detail.stateVer, vers.at(-1), "最后一条事件的版本就是现在读到的版本");
  // 交付是群里的普通消息(AC-56):用户在群里回「通过」,走 tasks.accept 这个显式入口
  const accepted = await call<TaskView>(svc, "tasks.accept", { taskId: task.id, clientActionId: "acc-1" });
  assert.equal(accepted.id, task.id);
  await settle(host, compute);
  const after_ = await bothEntrances(svc, g.id, a.id, task.id);
  assert.equal(after_.detail.state, "T8_Accepted");
  assert.ok((after_.detail.stateVer ?? 0) > (before.detail.stateVer ?? 0));
  assert.deepEqual([after_.group?.stateVer, after_.side?.stateVer, after_.group?.state, after_.side?.state], [after_.detail.stateVer, after_.detail.stateVer, "T8_Accepted", "T8_Accepted"]);
  const lastEv = events.findLast((e): e is Extract<ServerEvent, { type: "task.updated" }> => e.type === "task.updated" && e.task.id === task.id)!;
  assert.equal(lastEv.task.stateVer, after_.detail.stateVer);
  const checked = checkEvent(lastEv);
  assert.ok(checked.ok, "task.updated 带 stateVer 仍符合合同");
  assert.equal(checked.ok ? (checked.value as { task: { stateVer?: number } }).task.stateVer : 0, after_.detail.stateVer, "合同校验不丢 stateVer");
  compute.close();
  await host.close();
});

test("无新事件 → 两边都不刷新:安静下来后反复读两个入口,stateVer 不变,也不产生 task.updated", async () => {
  const compute = scriptedCompute();
  const host = newHost(compute);
  const svc = createService(host);
  const { events, a, g, task } = await seedGroup(host, svc, compute);
  const head = host.bus.head();
  const first = await bothEntrances(svc, g.id, a.id, task.id);
  const second = await bothEntrances(svc, g.id, a.id, task.id);
  assert.ok((first.detail.stateVer ?? 0) >= 1);
  assert.deepEqual([second.group?.stateVer, second.side?.stateVer, second.detail.stateVer], [first.detail.stateVer, first.detail.stateVer, first.detail.stateVer]);
  assert.equal(host.bus.head(), head, "读不产生事件");
  assert.equal(events.filter((e) => e.type === "task.updated" && e.eventSeq > head).length, 0);
  compute.close();
  await host.close();
});

test("侧边栏只列这个联系人在这个群里的任务:别的联系人的任务不出现,但同一任务在两个入口里版本一致", async () => {
  const compute = scriptedCompute();
  const host = newHost(compute);
  const svc = createService(host);
  const { b, g, task } = await seedGroup(host, svc, compute);
  await call(svc, "messages.send", { roomId: g.id, clientActionId: "side-2", text: "帮我跑一下测试", mentions: [{ id: b.id, source: "auto" }] });
  await settle(host, compute);
  const groupList = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId: g.id })).tasks;
  const sideB = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId: g.id, contactId: b.id })).tasks;
  assert.equal(groupList.length, 2);
  assert.deepEqual(sideB.map((t) => t.ownerContactId), [b.id]);
  assert.ok(!sideB.some((t) => t.id === task.id));
  const tb = sideB[0]!;
  assert.equal(groupList.find((t) => t.id === tb.id)?.stateVer, tb.stateVer);
  assert.equal(tb.stateVer, host.taskDoc(tb.id).ver);
  compute.close();
  await host.close();
});
