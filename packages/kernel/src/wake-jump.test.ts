// AC-36 ⑤ F11 休眠检测的跳变边界(B-F11 第 1 轮审查 BF11-R1-02 / hy4 H-BF11-01):相邻两次采样「超过」jumpMs 才算醒来。
// 恰好等于 jumpMs 是正常核对能碰上的间隔(jumpMs 恰为核对周期 2 倍时允许启动),这一拍不能开宽限门、把真停滞吞掉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { WAKE_INITIAL, mayJudgeStale, wakeTick } from "./retry-policy.ts";

test("F11 相邻两次采样恰好相隔 jumpMs 不算醒来、照常可判卡死;多 1 毫秒才算醒来、宽限期内不判", () => {
  const p = { jumpMs: 60000, graceMs: 180000 };
  const s0 = wakeTick(WAKE_INITIAL, 1000, p);
  const exact = wakeTick(s0, 61000, p);
  assert.deepEqual(exact, { lastTickMs: 61000, awakeSince: null }, "恰好 60 秒:不算醒来");
  assert.equal(mayJudgeStale(exact, 61000, p), true, "恰好 60 秒:可以判卡死");
  const over = wakeTick(s0, 61001, p);
  assert.deepEqual(over, { lastTickMs: 61001, awakeSince: 61001 }, "多 1 毫秒:算醒来");
  assert.equal(mayJudgeStale(over, 61001, p), false, "刚醒来:宽限期内不判");
  assert.equal(mayJudgeStale(over, 61001 + 180000, p), true, "宽限 3 分钟到点可以判");
});
