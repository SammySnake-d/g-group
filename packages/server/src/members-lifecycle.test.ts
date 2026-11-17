// AC-49 群成员加入与移出(U03/U09,D05):重复加入只有一个成员、不挪游标;移出又加回从当前末尾开始,不处理离开期间的旧消息;
// 移出在这个群有在途任务的联系人默认拒绝(conflict 列出任务);带 stopTasks 时先进「移出中」——这个群的新消息不再送达它、
// 它在这个群的发言与接新活被拒——在途任务 Cancel → 停 Compute,等 Compute 真实停止确认(任务到 T10)之后才删成员;
// Compute 不回停止确认就一直不删。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import type { RoomView } from "@g-group/api-contract";
import type { RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-members-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `m${++n}.db`);

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
/** Compute 替身:起来后一直跑;stop 只记下请求、不回停止确认,confirm(id) 时才真的报 stopped。 */
function holdingCompute() {
  const inner = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const stopAsked: string[] = [];
  const adapter: ComputeAdapter = {
    ...inner.adapter,
    stop: async (id: string) => {
      stopAsked.push(id);
      return { ok: true };
    },
  };
  return { adapter, stopAsked, drained: () => inner.drained(), confirm: (id: string) => inner.adapter.stop(id), close: () => inner.close() };
}
const okValue = <T>(r: { ok: boolean; value?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};
const contact = (id: string) => ({ kind: "contact" as const, id });
const LEAVING = "正在移出这个群,不能在这里发言或接新活";

test("重复加入只有一个成员、不挪游标;移出后再加回从当前末尾开始,不处理离开期间的旧消息", async () => {
  const seen: { contact: string; texts: string[] }[] = [];
  const host = new Host({ file: file(), mind: () => scriptedMind({ onRound: (i: RoundInput) => seen.push({ contact: i.contact.id, texts: i.fresh.flatMap((f) => (f.kind === "message" ? [f.text] : [])) }) }), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [contact(a.id)]);
  host.send({ roomId: g.id, clientActionId: "m1", text: "第一条" });
  // 小前还没处理第一条时又被拉一次(同一请求里还重复了一次):成员只有一个,它仍会处理第一条
  const dup = okValue<RoomView>(await svc.handle("rooms.addMembers", { roomId: g.id, members: [contact(a.id), contact(a.id)] }));
  assert.deepEqual(dup.members, [contact(a.id), { kind: "user", id: "me" }]);
  await settle(host);
  host.removeMember(g.id, contact(a.id));
  host.send({ roomId: g.id, clientActionId: "m2", text: "离开期间一" });
  host.send({ roomId: g.id, clientActionId: "m3", text: "离开期间二" });
  await settle(host);
  const back = host.addMembers(g.id, [contact(a.id)]);
  assert.deepEqual(back.members, [contact(a.id), { kind: "user", id: "me" }]);
  host.send({ roomId: g.id, clientActionId: "m4", text: "回来之后" });
  await settle(host);
  assert.deepEqual(
    seen.filter((s) => s.contact === a.id).map((s) => s.texts),
    [["第一条"], ["回来之后"]],
  );
  await host.close();
});

test("移出在这个群有在途任务的联系人:不带 stopTasks 被拒并列出任务,成员、任务、Compute 都不变;没有在途任务的照常移出", async () => {
  const compute = holdingCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const b = host.createContact({ name: "小安" });
  const g = host.createGroup("研发群", [contact(a.id), contact(b.id)]);
  host.send({ roomId: g.id, clientActionId: "m1", text: "帮我跑脚本", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const t = host.listTasks({ roomId: g.id })[0]!;
  assert.equal(t.state, "T3_Running");
  const r = await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(a.id) });
  assert.deepEqual(r.ok ? null : [r.error.code, r.error.detail], ["conflict", { tasks: [{ taskId: t.id, title: "跑脚本", state: "T3_Running" }] }]);
  const view = host.roomView(g.id);
  assert.deepEqual([view.members.map((m) => m.id), view.leavingMembers], [[a.id, b.id, "me"].sort(), []]);
  assert.equal(host.taskView(host.taskDoc(t.id).value).state, "T3_Running");
  assert.deepEqual(compute.stopAsked, []);
  const rb = okValue<RoomView>(await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(b.id), stopTasks: true }));
  assert.deepEqual([rb.members.map((m) => m.id), rb.leavingMembers], [[a.id, "me"].sort(), []]);
  compute.close();
  await host.close();
});

test("带 stopTasks:停止确认前成员仍在并标移出中,这个群的新消息不再送达、发言与接新活被拒;确认后才移除、任务 T10,别的群的任务照常", async () => {
  const compute = holdingCompute();
  const rejected: string[] = [];
  const rounds: string[][] = [];
  let blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host = new Host({
    file: file(),
    mind: () => {
      const inner = scriptedMind({ onRound: (i: RoundInput) => rounds.push(i.fresh.map((f) => (f.kind === "message" ? f.text : f.kind))) });
      return {
        async round(input, signal) {
          // 「第二件」这一轮在移出开始前就已经开跑:卡住它,等移出开始后再交回动作
          if (input.fresh.some((f) => f.kind === "message" && f.text === "帮我第二件")) {
            blocked = true;
            await gate;
          }
          return inner.round(input, signal);
        },
      };
    },
    compute: () => compute.adapter,
    onReport: (what, d) => {
      if (what === "action-rejected") rejected.push(`${(d as { action: { kind: string } }).action.kind}:${(d as { reason: string }).reason}`);
    },
    maxDeferMs: 5,
  });
  const svc = createService(host);
  const events: RoomView[] = [];
  host.bus.subscribe((e) => {
    if (e.type === "room.updated") events.push(e.room);
  });
  const a = host.createContact({ name: "小前" });
  const g1 = host.createGroup("研发群", [contact(a.id)]);
  const g2 = host.createGroup("运维群", [contact(a.id)]);
  host.send({ roomId: g1.id, clientActionId: "m1", text: "帮我跑脚本", mentions: [{ id: a.id, source: "manual" }] });
  host.send({ roomId: g2.id, clientActionId: "m2", text: "帮我查日志", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const t1 = host.listTasks({ roomId: g1.id })[0]!;
  const t2 = host.listTasks({ roomId: g2.id })[0]!;
  const cp1 = t1.computeRuns[0]!.computeId;
  assert.deepEqual([t1.state, t2.state], ["T3_Running", "T3_Running"]);
  host.send({ roomId: g1.id, clientActionId: "m3", text: "帮我第二件", mentions: [{ id: a.id, source: "manual" }] });
  for (let i = 0; i < 200 && !blocked; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(blocked, true);

  const leaving = okValue<RoomView>(await svc.handle("rooms.removeMember", { roomId: g1.id, member: contact(a.id), stopTasks: true }));
  assert.deepEqual([leaving.members.map((m) => m.id), leaving.leavingMembers], [[a.id, "me"], [contact(a.id)]]);
  assert.equal(host.taskView(host.taskDoc(t1.id).value).state, "T9_StopRequested");
  assert.deepEqual(compute.stopAsked, [cp1]);

  release();
  await settle(host, compute);
  // 移出前就开跑的那一轮:接新活、登记承诺、发言全被拒,没有新任务
  assert.deepEqual(rejected, [`dispatch:${LEAVING}`, `commit:${LEAVING}`, `reply:${LEAVING}`]);
  assert.deepEqual(host.listTasks({ roomId: g1.id }).map((t) => t.id), [t1.id]);
  // 这个群的新消息不再送达它;/task 交给它被拒
  const before = rounds.length;
  host.send({ roomId: g1.id, clientActionId: "m4", text: "小前在吗", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  assert.equal(rounds.length, before);
  const cmd = await svc.handle("messages.send", { roomId: g1.id, clientActionId: "m5", text: "/task 再做一件", command: { name: "task", args: { contact: a.id, what: "再做一件" } } });
  assert.equal(cmd.ok ? null : cmd.error.code, "conflict");
  // 停止确认还没到:成员仍在、仍标移出中
  const pending = host.roomView(g1.id);
  assert.deepEqual([pending.members.map((m) => m.id), pending.leavingMembers], [[a.id, "me"], [contact(a.id)]]);

  await compute.confirm(cp1);
  await settle(host, compute);
  assert.equal(host.taskView(host.taskDoc(t1.id).value).state, "T10_Cancelled");
  const done = host.roomView(g1.id);
  assert.deepEqual([done.members.map((m) => m.id), done.leavingMembers], [["me"], []]);
  // 别的群的任务照常跑,也没被停
  assert.equal(host.taskView(host.taskDoc(t2.id).value).state, "T3_Running");
  assert.deepEqual(compute.stopAsked, [cp1]);
  // 群事件:先推「移出中」,确认后再推移除
  assert.deepEqual(
    events.filter((r) => r.id === g1.id).map((r) => [r.members.length, r.leavingMembers?.length]).slice(-2),
    [
      [2, 1],
      [1, 0],
    ],
  );
  compute.close();
  await host.close();
});

test("Compute 不回停止确认:成员一直不被移除、仍标移出中;重复移出不重复发停止,移出中不能拉回;确认到了才移除", async () => {
  const compute = holdingCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [contact(a.id)]);
  host.send({ roomId: g.id, clientActionId: "m1", text: "帮我跑脚本", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const t = host.listTasks({ roomId: g.id })[0]!;
  const cp = t.computeRuns[0]!.computeId;
  okValue(await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(a.id), stopTasks: true }));
  await settle(host, compute);
  await new Promise((r) => setTimeout(r, 50));
  await settle(host, compute);
  const still = host.roomView(g.id);
  assert.deepEqual([still.members.map((m) => m.id), still.leavingMembers], [[a.id, "me"], [contact(a.id)]]);
  assert.equal(host.taskView(host.taskDoc(t.id).value).state, "T9_StopRequested");
  const again = okValue<RoomView>(await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(a.id), stopTasks: true }));
  assert.deepEqual(again.leavingMembers, [contact(a.id)]);
  assert.deepEqual(compute.stopAsked, [cp]);
  const back = await svc.handle("rooms.addMembers", { roomId: g.id, members: [contact(a.id)] });
  assert.equal(back.ok ? null : back.error.code, "conflict");
  assert.throws(() => host.removeContact(a.id), /在途任务/);
  await compute.confirm(cp);
  await settle(host, compute);
  const gone = host.roomView(g.id);
  assert.deepEqual([gone.members.map((m) => m.id), gone.leavingMembers, host.taskView(host.taskDoc(t.id).value).state], [["me"], [], "T10_Cancelled"]);
  compute.close();
  await host.close();
});
