// AC-31 ② 单人串行与防无限延期:同一联系人推理期间新事件排队不并发;未 @ 攒批在有界 max_defer_ms 内必被处理。
// AC-31 ④ 发送前撤销竞态:一轮报告 stale(检出更新的用户消息)就重跑,不按旧结果收尾;连续 stale 有上限防活锁。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttentionLoop, type RoundStatus, type TimerApi } from "./attention.ts";

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
/** 可手动放行的一轮。 */
function gate() {
  let open!: (s: RoundStatus) => void;
  let fail!: (e: unknown) => void;
  const p = new Promise<RoundStatus>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { p, open, fail };
}
const tick = () => new Promise((r) => setImmediate(r));

test("同一联系人单飞:在跑期间来 3 条通知,不并发,结束后只补跑 1 轮", async () => {
  const t = fakeTimers();
  const gates: ReturnType<typeof gate>[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const loop = createAttentionLoop({
    maxDeferMs: 500,
    timers: t.api,
    run: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const g = gate();
      gates.push(g);
      const s = await g.p;
      concurrent--;
      return s;
    },
  });
  loop.notify("c1", "now");
  await tick();
  loop.notify("c1", "now");
  loop.notify("c1", "batch");
  loop.notify("c1", "now");
  assert.equal(gates.length, 1);
  gates[0]!.open("done");
  await tick();
  await tick();
  assert.equal(gates.length, 2, "结束后立刻补跑一轮");
  gates[1]!.open("done");
  await loop.idle();
  assert.equal(loop.rounds("c1"), 2);
  assert.equal(maxConcurrent, 1);
});

test("不同联系人互不阻塞:c1 卡住时 c2 照样跑", async () => {
  const t = fakeTimers();
  const g1 = gate();
  const ran: string[] = [];
  const loop = createAttentionLoop({
    maxDeferMs: 500,
    timers: t.api,
    run: async (id) => {
      ran.push(id);
      return id === "c1" ? g1.p : "done";
    },
  });
  loop.notify("c1", "now");
  loop.notify("c2", "now");
  await tick();
  assert.deepEqual(ran, ["c1", "c2"]);
  assert.equal(loop.busy(), true);
  g1.open("done");
  await loop.idle();
  assert.equal(loop.busy(), false);
});

test("未 @ 的消息攒批:maxDeferMs 之前不跑,到点必跑;后续 batch 不推迟已有计时器", async () => {
  const t = fakeTimers();
  let runs = 0;
  const loop = createAttentionLoop({ maxDeferMs: 300, timers: t.api, run: async () => {
      runs++;
      return "done";
    } });
  loop.notify("c1", "batch");
  t.advance(200);
  loop.notify("c1", "batch");
  t.advance(99);
  await tick();
  assert.equal(runs, 0, "还没到上界");
  t.advance(1);
  await tick();
  assert.equal(runs, 1, "从第一条起 300ms 必跑,第二条没有把它推迟");
  await loop.idle();
  assert.equal(t.count(), 0);
});

test("攒批期间来了 now:立刻跑并取消攒批计时器", async () => {
  const t = fakeTimers();
  let runs = 0;
  const loop = createAttentionLoop({ maxDeferMs: 300, timers: t.api, run: async () => {
      runs++;
      return "done";
    } });
  loop.notify("c1", "batch");
  loop.notify("c1", "now");
  await tick();
  assert.equal(runs, 1);
  assert.equal(t.count(), 0, "攒批计时器已取消");
  t.advance(1000);
  await tick();
  assert.equal(runs, 1, "不会因为旧计时器再多跑一轮");
});

test("在跑期间只来了 batch:结束后进入攒批而不是立刻跑", async () => {
  const t = fakeTimers();
  const g = gate();
  let runs = 0;
  const loop = createAttentionLoop({ maxDeferMs: 300, timers: t.api, run: async () => {
      runs++;
      return runs === 1 ? g.p : "done";
    } });
  loop.notify("c1", "now");
  await tick();
  loop.notify("c1", "batch");
  g.open("done");
  await tick();
  await tick();
  assert.equal(runs, 1);
  t.advance(300);
  await tick();
  assert.equal(runs, 2);
});

test("发送前检出新消息(stale)立刻重跑;连续 stale 超上限后停止并报告", async () => {
  const t = fakeTimers();
  const statuses: RoundStatus[] = ["stale", "done"];
  let runs = 0;
  const loop = createAttentionLoop({ maxDeferMs: 300, timers: t.api, run: async () => statuses[runs++] ?? "done" });
  loop.notify("c1", "now");
  await loop.idle();
  assert.equal(runs, 2, "stale 后重跑一轮");

  const reports: [string, string, unknown][] = [];
  let staleRuns = 0;
  const loop2 = createAttentionLoop({ maxDeferMs: 300, maxStaleReruns: 2, timers: t.api, run: async () => {
      staleRuns++;
      return "stale";
    }, onReport: (id, w, d) => reports.push([id, w, d]) });
  loop2.notify("c9", "now");
  await loop2.idle();
  assert.equal(staleRuns, 3, "首轮 + 2 次重跑");
  assert.deepEqual(reports, [["c9", "stale-limit", 3]]);
});

test("一轮抛错:报告、退避 retryMs 后重跑;不影响其他联系人", async () => {
  const t = fakeTimers();
  const reports: string[] = [];
  let c1 = 0;
  let c2 = 0;
  const loop = createAttentionLoop({
    maxDeferMs: 300,
    retryMs: 1000,
    timers: t.api,
    onReport: (id, what) => reports.push(`${id}:${what}`),
    run: async (id) => {
      if (id === "c1" && ++c1 === 1) throw new Error("模型 502");
      if (id === "c2") c2++;
      return "done";
    },
  });
  loop.notify("c1", "now");
  loop.notify("c2", "now");
  await tick();
  await tick();
  assert.deepEqual(reports, ["c1:error"]);
  assert.equal(c2, 1);
  t.advance(999);
  await tick();
  assert.equal(c1, 1, "退避未到");
  t.advance(1);
  await loop.idle();
  assert.equal(c1, 2, "退避到点重跑");
});

test("stop:中止在跑的轮次(signal 触发),之后的通知忽略,idle 立即返回", async () => {
  const t = fakeTimers();
  let aborted = false;
  const loop = createAttentionLoop({
    maxDeferMs: 300,
    timers: t.api,
    run: (_id, signal) =>
      new Promise<RoundStatus>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve("done");
        });
      }),
  });
  loop.notify("c1", "now");
  loop.notify("c2", "batch");
  await tick();
  await loop.stop();
  assert.equal(aborted, true);
  assert.equal(t.count(), 0, "攒批计时器被清掉");
  loop.notify("c1", "now");
  assert.equal(loop.busy(), false);
  await loop.idle();
});

test("非法参数被拒", () => {
  assert.throws(() => createAttentionLoop({ maxDeferMs: Number.NaN, run: async () => "done" }), RangeError);
  const loop = createAttentionLoop({ maxDeferMs: 1, run: async () => "done" });
  assert.throws(() => loop.notify("c1", "later" as "now"), TypeError);
});
