// AC-47 手动新建任务(候选底座,U14;也是 AC-52 Helper 把 CSV 转成本群任务的后端):
// tasks.create 以用户一条对话消息记进会话,描述原样保留;指定负责人 → 自动 @ 它、它认领(Claim)并起 Compute(brief 含标题与描述);
// 不指定 → 停在 T1_Open,之后 tasks.assign。负责人必须是本会话联系人成员;clientActionId 幂等。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskView } from "@g-group/api-contract";
import type { ContactMind } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-mtask-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `m${++fileNo}.db`);
const NOW = "2026-11-09T09:00:00.000Z";
const DESC = "第一行:整理 10 月发票\n第二行:按部门分表,金额保留两位小数\n第三行:完成后发我汇总";

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}

async function setup() {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), now: () => NOW, mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小账" });
  const b = host.createContact({ name: "小写" });
  const outsider = host.createContact({ name: "局外" });
  const g = host.createGroup("财务群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const call = async (m: string, p: unknown) => {
    const r = await svc.handle(m, p);
    if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.value as TaskView;
  };
  const code = async (m: string, p: unknown) => {
    const r = await svc.handle(m, p);
    return r.ok ? "ok" : r.error.code;
  };
  return { compute, host, svc, a, b, outsider, g, call, code };
}

test("带描述与负责人新建:描述原样读回;负责人认领并开工,Compute 的 brief 含标题和描述;会话里有那条用户消息并自动 @ 负责人", async () => {
  const { compute, host, a, g, call } = await setup();
  const t = await call("tasks.create", { clientActionId: "c1", roomId: g.id, title: "整理发票", description: DESC, ownerContactId: a.id });
  assert.deepEqual([t.title, t.description, t.roomId, t.ownerContactId, t.requesterId, t.state], ["整理发票", DESC, g.id, a.id, "me", "T2_Claimed"]);
  await settle(host, compute);
  const got = await call("tasks.get", { taskId: t.id });
  assert.deepEqual([got.description, got.ownerContactId, got.state], [DESC, a.id, "T3_Running"]);
  assert.deepEqual(got.computeRuns.map((r) => r.computeId), ["cp-1"]);
  assert.equal(compute.spawned.length, 1);
  assert.equal((compute.spawned[0]!.brief as { task: string }).task, `整理发票\n\n${DESC}`);
  const m = host.listMessages(g.id, {}).messages.find((x) => x.seq === t.sourceSeq)!;
  assert.deepEqual([m.sender, m.mentions, m.clientActionId, m.card?.kind, m.card?.taskId], [{ kind: "user", id: "me" }, [{ id: a.id, source: "auto" }], "c1", "task-status", t.id]);
  assert.equal(m.text, `新建任务:整理发票\n${DESC}`);
  // 负责人自己不会再拿同一条消息另建一个任务
  assert.deepEqual(host.listTasks({ roomId: g.id }).map((x) => x.id), [t.id]);
  const viaContract = await createService(host).handle("tasks.get", { taskId: t.id });
  assert.equal(viaContract.ok ? (viaContract.value as TaskView).state : viaContract.error.code, "T3_Running");
  compute.close();
  await host.close();
});

test("不指定负责人:任务停在 T1_Open、tasks.list 可见、没起 Compute;会话里记了用户消息但不 @ 任何人", async () => {
  const { compute, host, g, call } = await setup();
  const t = await call("tasks.create", { clientActionId: "c1", roomId: g.id, title: "订年会场地" });
  await settle(host, compute);
  assert.deepEqual([t.state, t.ownerContactId, t.description], ["T1_Open", null, undefined]);
  const r = await createService(host).handle("tasks.list", { roomId: g.id });
  assert.ok(r.ok);
  assert.deepEqual((r.value as { tasks: TaskView[] }).tasks.map((x) => [x.id, x.state, x.ownerContactId]), [[t.id, "T1_Open", null]]);
  assert.deepEqual(compute.spawned, []);
  const m = host.listMessages(g.id, {}).messages.find((x) => x.seq === t.sourceSeq)!;
  assert.deepEqual([m.text, m.mentions, m.sender.kind], ["新建任务:订年会场地", [], "user"]);
  compute.close();
  await host.close();
});

test("tasks.assign:给 T1_Open 任务指定负责人后它认领并开工,会话里记一条 @ 它的用户消息;已有负责人再指定 conflict;重放同号不重复", async () => {
  const { compute, host, a, b, g, call, code } = await setup();
  const t = await call("tasks.create", { clientActionId: "c1", roomId: g.id, title: "订年会场地", description: "100 人,12 月" });
  const v = await call("tasks.assign", { taskId: t.id, contactId: b.id, clientActionId: "as1" });
  assert.deepEqual([v.ownerContactId, v.state], [b.id, "T2_Claimed"]);
  await settle(host, compute);
  assert.equal((await call("tasks.get", { taskId: t.id })).state, "T3_Running");
  assert.deepEqual(compute.spawned.map((s) => (s.brief as { task: string }).task), ["订年会场地\n\n100 人,12 月"]);
  const msgs = host.listMessages(g.id, {}).messages.filter((x) => x.clientActionId === "as1");
  assert.deepEqual(msgs.map((x) => [x.sender.kind, x.mentions, x.replyToSeq]), [["user", [{ id: b.id, source: "auto" }], t.sourceSeq]]);
  assert.deepEqual(await call("tasks.assign", { taskId: t.id, contactId: b.id, clientActionId: "as1" }).then((x) => [x.id, x.ownerContactId]), [t.id, b.id]);
  assert.equal(await code("tasks.assign", { taskId: t.id, contactId: a.id, clientActionId: "as2" }), "conflict");
  await settle(host, compute);
  assert.equal(compute.spawned.length, 1);
  assert.equal(host.listMessages(g.id, {}).messages.filter((x) => x.clientActionId === "as1").length, 1);
  assert.equal(await code("tasks.assign", { taskId: "t-nope", contactId: a.id, clientActionId: "as3" }), "not_found");
  const viaContract = await createService(host).handle("tasks.get", { taskId: t.id });
  assert.equal(viaContract.ok ? (viaContract.value as TaskView).state : viaContract.error.code, "T3_Running");
  compute.close();
  await host.close();
});

test("负责人不是本会话联系人成员 → invalid_params,什么都没新增(任务、消息、Compute);assign 同样拒绝", async () => {
  const { compute, host, outsider, g, call, code } = await setup();
  const before = host.lastSeq(g.id);
  assert.equal(await code("tasks.create", { clientActionId: "c1", roomId: g.id, title: "整理发票", ownerContactId: outsider.id }), "invalid_params");
  assert.equal(await code("tasks.create", { clientActionId: "c2", roomId: g.id, title: "整理发票", ownerContactId: "c-nope" }), "invalid_params");
  assert.equal(await code("tasks.create", { clientActionId: "c3", roomId: "g-nope", title: "整理发票" }), "not_found");
  await settle(host, compute);
  assert.deepEqual([host.listTasks({}), host.lastSeq(g.id), compute.spawned], [[], before, []]);
  const t = await call("tasks.create", { clientActionId: "c4", roomId: g.id, title: "整理发票" });
  const seqAfter = host.lastSeq(g.id);
  assert.equal(await code("tasks.assign", { taskId: t.id, contactId: outsider.id, clientActionId: "as1" }), "invalid_params");
  await settle(host, compute);
  assert.deepEqual([(await call("tasks.get", { taskId: t.id })).state, host.lastSeq(g.id), compute.spawned], ["T1_Open", seqAfter, []]);
  const viaContract = await createService(host).handle("tasks.get", { taskId: t.id });
  assert.equal(viaContract.ok ? (viaContract.value as TaskView).state : viaContract.error.code, "T1_Open");
  compute.close();
  await host.close();
});

test("重放同一 clientActionId:只有一个任务、一条消息、一次 Compute;私聊里也能建(负责人可以是对方)", async () => {
  const { compute, host, a, g, call } = await setup();
  const p = { clientActionId: "c1", roomId: g.id, title: "整理发票", description: DESC, ownerContactId: a.id };
  const t1 = await call("tasks.create", p);
  const t2 = await call("tasks.create", p);
  await settle(host, compute);
  const t3 = await call("tasks.create", p);
  assert.deepEqual([t2.id, t3.id], [t1.id, t1.id]);
  assert.deepEqual(host.listTasks({}).map((x) => x.id), [t1.id]);
  assert.equal(host.listMessages(g.id, {}).messages.filter((x) => x.clientActionId === "c1").length, 1);
  assert.equal(compute.spawned.length, 1);
  const dm = host.openDm(a.id);
  const d = await call("tasks.create", { clientActionId: "c9", roomId: dm.id, title: "写周报", ownerContactId: a.id });
  await settle(host, compute);
  assert.deepEqual([d.roomId, (await call("tasks.get", { taskId: d.id })).state], [dm.id, "T3_Running"]);
  assert.equal(all<{ n: number }>(host.db, "SELECT count(*) AS n FROM gg_compute")[0]!.n, 2);
  compute.close();
  await host.close();
});

test("负责人收到新建任务那条消息后又想 dispatch:被拒,只有手动建的那一个任务和一次 Compute", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const rejected: string[] = [];
  const mind: ContactMind = {
    async round(i) {
      const m = i.fresh.find((f) => f.kind === "message" && f.sender.kind === "user");
      return { actions: m?.kind === "message" ? [{ kind: "dispatch", roomId: m.roomId, sourceSeq: m.seq, title: "重复", task: "重复" }] : [], stateNote: null };
    },
  };
  const host = new Host({ file: file(), now: () => NOW, mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, onReport: (w, d) => { if (w === "action-rejected") rejected.push((d as { reason: string }).reason); } });
  const a = host.createContact({ name: "小账" });
  const dm = host.openDm(a.id);
  const t = host.createTask({ clientActionId: "c1", roomId: dm.id, title: "整理发票", ownerContactId: a.id });
  await settle(host, compute);
  assert.deepEqual(host.listTasks({}).map((x) => x.id), [t.id]);
  assert.equal(compute.spawned.length, 1);
  assert.deepEqual(rejected, ["这条消息已经建过任务"]);
  compute.close();
  await host.close();
});
