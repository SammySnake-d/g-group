// AC-56 交付是普通消息(U98/D28.5)+ AC-28 状态底座:联系人以普通消息 @ 提出者汇报结果,不挂专用验收卡;
// 用户用普通回复表达通过或修改,由联系人提交验收结论(verdict),宿主只认提出者本人在交付之后、本轮新到的直接消息;
// 沉默不算通过;退回时原 Compute 可恢复就恢复原实例,不可恢复才携交接新开。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-deliv-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `p${++fileNo}.db`);

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

/**
 * 测试用脑子:「帮我…」派活;Compute 完成就交付;用户(或群里有人)说「通过…」「改…」时,对 judge.taskId 提交验收结论。
 * judge 由测试设置(脑子每轮新建,状态放在闭包外)。echoPass:这位联系人看到用户说「看看」就在群里回「通过」(应失败的输入的来源)。
 */
const judge: { taskId: string | null } = { taskId: null };
const mindFor = (o: { echoPass?: boolean } = {}): ContactMind => ({
  async round(input) {
    const me = input.contact.id;
    const actions: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind === "message") {
        if (o.echoPass) {
          if (f.sender.kind === "user" && f.text.includes("看看")) actions.push({ kind: "reply", roomId: f.roomId, text: "通过", replyToSeq: null });
          continue;
        }
        const direct = f.roomId.startsWith("dm-") || f.mentions.includes(me) || f.text === "通过";
        if (!direct) continue;
        const m = /^帮我(.+)$/.exec(f.text.trim());
        if (m && f.sender.kind === "user") {
          actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: m[1]!, task: m[1]! });
          actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: m[1]!, taskId: null });
          continue;
        }
        if (judge.taskId && /^通过/.test(f.text)) actions.push({ kind: "verdict", taskId: judge.taskId, sourceSeq: f.seq, verdict: "accept", feedback: null });
        else if (judge.taskId && /^改/.test(f.text)) actions.push({ kind: "verdict", taskId: judge.taskId, sourceSeq: f.seq, verdict: "revise", feedback: f.text });
      }
      if (f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `做完了:${f.summary}` });
    }
    return { actions, stateNote: null };
  },
});
const rejected = (host: Host) =>
  all<{ kind: string; error: string }>(host.db, "SELECT kind, error FROM gg_effects WHERE status = 'rejected' ORDER BY created_at, action_id").map((r) => ({ kind: r.kind, error: r.error }));

test("交付是普通消息:联系人 @ 提出者汇报结果,不挂交付卡;沉默不算通过,一直待确认", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const ask = host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
  await settle(host, compute);
  const msgs = host.listMessages(dm.id, {}).messages;
  const last = msgs.at(-1)!;
  assert.equal(last.sender.kind, "contact");
  assert.equal(last.text, "做完了:完成:写报告");
  assert.equal(last.card, null, "交付不挂专用验收卡");
  assert.deepEqual(last.mentions, [{ id: "me", source: "auto" }], "交付 @ 提出者");
  assert.equal(last.replyToSeq, ask.seq);
  assert.deepEqual(msgs.filter((m) => m.card?.kind === "delivery"), [], "整段对话里没有交付卡");
  const [t] = host.listTasks({ roomId: dm.id });
  assert.equal(t!.state, "T8a_Delivered", "已交付、待确认(没有跨厂商审查人,不审,由提出者决定)");
  assert.equal(host.roomView(dm.id).pendingForUser, 2, "任务卡 + 一件等你回复的交付");
  // 沉默:再等几轮也不自动通过、不归档
  await new Promise((r) => setTimeout(r, 60));
  await settle(host, compute);
  assert.equal(host.taskView(host.taskDoc(t!.id).value).state, "T8a_Delivered");
  assert.equal(host.listMessages(dm.id, {}).messages.length, msgs.length, "沉默期间没有新消息");
  compute.close();
  await host.close();
});

test("用户普通回复「通过」:联系人提交验收结论 → T8 已验收(记用户豁免)、承诺了结、任务卡收口", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  judge.taskId = t!.id;
  const before = host.listMessages(dm.id, {}).messages.length;
  host.send({ roomId: dm.id, clientActionId: "u2", text: "通过,辛苦了" });
  await settle(host, compute);
  const done = host.taskView(host.taskDoc(t!.id).value);
  assert.equal(done.state, "T8_Accepted");
  assert.equal(done.reviewGate, "waived-by-user", "提出者本人豁免审查,如实记录");
  assert.deepEqual(host.listCommitments({ contactId: c.id }).map((k) => [k.text, k.status]), [["写报告", "done"]]);
  assert.equal(host.listMessages(dm.id, {}).messages.length, before + 1, "只多了用户那条普通回复,没有额外卡片或按钮消息");
  assert.equal(host.roomView(dm.id).pendingForUser, 0, "任务卡已收口,没有待你处理的事");
  assert.deepEqual(rejected(host), []);
  compute.close();
  await host.close();
});

test("用户回复修改意见:原 Compute 可恢复就恢复原实例并带上意见,不新开", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  judge.taskId = t!.id;
  host.send({ roomId: dm.id, clientActionId: "u2", text: "改一下:标题加粗" });
  await settle(host, compute);
  assert.deepEqual(compute.resumed, [{ computeId: "cp-1", text: "用户退回:改一下:标题加粗" }]);
  assert.equal(compute.spawned.length, 1, "没有新开 Compute");
  const v = host.taskView(host.taskDoc(t!.id).value);
  assert.equal(v.state, "T3_Running");
  assert.equal(v.constraintVersion, 1, "退回升了条件版本");
  compute.close();
  await host.close();
});

test("原 Compute 已停、不可恢复:退回时携交接新开一个 Compute,交接里有原要求、上次结果和修改意见", async () => {
  judge.taskId = null;
  const compute = scriptedCompute({
    script: (_id, brief) => [
      { kind: "started", sessionId: "s", resumed: false },
      { kind: "completed", result: `完成:${(brief as { task: string }).task.split("\n")[0]}` },
      { kind: "stopped", code: 0, signal: null, scope: "main-then-group", violations: [] },
    ],
  });
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  judge.taskId = t!.id;
  host.send({ roomId: dm.id, clientActionId: "u2", text: "改成英文" });
  await settle(host, compute);
  assert.deepEqual(compute.resumed, [], "实例已停,不去恢复");
  assert.equal(compute.spawned.length, 2);
  const brief = (compute.spawned[1]!.brief as { task: string }).task;
  assert.equal(brief, "写报告\n\n【交接】上一个 Compute 已结束,这是返工。\n上次结果:完成:写报告\n用户退回意见:改成英文");
  const v = host.taskView(host.taskDoc(t!.id).value);
  assert.deepEqual(v.computeRuns.map((r) => r.computeId), ["cp-1", "cp-2"]);
  compute.close();
  await host.close();
});

test("验收结论只认提出者本人的直接消息:别的联系人说「通过」、替不是自己的任务下结论、任务还没交付,都被拒且状态不变", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: (c) => mindFor({ echoPass: c.name === "小研" }), compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "g1", text: "帮我写报告", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: g.id });
  assert.equal(t!.state, "T8a_Delivered");
  // 用户说「大家看看」,小研回「通过」;小克若据此提交结论,宿主拒绝(不是提出者本人的消息)
  judge.taskId = t!.id;
  host.send({ roomId: g.id, clientActionId: "g2", text: "大家看看" });
  await settle(host, compute);
  const passMsg = host.listMessages(g.id, {}).messages.find((m) => m.sender.id === b.id && m.text === "通过");
  assert.ok(passMsg, "小研确实在群里说了通过");
  assert.equal(host.taskView(host.taskDoc(t!.id).value).state, "T8a_Delivered", "别的联系人说通过不算");
  assert.deepEqual(rejected(host), [{ kind: "verdict", error: `验收结论的来源 ${g.id} #${passMsg.seq} 不是提出者本人的消息` }]);
  // 替不存在/不是自己的任务下结论
  judge.taskId = "t-none";
  host.send({ roomId: g.id, clientActionId: "g3", text: "再看看" });
  await settle(host, compute);
  assert.deepEqual(rejected(host).at(-1), { kind: "verdict", error: "任务 t-none 不存在或不是你的" });
  assert.equal(host.taskView(host.taskDoc(t!.id).value).state, "T8a_Delivered");
  // 还没交付(在跑)时用户说「通过」:结论被拒;交付之后这条旧「通过」也不会自动生效
  judge.taskId = null;
  const slow = scriptedCompute({ stepMs: 300 });
  const host2 = new Host({ file: file(), mind: () => mindFor(), compute: () => slow.adapter, maxDeferMs: 5 });
  const c2 = host2.createContact({ name: "小克" });
  const dm2 = host2.openDm(c2.id);
  host2.send({ roomId: dm2.id, clientActionId: "x1", text: "帮我写报告" });
  for (let i = 0; i < 200 && !host2.listTasks({ roomId: dm2.id }).some((x) => x.state === "T3_Running"); i++) await new Promise((r) => setTimeout(r, 5));
  const [t2] = host2.listTasks({ roomId: dm2.id });
  judge.taskId = t2!.id;
  host2.send({ roomId: dm2.id, clientActionId: "x2", text: "通过" });
  for (let i = 0; i < 200 && !rejected(host2).length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rejected(host2), [{ kind: "verdict", error: "任务在 T3_Running,没有等你确认的交付" }]);
  judge.taskId = null;
  await settle(host2, slow);
  assert.equal(host2.taskView(host2.taskDoc(t2!.id).value).state, "T8a_Delivered");
  compute.close();
  slow.close();
  await host.close();
  await host2.close();
});

test("显式入口 tasks.accept / tasks.reject 不需要交付卡:记一条用户回复并按通过/退回推进", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  const delivered = host.listMessages(dm.id, {}).messages.at(-1)!;
  assert.equal(delivered.card, null, "交付消息上没有卡片可点");
  const rj = await svc.handle("tasks.reject", { taskId: t!.id, clientActionId: "r1", feedback: "再短一点" });
  assert.ok(rj.ok, JSON.stringify(rj));
  assert.equal((rj.value as { state: string }).state, "T3_Running");
  const note = host.listMessages(dm.id, {}).messages.find((m) => m.clientActionId === "r1")!;
  assert.equal(note.text, "退回:再短一点");
  assert.equal(note.sender.kind, "user");
  assert.equal(note.replyToSeq, delivered.seq, "回复的是那条交付消息");
  await settle(host, compute);
  assert.deepEqual(compute.resumed, [{ computeId: "cp-1", text: "用户退回:再短一点" }]);
  compute.close();
  await host.close();
});
