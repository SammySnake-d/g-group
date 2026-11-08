// AC-26(写审分离 + 跨研发厂商独立审查硬门禁)与 AC-28/AC-56(交付是普通消息、待确认)在宿主里的闭环:
// 交付后宿主挑一位跨厂商审查联系人,用它的 Compute 模型起只读审查 Compute;审过 → T7 → 负责联系人发普通消息 @提出者 → T8a 待确认,
// reviewGate 记 compliant;打回 → 原 Compute 带审查意见续改;没有合格审查人或审查没做成 → 交给提出者本人豁免,记 waived-by-user。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { REVIEW_TOOLS, parseVerdict, pickReviewer } from "./review.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-review-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);

async function settle(host: Host, ...computes: { drained(): boolean }[]) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (computes.every((c) => c.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}

const CLAUDE = "claude-sonnet-4-6";
const GPT = "agentrouter/gpt-6.1-sol";
/** 执行 Compute 用 claude;审查 Compute 用审查人的模型。verdicts 依次给出每次审查的结论原文。 */
/** H 是被测的宿主类(显式传入,测试断言的都是它的结果)。 */
function world(H: typeof Host, opts: { verdicts?: string[]; reviewFails?: boolean; reviewer?: { name: string; model: string } | null; extra?: { name: string; model: string }[]; ownerModel?: string } = {}) {
  const exec = scriptedCompute({ onResume: () => [{ kind: "completed", result: "按审查意见改好了" }] });
  const verdicts = [...(opts.verdicts ?? ["APPROVE\n产物与要求一致"])];
  const review = scriptedCompute({
    idPrefix: "rv",
    script: () =>
      opts.reviewFails
        ? [{ kind: "started", sessionId: "rv", resumed: false }, { kind: "failed", reason: "上游 502", code: 1, signal: null, violations: [] }]
        : [{ kind: "started", sessionId: "rv", resumed: false }, { kind: "completed", result: verdicts.shift() ?? "APPROVE" }],
  });
  const models: string[] = [];
  const host = new H({
    file: file(),
    mind: () => scriptedMind(),
    compute: (m) => {
      models.push(m);
      return m === (opts.ownerModel ?? CLAUDE) ? exec.adapter : review.adapter;
    },
    computeCwd: (t) => path.join(dir, "work", t),
    maxDeferMs: 5,
  });
  host.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const owner = host.createContact({ name: "小克", ...(opts.ownerModel ? { computeModel: { mode: "explicit" as const, model: opts.ownerModel } } : {}) });
  const rv = opts.reviewer === null ? null : host.createContact({ name: opts.reviewer?.name ?? "小审", computeModel: { mode: "explicit", model: opts.reviewer?.model ?? GPT } });
  for (const x of opts.extra ?? []) host.createContact({ name: x.name, computeModel: { mode: "explicit", model: x.model } });
  const dm = host.openDm(owner.id);
  return { host, exec, review, models, owner, reviewer: rv, dm, svc: createService(host) };
}
async function deliver(w: ReturnType<typeof world>) {
  w.host.send({ roomId: w.dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(w.host, w.exec, w.review);
  const [task] = w.host.listTasks({ roomId: w.dm.id });
  assert.ok(task);
  return task;
}
const close = async (w: ReturnType<typeof world>) => {
  w.exec.close();
  w.review.close();
  await w.host.close();
};

test("AC-26 ④ 有跨厂商审查联系人:交付后用它的 Compute 模型起只读审查 Compute,审过 → T8a 待确认,reviewGate 记 compliant", async () => {
  const w = world(Host);
  const task = await deliver(w);
  assert.equal(w.review.spawned.length, 1, "起了一个审查 Compute");
  assert.deepEqual(w.models, [CLAUDE, GPT], "审查 Compute 用的是审查人的 Compute 模型");
  const brief = w.review.spawned[0]!.brief as { task: string; tools: string[] };
  assert.deepEqual(brief.tools, [...REVIEW_TOOLS], "审查只给只读工具");
  assert.deepEqual(REVIEW_TOOLS, ["Read", "Glob", "Grep"]);
  assert.match(brief.task, /写一个 hello\.txt/, "审查说明带要求原文");
  assert.match(brief.task, /完成:写一个 hello\.txt/, "审查说明带交付内容");
  assert.equal(w.review.spawned[0]!.cwd, path.join(dir, "work", task.id), "审查在同一个任务工作目录里看产物");
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T8a_Delivered", "审过 → 交付待确认");
  assert.equal(t.reviewGate, "compliant", "跨厂商审查记合规");
  const msgs = w.host.listMessages(w.dm.id, {}).messages;
  const last = msgs.at(-1)!;
  assert.equal(last.sender.kind, "contact", "审过的消息由负责联系人发出");
  assert.equal(last.sender.id, w.owner.id);
  assert.ok(last.mentions.some((m) => m.id === "me"), "@ 提出者");
  assert.match(last.text, /小审/);
  assert.match(last.text, /openai/);
  assert.match(last.text, /审查通过/);
  assert.equal(last.card, null, "交付是普通消息,不挂验收卡(AC-56)");
  assert.ok(!msgs.some((m) => m.card?.kind === "delivery"), "整段会话没有交付卡");
  assert.ok(!msgs.some((m) => /豁免/.test(m.text)), "有合格审查人时不叫提出者豁免");
  await close(w);
});

test("AC-28 审过后提出者确认 → T8_Accepted,reviewGate 仍是 compliant,承诺了结;沉默不自动通过", async () => {
  const w = world(Host);
  const task = await deliver(w);
  assert.equal(w.host.taskView(w.host.taskDoc(task.id).value).state, "T8a_Delivered", "没人说话就一直待确认");
  const r = await w.svc.handle("tasks.accept", { taskId: task.id, clientActionId: "a1" });
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T8_Accepted");
  assert.equal(t.reviewGate, "compliant");
  assert.deepEqual(w.host.listCommitments({ contactId: w.owner.id }).map((k) => k.status), ["done"]);
  await close(w);
});

test("AC-26 TaskView.reviews 记下审查人、实际审查模型与厂商、结论和意见", async () => {
  const w = world(Host, { verdicts: ["APPROVE\n文件内容正确"] });
  const task = await deliver(w);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.deepEqual(
    t.reviews?.map((r) => [r.reviewerContactId, r.model, r.vendor, r.status, r.notes]),
    [[w.reviewer!.id, GPT, "openai", "approved", "文件内容正确"]],
  );
  await close(w);
});

test("AC-26 ② 只有同厂商的联系人 → 不起审查 Compute,交给提出者本人豁免,记 waived-by-user", async () => {
  const w = world(Host, { reviewer: { name: "同厂", model: "claude-opus-5-5" } });
  const task = await deliver(w);
  assert.equal(w.review.spawned.length, 0, "同厂商不能当独立审查人");
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T5_InReview");
  assert.deepEqual(t.reviews, [], "没有起任何审查");
  const r = await w.svc.handle("tasks.accept", { taskId: task.id, clientActionId: "a1" });
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  const t2 = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t2.state, "T8_Accepted", "提出者本人回复通过 = 豁免审查并验收");
  assert.equal(t2.reviewGate, "waived-by-user", "豁免不记合规");
  await close(w);
});

test("AC-26 ③ 审查联系人的模型认不出厂商(unknown)→ 不当审查人", async () => {
  const w = world(Host, { reviewer: { name: "隐身", model: "stealth/crouton-alpha" } });
  const task = await deliver(w);
  assert.equal(w.review.spawned.length, 0);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.deepEqual(t.reviews, [], "没有起任何审查");
  assert.equal(t.state, "T5_InReview", "停在 T5 等提出者本人决定");
  await close(w);
});

test("AC-26 ① 作者自己不当审查人:负责联系人的 Compute 模型跨厂商也不行,换别的合格联系人", async () => {
  const w = world(Host, { reviewer: null, ownerModel: GPT, extra: [{ name: "谷歌审", model: "gemini-3-pro" }] });
  const task = await deliver(w);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.reviews?.[0]?.vendor, "google", "挑的是别的联系人");
  assert.notEqual(t.reviews?.[0]?.reviewerContactId, w.owner.id);
  await close(w);
});

test("AC-26 审查打回 → 回 T3,原 Compute 带审查意见续改;改完再交付重新送审,第二次审过才进 T8a", async () => {
  const w = world(Host, { verdicts: ["REJECT\n文件末尾缺换行", "APPROVE\n改好了"] });
  const task = await deliver(w);
  assert.equal(w.exec.resumed.length, 1, "打回后续接原 Compute");
  assert.equal(w.exec.resumed[0]!.computeId, w.exec.spawned[0]!.computeId);
  assert.match(w.exec.resumed[0]!.text, /文件末尾缺换行/);
  assert.equal(w.exec.spawned.length, 1, "可恢复就不新开");
  assert.equal(w.review.spawned.length, 2, "改完重新送审");
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T8a_Delivered");
  assert.deepEqual(t.reviews?.map((r) => r.status), ["rejected", "approved"]);
  await close(w);
});

test("审查 Compute 失败 → 不当通过,交给提出者本人豁免或退回,说明审查没做成", async () => {
  const w = world(Host, { reviewFails: true });
  const task = await deliver(w);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T5_InReview");
  assert.equal(t.reviewGate, "none");
  assert.equal(t.reviews?.[0]?.status, "failed");
  const last = w.host.listMessages(w.dm.id, {}).messages.at(-1)!;
  assert.equal(last.sender.id, w.owner.id);
  assert.ok(last.mentions.some((m) => m.id === "me"), "@ 提出者");
  assert.match(last.text, /审查没做成/);
  assert.match(last.text, /上游 502/, "说清原因");
  assert.equal(last.card, null);
  await close(w);
});

test("审查结论既不是 APPROVE 也不是 REJECT → 当审查没做成,不猜成通过", async () => {
  const w = world(Host, { verdicts: ["看起来还行吧"] });
  const task = await deliver(w);
  const t = w.host.taskView(w.host.taskDoc(task.id).value);
  assert.equal(t.state, "T5_InReview");
  assert.equal(t.reviews?.[0]?.status, "failed");
  assert.match(w.host.listMessages(w.dm.id, {}).messages.at(-1)!.text, /审查没做成/);
  await close(w);
});

test("审查中取消任务 → 审查 Compute 也被停止", async () => {
  const exec = scriptedCompute();
  const review = scriptedCompute({ idPrefix: "rv", script: () => [{ kind: "started", sessionId: "rv", resumed: false }] });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: (m) => (m === CLAUDE ? exec.adapter : review.adapter), maxDeferMs: 5 });
  host.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const owner = host.createContact({ name: "小克" });
  host.createContact({ name: "小审", computeModel: { mode: "explicit", model: GPT } });
  const dm = host.openDm(owner.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, exec, review);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.equal(task!.state, "T5_InReview");
  assert.equal(review.spawned.length, 1);
  host.taskDecision(task!.id, "cancel", "c1");
  await settle(host, exec, review);
  assert.deepEqual(review.stopped, [review.spawned[0]!.computeId], "审查 Compute 被停");
  assert.equal(host.taskView(host.taskDoc(task!.id).value).reviews?.[0]?.status, "stopped");
  exec.close();
  review.close();
  await host.close();
});

test("重启时审查 Compute 已不在 → 这次审查记中断,交给提出者本人豁免或退回,任务不卡在 T5", async () => {
  const f = file();
  const exec = scriptedCompute();
  const review = scriptedCompute({ idPrefix: "rv", script: () => [{ kind: "started", sessionId: "rv", resumed: false }] });
  const host = new Host({ file: f, mind: () => scriptedMind(), compute: (m) => (m === CLAUDE ? exec.adapter : review.adapter), maxDeferMs: 5 });
  host.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const owner = host.createContact({ name: "小克" });
  host.createContact({ name: "小审", computeModel: { mode: "explicit", model: GPT } });
  const dm = host.openDm(owner.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, exec, review);
  exec.close();
  review.close();
  await host.close();
  const exec2 = scriptedCompute();
  const host2 = new Host({ file: f, mind: () => scriptedMind(), compute: () => exec2.adapter, maxDeferMs: 5 });
  const [task] = host2.listTasks({ roomId: dm.id });
  assert.equal(task!.state, "T5_InReview");
  assert.equal(task!.reviews?.[0]?.status, "interrupted");
  const last = host2.listMessages(dm.id, {}).messages.at(-1)!;
  assert.match(last.text, /审查没做成/);
  assert.match(last.text, /宿主重启/);
  exec2.close();
  await host2.close();
});

test("pickReviewer:排除作者、unknown、与累积生产厂商任一同源(F13 半途换模 {A,B} 都不行);同会话成员优先", () => {
  const c = (contactId: string, model: string, inRoom = false) => ({ contactId, model, inRoom });
  assert.equal(pickReviewer([c("a", GPT)], [CLAUDE], "a"), null, "作者不能审自己");
  assert.equal(pickReviewer([c("b", "stealth/crouton-alpha")], [CLAUDE], "a"), null, "unknown 不能审");
  assert.equal(pickReviewer([c("b", GPT)], [CLAUDE, "stealth/x"], "a"), null, "生产模型里有 unknown 就没人能审");
  assert.equal(pickReviewer([c("b", GPT)], [], "a"), null, "没有生产模型记录不能判");
  assert.equal(pickReviewer([c("b", GPT)], [CLAUDE, "gpt-6-astra"], "a"), null, "半途换到 openai 后,openai 审查人也不行");
  assert.equal(pickReviewer([c("b", GPT)], ["gpt-6-astra", CLAUDE], "a"), null, "前半程 openai、半途换回 claude:不能只看末次模型,openai 审查人仍不行");
  assert.equal(pickReviewer([c("b", GPT), c("g", "gemini-3-pro")], [CLAUDE, "gpt-6-astra"], "a")?.contactId, "g");
  assert.equal(pickReviewer([c("b", GPT), c("g", "gemini-3-pro", true)], [CLAUDE], "a")?.contactId, "g", "同会话成员优先");
  assert.equal(pickReviewer([c("b", GPT), c("g", "gemini-3-pro")], [CLAUDE], "a")?.contactId, "b", "都不在会话里按给定顺序");
});

test("parseVerdict:结论行以 APPROVE / REJECT 开头,或在冒号后以它结尾(去掉加粗等标记,大小写不敏感);前后矛盾或认不出返回 null", () => {
  assert.deepEqual(parseVerdict("APPROVE\n没问题"), { verdict: "approve", notes: "没问题" });
  assert.deepEqual(parseVerdict("\n  reject: 缺测试\n第二点"), { verdict: "reject", notes: "缺测试\n第二点" });
  assert.deepEqual(parseVerdict("REJECT"), { verdict: "reject", notes: "" });
  // 2026-11-09 真实运行(proof/e2e-help-review-run1.txt):GLM 审查人的最终回复第一行是「审查已完成并提交：**APPROVE**。」
  assert.deepEqual(parseVerdict("审查已完成并提交：**APPROVE**。\n\n核对结果:文件存在"), { verdict: "approve", notes: "核对结果:文件存在" });
  assert.deepEqual(parseVerdict("**REJECT**: 缺测试"), { verdict: "reject", notes: "缺测试" });
  assert.deepEqual(parseVerdict("- 结论:`REJECT`\n第三列缺表头"), { verdict: "reject", notes: "第三列缺表头" });
  assert.equal(parseVerdict("我觉得 APPROVE"), null, "不在行首、也不在冒号后,不算");
  assert.equal(parseVerdict("不能 APPROVE,还差测试"), null, "否定句里的词不算");
  assert.equal(parseVerdict("APPROVED-ish"), null, "必须是完整的词");
  assert.equal(parseVerdict("APPROVE\n复查后改为:REJECT"), null, "前后矛盾不猜");
  assert.equal(parseVerdict(""), null);
});
