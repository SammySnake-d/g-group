// 群管理与消息操作(U03/U23/U26/U100,D05):
// - 解散:只有群主能解散;先停本群在途任务,真实停止确认前不算解散完、不归还槽位(AC-23/U09);解散后只读、不再送达联系人,记录保留;重复解散幂等。
// - 删除/多选删除/清空(U23):只在用户这一端隐藏,消息列表、搜索、预览不再返回;联系人上下文照旧(与撤回对照);只追加,原记录不变(AC-05)。
// - 群主撤回别人的消息(U26):对所有人生效并走撤回级联(AC-08);非群主撤回别人的被拒。
// - 禁言(U03,候选,只做最小一项):被禁言联系人在该群发的消息被拒收、下一轮输入里写明它被禁言;别的不变(任务照跑、私聊照常、不发通知);解除后恢复。
// - system 发言者(只给宿主通知用):写进群里,不唤醒联系人、不进账本待处理、不能作为接活来源。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { QuiesceResult } from "@g-group/adapter-cc-compute";
import { loadLog } from "@g-group/adapter-sqlite";
import type { MessageView, RoomView, ServerEvent } from "@g-group/api-contract";
import type { ContactMind, RoundInput } from "@g-group/kernel";
import { all, getDoc } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-chat-admin-"));
after(() => rmSync(dir, { recursive: true, force: true }));
// 断言中途失败时也关掉本条用例起的宿主与替身,不留计时器和卡住的轮次
const live: { hosts: Host[]; computes: { close(): void }[]; gates: (() => void)[] } = { hosts: [], computes: [], gates: [] };
const track = (h: Host) => {
  live.hosts.push(h);
  return h;
};
afterEach(async () => {
  for (const g of live.gates.splice(0)) g();
  for (const c of live.computes.splice(0)) c.close();
  for (const h of live.hosts.splice(0)) await h.close();
});
let n = 0;
const file = () => path.join(dir, `a${++n}.db`);
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await tick();
  }
}
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
const okValue = <T>(r: { ok: boolean; value?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};
const errOf = (r: { ok: boolean; error?: { code: string; message: string } }) => (r.ok ? null : [r.error!.code, r.error!.message]);
const contact = (id: string) => ({ kind: "contact" as const, id });
const at = (id: string) => [{ id, source: "manual" as const }];
const freshTexts = (i: RoundInput) => i.fresh.map((f) => (f.kind === "message" ? f.text : f.kind));
const DISSOLVED = "这个群已解散(或正在解散),只读:不能在这里发言或接新活";
const muteText = (title: string) => `你在「${title}」群被禁言,在那里发的消息会被拒收`;
/** 一直跑、不自己结束的 Compute;停止确认(quiesce)由测试放行 */
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
  live.computes.push(compute);
  return { compute, asked, finish: (id: string) => gates.get(id)?.({ ok: true, killed: 1 }) };
}
/** 原记录快照:这个会话的只追加事件与消息结构化记录(按 seq) */
function records(host: Host, roomId: string) {
  return {
    events: all<Record<string, unknown>>(host.db, "SELECT * FROM events WHERE session = ? ORDER BY seq", `room:${roomId}`),
    msgs: all<Record<string, unknown>>(host.db, "SELECT * FROM gg_msg WHERE room_id = ? ORDER BY seq", roomId),
  };
}
const rejections = (out: string[]) => (what: string, d: unknown) => {
  if (what === "action-rejected") out.push(`${(d as { action: { kind: string } }).action.kind}:${(d as { reason: string }).reason}`);
};

// ======================= 解散 =======================

test("解散只有群主能做(非群主、私聊被拒);解散后列表标已解散、记录保留、会话只读,联系人不再收到也不能再发言", async () => {
  const f = file();
  const rounds: { contact: string; texts: string[] }[] = [];
  const rejected: string[] = [];
  let gateOn = false;
  let blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  live.gates.push(() => release());
  const mind = (): ContactMind => {
    const inner = scriptedMind({ onRound: (i) => rounds.push({ contact: i.contact.id, texts: freshTexts(i) }) });
    return {
      async round(input, signal) {
        if (gateOn && input.fresh.some((x) => x.kind === "message" && x.text === "在吗")) {
          blocked = true;
          await gate;
        }
        return inner.round(input, signal);
      },
    };
  };
  const h1 = track(new Host({ file: f, mind, maxDeferMs: 5 }));
  const a = h1.createContact({ name: "小前" });
  const b = h1.createContact({ name: "小安" });
  const g = h1.createGroup("研发群", [contact(a.id), contact(b.id), { kind: "user", id: "u2" }]);
  const dm = h1.openDm(a.id);
  h1.send({ roomId: g.id, clientActionId: "m1", text: "大家好", mentions: at(a.id) });
  await settle(h1);
  await h1.close();

  // 群里的另一位用户打开同一份数据:不是群主,解散与禁言都被拒,群没变
  const h2 = track(new Host({ file: f, userId: "u2", mind, maxDeferMs: 5 }));
  const s2 = createService(h2);
  assert.deepEqual(errOf(await s2.handle("rooms.dissolve", { roomId: g.id, clientActionId: "x1" })), ["forbidden", "只有群主能解散群"]);
  assert.deepEqual(errOf(await s2.handle("rooms.muteMember", { roomId: g.id, contactId: a.id, muted: true, clientActionId: "x2" })), ["forbidden", "只有群主能禁言"]);
  assert.deepEqual([h2.roomView(g.id).ownerId, h2.roomView(g.id).dissolution, h2.roomView(g.id).mutedMembers], ["me", undefined, undefined]);
  await h2.close();

  // 群主:攒批放长,b 的送达只在测试显式叫醒时发生
  const h = track(new Host({ file: f, mind, maxDeferMs: 60_000, onReport: rejections(rejected) }));
  const svc = createService(h);
  assert.deepEqual(errOf(await svc.handle("rooms.dissolve", { roomId: dm.id, clientActionId: "y1" })), ["forbidden", "私聊不能解散群"]);
  // a 这一轮已经开跑(卡住):解散后它交回的发言被拒收
  gateOn = true;
  h.send({ roomId: g.id, clientActionId: "m2", text: "在吗", mentions: at(a.id) });
  await until(() => blocked, "a 这一轮开跑");
  const done = okValue<RoomView>(await svc.handle("rooms.dissolve", { roomId: g.id, clientActionId: "d1" }));
  assert.equal(done.dissolution, "dissolved");
  release();
  await until(() => rejected.length === 1, "a 的发言被拒收");
  // b 还没接到「在吗」:解散后叫醒它也收不到
  const bBefore = rounds.filter((r) => r.contact === b.id).length;
  h.loop.notify(b.id, "now");
  await settle(h);
  assert.equal(rounds.filter((r) => r.contact === b.id).length, bBefore);
  assert.deepEqual(rejected, [`reply:${DISSOLVED}`]);

  // 列表照常列出并标已解散;记录保留,解散说明以 system 发言者记一条
  const listed = okValue<{ rooms: RoomView[] }>(await svc.handle("rooms.list", {})).rooms.find((r) => r.id === g.id);
  assert.equal(listed?.dissolution, "dissolved");
  assert.deepEqual(
    h.listMessages(g.id, {}).messages.map((m) => [m.sender.kind, m.text]),
    [
      ["user", "大家好"],
      ["contact", "收到:大家好"],
      ["user", "在吗"],
      ["system", "本群已解散:记录保留可查,不能再发言,也不再给联系人派活"],
    ],
  );
  // 只读:发言、编辑、拉人、禁言都被拒;私聊照常
  const first = h.listMessages(g.id, {}).messages[0]!;
  assert.deepEqual(errOf(await svc.handle("messages.send", { roomId: g.id, clientActionId: "m3", text: "还在吗" })), ["conflict", DISSOLVED]);
  assert.deepEqual(errOf(await svc.handle("messages.edit", { roomId: g.id, seq: first.seq, text: "改一下" })), ["conflict", DISSOLVED]);
  assert.deepEqual(errOf(await svc.handle("rooms.addMembers", { roomId: g.id, members: [contact(b.id)] })), ["conflict", DISSOLVED]);
  assert.deepEqual(errOf(await svc.handle("rooms.muteMember", { roomId: g.id, contactId: a.id, muted: true, clientActionId: "x3" })), ["conflict", DISSOLVED]);
  okValue(await svc.handle("messages.send", { roomId: dm.id, clientActionId: "m4", text: "私聊还能聊" }));
  await settle(h);
  assert.equal(h.listMessages(dm.id, {}).messages.at(-1)?.text, "收到:私聊还能聊");
  await h.close();
});

test("解散先停在途任务:停止确认前标解散中、只读、槽位不归还、重复解散不重复停止;全部确认后才解散、归还槽位、本群临时槽位清零", async () => {
  const lr = longRunning();
  const host = track(new Host({ file: file(), mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5 }));
  const svc = createService(host);
  const c = host.createContact({ name: "小前" });
  host.updateContact(c.id, { computeSlots: 1 });
  const g = host.createGroup("研发群", [contact(c.id)]);
  host.updateRoom(g.id, { tempComputeSlots: 1 });
  host.send({ roomId: g.id, clientActionId: "a1", text: "帮我改组件一", mentions: at(c.id) });
  await until(() => lr.compute.spawned.length === 1, "第一件开跑");
  host.send({ roomId: g.id, clientActionId: "a2", text: "帮我改组件二", mentions: at(c.id) });
  await until(() => lr.compute.spawned.length === 2, "第二件借本群临时槽位开跑");
  const tasks = host.listTasks({ roomId: g.id });
  assert.deepEqual(tasks.map((t) => host.quota.leaseOf(t.id)?.scope).sort(), [`group:${g.id}`, `personal:${c.id}`].sort());
  const events: RoomView[] = [];
  host.bus.subscribe((e: ServerEvent) => {
    if (e.type === "room.updated" && e.room.id === g.id) events.push(e.room);
  });

  const v = okValue<RoomView>(await svc.handle("rooms.dissolve", { roomId: g.id, clientActionId: "d1" }));
  assert.equal(v.dissolution, "dissolving");
  await until(() => lr.asked.length === 2, "宿主去确认两个 Compute 停下");
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(tasks.map((t) => host.taskDoc(t.id).value.task.state), ["T9_StopRequested", "T9_StopRequested"]);
  assert.deepEqual(tasks.map((t) => host.quota.leaseOf(t.id)?.stopping), [true, true], "停止请求发出 ≠ 已停止,槽位还占着");
  assert.deepEqual([host.roomView(g.id).dissolution, host.roomView(g.id).tempComputeSlots], ["dissolving", 1]);
  assert.deepEqual(errOf(await svc.handle("messages.send", { roomId: g.id, clientActionId: "a3", text: "还在吗" })), ["conflict", DISSOLVED]);
  const again = okValue<RoomView>(await svc.handle("rooms.dissolve", { roomId: g.id, clientActionId: "d2" }));
  assert.equal(again.dissolution, "dissolving");
  assert.equal(lr.compute.stopped.length, 2, "重复解散不重复发停止");

  lr.finish(lr.asked[0]!);
  await until(() => tasks.some((t) => host.taskDoc(t.id).value.task.state === "T10_Cancelled"), "第一件确认停下");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(host.roomView(g.id).dissolution, "dissolving", "还有一件没确认,不算解散完");
  assert.equal(host.roomView(g.id).tempComputeSlots, 1);
  lr.finish(lr.asked[1]!);
  await until(() => host.roomView(g.id).dissolution === "dissolved", "全部确认后解散");
  assert.deepEqual(
    tasks.map((t) => [host.taskDoc(t.id).value.task.state, host.quota.leaseOf(t.id)]),
    [
      ["T10_Cancelled", undefined],
      ["T10_Cancelled", undefined],
    ],
  );
  assert.equal(host.roomView(g.id).tempComputeSlots, 0);
  const notices = () => host.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system").map((m) => m.text);
  assert.deepEqual(notices(), ["本群已解散:记录保留可查,不能再发言,也不再给联系人派活"]);
  assert.deepEqual(events.map((r) => r.dissolution).filter((d, i, xs) => d !== xs[i - 1]), ["dissolving", "dissolved"]);
  // 已解散后再调用:幂等,不再记说明、不再停任何东西
  assert.equal(okValue<RoomView>(await svc.handle("rooms.dissolve", { roomId: g.id, clientActionId: "d3" })).dissolution, "dissolved");
  assert.deepEqual([notices().length, lr.compute.stopped.length], [1, 2]);
  lr.compute.close();
  await host.close();
});

// ======================= 删除 / 多选删除 / 清空 =======================

test("删除与多选删除只在用户这一端隐藏:消息列表、搜索、会话预览不再返回;不存在的 seq 逐条报错不影响其他;同一 clientActionId 重放不重复记", async () => {
  const host = track(new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 }));
  const svc = createService(host);
  const hiddenEvents: unknown[] = [];
  host.bus.subscribe((e: ServerEvent) => {
    if (e.type === "message.hidden") hiddenEvents.push({ roomId: e.roomId, seqs: e.seqs, uptoSeq: e.uptoSeq });
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m1 = host.send({ roomId: dm.id, clientActionId: "1", text: "灰度方案甲" });
  await settle(host);
  const m2 = host.send({ roomId: dm.id, clientActionId: "2", text: "灰度方案乙" });
  await settle(host);
  const m3 = host.send({ roomId: dm.id, clientActionId: "3", text: "灰度方案丙" });
  await settle(host);
  const seqsOf = (ms: readonly { seq: number }[]) => ms.map((m) => m.seq).sort((x, y) => x - y);
  const all0 = host.listMessages(dm.id, {}).messages;
  assert.equal(all0.length, 6);
  const [, r1, , r2, , r3] = all0;
  assert.deepEqual(seqsOf(host.searchMessages({ query: "灰度方案" }).hits), seqsOf(all0));

  const res = okValue<{ results: unknown[] }>(await svc.handle("messages.delete", { roomId: dm.id, seqs: [m1.seq, 999, m3.seq], clientActionId: "del-1" }));
  assert.deepEqual(res.results, [
    { seq: m1.seq, ok: true, error: null },
    { seq: 999, ok: false, error: { code: "not_found", message: "这个会话里没有 #999" } },
    { seq: m3.seq, ok: true, error: null },
  ]);
  assert.deepEqual(seqsOf(host.listMessages(dm.id, {}).messages), [r1!.seq, m2.seq, r2!.seq, r3!.seq]);
  assert.deepEqual(seqsOf(host.searchMessages({ query: "灰度方案" }).hits), [r1!.seq, m2.seq, r2!.seq, r3!.seq]);
  assert.equal(errOf(await svc.handle("messages.list", { roomId: dm.id, aroundSeq: m1.seq }))?.[0], "not_found");
  assert.deepEqual(hiddenEvents, [{ roomId: dm.id, seqs: [m1.seq, m3.seq], uptoSeq: null }]);
  // 重放同一 clientActionId:原样返回,不再追加隐藏记录
  const rows = () => all(host.db, "SELECT * FROM gg_view_hides").length;
  const before = rows();
  const replay = okValue<{ results: unknown[] }>(await svc.handle("messages.delete", { roomId: dm.id, seqs: [m1.seq, 999, m3.seq], clientActionId: "del-1" }));
  assert.deepEqual([replay.results, rows()], [res.results, before]);
  // 删掉最后一条:会话预览退到上一条看得见的
  assert.equal(host.roomView(dm.id).lastMessagePreview, "收到:灰度方案丙");
  okValue(await svc.handle("messages.delete", { roomId: dm.id, seqs: [r3!.seq], clientActionId: "del-2" }));
  assert.equal(host.roomView(dm.id).lastMessagePreview, "收到:灰度方案乙");
  // 一条都没选:参数不合格
  assert.equal(errOf(await svc.handle("messages.delete", { roomId: dm.id, seqs: [], clientActionId: "del-3" }))?.[0], "invalid_params");
  await host.close();
});

test("删除只动本端视图,和撤回不同:联系人照常收到被删的消息、收不到撤回的原文;原记录与结构化记录不变,隐藏记录只追加", async () => {
  const rounds: string[][] = [];
  const host = track(new Host({ file: file(), mind: () => scriptedMind({ onRound: (i) => rounds.push(freshTexts(i)) }), maxDeferMs: 5 }));
  const c = host.createContact({ name: "小运" });
  const g = host.createGroup("运营群", [contact(c.id)]);
  const keep = host.send({ roomId: g.id, clientActionId: "1", text: "周报草稿在共享盘" });
  await settle(host);
  // 发出后联系人还没接(没 @,攒批)就在自己这端删除;另一条发出后立刻撤回
  const del = host.send({ roomId: g.id, clientActionId: "2", text: "预算表第二版" });
  const snap = records(host, g.id);
  host.deleteMessages({ roomId: g.id, seqs: [del.seq, keep.seq], clientActionId: "d1" });
  const hides1 = all(host.db, "SELECT * FROM gg_view_hides ORDER BY id");
  const ret = host.send({ roomId: g.id, clientActionId: "3", text: "临时口令 NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  host.retractMessage(g.id, ret.seq);
  await settle(host);
  const seen = rounds.flat();
  assert.ok(seen.includes("预算表第二版"), `删除不影响联系人上下文:${JSON.stringify(rounds)}`);
  assert.ok(!seen.some((t) => t.includes("NEUTRAL_FIXTURE_NO_CREDENTIALS")), "撤回的原文不进联系人上下文");
  assert.ok(seen.includes(`(撤回了 #${ret.seq})`));
  // 用户这一端:删除的看不见,撤回的是占位
  assert.deepEqual(host.listMessages(g.id, {}).messages.map((m) => [m.seq, m.text, m.retracted]), [[ret.seq, "", true]]);
  // 原记录:删除前的事件与结构化记录逐字节不变,hash 链完整
  const now = records(host, g.id);
  assert.deepEqual(now.events.slice(0, snap.events.length), snap.events);
  assert.deepEqual(now.msgs.slice(0, snap.msgs.length), snap.msgs);
  assert.deepEqual(loadLog(host.db.store, `room:${g.id}`).check, { ok: true });
  // 隐藏记录只追加:再清空一次,之前的行原样保留,只多一行;库里改写或删除隐藏记录被拒
  host.clearHistory({ roomId: g.id, clientActionId: "c1" });
  const hides2 = all(host.db, "SELECT * FROM gg_view_hides ORDER BY id");
  assert.deepEqual([hides2.slice(0, hides1.length), hides2.length], [hides1, hides1.length + 1]);
  assert.throws(() => host.db.store.db.exec("UPDATE gg_view_hides SET seq = 0"), /append-only/);
  assert.throws(() => host.db.store.db.exec("DELETE FROM gg_view_hides"), /append-only/);
  await host.close();
});

test("清空:此刻为止的全部消息从用户视图、搜索与预览消失,之后的新消息照常可见;联系人上下文不受影响;同一 clientActionId 重放不重复记", async () => {
  const rounds: string[][] = [];
  const host = track(new Host({ file: file(), mind: () => scriptedMind({ onRound: (i) => rounds.push(freshTexts(i)) }), maxDeferMs: 5 }));
  const svc = createService(host);
  const c = host.createContact({ name: "小运" });
  const g = host.createGroup("运营群", [contact(c.id)]);
  host.send({ roomId: g.id, clientActionId: "1", text: "架构评审纪要" });
  const x2 = host.send({ roomId: g.id, clientActionId: "2", text: "架构评审补充" });
  const r = okValue<{ room: RoomView; clearedUptoSeq: number }>(await svc.handle("rooms.clearHistory", { roomId: g.id, clientActionId: "c1" }));
  assert.equal(r.clearedUptoSeq, x2.seq);
  assert.deepEqual([r.room.lastMessagePreview, r.room.unread, r.room.lastSeq], [null, 0, x2.seq]);
  await settle(host);
  assert.deepEqual(rounds.flat(), ["架构评审纪要", "架构评审补充"], "清空不影响联系人上下文");
  assert.deepEqual(host.listMessages(g.id, {}).messages, []);
  assert.deepEqual(host.searchMessages({ query: "架构评审" }).hits, []);
  const x3 = host.send({ roomId: g.id, clientActionId: "3", text: "架构评审下周继续" });
  await settle(host);
  assert.deepEqual(host.listMessages(g.id, {}).messages.map((m) => m.seq), [x3.seq]);
  assert.deepEqual(host.searchMessages({ query: "架构评审" }).hits.map((h) => h.seq), [x3.seq]);
  assert.equal(host.roomView(g.id).lastMessagePreview, "架构评审下周继续");
  const rows = all(host.db, "SELECT * FROM gg_view_hides").length;
  const replay = okValue<{ clearedUptoSeq: number }>(await svc.handle("rooms.clearHistory", { roomId: g.id, clientActionId: "c1" }));
  assert.deepEqual([replay.clearedUptoSeq, all(host.db, "SELECT * FROM gg_view_hides").length, host.listMessages(g.id, {}).messages.length], [x2.seq, rows, 1]);
  await host.close();
});

// ======================= 群主撤回别人的消息 =======================

test("群主撤回联系人在群里的消息:对所有人生效并走撤回级联;非群主撤回别人的被拒;私聊仍只能撤回自己的", async () => {
  const f = file();
  const rounds: { contact: string; texts: string[] }[] = [];
  const mind = () => scriptedMind({ onRound: (i) => rounds.push({ contact: i.contact.id, texts: freshTexts(i) }) });
  const h1 = track(new Host({ file: f, mind, maxDeferMs: 5 }));
  const a = h1.createContact({ name: "小前" });
  const b = h1.createContact({ name: "小安" });
  const g = h1.createGroup("研发群", [contact(a.id), contact(b.id), { kind: "user", id: "u2" }]);
  h1.send({ roomId: g.id, clientActionId: "1", text: "灰度开关在哪", mentions: at(a.id) });
  await settle(h1);
  const reply = h1.listMessages(g.id, {}).messages.find((m) => m.sender.kind === "contact" && m.sender.id === a.id)!;
  assert.equal(reply.text, "收到:灰度开关在哪");
  await h1.close();

  const h2 = track(new Host({ file: f, userId: "u2", mind, maxDeferMs: 5 }));
  assert.deepEqual(errOf(await createService(h2).handle("messages.retract", { roomId: g.id, seq: reply.seq })), ["forbidden", "只能改自己发的消息;群里只有群主能撤回别人的消息"]);
  assert.equal(h2.listMessages(g.id, {}).messages.find((m) => m.seq === reply.seq)?.retracted, false);
  await h2.close();

  const h = track(new Host({ file: f, mind, maxDeferMs: 5 }));
  const svc = createService(h);
  const quoting = h.send({ roomId: g.id, clientActionId: "2", text: "这个回答不对", replyToSeq: reply.seq });
  await settle(h);
  assert.deepEqual(h.searchMessages({ query: "收到:灰度开关" }).hits.map((x) => x.seq), [reply.seq]);
  const from = rounds.length;
  const r = okValue<MessageView>(await svc.handle("messages.retract", { roomId: g.id, seq: reply.seq }));
  assert.deepEqual([r.text, r.retracted, r.sender], ["", true, { kind: "contact", id: a.id }]);
  await settle(h);
  // 级联:搜索不再返回原文;引用块变成已撤回占位;两位联系人(含原发言者)下一轮收到「撤回了」、不再见到原文
  assert.deepEqual(h.searchMessages({ query: "收到:灰度开关" }).hits, []);
  const q = h.listMessages(g.id, {}).messages.find((m) => m.seq === quoting.seq)!.quotes[0];
  assert.deepEqual([q?.state, q?.excerpt], ["retracted", ""]);
  const later = rounds.slice(from);
  for (const id of [a.id, b.id]) assert.ok(later.some((x) => x.contact === id && x.texts.includes(`(撤回了 #${reply.seq})`)), `${id} 收到撤回:${JSON.stringify(later)}`);
  assert.ok(!later.some((x) => x.texts.some((t) => t.includes("收到:灰度开关在哪"))));
  // 私聊里没有群主:仍只能撤回自己的
  const dm = h.openDm(a.id);
  h.send({ roomId: dm.id, clientActionId: "3", text: "你好" });
  await settle(h);
  const dmReply = h.listMessages(dm.id, {}).messages.find((m) => m.sender.kind === "contact")!;
  assert.deepEqual(errOf(await svc.handle("messages.retract", { roomId: dm.id, seq: dmReply.seq })), ["forbidden", "只能改自己发的消息"]);
  await h.close();
});

// ======================= 禁言(候选,只做最小一项) =======================

test("禁言:被禁言的联系人在该群发的消息(回复、交付)被拒收并记违规,下一轮输入里写明它被禁言;任务照跑、不发通知、私聊照常;解除后恢复", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  live.computes.push(compute);
  const rejected: string[] = [];
  const rounds: { texts: string[]; blocks: string }[] = [];
  const host = track(new Host({
    file: file(),
    mind: () => scriptedMind({ onRound: (i) => rounds.push({ texts: freshTexts(i), blocks: i.request.blocks.map((x) => x.text).join("\n") }) }),
    compute: () => compute.adapter,
    maxDeferMs: 5,
    onReport: rejections(rejected),
  }));
  const svc = createService(host);
  const a = host.createContact({ name: "小旅" });
  const g = host.createGroup("出行群", [contact(a.id)]);
  const dm = host.openDm(a.id);
  assert.deepEqual(errOf(await svc.handle("rooms.muteMember", { roomId: dm.id, contactId: a.id, muted: true, clientActionId: "x" })), ["forbidden", "私聊不能禁言"]);
  host.send({ roomId: g.id, clientActionId: "1", text: "帮我比价机票", mentions: at(a.id) });
  await settle(host, compute);
  const t = host.listTasks({ roomId: g.id })[0]!;
  assert.equal(t.state, "T3_Running");

  const mutedAt = host.lastSeq(g.id);
  const muted = okValue<RoomView>(await svc.handle("rooms.muteMember", { roomId: g.id, contactId: a.id, muted: true, clientActionId: "mu1" }));
  assert.deepEqual(muted.mutedMembers, [contact(a.id)]);
  assert.equal(host.lastSeq(g.id), mutedAt, "禁言本身不往群里发任何消息");
  host.send({ roomId: g.id, clientActionId: "2", text: "今天天气怎么样", mentions: at(a.id) });
  await settle(host, compute);
  compute.emit({ computeId: t.computeRuns[0]!.computeId, kind: "completed", result: "最低 1234 元" });
  await settle(host, compute);
  assert.deepEqual(rejected, [`reply:${muteText("出行群")}`, `deliver:${muteText("出行群")}`]);
  // 拒收的没出现在群里;任务照跑、没被停,也没改投到私聊
  assert.deepEqual(host.listMessages(g.id, { afterSeq: mutedAt }).messages.map((m) => [m.sender.kind, m.text]), [["user", "今天天气怎么样"]]);
  assert.deepEqual([host.taskDoc(t.id).value.task.state, compute.stopped], ["T3_Running", []]);
  assert.deepEqual(host.listMessages(dm.id, {}).messages, []);
  // 下一轮输入里写明它在这个群被禁言
  assert.ok(rounds.at(-1)!.blocks.includes(muteText("出行群")), rounds.at(-1)!.blocks);
  // 私聊不受影响
  host.send({ roomId: dm.id, clientActionId: "3", text: "私下问一句" });
  await settle(host, compute);
  assert.equal(host.listMessages(dm.id, {}).messages.at(-1)?.text, "收到:私下问一句");
  assert.equal(rejected.length, 2);

  // 解除后恢复:群里能发言,输入里不再写被禁言;解除同样不往群里发消息
  const unmutedAt = host.lastSeq(g.id);
  const un = okValue<RoomView>(await svc.handle("rooms.muteMember", { roomId: g.id, contactId: a.id, muted: false, clientActionId: "mu2" }));
  assert.equal(un.mutedMembers, undefined);
  assert.equal(host.lastSeq(g.id), unmutedAt);
  host.send({ roomId: g.id, clientActionId: "4", text: "现在呢", mentions: at(a.id) });
  await settle(host, compute);
  assert.equal(host.listMessages(g.id, {}).messages.at(-1)?.text, "收到:现在呢");
  assert.ok(!rounds.at(-1)!.blocks.includes("被禁言"));
  assert.deepEqual(host.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system"), []);
  compute.close();
  await host.close();
});

// ======================= system 发言者 =======================

test("system 发言者只给宿主通知用:写进群里,不唤醒联系人、不进联系人账本的待处理、不能作为接活或承诺的来源,只在下一轮作上下文", async () => {
  const rounds: { contact: string; fresh: string[][] }[] = [];
  const rejected: string[] = [];
  const host = track(new Host({
    file: file(),
    mind: (c) => {
      const inner = scriptedMind({ onRound: (i) => rounds.push({ contact: i.contact.id, fresh: i.fresh.map((x) => (x.kind === "message" ? [x.sender.kind, x.text] : [x.kind])) }) });
      return {
        async round(input, signal) {
          const out = await inner.round(input, signal);
          if (c.name !== "小安") return out;
          // 小安试图把 system 通知当成接活与承诺的来源
          const extra = input.fresh.flatMap((x) =>
            x.kind === "message" && x.sender.kind === "system"
              ? [
                  { kind: "dispatch" as const, roomId: x.roomId, sourceSeq: x.seq, title: "跟进通知", task: "跟进通知" },
                  { kind: "commit" as const, roomId: x.roomId, sourceSeq: x.seq, text: "资产", taskId: null },
                ]
              : [],
          );
          return { ...out, actions: [...extra, ...out.actions] };
        },
      };
    },
    maxDeferMs: 5,
    onReport: rejections(rejected),
  }));
  const a = host.createContact({ name: "小旅" });
  const b = host.createContact({ name: "小安" });
  const g = host.createGroup("出行群", [contact(a.id), contact(b.id)]);
  const notice = host.postSystemNotice(g.id, "资产「香港 1 号机」租约下周到期", "asset-1");
  await settle(host);
  assert.equal(rounds.length, 0, "system 通知不唤醒任何联系人");
  assert.deepEqual([notice.sender, notice.text], [{ kind: "system", id: "host" }, "资产「香港 1 号机」租约下周到期"]);
  assert.equal(host.postSystemNotice(g.id, "资产「香港 1 号机」租约下周到期", "asset-1").seq, notice.seq, "同一 actionKey 重放不重复写");

  const hi = host.send({ roomId: g.id, clientActionId: "1", text: "你好", mentions: at(b.id) });
  await settle(host);
  const bRound = rounds.find((r) => r.contact === b.id)!;
  assert.deepEqual(bRound.fresh, [
    ["system", notice.text],
    ["user", "你好"],
  ]);
  assert.deepEqual(rejected, ["dispatch:系统通知只作上下文,不能作为接活或承诺的来源", "commit:系统通知只作上下文,不能作为接活或承诺的来源"]);
  assert.deepEqual([host.listTasks({ roomId: g.id }), host.listMessages(g.id, {}).messages.at(-1)?.text], [[], "收到:你好"]);
  const ledger = getDoc<{ messages: { seq: number; handled: boolean }[] }>(host.db, `ledger:${b.id}:${g.id}`)!.value;
  assert.deepEqual(ledger.messages.map((m) => [m.seq, m.handled]), [[hi.seq, true]]);
  await host.close();
});
