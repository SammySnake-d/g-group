// Q09 最小闭环(需求 §8.1 已定 1、AC-28、AC-56):联系人交活后,没有跨厂商审查人时不审,任务直接进 T8a 待确认,
// 不再停在 T5_InReview;沉默一直待确认;提出者本人用普通回复或显式入口验到 T8(没经审查,如实记 waived-by-user)。
// 阴性:他人说「通过」不算;退回修改期间(旧版本)说的「通过」不算第二版的验收。全部经 createService 的 service 入口驱动。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskView } from "@g-group/api-contract";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-q09-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let fileNo = 0;
const file = () => path.join(dir, `q${++fileNo}.db`);

async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 600; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
async function until(what: string, ok: () => boolean) {
  for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), `等不到:${what}`);
}

/** 测试用脑子:「帮我…」派活;Compute 完成就交付;本人(或群里有人)说「通过」「改…」时对 judge.taskId 提交验收结论;echoPass 的联系人见「看看」就回「通过」。 */
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

async function okValue<T>(p: Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}:${r.error.message}`);
  return r.value as T;
}
const taskVia = (svc: ReturnType<typeof createService>, taskId: string) => okValue<TaskView>(svc.handle("tasks.get", { taskId }));

/** 私聊里派一件活并等它交付;返回宿主、服务、会话和任务。 */
async function deliveredDm(compute = scriptedCompute()) {
  judge.taskId = null;
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  await okValue(svc.handle("messages.send", { roomId: dm.id, clientActionId: "u1", text: "帮我写报告" }));
  await settle(host, compute);
  const [t] = (await okValue<{ tasks: TaskView[] }>(svc.handle("tasks.list", { roomId: dm.id }))).tasks;
  assert.ok(t);
  return { host, svc, dm, task: t, compute, contact: c };
}

test("Q09 A0 私聊没有审查人:交付后经 service 读到 T8a 待确认、门禁 none、交付消息已钉住;沉默不通过", async () => {
  const { host, svc, dm, task, compute } = await deliveredDm();
  assert.equal(task.state, "T8a_Delivered", "交活后进 T8a 待确认,不停在 T5");
  assert.equal(task.reviewGate, "none", "没审过,不记合规也不记豁免");
  assert.deepEqual(task.reviews ?? [], [], "没有起审查");
  const last = host.listMessages(dm.id, {}).messages.at(-1)!;
  assert.equal(task.deliveredSeq, last.seq, "交付消息就是联系人那条 @ 你的普通消息");
  assert.equal(last.card, null, "不挂专用验收卡");
  await new Promise((r) => setTimeout(r, 80));
  await settle(host, compute);
  const later = await taskVia(svc, task.id);
  assert.equal(later.state, "T8a_Delivered", "沉默不自动通过、不归档");
  assert.equal(later.reviewGate, "none");
  assert.equal(host.roomView(dm.id).pendingForUser, 2, "任务卡 + 一件等你确认的交付");
  compute.close();
  await host.close();
});

test("Q09 A0 群里只有同厂商联系人:不起审查,交付同样直接进 T8a", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => mindFor(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小林" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  await okValue(svc.handle("messages.send", { roomId: g.id, clientActionId: "g1", text: "帮我写周报", mentions: [{ id: a.id, source: "manual" }] }));
  await settle(host, compute);
  const [t] = (await okValue<{ tasks: TaskView[] }>(svc.handle("tasks.list", { roomId: g.id }))).tasks;
  assert.equal(t!.state, "T8a_Delivered");
  assert.equal(t!.reviewGate, "none");
  assert.equal(compute.spawned.length, 1, "只起了干活的 Compute,没有审查 Compute");
  compute.close();
  await host.close();
});

test("Q09 A2 本人普通回复「通过」:联系人提交结论,service 读到 T8_Accepted,如实记本人豁免;任务卡收口", async () => {
  const { host, svc, dm, task, compute } = await deliveredDm();
  assert.equal(task.state, "T8a_Delivered", "回复之前是交付待确认");
  judge.taskId = task.id;
  await okValue(svc.handle("messages.send", { roomId: dm.id, clientActionId: "u2", text: "通过,辛苦了" }));
  await settle(host, compute);
  const done = await taskVia(svc, task.id);
  assert.equal(done.state, "T8_Accepted");
  assert.equal(done.reviewGate, "waived-by-user", "没经审查的交付由本人验收 = 本人豁免,不算合规");
  assert.equal(host.roomView(dm.id).pendingForUser, 0);
  assert.deepEqual(rejected(host), []);
  compute.close();
  await host.close();
});

test("Q09 A2 显式入口 tasks.accept:T8a 直接验到 T8;已验收后再点被拒", async () => {
  const { host, svc, task, compute } = await deliveredDm();
  assert.equal(task.state, "T8a_Delivered", "点之前是交付待确认");
  const v = await okValue<TaskView>(svc.handle("tasks.accept", { taskId: task.id, clientActionId: "a1" }));
  assert.equal(v.state, "T8_Accepted");
  assert.equal(v.reviewGate, "waived-by-user");
  const again = await svc.handle("tasks.accept", { taskId: task.id, clientActionId: "a2" });
  assert.equal(again.ok ? "ok" : again.error.code, "conflict", "已经验收过,不再有待确认的交付");
  await settle(host, compute);
  compute.close();
  await host.close();
});

test("Q09 A2 阴性 他人:群里别的联系人说「通过」,负责联系人据此提交的结论被拒,任务仍在 T8a", async () => {
  judge.taskId = null;
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: (c) => mindFor({ echoPass: c.name === "小研" }), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  await okValue(svc.handle("messages.send", { roomId: g.id, clientActionId: "g1", text: "帮我写报告", mentions: [{ id: a.id, source: "manual" }] }));
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: g.id });
  assert.equal(t!.state, "T8a_Delivered");
  judge.taskId = t!.id;
  await okValue(svc.handle("messages.send", { roomId: g.id, clientActionId: "g2", text: "大家看看" }));
  await settle(host, compute);
  const pass = host.listMessages(g.id, {}).messages.find((m) => m.sender.id === b.id && m.text === "通过");
  assert.ok(pass, "小研确实在群里说了通过");
  assert.deepEqual(rejected(host), [{ kind: "verdict", error: `验收结论的来源 ${g.id} #${pass.seq} 不是提出者本人的消息` }]);
  const still = await taskVia(svc, t!.id);
  assert.equal(still.state, "T8a_Delivered", "别人说通过不算验收");
  assert.equal(still.reviewGate, "none");
  compute.close();
  await host.close();
});

test("Q09 A2 阴性 旧版本:第一版交付后要求修改,修改期间说的「通过」被拒;第二版交付后仍待确认,之后本人回复才验到 T8", async () => {
  // 续接的这一轮慢一点、按修改意见做完(第二版)
  const slow = scriptedCompute({ stepMs: 150, resumeScript: () => [{ kind: "completed", result: "完成:写报告(加了标题)" }] });
  const { host, svc, dm, task } = await deliveredDm(slow);
  const v1 = task.deliveredSeq!;
  judge.taskId = task.id;
  await okValue(svc.handle("messages.send", { roomId: dm.id, clientActionId: "u2", text: "改一下:加个标题" }));
  await until("退回后在改", () => host.taskView(host.taskDoc(task.id).value).state === "T3_Running");
  assert.equal(slow.spawned.length, 1, "原 Compute 可恢复:恢复原实例,不新开");
  await okValue(svc.handle("messages.send", { roomId: dm.id, clientActionId: "u3", text: "通过" }));
  await until("改的期间的结论被拒", () => rejected(host).length > 0);
  assert.deepEqual(rejected(host), [{ kind: "verdict", error: "任务在 T3_Running,没有等你确认的交付" }]);
  judge.taskId = null;
  await settle(host, slow);
  const v2 = await taskVia(svc, task.id);
  assert.equal(v2.state, "T8a_Delivered", "第一版之后的「通过」不算第二版的验收");
  assert.ok(v2.deliveredSeq! > v1, "第二版是新的交付消息");
  assert.equal(v2.constraintVersion, 1, "退回升了条件版本");
  judge.taskId = task.id;
  await okValue(svc.handle("messages.send", { roomId: dm.id, clientActionId: "u4", text: "通过" }));
  await settle(host, slow);
  const done = await taskVia(svc, task.id);
  assert.equal(done.state, "T8_Accepted");
  assert.equal(done.reviewGate, "waived-by-user");
  slow.close();
  await host.close();
});
