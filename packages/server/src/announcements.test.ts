// AC-55 群置顶与多条公告(U97/U86,D28 第 4 条):第二条公告不覆盖第一条、按创建先后列出;改了之后联系人下一轮第 1 块读新版本;
// 撤下后不再出现;无公告是空数组且装配不出公告段;公告没改时连续两轮第 1 块逐字节相同(U85/D22 前缀缓存);
// 新成员入群、宿主重启后的第一轮都带当前全部公告;置顶群在会话列表里排第一。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AnnouncementView, RoomView, ServerEvent } from "@g-group/api-contract";
import type { RoundInput } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-ann-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `a${++n}.db`);

async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}

type Prefix = { contact: string; text: string };
/** 宿主参数:把每位联系人每轮第 1 块原文记进 prefix;时钟每读一次走一秒。 */
function opts(prefix: Prefix[], extra: Partial<HostOptions> = {}, f = file()): HostOptions {
  let t = 0;
  return {
    file: f,
    now: () => new Date(Date.UTC(2026, 10, 9, 8, 0, t++)).toISOString(),
    mind: () => scriptedMind({ onRound: (i: RoundInput) => prefix.push({ contact: i.contact.id, text: i.request.blocks.find((b) => b.block === 1)!.text }) }),
    maxDeferMs: 5,
    ...extra,
  };
}
const okValue = <T>(r: { ok: boolean; value?: unknown; error?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};
/** 第 1 块里某个群的群规快照段(kernelAssemble 的渲染格式)。 */
const snap = (roomId: string, version: number, body: string) => `〔规矩 room-rules:${roomId} · 来源 #${version}〕\n${body}\n`;

test("两条公告并存:第二条不覆盖第一条,按创建先后列出,可倒序;重发同一 clientActionId 不新增;置顶群排第一并带公告条数", async () => {
  const host = new Host(opts([]));
  const svc = createService(host);
  const events: ServerEvent[] = [];
  host.bus.subscribe((e) => events.push(e));
  const a = host.createContact({ name: "小前" });
  const g1 = host.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  const g2 = host.createGroup("闲聊群", [{ kind: "contact", id: a.id }]);
  okValue(await svc.handle("rooms.update", { roomId: g1.id, pinned: true }));
  const x1 = okValue<AnnouncementView>(await svc.handle("announcements.add", { roomId: g1.id, clientActionId: "n1", text: "发版前所有涉及鉴权的改动必须过小安审查" }));
  const x2 = okValue<AnnouncementView>(await svc.handle("announcements.add", { roomId: g1.id, clientActionId: "n2", text: "提交信息用中文" }));
  const again = okValue<AnnouncementView>(await svc.handle("announcements.add", { roomId: g1.id, clientActionId: "n1", text: "发版前所有涉及鉴权的改动必须过小安审查" }));
  assert.deepEqual([x1.roomId, x1.version, x2.roomId, x2.version, again.id], [g1.id, 1, g1.id, 1, x1.id]);
  assert.notEqual(x1.id, x2.id);
  const list = okValue<{ announcements: AnnouncementView[] }>(await svc.handle("announcements.list", { roomId: g1.id }));
  assert.deepEqual(
    list.announcements.map((x) => [x.id, x.text, x.version]),
    [
      [x1.id, "发版前所有涉及鉴权的改动必须过小安审查", 1],
      [x2.id, "提交信息用中文", 1],
    ],
  );
  const desc = okValue<{ announcements: AnnouncementView[] }>(await svc.handle("announcements.list", { roomId: g1.id, order: "created-desc" }));
  assert.deepEqual(desc.announcements.map((x) => x.id), [x2.id, x1.id]);
  // 闲聊群后来有新消息(更新时间更晚),置顶的研发群仍排第一、不消失
  host.send({ roomId: g2.id, clientActionId: "m1", text: "中午吃什么" });
  await settle(host);
  const rooms = okValue<{ rooms: RoomView[] }>(await svc.handle("rooms.list", {}));
  assert.deepEqual(
    rooms.rooms.map((r) => [r.id, r.pinned, r.announcementCount]),
    [
      [g1.id, true, 2],
      [g2.id, false, 0],
    ],
  );
  // 每次公告改动都推 room.updated,带当时的条数;重发不推
  assert.deepEqual(
    events.flatMap((e) => (e.type === "room.updated" && e.room.id === g1.id ? [e.room.announcementCount] : [])),
    [0, 0, 1, 2],
  );
  await host.close();
});

test("改公告后联系人下一轮第 1 块是新文本、不再有旧文本,快照版本前进;旧版本号再改被拒", async () => {
  const prefix: Prefix[] = [];
  const host = new Host(opts(prefix));
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  const x = host.announcements.add(g.id, "发版前要审查", "n1");
  host.send({ roomId: g.id, clientActionId: "m1", text: "开工" });
  await settle(host);
  const u = okValue<AnnouncementView>(await svc.handle("announcements.update", { announcementId: x.id, text: "发版前必须过小安审查", expectedVersion: 1 }));
  assert.deepEqual([u.id, u.text, u.version, u.createdAt], [x.id, "发版前必须过小安审查", 2, x.createdAt]);
  assert.notEqual(u.updatedAt, x.updatedAt);
  const stale = await svc.handle("announcements.update", { announcementId: x.id, text: "别的", expectedVersion: 1 });
  assert.deepEqual(stale.ok ? null : [stale.error.code, stale.error.detail], ["conflict", { currentVer: 2 }]);
  host.send({ roomId: g.id, clientActionId: "m2", text: "继续" });
  await settle(host);
  assert.deepEqual(prefix.map((p) => p.contact), [a.id, a.id]);
  assert.ok(prefix[0]!.text.includes(snap(g.id, 1, "研发群:群公告(共 1 条):\n1. 发版前要审查")), prefix[0]!.text);
  assert.ok(prefix[1]!.text.includes(snap(g.id, 2, "研发群:群公告(共 1 条):\n1. 发版前必须过小安审查")), prefix[1]!.text);
  assert.equal(prefix[1]!.text.includes("发版前要审查"), false, "联系人只拿到旧公告");
  assert.deepEqual(host.announcements.list(g.id).map((y) => [y.text, y.version]), [["发版前必须过小安审查", 2]]);
  await host.close();
});

test("撤下一条公告后列表和联系人下一轮装配都不再有它,另一条仍在;重复撤下或改已撤下的报不存在", async () => {
  const prefix: Prefix[] = [];
  const host = new Host(opts(prefix));
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  const x1 = host.announcements.add(g.id, "甲规则", "n1");
  const x2 = host.announcements.add(g.id, "乙规则", "n2");
  host.send({ roomId: g.id, clientActionId: "m1", text: "开工" });
  await settle(host);
  okValue(await svc.handle("announcements.remove", { announcementId: x1.id, expectedVersion: 1 }));
  assert.deepEqual(host.announcements.list(g.id).map((y) => y.id), [x2.id]);
  assert.equal(host.roomView(g.id).announcementCount, 1);
  host.send({ roomId: g.id, clientActionId: "m2", text: "继续" });
  await settle(host);
  assert.ok(prefix[0]!.text.includes(snap(g.id, 2, "研发群:群公告(共 2 条):\n1. 甲规则\n2. 乙规则")), prefix[0]!.text);
  assert.ok(prefix[1]!.text.includes(snap(g.id, 3, "研发群:群公告(共 1 条):\n1. 乙规则")), prefix[1]!.text);
  assert.equal(prefix[1]!.text.includes("甲规则"), false);
  const twice = await svc.handle("announcements.remove", { announcementId: x1.id });
  assert.equal(twice.ok ? null : twice.error.code, "not_found");
  const edit = await svc.handle("announcements.update", { announcementId: x1.id, text: "复活" });
  assert.equal(edit.ok ? null : edit.error.code, "not_found");
  const staleRemove = await svc.handle("announcements.remove", { announcementId: x2.id, expectedVersion: 5 });
  assert.deepEqual(staleRemove.ok ? null : [staleRemove.error.code, staleRemove.error.detail], ["conflict", { currentVer: 1 }]);
  assert.deepEqual(host.announcements.list(g.id).map((y) => y.text), ["乙规则"]);
  await host.close();
});

test("没有公告:list 返回空数组、条数为 0,联系人第 1 块不出公告段;只有群规时只放群规;私聊不能设群公告", async () => {
  const prefix: Prefix[] = [];
  const host = new Host(opts(prefix));
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  assert.deepEqual(okValue(await svc.handle("announcements.list", { roomId: g.id })), { announcements: [] });
  assert.equal(host.roomView(g.id).announcementCount, 0);
  host.send({ roomId: g.id, clientActionId: "m1", text: "开工" });
  await settle(host);
  host.updateRoom(g.id, { rules: "先测后合" });
  host.send({ roomId: g.id, clientActionId: "m2", text: "继续" });
  await settle(host);
  assert.equal(prefix.length, 2);
  assert.equal(prefix[0]!.text.includes("群公告"), false);
  assert.equal(prefix[0]!.text.includes(`room-rules:${g.id}`), false);
  assert.ok(prefix[1]!.text.includes(snap(g.id, 1, "研发群:先测后合")), prefix[1]!.text);
  assert.equal(prefix[1]!.text.includes("群公告"), false);
  const dm = host.openDm(a.id);
  const add = await svc.handle("announcements.add", { roomId: dm.id, clientActionId: "d1", text: "私聊公告" });
  assert.equal(add.ok ? null : add.error.code, "forbidden");
  assert.deepEqual(okValue(await svc.handle("announcements.list", { roomId: dm.id })), { announcements: [] });
  const none = await svc.handle("announcements.list", { roomId: "g-nope" });
  assert.equal(none.ok ? null : none.error.code, "not_found");
  await host.close();
});

test("公告没改时连续两轮第 1 块逐字节相同:置顶、静音、用同样正文再存都不刷新前缀;真改了才换", async () => {
  const prefix: Prefix[] = [];
  const host = new Host(opts(prefix));
  const svc = createService(host);
  const a = host.createContact({ name: "小前" });
  const g = host.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  const x = host.announcements.add(g.id, "发版前要审查", "n1");
  host.send({ roomId: g.id, clientActionId: "m1", text: "开工" });
  await settle(host);
  host.updateRoom(g.id, { pinned: true, muted: true });
  const same = okValue<AnnouncementView>(await svc.handle("announcements.update", { announcementId: x.id, text: "发版前要审查" }));
  assert.deepEqual([same.version, same.updatedAt], [1, x.updatedAt]);
  host.send({ roomId: g.id, clientActionId: "m2", text: "继续" });
  await settle(host);
  okValue(await svc.handle("announcements.update", { announcementId: x.id, text: "发版前必须审查" }));
  host.send({ roomId: g.id, clientActionId: "m3", text: "再继续" });
  await settle(host);
  assert.equal(prefix.length, 3);
  assert.equal(prefix[1]!.text, prefix[0]!.text);
  assert.notEqual(prefix[2]!.text, prefix[1]!.text);
  assert.ok(prefix[1]!.text.includes(snap(g.id, 1, "研发群:群公告(共 1 条):\n1. 发版前要审查")), prefix[1]!.text);
  assert.ok(prefix[2]!.text.includes(snap(g.id, 2, "研发群:群公告(共 1 条):\n1. 发版前必须审查")), prefix[2]!.text);
  await host.close();
});

test("新成员入群后的第一轮、宿主重启后的第一轮都带当前全部公告;排序参数倒序时列表与装配都新的在前", async () => {
  const f = file();
  const firstPrefix: Prefix[] = [];
  const first = new Host(opts(firstPrefix, {}, f));
  const a = first.createContact({ name: "小前" });
  const b = first.createContact({ name: "小安" });
  const g = first.createGroup("研发群", [{ kind: "contact", id: a.id }]);
  first.updateRoom(g.id, { rules: "先测后合" });
  const x1 = first.announcements.add(g.id, "甲规则", "n1");
  const x2 = first.announcements.add(g.id, "乙规则", "n2");
  first.addMembers(g.id, [{ kind: "contact", id: b.id }]);
  first.send({ roomId: g.id, clientActionId: "m1", text: "欢迎小安" });
  await settle(first);
  const bFirst = firstPrefix.find((p) => p.contact === b.id);
  assert.ok(bFirst?.text.includes(snap(g.id, 3, "研发群:先测后合\n群公告(共 2 条):\n1. 甲规则\n2. 乙规则")), bFirst?.text);
  await first.close();
  const secondPrefix: Prefix[] = [];
  const second = new Host(opts(secondPrefix, { announcementOrder: "created-desc" }, f));
  assert.deepEqual(second.announcements.list(g.id).map((y) => y.id), [x2.id, x1.id]);
  assert.deepEqual(second.announcements.list(g.id, "created-asc").map((y) => y.id), [x1.id, x2.id]);
  second.send({ roomId: g.id, clientActionId: "m2", text: "重启后继续" });
  await settle(second);
  assert.deepEqual(secondPrefix.map((p) => p.contact).sort(), [a.id, b.id].sort());
  for (const p of secondPrefix) assert.ok(p.text.includes(snap(g.id, 3, "研发群:先测后合\n群公告(共 2 条):\n1. 乙规则\n2. 甲规则")), p.text);
  await second.close();
});
