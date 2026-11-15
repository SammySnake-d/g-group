// 授权与意图在宿主上的闭环(用确定性替身驱动,真实 SQLite):
// AC-17 群规「改代码前先问我」:Compute 拿不到写工具 → 受阻进 T4b 提问 → 用户本人直接回复「同意」(不点卡)→ 换上写工具续接,实际只写一次;
// AC-19 答复绑定任务、提问与有效版本:改条件后迟到的「同意」不放行,提问卡标过期;
// AC-20 只有用户本人的直接表态算数:联系人的「同意」、引用旧同意、多个待授权时没指明,都不放行(后者追问);
// AC-45 中途改条件:原位升版、新约束送进同一个 Compute,Compute 在跑时排队,旧版本结果不能交付;
// AC-16 交付后补充标 Applied 并指向产物版本;AC-15 改挂补充:A 不取消、版本 +1、重放 #n,已落实时先停旧执行器再回滚。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { MessageView, TaskView } from "@g-group/api-contract";
import type { ContactMind, Inbound, MindAction } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-intent-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `i${++fileNo}.db`);

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
type Ev = ComputeEvent extends infer E ? (E extends ComputeEvent ? Omit<E, "computeId"> : never) : never;
/** 联系人替身:「帮我…」派活;Compute 完成就交付;其余由 extra 决定(转交补充等)。 */
function mind(extra: (me: string, f: Inbound) => MindAction[] = () => [], autoDeliver = true): ContactMind {
  return {
    async round(input) {
      const me = input.contact.id;
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && (f.roomId.startsWith("dm-") || f.mentions.includes(me))) {
          const m = /^帮我(.+)$/.exec(f.text.trim());
          if (m) actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: m[1]!.slice(0, 40), task: m[1]! });
        }
        if (autoDeliver && f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `做完了:${f.summary}` });
        actions.push(...extra(me, f));
      }
      return { actions, stateNote: null };
    },
  };
}
const RULE = "改代码前先问我";
type Svc = ReturnType<typeof createService>;
/** 经服务层(按 @g-group/api-contract 校验参数与结果)取数据:同时核对新增的可选字段符合合同。 */
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method as never, params);
  if (!r.ok) throw new Error(`${method}:${r.error.code} ${r.error.message}`);
  return r.value as T;
}
const tasksOf = async (svc: Svc, q: { roomId?: string }) => (await call<{ tasks: TaskView[] }>(svc, "tasks.list", q)).tasks;
const msgsOf = (svc: Svc, roomId: string) => call<{ messages: MessageView[] }>(svc, "messages.list", { roomId, limit: 500 });
const taskOf = (svc: Svc, taskId: string) => call<TaskView>(svc, "tasks.get", { taskId });
const WRITE = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

/** 改前先问的完整场景:Compute 首轮只读、受阻要写;续接拿到 Write 才真的写盘(写入次数记在文件里)。 */
function guardedScene(o: { rules?: string; group?: boolean } = {}) {
  const out = path.join(mkdtempSync(path.join(dir, "ws-")), "app.ts");
  let writes = 0;
  const compute = scriptedCompute({
    script: () => [
      { kind: "started", sessionId: "s", resumed: false },
      { kind: "blocked", needs: "要改 app.ts 加导出函数", summary: "读完了,准备改 app.ts" },
    ],
    resumeScript: (_id, _turn, _text, tools): Ev[] => {
      if (!tools?.includes("Write")) return [{ kind: "blocked", needs: "还是需要写 app.ts", summary: "没有写权限" }];
      writes++;
      writeFileSync(out, `export const hello = 1; // 第 ${writes} 次写入\n`);
      return [{ kind: "milestone", stage: "写文件", summary: "写好 app.ts" }, { kind: "completed", result: "app.ts 已加导出" }];
    },
  });
  const reports: { what: string; detail: unknown }[] = [];
  const host = new Host({ file: file(), mind: () => mind(), compute: () => compute.adapter, maxDeferMs: 5, onReport: (what, detail) => reports.push({ what, detail }) });
  const c = host.createContact({ name: "小克" });
  const room = o.group ? host.createGroup("项目群", [{ kind: "contact", id: c.id }]) : host.openDm(c.id);
  if (o.rules !== undefined) host.updateRoom(room.id, { rules: o.rules });
  return { host, compute, contact: c, room, out, writes: () => writes, reports };
}

test("AC-17 群规「改代码前先问我」生效:Compute 首轮拿不到任何写工具,群规写进 brief", async () => {
  const s = guardedScene({ rules: `周报周五发\n${RULE}` });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const brief = s.compute.spawned[0]!.brief as { tools: string[]; rules: string[] };
  for (const w of WRITE) assert.ok(!brief.tools.includes(w), `首轮不该有 ${w}`);
  assert.ok(brief.tools.includes("Read"));
  // 群规各行按原文进 brief,接在宿主固定规矩(如人工验证码交给用户)之后
  assert.deepEqual(brief.rules.slice(-2), ["周报周五发", RULE]);
  assert.equal(existsSync(s.out), false, "没授权不能写盘");
  const [t] = await tasksOf(svc, { roomId: s.room.id });
  assert.equal(t!.state, "T4b_BlockedOnHuman", "首轮只读、要写就停下来问");
  await s.host.close();
});

test("AC-17 归入任务 ≠ 获授权:受阻后任务停在 T4b,负责人在会话里 @ 用户提问;没有本人同意不续接写", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const [t] = (await tasksOf(svc, { roomId: s.room.id }));
  assert.equal(t!.state, "T4b_BlockedOnHuman");
  assert.equal(t!.authorizations?.length, 1);
  assert.equal(t!.authorizations![0]!.state, "pending");
  assert.equal(t!.authorizations![0]!.principalId, "me");
  assert.equal(t!.pendingQuestion?.text, "要改 app.ts 加导出函数");
  const q = (await msgsOf(svc, s.room.id)).messages.find((m) => m.card?.kind === "question")!;
  assert.equal(q.sender.kind, "contact");
  assert.equal(q.sender.id, s.contact.id);
  assert.ok(q.mentions.some((m) => m.id === "me"));
  assert.match(q.text, /直接回复「同意」/);
  assert.equal(s.compute.resumed.length, 0);
  assert.equal(s.writes(), 0);
  await s.host.close();
});

test("AC-17 本人直接回复「同意」(不点卡):绑定当前版本放行,续接换上写工具,实际只写一次", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const yes = s.host.send({ roomId: s.room.id, clientActionId: "u2", text: "同意" });
  await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.length, 1, "只续接一次");
  assert.ok(s.compute.resumed[0]!.tools?.includes("Write"), "授权后这一轮才拿到写工具");
  assert.match(s.compute.resumed[0]!.text, /用户本人已同意/);
  assert.equal(s.writes(), 1);
  assert.match(readFileSync(s.out, "utf8"), /第 1 次写入/);
  const [t] = (await tasksOf(svc, { roomId: s.room.id }));
  const a = t!.authorizations![0]!;
  assert.equal(a.state, "granted");
  assert.equal(a.decidedSeq, yes.seq);
  assert.equal(a.constraintVersion, 0);
  const q = (await msgsOf(svc, s.room.id)).messages.find((m) => m.card?.kind === "question")!;
  assert.equal(q.card!.state, "done");
  // 同一句「同意」重发(同一 clientActionId)不再放行第二次
  s.host.send({ roomId: s.room.id, clientActionId: "u2", text: "同意" });
  s.host.send({ roomId: s.room.id, clientActionId: "u3", text: "同意" });
  await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.length, 1);
  assert.equal(s.writes(), 1);
  await s.host.close();
});

test("AC-17 按钮只是可选交互:点提问卡「同意」走同一条绑定路径,同样放行一次", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const q = (await msgsOf(svc, s.room.id)).messages.find((m) => m.card?.kind === "question")!;
  s.host.cardAct({ roomId: s.room.id, seq: q.seq, cardId: q.card!.cardId, actionId: "approve", clientActionId: "c1" });
  await settle(s.host, s.compute);
  assert.equal(s.writes(), 1);
  assert.equal((await tasksOf(svc, { roomId: s.room.id }))[0]!.authorizations![0]!.state, "granted");
  await s.host.close();
});

test("AC-17 本人回复「不行」:不写盘,任务取消", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  s.host.send({ roomId: s.room.id, clientActionId: "u2", text: "不行" });
  await settle(s.host, s.compute);
  const [t] = (await tasksOf(svc, { roomId: s.room.id }));
  assert.equal(t!.authorizations![0]!.state, "denied");
  assert.ok(["T9_StopRequested", "T10_Cancelled"].includes(t!.state));
  assert.equal(s.writes(), 0);
  assert.equal(s.compute.resumed.length, 0);
  await s.host.close();
});

test("AC-17 没有「改前先问」群规:照常给全部工具,不插授权提问(可逆改动由群规决定,不是默认都问)", async () => {
  const s = guardedScene({ rules: "周报周五发" });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const brief = s.compute.spawned[0]!.brief as { tools: string[]; rules: string[] };
  assert.ok(brief.tools.includes("Write"));
  assert.deepEqual(brief.rules.slice(-1), ["周报周五发"], "群规照样写进 brief");
  assert.ok(!brief.rules.includes(RULE));
  // 受阻仍按 AC-44 发一般提问卡,但不是授权提问(标题不是「需要你同意」)
  assert.equal((await msgsOf(svc, s.room.id)).messages.some((m) => m.card?.kind === "question" && m.card.title.startsWith("需要你同意")), false);
  assert.equal((await tasksOf(svc, { roomId: s.room.id }))[0]!.authorizations, undefined);
  await s.host.close();
});

test("AC-17 显式入口 tasks.answer 回答授权提问:「同意」绑定放行一次;含义不清的回答被拒,不放行", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  const [t0] = await tasksOf(svc, { roomId: s.room.id });
  const qId = t0!.pendingQuestion!.qId;
  await assert.rejects(call(svc, "tasks.answer", { taskId: t0!.id, qId, clientActionId: "a1", answer: "你看着办吧" }), /invalid_params/);
  assert.equal((await taskOf(svc, t0!.id)).authorizations![0]!.state, "pending");
  const t1 = await call<TaskView>(svc, "tasks.answer", { taskId: t0!.id, qId, clientActionId: "a2", answer: "同意" });
  await settle(s.host, s.compute);
  assert.equal(t1.authorizations![0]!.state, "granted");
  assert.equal(s.writes(), 1);
  assert.ok(s.compute.resumed[0]!.tools?.includes("Write"));
  await s.host.close();
});

test("AC-20 授权提问时联系人把用户的话 forward 过去不算授权:被拒,任务仍等本人,写工具仍收着", async () => {
  const s = guardedScene({ rules: RULE });
  const reports: string[] = [];
  const host: Host = new Host({
    file: file(),
    // 联系人把用户在会话里说的任何话都当回答转给 Compute(不带来源 seq)
    mind: () => mind((_me, f) => (f.kind === "message" && f.sender.kind === "user" && !f.text.startsWith("帮我") ? [{ kind: "forward", taskId: host.listTasks({})[0]!.id, text: f.text }] : [])),
    compute: () => s.compute.adapter,
    maxDeferMs: 5,
    onReport: (what, detail) => reports.push(`${what} ${JSON.stringify(detail)}`),
  });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.updateRoom(dm.id, { rules: RULE });
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(host, s.compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "你先看看再说" });
  await settle(host, s.compute);
  const [t] = await tasksOf(svc, { roomId: dm.id });
  assert.equal(t!.state, "T4b_BlockedOnHuman");
  assert.equal(t!.authorizations![0]!.state, "pending");
  assert.ok(reports.some((r) => r.startsWith("action-rejected") && /授权提问/.test(r)));
  assert.equal(s.compute.resumed.length, 0);
  assert.equal(s.writes(), 0);
  await host.close();
  await s.host.close();
});

test("AC-20 授权只来自用户本人:引用旧的「同意」、正文说别的,不放行", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  const old = s.host.send({ roomId: s.room.id, clientActionId: "u0", text: "同意" });
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  s.host.send({ roomId: s.room.id, clientActionId: "u2", text: "按这条来", replyToSeq: old.seq, quotedSeqs: [old.seq] });
  s.host.send({ roomId: s.room.id, clientActionId: "u3", text: "> 同意\n先看看" });
  await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.length, 0);
  assert.equal(s.writes(), 0);
  assert.equal((await tasksOf(svc, { roomId: s.room.id }))[0]!.authorizations![0]!.state, "pending");
  await s.host.close();
});

test("AC-20 联系人在群里说「同意」不产生授权:旁边的联系人看到提问就回「同意」,任务仍停在等本人", async () => {
  const out = path.join(mkdtempSync(path.join(dir, "ws-")), "app.ts");
  let writes = 0;
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "要改 app.ts", summary: "准备改" }],
    resumeScript: (_id, _turn, _t, tools) => {
      if (tools?.includes("Write")) { writes++; writeFileSync(out, "x"); }
      return [{ kind: "completed", result: "ok" }];
    },
  });
  // 「旁人」联系人:看到任何别人的消息就回一句「同意」
  const yesMan: ContactMind = {
    async round(input) {
      const f = input.fresh.find((x) => x.kind === "message" && x.sender.kind === "contact");
      return { actions: f && f.kind === "message" ? [{ kind: "reply", roomId: f.roomId, text: "同意", replyToSeq: f.seq }] : [], stateNote: null };
    },
  };
  const host = new Host({ file: file(), mind: (cv) => (cv.name === "旁人" ? yesMan : mind()), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const other = host.createContact({ name: "旁人" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }, { kind: "contact", id: other.id }]);
  host.updateRoom(g.id, { rules: RULE });
  host.send({ roomId: g.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  const msgs = host.listMessages(g.id, {}).messages;
  assert.ok(msgs.some((m) => m.sender.kind === "contact" && m.sender.id === other.id && m.text === "同意"), "旁人确实说了「同意」");
  const [t] = host.listTasks({ roomId: g.id });
  assert.equal(t!.state, "T4b_BlockedOnHuman");
  assert.equal(t!.authorizations![0]!.state, "pending");
  assert.equal(compute.resumed.length, 0);
  assert.equal(writes, 0);
  await host.close();
});

test("AC-20 多个待授权动作又没指明:不擅自选,联系人追问;回复其中一条提问才放行那一件", async () => {
  const s = guardedScene({ rules: RULE });
  const svc = createService(s.host);
  s.host.send({ roomId: s.room.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(s.host, s.compute);
  s.host.send({ roomId: s.room.id, clientActionId: "u2", text: "帮我再改 lib.ts" });
  await settle(s.host, s.compute);
  const qs = (await msgsOf(svc, s.room.id)).messages.filter((m) => m.card?.kind === "question");
  assert.equal(qs.length, 2);
  s.host.send({ roomId: s.room.id, clientActionId: "u3", text: "同意" });
  await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.length, 0, "两件都在等,不能猜");
  const ask = (await msgsOf(svc, s.room.id)).messages.at(-1)!;
  assert.equal(ask.sender.kind, "contact");
  assert.match(ask.text, /对应哪一件/);
  s.host.send({ roomId: s.room.id, clientActionId: "u4", text: "同意", replyToSeq: qs[1]!.seq });
  await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.length, 1);
  const tasks = (await tasksOf(svc, { roomId: s.room.id }));
  const granted = tasks.filter((t) => t.authorizations?.[0]?.state === "granted");
  assert.equal(granted.length, 1);
  assert.equal(granted[0]!.authorizations![0]!.askedSeq, qs[1]!.seq);
  await s.host.close();
});

test("AC-19 改条件之后的迟到「同意」不放行:提问卡标过期,授权记 expired,任务按新版本回到执行", async () => {
  const s = guardedScene({ rules: RULE });
  // 联系人把用户的补充当改条件转交(带来源 seq)
  const host: Host = new Host({
    file: file(),
    mind: () => mind((_me, f) => (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("改成") ? [{ kind: "forward", taskId: host.listTasks({})[0]!.id, text: f.text, sourceSeq: f.seq }] : [])),
    compute: () => s.compute.adapter,
    maxDeferMs: 5,
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.updateRoom(dm.id, { rules: RULE });
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(host, s.compute);
  assert.equal(host.listTasks({})[0]!.state, "T4b_BlockedOnHuman");
  host.send({ roomId: dm.id, clientActionId: "u2", text: "改成导出两个函数" });
  await settle(host, s.compute);
  const t1 = host.listTasks({})[0]!;
  assert.equal(t1.constraintVersion, 1);
  assert.equal(t1.authorizations![0]!.state, "expired");
  const q = host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "question")!;
  assert.equal(q.card!.state, "expired");
  // 续接只是把新条件送进去,仍然没有写工具
  assert.ok(s.compute.resumed.length >= 1);
  assert.ok(!s.compute.resumed[0]!.tools?.includes("Write"));
  const resumedBefore = s.compute.resumed.filter((r) => r.tools?.includes("Write")).length;
  host.send({ roomId: dm.id, clientActionId: "u3", text: "同意", replyToSeq: q.seq });
  await settle(host, s.compute);
  assert.equal(s.compute.resumed.filter((r) => r.tools?.includes("Write")).length, resumedBefore, "迟到的同意不放行");
  assert.equal(s.writes(), 0);
  await host.close();
  await s.host.close();
});

test("AC-19 授权只对那一版有效:同意后用户又改条件,之后的续接收回写工具", async () => {
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "要改 app.ts", summary: "准备改" }],
    resumeScript: () => [{ kind: "milestone", stage: "写", summary: "写了一部分" }],
  });
  const host: Host = new Host({
    file: file(),
    mind: () => mind((_me, f) => (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("改成") ? [{ kind: "forward", taskId: host.listTasks({})[0]!.id, text: f.text, sourceSeq: f.seq }] : []), false),
    compute: () => compute.adapter,
    maxDeferMs: 5,
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.updateRoom(dm.id, { rules: RULE });
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "同意" });
  await settle(host, compute);
  assert.ok(compute.resumed[0]!.tools?.includes("Write"), "v0 的授权放开写工具");
  host.send({ roomId: dm.id, clientActionId: "u3", text: "改成导出两个函数" });
  await settle(host, compute);
  const t = host.listTasks({})[0]!;
  assert.equal(t.constraintVersion, 1);
  const last = compute.resumed.at(-1)!;
  assert.match(last.text, /改成导出两个函数/);
  assert.ok(!compute.currentTools(last.computeId).includes("Write"), "v1 没有本人授权,写工具收回");
  assert.ok(compute.currentTools(last.computeId).includes("Read"));
  await host.close();
});

test("AC-45 Compute 运行中送不进去的新条件:这一轮结束时自动续上,不靠联系人交付触发", async () => {
  const compute = scriptedCompute({
    refuseWhileRunning: true,
    stepMs: 3,
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "milestone", stage: "写", summary: "写东京" }, { kind: "milestone", stage: "写", summary: "写东京 2" }, { kind: "completed", result: "东京五日攻略" }],
    resumeScript: () => [],
  });
  const host: Host = new Host({
    file: file(),
    // 不自动交付:排队的补充只能由「本轮结束」续上
    mind: () => mind((_me, f) => (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("改成") ? [{ kind: "forward", taskId: host.listTasks({})[0]!.id, text: f.text, sourceSeq: f.seq }] : []), false),
    compute: () => compute.adapter,
    maxDeferMs: 1,
  });
  const c = host.createContact({ name: "小旅" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写东京五日攻略" });
  await new Promise((r) => setTimeout(r, 4));
  host.send({ roomId: dm.id, clientActionId: "u2", text: "改成大阪,带老人" });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 1);
  assert.match(compute.resumed[0]!.text, /大阪/);
  await host.close();
});

test("AC-45 中途改条件:同一任务原位升版 v0→v1,新约束送进同一个 Compute;Compute 在跑就排队,旧版本结果不能交付", async () => {
  let rounds = 0;
  const compute = scriptedCompute({
    refuseWhileRunning: true,
    stepMs: 3,
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "milestone", stage: "写", summary: "写东京" }, { kind: "milestone", stage: "写", summary: "写东京 2" }, { kind: "completed", result: "东京五日攻略" }],
    resumeScript: (_id, _turn, text) => {
      rounds++;
      return [{ kind: "completed", result: /大阪/.test(text) ? "大阪五日攻略(带老人)" : "?" }];
    },
  });
  const reports: { what: string; detail: unknown }[] = [];
  const host: Host = new Host({
    file: file(),
    mind: () => mind((_me, f) => (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("改成") ? [{ kind: "forward", taskId: host.listTasks({})[0]!.id, text: f.text, sourceSeq: f.seq }] : [])),
    compute: () => compute.adapter,
    maxDeferMs: 1,
    onReport: (what, detail) => reports.push({ what, detail }),
  });
  const c = host.createContact({ name: "小旅" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写东京五日攻略" });
  await new Promise((r) => setTimeout(r, 4));
  const amend = host.send({ roomId: dm.id, clientActionId: "u2", text: "改成大阪,带老人" });
  await settle(host, compute);
  const tasks = host.listTasks({});
  assert.equal(tasks.length, 1, "不另开第二个任务");
  const t = tasks[0]!;
  assert.equal(t.constraintVersion, 1);
  assert.equal(compute.spawned.length, 1, "同一个 Compute");
  assert.equal(rounds, 1, "排队的新条件在这一轮结束后送进同一个 Compute");
  assert.match(compute.resumed[0]!.text, /大阪/);
  // 旧版本(东京)的结果交付被拒,按新版本的结果交付
  assert.ok(reports.some((r) => r.what === "action-rejected" && /新条件还没落实/.test(JSON.stringify(r.detail))));
  // 交付是普通消息(AC-56):联系人 @ 提出者、正文是交付说明
  const delivery = host.listMessages(dm.id, {}).messages.filter((m) => m.sender.kind === "contact" && m.text.startsWith("做完了:"));
  assert.equal(delivery.length, 1);
  assert.match(delivery[0]!.text, /大阪/);
  const link = t.followUps!.find((l) => l.seq === amend.seq)!;
  assert.equal(link.state, "Applied");
  assert.equal(link.version, 1);
  assert.equal(link.appliedVersion, 1);
  assert.match(link.appliedIn!, /@v1$/);
  await host.close();
});

test("AC-16 收到 ≠ 落实:补充送达、Compute 也做完了,没交付前只是 Received;交付后才标 Applied 并指向产物版本", async () => {
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "等补充", summary: "等用户补充" }],
    resumeScript: () => [{ kind: "completed", result: "加好了缓存一节" }],
  });
  const host: Host = new Host({
    file: file(),
    // 不自动交付:用户说「交付吧」才交付,好观察交付前后的关联边
    mind: () => mind((_me, f) => {
      if (f.kind !== "message" || f.sender.kind !== "user") return [];
      const t = host.listTasks({})[0];
      if (!t) return [];
      if (f.text.startsWith("再")) return [{ kind: "forward", taskId: t.id, text: f.text, sourceSeq: f.seq }];
      if (f.text === "交付吧") return [{ kind: "deliver", taskId: t.id, text: "交付:需求文档" }];
      return [];
    }, false),
    compute: () => compute.adapter,
    maxDeferMs: 5,
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理需求文档" });
  await settle(host, compute);
  const m = host.send({ roomId: dm.id, clientActionId: "u2", text: "再加一节缓存" });
  await settle(host, compute);
  let t = host.listTasks({})[0]!;
  assert.equal(t.recentProgress.at(-1)!.kind, "completed");
  assert.equal(t.followUps![0]!.state, "Received", "Compute 做完了也只是送达,没交付不算落实");
  assert.equal(t.followUps![0]!.appliedIn, null);
  host.send({ roomId: dm.id, clientActionId: "u3", text: "交付吧" });
  await settle(host, compute);
  t = host.listTasks({})[0]!;
  const l = t.followUps!.find((x) => x.seq === m.seq)!;
  assert.equal(l.state, "Applied");
  assert.equal(l.appliedIn, "result:cp-1@v1");
  assert.equal(l.appliedVersion, 1);
  await host.close();
});

// ---------------------------------------------------------------- AC-15 改挂
async function twoTasks(o: { blockA?: boolean } = {}) {
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, ...(o.blockA ? [] : [{ kind: "blocked", needs: "等补充", summary: "等" } as Ev])],
    resumeScript: () => [],
  });
  const host: Host = new Host({
    file: file(),
    // 「给A:」开头的补充转交给 A(带来源 seq),模拟联系人把 #m、#n 都挂到 A
    mind: () => mind((_me, f) => {
      if (f.kind !== "message" || f.sender.kind !== "user") return [];
      const m = /^给(A|B):(.+)$/.exec(f.text);
      if (!m) return [];
      const t = host.listTasks({}).find((x) => x.title.startsWith(m[1]!));
      return t ? [{ kind: "forward", taskId: t.id, text: m[2]!, sourceSeq: f.seq }] : [];
    }),
    compute: () => compute.adapter,
    maxDeferMs: 5,
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "a", text: "帮我A需求文档" });
  host.send({ roomId: dm.id, clientActionId: "b", text: "帮我B测试报告" });
  await settle(host, compute);
  const m = host.send({ roomId: dm.id, clientActionId: "m", text: "给A:报告加覆盖率表" });
  await settle(host, compute);
  const n = host.send({ roomId: dm.id, clientActionId: "n", text: "给A:文档补压缩换页" });
  await settle(host, compute);
  const A = host.listTasks({}).find((x) => x.title.startsWith("A"))!;
  const B = host.listTasks({}).find((x) => x.title.startsWith("B"))!;
  return { host, compute, dm, m, n, A, B };
}

test("AC-15 改挂补充:消息 m 从 A 移到 B,A 不取消、版本 +1 并重放 消息 n,B 收下 消息 m;重复改挂幂等", async () => {
  const s = await twoTasks();
  const svc = createService(s.host);
  assert.equal(s.A.followUps!.length, 2);
  assert.equal(s.A.constraintVersion, 2);
  const before = s.compute.resumed.length;
  const r = await svc.handle("tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "rb1" });
  assert.ok(r.ok, JSON.stringify(r));
  await settle(s.host, s.compute);
  const A = (await taskOf(svc, s.A.id));
  const B = (await taskOf(svc, s.B.id));
  assert.ok(!["T9_StopRequested", "T10_Cancelled", "T11_Failed"].includes(A.state), "A 不能被取消");
  assert.equal(A.constraintVersion, 3, "v_A_new = 当前版本 + 1");
  assert.equal(A.followUps!.find((l) => l.seq === s.m.seq)!.state, "Rebound");
  assert.equal(A.followUps!.find((l) => l.seq === s.m.seq)!.reboundTo, s.B.id);
  assert.equal(A.followUps!.find((l) => l.seq === s.n.seq)!.state, "Received");
  assert.equal(A.bindingVersion, 1);
  assert.equal(B.followUps!.find((l) => l.seq === s.m.seq)!.state, "Received");
  assert.equal(B.constraintVersion, 1);
  const newResumes = s.compute.resumed.slice(before);
  const toA = newResumes.find((x) => x.computeId === A.computeRuns[0]!.computeId)!;
  assert.match(toA.text, /文档补压缩换页/, "重放 #n");
  assert.doesNotMatch(toA.text, new RegExp(`- #${s.m.seq} `), "重放清单里没有 #m");
  const toB = newResumes.find((x) => x.computeId === B.computeRuns[0]!.computeId)!;
  assert.match(toB.text, /报告加覆盖率表/);
  assert.equal(s.compute.stopped.length, 0, "#m 只送达未落实,不用停执行器");
  // 重复改挂(新动作号)幂等,版本不再变
  const again = await svc.handle("tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "rb2" });
  assert.ok(again.ok);
  assert.equal(s.host.taskDoc(s.A.id).value.task.constraintVer, 3);
  assert.equal(s.host.taskDoc(s.B.id).value.task.constraintVer, 1);
  await s.host.close();
});

test("AC-15 关联版本对不上返回 conflict 并带当前值;改挂之后联系人再把 消息 m 转给 A 被拒(定向作废依赖 消息 m 的动作)", async () => {
  const s = await twoTasks();
  const svc = createService(s.host);
  const bad = await svc.handle("tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 5, clientActionId: "x1" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.error.code === "conflict");
  assert.deepEqual(!bad.ok && bad.error.detail, { currentVer: 0 });
  assert.equal((await taskOf(svc, s.A.id)).constraintVersion, 2, "冲突时 A 不动");
  const ok = await svc.handle("tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "x2" });
  assert.ok(ok.ok);
  await settle(s.host, s.compute);
  const h = s.host as unknown as { amendFromFollowUpTx: (...a: unknown[]) => { ok: boolean; reason?: string } };
  const doc = s.host.taskDoc(s.A.id).value;
  const r = h.amendFromFollowUpTx.call(s.host, s.A.id, doc, s.m.seq, "x", [{ kind: "message", roomId: s.dm.id, seq: s.m.seq, sender: { kind: "user", id: "me", name: "我" }, text: "给A:报告加覆盖率表", replyToSeq: null, quotedSeqs: [], mentions: [], command: null, at: "" }]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /已挂在任务|已改挂/);
  await s.host.close();
});

test("AC-15 消息 m 已落实进工作区:先停旧执行器(任务不取消),停止确认后才让它回到 消息 m 之前并重做 消息 n", async () => {
  const s = await twoTasks();
  const svc = createService(s.host);
  // 让 A 的补充都算落实:直接记一次按当前版本的产出
  const h = s.host as unknown as { followOf: (id: string) => { value: { state: unknown; rounds: number[]; resultVer: number | null; queued: string[] }; ver: number }; putFollowTx: (id: string, cur: unknown, next: unknown) => void };
  const { followups } = await import("@g-group/domain");
  const tx = (await import("./db.ts")).tx;
  tx(s.host.db, () => {
    const f = h.followOf.call(s.host, s.A.id);
    const ap = followups.applyArtifact(f.value.state as never, { artifact: "result:cp-1@v2", artifactVer: 2 });
    assert.ok(ap.ok);
    h.putFollowTx.call(s.host, s.A.id, f, { ...f.value, state: ap.value });
  });
  const before = s.compute.resumed.length;
  const r = await call<{ from: TaskView; to: TaskView }>(svc, "tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "rb" });
  assert.ok(!["T9_StopRequested", "T10_Cancelled"].includes(r.from.state));
  await settle(s.host, s.compute);
  const aCompute = r.from.computeRuns[0]!.computeId;
  assert.deepEqual(s.compute.stopped, [aCompute], "先停 A 的执行器");
  const toA = s.compute.resumed.slice(before).filter((x) => x.computeId === aCompute);
  assert.equal(toA.length, 1, "停稳之后只续接一次");
  assert.match(toA[0]!.text, new RegExp(`回到 #${s.m.seq} 之前`));
  assert.match(toA[0]!.text, /文档补压缩换页/);
  const A = (await taskOf(svc, s.A.id));
  assert.equal(A.state, "T3_Running");
  assert.equal(A.followUps!.find((l) => l.seq === s.n.seq)!.state, "Received", "#n 随回滚退回重做");
  await s.host.close();
});

test("AC-15 改挂到别的会话的任务、改挂到自己都被拒", async () => {
  const s = await twoTasks();
  const svc = createService(s.host);
  await assert.rejects(call(svc, "tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.A.id, expectedBindingVersion: 0, clientActionId: "z1" }), /invalid_params 不能改挂到同一个任务/);
  await assert.rejects(call(svc, "tasks.rebindFollowUp", { roomId: "elsewhere", seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "z2" }), /不在这个会话里/);
  // 对照:同一会话、两件不同任务的改挂照常成功
  const ok = await call<{ from: TaskView }>(svc, "tasks.rebindFollowUp", { roomId: s.dm.id, seq: s.m.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 0, clientActionId: "z3" });
  assert.equal(ok.from.followUps!.find((l) => l.seq === s.m.seq)!.state, "Rebound");
  await s.host.close();
});
