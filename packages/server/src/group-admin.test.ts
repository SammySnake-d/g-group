// 群管理(U03 建群 / 解散,U09 群临时算力,AC-55 公告装配):
// - 建群带 clientActionId:同一号重发只建一个群,返回原来那个(重试不多出一个群);
// - 解散(U03,群主能力):没有在途任务直接解散——群从你的会话列表消失、推 room.removed、群里的定时一起删掉;
//   有在途任务默认拒绝并列出;带 stopTasks 先让成员都进「移出中」、停任务,Compute 真实停下(D05/D16:确认停止才释放)之后才移除;私聊不能解散;
// - 公告装配(AC-55):announcements.list 写明每位联系人装配到这条公告的第几版;改了之后下一轮之前仍是旧版,下一轮装配后跟上;
// - 群临时算力(U09/AC-23):任务视图写明它占的是个人槽位还是借的本群临时槽位,停止请求后标「停止中」直到确认停下。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import type { RoomView, ServerEvent } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-gadmin-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `g${++n}.db`);
const contact = (id: string) => ({ kind: "contact" as const, id });

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
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
  return { adapter, stopAsked, drained: () => inner.drained(), confirm: (id: string) => inner.adapter.stop(id) };
}
const ok = <T>(r: { ok: boolean; value?: unknown; error?: unknown }): T => {
  assert.ok(r.ok, `应当成功,实际:${JSON.stringify(r)}`);
  return r.value as T;
};
const groupIds = (rooms: readonly RoomView[]) => rooms.filter((r) => r.kind === "group").map((r) => r.id);

test("建群带同一个 clientActionId 重发:只建一个群,返回原来那个", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const p = { clientActionId: "ui-create-1", title: "研发群", members: [contact(a.id)] };
  const first = ok<RoomView>(await svc.handle("rooms.createGroup", p));
  const again = ok<RoomView>(await svc.handle("rooms.createGroup", p));
  assert.equal(again.id, first.id, "重发同一个动作号应返回原来那个群");
  assert.deepEqual(groupIds(ok<{ rooms: RoomView[] }>(await svc.handle("rooms.list", {})).rooms), [first.id], "只应有一个群");
  const other = ok<RoomView>(await svc.handle("rooms.createGroup", { ...p, clientActionId: "ui-create-2" }));
  assert.notEqual(other.id, first.id, "换了动作号是另建一个");
  await host.close();
});

test("解散没有在途任务的群:从会话列表消失并推 room.removed,群里的定时一起删掉,私聊不受影响", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const dm = host.openDm(a.id);
  const g = host.createGroup("研发群", [contact(a.id)]);
  ok(await svc.handle("schedules.create", { clientActionId: "s1", contactId: a.id, roomId: g.id, title: "日报", cron: "0 9 * * *", tz: "Asia/Shanghai", prompt: "写日报" }));
  ok(await svc.handle("schedules.create", { clientActionId: "s2", contactId: a.id, roomId: dm.id, title: "私聊提醒", cron: "0 9 * * *", tz: "Asia/Shanghai", prompt: "提醒我" }));
  const events: ServerEvent[] = [];
  const off = svc.subscribe((e) => events.push(e));
  const r = ok<{ roomId: string; dissolved: boolean }>(await svc.handle("rooms.dissolve", { roomId: g.id }));
  assert.deepEqual(r, { roomId: g.id, dissolved: true });
  const rooms = ok<{ rooms: RoomView[] }>(await svc.handle("rooms.list", {})).rooms;
  assert.deepEqual(groupIds(rooms), [], "解散后会话列表里没有这个群");
  assert.ok(rooms.some((x) => x.id === dm.id), "私聊还在");
  assert.ok(events.some((e) => e.type === "room.removed" && e.roomId === g.id), "推了 room.removed");
  assert.deepEqual(ok<{ schedules: { roomId: string }[] }>(await svc.handle("schedules.list", { roomId: g.id })).schedules, [], "群里的定时删掉了");
  assert.equal(ok<{ schedules: unknown[] }>(await svc.handle("schedules.list", { roomId: dm.id })).schedules.length, 1, "私聊的定时不动");
  const again = await svc.handle("rooms.dissolve", { roomId: dm.id });
  assert.equal(again.ok ? "ok" : again.error.code, "forbidden", "私聊不能解散");
  off();
  await host.close();
});

test("解散有在途任务的群:不带 stopTasks 被拒并列出任务;带上先停任务,Compute 真实停下之后才移除", async () => {
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
  const refused = await svc.handle("rooms.dissolve", { roomId: g.id });
  assert.deepEqual(refused.ok ? null : [refused.error.code, refused.error.detail], ["conflict", { tasks: [{ taskId: t.id, title: "跑脚本", state: "T3_Running" }] }]);
  assert.deepEqual(groupIds(host.roomsOfUser()), [g.id], "被拒时群还在");

  const r = ok<{ roomId: string; dissolved: boolean }>(await svc.handle("rooms.dissolve", { roomId: g.id, stopTasks: true }));
  assert.deepEqual(r, { roomId: g.id, dissolved: false }, "有在途任务:先停,等停下再移除");
  await settle(host, compute);
  assert.deepEqual(groupIds(host.roomsOfUser()), [g.id], "Compute 还没确认停下:群还在(解散中)");
  assert.deepEqual(host.roomView(g.id).leavingMembers, [contact(a.id)], "在干活的成员标移出中");
  assert.equal(compute.stopAsked.length, 1, "发了停止");

  for (const id of compute.stopAsked) await compute.confirm(id);
  await settle(host, compute);
  assert.equal(host.listTasks({ roomId: g.id })[0]!.state, "T10_Cancelled");
  assert.deepEqual(groupIds(host.roomsOfUser()), [], "停下之后群才移除");
  await host.close();
});

test("公告装配:列表写明每位联系人装配到第几版;改了以后下一轮之前仍是旧版,下一轮装配后跟上", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const b = host.createContact({ name: "小安" });
  const g = host.createGroup("研发群", [contact(a.id), contact(b.id)]);
  type Ann = { id: string; version: number; assembled?: { contactId: string; version: number }[] };
  const list = async () => ok<{ announcements: Ann[] }>(await svc.handle("announcements.list", { roomId: g.id })).announcements;
  const at = (ann: Ann | undefined, who: string) => ann?.assembled?.find((x) => x.contactId === who)?.version ?? null;

  const ann = ok<Ann>(await svc.handle("announcements.add", { roomId: g.id, clientActionId: "a1", text: "派活先 @ 对应的人" }));
  assert.equal(at((await list())[0], a.id), null, "还没轮到联系人:没装配过");
  host.send({ roomId: g.id, clientActionId: "m1", text: "看下公告", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  assert.equal(at((await list())[0], a.id), 1, "小前这一轮装配了 v1");

  ok(await svc.handle("announcements.update", { announcementId: ann.id, text: "派活先 @ 对应的人,做完先复核", expectedVersion: 1 }));
  const changed = (await list())[0]!;
  assert.equal(changed.version, 2);
  assert.equal(at(changed, a.id), 1, "下一轮之前还是旧版");
  const events: ServerEvent[] = [];
  const off = svc.subscribe((e) => events.push(e));
  host.send({ roomId: g.id, clientActionId: "m2", text: "再看一眼", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  assert.equal(at((await list())[0], a.id), 2, "下一轮装配了 v2");
  assert.ok(events.some((e) => e.type === "room.updated" && e.room.id === g.id), "装配版本变了要推 room.updated,界面据此刷新");
  off();
  await host.close();
});

test("群临时算力:任务视图写明占的是个人槽位还是借的本群临时槽位", async () => {
  const compute = holdingCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  host.updateContact(a.id, { computeSlots: 1 });
  const g = host.createGroup("研发群", [contact(a.id)]);
  ok(await svc.handle("rooms.update", { roomId: g.id, tempComputeSlots: 2 }));
  host.send({ roomId: g.id, clientActionId: "m1", text: "帮我跑脚本一", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  host.send({ roomId: g.id, clientActionId: "m2", text: "帮我跑脚本二", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  type T = { title: string; state: string; slot?: { scope: string; stopping: boolean } | null };
  const tasks = ok<{ tasks: T[] }>(await svc.handle("tasks.list", { roomId: g.id })).tasks;
  const by = (title: string) => tasks.find((t) => t.title === title);
  assert.deepEqual(by("跑脚本一")?.slot, { scope: "personal", stopping: false }, "先占个人槽位");
  assert.deepEqual(by("跑脚本二")?.slot, { scope: "group", stopping: false }, "个人满了借本群临时槽位");
  await host.close();
});
