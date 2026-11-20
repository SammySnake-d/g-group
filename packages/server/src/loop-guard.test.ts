// U15 / D07.0：稳定因果链、总次数与频率、重投与重启，及真实 SQLite/注意循环生产路径。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { type ContactMind, type Inbound, type MindAction, PREFETCH_REF, type RoundInput, type RoundTools, searchHistory } from "@g-group/kernel";
import { openDb, tx } from "./db.ts";
import { Host, type HostOptions } from "./host.ts";
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
  assert.equal(guard.isStopped("room-a", 4), true);
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
  assert.equal(guard.isStopped("room-b", 2), false);
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
  const blocked = guard.blockedWakes();
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0], { roomId: "room-a", seq: 4, contactId: "b", reason: "hops", roots: ["root-a"] });
  assert.equal(guard.isStopped("room-a", 4), true);
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
  assert.equal(guard.isStopped("room-a", 6), true);
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
  assert.equal(guard.blockedWakes().length, 1);
  const newRoots = guard.rootsFor([input(3, "contact"), input(4, "user")], "room-a");
  assert.deepEqual(newRoots, [root("room-a", 4)]);
  guard.recordMessage("room-a", 5, newRoots);
  assert.equal(guard.admit("room-a", 5, "b").allowed, true);
  assert.equal(guard.isStopped("room-a", 5), false);
});

test("因果元数据与消息事务同生共死；失败事务不留下额度占用", () => {
  const d = db();
  const guard = new LoopGuard(d, { maxHops: 1 });
  assert.throws(() => tx(d, () => { guard.recordMessage("room-a", 2, ["root-a"]); guard.admit("room-a", 2, "b"); throw new Error("故意中止事务"); }), /故意中止事务/);
  guard.recordMessage("room-a", 3, ["root-a"]);
  assert.equal(guard.admit("room-a", 3, "b").allowed, true);
  guard.recordMessage("room-a", 4, ["root-a"]);
  assert.equal(guard.admit("room-a", 4, "b").allowed, false);
  assert.equal(guard.isStopped("room-a", 4), true);
});

test("跨会话派生保持原因果根，不借输出到另一群重新获额度", () => {
  const guard = new LoopGuard(db(), { maxHops: 1 });
  guard.recordMessage("room-a", 2, ["root-a"]);
  assert.equal(guard.admit("room-a", 2, "b").allowed, true);
  const roots = guard.rootsFor([input(2, "contact")], "room-b");
  assert.deepEqual(roots, ["root-a"]);
  guard.recordMessage("room-b", 1, roots);
  assert.equal(guard.admit("room-b", 1, "c").allowed, false);
  assert.equal(guard.isStopped("room-b", 1), true);
});

test("显式额度配置拒绝无穷、零和非整数", () => {
  const d = db();
  assert.throws(() => new LoopGuard(d, { maxHops: Number.POSITIVE_INFINITY }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxHops: 0 }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxHops: 1.5 }), /maxHops/);
  assert.throws(() => new LoopGuard(d, { maxPerMinute: -1 }), /maxPerMinute/);
});

test("默认配置下同一用户消息派生的第 5 至第 8 次唤醒仍可送达", () => {
  const guard = new LoopGuard(db());
  const decisions = Array.from({ length: 8 }, (_, i) => {
    const seq = i + 2;
    guard.recordMessage("room-a", seq, [root("room-a", 1)]);
    return guard.admit("room-a", seq, "b").allowed;
  });
  assert.deepEqual(decisions, Array(8).fill(true));
  assert.deepEqual(guard.blockedWakes(), []);
  assert.equal(guard.admit("room-a", 9, "b").duplicate, true);
});

test("曾触及次数限额的旧因果根在默认配置下允许新的唤醒", () => {
  const d = db();
  const constrained = new LoopGuard(d, { maxHops: 1 });
  constrained.recordMessage("room-a", 2, ["legacy"]);
  assert.equal(constrained.admit("room-a", 2, "b").allowed, true);
  constrained.recordMessage("room-a", 3, ["legacy"]);
  assert.equal(constrained.admit("room-a", 3, "b").reason, "hops");
  const current = new LoopGuard(d);
  current.recordMessage("room-a", 4, ["legacy"]);
  assert.equal(current.admit("room-a", 4, "b").allowed, true);
  assert.equal(current.mayReceive("room-a", 4, "b"), true);
});

test("生产调度保留旁观者参与但同根自动往返到上限停止，只留一次停止说明；新用户消息可继续", async () => {
  const rounds: string[] = [];
  const h = new Host({ file: file(), mind: () => chatter(rounds), maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 4 } }); hosts.push(h);
  const a = h.createContact({ name: "甲" }); const b = h.createContact({ name: "乙" });
  const g = h.createGroup("讨论", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  h.send({ roomId: g.id, clientActionId: "user-1", text: "讨论这个中性问题", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h);
  const first = rounds.length;
  assert.ok(first >= 2 && first <= 6, `应保留旁观者参与且最多初始两轮加四次自动唤醒，实际 ${first}`);
  const notices = h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /自动往返已到上限.*待处理.*用户/s);
  assert.ok(h.loopGuard.blockedWakes().length > 0);
  h.send({ roomId: g.id, clientActionId: "user-2", text: "继续讨论", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h);
  assert.ok(rounds.length > first && rounds.length <= first + 6, `新根必须继续但仍有限：${first} → ${rounds.length}`);
  assert.equal(h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "system").length, 2);
});

test("生产重启不自动重开已停止的派生链；未读原文仍可查看，用户续话后再参与", async () => {
  const rounds: string[] = []; const f = file();
  const h1 = new Host({ file: f, mind: () => chatter(rounds), maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(h1);
  const a = h1.createContact({ name: "甲" }); const b = h1.createContact({ name: "乙" });
  const g = h1.createGroup("讨论", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  h1.send({ roomId: g.id, clientActionId: "u1", text: "开始", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h1); const before = rounds.length; const pending = h1.loopGuard.blockedWakes();
  assert.ok(pending.length > 0);
  await h1.close();
  const h2 = new Host({ file: f, mind: () => chatter(rounds), maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(h2);
  await settle(h2);
  assert.equal(rounds.length, before, "重启只能恢复等待，不能发放新的自动互唤额度");
  assert.deepEqual(h2.loopGuard.blockedWakes(), pending);
  assert.ok(h2.listMessages(g.id, {}).messages.some((m) => m.text.startsWith("自动讨论")));
  h2.send({ roomId: g.id, clientActionId: "u2", text: "用户续话", mentions: [{ id: a.id, source: "manual" }] });
  await settle(h2);
  assert.ok(rounds.length > before);
});

const groupSecret = "仅群内可见：琥珀编号 7788（测试数据）";
const handoff = "@乙 复查琥珀项目";
const dmHistory = "天气预报：明天放晴";
const dmQuestion = "天气预报更新了吗";
const block5 = (i: RoundInput | undefined) => i?.request.blocks.find((b) => b.block === 5)?.text ?? "";

function isolationOptions(observe?: (input: RoundInput, tools: RoundTools) => void | Promise<void>) {
  let beforeSecondReply: (() => void) | undefined;
  let id = 0;
  const searched: string[] = [];
  const options: HostOptions = {
    file: file(), maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 1 },
    // The group sorts before the DM, so its notice can also corrupt run attribution.
    newId: (prefix) => `${prefix === "g" ? "a-group" : prefix}-${++id}`,
    historySearch: (docs, query, limit) => {
      searched.push(query);
      // A notice-driven search has a relevant older group hit even if the quoted secret was already paged in.
      return searchHistory(docs, query.startsWith("自动往返已到上限") ? handoff : query, limit);
    },
    mind: () => ({ async round(i, _signal, tools) {
      const actions: MindAction[] = [];
      for (const f of i.fresh) {
        if (f.kind !== "message") continue;
        if (i.contact.name === "甲" && f.sender.kind === "user" && f.text === groupSecret) actions.push({ kind: "reply", roomId: f.roomId, text: handoff, replyToSeq: null });
        if (i.contact.name === "乙" && f.sender.kind === "contact" && f.text === handoff) {
          beforeSecondReply?.();
          actions.push({ kind: "reply", roomId: f.roomId, text: "@丙 请确认琥珀编号", replyToSeq: 1 });
        }
      }
      if (i.contact.name === "丙" && tools) await observe?.(i, tools);
      return { actions, stateNote: null };
    } }),
  };
  return { options, searched, beforeReply: (fn: () => void) => { beforeSecondReply = fn; } };
}

async function stopGroup(h: Host, fixture: ReturnType<typeof isolationOptions>) {
  hosts.push(h);
  const a = h.createContact({ name: "甲" });
  const b = h.createContact({ name: "乙" });
  const c = { kind: "contact" as const, id: h.createContact({ name: "丙" }).id };
  const dm = h.openDm(c.id);
  const prior = h.send({ roomId: dm.id, clientActionId: "weather-history", text: dmHistory });
  await settle(h);
  const g = h.createGroup("琥珀项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  // Joining after #2 gives 丙 a real delivery cursor at #2 without marking the group read.
  fixture.beforeReply(() => { h.addMembers(g.id, [c]); });
  const original = h.send({ roomId: g.id, clientActionId: "group-start", text: groupSecret, mentions: [{ id: a.id, source: "manual" }] });
  await settle(h);
  const messages = h.listMessages(g.id, {}).messages;
  const blocked = messages.find((m) => m.sender.id === b.id);
  const notice = messages.find((m) => m.sender.kind === "system");
  assert.ok(blocked && notice, "生产链必须真的写入乙的回复及停止通知");
  assert.deepEqual([original.seq, blocked.seq, blocked.replyToSeq, notice.seq], [1, 3, original.seq, 4]);
  assert.ok(h.loopGuard.blockedWakes().some((w) => w.roomId === g.id && w.seq === blocked.seq && w.contactId === c.id));
  fixture.searched.length = 0;
  return { c, dm, prior, g, original, blocked, notice };
}

test("R2 G4-a 停止通知不能混入私聊新输入、运行来源或推进被拦群的已读", async () => {
  let round: RoundInput | undefined;
  const fixture = isolationOptions((i) => { round = i; });
  const h = new Host(fixture.options);
  const { c, dm, g } = await stopGroup(h, fixture);
  const readBefore = h.readSeq(g.id, c);
  const dmInput = h.send({ roomId: dm.id, clientActionId: "dm-question", text: dmQuestion });
  await settle(h);
  const last = h.listRuns({ contactId: c.id, limit: 1 }).runs[0];
  assert.deepEqual({ fresh: round?.fresh.map((f) => f.roomId), run: last && [last.roomId, last.sourceSeq], groupRead: h.readSeq(g.id, c) },
    { fresh: [dm.id], run: [dm.id, dmInput.seq], groupRead: readBefore });
});

test("R2 D06.3 有未读停止通知时第五块只预取私聊、不带被拦群的预取或引用", async () => {
  let round: RoundInput | undefined;
  const fixture = isolationOptions((i) => { round = i; });
  const h = new Host(fixture.options);
  const { dm, g } = await stopGroup(h, fixture);
  h.send({ roomId: dm.id, clientActionId: "dm-question", text: dmQuestion });
  await settle(h);
  const fifth = block5(round);
  assert.deepEqual({ queries: fixture.searched, groupQuote: fifth.includes(`〔${g.id} #`), groupPrefetch: fifth.includes(`\n${g.id} #`), dmPrefetch: fifth.includes(PREFETCH_REF) && fifth.includes(dmHistory) },
    { queries: [dmQuestion], groupQuote: false, groupPrefetch: false, dmPrefetch: true });
});

test("R2 G4-01 私聊 query_history 只搜本会话、拒绝显式搜索和回读被拦群", async () => {
  let groupId = "";
  let dmId = "";
  const results: (string | null)[] = [];
  const fixture = isolationOptions(async (_i, tools) => {
    if (!groupId || !tools.queryHistory) return;
    const query = { kind: "search" as const, query: "琥珀编号", limit: null };
    results.push(await tools.queryHistory({ ...query, roomId: null }));
    results.push(await tools.queryHistory({ ...query, roomId: groupId }));
    results.push(await tools.queryHistory({ kind: "read", roomId: groupId, seq: 1, before: 0, after: 0 }));
    results.push(await tools.queryHistory({ ...query, query: "天气预报", roomId: dmId }));
    results.push(await tools.queryHistory({ kind: "read", roomId: dmId, seq: 1, before: 0, after: 0 }));
  });
  const h = new Host(fixture.options);
  const { dm, g } = await stopGroup(h, fixture);
  groupId = g.id; dmId = dm.id;
  h.send({ roomId: dm.id, clientActionId: "dm-question", text: dmQuestion });
  await settle(h);
  assert.deepEqual({ missesInDm: results[0]?.startsWith(`没有找到相关的旧消息(只搜了本轮所在的会话 ${dm.id};`), groupSearch: results[1], groupRead: results[2], dmSearch: results[3]?.includes(dmHistory), dmRead: results[4]?.includes(dmHistory) },
    { missesInDm: true, groupSearch: null, groupRead: null, dmSearch: true, dmRead: true });
});

test("R2 D06.3 没有未读系统通知时，被拦回复的引用也不进入私聊第五块", async () => {
  let round: RoundInput | undefined;
  const fixture = isolationOptions((i) => { round = i; });
  const h = new Host(fixture.options);
  const { c, dm, g, notice } = await stopGroup(h, fixture);
  // Seed only the notice as already seen; the quoting reply remains beyond the delivery cursor.
  h.db.store.db.prepare("INSERT INTO gg_loop_seen (room_id, seq, contact_id) VALUES (?, ?, ?)").run(g.id, notice.seq, c.id);
  h.send({ roomId: dm.id, clientActionId: "dm-question", text: dmQuestion });
  await settle(h);
  assert.deepEqual(round?.fresh.map((f) => f.roomId), [dm.id]);
  assert.ok(block5(round).includes(dmHistory), "私聊的正常预取仍在");
  assert.ok(!block5(round).includes(g.id) && !block5(round).includes(groupSecret), `第五块不应有被拦群引用：${block5(round)}`);
});

test("R2 AC-46 群有可交付新输入时，已读仍停在被拦消息之前", async () => {
  let round: RoundInput | undefined;
  const fixture = isolationOptions((i) => { round = i; });
  const h = new Host(fixture.options);
  const { c, g, original, blocked } = await stopGroup(h, fixture);
  const kept = h.postAsHelper(g.id, "helper", "已上传不相关的附件", original.seq, "helper-update");
  await settle(h);
  assert.ok(round?.fresh.some((f) => f.kind === "message" && f.seq === kept.seq && f.sender.kind === "helper"));
  assert.equal(h.readSeq(g.id, c), blocked.seq - 1);
});

test("R2 G4-03 即使群在本轮活跃，系统通知也不作为预取查询", async () => {
  const fixture = isolationOptions();
  const h = new Host(fixture.options);
  const { g, original } = await stopGroup(h, fixture);
  const kept = h.postAsHelper(g.id, "helper", "已上传不相关的附件", original.seq, "helper-update");
  await settle(h);
  assert.deepEqual([...new Set(fixture.searched)], [kept.text]);
});
