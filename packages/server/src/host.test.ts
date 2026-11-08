// AC-30 Claude Code 最小闭环(用确定性替身驱动):私聊/群里派活 → 联系人建任务 → Compute 执行 → 进度回聊天 → 交付待确认 → 用户确认。
// 同时覆盖 AC-31 ①②③④(唯一入口全员送达、单人串行、action_id 去重、发送前撤销)、AC-46(接走即已读、群里联系人进名单)、
// AC-26 ⑤(没有跨厂商审查人时交付记为用户豁免,不当合规)、AC-40 ②(承诺登记与验收后了结)、AC-05(重启后记录还在)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-host-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `h${++fileNo}.db`);

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const texts = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.map((m) => `${m.sender.kind}:${m.text}`);

test("私聊派活闭环:接任务 → Compute 进度回聊天 → 交付卡 → 用户豁免审查并通过 → T8 已验收,承诺了结", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, computeCwd: (t) => `/tmp/gg/${t}`, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const sent = host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, compute);

  assert.equal(compute.spawned.length, 1);
  assert.deepEqual(compute.spawned[0]!.brief, { task: "写一个 hello.txt", rules: [], tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], credentialRefs: [], placement: "local" });
  assert.match(compute.spawned[0]!.cwd ?? "", /^\/tmp\/gg\/t-/);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.ok(task);
  assert.equal(task.state, "T5_InReview", "交付后等审查(没有跨厂商审查人,交给用户豁免)");
  assert.equal(task.ownerContactId, c.id);
  assert.equal(task.requesterId, "me");
  assert.deepEqual(task.recentProgress.map((p) => p.kind), ["started", "milestone", "completed"]);
  assert.deepEqual(texts(host, dm.id), [
    "user:帮我写一个 hello.txt",
    "contact:接了任务:写一个 hello.txt",
    "contact:好的,我安排 Compute 去写一个 hello.txt,有进度告诉你。",
    "contact:进度:已写好 hello.txt",
    "contact:做完了:完成:写一个 hello.txt",
  ]);
  const msgs = host.listMessages(dm.id, {}).messages;
  const card = msgs.at(-1)!.card!;
  assert.equal(card.kind, "delivery");
  assert.equal(card.state, "open");
  assert.equal(msgs[1]!.card?.kind, "task-status");
  assert.equal(msgs[1]!.replyToSeq, sent.seq);
  assert.equal(host.roomView(dm.id).pendingForUser, 2, "任务卡与交付卡都待用户处理");

  const commitments = host.listCommitments({ contactId: c.id });
  assert.deepEqual(commitments.map((k) => [k.text, k.status, k.taskId]), [["写一个 hello.txt", "active", task.id]]);

  const reply = host.cardAct({ roomId: dm.id, seq: msgs.at(-1)!.seq, cardId: card.cardId, actionId: "accept", clientActionId: "u2" });
  assert.equal(reply.text, "豁免审查并通过");
  assert.equal(reply.replyToSeq, msgs.at(-1)!.seq);
  const done = host.taskView(host.taskDoc(task.id).value);
  assert.equal(done.state, "T8_Accepted");
  assert.equal(done.reviewGate, "waived-by-user", "用户豁免如实记录,不记合规通过");
  assert.deepEqual(host.listCommitments({ contactId: c.id }).map((k) => k.status), ["done"]);
  assert.throws(() => host.cardAct({ roomId: dm.id, seq: msgs.at(-1)!.seq, cardId: card.cardId, actionId: "accept", clientActionId: "u3" }), /已经处理过/);
  await settle(host, compute);
  compute.close();
  await host.close();
});

test("群聊:消息机械送达每位成员联系人;被 @ 的接活,没被 @ 的也处理并推进游标;回执名单含联系人", async () => {
  const compute = scriptedCompute();
  const seen: Record<string, number[]> = {};
  const mind = () =>
    scriptedMind({
      onRound: (i: RoundInput) => {
        const list = seen[i.contact.id] ?? [];
        seen[i.contact.id] = list;
        list.push(...i.fresh.filter((f) => f.kind === "message").map((f) => (f as { seq: number }).seq));
      },
    });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "A" });
  const b = host.createContact({ name: "B" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const m1 = host.send({ roomId: g.id, clientActionId: "g1", text: "大家好" });
  const m2 = host.send({ roomId: g.id, clientActionId: "g2", text: "帮我跑一下测试", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  assert.ok(seen[b.id]?.includes(m1.seq) && seen[b.id]?.includes(m2.seq), "没被 @ 的 B 也收到了两条(唯一入口,不前置过滤)");
  assert.ok(seen[a.id]?.includes(m2.seq));
  const tasks = host.listTasks({ roomId: g.id });
  assert.deepEqual(tasks.map((t) => t.ownerContactId), [a.id], "只有被 @ 的 A 接活");
  const r = host.receipts(g.id, m2.seq);
  assert.deepEqual(r.read.map((x) => x.member.id).sort(), [a.id, b.id].sort(), "联系人接走即已读");
  assert.equal(r.read.find((x) => x.member.id === a.id)?.mentioned, true);
  assert.equal(r.read[0]?.member.id, a.id, "被 @ 的排前");
  assert.deepEqual(r.unread, []);
  compute.close();
  await host.close();
});

test("同一 clientActionId 重发只入库一次(入库端去重)", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const a = host.send({ roomId: dm.id, clientActionId: "same", text: "你好" });
  const b = host.send({ roomId: dm.id, clientActionId: "same", text: "你好" });
  assert.equal(a.seq, b.seq);
  await settle(host);
  assert.deepEqual(texts(host, dm.id), ["user:你好", "contact:收到:你好"]);
  await host.close();
});

test("发送前撤销竞态:联系人推理期间用户又发了消息,旧草稿不上屏,重跑时两条一起处理", async () => {
  const rounds: number[][] = [];
  let hostRef: Host | null = null;
  let dmId = "";
  let first = true;
  const mind = () => ({
    async round(input: RoundInput) {
      rounds.push(input.fresh.map((f) => (f as { seq: number }).seq));
      if (first) {
        first = false;
        hostRef!.send({ roomId: dmId, clientActionId: "late", text: "算了不用了" });
      }
      return { actions: [{ kind: "reply" as const, roomId: dmId, text: `看到 ${input.fresh.length} 条`, replyToSeq: null }], stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, maxDeferMs: 5 });
  hostRef = host;
  const c = host.createContact({ name: "小克" });
  dmId = host.openDm(c.id).id;
  host.send({ roomId: dmId, clientActionId: "e1", text: "帮我查一下天气" });
  await settle(host);
  assert.deepEqual(rounds, [[1], [1, 2]]);
  assert.deepEqual(texts(host, dmId), ["user:帮我查一下天气", "user:算了不用了", "contact:看到 2 条"]);
  await host.close();
});

test("模型提出的越界动作被拒收:来源不是本轮消息的派活、原文不出自来源的承诺、别人的任务", async () => {
  const reports: unknown[] = [];
  let dmId = "";
  const mind = () => ({
    async round() {
      return {
        actions: [
          { kind: "dispatch" as const, roomId: dmId, sourceSeq: 99, title: "x", task: "x" },
          { kind: "commit" as const, roomId: dmId, sourceSeq: 1, text: "原文里没有这句", taskId: null },
          { kind: "deliver" as const, taskId: "t-nope", text: "完成" },
          { kind: "reply" as const, roomId: "dm-别人", text: "串台", replyToSeq: null },
        ],
        stateNote: null,
      };
    },
  });
  const host = new Host({ file: file(), mind, maxDeferMs: 5, onReport: (w, d) => w === "action-rejected" && reports.push((d as { reason: string }).reason) });
  const c = host.createContact({ name: "小克" });
  dmId = host.openDm(c.id).id;
  host.send({ roomId: dmId, clientActionId: "x1", text: "随便聊聊" });
  await settle(host);
  assert.deepEqual(reports, [`来源 ${dmId} #99 不是本轮新消息`, "承诺原文必须出自来源消息", "不是你的任务", "不在这个会话里"]);
  assert.equal(host.listTasks({}).length, 0);
  assert.equal(host.listCommitments({}).length, 0);
  assert.deepEqual(texts(host, dmId), ["user:随便聊聊"]);
  await host.close();
});

test("Compute 起不来:任务进 T11 失败,联系人收到失败事件并如实告诉用户", async () => {
  const compute = scriptedCompute({ failSpawn: "claude 不在 PATH" });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "f1", text: "帮我编译项目" });
  await settle(host, compute);
  assert.equal(host.listTasks({})[0]?.state, "T11_Failed");
  assert.equal(texts(host, dm.id).at(-1), "contact:任务没做成:Compute 没起来:claude 不在 PATH");
  compute.close();
  await host.close();
});

test("用户点任务卡「取消任务」:Compute 被停止,任务落到 T10 已取消", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }], stepMs: 1 });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "s1", text: "帮我跑一个很久的任务" });
  await settle(host, compute);
  const taskMsg = host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "task-status")!;
  assert.equal(host.listTasks({})[0]?.state, "T3_Running");
  host.cardAct({ roomId: dm.id, seq: taskMsg.seq, cardId: taskMsg.card!.cardId, actionId: "cancel", clientActionId: "s2" });
  await settle(host, compute);
  assert.deepEqual(compute.stopped, ["cp-1"]);
  assert.equal(host.listTasks({})[0]?.state, "T10_Cancelled");
  compute.close();
  await host.close();
});

test("重启后会话记录、任务、游标都在,不重复处理旧消息", async () => {
  const f = file();
  const compute = scriptedCompute();
  let rounds = 0;
  const mk = () => new Host({ file: f, mind: () => ({
      round: async (i, s) => {
        rounds++;
        return scriptedMind().round(i, s);
      },
    }), compute: () => compute.adapter, maxDeferMs: 5 });
  const h1 = mk();
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id);
  h1.send({ roomId: dm.id, clientActionId: "p1", text: "帮我整理日志" });
  await settle(h1, compute);
  const before = texts(h1, dm.id);
  const taskState = h1.listTasks({})[0]?.state;
  await h1.close();
  const roundsBefore = rounds;
  const h2 = mk();
  assert.deepEqual(texts(h2, dm.id), before);
  assert.equal(h2.listTasks({})[0]?.state, taskState);
  h2.loop.notify(c.id, "now");
  await settle(h2);
  assert.equal(rounds, roundsBefore, "游标已持久化:没有新消息就不调模型");
  compute.close();
  await h2.close();
});

test("服务层:按合同校验参数与结果;未知方法、非法参数、未接入功能各自给出错误码", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const created = await svc.handle("contacts.create", { clientActionId: "k1", name: "小克" });
  assert.ok(created.ok);
  const cid = (created.value as { id: string }).id;
  const dm = await svc.handle("rooms.openDm", { contactId: cid });
  assert.ok(dm.ok);
  const roomId = (dm.value as { id: string }).id;
  const events: string[] = [];
  const off = svc.subscribe((e) => events.push(e.type));
  const s = await svc.handle("messages.send", { roomId, clientActionId: "m1", text: "你好" });
  assert.ok(s.ok);
  await settle(host);
  assert.ok(events.includes("message.appended") && events.includes("receipt.updated") && events.includes("contact.activity"));
  off();
  const list = await svc.handle("messages.list", { roomId });
  assert.ok(list.ok);
  assert.equal((list.value as { messages: unknown[] }).messages.length, 2);
  assert.deepEqual(await svc.handle("nope.nope", {}), { ok: false, error: { code: "unknown_method", message: "没有方法 nope.nope" } });
  const bad = await svc.handle("messages.send", { roomId, text: "缺动作号" });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, "invalid_params");
  const nf = await svc.handle("rooms.get", { roomId: "nope" });
  assert.equal(!nf.ok && nf.error.code, "not_found");
  const un = await svc.handle("schedules.list", {});
  assert.equal(!un.ok && un.error.code, "unavailable");
  const cmds = await svc.handle("commands.list", { roomId, prefix: "re" });
  assert.ok(cmds.ok);
  assert.deepEqual((cmds.value as { commands: { name: string }[] }).commands.map((c) => c.name), ["remind"]);
  await host.close();
});
