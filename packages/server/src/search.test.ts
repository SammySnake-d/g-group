// 基础搜索(AC-25):结果每条带 roomId + #seq 且能用 messages.list({ aroundSeq }) 跳回原位置;
// 只搜自己所在的会话;撤回的消息搜不到,且派生索引表里不再有原文(AC-08);编辑过的按新文字;附件按文件名;
// 索引从只追加日志可重建,重建前后同一查询结果一致。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { ContactMind } from "@g-group/kernel";
import { all } from "./db.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-search-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);
/** 不说话的联系人:这里只测宿主的索引与查询,不跑联系人轮次的副作用。 */
const silent = (): ContactMind => ({ round: async () => ({ actions: [], stateNote: null }) });
let tick = 0;
/** 每次取时间递增一秒,结果的时间倒序可判定。 */
const clock = () => new Date(Date.UTC(2026, 10, 9, 0, 0, tick++)).toISOString();
const opts = (f = file()) => ({ file: f, mind: silent, now: clock, maxDeferMs: 60_000 });
const seqs = (r: { hits: { seq: number }[] }) => r.hits.map((h) => h.seq);
const indexRows = (host: Host) => all<Record<string, unknown>>(host.db, "SELECT * FROM gg_search");

test("搜索:命中自己所在会话的消息,每条带 roomId、seq、threadRootSeq、发送人与关键词片段,按时间倒序", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("登录组", [{ kind: "contact", id: c.id }]);
  const dm = host.openDm(c.id);
  const a = host.send({ roomId: g.id, clientActionId: "a", text: "登录接口限流阈值先定 200 QPS" });
  host.send({ roomId: g.id, clientActionId: "b", text: "午饭吃什么" });
  const t = host.send({ roomId: g.id, clientActionId: "c", text: "限流再压测一轮", threadRootSeq: a.seq });
  const d = host.send({ roomId: dm.id, clientActionId: "d", text: "私聊里也提一下限流" });
  const r = host.searchMessages({ query: "限流" });
  assert.deepEqual(r.hits.map((h) => [h.roomId, h.seq]), [[dm.id, d.seq], [g.id, t.seq], [g.id, a.seq]]);
  const top = r.hits[1]!;
  assert.deepEqual(
    { roomTitle: top.roomTitle, threadRootSeq: top.threadRootSeq, sender: top.sender, senderName: top.senderName, matchedIn: top.matchedIn, attachmentName: top.attachmentName },
    { roomTitle: "登录组", threadRootSeq: a.seq, sender: { kind: "user", id: "me" }, senderName: "我", matchedIn: "text", attachmentName: null },
  );
  assert.equal(r.hits[2]!.threadRootSeq, null);
  for (const h of r.hits) {
    assert.ok(h.highlights.length > 0, "片段里要标出关键词位置");
    for (const x of h.highlights) assert.equal(h.snippet.slice(x.start, x.start + x.length), "限流");
  }
  assert.equal(r.hits[2]!.snippet, "登录接口限流阈值先定 200 QPS");
  assert.equal(r.nextCursor, null);
  assert.deepEqual(seqs(host.searchMessages({ query: "限流", roomId: g.id })), [t.seq, a.seq], "指定 roomId 只搜这个会话");
  assert.deepEqual(seqs(host.searchMessages({ query: "限流 压测" })), [t.seq], "多个词全部命中才算");
  await host.close();
});

test("搜索:中文两字词能搜到;% 和 _ 按字面匹配,不当通配符;英文不分大小写", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const pct = host.send({ roomId: dm.id, clientActionId: "a", text: "成功率 100% 了" });
  host.send({ roomId: dm.id, clientActionId: "b", text: "跑了 1000 次" });
  const us = host.send({ roomId: dm.id, clientActionId: "c", text: "变量叫 a_b" });
  host.send({ roomId: dm.id, clientActionId: "d", text: "变量叫 axb" });
  const en = host.send({ roomId: dm.id, clientActionId: "e", text: "Deploy 完成" });
  assert.deepEqual(seqs(host.searchMessages({ query: "100%" })), [pct.seq]);
  assert.deepEqual(seqs(host.searchMessages({ query: "a_b" })), [us.seq]);
  assert.deepEqual(seqs(host.searchMessages({ query: "变量" })), [us.seq + 1, us.seq]);
  assert.deepEqual(seqs(host.searchMessages({ query: "deploy" })), [en.seq]);
  assert.deepEqual(seqs(host.searchMessages({ query: "%" })), [pct.seq]);
  assert.throws(() => host.searchMessages({ query: "   " }), /搜索词不能为空/);
  await host.close();
});

test("搜索:不是成员的会话搜不到——不带 roomId 时排除,指定 roomId 时 forbidden,不存在的会话 not_found", async () => {
  const host = new Host(opts());
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const mine = host.createGroup("我在的群", [{ kind: "contact", id: c.id }]);
  const left = host.createGroup("我退出的群", [{ kind: "contact", id: c.id }]);
  const keep = host.send({ roomId: mine.id, clientActionId: "a", text: "压测报告在这" });
  host.send({ roomId: left.id, clientActionId: "b", text: "压测报告另一份" });
  assert.equal(host.searchMessages({ query: "压测报告" }).hits.length, 2);
  host.removeMember(left.id, { kind: "user", id: "me" });
  assert.deepEqual(host.searchMessages({ query: "压测报告" }).hits.map((h) => [h.roomId, h.seq]), [[mine.id, keep.seq]]);
  const denied = await svc.handle("search.messages", { query: "压测报告", roomId: left.id });
  assert.equal(denied.ok ? "ok" : denied.error.code, "forbidden");
  const missing = await svc.handle("search.messages", { query: "压测报告", roomId: "g-nope" });
  assert.equal(missing.ok ? "ok" : missing.error.code, "not_found");
  await host.close();
});

test("搜索:编辑后按新文字命中,旧文字不再命中,索引行里只剩新文字", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m = host.send({ roomId: dm.id, clientActionId: "a", text: "阈值定 200" });
  host.editMessage(dm.id, m.seq, "上限改成 300");
  assert.deepEqual(seqs(host.searchMessages({ query: "阈值" })), []);
  assert.deepEqual(seqs(host.searchMessages({ query: "上限" })), [m.seq]);
  assert.equal(host.searchMessages({ query: "300" }).hits[0]!.snippet, "上限改成 300");
  assert.deepEqual(indexRows(host).map((r) => r.text), ["上限改成 300"]);
  await host.close();
});

test("搜索:撤回后搜不到,派生索引表里也不再有原文(含编辑过的旧文字)", async () => {
  const host = new Host(opts());
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const secret = host.send({ roomId: dm.id, clientActionId: "a", text: "口令是 NEUTRAL_FIXTURE_NO_CREDENTIALS 甲" });
  host.editMessage(dm.id, secret.seq, "口令是 NEUTRAL_FIXTURE_NO_CREDENTIALS 乙");
  const other = host.send({ roomId: dm.id, clientActionId: "b", text: "口令换了,当面说" });
  assert.deepEqual(seqs(host.searchMessages({ query: "口令" })), [other.seq, secret.seq]);
  host.retractMessage(dm.id, secret.seq);
  assert.deepEqual(seqs(host.searchMessages({ query: "口令" })), [other.seq]);
  assert.deepEqual(seqs(host.searchMessages({ query: "NEUTRAL_FIXTURE" })), []);
  const rows = indexRows(host);
  assert.deepEqual(rows.map((r) => r.seq), [other.seq], "撤回的那一行已从索引表删除");
  assert.equal(JSON.stringify(rows).includes("NEUTRAL_FIXTURE"), false);
  await host.close();
});

test("搜索:附件按文件名命中,返回所在消息的 seq 与命中的文件名", async () => {
  const host = new Host({ file: file(), dataDir: path.join(dir, "att"), mind: silent, now: clock, maxDeferMs: 60_000 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const f = path.join(dir, "压测报告-1108.md");
  writeFileSync(f, "# 报告");
  const att = host.addAttachment(f);
  const m = host.send({ roomId: dm.id, clientActionId: "a", text: "附上", attachments: [att.ref] });
  host.send({ roomId: dm.id, clientActionId: "b", text: "无关" });
  const r = host.searchMessages({ query: "压测报告" });
  assert.deepEqual(r.hits.map((h) => [h.seq, h.matchedIn, h.attachmentName, h.snippet]), [[m.seq, "attachment", "压测报告-1108.md", "附上"]]);
  await host.close();
});

test("搜索分页:limit + nextCursor 依次取完,不重不漏;改坏的游标被拒", async () => {
  const host = new Host(opts());
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const sent = Array.from({ length: 7 }, (_, i) => host.send({ roomId: dm.id, clientActionId: `m${i}`, text: `周报第 ${i} 条` }).seq);
  const got: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = host.searchMessages({ query: "周报", limit: 3, cursor });
    got.push(...seqs(r));
    cursor = r.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.deepEqual(got, [...sent].reverse());
  assert.equal(pages, 3);
  const bad = await svc.handle("search.messages", { query: "周报", cursor: "不是游标" });
  assert.equal(bad.ok ? "ok" : bad.error.code, "invalid_params");
  const viaSvc = await svc.handle("search.messages", { query: "周报", limit: 2 });
  assert.ok(viaSvc.ok);
  assert.deepEqual((viaSvc.value as { hits: { seq: number }[] }).hits.map((h) => h.seq), [sent[6], sent[5]]);
  await host.close();
});

test("索引重建:删掉派生索引表或版本号不符时,重开宿主从只追加日志重建,同一查询结果与重建前一致,撤回的不回来", async () => {
  const f = file();
  const host = new Host({ file: f, dataDir: path.join(dir, "att2"), mind: silent, now: clock, maxDeferMs: 60_000 });
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("群", [{ kind: "contact", id: c.id }]);
  const a = host.send({ roomId: g.id, clientActionId: "a", text: "部署脚本放 ops 目录" });
  host.send({ roomId: g.id, clientActionId: "b", text: "部署窗口周五", threadRootSeq: a.seq });
  const x = host.send({ roomId: g.id, clientActionId: "c", text: "部署口令 NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  host.editMessage(g.id, a.seq, "部署脚本改放 deploy 目录");
  host.retractMessage(g.id, x.seq);
  const p = path.join(dir, "部署清单.txt");
  writeFileSync(p, "清单");
  host.send({ roomId: g.id, clientActionId: "d", text: "清单", attachments: [host.addAttachment(p).ref] });
  const queries = ["部署", "deploy", "ops", "NEUTRAL_FIXTURE", "清单"];
  const before = queries.map((q) => host.searchMessages({ query: q }));
  const rowsBefore = indexRows(host);
  await host.close();

  const raw = new DatabaseSync(f);
  raw.exec("DROP TABLE gg_search");
  raw.close();
  const h2 = new Host({ file: f, dataDir: path.join(dir, "att2"), mind: silent, now: clock, maxDeferMs: 60_000 });
  assert.deepEqual(queries.map((q) => h2.searchMessages({ query: q })), before);
  assert.deepEqual(indexRows(h2), rowsBefore);
  assert.deepEqual(before[3]!.hits, [], "撤回的消息重建后也不回来");
  await h2.close();

  const raw2 = new DatabaseSync(f);
  raw2.exec("UPDATE gg_search_meta SET v = '0' WHERE k = 'version'");
  raw2.exec("INSERT INTO gg_search (room_id, seq, at, sender_kind, sender_id, thread_root, text, att) VALUES ('g-x', 99, '2026-01-01T00:00:00.000Z', 'user', 'me', NULL, '残留', '')");
  raw2.close();
  const h3 = new Host({ file: f, dataDir: path.join(dir, "att2"), mind: silent, now: clock, maxDeferMs: 60_000 });
  assert.deepEqual(indexRows(h3), rowsBefore, "版本号不符就整表重建,旧残留行被清掉");
  await h3.close();
});

test("跳转:messages.list 带 aroundSeq 返回以该条为中心、包含它的一页,并给出前后是否还有", async () => {
  const host = new Host(opts());
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const all_ = Array.from({ length: 21 }, (_, i) => host.send({ roomId: dm.id, clientActionId: `j${i}`, text: `第 ${i} 条${i === 10 ? " 限流结论" : ""}` }).seq);
  const hit = host.searchMessages({ query: "限流结论" }).hits[0]!;
  const mid = host.listMessages(dm.id, { aroundSeq: hit.seq, limit: 5 });
  assert.deepEqual([mid.messages.map((m) => m.seq), mid.hasMore, mid.hasMoreAfter], [all_.slice(8, 13), true, true]);
  const head = host.listMessages(dm.id, { aroundSeq: all_[0]!, limit: 5 });
  assert.deepEqual([head.messages.map((m) => m.seq), head.hasMore, head.hasMoreAfter], [all_.slice(0, 5), false, true]);
  const tail = host.listMessages(dm.id, { aroundSeq: all_[20]!, limit: 4 });
  assert.deepEqual([tail.messages.map((m) => m.seq), tail.hasMore, tail.hasMoreAfter], [all_.slice(17), true, false]);
  const viaSvc = await svc.handle("messages.list", { roomId: dm.id, aroundSeq: hit.seq, limit: 3 });
  assert.ok(viaSvc.ok);
  assert.deepEqual((viaSvc.value as { messages: { seq: number }[] }).messages.map((m) => m.seq), all_.slice(9, 12));
  const missing = await svc.handle("messages.list", { roomId: dm.id, aroundSeq: 9999 });
  assert.equal(missing.ok ? "ok" : missing.error.code, "not_found");
  const both = await svc.handle("messages.list", { roomId: dm.id, aroundSeq: hit.seq, beforeSeq: 5 });
  assert.equal(both.ok ? "ok" : both.error.code, "invalid_params");
  await host.close();
});
