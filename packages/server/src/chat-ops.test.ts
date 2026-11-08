// 会话操作:编辑/撤回(只追加,AC-05/AC-08)、表情不改已读(AC-46 ⑦)、附件、移出成员、删联系人、撤销承诺、任务显式验收入口(AC-28)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-ops-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `o${++n}.db`);
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}

test("编辑与撤回:追加事件,联系人下一轮收到「编辑了/撤回了 #x」;撤回原文不再出现在视图和联系人输入里", async () => {
  const inputs: string[][] = [];
  const host = new Host({ file: file(), mind: () => scriptedMind({ onRound: (i: RoundInput) => inputs.push(i.fresh.map((f) => (f.kind === "message" ? f.text : f.kind))) }), maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m = host.send({ roomId: dm.id, clientActionId: "a", text: "密码是 hunter2" });
  await settle(host);
  const e = host.editMessage(dm.id, m.seq, "密码是 ******");
  assert.equal(e.text, "密码是 ******");
  assert.equal(e.edited, true);
  await settle(host);
  const r = host.retractMessage(dm.id, m.seq);
  assert.deepEqual([r.text, r.retracted], ["", true]);
  await settle(host);
  assert.deepEqual(inputs, [["密码是 hunter2"], [`(编辑了 #${m.seq})密码是 ******`], [`(撤回了 #${m.seq})`]]);
  assert.throws(() => host.editMessage(dm.id, m.seq, "x"), /已撤回/);
  const contactMsg = host.listMessages(dm.id, {}).messages.find((x) => x.sender.kind === "contact")!;
  assert.throws(() => host.retractMessage(dm.id, contactMsg.seq), /只能改自己发的消息/);
  await host.close();
});

test("表情回应不改已读;重复点同一个表情只记一次,取消后移除", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m = host.send({ roomId: dm.id, clientActionId: "a", text: "你好" });
  await settle(host);
  const reply = host.listMessages(dm.id, {}).messages.at(-1)!;
  const before = host.roomView(dm.id).readSeq;
  host.react(dm.id, reply.seq, "👍", true);
  const v = host.react(dm.id, reply.seq, "👍", true);
  assert.deepEqual(v.reactions, [{ emoji: "👍", by: [{ kind: "user", id: "me" }] }]);
  assert.equal(host.roomView(dm.id).readSeq, before, "点表情不推进已读");
  assert.deepEqual(host.receipts(dm.id, m.seq).read.map((x) => x.member.id), [c.id]);
  assert.deepEqual(host.react(dm.id, reply.seq, "👍", false).reactions, []);
  await host.close();
});

test("附件:按内容去重存入数据目录,随消息发出;不存在的附件被拒", async () => {
  const host = new Host({ file: file(), dataDir: path.join(dir, "data-att"), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const f = path.join(dir, "note.md");
  writeFileSync(f, "# 笔记");
  const a1 = host.addAttachment(f);
  const a2 = host.addAttachment(f);
  assert.equal(a1.ref, a2.ref);
  assert.deepEqual([a1.name, a1.mime, a1.bytes], ["note.md", "text/markdown", 8]);
  const sent = await svc.handle("messages.send", { roomId: dm.id, clientActionId: "x", text: "看附件", attachments: [a1.ref] });
  assert.ok(sent.ok);
  assert.deepEqual((sent.value as { attachments: unknown[] }).attachments, [a1]);
  const bad = await svc.handle("messages.send", { roomId: dm.id, clientActionId: "y", text: "x", attachments: ["att-nope"] });
  assert.equal(!bad.ok && bad.error.code, "invalid_params");
  await settle(host);
  await host.close();
});

test("移出群成员后不再收到群消息;删联系人:有在途任务拒绝,完成后可删,从群里移除", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "A" });
  const b = host.createContact({ name: "B" });
  const g = host.createGroup("群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.removeMember(g.id, { kind: "contact", id: b.id });
  assert.deepEqual(host.roomView(g.id).members.map((m) => m.id).sort(), [a.id, "me"].sort());
  host.send({ roomId: g.id, clientActionId: "1", text: "帮我跑个脚本", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  assert.deepEqual(host.receipts(g.id, 1).read.map((x) => x.member.id), [a.id], "B 已不在名单里");
  assert.throws(() => host.removeContact(a.id), /还有 1 个在途任务/);
  const t = host.listTasks({})[0]!;
  host.taskDecision(t.id, "cancel", "c1");
  await settle(host, compute);
  host.removeContact(a.id);
  assert.deepEqual(host.listContacts().map((c) => c.id), [b.id]);
  assert.deepEqual(host.roomView(g.id).members.map((m) => m.id), ["me"]);
  compute.close();
  await host.close();
});

test("任务显式入口:tasks.accept 等同点交付卡;没有待确认交付时如实拒绝;用户撤销承诺", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "帮我写报告" });
  host.send({ roomId: dm.id, clientActionId: "2", text: "帮我订会议室" });
  await settle(host, compute);
  const t1 = host.listTasks({}).find((t) => t.title === "写报告");
  const t2 = host.listTasks({}).find((t) => t.title === "订会议室");
  const acc = await svc.handle("tasks.accept", { taskId: t1!.id, clientActionId: "3" });
  assert.ok(acc.ok, JSON.stringify(acc));
  assert.equal((acc.value as { state: string }).state, "T8_Accepted");
  const again = await svc.handle("tasks.accept", { taskId: t1!.id, clientActionId: "4" });
  assert.equal(!again.ok && again.error.code, "conflict");
  const k = host.listCommitments({ status: "active" }).find((x) => x.taskId === t2!.id);
  assert.ok(k, JSON.stringify(host.listCommitments({})));
  const rv = await svc.handle("commitments.revoke", { commitmentId: k!.id, clientActionId: "r1" });
  assert.ok(rv.ok, JSON.stringify(rv));
  assert.equal((rv.value as { status: string }).status, "revoked");
  await settle(host, compute);
  compute.close();
  await host.close();
});
