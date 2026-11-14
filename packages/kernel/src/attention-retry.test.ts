// AC-36 注意循环的失败退避接缝:一轮抛错后按宿主失败策略给的延迟重跑(retryAfter),返回 null 就不再自动重跑,只等新的 now 通知;
// 策略自身出错或给出非法延迟时按 retryMs 兜底。计时器可注入,测试用假计时器逐步推进。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttentionLoop, type TimerApi } from "./attention.ts";

/** 假计时器:advance(ms) 推进虚拟时间并触发到期回调。 */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const api: TimerApi = {
    set(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(h) {
      pending.delete(h as number);
    },
  };
  return {
    api,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && pending.has(id)) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    count: () => pending.size,
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("AC-36 一轮抛错后按 retryAfter 给的延迟重跑;返回 null 不再自动重跑,新的 now 通知照样能触发", async () => {
  const t = fakeTimers();
  const asked: string[] = [];
  let runs = 0;
  const loop = createAttentionLoop({
    maxDeferMs: 300,
    retryMs: 1000,
    timers: t.api,
    retryAfter: (id, e) => {
      asked.push(`${id}:${(e as Error).message}`);
      return runs === 1 ? 50 : null;
    },
    run: async () => {
      runs++;
      if (runs <= 2) throw new Error(`第 ${runs} 次失败`);
      return "done";
    },
  });
  loop.notify("c1", "now");
  await tick();
  await tick();
  assert.deepEqual(asked, ["c1:第 1 次失败"]);
  t.advance(49);
  await tick();
  assert.equal(runs, 1, "策略给的 50ms 还没到");
  t.advance(1);
  await tick();
  await tick();
  assert.equal(runs, 2, "按策略的延迟重跑,不是 retryMs");
  assert.deepEqual(asked, ["c1:第 1 次失败", "c1:第 2 次失败"]);
  t.advance(5000);
  await tick();
  assert.equal(runs, 2, "策略说不再自动重跑:没有计时器");
  assert.equal(t.count(), 0);
  assert.equal(loop.busy(), false);
  loop.notify("c1", "now");
  await loop.idle();
  assert.equal(runs, 3, "用户的新消息照样能触发");
});

test("AC-36 retryAfter 自身抛错或给出非法延迟时按 retryMs 兜底", async () => {
  const t = fakeTimers();
  let runs = 0;
  let asked = 0;
  const loop = createAttentionLoop({
    maxDeferMs: 300,
    retryMs: 200,
    timers: t.api,
    retryAfter: () => {
      asked++;
      if (runs === 1) throw new Error("策略出错");
      return Number.NaN;
    },
    run: async () => {
      runs++;
      if (runs <= 2) throw new Error("失败");
      return "done";
    },
  });
  loop.notify("c1", "now");
  await tick();
  await tick();
  t.advance(199);
  await tick();
  assert.equal(runs, 1);
  t.advance(1);
  await tick();
  await tick();
  assert.equal(runs, 2, "策略抛错按 retryMs");
  t.advance(200);
  await loop.idle();
  assert.equal(runs, 3, "非法延迟按 retryMs");
  assert.equal(loop.rounds("c1"), 3);
  assert.equal(asked, 2, "两次失败都先问了策略");
});
