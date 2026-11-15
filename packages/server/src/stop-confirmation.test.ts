// AC-23 停止确认反例:只用无 OS 进程的替身,不以失败/续接拒绝代替原执行器停止确认。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-stop-confirmation-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(root, `h${++n}.db`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(cond: () => boolean, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 5000) throw new Error(`等不到:${what}`);
    await tick();
  }
}
const failureScript = () => [
  { kind: "started" as const, sessionId: "s", resumed: false },
  { kind: "failed" as const, reason: "cyber_policy: flagged by safeguards", code: 1, signal: null, violations: [] },
];

test("AC-23 停止未确认后重试被拒:原租约不能复用或释放给后继", async (t) => {
  const compute = scriptedCompute({
    script: failureScript,
    quiesce: async () => ({ ok: false, reason: "原执行器停止未确认", remaining: [] }),
    resumeResult: () => ({ ok: false, reason: "这一轮续接被拒" }),
  });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  try {
    const contact = host.createContact({ name: "停止未确认重试" });
    const dm = host.openDm(contact.id).id;
    host.send({ roomId: dm, clientActionId: "first", text: "帮我写一份报告" });
    await until(() => host.listTasks({ roomId: dm })[0]?.waitingFor?.includes("停止未确认") === true, "原执行器停止未确认");
    const first = host.listTasks({ roomId: dm })[0]!;
    const lease = host.quota.leaseOf(first.id);
    assert.ok(lease?.stopping);
    host.send({ roomId: dm, clientActionId: "second", text: "帮我再写一份报告" });
    await until(() => host.listTasks({ roomId: dm }).length === 2, "后继已建好");
    assert.equal(compute.spawned.length, 1, "后继仍需等待原槽位");
    const failure = host.listMessages(dm, {}).messages.find((message) => message.card?.kind === "failure")!;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    host.cardAct({ roomId: dm, seq: failure.seq, cardId: failure.card!.cardId, actionId: "retry", clientActionId: "retry" });
    // 执行重试的零延时计时器并排空微任务,不能用点击前就存在的等待说明提前判绿。
    t.mock.timers.tick(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(host.quota.leaseOf(first.id), lease, "续接未获新租约,不得归还原执行器仍占用的租约");
    assert.equal(compute.resumed.length, 0, "停止未确认不得续接原执行器");
    assert.equal(compute.spawned.length, 1, "后继不得占用未经核验的原槽位");
  } finally {
    t.mock.timers.reset();
    compute.close();
    await host.close();
  }
});

test("AC-23 重启无原执行器后放弃失败任务:不得虚构停止确认", async () => {
  const compute = scriptedCompute({
    script: failureScript,
    quiesce: async () => ({ ok: false, reason: "原执行器停止未确认", remaining: [] }),
  });
  const database = file();
  let before: Host | undefined;
  let afterRestart: Host | undefined;
  try {
    before = new Host({ file: database, mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
    const contact = before.createContact({ name: "重启无执行器" });
    const dm = before.openDm(contact.id).id;
    before.send({ roomId: dm, clientActionId: "start", text: "帮我写一份报告" });
    await until(() => before!.listTasks({ roomId: dm })[0]?.waitingFor?.includes("停止未确认") === true, "旧执行器停止未确认");
    const task = before.listTasks({ roomId: dm })[0]!;
    const saved = before.quota.leaseOf(task.id);
    assert.ok(saved);
    await before.close();
    before = undefined;
    compute.close();
    // 重启只有持久账本,没有接回原执行器;旧失败卡仍是正常产品入口。
    afterRestart = new Host({ file: database, mind: () => scriptedMind(), maxDeferMs: 5, personalComputeSlots: 1 });
    const failure = afterRestart.listMessages(dm, {}).messages.find((message) => message.card?.kind === "failure")!;
    afterRestart.cardAct({ roomId: dm, seq: failure.seq, cardId: failure.card!.cardId, actionId: "give-up", clientActionId: "give-up" });
    await tick();
    assert.equal(afterRestart.taskDoc(task.id).value.task.state, "T9_StopRequested", "没有原执行器,不能以空观察确认停止并转 T11");
    assert.deepEqual(afterRestart.quota.leaseOf(task.id), saved, "原物理租约必须原样保留");
    assert.ok(afterRestart.taskView(afterRestart.taskDoc(task.id).value).waitingFor?.includes("停止未确认"));
  } finally {
    compute.close();
    if (before) await before.close();
    if (afterRestart) await afterRestart.close();
  }
});

test("AC-23 执行器未提供停止核验:轮次 settled 不得确认停止或归还槽位", async () => {
  let settledObserved = false;
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }],
    settle: async () => { settledObserved = true; },
  });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5, personalComputeSlots: 1 });
  try {
    const contact = host.createContact({ name: "没有停止核验" });
    const dm = host.openDm(contact.id).id;
    host.send({ roomId: dm, clientActionId: "start", text: "帮我写一份报告" });
    await until(() => host.listTasks({ roomId: dm })[0]?.state === "T3_Running", "执行器开跑");
    const task = host.listTasks({ roomId: dm })[0]!;
    const lease = host.quota.leaseOf(task.id)!;
    host.stopTask(task.id, "me");
    await until(() => settledObserved || host.taskView(host.taskDoc(task.id).value).waitingFor?.includes("执行器未提供") === true, "旧轮次已 settled 或宿主拒绝空核验");
    assert.equal(host.taskDoc(task.id).value.task.state, "T9_StopRequested", "轮次 settled 不证明主进程及全部后代已经停止");
    assert.equal(host.quota.leaseOf(task.id)?.leaseId, lease.leaseId, "没有完整停止核验,不能归还物理槽位");
  } finally {
    compute.close();
    await host.close();
  }
});
