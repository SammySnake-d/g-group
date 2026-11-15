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

test("scriptedCompute 默认停止核验:失败终态仍须等待 settled 的退出门", async () => {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "failed", reason: "测试失败", code: 1, signal: null, violations: [] }],
    settle: () => exited,
  });
  try {
    const spawned = await compute.adapter.spawn({ task: "失败后慢退出" });
    assert.ok(spawned.ok);
    const events = compute.adapter.events()[Symbol.asyncIterator]();
    assert.equal((await events.next()).value.kind, "started");
    assert.equal((await events.next()).value.kind, "failed");
    let confirmed = false;
    const result = compute.adapter.quiesce!(spawned.computeId).then((value) => { confirmed = true; return value; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(confirmed, false, "不能在主退出门打开前固定返回成功");
    exit();
    assert.deepEqual(await result, { ok: true, killed: 0 });
  } finally {
    exit();
    compute.close();
  }
});

test("scriptedCompute 默认停止核验:即使曾有 failed,空 settled 也不得成功", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "failed", reason: "测试失败", code: 1, signal: null, violations: [] }] });
  try {
    const spawned = await compute.adapter.spawn({ task: "空观察" });
    assert.ok(spawned.ok);
    assert.equal((await compute.adapter.events()[Symbol.asyncIterator]().next()).value.kind, "failed");
    const empty = { ...compute.adapter, settled: async () => [] };
    assert.equal((await empty.quiesce!(spawned.computeId)).ok, false, "核验必须来自当前 settled,不是旧 failed 或固定成功");
  } finally {
    compute.close();
  }
});
