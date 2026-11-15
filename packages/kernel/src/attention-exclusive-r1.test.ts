import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttentionLoop } from "./attention.ts";

test("R1-03 同联系人只读轮同步抛错后,后续轮仍能取得单飞入口", async () => {
  const loop = createAttentionLoop({ maxDeferMs: 1, run: async () => "done" });
  await assert.rejects(loop.runExclusive("a", () => { throw new Error("fixture"); }), /fixture/);
  const next = loop.runExclusive("a", async () => "完成");
  const result = await Promise.race([next, new Promise<string>((resolve) => setTimeout(() => resolve("超时"), 100))]);
  assert.equal(result, "完成", "失败后的同联系人队列必须可继续");
  await loop.stop();
});

test("R1-03 重试定时器到点时只读轮在途,普通轮应延后而非遗失", async () => {
  let due!: () => void;
  let release!: () => void;
  let runs = 0;
  const loop = createAttentionLoop({
    maxDeferMs: 5,
    timers: { set(fn) { due = fn; return 1; }, clear() {} },
    run: async () => { runs++; if (runs === 1) throw new Error("重试"); return "done"; },
  });
  loop.notify("a", "now");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof due, "function");
  const held = loop.runExclusive("a", () => new Promise<void>((done) => { release = done; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  due();
  release();
  await held;
  await loop.idle();
  assert.equal(runs, 2, "到点后必须补跑一次普通轮");
  await loop.stop();
});

test("R1-03 已有的 now 通知不能被后到的只读轮饿死", async () => {
  let release!: () => void;
  const order: string[] = [];
  const loop = createAttentionLoop({ maxDeferMs: 5, run: async () => { order.push("普通轮"); return "done"; } });
  const first = loop.runExclusive("a", () => new Promise<void>((done) => { order.push("只读1"); release = done; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.notify("a", "now");
  const second = loop.runExclusive("a", async () => { order.push("只读2"); });
  release();
  await first;
  await second;
  await loop.idle();
  assert.deepEqual(order, ["只读1", "普通轮", "只读2"]);
  await loop.stop();
});
