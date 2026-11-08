// AC-48 私聊 rewind(U26/D05):预览只读、取消即什么都不变;执行后回退点之后的消息不再作为任何联系人的当前上下文
// (不送达第 4 块、不被第 5 块换入、来源于它们的承诺作废、在途任务走 Cancel → 等真实停止确认),
// 已发生的外部副作用(起过的 Compute、已产出的结果)如实列出,任何文案都不声称已撤销。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import type { RewindPreview, RewindResult, TaskView } from "@g-group/api-contract";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { all, getDoc } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-rewind-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);
const NOW = "2026-11-09T08:00:00.000Z";

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
async function until(cond: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("等不到条件成立");
}
const rows = (host: Host, sql: string) => all<Record<string, unknown>>(host.db, sql).map((r) => ({ ...r }));
const stateOf = (host: Host, taskId: string) => host.taskView(host.taskDoc(taskId).value).state;
const BAD_CLAIM = /已撤回|已撤销|撤回了|撤销了/;
/** 经合同取任务当前状态。 */
async function stateVia(svc: ReturnType<typeof createService>, taskId: string) {
  const r = await svc.handle("tasks.get", { taskId });
  return r.ok ? (r.value as TaskView).state : r.error.code;
}

/** 宿主里所有和回退有关的状态,逐项比对用。 */
function snapshot(host: Host, roomId: string, contactId: string) {
  return {
    messages: host.listMessages(roomId, {}).messages,
    room: host.roomView(roomId),
    tasks: host.listTasks({}),
    commitments: host.listCommitments({}),
    cursor: rows(host, "SELECT contact_id, room_id, processed_seq FROM gg_cursor ORDER BY contact_id, room_id"),
    inbox: rows(host, "SELECT id, contact_id, consumed FROM gg_inbox ORDER BY id"),
    cards: rows(host, "SELECT card_id, state FROM gg_cards ORDER BY card_id"),
    read: rows(host, "SELECT room_id, kind, member_id, upto_seq FROM gg_read ORDER BY rowid"),
    note: getDoc(host.db, `note:${contactId}`) ?? null,
    lastSeq: host.lastSeq(roomId),
  };
}

/**
 * 私聊:#1 用户「你好」、#2 联系人回复;#3 用户派活、#4 接任务卡、#5 联系人回复;Compute cp-1 运行中。
 * holdStop:Compute 收到 stop 只记下来、不回报 stopped,用来证明没有停止确认就不算停下。
 */
async function scenario(opts: { holdStop?: boolean; mind?: ContactMind; onReport?: (what: string, detail: unknown) => void } = {}) {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const stops: string[] = [];
  const adapter: ComputeAdapter = opts.holdStop
    ? {
        ...compute.adapter,
        stop: async (id: string) => {
          stops.push(id);
          return { ok: true as const };
        },
      }
    : compute.adapter;
  const rounds: RoundInput[] = [];
  const mind = opts.mind ?? scriptedMind({ onRound: (i) => rounds.push(i) });
  const host = new Host({ file: file(), now: () => NOW, mind: () => mind, compute: () => adapter, maxDeferMs: 5, ...(opts.onReport ? { onReport: opts.onReport } : {}) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "你好" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我把周报发给老板" });
  await settle(host, compute);
  const task = host.listTasks({ roomId: dm.id })[0]!;
  return { compute, stops, host, c, dm, task, rounds };
}

test("rewind 预览只读:列出将撤下的消息、将取消的在途任务、将作废的承诺与已发生的 Compute;消息、任务、承诺、游标、待处理输入、卡片前后逐项不变,不发事件", async () => {
  const { compute, host, c, dm, task } = await scenario();
  assert.equal(task.state, "T3_Running");
  const k = host.listCommitments({ roomId: dm.id })[0]!;
  const before = snapshot(host, dm.id, c.id);
  const events: string[] = [];
  const off = host.bus.subscribe((e) => events.push(e.type));
  const p = host.rewindPreview(dm.id, 2);
  off();
  assert.deepEqual(p, {
    roomId: dm.id,
    toSeq: 2,
    messages: [
      { seq: 3, sender: { kind: "user", id: "me" }, excerpt: "帮我把周报发给老板" },
      { seq: 4, sender: { kind: "contact", id: c.id }, excerpt: "接了任务:把周报发给老板" },
      { seq: 5, sender: { kind: "contact", id: c.id }, excerpt: "好的,我安排 Compute 去把周报发给老板,有进度告诉你。" },
    ],
    tasks: [{ taskId: task.id, title: "把周报发给老板", sourceSeq: 3, state: "T3_Running" }],
    commitments: [{ commitmentId: k.id, contactId: c.id, sourceSeq: 3, taskId: task.id, text: "把周报发给老板" }],
    sideEffects: [{ kind: "compute", taskId: task.id, taskTitle: "把周报发给老板", computeId: "cp-1", status: "running", result: null, startedAt: NOW, endedAt: null }],
  } satisfies RewindPreview);
  assert.deepEqual(events, [], "预览不发任何事件");
  assert.deepEqual(snapshot(host, dm.id, c.id), before);

  // 经合同调用同样只读;回退点在任务来源之后时,任务不在取消清单里
  const svc = createService(host);
  const r = await svc.handle("rooms.rewindPreview", { roomId: dm.id, toSeq: 4 });
  assert.ok(r.ok, JSON.stringify(r));
  const v = r.value as RewindPreview;
  assert.deepEqual([v.messages.map((m) => m.seq), v.tasks, v.commitments, v.sideEffects], [[5], [], [], []]);
  // 用户看完不确认 = 取消:什么都不变,Compute 没被停,也没有新派活
  await settle(host, compute);
  assert.deepEqual(snapshot(host, dm.id, c.id), before);
  assert.deepEqual([compute.spawned.length, compute.stopped], [1, []]);
  compute.close();
  await host.close();
});

test("rewind 执行:之后的消息标 rewound 照常列出;来源于它们的在途任务 Cancel → T9、Compute 收到 stop,停止确认前不算停下,确认后 T10;承诺作废;回退说明如实写明已发生的不撤销", async () => {
  const { compute, stops, host, dm, task, rounds } = await scenario({ holdStop: true });
  const svc = createService(host);
  const k = host.listCommitments({ roomId: dm.id })[0]!;
  const r = await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: 2, clientActionId: "rw1" });
  assert.ok(r.ok, JSON.stringify(r));
  const res = r.value as RewindResult;
  assert.equal(await stateVia(svc, task.id), "T9_StopRequested");
  assert.deepEqual(res.tasks, [{ taskId: task.id, title: "把周报发给老板", sourceSeq: 3, state: "T9_StopRequested" }]);
  assert.deepEqual(res.messages.map((m) => m.seq), [3, 4, 5]);
  assert.deepEqual(res.commitments.map((x) => x.commitmentId), [k.id]);
  assert.deepEqual(res.sideEffects.map((x) => [x.computeId, x.status, x.result]), [["cp-1", "running", null]]);
  assert.deepEqual([res.markerSeq, res.at], [6, NOW]);

  await settle(host, compute);
  assert.deepEqual(stops, ["cp-1"], "向 Compute 发了停止");
  assert.equal(stateOf(host, task.id), "T9_StopRequested", "没有停止确认就不算停下");
  assert.deepEqual(host.listCommitments({ roomId: dm.id }).map((x) => [x.id, x.status]), [[k.id, "revoked"]]);
  assert.equal(compute.spawned.length, 1, "回退后没有按撤下的请求重新派活");

  const msgs = host.listMessages(dm.id, {}).messages;
  assert.deepEqual(
    msgs.slice(0, 6).map((m) => [m.seq, m.rewound === true]),
    [[1, false], [2, false], [3, true], [4, true], [5, true], [6, false]],
  );
  const marker = msgs[5]!;
  assert.deepEqual([marker.sender, marker.replyToSeq, marker.command?.name, marker.clientActionId], [{ kind: "user", id: "me" }, 2, "rewind", "rw1"]);
  assert.match(marker.text, /回退到 #2/);
  assert.match(marker.text, /1 项已经发生的外部操作.*不会被撤销/);
  assert.doesNotMatch(marker.text, BAD_CLAIM);
  assert.equal(msgs[3]!.card?.state, "expired", "取消了的任务卡收口,不再可点");
  assert.equal(host.roomView(dm.id).pendingForUser, 0);
  assert.throws(() => host.editMessage(dm.id, 3, "改一下"), /已回退/);
  // 联系人下一轮收到的是回退说明,不是撤下的消息
  assert.deepEqual(rounds.at(-1)!.fresh.map((f) => (f.kind === "message" ? f.seq : f.kind)), [6]);

  // Compute 真正回报停下,任务才落到 T10
  await compute.adapter.stop("cp-1");
  await settle(host, compute);
  assert.equal(await stateVia(svc, task.id), "T10_Cancelled");
  compute.close();
  await host.close();
});

test("rewind 后联系人第 4 块不再有撤下的消息;新消息引用它,第 5 块也换不进它的原文(没撤下的照常换入);附件资产不删", async () => {
  const rounds: RoundInput[] = [];
  const mind: ContactMind = {
    async round(i) {
      rounds.push(i);
      return { actions: [], stateNote: null };
    },
  };
  const host = new Host({ file: file(), dataDir: path.join(dir, "data-b45"), now: () => NOW, mind: () => mind, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const f = path.join(dir, "draft.txt");
  writeFileSync(f, "NEUTRAL_FIXTURE_NO_CREDENTIALS");
  const att = host.addAttachment(f);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "第一条:周五开会" });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我给老板发邮件说项目延期", attachments: [att.ref] });
  // 联系人这一轮还在处理 #1 时用户回退到 #1:#2 还没送达就被撤下
  const res = host.rewind({ roomId: dm.id, toSeq: 1, clientActionId: "rw" });
  assert.deepEqual([res.messages.map((m) => m.seq), res.markerSeq], [[2], 3]);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "u3", text: "按之前说的办", quotedSeqs: [1, 2] });
  await settle(host);

  assert.deepEqual(rounds.map((r) => r.fresh.map((x) => (x.kind === "message" ? x.seq : x.kind))), [[1], [3], [4]]);
  const block = (r: RoundInput, n: number) => r.request.blocks.find((b) => b.block === n)!.text;
  for (const r of rounds) assert.doesNotMatch(block(r, 4), /发邮件说项目延期/);
  assert.match(block(rounds[1]!, 4), /回退到 #1/);
  const b5 = block(rounds[2]!, 5);
  assert.match(b5, /周五开会/, "没撤下的被引用消息照常换入");
  assert.doesNotMatch(b5, /发邮件说项目延期/, "撤下的被引用消息不换入");
  // 删聊天不删资产:撤下的消息和它的附件都还在
  const m2 = host.listMessages(dm.id, {}).messages.find((m) => m.seq === 2)!;
  assert.deepEqual([m2.rewound, m2.text, m2.attachments.map((a) => a.ref)], [true, "帮我给老板发邮件说项目延期", [att.ref]]);
  const stored = all<{ path: string }>(host.db, "SELECT path FROM gg_attachments WHERE ref = ?", att.ref)[0]!;
  assert.equal(existsSync(stored.path), true);
  await host.close();
});

test("rewind:已完成的 Compute 结果列在「已发生、未撤销」里;任务照样取消并等停止确认,交付卡收口,文案不声称结果被撤回", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), now: () => NOW, mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "你好" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我写一个 hello.txt" });
  await settle(host, compute);
  const task = host.listTasks({ roomId: dm.id })[0]!;
  assert.equal(task.state, "T5_InReview");
  const expected = [{ kind: "compute", taskId: task.id, taskTitle: "写一个 hello.txt", computeId: "cp-1", status: "completed" as const, result: "完成:写一个 hello.txt", startedAt: NOW, endedAt: NOW }];
  const p = host.rewindPreview(dm.id, 2);
  assert.deepEqual(p.sideEffects, expected);
  const res: RewindResult = host.rewind({ roomId: dm.id, toSeq: 2, clientActionId: "rw" });
  assert.deepEqual(res.sideEffects, expected);
  assert.deepEqual(res.tasks.map((t) => [t.taskId, t.state]), [[task.id, "T9_StopRequested"]]);
  assert.deepEqual(res.messages.map((m) => m.seq), [3, 4, 5, 6, 7]);
  const marker = host.listMessages(dm.id, {}).messages.find((m) => m.seq === res.markerSeq)!;
  assert.match(marker.text, /1 项已经发生的外部操作.*不会被撤销/);
  assert.doesNotMatch(marker.text, BAD_CLAIM);
  assert.doesNotMatch(JSON.stringify(res), BAD_CLAIM);
  await settle(host, compute);
  assert.equal(stateOf(host, task.id), "T10_Cancelled");
  assert.deepEqual(compute.stopped, ["cp-1"]);
  const cards = host.listMessages(dm.id, {}).messages.filter((m) => m.card).map((m) => [m.seq, m.card!.kind, m.card!.state]);
  assert.deepEqual(cards, [[4, "task-status", "expired"], [7, "delivery", "expired"]]);
  compute.close();
  await host.close();
});

test("rewind:同一 clientActionId 重放返回同一结果,不重复撤下、不重复记回退说明、不重复停 Compute;回退点是已撤下的消息 → invalid_params", async () => {
  const { compute, host, dm } = await scenario();
  const svc = createService(host);
  const a = host.rewind({ roomId: dm.id, toSeq: 2, clientActionId: "rw1" });
  assert.deepEqual(host.rewind({ roomId: dm.id, toSeq: 2, clientActionId: "rw1" }), a);
  await settle(host, compute);
  const again = await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: 2, clientActionId: "rw1" });
  assert.ok(again.ok, JSON.stringify(again));
  assert.deepEqual(again.value, a);
  await settle(host, compute);
  const markers = host.listMessages(dm.id, {}).messages.filter((m) => m.command?.name === "rewind").map((m) => m.seq);
  assert.deepEqual(markers, [a.markerSeq]);
  assert.deepEqual(compute.stopped, ["cp-1"]);
  assert.deepEqual(host.listMessages(dm.id, {}).messages.filter((m) => m.rewound).map((m) => m.seq), [3, 4, 5]);
  const stale = await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: 4, clientActionId: "rw2" });
  assert.equal(stale.ok ? "ok" : stale.error.code, "invalid_params");
  compute.close();
  await host.close();
});

test("rewind 只在私聊:群聊 forbidden;会话不存在 not_found;回退点不是本会话的消息或之后没有消息 invalid_params;被拒时什么都不变", async () => {
  const host = new Host({ file: file(), now: () => NOW, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "A" });
  const g = host.createGroup("群", [{ kind: "contact", id: a.id }]);
  host.send({ roomId: g.id, clientActionId: "g1", text: "大家好" });
  host.send({ roomId: g.id, clientActionId: "g2", text: "今天的安排" });
  const dm = host.openDm(a.id);
  host.send({ roomId: dm.id, clientActionId: "d1", text: "你好" });
  await settle(host);
  const before = [snapshot(host, g.id, a.id), snapshot(host, dm.id, a.id)];
  const code = async (m: string, p: unknown) => {
    const r = await svc.handle(m, p);
    return r.ok ? "ok" : r.error.code;
  };
  assert.deepEqual(
    [
      await code("rooms.rewindPreview", { roomId: g.id, toSeq: 1 }),
      await code("rooms.rewind", { roomId: g.id, toSeq: 1, clientActionId: "x1" }),
      await code("rooms.rewindPreview", { roomId: "dm-nope", toSeq: 1 }),
      await code("rooms.rewind", { roomId: "dm-nope", toSeq: 1, clientActionId: "x2" }),
      await code("rooms.rewindPreview", { roomId: dm.id, toSeq: 99 }),
      await code("rooms.rewind", { roomId: dm.id, toSeq: 99, clientActionId: "x3" }),
      await code("rooms.rewind", { roomId: dm.id, toSeq: 0, clientActionId: "x4" }),
      await code("rooms.rewind", { roomId: dm.id, toSeq: 2, clientActionId: "x5" }),
    ],
    ["forbidden", "forbidden", "not_found", "not_found", "invalid_params", "invalid_params", "invalid_params", "invalid_params"],
  );
  await settle(host);
  assert.deepEqual([snapshot(host, g.id, a.id), snapshot(host, dm.id, a.id)], before);
  // 合法的回退点照常可用(证明上面是按条件拒绝,不是方法本身不可用)
  assert.equal(await code("rooms.rewindPreview", { roomId: dm.id, toSeq: 1 }), "ok");
  await host.close();
});

/** Compute 启动卡在半路:spawn 等 release 才返回(fail 给出原因时返回启动失败)。 */
async function launchPending(fail?: string) {
  const compute = scriptedCompute({ script: () => [] });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let spawnCalls = 0;
  const adapter: ComputeAdapter = {
    ...compute.adapter,
    spawn: async (brief, o) => {
      spawnCalls++;
      await gate;
      return fail ? { ok: false as const, reason: fail } : compute.adapter.spawn(brief, o);
    },
  };
  const host = new Host({ file: file(), now: () => NOW, mind: () => scriptedMind(), compute: () => adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "你好" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我整理发票" });
  await until(() => spawnCalls === 1);
  const task = host.listTasks({ roomId: dm.id })[0]!;
  return { compute, host, dm, task, release };
}

test("rewind 时 Compute 还在启动途中:任务进 T9 等撤销确认;实例一上线就被停,停止确认后 T10,不会带着作废的请求跑下去", async () => {
  const { compute, host, dm, task, release } = await launchPending();
  const svc = createService(host);
  assert.equal(task.state, "T2_Claimed");
  const r = await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: 2, clientActionId: "rw" });
  assert.ok(r.ok, JSON.stringify(r));
  const res = r.value as RewindResult;
  assert.deepEqual([res.tasks.map((t) => t.state), res.sideEffects], [["T9_StopRequested"], []]);
  assert.equal(await stateVia(svc, task.id), "T9_StopRequested");
  release();
  await settle(host, compute);
  assert.deepEqual(compute.stopped, ["cp-1"], "启动途中被取消的实例一上线就停");
  assert.equal(await stateVia(svc, task.id), "T10_Cancelled");
  compute.close();
  await host.close();
});

test("rewind 时 Compute 还在启动途中、随后启动失败:撤销即确认,任务落到 T10,不卡在 T9", async () => {
  const { compute, host, dm, task, release } = await launchPending("额度用完");
  const svc = createService(host);
  const r = await svc.handle("rooms.rewind", { roomId: dm.id, toSeq: 2, clientActionId: "rw" });
  assert.deepEqual(r.ok ? (r.value as RewindResult).tasks.map((t) => [t.taskId, t.state]) : r.error, [[task.id, "T9_StopRequested"]]);
  assert.equal(await stateVia(svc, task.id), "T9_StopRequested");
  release();
  await settle(host, compute);
  assert.deepEqual([compute.spawned, compute.stopped], [[], []]);
  assert.equal(await stateVia(svc, task.id), "T10_Cancelled");
  compute.close();
  await host.close();
});

test("rewind 后联系人想把补充转给已取消任务的 Compute:被拒,停止中的 Compute 不会被恢复", async () => {
  const ctl = { taskId: "" };
  const base = scriptedMind();
  const mind: ContactMind = {
    async round(i, signal) {
      const out = await base.round(i, signal);
      const sawRewind = i.fresh.some((f) => f.kind === "message" && f.command?.name === "rewind");
      return sawRewind ? { ...out, actions: [...out.actions, { kind: "forward", taskId: ctl.taskId, text: "接着把周报发出去" }] } : out;
    },
  };
  const rejected: { kind: string; reason: string }[] = [];
  const { compute, host, dm, task } = await scenario({
    holdStop: true,
    mind,
    onReport: (what, d) => {
      if (what === "action-rejected") rejected.push({ kind: (d as { action: MindAction }).action.kind, reason: (d as { reason: string }).reason });
    },
  });
  ctl.taskId = task.id;
  host.rewind({ roomId: dm.id, toSeq: 2, clientActionId: "rw" });
  await settle(host, compute);
  assert.equal(stateOf(host, task.id), "T9_StopRequested");
  assert.deepEqual(compute.resumed, []);
  assert.deepEqual(rejected, [{ kind: "forward", reason: "任务没有在途 Compute" }]);
  compute.close();
  await host.close();
});

test("rewind 发生在联系人这一轮途中:基于撤下消息的派活被放弃重跑,只登记承诺的也被拒,不会按撤下的请求执行", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = new Set<string>();
  const mind = (contactId: string): ContactMind => ({
    async round(i) {
      const ask = i.fresh.find((f) => f.kind === "message" && f.text === "帮我订机票");
      if (ask?.kind !== "message") {
        const m = i.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
        return { actions: m && m.kind === "message" ? [{ kind: "reply", roomId: m.roomId, text: "收到", replyToSeq: m.seq }] : [], stateNote: null };
      }
      held.add(contactId);
      await gate;
      const commit: MindAction = { kind: "commit", roomId: ask.roomId, sourceSeq: ask.seq, text: "订机票", taskId: null };
      const actions: MindAction[] = i.contact.name === "只登记"
        ? [commit]
        : [{ kind: "dispatch", roomId: ask.roomId, sourceSeq: ask.seq, title: "订机票", task: "订机票" }, commit, { kind: "reply", roomId: ask.roomId, text: "好的", replyToSeq: ask.seq }];
      return { actions, stateNote: null };
    },
  });
  const compute = scriptedCompute();
  const rejected: { contactId: string; reason: string }[] = [];
  const host = new Host({
    file: file(),
    now: () => NOW,
    mind: (cv) => mind(cv.id),
    compute: () => compute.adapter,
    maxDeferMs: 5,
    onReport: (what, d) => {
      if (what === "action-rejected") rejected.push({ contactId: (d as { contactId: string }).contactId, reason: (d as { reason: string }).reason });
    },
  });
  const a = host.createContact({ name: "只登记" });
  const b = host.createContact({ name: "派活" });
  const dmA = host.openDm(a.id);
  const dmB = host.openDm(b.id);
  for (const dm of [dmA, dmB]) host.send({ roomId: dm.id, clientActionId: `${dm.id}-1`, text: "你好" });
  await settle(host);
  for (const dm of [dmA, dmB]) host.send({ roomId: dm.id, clientActionId: `${dm.id}-2`, text: "帮我订机票" });
  await until(() => held.size === 2);
  for (const dm of [dmA, dmB]) host.rewind({ roomId: dm.id, toSeq: 2, clientActionId: `${dm.id}-rw` });
  release();
  await settle(host, compute);
  assert.deepEqual(host.listTasks({}), [], "没有按撤下的请求派活");
  assert.deepEqual(compute.spawned, []);
  assert.deepEqual(host.listCommitments({}), [], "没有登记来源已撤下的承诺");
  assert.deepEqual(rejected, [{ contactId: a.id, reason: "来源消息已回退" }]);
  compute.close();
  await host.close();
});
