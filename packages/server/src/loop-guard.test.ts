// U15 / D07.0：稳定因果链、总次数与频率、重投与重启，及真实 SQLite/注意循环生产路径。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactMind, Inbound, MindAction } from "@g-group/kernel";
import { openDb, tx } from "./db.ts";
import { Host } from "./host.ts";
import { LoopGuard } from "./loop-guard.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-loop-limit-"));
let next = 0;
const dbs: ReturnType<typeof openDb>[] = [];
const hosts: Host[] = [];
const file = () => path.join(dir, `case-${++next}.db`);
const db = () => { const d = openDb(file()); dbs.push(d); return d; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); for (const d of dbs.splice(0)) d.close(); });
after(() => rmSync(dir, { recursive: true, force: true }));
const input = (seq: number, kind: "user" | "contact", roomId = "room-a"): Inbound => ({ kind: "message", roomId, seq, sender: { kind, id: kind === "user" ? "me" : "bot", name: "夹具" }, text: "中性内容", replyToSeq: null, quotedSeqs: [], mentions: [], command: null, at: "2026-11-12T00:00:00.000Z" });
const root = (roomId: string, seq: number) => `message:${roomId}:${seq}`;

async function settle(h: Host) {
  for (let i = 0; i < 300; i++) {
    await Promise.race([h.idle(), new Promise((r) => setTimeout(r, 10))]);
    if (!h.loop.busy()) return;
  }
  assert.fail("联系人循环没有在有限观测窗口内停止");
}
function chatter(rounds: string[], cap = 20): ContactMind {
  return { async round(i) {
    const items = i.fresh.filter((f) => f.kind === "message" && (f.sender.kind === "user" || f.sender.kind === "contact"));
    const latest = items.at(-1);
    const actions: MindAction[] = [];
    rounds.push(`${i.contact.id}:${latest?.kind === "message" ? latest.seq : "context-only"}`);
    if (latest && latest.kind === "message" && rounds.length <= cap) {
      // 故意不显式回复或点名：真实旁观者 batch 也必须保留，但不得无限互唤。
      actions.push({ kind: "reply", roomId: latest.roomId, text: `自动讨论 ${rounds.length}`, replyToSeq: null });
    }
    return { actions, stateNote: null };
  } };
}

test("因果根继承：派生消息连续传递同一根，不能每条消息重新获额度", () => {
  const guard = new LoopGuard(db(), { maxHops: 2 });
  guard.recordMessage("room-a", 1, [root("room-a", 1)]);
  const roots = guard.rootsFor([input(1, "user")], "room-a");
  assert.deepEqual(roots, [root("room-a", 1)]);
  guard.recordMessage("room-a", 2, roots);
  assert.equal(guard.admit("room-a", 2, "b").allowed, true);
  guard.recordMessage("room-a", 3, guard.rootsFor([input(2, "contact")], "room-a"));
  assert.equal(guard.admit("room-a", 3, "a").allowed, true);
  guard.recordMessage("room-a", 4, guard.rootsFor([input(3, "contact")], "room-a"));
  assert.deepEqual(guard.admit("room-a", 4, "b"), { allowed: false, duplicate: false, roots: [root("room-a", 1)], reason: "hops" });
});

test("同根并发分支共用总额度，不同根互不占用，多根派生取每根约束", async () => {
  const guard = new LoopGuard(db(), { maxHops: 2 });
  guard.recordMessage("room-a", 2, ["root-a"]);
  const decisions = await Promise.all(["b", "c", "d"].map(async (id) => guard.admit("room-a", 2, id)));
  assert.deepEqual(decisions.map((d) => d.allowed), [true, true, false]);
  guard.recordMessage("room-b", 1, ["root-b"]);
  assert.equal(guard.admit("room-b", 1, "b").allowed, true);
  guard.recordMessage("room-a", 3, ["root-a", "root-b"]);
  assert.equal(guard.admit("room-a", 3, "b").allowed, false);
  guard.recordMessage("room-b", 2, ["root-b"]);
  assert.equal(guard.admit("room-b", 2, "c").allowed, true, "被拒的多根消息不消耗其他根额度");
});

test("消息重投使用会话、消息与目标联系人的稳定键，不二次扣额度", () => {
  const guard = new LoopGuard(db(), { maxHops: 2 });
  guard.recordMessage("room-a", 2, ["root-a"]);
  assert.deepEqual(guard.admit("room-a", 2, "b"), { allowed: true, duplicate: false, roots: ["root-a"], reason: null });
  let replay: ReturnType<LoopGuard["admit"]> | undefined;
  assert.doesNotThrow(() => { replay = guard.admit("room-a", 2, "b"); });
  assert.deepEqual(replay, { allowed: true, duplicate: true, roots: ["root-a"], reason: null });
  guard.recordMessage("room-a", 3, ["root-a"]);
  assert.equal(guard.admit("room-a", 3, "b").allowed, true);
  guard.recordMessage("room-a", 4, ["root-a"]);
  assert.equal(guard.admit("room-a", 4, "b").allowed, false);
  assert.equal(guard.admit("room-a", 4, "b").duplicate, true);
  assert.deepEqual(guard.pending().map((x) => [x.roomId, x.seq, x.contactId, x.reason]), [["room-a", 4, "b", "hops"]]);
});

test("频率额度使用滚动一分钟；频率停止持久保留，等新用户输入开新根", () => {
  let now = 0;
  const guard = new LoopGuard(db(), { maxHops: 10, maxPerMinute: 2 }, () => now);
  guard.recordMessage("room-a", 2, ["root-a"]);
  assert.equal(guard.admit("room-a", 2, "b").allowed, true);
  now = 30_000;
  guard.recordMessage("room-a", 3, ["root-a"]);
  assert.equal(guard.admit("room-a", 3, "b").allowed, true);
  now = 60_000;
  guard.recordMessage("room-a", 4, ["root-a"]);
  assert.equal(guard.admit("room-a", 4, "b").allowed, true, "恰好一分钟前的唤醒已移出窗口");
  guard.recordMessage("room-a", 5, ["root-a"]);
  assert.equal(guard.admit("room-a", 5, "b").reason, "rate");
  now = 120_000;
  guard.recordMessage("room-a", 6, ["root-a"]);
  assert.equal(guard.admit("room-a", 6, "b").reason, "rate", "限额触发后不靠等一分钟自行继续");
});

test("重启后保留次数、停止原因和待处理；新用户输入才建立新的因果根", () => {
  const f = file();
  const first = openDb(f);
  const g1 = new LoopGuard(first, { maxHops: 1 });
  g1.recordMessage("room-a", 2, ["root-a"]);
  assert.equal(g1.admit("room-a", 2, "b").allowed, true);
  first.close();
  const second = openDb(f); dbs.push(second);
  const guard = new LoopGuard(second, { maxHops: 1 });
  guard.recordMessage("room-a", 3, ["root-a"]);
  assert.equal(guard.admit("room-a", 3, "b").reason, "hops");
  assert.equal(guard.pending().length, 1);
  const newRoots = guard.rootsFor([input(3, "contact"), input(4, "user")], "room-a");
  assert.deepEqual(newRoots, [root("room-a", 4)]);
  guard.recordMessage("room-a", 5, newRoots);
  assert.equal(guard.admit("room-a", 5, "b").allowed, true);
});

test("因果元数据与消息事务同生共死；失败事务不留下额度占用", () => {
  const d = db();
  const guard = new LoopGuard(d, { maxHops: 1 });
  assert.throws(() => tx(d, () => { guard.recordMessage("room-a", 2, ["root-a"]); guard.admit("room-a", 2, "b"); throw new Error("故意中止事务"); }), /故意中止事务/);
  guard.recordMessage("room-a", 3, ["root-a"]);
  assert.equal(guard.admit("room-a", 3, "b").allowed, true);
  guard.recordMessage("room-a", 4, ["root-a"]);
  assert.equal(guard.admit("room-a", 4, "b").allowed, false);
});

test("跨会话派生保持原因果根，不借输出到另一群重新获额度", () => {
  const guard = new LoopGuard(db(), { maxHops: 1 });
  guard.recordMessage("room-a", 2, ["root-a"]);
  assert.equal(guard.admit("room-a", 2, "b").allowed, true);
  const roots = guard.rootsFor([input(2, "contact")], "room-b");
  assert.deepEqual(roots, ["root-a"]);
  guard.recordMessage("room-b", 1, roots);
  assert.equal(guard.admit("room-b", 1, "c").allowed, false);
});

test("配置拒绝无穷、零和非整数；省略次数时采用明确标候选的有限默认值", () => {
  const d = db();
  assert.throws(() => new LoopGuard(d, { maxHops: Number.POSITIVE_INFINITY }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxHops: 0 }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxHops: 1.5 }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxPerMinute: -1 }), /maxPerMinute/);
  const guard = new LoopGuard(d);
  for (let seq = 1; seq <= 5; seq++) guard.recordMessage("room-a", seq, ["root-default"]);
  assert.deepEqual([1, 2, 3, 4, 5].map((seq) => guard.admit("room-a", seq, "b").allowed), [true, true, true, true, false]);
});

test("生产调度保留旁观者参与但同根自动往返到上限停止，只留一次停止说明；新用户消息可继续", async () => {
  const rounds: string[] = [];
  const h = new Host({ file: file(), mind: () => chatter(rounds), maxDeferMs: 2, loopGuard: { maxHops: 4 } }); hosts.push(h);
  const a = h.createContact({ name: "甲" }); const b = h.createContact({ name: "乙" });
  const g = h.createGroup("讨论", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  h.send({ roomId: g.id, clientActionId: "user-1", text: "讨论这个中性问题", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h);
  const first = rounds.length;
  assert.ok(first >= 2 && first <= 6, `应保留旁观者参与且最多初始两轮加四次自动唤醒，实际 ${first}`);
  const notices = h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /自动往返已到上限.*待处理.*用户/s);
  assert.ok(h.loopGuard.pending().length > 0);
  h.send({ roomId: g.id, clientActionId: "user-2", text: "继续讨论", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h);
  assert.ok(rounds.length > first && rounds.length <= first + 6, `新根必须继续但仍有限：${first} → ${rounds.length}`);
  assert.equal(h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system").length, 2);
});

test("生产重启不自动重开已停止的派生链；未读原文仍可查看，用户续话后再参与", async () => {
  const rounds: string[] = []; const f = file();
  const h1 = new Host({ file: f, mind: () => chatter(rounds), maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(h1);
  const a = h1.createContact({ name: "甲" }); const b = h1.createContact({ name: "乙" });
  const g = h1.createGroup("讨论", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  h1.send({ roomId: g.id, clientActionId: "u1", text: "开始", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h1); const before = rounds.length; const pending = h1.loopGuard.pending();
  assert.ok(pending.length > 0);
  await h1.close();
  const h2 = new Host({ file: f, mind: () => chatter(rounds), maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(h2);
  await settle(h2);
  assert.equal(rounds.length, before, "重启只能恢复等待，不能发放新的自动互唤额度");
  assert.deepEqual(h2.loopGuard.pending(), pending);
  assert.ok(h2.listMessages(g.id, {}).messages.some((m) => m.text.startsWith("自动讨论")));
  h2.send({ roomId: g.id, clientActionId: "u2", text: "用户续话", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h2);
  assert.ok(rounds.length > before);
});
