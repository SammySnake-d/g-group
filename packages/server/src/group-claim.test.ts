// 群聊接活归属(AC-30 群里派活的真实运行暴露的缺口,proof/e2e-group-pi-claude-run1.txt):
// 用户 @ 了小克,没被 @ 的小研也建了任务、起了第二个 Compute。宿主按元数据机械判定(D15.1):
// ① 一条消息 @ 了别的联系人、没 @ 你,你提出接活被拒;② 同一条消息只能被一位联系人接,先落盘的拿到(U47 抢答);
// ③ 联系人每轮知道自己是谁(第 1 块写明名字与 id),否则它分不清 @ 的是不是自己。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-claim-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `c${++fileNo}.db`);

async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}

/** 什么都想接的脑子:看到用户消息就提出接活,不管 @ 的是谁。 */
const greedy = (seen?: RoundInput[]): ContactMind => ({
  async round(input) {
    seen?.push(input);
    const actions = input.fresh.flatMap((f) =>
      f.kind === "message" && f.sender.kind === "user" ? [{ kind: "dispatch" as const, roomId: f.roomId, sourceSeq: f.seq, title: "写文件", task: f.text }] : [],
    );
    return { actions, stateNote: null };
  },
});
const rejections = (host: Host) =>
  all<{ kind: string; error: string }>(host.db, "SELECT kind, error FROM gg_effects WHERE status = 'rejected' ORDER BY created_at, action_id").map((r) => ({ kind: r.kind, error: r.error }));

test("群里一条消息 @ 了别的联系人,没被 @ 的联系人提出接活被拒,只有被 @ 的人建任务", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => greedy(), compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const m = host.send({ roomId: g.id, clientActionId: "g1", text: "@小克 帮我写 group.txt", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const tasks = host.listTasks({ roomId: g.id });
  assert.deepEqual(tasks.map((t) => [t.ownerContactId, t.sourceSeq]), [[a.id, m.seq]]);
  assert.equal(compute.spawned.length, 1, "只起了一个 Compute");
  assert.deepEqual(rejections(host), [{ kind: "dispatch", error: `这条消息 @ 的是别的联系人,不是你(${g.id} #${m.seq})` }]);
  compute.close();
  await host.close();
});

test("同一条消息只能被一位联系人接:先落盘的拿到,后来的被拒,不起第二个 Compute", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => greedy(), compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const m = host.send({ roomId: g.id, clientActionId: "g1", text: "谁来写一下 notes.txt" });
  await settle(host, compute);
  const tasks = host.listTasks({ roomId: g.id });
  assert.equal(tasks.length, 1);
  assert.equal(compute.spawned.length, 1);
  const winner = tasks[0]!.ownerContactId;
  assert.ok(winner === a.id || winner === b.id);
  const loser = winner === a.id ? b : a;
  assert.deepEqual(rejections(host), [{ kind: "dispatch", error: `${g.id} #${m.seq} 已由联系人 ${winner} 接手(任务 ${tasks[0]!.id})` }]);
  assert.notEqual(loser.id, winner);
  // 私聊不受影响:同一位联系人在私聊里照常接活
  const dm = host.openDm(a.id);
  host.send({ roomId: dm.id, clientActionId: "d1", text: "帮我写 dm.txt" });
  await settle(host, compute);
  assert.equal(host.listTasks({ roomId: dm.id }).length, 1);
  compute.close();
  await host.close();
});

test("联系人每轮知道自己是谁:第 1 块写明名字与 id,并说明 @ 别人的活不归自己、交付不重复发", async () => {
  const seen: RoundInput[] = [];
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => greedy(seen), compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研", persona: "擅长查资料" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "g1", text: "大家好", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const forB = seen.find((s) => s.contact.id === b.id);
  assert.ok(forB, "小研也收到了这一轮");
  const prefix = forB.request.blocks.find((x) => x.block === 1)!.text;
  assert.ok(prefix.includes(`你是「小研」(联系人 id ${b.id})`), "第 1 块写明自己是谁");
  assert.ok(prefix.includes("擅长查资料"), "原有人设照旧在");
  assert.ok(prefix.includes("没 @ 你"), "说明 @ 别人的活不归自己");
  assert.ok(prefix.includes("不要再用 reply 重复"), "说明交付不重复发");
  const forA = seen.find((s) => s.contact.id === a.id)!;
  assert.ok(forA.request.blocks.find((x) => x.block === 1)!.text.includes(`你是「小克」(联系人 id ${a.id})`));
  compute.close();
  await host.close();
});

test("群里只 @ 一人:未被点名联系人可补充新信息,联系人回复仍唤醒旁观者纠正", async () => {
  const rounds: RoundInput[] = [];
  const mind = (): ContactMind => ({
    async round(input) {
      rounds.push(input);
      const user = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
      const peer = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "contact" && f.sender.id !== input.contact.id);
      if (input.contact.id === b.id && user?.kind === "message") {
        const actions: MindAction[] = [{ kind: "reply", roomId: user.roomId, text: "小克补充了新的回滚路径", replyToSeq: null }];
        if (peer?.kind === "message") actions.push({ kind: "reply", roomId: peer.roomId, text: "小克纠正", replyToSeq: peer.seq });
        return { actions, stateNote: null };
      }
      if (input.contact.id === b.id && peer?.kind === "message") {
        return { actions: [{ kind: "reply", roomId: peer.roomId, text: "小克纠正", replyToSeq: peer.seq }], stateNote: null };
      }
      return user?.kind === "message"
        ? { actions: [{ kind: "reply", roomId: user.roomId, text: `${input.contact.name}回答`, replyToSeq: null }], stateNote: null }
        : { actions: [], stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, maxDeferMs: 5 });
  const a = host.createContact({ name: "小林" });
  const b = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const user = host.send({ roomId: g.id, clientActionId: "reply-scope", text: "请回答 P0 问题", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, { drained: () => true });

  const messages = host.listMessages(g.id, {}).messages;
  assert.deepEqual(messages.filter((m) => m.sender.kind === "contact").map((m) => [m.sender.id, m.text]).sort(), [[a.id, "小林回答"], [b.id, "小克补充了新的回滚路径"], [b.id, "小克纠正"]].sort());
  assert.ok(rounds.some((r) => r.contact.id === b.id && r.fresh.some((f) => f.kind === "message" && f.seq === user.seq)), "未被点名者仍收到用户消息并进入注意回合");
  assert.ok(rounds.some((r) => r.contact.id === b.id && r.fresh.some((f) => f.kind === "message" && f.sender.kind === "contact" && f.text === "小林回答")), "联系人回复仍唤醒旁观者用于纠正");
  assert.deepEqual(rejections(host), [], "不能因未被点名而拒绝补充或纠错");
  const correction = messages.find((m) => m.text === "小克纠正")!;
  assert.deepEqual(host.loopGuard.rootsOf(g.id, correction.seq), [`message:${g.id}:${user.seq}`]);
  await host.close();
});

test("同批未点名群请求和点名别人的请求:联系人可引用并回复前者", async () => {
  let bId = "";
  let first = 0;
  let seen = false;
  const mind = (): ContactMind => ({
    async round(input) {
      const earlier = input.fresh.find((f) => f.kind === "message" && f.seq === first);
      const later = input.fresh.find((f) => f.kind === "message" && f.text === "只问小林");
      if (input.contact.id === bId && earlier?.kind === "message" && later) {
        seen = true;
        return { actions: [{ kind: "reply", roomId: earlier.roomId, text: "我的进度是已完成", replyToSeq: earlier.seq }], stateNote: null };
      }
      return { actions: [], stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, maxDeferMs: 50 });
  const a = host.createContact({ name: "小林" });
  const b = host.createContact({ name: "小克" });
  bId = b.id;
  const group = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  first = host.send({ roomId: group.id, clientActionId: "all", text: "大家汇报一下各自进度" }).seq;
  host.send({ roomId: group.id, clientActionId: "a", text: "只问小林", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, { drained: () => true });
  assert.equal(seen, true, "两条请求同批交给小克");
  const reply = host.listMessages(group.id, {}).messages.find((m) => m.sender.id === b.id && m.replyToSeq === first && m.text === "我的进度是已完成");
  assert.ok(reply, "后一条对小林的点名不能吞掉小克对前一条的回复");
  assert.deepEqual(host.loopGuard.rootsOf(group.id, reply.seq), [`message:${group.id}:${first}`]);
  await host.close();
});

test("同时收到别人被点名的消息和自己的 Compute 进度:不能吞掉进度汇报", async () => {
  let owner = "";
  let seen = false;
  const mind = (): ContactMind => ({ async round(input) {
    const progress = input.fresh.find((f) => f.kind === "compute" && f.signal === "milestone");
    const other = input.fresh.find((f) => f.kind === "message" && f.text === "只问小林");
    if (input.contact.id === owner && progress?.kind === "compute" && other) {
      seen = true;
      return { actions: [{ kind: "reply", roomId: progress.roomId, text: `进度:${progress.summary}`, replyToSeq: null }], stateNote: null };
    }
    return { actions: [], stateNote: null };
  } });
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 80 });
  try {
    const a = host.createContact({ name: "小林" });
    const b = host.createContact({ name: "小克" });
    owner = b.id;
    const group = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
    const task = host.createTask({ roomId: group.id, clientActionId: "task", title: "整理材料", ownerContactId: b.id });
    assert.deepEqual(host.loopGuard.taskRoots(task.id), [`message:${group.id}:${task.sourceSeq}`]);
    await settle(host, compute);
    assert.equal(compute.spawned.length, 1, "小克的 Compute 已启动");
    host.send({ roomId: group.id, clientActionId: "a", text: "只问小林", mentions: [{ id: a.id, source: "manual" }] });
    compute.emit({ kind: "milestone", computeId: compute.spawned[0]!.computeId, stage: "整理", summary: "材料已整理" });
    await new Promise((r) => setTimeout(r, 10));
    await settle(host, compute);
    assert.equal(seen, true, "进度与点名消息确实在同一轮");
    assert.ok(host.listMessages(group.id, {}).messages.some((m) => m.sender.id === b.id && m.text === "进度:材料已整理"), "这条进度不是代答,不能拒收");
  } finally {
    compute.close();
    await host.close();
  }
});
