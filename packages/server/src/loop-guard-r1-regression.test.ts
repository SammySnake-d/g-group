// PR #88 第 1 轮审查探针(审查人自构,返修保留为回归测试):每条断言写的是「应有的行为」,在被审 HEAD 上失败即为缺陷复现。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactMind, Inbound, MindAction, RoundInput } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-pr88-probe-"));
const hosts: Host[] = [];
let next = 0;
const fresh = () => { const d = path.join(dir, `c${++next}`); mkdirSync(d, { recursive: true }); return { file: path.join(d, "gg.db"), dataDir: d }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => { for (const h of hosts.splice(0)) await Promise.race([h.close().catch(() => {}), sleep(2000)]); });
after(() => rmSync(dir, { recursive: true, force: true }));
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 600; i++) {
    await Promise.race([host.idle(), sleep(50)]);
    await sleep(5);
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await sleep(20);
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  assert.fail("宿主没有在有限窗口内安静下来");
}
async function waitFor(pred: () => boolean, what: string) {
  for (let i = 0; i < 600; i++) { if (pred()) return; await sleep(5); }
  assert.fail(`没等到:${what}`);
}
const msgsOf = (i: RoundInput) => i.fresh.filter((f): f is Extract<Inbound, { kind: "message" }> => f.kind === "message");
const notices = (h: Host, roomId: string) => h.listMessages(roomId, { limit: 500 }).messages.filter((m) => m.sender.kind === "system");
const texts = (h: Host, roomId: string) => h.listMessages(roomId, { limit: 500 }).messages.map((m) => `${m.sender.kind}:${m.text}`);

test("探针P1：记忆冲突提问(联系人发言)应继承因果根；两位联系人借它互唤应在上限内停止", async () => {
  let aId = ""; let first = ""; let quoteSeq = 0; let aAsks = 0; let bReplies = 0; const CAP = 12;
  const mind = (): ContactMind => ({ async round(i) {
    const actions: MindAction[] = [];
    const last = msgsOf(i).filter((f) => f.sender.kind !== "system").at(-1);
    if (!last) return { actions, stateNote: null };
    const rem = (over: Partial<Extract<MindAction, { kind: "remember" }>>): MindAction => ({ kind: "remember", roomId: last.roomId, sourceSeq: last.seq, title: "回复语言", text: last.text, anchors: [`room:${last.roomId}`], quote: last.text, relation: null, target: null, ...over });
    if (i.contact.id === aId) {
      if (last.sender.kind === "user" && last.text.includes("中文")) actions.push(rem({}));
      else if (last.sender.kind === "user" && last.text.includes("英文")) { quoteSeq = last.seq; actions.push(rem({ relation: "conflict", target: first })); }
      else if (last.sender.kind === "contact" && aAsks < CAP) { aAsks++; actions.push(rem({ sourceSeq: quoteSeq, text: `回复都用英文(第 ${aAsks} 次重提)`, quote: "回复都用英文", relation: "conflict", target: first })); }
    } else if (last.sender.kind === "contact" && bReplies < CAP) { bReplies++; actions.push({ kind: "reply", roomId: last.roomId, text: `乙回应 ${bReplies}`, replyToSeq: null }); }
    return { actions, stateNote: null };
  } });
  const host = new Host({ ...fresh(), mind, maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" });
  const g = host.createGroup("探针一", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "p1-1", text: "回复都用中文", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  first = host.listMemories(a.id)[0]!.id;
  host.send({ roomId: g.id, clientActionId: "p1-2", text: "回复都用英文", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  const asks = texts(host, g.id).filter((t) => t.startsWith("contact:记忆冲突"));
  console.log(`P1 观测: 记忆冲突提问 ${asks.length} 条, 乙回应 ${bReplies} 次, 停止说明 ${notices(host, g.id).length} 条, 根数 ${all(host.db, "SELECT root FROM gg_loop_roots").length}`);
  assert.ok(asks.length >= 1, "前置:至少发出过一条记忆冲突提问");
  assert.ok(bReplies <= 3, `一条用户消息引出的联系人互唤(上限 2)应停下,实际乙被唤醒并回应了 ${bReplies} 次(探针封顶 ${CAP})`);
});

test("探针P1b：重跑到上限后的「未做」说明(联系人发言)应继承因果根；两位联系人借它互唤应在上限内停止", async () => {
  const t0 = Date.parse("2026-11-09T02:00:00.000Z");
  const clock = { ms: () => t0, iso: () => new Date(t0).toISOString() };
  const started = { kind: "started" as const, sessionId: "s", resumed: false };
  const compute = scriptedCompute({ script: () => [started, { kind: "failed", reason: "进程以 1 退出:boom", code: 1, signal: null, violations: [] }] });
  let hostRef: Host | null = null; let aId = ""; let bReplies = 0; const CAP = 10;
  const lastFailed = (roomId: string) => hostRef!.listRuns({ roomId }).runs.filter((r) => r.layer === "compute-session" && r.contactId === aId && r.status === "failed").at(-1);
  const aMind: ContactMind = { async round(input, signal) {
    const out = await scriptedMind().round(input, signal);
    const extra: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind === "compute" && f.signal === "failed") { const u = lastFailed(f.roomId); if (u) extra.push({ kind: "rerun", runId: u.id, roomId: f.roomId, basisSeq: null }); }
      if (f.kind === "message" && f.sender.kind === "contact" && f.text.startsWith("再重跑")) { const u = lastFailed(f.roomId); if (u) extra.push({ kind: "rerun", runId: u.id, roomId: f.roomId, basisSeq: null }); }
    }
    return { ...out, actions: [...out.actions, ...extra] };
  } };
  const bMind: ContactMind = { async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) if (f.kind === "message" && f.sender.kind === "contact" && f.text.startsWith("未做") && bReplies < CAP) { bReplies++; actions.push({ kind: "reply", roomId: f.roomId, text: `再重跑一次 ${bReplies}`, replyToSeq: null }); }
    return { actions, stateNote: null };
  } };
  const host = new Host({ ...fresh(), clockMs: clock.ms, now: clock.iso, runCheckMs: 10, maxDeferMs: 5, retry: { maxAutoRetries: 0 }, mind: (c) => (c.id === aId ? aMind : bMind), compute: () => compute.adapter, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(host);
  hostRef = host;
  const A = host.createContact({ name: "A" }); aId = A.id; const B = host.createContact({ name: "B" });
  const g = host.createGroup("探针一b", [{ kind: "contact", id: A.id }, { kind: "contact", id: B.id }]);
  host.send({ roomId: g.id, clientActionId: "p1b", text: "帮我跑一下构建", mentions: [{ id: A.id, source: "manual" }] });
  await settle(host, compute);
  const notDone = texts(host, g.id).filter((t) => t.startsWith("contact:未做:自动重跑已到上限"));
  console.log(`P1b 观测: 「未做」说明 ${notDone.length} 条, 乙回应 ${bReplies} 次, 停止说明 ${notices(host, g.id).length} 条`);
  compute.close();
  assert.ok(notDone.length >= 1, "前置:自动重跑到上限后至少报过一次「未做」");
  assert.ok(bReplies <= 3, `一条用户消息引出的联系人互唤(上限 2)应停下,实际乙被「未做」说明唤醒并回应了 ${bReplies} 次(探针封顶 ${CAP})`);
});

test("探针P2：经 Compute 往返的联系人互唤(派活→完成→回话→再派活)应受同一因果链上限约束", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "ok" }] });
  let aId = ""; let bReplies = 0; let dispatches = 0; const CAP = 10;
  const mind = (): ContactMind => ({ async round(i) {
    const actions: MindAction[] = [];
    for (const f of i.fresh) {
      if (i.contact.id === aId) {
        if (f.kind === "compute" && f.signal === "completed") actions.push({ kind: "reply", roomId: f.roomId, text: `做完了 ${f.taskId}`, replyToSeq: null });
        if (f.kind === "message" && (f.sender.kind === "user" || (f.sender.kind === "contact" && f.text.startsWith("再做一遍")))) { dispatches++; actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: `第 ${dispatches} 次`, task: `第 ${dispatches} 次` }); }
      } else if (f.kind === "message" && f.sender.kind === "contact" && f.text.startsWith("做完了") && bReplies < CAP) { bReplies++; actions.push({ kind: "reply", roomId: f.roomId, text: `再做一遍 ${bReplies}`, replyToSeq: null }); }
    }
    return { actions, stateNote: null };
  } });
  const host = new Host({ ...fresh(), mind, compute: () => compute.adapter, maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" });
  const g = host.createGroup("探针二", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "p2", text: "做一次", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const n = notices(host, g.id).length;
  console.log(`P2 观测: 派活 ${dispatches} 次, 起 Compute ${compute.spawned.length} 个, 乙回应 ${bReplies} 次, 停止说明 ${n} 条, 根数 ${all(host.db, "SELECT root FROM gg_loop_roots").length}`);
  compute.close();
  assert.ok(dispatches <= 4, `一条用户消息引出的派活应在上限(2)附近停下,实际派了 ${dispatches} 次、起了 ${compute.spawned.length} 个 Compute、乙回应 ${bReplies} 次(探针封顶 ${CAP}),期间发了 ${n} 条「已到上限」说明仍在继续`);
});

test("探针P3：两个不相干会话的因果链不应互相计数、互相叫停", async () => {
  let aId = "", bId = ""; let aRound = 0;
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const saw: { b: string[]; c: string[] } = { b: [], c: [] };
  const mind = (): ContactMind => ({ async round(i) {
    const actions: MindAction[] = []; const ms = msgsOf(i);
    if (i.contact.id === aId) {
      if (++aRound === 1) { await gate; return { actions, stateNote: null }; }
      for (const roomId of new Set(ms.filter((f) => f.sender.kind === "contact").map((f) => f.roomId))) actions.push({ kind: "reply", roomId, text: "甲回应", replyToSeq: null });
    } else {
      const me = i.contact.id === bId ? "b" : "c";
      for (const f of ms) { if (f.sender.kind === "user") actions.push({ kind: "reply", roomId: f.roomId, text: me === "b" ? "乙先说" : "丙先说", replyToSeq: null }); if (f.sender.kind === "contact") saw[me]!.push(f.text); }
    }
    return { actions, stateNote: null };
  } });
  const host = new Host({ ...fresh(), mind, maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" }); bId = b.id; const c = host.createContact({ name: "丙" });
  const g1 = host.createGroup("一群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const g2 = host.createGroup("二群", [{ kind: "contact", id: a.id }, { kind: "contact", id: c.id }]);
  host.send({ roomId: g1.id, clientActionId: "p3-1", text: "一群的问题" });
  host.send({ roomId: g2.id, clientActionId: "p3-2", text: "二群的问题" });
  await waitFor(() => texts(host, g1.id).includes("contact:乙先说") && texts(host, g2.id).includes("contact:丙先说"), "乙、丙各自先回一句");
  release();
  await settle(host);
  const roots = all<{ root: string; count: number; stopped: string | null }>(host.db, "SELECT root,count,stopped FROM gg_loop_roots WHERE count>0 ORDER BY root");
  console.log(`P3 观测: 一群停止说明 ${notices(host, g1.id).length} 条, 二群停止说明 ${notices(host, g2.id).length} 条, 乙看到 ${JSON.stringify(saw.b)}, 丙看到 ${JSON.stringify(saw.c)}, 根 ${JSON.stringify(roots)}`);
  assert.deepEqual([texts(host, g1.id).filter((t) => t === "contact:甲回应").length, texts(host, g2.id).filter((t) => t === "contact:甲回应").length], [1, 1], "前置:甲在两个群各回了一句");
  assert.equal(notices(host, g1.id).length + notices(host, g2.id).length, 0, "两个群各自只发生 2 次自动唤醒(上限 2),都不该出现「已到上限」");
  assert.ok(saw.b.includes("甲回应") && saw.c.includes("甲回应"), "甲在各群的回应都应唤醒该群的另一位");
});

async function prepareBlockedContinuation(withUnrelatedRound: boolean, HostCtor: typeof Host) {
  let aId = ""; const aSaw: string[][] = [];
  const mind = (): ContactMind => ({ async round(i) {
    const actions: MindAction[] = []; const ms = msgsOf(i);
    if (i.contact.id === aId) {
      aSaw.push(ms.map((f) => `${f.roomId.startsWith("dm-") ? "私聊" : "群"}:${f.sender.kind}:${f.text}`));
      for (const f of ms) if (f.sender.kind === "user") actions.push({ kind: "reply", roomId: f.roomId, text: f.roomId.startsWith("dm-") ? "私聊收到" : "甲说", replyToSeq: null });
    } else for (const f of ms) if (f.sender.kind === "contact" && f.text === "甲说") actions.push({ kind: "reply", roomId: f.roomId, text: "乙的补充意见", replyToSeq: null });
    return { actions, stateNote: null };
  } });
  const host = new HostCtor({ ...fresh(), mind, maxDeferMs: 2, roomPostBudget: false, loopGuard: { maxHops: 1 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" });
  const g = host.createGroup("探针四", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "p4-1", text: "开始", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  assert.ok(texts(host, g.id).includes("contact:乙的补充意见"), "前置:乙的补充意见已落盘");
  assert.equal(host.loopGuard.blockedWakes().filter((p) => p.contactId === a.id).length, 1, "前置:乙的补充意见对甲的唤醒被拦下并记为待处理");
  assert.ok(!aSaw.flat().includes("群:contact:乙的补充意见"), "前置:被拦时甲没有看到它");
  if (withUnrelatedRound) {
    const dm = host.openDm(a.id);
    host.send({ roomId: dm.id, clientActionId: "p4-dm", text: "顺便问个别的" });
    await settle(host);
    assert.ok(aSaw.some((r) => r.includes("私聊:user:顺便问个别的")), "前置:甲在私聊里跑过无关的一轮");
  }
  aSaw.length = 0;
  return { host, g, a, aSaw };
}
test("探针P4(对照)：被拦后用户直接续话,被拦的那条原文随续话一起给到被拦的联系人", async () => {
  const { host, g, a, aSaw } = await prepareBlockedContinuation(false, Host);
  const continued = host.send({ roomId: g.id, clientActionId: "p4-2", text: "继续讨论", mentions: [{ id: a.id, source: "manual" }] });
  assert.equal(continued.text, "继续讨论", "续话必须实际发送成功");
  await settle(host);
  const round = aSaw.find((r) => r.includes("群:user:继续讨论")) ?? [];
  console.log(`P4(对照) 观测: 用户续话那一轮甲收到 ${JSON.stringify(round)}`);
  assert.ok(round.includes("群:contact:乙的补充意见"));
});
test("探针P4：被拦后该联系人先在别处跑过无关的一轮,用户再续话时被拦的那条原文仍应给到它", async () => {
  const { host, g, a, aSaw } = await prepareBlockedContinuation(true, Host);
  const continued = host.send({ roomId: g.id, clientActionId: "p4-2", text: "继续讨论", mentions: [{ id: a.id, source: "manual" }] });
  assert.equal(continued.text, "继续讨论", "续话必须实际发送成功");
  await settle(host);
  const round = aSaw.find((r) => r.includes("群:user:继续讨论")) ?? [];
  console.log(`P4 观测: 用户续话那一轮甲收到 ${JSON.stringify(round)}`);
  assert.ok(round.includes("群:contact:乙的补充意见"), "停止说明写的是「待处理…等用户发言继续」,用户续话时被拦的原文不该已被游标越过");
});

test("探针P5：默认上限下四人群里,已放行(已扣额度)的唤醒不应因同一条消息后面的目标被拦而作废", async () => {
  let aId = "", bId = ""; const done = new Set<string>(); const aSaw: string[] = []; let aRound = 0;
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const mind = (): ContactMind => ({ async round(i) {
    const actions: MindAction[] = []; const ms = msgsOf(i);
    if (i.contact.id === aId) {
      if (++aRound === 1) await gate;
      for (const f of ms) { if (f.sender.kind === "user") actions.push({ kind: "reply", roomId: f.roomId, text: "甲答", replyToSeq: null }); if (f.sender.kind === "contact") aSaw.push(f.text); }
    } else {
      if (i.contact.id === bId) for (const f of ms) if (f.sender.kind === "contact" && f.text === "甲答") actions.push({ kind: "reply", roomId: f.roomId, text: "乙补充", replyToSeq: null });
      done.add(i.contact.id);
    }
    return { actions, stateNote: null };
  } });
  const host = new Host({ ...fresh(), mind, maxDeferMs: 2 }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" }); bId = b.id;
  const c = host.createContact({ name: "丙" }); const d = host.createContact({ name: "丁" });
  const g = host.createGroup("四人群", [a, b, c, d].map((x) => ({ kind: "contact" as const, id: x.id })));
  host.send({ roomId: g.id, clientActionId: "p5", text: "大家看看这个问题" });
  await waitFor(() => done.size === 3, "乙丙丁各自先处理完用户这句");
  release();
  await settle(host);
  const sup = host.listMessages(g.id, { limit: 500 }).messages.find((m) => m.text === "乙补充");
  assert.ok(sup, "前置:乙的补充已落盘");
  const wakes = all<{ contact_id: string; allowed: number }>(host.db, "SELECT contact_id,allowed FROM gg_loop_wakes WHERE room_id=? AND seq=? ORDER BY contact_id", g.id, sup.seq);
  const mine = wakes.find((w) => w.contact_id === a.id);
  console.log(`P5 观测: 「乙补充」的唤醒记录 ${JSON.stringify(wakes.map((w) => [w.contact_id === a.id ? "甲" : w.contact_id === c.id ? "丙" : "丁", w.allowed]))}, 甲看到的联系人消息 ${JSON.stringify(aSaw)}, 停止说明 ${notices(host, g.id).length} 条`);
  assert.equal(mine?.allowed, 1, "前置:「乙补充」对甲的唤醒是放行的(同根第 4 次,默认上限 4)");
  assert.ok(aSaw.includes("乙补充"), "对甲的这次唤醒已放行并扣了额度,甲应当收到「乙补充」");
});
