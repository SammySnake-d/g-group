// 桌面开发用的替身 Compute(startServer 的 fake,Electron 里 GG_COMPUTE=fake 就是它):按派的活说话。
// 用户看截图把替身当成真运行,原来不管派什么活都报「已写好 hello.txt」;现在进度写的是这件事本身,
// 并且能按活演出闭环里要用户动手的几种情况:卡在验证码等你接手(AC-44)、失败出原位失败卡(AC-36)、慢慢做好让人按停止(AC-23)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { MessageView, TaskView } from "@g-group/api-contract";
import { type Started, startServer } from "./start.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-desk-fake-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

async function boot() {
  const s = await startServer({ dataDir: path.join(dir, `d${++n}`), env: {} });
  const c = s.host.createContact({ name: "小克" });
  const dm = s.host.openDm(c.id);
  return { s, dm };
}
async function until<T>(what: string, get: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等不到:${what}`);
}
const taskOf = (s: Started, roomId: string): TaskView | undefined => s.host.listTasks({ roomId })[0];
const call = async <T>(s: Started, method: string, params: unknown): Promise<T> => {
  const r = await s.service.handle(method as never, params as never);
  assert.ok(r.ok, `${method}:${JSON.stringify(r)}`);
  return r.value as T;
};

test("派什么活,替身 Compute 的进度就写什么:不再一律报 hello.txt", async () => {
  const { s, dm } = await boot();
  s.host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我整理周报" });
  const t = await until("交付", () => { const x = taskOf(s, dm.id); return x?.deliveredSeq != null || (x && ["T5_InReview", "T8a_Delivered"].includes(x.state)) ? x : null; });
  const progress = s.host.progress(t.id);
  const milestones = progress.filter((p) => p.kind === "milestone");
  assert.ok(milestones.length >= 1, "有进展");
  for (const p of milestones) assert.doesNotMatch(p.summary, /hello\.txt/, "进度不报和这件事无关的文件");
  assert.ok(milestones.some((p) => p.summary.includes("整理周报")), `进度说的是这件事:${milestones.map((p) => p.summary).join(" / ")}`);
  assert.equal(progress.at(-1)?.summary, "完成:整理周报");
  await s.close();
});

test("活里要验证码:替身 Compute 停在受阻,任务等你回答;你交还后它接着做完", async () => {
  const { s, dm } = await boot();
  s.host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我登录后台查日志(要验证码)" });
  const blocked = await until("停在等你", () => { const x = taskOf(s, dm.id); return x?.state === "T4b_BlockedOnHuman" ? x : null; });
  assert.ok(blocked.pendingQuestion, "有待你回答的问题");
  assert.match(blocked.pendingQuestion.text, /验证码/);
  const ask = s.host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "question" && m.card.taskId === blocked.id);
  assert.ok(ask, "联系人在会话里 @你 发了提问");
  assert.equal(ask.sender.kind, "contact", "是联系人说的,不是 Compute 自己在会话里说话");
  await call(s, "tasks.answer", { taskId: blocked.id, qId: blocked.pendingQuestion.qId, clientActionId: "a1", answer: "验证码输好了,交还给你" });
  const done = await until("接着做完", () => { const x = taskOf(s, dm.id); return x && ["T5_InReview", "T8a_Delivered"].includes(x.state) ? x : null; });
  assert.equal(s.host.progress(done.id).at(-1)?.summary, "完成:登录后台查日志(要验证码)");
  await s.close();
});

test("活里写了会失败:出一张挂在这件事上的原位失败卡,点重试后续接做完", async () => {
  const { s, dm } = await boot();
  s.host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我抓取网页(会失败)" });
  const card = await until("失败卡", () => s.host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "failure" && m.card.state === "open" && m.card.taskId !== null));
  const t = taskOf(s, dm.id)!;
  assert.equal(card.card!.taskId, t.id);
  assert.ok(card.card!.actions.some((a) => a.actionId === "retry"), "卡上有重试");
  await call<MessageView>(s, "cards.act", { roomId: dm.id, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "r1" });
  const done = await until("重试后做完", () => { const x = taskOf(s, dm.id); return x && ["T5_InReview", "T8a_Delivered"].includes(x.state) ? x : null; });
  assert.equal(s.host.progress(done.id).at(-1)?.summary, "完成:抓取网页(会失败)");
  await s.close();
});

test("活里写了慢慢:停止后不再吐剩下的进度,任务落到已取消;可以按台账重跑", async () => {
  const { s, dm } = await boot();
  s.host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我慢慢整理资料" });
  const running = await until("在做", () => { const x = taskOf(s, dm.id); return x?.state === "T3_Running" && x.recentProgress.length ? x : null; });
  await call(s, "tasks.cancel", { taskId: running.id, clientActionId: "c1" });
  const cancelled = await until("已取消", () => { const x = taskOf(s, dm.id); return x?.state === "T10_Cancelled" ? x : null; });
  const kinds = () => s.host.progress(cancelled.id).map((p) => p.kind);
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(!kinds().includes("completed"), `停下后没有再做完:${kinds().join(",")}`);
  const { runs } = await call<{ runs: { id: string; layer: string; taskId: string | null; status: string }[] }>(s, "runs.list", { roomId: dm.id });
  const session = runs.find((r) => r.layer === "compute-session" && r.taskId === cancelled.id);
  assert.ok(session, "台账里有这次 Compute 会话");
  assert.equal(session.status, "interrupted");
  const re = await call<{ taskId: string | null }>(s, "runs.rerun", { runId: session.id, clientActionId: "rr1" });
  assert.ok(re.taskId, "重跑开了一件新任务");
  await until("重跑的在做", () => s.host.taskViewById(re.taskId!).state === "T3_Running");
  await s.close();
});
