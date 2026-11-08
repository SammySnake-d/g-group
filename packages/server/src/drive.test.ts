// 群聊派活驱动(CLI `group` 与真实运行用)+ AC-03 发言者核对:群里 @ 联系人派活 → Compute 执行 → 联系人在群里转述进度与交付,
// Compute 从不出现在群消息的发言者里。用确定性替身跑,真实 pi + Claude Code 的一次运行原文见 proof/e2e-group-pi-claude.txt。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appendEvent } from "@g-group/adapter-sqlite";
import { ensureGroup, sendAndWait, senderAudit } from "./drive.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-drive-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `d${++fileNo}.db`);

test("群聊 @ 联系人派活:Compute 执行,联系人在群里转述进度与交付,群消息发言者只有用户与联系人(AC-03)", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const { room, contacts } = ensureGroup(host, "项目群", ["小克", "小研"]);
  assert.deepEqual(contacts.map((c) => c.name), ["小克", "小研"]);
  assert.equal(room.kind, "group");
  // 再来一次:同名群和同名联系人复用,不重复建
  const again = ensureGroup(host, "项目群", ["小克", "小研"]);
  assert.equal(again.room.id, room.id);
  assert.deepEqual(again.contacts.map((c) => c.id), contacts.map((c) => c.id));
  assert.equal(host.listContacts().length, 2);

  const run = await sendAndWait(host, room.id, "帮我写一个 group.txt", { mention: "小克", timeoutMs: 20000, settleMs: 20 });
  assert.equal(run.timedOut, false);
  assert.deepEqual(run.sent.mentions, [{ id: contacts[0]!.id, source: "manual" }], "被 @ 的是小克");
  const [task] = host.listTasks({ roomId: room.id });
  assert.ok(task);
  assert.equal(task.ownerContactId, contacts[0]!.id, "被 @ 的小克接活,没被 @ 的小研不接");
  assert.equal(task.roomId, room.id);
  assert.equal(task.sourceSeq, run.sent.seq);
  assert.deepEqual(task.recentProgress.map((p) => p.kind), ["started", "milestone", "completed"]);
  const msgs = host.listMessages(room.id, {}).messages;
  assert.deepEqual(
    msgs.map((m) => `${m.sender.kind}:${m.sender.id === contacts[0]!.id ? "小克" : m.sender.id}:${m.text}`),
    [
      "user:me:帮我写一个 group.txt",
      "contact:小克:接了任务:写一个 group.txt",
      "contact:小克:好的,我安排 Compute 去写一个 group.txt,有进度告诉你。",
      "contact:小克:进度:已写好 hello.txt",
      "contact:小克:做完了:完成:写一个 group.txt",
    ],
    "进度与结果都由联系人在群里转述,Compute 的事件不直接成为群消息",
  );
  assert.equal(msgs.at(-1)!.card, null, "交付是群里的一条普通消息,不挂验收卡(AC-56)");
  assert.deepEqual(msgs.at(-1)!.mentions, [{ id: "me", source: "auto" }], "交付 @ 提出者");
  assert.deepEqual(run.transcript.map((m) => m.seq), msgs.map((m) => m.seq), "驱动返回的记录就是群里的全部消息");
  const audit = senderAudit(host, room.id);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.offenders, []);
  assert.equal(audit.checked, 5);
  compute.close();
  await host.close();
});

test("发言者核对:群里混进非用户、非联系人发出的消息,或以 Compute 身份发言,判失败并列出", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const { room } = ensureGroup(host, "核对群", ["小克"]);
  await sendAndWait(host, room.id, "帮我写一个 a.txt", { mention: "小克", timeoutMs: 20000, settleMs: 20 });
  assert.equal(senderAudit(host, room.id).ok, true);
  const [task] = host.listTasks({ roomId: room.id });
  const computeId = task!.computeRuns[0]!.computeId;
  // 应失败的输入:直接往群日志写一条 helper 消息,再写一条冒用 Compute id 的「联系人」消息
  const helperSeq = appendEvent(host.db.store, `room:${room.id}`, { kind: "helper", id: "helper" }, { kind: "message", text: "NEUTRAL_FIXTURE 旁白" }, new Date().toISOString()).seq;
  const computeSeq = appendEvent(host.db.store, `room:${room.id}`, { kind: "contact", id: computeId }, { kind: "message", text: "NEUTRAL_FIXTURE Compute 直接发言" }, new Date().toISOString()).seq;
  const audit = senderAudit(host, room.id);
  assert.equal(audit.ok, false);
  assert.deepEqual(
    audit.offenders.map((o) => [o.seq, o.sender.kind, o.reason]),
    [
      [helperSeq, "helper", "发言者不是用户或联系人"],
      [computeSeq, "contact", "发言者是 Compute 实例"],
    ],
  );
  assert.equal(audit.checked, 7);
  compute.close();
  await host.close();
});

test("驱动等不到收尾就报超时,不把半截当完成", async () => {
  const compute = scriptedCompute({ stepMs: 400 });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const { room } = ensureGroup(host, "慢群", ["小克"]);
  const run = await sendAndWait(host, room.id, "帮我写一个 slow.txt", { mention: "小克", timeoutMs: 150, settleMs: 20 });
  assert.equal(run.timedOut, true);
  assert.ok(host.listTasks({ roomId: room.id }).some((t) => t.state === "T3_Running" || t.state === "T2_Claimed"), "超时时任务确实还在执行");
  await assert.rejects(sendAndWait(host, room.id, "帮我写一个 b.txt", { mention: "不存在的人", timeoutMs: 100 }), /群里没有联系人「不存在的人」/);
  compute.close();
  await host.close();
});
