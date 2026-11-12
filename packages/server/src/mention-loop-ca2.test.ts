// 新叠加分支的接缝：CA2 拒绝/逐个@/@everyone 与持久因果根同时保留；scripted mind 不代表真实模型验收。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-loop-ca2-seam-"));
const hosts: Host[] = [];
let next = 0;
const file = () => path.join(dir, `case-${++next}.db`);
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
after(() => rmSync(dir, { recursive: true, force: true }));
async function settle(host: Host) {
  for (let n = 0; n < 300; n++) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 10))]);
    if (!host.loop.busy()) return;
  }
  assert.fail("CA2 接缝没有在有限窗口内安静下来");
}
const roots = (roomId: string, seq: number) => [`message:${roomId}:${seq}`];

test("CA2接缝01：@everyone与逐个@去重保留，同根派生仍有限停止", async () => {
  let calls = 0;
  const mind = (): ContactMind => ({ async round(input) {
    const last = input.fresh.filter((f) => f.kind === "message" && f.sender.kind !== "system").at(-1);
    const actions: MindAction[] = [];
    if (last?.kind === "message" && ++calls <= 20) {
      const other = input.contact.id === a.id ? b.id : a.id;
      actions.push({ kind: "reply", roomId: last.roomId, text: `接缝讨论 ${calls}`, replyToSeq: null, mentions: [other], everyone: true });
    }
    return { actions, stateNote: null };
  } });
  const host = new Host({ file: file(), mind, maxDeferMs: 2, loopGuard: { maxHops: 4 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); const b = host.createContact({ name: "乙" });
  const group = host.createGroup("接缝群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: group.id, clientActionId: "seam-01", text: "开始接缝讨论" });
  await settle(host);
  const messages = host.listMessages(group.id, {}).messages;
  const user = messages.find((m) => m.text === "开始接缝讨论")!;
  const replies = messages.filter((m) => m.sender.kind === "contact");
  assert.ok(replies.length >= 2 && replies.length <= 6, `@everyone不能重置因果额度，实际${replies.length}`);
  for (const reply of replies) {
    const other = reply.sender.id === a.id ? b.id : a.id;
    assert.deepEqual(reply.mentions.map((m) => m.id).sort(), [host.userId, other].sort());
    assert.deepEqual(host.loopGuard.rootsOf(group.id, reply.seq), roots(group.id, user.seq));
  }
  assert.equal(messages.filter((m) => m.sender.kind === "system").length, 1);
});

test("CA2接缝02：同轮被拒动作的完成声明仍不发送，也不产生自动唤醒额度", async () => {
  const attempted: MindAction = { kind: "claim", taskId: "t-seam-refused" };
  const mind = (): ContactMind => ({ async round(input) {
    const request = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "声明校验");
    return {
      actions: request?.kind === "message" ? [{ kind: "reply", roomId: request.roomId, text: "我已经认领 t-seam-refused 并完成", replyToSeq: null, everyone: true }] : [],
      stateNote: null,
      inRoundRefusals: [{ action: attempted, reason: "该任务不允许认领" }],
    };
  } });
  const host = new Host({ file: file(), mind, maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); const b = host.createContact({ name: "乙" });
  const group = host.createGroup("接缝群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: group.id, clientActionId: "seam-02", text: "声明校验" });
  await settle(host);
  assert.equal(host.listMessages(group.id, {}).messages.some((m) => m.sender.kind === "contact"), false);
  const rejected = all<{ error: string }>(host.db, "SELECT error FROM gg_effects WHERE status='rejected'");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => r.error.includes("宣称它已完成")));
  assert.equal(all(host.db, "SELECT * FROM gg_loop_wakes").length, 0);
});

test("CA2接缝03：@everyone不掩盖非法逐个@，拒绝仍在消息与因果提交之前", async () => {
  const mind = (): ContactMind => ({ async round(input) {
    const request = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "非法点名");
    return { actions: request?.kind === "message" ? [{ kind: "reply", roomId: request.roomId, text: "叫外人进来", replyToSeq: null, mentions: [outside.id], everyone: true }] : [], stateNote: null };
  } });
  const host = new Host({ file: file(), mind, maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); const outside = host.createContact({ name: "外人" });
  const group = host.createGroup("接缝群", [{ kind: "contact", id: a.id }]);
  host.send({ roomId: group.id, clientActionId: "seam-03", text: "非法点名" });
  await settle(host);
  assert.equal(host.listMessages(group.id, {}).messages.some((m) => m.text === "叫外人进来"), false);
  const rejected = all<{ error: string }>(host.db, "SELECT error FROM gg_effects WHERE status='rejected'");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.error, /不是会话.*的成员/);
  assert.equal(all(host.db, "SELECT * FROM gg_loop_wakes").length, 0);
});

test("CA2接缝04：新增claim卡继承触发本轮的用户根，而不是另起卡片根", async () => {
  const compute = scriptedCompute();
  let taskId = "";
  const mind = (): ContactMind => ({ async round(input) {
    const requested = input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "现在认领");
    return { actions: requested ? [{ kind: "claim", taskId }] : [], stateNote: null };
  } });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(host);
  try {
    const a = host.createContact({ name: "甲" });
    const group = host.createGroup("接缝群", [{ kind: "contact", id: a.id }]);
    const task = host.createTask({ roomId: group.id, clientActionId: "seam-task", title: "接缝任务" });
    taskId = task.id;
    await settle(host);
    host.send({ roomId: group.id, clientActionId: "seam-04", text: "现在认领" });
    await settle(host);
    const messages = host.listMessages(group.id, {}).messages;
    const user = messages.find((m) => m.text === "现在认领")!;
    const card = messages.find((m) => m.text === "认领了任务:接缝任务");
    assert.ok(card);
    assert.equal(host.taskViewById(task.id).ownerContactId, a.id);
    assert.deepEqual(host.loopGuard.rootsOf(group.id, card.seq), roots(group.id, user.seq));
    assert.notEqual(user.seq, task.sourceSeq);
  } finally { compute.close(); }
});

test("CA2接缝05：同一轮真实装配同时保留被拒回告、可认领任务和禁言事实", async () => {
  let fifth = "";
  const mind = (): ContactMind => ({ async round(input) {
    const seed = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "先留下回告");
    const check = input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "三样一起装配");
    if (check) fifth = input.request.blocks.find((b) => b.block === 5)!.text;
    return { actions: seed?.kind === "message" ? [{ kind: "claim", taskId: "t-seam-not-found" }] : [], stateNote: null };
  } });
  const host = new Host({ file: file(), mind, maxDeferMs: 2, loopGuard: { maxHops: 2 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" });
  const group = host.createGroup("三样并集群", [{ kind: "contact", id: a.id }]);
  const task = host.createTask({ roomId: group.id, clientActionId: "seam-open-task", title: "待认领任务" });
  await settle(host);
  host.send({ roomId: group.id, clientActionId: "seam-rejection-seed", text: "先留下回告" });
  await settle(host);
  host.muteMember({ roomId: group.id, contactId: a.id, muted: true, clientActionId: "seam-mute" });
  host.send({ roomId: group.id, clientActionId: "seam-05", text: "三样一起装配" });
  await settle(host);
  assert.ok(fifth.includes("claim_task(taskId=t-seam-not-found) → 被拒:没有任务 t-seam-not-found"), "同一轮有 CA2 拒绝回告");
  assert.ok(fifth.includes(`可认领的任务 ${task.id}`), "同一轮有 CA2 可认领任务");
  assert.ok(fifth.includes(`禁言 ${group.id}`) && fifth.includes("三样并集群"), "同一轮有 #71 禁言事实");
});
