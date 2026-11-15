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
