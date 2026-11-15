// AC-23 指定的落盘故障接缝:只在本测试自有 SQLite 注入停止标记写失败,不用 OS 进程或真实模型。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-stop-storage-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
async function until(cond: () => boolean) {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("等不到指定落盘故障或失败卡");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("AC-23 失败卡已提交但停止标记落盘失败:原租约仍未知,用户 retry 不得复用", async (t) => {
  const reports: string[] = [];
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }],
    quiesce: async () => ({ ok: false, reason: "原执行器停止未确认", remaining: [] }),
  });
  const host = new Host({
    file: path.join(root, "host.db"),
    mind: () => scriptedMind(),
    compute: () => compute.adapter,
    personalComputeSlots: 1,
    maxDeferMs: 5,
    onReport: (what, data) => { reports.push(`${what}:${String(data)}`); },
  });
  try {
    const contact = host.createContact({ name: "停止标记落盘故障" });
    const dm = host.openDm(contact.id).id;
    host.send({ roomId: dm, clientActionId: "start", text: "帮我写一份报告" });
    await until(() => host.listTasks({ roomId: dm })[0]?.state === "T3_Running");
    const task = host.listTasks({ roomId: dm })[0]!;
    const lease = host.quota.leaseOf(task.id)!;
    host.db.exec("CREATE TRIGGER fail_stop_storage BEFORE UPDATE ON gg_compute_leases WHEN NEW.stopping = 1 BEGIN SELECT RAISE(ABORT, 'stop-storage-test'); END");
    compute.emit({ computeId: compute.spawned[0]!.computeId, kind: "failed", reason: "cyber_policy: flagged by safeguards", code: 1, signal: null, violations: [] });
    await until(() => reports.some((report) => report.includes("stop-storage-test")) && host.listMessages(dm, {}).messages.some((message) => message.card?.kind === "failure"));
    const failure = host.listMessages(dm, {}).messages.find((message) => message.card?.kind === "failure")!;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    host.cardAct({ roomId: dm, seq: failure.seq, cardId: failure.card!.cardId, actionId: "retry", clientActionId: "retry" });
    t.mock.timers.tick(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compute.resumed.length, 0, "停止标记写失败不得回滚成可复用原 lease");
    assert.equal(host.quota.leaseOf(task.id)?.leaseId, lease.leaseId);
    assert.equal(host.quota.leaseOf(task.id)?.stopping, true, "物理租约须在内存中保守隔离");
    assert.ok(host.taskViewById(task.id).waitingFor?.includes("停止未确认"));
  } finally {
    t.mock.timers.reset();
    compute.close();
    await host.close();
  }
});
