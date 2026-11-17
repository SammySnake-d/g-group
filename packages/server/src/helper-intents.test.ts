// AC-52 Helper 三种意图(U94/D28 第 1 条)的后端接口:全局入口首次不带任何聊天、按需读用户有权的聊天;
// 侧栏读当前聊天,对话留在侧栏不上公屏;聊天里 @Helper 时回复作为一条消息出现在当前聊天。
// 权限底座复用 domain/helper.ts 的 routeHelper(Helper 只为用户本人服务)。Helper 的模型运行时不在本片。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind } from "@g-group/kernel";
import { run } from "./db.ts";
import { senderAudit } from "./drive.ts";
import { HELPER_ID } from "./helper.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-helper-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `h${++fileNo}.db`);
/** 记下每轮收到了什么、什么都不做的联系人。 */
const quiet = (rounds: string[]): ContactMind => ({
  async round(input) {
    for (const f of input.fresh) if (f.kind === "message") rounds.push(`${input.contact.name}:${f.roomId}#${f.seq}:${f.sender.kind}`);
    return { actions: [], stateNote: null };
  },
});
async function settle(host: Host) {
  for (let i = 0; i < 100; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
}

test("全局入口首次不带任何聊天;按需读取指定的、用户在场的聊天;读用户不在的会话被拒", async () => {
  const rounds: string[] = [];
  const host = new Host({ file: file(), mind: () => quiet(rounds), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "d1", text: "私聊里的一句" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: g.id, clientActionId: "g1", text: "群里的一句" });
  await settle(host);

  const first = await svc.handle("helper.context", { entry: { kind: "global" } });
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(first.value, { route: { replyIn: "global-panel", becomesMessage: false, contextRoomId: null, replyToSeq: null }, rooms: [] }, "首次不读任何聊天");

  const some = await svc.handle("helper.context", { entry: { kind: "global" }, readRoomIds: [dm.id] });
  assert.ok(some.ok, JSON.stringify(some));
  const v = some.value as { rooms: { roomId: string; title: string; messages: { text: string }[] }[] };
  assert.deepEqual(v.rooms.map((r) => [r.roomId, r.title, r.messages.map((m) => m.text)]), [[dm.id, "小克", ["私聊里的一句"]]], "只读点名的那个聊天");

  run(host.db, "DELETE FROM gg_members WHERE room_id = ? AND kind = 'user'", g.id);
  const denied = await svc.handle("helper.context", { entry: { kind: "global" }, readRoomIds: [g.id] });
  assert.equal(!denied.ok && denied.error.code, "forbidden");
  const missing = await svc.handle("helper.context", { entry: { kind: "global" }, readRoomIds: ["g-none"] });
  assert.equal(!missing.ok && missing.error.code, "not_found");
  await host.close();
});

test("侧栏读当前聊天;侧栏里的问答只记在侧栏,不进会话、不送联系人;再打开能看到记录", async () => {
  const rounds: string[] = [];
  const host = new Host({ file: file(), mind: () => quiet(rounds), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: g.id, clientActionId: "g1", text: "今天的进度" });
  await settle(host);
  const roundsBefore = rounds.length;
  const msgsBefore = host.listMessages(g.id, {}).messages.length;

  const ctx = await svc.handle("helper.context", { entry: { kind: "sidebar", roomId: g.id } });
  assert.ok(ctx.ok, JSON.stringify(ctx));
  const cv = ctx.value as { route: unknown; rooms: { roomId: string; messages: { text: string }[] }[] };
  assert.deepEqual(cv.route, { replyIn: "sidebar", becomesMessage: false, contextRoomId: g.id, replyToSeq: null });
  assert.deepEqual(cv.rooms.map((r) => [r.roomId, r.messages.map((m) => m.text)]), [[g.id, ["今天的进度"]]]);

  const q = await svc.handle("helper.note", { entry: { kind: "sidebar", roomId: g.id }, role: "user", text: "帮我看看谁在忙", clientActionId: "s1" });
  const a = await svc.handle("helper.note", { entry: { kind: "sidebar", roomId: g.id }, role: "helper", text: "小克空闲", clientActionId: "s2" });
  const again = await svc.handle("helper.note", { entry: { kind: "sidebar", roomId: g.id }, role: "helper", text: "小克空闲", clientActionId: "s2" });
  assert.ok(q.ok && a.ok && again.ok, JSON.stringify([q, a, again]));
  assert.equal((again.value as { id: string }).id, (a.value as { id: string }).id, "同一 clientActionId 重放不重复记");
  await settle(host);
  assert.equal(host.listMessages(g.id, {}).messages.length, msgsBefore, "侧栏对话不上公屏");
  assert.equal(rounds.length, roundsBefore, "联系人没有收到侧栏对话");

  const hist = await svc.handle("helper.history", { entry: { kind: "sidebar", roomId: g.id } });
  assert.ok(hist.ok, JSON.stringify(hist));
  assert.deepEqual((hist.value as { notes: { role: string; text: string; roomId: string; scope: string }[] }).notes.map((n) => [n.scope, n.roomId, n.role, n.text]), [
    ["sidebar", g.id, "user", "帮我看看谁在忙"],
    ["sidebar", g.id, "helper", "小克空闲"],
  ]);
  const globalHist = await svc.handle("helper.history", { entry: { kind: "global" } });
  assert.ok(globalHist.ok);
  assert.deepEqual((globalHist.value as { notes: unknown[] }).notes, [], "侧栏记录不混进全局面板");
  await host.close();
});

test("聊天里 @Helper:回复作为一条 helper 消息出现在当前聊天、回复那条 @ 它的消息;联系人照常看到;没被 @ 不能公开回复", async () => {
  const rounds: string[] = [];
  const host = new Host({ file: file(), mind: () => quiet(rounds), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const plain = host.send({ roomId: g.id, clientActionId: "g0", text: "随便说一句" });
  const ask = host.send({ roomId: g.id, clientActionId: "g1", text: "@Helper 总结一下", mentions: [{ id: HELPER_ID, source: "manual" }] });
  await settle(host);

  const ctx = await svc.handle("helper.context", { entry: { kind: "mention", roomId: g.id, seq: ask.seq } });
  assert.ok(ctx.ok, JSON.stringify(ctx));
  assert.deepEqual((ctx.value as { route: unknown }).route, { replyIn: "conversation", becomesMessage: true, contextRoomId: g.id, replyToSeq: ask.seq });

  const r = await svc.handle("helper.post", { entry: { kind: "mention", roomId: g.id, seq: ask.seq }, text: "总结:一切正常", clientActionId: "h1" });
  assert.ok(r.ok, JSON.stringify(r));
  const m = r.value as { seq: number; sender: { kind: string; id: string }; replyToSeq: number | null; text: string };
  assert.deepEqual([m.sender, m.replyToSeq, m.text], [{ kind: "helper", id: HELPER_ID }, ask.seq, "总结:一切正常"]);
  const replay = await svc.handle("helper.post", { entry: { kind: "mention", roomId: g.id, seq: ask.seq }, text: "总结:一切正常", clientActionId: "h1" });
  assert.equal(replay.ok && (replay.value as { seq: number }).seq, m.seq, "重放不重复发");
  await settle(host);
  assert.ok(rounds.includes(`小克:${g.id}#${m.seq}:helper`), "公开回复和普通消息一样送到群里的联系人");
  assert.deepEqual(senderAudit(host, g.id), { ok: true, checked: 3, offenders: [] }, "回复 @Helper 的 helper 消息不算越界发言");

  const notAsked = await svc.handle("helper.post", { entry: { kind: "mention", roomId: g.id, seq: plain.seq }, text: "插一句", clientActionId: "h2" });
  assert.equal(!notAsked.ok && notAsked.error.code, "invalid_params", "那条消息没有 @Helper,不能公开回复");
  const sidebarPost = await svc.handle("helper.post", { entry: { kind: "sidebar", roomId: g.id }, text: "侧栏里的话", clientActionId: "h3" });
  assert.equal(!sidebarPost.ok && sidebarPost.error.code, "invalid_params", "侧栏/全局的回复不能发成会话消息");
  assert.equal(host.listMessages(g.id, {}).messages.length, 3);
  await host.close();
});
