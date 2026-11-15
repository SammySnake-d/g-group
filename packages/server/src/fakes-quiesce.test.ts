// 替身停止核验合同:无 OS 进程,但仍须区分未知、正在运行、已终结及主退出等待门。
import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptedCompute } from "./fakes.ts";

test("scriptedCompute 默认停止核验:未知和正在运行不成功,实际 stopped 后才成功", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  try {
    assert.equal(typeof compute.adapter.quiesce, "function", "已确认无 OS 进程的替身仍须提供明确的停止核验入口");
    assert.equal((await compute.adapter.quiesce!("unknown")).ok, false, "空 settled 不证明停止");
    const spawned = await compute.adapter.spawn({ task: "一直运行" });
    assert.ok(spawned.ok);
    const id = spawned.computeId;
    const events = compute.adapter.events()[Symbol.asyncIterator]();
    assert.equal((await events.next()).value.kind, "started");
    assert.equal((await compute.adapter.quiesce!(id)).ok, false, "未产出终态时仍在运行");
    await compute.adapter.stop(id);
    assert.equal((await events.next()).value.kind, "stopped");
    assert.equal((await compute.adapter.settled(id)).at(-1)?.kind, "stopped");
    assert.deepEqual(await compute.adapter.quiesce!(id), { ok: true, killed: 0 });
    assert.ok((await compute.adapter.resume(id, "继续")).ok);
    assert.equal((await compute.adapter.quiesce!(id)).ok, false, "续接后不能复用上一轮的停止终态");
  } finally {
    compute.close();
  }
});
