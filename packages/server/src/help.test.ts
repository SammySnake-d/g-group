// AC-44(C-US15)与 T4b 求助闭环:Compute 执行中卡在人工验证码 → 任务进 T4b(q_id),宿主不重试不重派;
// 联系人在会话里 @提出者并附截图发提问卡,Compute 不直接发言;用户经 tasks.answer / 卡片 / 聊天里回答
// → 校验 (task_id, q_id, constraint_ver) 后回 T3 并把回答续接给同一 Compute;用户拒绝 → 取消并停 Compute;
// 已取消或已换卡后的迟到回答幂等忽略,卡标「已过期·未执行」,不送进 Compute。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { HUMAN_VERIFICATION_RULE, Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-help-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `h${++fileNo}.db`);
/** 每个任务一个工作目录,里面放一张中性内容的「截图」。 */
const cwdOf = (taskId: string) => {
  const d = path.join(dir, "work", taskId);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "captcha.png"), "NEUTRAL_FIXTURE_NO_CREDENTIALS");
  return d;
};

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

const BLOCKED = { kind: "blocked", needs: "请把登录页的图形验证码告诉我", summary: "登录页出现图形验证码,截图在 captcha.png", attachments: ["captcha.png"] } as const;
/** 起一个会受阻的任务:started → blocked(带截图);resume 时可选再吐一批事件。 */
/** H 是被测的宿主类(显式传入,测试断言的都是它的结果)。 */
async function blockedTask(H: typeof Host, opts: { onResume?: (computeId: string, text: string) => object[]; mind?: () => ContactMind } = {}) {
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { ...BLOCKED }] as never,
    ...(opts.onResume ? { onResume: opts.onResume as never } : {}),
  });
  const host = new H({ file: file(), mind: opts.mind ?? (() => scriptedMind()), compute: () => compute.adapter, computeCwd: cwdOf, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我登录后台导出订单" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.ok(task, "派出了任务");
  return { compute, host, svc, contact: c, dm, task };
}
const questionMsgs = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.filter((m) => m.card?.kind === "question");

test("AC-44 ① Compute 报受阻 → 任务进 T4b(q_id),宿主不重试、不重派、不自己续接", async () => {
  const { compute, host, task } = await blockedTask(Host);
  const t = host.taskView(host.taskDoc(task.id).value);
  assert.equal(t.state, "T4b_BlockedOnHuman");
  assert.ok(t.pendingQuestion, "有待回答的问题");
  assert.match(t.pendingQuestion.qId, /\S/);
  assert.equal(t.pendingQuestion.text, BLOCKED.needs, "问题原文就是 Compute 报的 needs");
  assert.equal(compute.spawned.length, 1, "不重派");
  assert.deepEqual(compute.resumed, [], "没有用户回答之前不续接 Compute");
  assert.deepEqual(compute.stopped, [], "受阻不是失败,不停 Compute");
  compute.close();
  await host.close();
});

test("AC-44 ② 联系人在会话里 @提出者并附截图发提问卡;Compute 不直接发言", async () => {
  const { compute, host, dm, contact, task } = await blockedTask(Host);
  const qs = questionMsgs(host, dm.id);
  assert.equal(qs.length, 1, "只发一张提问卡");
  const q = qs[0]!;
  assert.deepEqual(q.sender, { kind: "contact", id: contact.id }, "由负责的联系人发出");
  assert.ok(q.mentions.some((m) => m.id === "me"), "@ 了提出者");
  assert.match(q.text, /验证码/);
  assert.equal(q.card!.taskId, task.id);
  assert.equal(q.card!.state, "open");
  assert.deepEqual(q.card!.actions.map((a) => a.actionId), ["answer", "reject"]);
  assert.deepEqual(q.attachments.map((a) => [a.name, a.mime]), [["captcha.png", "image/png"]], "截图作为附件随提问卡发出");
  const kinds = new Set(host.listMessages(dm.id, {}).messages.map((m) => m.sender.kind));
  assert.deepEqual([...kinds].sort(), ["contact", "user"], "会话里只有用户和联系人说话,Compute 不直接发言");
  compute.close();
  await host.close();
});

test("AC-44 ③ tasks.answer 校验 (task_id, q_id, constraint_ver) 后回 T3,回答续接给同一个 Compute", async () => {
  const { compute, host, svc, dm, task } = await blockedTask(Host);
  const before = host.taskView(host.taskDoc(task.id).value);
  const qId = before.pendingQuestion!.qId;
  const r = await svc.handle("tasks.answer", { taskId: task.id, qId, clientActionId: "a1", answer: "7Q2K" });
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  assert.equal((r.value as { state: string }).state, "T3_Running");
  await settle(host, compute);
  const cid = before.computeRuns[0]!.computeId;
  assert.equal(compute.resumed.length, 1, "续接一次");
  assert.equal(compute.resumed[0]!.computeId, cid, "续接的是原来那个 Compute,不新开");
  assert.match(compute.resumed[0]!.text, /7Q2K/);
  assert.equal(compute.spawned.length, 1);
  const after_ = host.taskView(host.taskDoc(task.id).value);
  assert.equal(after_.pendingQuestion, null);
  assert.equal(questionMsgs(host, dm.id)[0]!.card!.state, "done", "提问卡已处理");
  const again = await svc.handle("tasks.answer", { taskId: task.id, qId, clientActionId: "a1", answer: "7Q2K" });
  assert.ok(again.ok, "同一回答重发幂等");
  assert.equal(compute.resumed.length, 1, "重发不再续接第二次");
  compute.close();
  await host.close();
});

test("AC-44 ④ 用户在提问卡上选「不做了」→ 任务取消,Compute 被停止并释放", async () => {
  const { compute, host, dm, task } = await blockedTask(Host);
  const q = questionMsgs(host, dm.id)[0]!;
  host.cardAct({ roomId: dm.id, seq: q.seq, cardId: q.card!.cardId, actionId: "reject", clientActionId: "r1" });
  await settle(host, compute);
  const t = host.taskView(host.taskDoc(task.id).value);
  assert.equal(t.state, "T10_Cancelled");
  assert.deepEqual(compute.stopped, [t.computeRuns[0]!.computeId]);
  assert.deepEqual(compute.resumed, [], "拒绝不把任何东西送进 Compute");
  compute.close();
  await host.close();
});

test("AC-44 ⑤ 任务取消后的迟到回答幂等忽略:不送进 Compute,提问卡标「已过期·未执行」", async () => {
  const { compute, host, svc, dm, task } = await blockedTask(Host);
  const qId = host.taskView(host.taskDoc(task.id).value).pendingQuestion!.qId;
  const c = await svc.handle("tasks.cancel", { taskId: task.id, clientActionId: "c1" });
  assert.ok(c.ok, c.ok ? "" : c.error.message);
  await settle(host, compute);
  assert.equal(host.taskView(host.taskDoc(task.id).value).state, "T10_Cancelled");
  const q = questionMsgs(host, dm.id)[0]!;
  assert.equal(q.card!.state, "expired", "任务离开 T4b,提问卡过期");
  assert.match(q.card!.body, /已过期·未执行/);
  const late = await svc.handle("tasks.answer", { taskId: task.id, qId, clientActionId: "a9", answer: "7Q2K" });
  assert.ok(late.ok, "迟到回答不报错,幂等忽略");
  assert.equal((late.value as { state: string }).state, "T10_Cancelled");
  const card = await svc.handle("cards.act", { roomId: dm.id, seq: q.seq, cardId: q.card!.cardId, actionId: "answer", clientActionId: "a10", text: "7Q2K" });
  assert.ok(card.ok, "在过期卡上点回答也幂等忽略");
  assert.deepEqual(compute.resumed, [], "迟到的验证码没有送进 Compute");
  assert.equal(questionMsgs(host, dm.id).length, 1);
  assert.ok(!host.listMessages(dm.id, {}).messages.some((m) => m.sender.kind === "user" && /7Q2K/.test(m.text)), "过期卡上的点击不记成对话消息");
  compute.close();
  await host.close();
});

test("AC-44 ⑤ 换了新问题后,旧问题上的回答幂等忽略,只有当前 q_id 生效", async () => {
  let n = 0;
  const { compute, host, svc, dm, task } = await blockedTask(Host, {
    onResume: () => (++n === 1 ? [{ kind: "blocked", needs: "验证码过期了,请再给一次新的", summary: "刷新后出现新的验证码" }] : []),
  });
  const q1 = host.taskView(host.taskDoc(task.id).value).pendingQuestion!.qId;
  assert.ok((await svc.handle("tasks.answer", { taskId: task.id, qId: q1, clientActionId: "a1", answer: "AAAA" })).ok);
  await settle(host, compute);
  const t2 = host.taskView(host.taskDoc(task.id).value);
  assert.equal(t2.state, "T4b_BlockedOnHuman", "Compute 又受阻,出第二个问题");
  const q2 = t2.pendingQuestion!.qId;
  assert.notEqual(q2, q1, "新问题有新的 q_id");
  const stale = await svc.handle("tasks.answer", { taskId: task.id, qId: q1, clientActionId: "a2", answer: "BBBB" });
  assert.ok(stale.ok);
  assert.equal(compute.resumed.length, 1, "旧问题上的回答不续接");
  assert.equal(host.taskView(host.taskDoc(task.id).value).pendingQuestion!.qId, q2, "当前问题不受影响");
  assert.ok((await svc.handle("tasks.answer", { taskId: task.id, qId: q2, clientActionId: "a3", answer: "CCCC" })).ok);
  await settle(host, compute);
  assert.deepEqual(compute.resumed.map((r) => /CCCC/.test(r.text) || /AAAA/.test(r.text)), [true, true]);
  assert.equal(questionMsgs(host, dm.id).length, 2);
  assert.equal(host.taskView(host.taskDoc(task.id).value).state, "T3_Running");
  compute.close();
  await host.close();
});

test("tasks.answer:不存在的问题号 not_found;回答为空被合同拒绝", async () => {
  const { compute, host, svc, task } = await blockedTask(Host);
  const nf = await svc.handle("tasks.answer", { taskId: task.id, qId: "q-nope", clientActionId: "x1", answer: "1" });
  assert.equal(!nf.ok && nf.error.code, "not_found");
  const empty = await svc.handle("tasks.answer", { taskId: task.id, qId: "q-nope", clientActionId: "x2", answer: "" });
  assert.equal(!empty.ok && empty.error.code, "invalid_params");
  const nt = await svc.handle("tasks.answer", { taskId: "t-nope", qId: "q", clientActionId: "x3", answer: "1" });
  assert.equal(!nt.ok && nt.error.code, "not_found");
  compute.close();
  await host.close();
});

/** 联系人脑子:Compute 受阻时记下任务号;之后用户在聊天里说的话原样 forward 给 Compute。fabricate=true 时它在受阻当轮就自己编一个回答转过去。 */
function relayMind(fabricate = false): () => ContactMind {
  const base = scriptedMind();
  let blockedTask: string | null = null;
  return () => ({
    async round(input, signal) {
      const out = await base.round(input, signal);
      const actions: MindAction[] = [...out.actions];
      for (const f of input.fresh) {
        if (f.kind === "compute" && f.signal === "blocked") {
          blockedTask = f.taskId;
          if (fabricate) actions.push({ kind: "forward", taskId: f.taskId, text: "我猜验证码是 0000" });
        }
        if (f.kind === "message" && f.sender.kind === "user" && blockedTask) {
          actions.splice(0, actions.length, { kind: "forward", taskId: blockedTask, text: f.text });
          blockedTask = null;
        }
      }
      return { actions, stateNote: out.stateNote };
    },
  });
}

test("AC-44 ③ 用户在聊天里直接回答,联系人 forward 转达 → 同样回 T3 并续接,提问卡标为已处理", async () => {
  const { compute, host, dm, task } = await blockedTask(Host, { mind: relayMind() });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "验证码是 9F3D" });
  await settle(host, compute);
  const t = host.taskView(host.taskDoc(task.id).value);
  assert.equal(t.state, "T3_Running");
  assert.equal(compute.resumed.length, 1);
  assert.match(compute.resumed[0]!.text, /9F3D/);
  assert.equal(questionMsgs(host, dm.id)[0]!.card!.state, "done");
  compute.close();
  await host.close();
});

test("AC-44 ③ 用户在提问卡上回答后,联系人又把那条回答 forward → 宿主拒收,回答只送进 Compute 一次", async () => {
  const rejected: unknown[] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { ...BLOCKED }] as never });
  const host = new Host({ file: file(), mind: relayMind(), compute: () => compute.adapter, computeCwd: cwdOf, maxDeferMs: 5, onReport: (w, d) => w === "action-rejected" && rejected.push(d) });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我登录后台导出订单" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  const qId = host.taskView(host.taskDoc(task!.id).value).pendingQuestion!.qId;
  assert.ok((await svc.handle("tasks.answer", { taskId: task!.id, qId, clientActionId: "a1", answer: "7Q2K" })).ok);
  await settle(host, compute);
  assert.equal(compute.resumed.length, 1, "卡片上的回答只续接一次,联系人的重复转发没有再送进去");
  assert.ok(rejected.some((r) => (r as { action: { kind: string } }).action.kind === "forward"), "重复的 forward 被拒收并记录");
  assert.equal(host.taskView(host.taskDoc(task!.id).value).state, "T3_Running");
  compute.close();
  await host.close();
});

test("AC-44 ① 联系人没等用户回答、自己编了答案 forward → 宿主拒收,任务仍停在 T4b,不送进 Compute", async () => {
  const rejected: unknown[] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { ...BLOCKED }] as never });
  const host = new Host({ file: file(), mind: relayMind(true), compute: () => compute.adapter, computeCwd: cwdOf, maxDeferMs: 5, onReport: (w, d) => w === "action-rejected" && rejected.push(d) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我登录后台导出订单" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.equal(task!.state, "T4b_BlockedOnHuman");
  assert.deepEqual(compute.resumed, [], "编出来的答案没有送进 Compute");
  assert.ok(rejected.some((r) => (r as { action: { kind: string } }).action.kind === "forward"), "forward 被拒收并记录");
  compute.close();
  await host.close();
});

test("AC-44 ① 派给 Compute 的说明带人工验证规则:不反复尝试、不猜、不用打码服务,截图后报 blocked 停下", async () => {
  const { compute, host } = await blockedTask(Host);
  const rules = (compute.spawned[0]!.brief as { rules: string[] }).rules;
  assert.deepEqual(rules, [HUMAN_VERIFICATION_RULE]);
  assert.match(HUMAN_VERIFICATION_RULE, /验证码/);
  assert.match(HUMAN_VERIFICATION_RULE, /不要反复尝试/);
  assert.match(HUMAN_VERIFICATION_RULE, /打码/);
  assert.match(HUMAN_VERIFICATION_RULE, /blocked/);
  assert.match(HUMAN_VERIFICATION_RULE, /attachments/);
  compute.close();
  await host.close();
});

test("受阻截图只收工作目录里的图片:目录外路径与非图片被丢弃,提问卡照发", async () => {
  const outside = path.join(dir, "outside-marker.png");
  writeFileSync(outside, "NEUTRAL_FIXTURE_NO_CREDENTIALS");
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "请给验证码", summary: "见截图", attachments: ["../../outside-marker.png", "notes.txt", "captcha.png"] }] as never,
  });
  const host = new Host({
    file: file(),
    mind: () => scriptedMind(),
    compute: () => compute.adapter,
    computeCwd: (t) => {
      const d = cwdOf(t);
      writeFileSync(path.join(d, "notes.txt"), "NEUTRAL_FIXTURE_NO_CREDENTIALS");
      return d;
    },
    maxDeferMs: 5,
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我登录后台导出订单" });
  await settle(host, compute);
  const q = questionMsgs(host, dm.id)[0]!;
  assert.deepEqual(q.attachments.map((a) => a.name), ["captcha.png"], "只带工作目录里的图片");
  compute.close();
  await host.close();
});
