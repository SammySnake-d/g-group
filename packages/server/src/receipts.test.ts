// AC-46 已读回执的判定部分(U35/U70、D09.3、#30/#732/#2862/#3035):
//   ③ 只进队列不算已读(消息已入账本、已送达,但联系人这一轮还没接走 → 未读);
//   ④ 接走即已读:宿主开始这一轮就把 read_seq 推到这条,读到时间 = 接走时刻;接走后这一轮失败,read_seq 不回退;
//      任何时刻 read_seq ≥ processed_seq(processed_seq 照旧在落盘后才推进,只用于显示的是 read_seq);
//   ② 读到时间取位置第一次越过这条消息的时刻,不是最后一次读。
// 阴性对照(同一文件):发送人自己不在名单里;已读位置只增不减,重复上报更早的位置不改回执。
// 回执的显示与「表情不算已读」在 chat-ops.test.ts / 前端走查里,这里只判宿主的位置语义。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind } from "@g-group/kernel";
import { one } from "./db.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-receipts-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `r${++n}.db`);
let tick = 0;
/** 每次取时间递增一秒:读到时间能分辨「第一次越过」与「最后一次读」。 */
const clock = () => new Date(Date.UTC(2026, 10, 12, 0, 0, tick++)).toISOString();
/** 不说话的联系人:只测位置语义,不跑轮次的副作用。 */
const silent = (): ContactMind => ({ round: async () => ({ actions: [], stateNote: null }) });
const opts = (f = file(), extra: Record<string, unknown> = {}) => ({ file: f, mind: silent, now: clock, maxDeferMs: 5, ...extra });
const member = (contactId: string) => ({ kind: "contact" as const, id: contactId });
/** 联系人在这个会话里已处理到的位置(gg_cursor.processed_seq)。 */
const processedSeq = (host: Host, contactId: string, roomId: string) =>
  one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", contactId, roomId)?.processed_seq ?? 0;
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.loop.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
async function until(what: () => boolean, why: string) {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等到超时:${why}`);
}

test("AC-46 ③ 只进队列不算已读:消息已入账本、已送达,联系人还没接走时回执未读;接走之后同一条才变已读", async () => {
  // 注意循环停住 = 消息已经写进账本并送达,但这一轮还没接走
  const quiet = new Host(opts());
  const q = quiet.createContact({ name: "小克" });
  const qg = quiet.createGroup("项目群", [{ kind: "contact", id: q.id }]);
  await quiet.loop.stop();
  const queued = quiet.send({ roomId: qg.id, clientActionId: "q1", text: "这条先放着" });
  assert.deepEqual(quiet.receipts(qg.id, queued.seq).read, [], "没人接走就不算已读");
  assert.deepEqual(quiet.receipts(qg.id, queued.seq).unread.map((x) => x.member.id), [q.id]);
  assert.equal(quiet.listMessages(qg.id, {}).messages.some((m) => m.seq === queued.seq), true, "消息已经写进账本");
  assert.ok(queued.seq > processedSeq(quiet, q.id, qg.id), "已经在联系人的未读区间里(游标还没到它)");
  assert.equal(quiet.readSeq(qg.id, member(q.id)), 0, "已读位置没动");
  await quiet.close();

  // 同一条消息被接走(开始这一轮)之后才变已读
  const taken = new Host(opts());
  const c = taken.createContact({ name: "小克" });
  const g = taken.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const m = taken.send({ roomId: g.id, clientActionId: "t1", text: "这条会被接走" });
  assert.deepEqual(taken.receipts(g.id, m.seq).unread.map((x) => x.member.id), [c.id], "接走之前先是未读");
  await until(() => taken.readSeq(g.id, member(c.id)) >= m.seq, "接走即已读");
  assert.deepEqual(taken.receipts(g.id, m.seq).read.map((x) => x.member.id), [c.id]);
  assert.deepEqual(taken.receipts(g.id, m.seq).unread, []);
  await taken.close();
});

test("AC-46 ④ 接走后这一轮失败:read_seq 已推进到这条且不回退,processed_seq 不动,read_seq ≥ processed_seq", async () => {
  let first = true;
  const mind = (): ContactMind => ({
    async round() {
      if (first) {
        first = false;
        throw new Error("这一轮炸了");
      }
      return { actions: [], stateNote: null };
    },
  });
  const host = new Host(opts(undefined, { mind }));
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const m = host.send({ roomId: g.id, clientActionId: "f1", text: "接走之后这一轮会失败" });
  await until(() => host.readSeq(g.id, member(c.id)) >= m.seq, "接走即已读");
  const after = host.readSeq(g.id, member(c.id));
  assert.equal(processedSeq(host, c.id, g.id), 0, "这一轮没落盘,processed_seq 不动");
  assert.ok(after >= processedSeq(host, c.id, g.id), "read_seq ≥ processed_seq");
  assert.deepEqual(host.receipts(g.id, m.seq).read.map((x) => x.member.id), [c.id], "这一轮失败也不退回未读");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(host.readSeq(g.id, member(c.id)), after, "退避重试期间与之后都不回退");
  await host.close();
});

test("AC-46 ④ 接走即已读、processed_seq 与 read_seq 分开:这一轮还没跑完时 read_seq 已到这条、processed_seq 还没动", async () => {
  let gid = "";
  let cid = "";
  let host: Host | null = null;
  let during: { read: number; processed: number } | null = null;
  const mind = (): ContactMind => ({
    async round() {
      // 这一轮已经开始(接走),但还没有落盘:位置该到这条,processed_seq 该不动
      during = { read: host!.readSeq(gid, member(cid)), processed: processedSeq(host!, cid, gid) };
      await new Promise((r) => setTimeout(r, 20));
      return { actions: [], stateNote: null };
    },
  });
  const h = new Host(opts(undefined, { mind }));
  host = h;
  const c = h.createContact({ name: "小克" });
  cid = c.id;
  const g = h.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  gid = g.id;
  const m = h.send({ roomId: g.id, clientActionId: "mid", text: "跑一半时看位置" });
  await until(() => during !== null, "这一轮进入模型调用");
  const seen = during as unknown as { read: number; processed: number };
  assert.equal(seen.read, m.seq, "接走即已读:位置已经推到这条");
  assert.equal(seen.processed, 0, "这一轮还没落盘,processed_seq 不动");
  assert.ok(seen.read >= seen.processed, "read_seq ≥ processed_seq");
  await settle(h);
  assert.equal(processedSeq(h, c.id, g.id), m.seq, "落盘后 processed_seq 跟上");
  assert.ok(h.readSeq(g.id, member(c.id)) >= processedSeq(h, c.id, g.id), "read_seq ≥ processed_seq 仍成立");
  await h.close();
});

test("AC-46 ② 读到时间 = 位置第一次越过这条消息的时刻,之后又读到新消息不改早先那条的时间", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const m1 = host.send({ roomId: g.id, clientActionId: "t1", text: "第一条" });
  await settle(host);
  const firstAt = host.receipts(g.id, m1.seq).read[0]!.at;
  assert.equal(host.readSeq(g.id, member(c.id)), m1.seq, "第一次读到位置 1");
  const m2 = host.send({ roomId: g.id, clientActionId: "t2", text: "第二条" });
  const m3 = host.send({ roomId: g.id, clientActionId: "t3", text: "第三条" });
  await settle(host);
  const laterAt = host.receipts(g.id, m3.seq).read[0]!.at;
  assert.ok(laterAt > firstAt, "后面的消息是后读到的");
  assert.equal(host.receipts(g.id, m1.seq).read[0]!.at, firstAt, "早先那条留着第一次越过的时刻,不被后来的读盖掉");
  assert.equal(host.receipts(g.id, m2.seq).read[0]!.at, laterAt, "同一批读到的几条共用那一刻");
  await host.close();
});

test("AC-46 阴性对照:发送人不在名单里;已读位置只增不减,重复上报更早的位置不改回执", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const older = host.send({ roomId: g.id, clientActionId: "o1", text: "早一条" });
  const newer = host.send({ roomId: g.id, clientActionId: "o2", text: "晚一条" });
  await settle(host);
  const view = host.receipts(g.id, older.seq);
  assert.deepEqual([view.read.map((x) => x.member.id), view.unread], [[c.id], []], "名单 = 成员减发送人(自己不算)");
  assert.ok(!view.read.some((x) => x.member.kind === "user"), "用户自己不在名单里");
  const readAt = view.read[0]!.at;
  // 更早的位置再报一次(重放、乱序回执):位置不动,回执不改,也不给订阅者发回退事件
  const pushed: number[] = [];
  const off = host.bus.subscribe((e) => {
    if (e.type === "receipt.updated" && e.member.kind === "contact") pushed.push(e.readSeq);
  });
  host.markRead(g.id, member(c.id), older.seq);
  off();
  assert.equal(host.readSeq(g.id, member(c.id)), newer.seq, "已读位置只增不减");
  assert.deepEqual(pushed, [], "重复上报更早的位置不发 receipt.updated(界面不会把读过的又标回未读)");
  assert.equal(host.receipts(g.id, older.seq).read[0]!.at, readAt, "重复上报不改读到时间");
  await host.close();
});
