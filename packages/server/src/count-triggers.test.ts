// 按消息数触发的联系人承诺(U80,D21.3 第 14 项、D21.4 第 1 步;验收 AC-35「常驻承诺」的消息数触发一项):
// - 联系人登记承诺时带 everyNMessages,宿主从登记那一刻起数这个会话的群聊发言;第 N 条冻结一段 (from, to],一段只冻结一次;
// - system 通知、任务事实卡、撤回的消息、提出人在自己这一端删掉的消息不计数;
// - 重发同一条(clientActionId)、关宿主重开都不多数、不重冻;消息已落盘但没来得及计数的,重启时补上;
// - 没人开就没有触发;承诺撤销、联系人移出、群解散后不再触发,没处理的窗口取消;N 不合格或不是用户提出的整条拒收。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { appendEvent } from "@g-group/adapter-sqlite";
import type { CommitmentView, MessageView, ServerEvent } from "@g-group/api-contract";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { type CountTriggerDeps, type CountWindow, CountTriggers } from "./count-triggers.ts";
import { type Db, all, openDb, tx } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-count-trigger-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const live: Host[] = [];
const track = (h: Host) => {
  live.push(h);
  return h;
};
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const h of live.splice(0)) await h.close();
});
let n = 0;
const file = () => path.join(dir, `c${++n}.db`);
async function settle(host: Host) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
const okValue = <T>(r: { ok: boolean; value?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};
const contact = (id: string) => ({ kind: "contact" as const, id });
const ASK = /^每 (-?[\d.]+) 条消息总结一次$/;
/**
 * 联系人脑子:用户说「每 N 条消息总结一次」→ 登记一条带 everyNMessages 的承诺并回一句;别的消息一概不出声。
 * viaReply:承诺原文出自它自己的回复(AC-40 ②)而不是用户原话。
 */
const mind = (opts: { viaReply?: boolean } = {}) => (): ContactMind => ({
  async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind !== "message") continue;
      const m = ASK.exec(f.text);
      if (!m) continue;
      const mine = `我会每 ${m[1]} 条总结一次`;
      actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: opts.viaReply ? mine : f.text, taskId: null, everyNMessages: Number(m[1]) });
      actions.push({ kind: "reply", roomId: f.roomId, text: opts.viaReply ? `好,${mine}` : "好,记下了", replyToSeq: f.seq });
    }
    return { actions, stateNote: null };
  },
});
const windowsOf = (host: { db: Db }) => all<{ trigger_id: string; from_seq: number; to_seq: number; status: string }>(host.db, "SELECT trigger_id, from_seq, to_seq, status FROM gg_count_windows ORDER BY trigger_id, to_seq");
const triggersOf = (host: Host) => all<{ commitment_id: string; every_n: number; covered_seq: number; status: string; closed_reason: string | null }>(host.db, "SELECT commitment_id, every_n, covered_seq, status, closed_reason FROM gg_count_triggers ORDER BY created_at, id");
const fires = (out: { from: number; to: number }[]) => (what: string, d: unknown) => {
  if (what === "count-window") out.push({ from: (d as { fromSeqExclusive: number }).fromSeqExclusive, to: (d as { toSeqInclusive: number }).toSeqInclusive });
};
const rejections = (out: string[]) => (what: string, d: unknown) => {
  if (what === "action-rejected") out.push(`${(d as { action: { kind: string } }).action.kind}:${(d as { reason: string }).reason}`);
};

test("没人开就没有触发;开了之后第 99 条不冻结、第 100 条冻结一段、第 101 条不再冻结,coveredSeq 停在第 100 条", async () => {
  const fired: { from: number; to: number }[] = [];
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5, onReport: fires(fired) }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  const list = async () => okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments;
  // 没人开:聊多少条都没有触发,也没有窗口
  for (let i = 0; i < 5; i++) h.send({ roomId: g.id, clientActionId: `pre${i}`, text: `闲聊 ${i}` });
  await settle(h);
  assert.deepEqual([triggersOf(h), windowsOf(h), fired, (await list()).length], [[], [], [], 0]);

  h.send({ roomId: g.id, clientActionId: "ask", text: "每 100 条消息总结一次" });
  await settle(h);
  const start = h.lastSeq(g.id);
  const opened = await list();
  assert.deepEqual(opened.map((c) => [c.text, c.status, c.trigger]), [["每 100 条消息总结一次", "active", { kind: "message-count", everyN: 100, coveredSeq: start, count: 0, active: true, windows: 0 }]]);

  const sent: MessageView[] = [];
  for (let i = 1; i <= 99; i++) sent.push(h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }));
  await settle(h);
  assert.deepEqual([(await list())[0]!.trigger, windowsOf(h).length, fired.length], [{ kind: "message-count", everyN: 100, coveredSeq: start, count: 99, active: true, windows: 0 }, 0, 0]);

  const hundredth = h.send({ roomId: g.id, clientActionId: "m100", text: "第 100 条" });
  await settle(h);
  assert.deepEqual(windowsOf(h).map((w) => [w.from_seq, w.to_seq]), [[start, hundredth.seq]]);
  assert.deepEqual(fired, [{ from: start, to: hundredth.seq }]);
  assert.deepEqual((await list())[0]!.trigger, { kind: "message-count", everyN: 100, coveredSeq: hundredth.seq, count: 0, active: true, windows: 1 });
  assert.equal(hundredth.seq - start, 100);

  h.send({ roomId: g.id, clientActionId: "m101", text: "第 101 条" });
  await settle(h);
  assert.deepEqual([windowsOf(h).length, fired.length, (await list())[0]!.trigger?.count, (await list())[0]!.trigger?.coveredSeq], [1, 1, 1, hundredth.seq]);
});

test("一段正好 N 条:连续两轮各冻结一段,第二段的起点就是第一段的终点;冻结时推 commitment.updated 带新的 coveredSeq", async () => {
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5 }));
  const svc = createService(h);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h);
  const start = h.lastSeq(g.id);
  const seqs: number[] = [];
  for (let i = 1; i <= 7; i++) seqs.push(h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }).seq);
  await settle(h);
  assert.deepEqual(windowsOf(h).map((w) => [w.from_seq, w.to_seq]), [[start, seqs[2]], [seqs[2], seqs[5]]]);
  const covered = events.flatMap((e) => (e.type === "commitment.updated" && e.commitment.trigger ? [[e.commitment.trigger.coveredSeq, e.commitment.trigger.windows]] : []));
  assert.deepEqual(covered, [[start, 0], [seqs[2], 1], [seqs[5], 2]]);
  const view = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { contactId: a.id })).commitments[0]!.trigger;
  assert.deepEqual(view, { kind: "message-count", everyN: 3, coveredSeq: seqs[5], count: 1, active: true, windows: 2 });
});

test("不算群聊发言的不计数:system 通知、任务事实卡、撤回的消息、提出人本端删除的消息;联系人自己的发言照算", async () => {
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 4 条消息总结一次" });
  await settle(h);
  const start = h.lastSeq(g.id);
  const count = async () => okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments[0]!.trigger!.count;
  h.postSystemNotice(g.id, "宿主通知:今晚维护", "n1");
  assert.equal(await count(), 0);
  await svc.handle("tasks.create", { clientActionId: "t1", roomId: g.id, title: "整理周报" });
  assert.equal(await count(), 0);
  const gone = h.send({ roomId: g.id, clientActionId: "x1", text: "发错了" });
  const kept = h.send({ roomId: g.id, clientActionId: "x2", text: "这条留着" });
  const mineHidden = h.send({ roomId: g.id, clientActionId: "x3", text: "我这边删掉" });
  await settle(h);
  assert.equal(await count(), 3);
  h.retractMessage(g.id, gone.seq);
  assert.equal(await count(), 2);
  okValue(await svc.handle("messages.delete", { roomId: g.id, seqs: [mineHidden.seq], clientActionId: "d1" }));
  assert.equal(await count(), 1);
  assert.deepEqual(windowsOf(h), []);
  // 联系人说的话算群聊发言:它对下一条承诺请求的回复计入本条触发
  h.send({ roomId: g.id, clientActionId: "y1", text: "每 50 条消息总结一次" });
  await settle(h);
  const reply = h.lastSeq(g.id);
  assert.equal(await count(), 3);
  const fourth = h.send({ roomId: g.id, clientActionId: "y2", text: "凑够四条" });
  await settle(h);
  // 这一段里算数的四条:kept、第二次请求、联系人的回复、fourth;撤回的、本端删的、通知、任务卡都不在数里
  assert.deepEqual(windowsOf(h).map((w) => [w.from_seq, w.to_seq]), [[start, fourth.seq]]);
  assert.deepEqual([kept.seq < reply, reply < fourth.seq, await count()], [true, true, 0]);
});

test("重放与重启不多数:同一 clientActionId 重发不计数;关宿主重开接着数,已冻结的不重冻,再开一次也不多冻", async () => {
  const f = file();
  const h1 = track(new Host({ file: f, mind: mind(), maxDeferMs: 5 }));
  const a = h1.createContact({ name: "小记" });
  const g = h1.createGroup("研发群", [contact(a.id)]);
  h1.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h1);
  const start = h1.lastSeq(g.id);
  h1.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  const again = h1.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  h1.send({ roomId: g.id, clientActionId: "m2", text: "二" });
  await settle(h1);
  assert.deepEqual([h1.lastSeq(g.id) - start, windowsOf(h1).length, again.seq], [2, 0, start + 1]);
  await h1.close();

  const fired2: { from: number; to: number }[] = [];
  const h2 = track(new Host({ file: f, mind: mind(), maxDeferMs: 5, onReport: fires(fired2) }));
  assert.deepEqual([windowsOf(h2).length, fired2.length, triggersOf(h2)[0]!.covered_seq], [0, 0, start]);
  const third = h2.send({ roomId: g.id, clientActionId: "m3", text: "三" });
  h2.send({ roomId: g.id, clientActionId: "m3", text: "三" });
  await settle(h2);
  assert.deepEqual([windowsOf(h2).map((w) => [w.from_seq, w.to_seq]), fired2], [[[start, third.seq]], [{ from: start, to: third.seq }]]);
  await h2.close();

  // 再重开:不多冻,coveredSeq 不动;接着数,下一段从上一段的终点起
  const h3 = track(new Host({ file: f, mind: mind(), maxDeferMs: 5 }));
  assert.deepEqual([windowsOf(h3).length, triggersOf(h3)[0]!.covered_seq], [1, third.seq]);
  const more: number[] = [];
  for (let i = 4; i <= 6; i++) more.push(h3.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }).seq);
  await settle(h3);
  assert.deepEqual(windowsOf(h3).map((w) => [w.from_seq, w.to_seq]), [[start, third.seq], [third.seq, more[2]]]);
});

test("消息已落盘但没来得及计数:重启时补冻结,攒了两个 N 就冻结两段,每段正好 N 条", async () => {
  const f = file();
  const h1 = track(new Host({ file: f, mind: mind(), maxDeferMs: 5 }));
  const a = h1.createContact({ name: "小记" });
  const g = h1.createGroup("研发群", [contact(a.id)]);
  h1.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h1);
  const start = h1.lastSeq(g.id);
  const commitmentId = triggersOf(h1)[0]!.commitment_id;
  const seqs: number[] = [];
  for (let i = 1; i <= 5; i++) seqs.push(h1.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }).seq);
  await settle(h1);
  await h1.close();
  // 把计数结果抹回登记时的样子,等于「五条消息都落盘了,计数那一拍没发生」
  const raw = track(new Host({ file: f, mind: mind(), maxDeferMs: 5 }));
  raw.db.store.db.exec("DELETE FROM gg_count_windows");
  raw.db.store.db.prepare("UPDATE gg_count_triggers SET covered_seq = ? WHERE commitment_id = ?").run(start, commitmentId);
  await raw.close();

  const fired: { from: number; to: number }[] = [];
  const h2 = track(new Host({ file: f, mind: mind(), maxDeferMs: 5, onReport: fires(fired) }));
  assert.deepEqual(windowsOf(h2).map((w) => [w.from_seq, w.to_seq]), [[start, seqs[1]], [seqs[1], seqs[3]]]);
  assert.deepEqual(fired, [{ from: start, to: seqs[1]! }, { from: seqs[1]!, to: seqs[3]! }]);
  assert.deepEqual([triggersOf(h2)[0]!.covered_seq, h2.countTriggers.viewOf(commitmentId)?.count], [seqs[3], 1]);
});

test("撤销承诺后不再触发:触发关闭并写明原因,之后聊多少条都不冻结;另一条没撤销的照常", async () => {
  const fired: { from: number; to: number }[] = [];
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5, onReport: fires(fired) }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const b = h.createContact({ name: "小安" });
  const g = h.createGroup("研发群", [contact(a.id), contact(b.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  // 两位联系人都听到了这句话,各登记一条,各数各的
  const both = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments;
  assert.deepEqual(both.map((c) => [c.contactId, c.trigger?.everyN, c.trigger?.active]).sort(), [[a.id, 2, true], [b.id, 2, true]].sort());
  const mine = both.find((c) => c.contactId === a.id)!;
  const other = both.find((c) => c.contactId === b.id)!;
  h.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "二" });
  await settle(h);
  assert.equal(windowsOf(h).length, 2);
  const revoked = okValue<CommitmentView>(await svc.handle("commitments.revoke", { commitmentId: mine.id, clientActionId: "r1" }));
  assert.deepEqual([revoked.status, revoked.trigger?.active, revoked.trigger?.count], ["revoked", false, 0]);
  const mineTrigger = h.countTriggers.byCommitment(mine.id)!;
  const otherTrigger = h.countTriggers.byCommitment(other.id)!;
  assert.deepEqual([mineTrigger.status, mineTrigger.closedReason], ["closed", "承诺已撤销"]);
  const before = fired.length;
  for (let i = 3; i <= 6; i++) h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` });
  await settle(h);
  assert.deepEqual([h.countTriggers.windows(mineTrigger.id).length, h.countTriggers.windows(otherTrigger.id).length, fired.length - before], [1, 3, 2]);
});

test("联系人移出群、群解散后触发关闭并写明原因,不再冻结", async () => {
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g1 = h.createGroup("甲群", [contact(a.id)]);
  const g2 = h.createGroup("乙群", [contact(a.id)]);
  h.send({ roomId: g1.id, clientActionId: "ask1", text: "每 2 条消息总结一次" });
  h.send({ roomId: g2.id, clientActionId: "ask2", text: "每 2 条消息总结一次" });
  await settle(h);
  assert.deepEqual(triggersOf(h).map((t) => t.status), ["active", "active"]);
  h.removeMember(g1.id, contact(a.id));
  // 刚移出、还没来新消息:视图里已经不算在数
  assert.deepEqual(okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g1.id })).commitments.map((c) => [c.status, c.trigger?.active, c.trigger?.count]), [["active", false, 0]]);
  h.send({ roomId: g1.id, clientActionId: "a1", text: "一" });
  h.send({ roomId: g1.id, clientActionId: "a2", text: "二" });
  okValue(await svc.handle("rooms.dissolve", { roomId: g2.id, clientActionId: "dis" }));
  await settle(h);
  const byRoom = new Map(all<{ room_id: string; status: string; closed_reason: string | null }>(h.db, "SELECT room_id, status, closed_reason FROM gg_count_triggers").map((r) => [r.room_id, [r.status, r.closed_reason]]));
  assert.deepEqual([byRoom.get(g1.id), byRoom.get(g2.id), windowsOf(h)], [["closed", "联系人已不在这个会话"], ["closed", "会话已解散"], []]);
  const views = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { contactId: a.id })).commitments;
  assert.deepEqual(views.map((c) => [c.trigger?.active, c.trigger?.count]), [[false, 0], [false, 0]]);
});

test("正在移出的联系人(在途任务还没停稳)也不再数:触发关闭,不冻结", async () => {
  // 一直在跑的 Compute;停止确认到测试结束才放行,所以联系人停在「移出中」
  let finish!: () => void;
  const stopped = new Promise<void>((r) => (finish = r));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }], quiesce: async () => {
    await stopped;
    return { ok: true, killed: 1 };
  } });
  cleanups.push(() => {
    finish();
    compute.close();
  });
  const h = track(new Host({ file: file(), mind: mind(), compute: () => compute.adapter, maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  okValue(await svc.handle("tasks.create", { clientActionId: "t1", roomId: g.id, title: "长活", ownerContactId: a.id }));
  await settle(h);
  const leaving = okValue<{ leavingMembers?: { id: string }[]; members: { id: string }[] }>(await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(a.id), stopTasks: true }));
  assert.deepEqual([leaving.leavingMembers?.map((m) => m.id), leaving.members.some((m) => m.id === a.id)], [[a.id], true]);
  h.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "二" });
  await settle(h);
  assert.deepEqual([triggersOf(h).map((t) => [t.status, t.closed_reason]), windowsOf(h)], [[["closed", "联系人已不在这个会话"]], []]);
});

test("私聊 rewind 撤下的消息和那条回退说明不计数:回退后只剩回退点之前的还算", async () => {
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const dm = h.openDm(a.id);
  h.send({ roomId: dm.id, clientActionId: "ask", text: "每 4 条消息总结一次" });
  await settle(h);
  const count = async () => okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: dm.id })).commitments[0]!.trigger!.count;
  const keep = h.send({ roomId: dm.id, clientActionId: "m1", text: "留下的" });
  h.send({ roomId: dm.id, clientActionId: "m2", text: "要回退掉的一" });
  h.send({ roomId: dm.id, clientActionId: "m3", text: "要回退掉的二" });
  await settle(h);
  assert.equal(await count(), 3);
  const rewound = okValue<{ markerSeq: number }>(await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: keep.seq, clientActionId: "rw" }));
  await settle(h);
  // 回退说明这条消息本身落在会话里,但不是谁说的话
  assert.deepEqual([await count(), rewound.markerSeq > keep.seq, windowsOf(h)], [1, true, []]);
});

test("私聊 rewind 把提出承诺的那句撤下:承诺随回退撤销,触发在同一步关闭并写明原因,之后聊多少条都不冻结", async () => {
  const fired: { from: number; to: number }[] = [];
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5, onReport: fires(fired) }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const dm = h.openDm(a.id);
  const hello = h.send({ roomId: dm.id, clientActionId: "hello", text: "先打个招呼" });
  await settle(h);
  h.send({ roomId: dm.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  const k = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: dm.id })).commitments[0]!;
  assert.deepEqual([k.status, k.trigger?.active], ["active", true]);
  okValue(await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: hello.seq, clientActionId: "rw" }));
  await settle(h);
  const t = h.countTriggers.byCommitment(k.id)!;
  assert.deepEqual([t.status, t.closedReason], ["closed", "承诺已了结或撤销"]);
  for (let i = 1; i <= 5; i++) h.send({ roomId: dm.id, clientActionId: `m${i}`, text: `第 ${i} 条` });
  await settle(h);
  assert.deepEqual([windowsOf(h), fired, h.countTriggers.viewOf(k.id)?.active], [[], [], false]);
});

test("N 不合格整条拒收:0、小数、超过上限都不进账本也不建触发;合格的那条照常", async () => {
  const rejected: string[] = [];
  const h = track(new Host({ file: file(), mind: mind(), maxDeferMs: 5, onReport: rejections(rejected) }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  for (const [i, bad] of ["0", "2.5", "10001", "-3"].entries()) {
    h.send({ roomId: g.id, clientActionId: `bad${i}`, text: `每 ${bad} 条消息总结一次` });
    await settle(h);
  }
  const why = "commit:everyNMessages 必须是 1–10000 的整数";
  assert.deepEqual([rejected, triggersOf(h), okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments], [[why, why, why, why], [], []]);
  h.send({ roomId: g.id, clientActionId: "ok", text: "每 10000 条消息总结一次" });
  await settle(h);
  assert.deepEqual(triggersOf(h).map((t) => [t.every_n, t.status]), [[10000, "active"]]);
  assert.equal(rejected.length, 4);
});

test("承诺原文出自联系人自己的回复时同样登记触发;从它这句回复之后开始数", async () => {
  const h = track(new Host({ file: file(), mind: mind({ viaReply: true }), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  const ask = h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  const replySeq = h.lastSeq(g.id);
  const c = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments;
  assert.deepEqual(c.map((x) => [x.text, x.sourceSeq, x.trigger]), [["我会每 2 条总结一次", replySeq, { kind: "message-count", everyN: 2, coveredSeq: replySeq, count: 0, active: true, windows: 0 }]]);
  assert.equal(replySeq, ask.seq + 1);
  const t = h.countTriggers.byCommitment(c[0]!.id)!;
  assert.deepEqual([t.requesterId, t.sourceSeq, t.contactId, t.roomId], ["me", ask.seq, a.id, g.id]);
});

test("不是用户提出的不算:联系人拿另一位联系人说的话登记按消息数触发的承诺被拒收,用户亲口说的才登记", async () => {
  const rejected: string[] = [];
  const base = mind();
  // 小安:用户让它提,它就在群里说那句话;小记:照常,听到那句话就想登记
  const minds = (c: { name: string }): ContactMind =>
    c.name === "小安"
      ? { round: async (input) => ({ actions: input.fresh.flatMap((f): MindAction[] => (f.kind === "message" && f.text === "小安你来提" ? [{ kind: "reply", roomId: f.roomId, text: "每 3 条消息总结一次", replyToSeq: null }] : [])), stateNote: null }) }
      : base();
  const h = track(new Host({ file: file(), mind: minds, maxDeferMs: 5, onReport: rejections(rejected) }));
  const a = h.createContact({ name: "小记" });
  const b = h.createContact({ name: "小安" });
  const g = h.createGroup("研发群", [contact(a.id), contact(b.id)]);
  h.send({ roomId: g.id, clientActionId: "x", text: "小安你来提" });
  await settle(h);
  assert.deepEqual([rejected, triggersOf(h)], [["commit:按消息数触发的承诺要由用户提出"], []]);
  h.send({ roomId: g.id, clientActionId: "y", text: "每 3 条消息总结一次" });
  await settle(h);
  assert.deepEqual(triggersOf(h).map((t) => [t.every_n, t.status]), [[3, "active"]]);
  assert.equal(h.countTriggers.byCommitment(triggersOf(h)[0]!.commitment_id)?.contactId, a.id);
});

// ======================= 窗口交接(直接测模块:没有消费方在场) =======================
const AT = "2026-11-14T00:00:00.000Z";
/** 模块的依赖:时钟固定、编号自增;closed 给出关闭原因就等于「这条触发不该再数了」。 */
function deps(db: Db, log: { fired: CountWindow[]; changed: string[]; closed: { why: string | null } }): CountTriggerDeps {
  let k = 0;
  return { db, now: () => AT, newId: (p) => `${p}-${++k}-${log.fired.length}`, closedWhy: () => log.closed.why, hidden: () => () => false, changed: (c) => log.changed.push(c), fired: (w) => log.fired.push(w) };
}
const say = (db: Db, triggers: CountTriggers, text: string) =>
  tx(db, () => {
    const e = appendEvent(db.store, "room:r1", { kind: "user", id: "me" }, { kind: "message", text }, AT);
    triggers.onAppendTx("r1");
    return e.seq;
  });
const opened = { commitmentId: "k1", contactId: "c1", roomId: "r1", requesterId: "me", everyN: 2, sourceSeq: 1, coveredSeq: 0 };

test("没处理的窗口每次宿主运行只交给消费方一次,重启后再交一次;结算只认一次,结算过的重启后不再交", () => {
  const db = openDb(file());
  const log1 = { fired: [] as CountWindow[], changed: [] as string[], closed: { why: null as string | null } };
  const t1 = new CountTriggers(deps(db, log1));
  const made = tx(db, () => t1.createTx(opened));
  const first = say(db, t1, "一");
  const second = say(db, t1, "二");
  t1.announce();
  t1.announce();
  const win = { triggerId: made.id, commitmentId: "k1", contactId: "c1", roomId: "r1", requesterId: "me", fromSeqExclusive: 0, toSeqInclusive: second, status: "pending" };
  assert.deepEqual([log1.fired, log1.changed, second - first], [[win], ["k1"], 1]);
  // 重启(新实例,同一份数据):还没处理,再交一次,只一次
  const log2 = { fired: [] as CountWindow[], changed: [] as string[], closed: { why: null as string | null } };
  const t2 = new CountTriggers(deps(db, log2));
  tx(db, () => t2.reconcileTx());
  t2.announce();
  t2.announce();
  assert.deepEqual([log2.fired, t2.windows(made.id).length], [[win], 1]);
  assert.deepEqual([tx(db, () => t2.settleWindowTx(made.id, second, "done")), tx(db, () => t2.settleWindowTx(made.id, second, "failed")), t2.window(made.id, second)?.status], [true, false, "done"]);
  const log3 = { fired: [] as CountWindow[], changed: [] as string[], closed: { why: null as string | null } };
  const t3 = new CountTriggers(deps(db, log3));
  tx(db, () => t3.reconcileTx());
  t3.announce();
  assert.deepEqual([log3.fired, t3.byCommitment("k1")?.coveredSeq], [[], second]);
  db.close();
});

test("触发关闭时没处理的窗口一并取消:不再交给消费方,消费方来结算也不认;已结算的不动", () => {
  const db = openDb(file());
  const log = { fired: [] as CountWindow[], changed: [] as string[], closed: { why: null as string | null } };
  const t = new CountTriggers(deps(db, log));
  const made = tx(db, () => t.createTx(opened));
  say(db, t, "一");
  const w1 = say(db, t, "二");
  assert.equal(tx(db, () => t.settleWindowTx(made.id, w1, "done")), true);
  say(db, t, "三");
  const w2 = say(db, t, "四");
  // 承诺了结:下一次数的时候发现不该再数,关掉并取消还没处理的那一段
  log.closed.why = "承诺已了结或撤销";
  say(db, t, "五");
  t.announce();
  assert.deepEqual([t.byCommitment("k1")?.status, t.byCommitment("k1")?.closedReason, t.windows(made.id).map((w) => [w.toSeqInclusive, w.status])], ["closed", "承诺已了结或撤销", [[w1, "done"], [w2, "cancelled"]]]);
  assert.deepEqual([log.fired.map((w) => w.toSeqInclusive), tx(db, () => t.settleWindowTx(made.id, w2, "done")), t.viewOf("k1")], [[], false, { kind: "message-count", everyN: 2, coveredSeq: w2, count: 0, active: false, windows: 2 }]);
  // 关了以后再来消息不数;重复关闭不改原因
  say(db, t, "六");
  say(db, t, "七");
  tx(db, () => t.closeTx("k1", "另一个原因"));
  assert.deepEqual([t.windows(made.id).length, t.byCommitment("k1")?.closedReason], [2, "承诺已了结或撤销"]);
  db.close();
});
