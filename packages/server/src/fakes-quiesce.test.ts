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
    const stopped = await events.next();
    assert.equal(stopped.value?.kind, "stopped");
    assert.equal(((await compute.adapter.settled(id)) as readonly { kind: string }[]).at(-1)?.kind, "stopped");
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
    assert.equal(typeof compute.adapter.quiesce, "function");
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
    assert.equal(typeof empty.quiesce, "function");
    assert.equal((await empty.quiesce!(spawned.computeId)).ok, false, "核验必须来自当前 settled,不是旧 failed 或固定成功");
  } finally {
    compute.close();
  }
});

test("scriptedCompute haltOnStop:取消自己的长等待,生产队列真结束后才确认停止", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const compute = scriptedCompute({ haltOnStop: true, pause: (event) => event.kind === "started" ? 0 : 60_000 });
  try {
    const spawned = await compute.adapter.spawn({ task: "很慢的活" });
    assert.ok(spawned.ok);
    const events = compute.adapter.events()[Symbol.asyncIterator]();
    t.mock.timers.tick(1);
    assert.equal((await events.next()).value.kind, "started");
    await compute.adapter.stop(spawned.computeId);
    assert.equal((await events.next()).value.kind, "stopped");
    assert.equal(typeof compute.adapter.quiesce, "function");
    assert.deepEqual(await compute.adapter.quiesce!(spawned.computeId), { ok: true, killed: 0 }, "必须取消真实挂起的替身等待,不能弱化 busy 判断");
    assert.equal(compute.drained(), true, "自己的生产队列已经结束");
    t.mock.timers.tick(60_001);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compute.drained(), true, "取消的等待不能在稍后又吐里程碑或完成");
  } finally {
    compute.close();
    t.mock.timers.reset();
  }
});
