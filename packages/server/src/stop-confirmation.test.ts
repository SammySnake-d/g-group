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

test("AC-23 停止未确认后重试被拒:原租约不能复用或释放给后继", async () => {
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
    host.cardAct({ roomId: dm, seq: failure.seq, cardId: failure.card!.cardId, actionId: "retry", clientActionId: "retry" });
    // 候选应在配额入口拒绝原租约复用;反例会在续接失败后错误删除原租约。
    await until(() => host.quota.waitingReason(first.id) !== null || host.quota.leaseOf(first.id) === undefined, "重试已到达配额或错误归还路径");
    assert.deepEqual(host.quota.leaseOf(first.id), lease, "续接未获新租约,不得归还原执行器仍占用的租约");
    assert.equal(compute.resumed.length, 0, "停止未确认不得续接原执行器");
    assert.equal(compute.spawned.length, 1, "后继不得占用未经核验的原槽位");
  } finally {
    compute.close();
    await host.close();
  }
});
