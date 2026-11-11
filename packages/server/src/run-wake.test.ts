// AC-36 ⑤ F11 休眠唤醒宽限门接到运行台账(T-177 B-F11,审查 docs/plans/t177-backend-resume-review.md §B):
//   RunStore 用内核 wakeTick 作唯一的休眠检测器(相邻两次核对间隔超过 jumpMs 判醒来),stallCheck 是唯一的宽限消费者;
//   参数构造即校验,jumpMs 不得小于核对周期的 2 倍;宽限不挡确定不会自愈的错误和人停的。
// 台账级用例:时钟与核对计时器都注入,由测试逐拍触发,不真实休眠;宿主级用例沿用 runs.test.ts 的做法(时钟可拨,核对周期用真实的 10 毫秒)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HostError, openDb } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { RunStore, type RunStoreOptions } from "./runs.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-run-wake-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let fileNo = 0;
const file = () => path.join(dir, `w${++fileNo}.db`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEC = 1000;
const MIN = 60_000;

// ---------------- 台账级:注入时钟与计时器 ----------------
type Ledger = {
  readonly store: RunStore;
  /** 时钟拨到 ms,不触发核对 */
  at(ms: number): void;
  /** 时钟拨到 ms,触发台账排着的那一拍核对 */
  beat(ms: number): void;
  /** 台账排着的计时器(各自的间隔) */
  pending(): number[];
  close(): void;
};
/** 建台账:被测类作为参数传入,时钟从 0 起 */
function ledger(RS: typeof RunStore, o: Partial<RunStoreOptions> = {}): Ledger {
  let t = 0;
  let ids = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let handle = 0;
  const db = openDb(file());
  const store = new RS({
    db,
    bootId: "boot-1",
    clockMs: () => t,
    timers: {
      set: (fn, ms) => {
        timers.set(++handle, { fn, ms });
        return handle;
      },
      clear: (h) => void timers.delete(h as number),
    },
    newId: (p) => `${p}-${++ids}`,
    thresholds: () => ({}),
    ...o,
  });
  return {
    store,
    at: (ms) => {
      t = ms;
    },
    beat: (ms) => {
      t = ms;
      const first = [...timers][0];
      assert.ok(first, `${ms / SEC} 秒时台账没有排着的核对`);
      timers.delete(first[0]);
      first[1].fn();
    },
    pending: () => [...timers.values()].map((x) => x.ms),
    close: () => {
      store.stopTicker();
      db.close();
    },
  };
}
const turn = (l: Ledger) => l.store.start({ layer: "compute-turn", parentId: null, roomId: "r1", sourceSeq: 1, contactId: "c1", status: "running" });
/** 这个单元被判卡死的时刻(秒)与判定种类,从台账事件读 */
const judged = (l: Ledger, id: string) =>
  l.store
    .events(id)
    .filter((e) => e.kind === "stall-judged")
    .map((e) => {
      const d = e.detail as { kind: string; judgedAt: string; thresholdMs: number };
      return `${d.kind}@${Date.parse(d.judgedAt) / SEC}s/${d.thresholdMs / SEC}s`;
    });
const waitingOf = (l: Ledger, id: string) => l.store.liveCheck(l.store.get(id)!).waiting;

test("F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器", () => {
  // 默认核对周期 30 秒、默认阈值(首字节 120 秒)、默认休眠门(跳变 60 秒、宽限 3 分钟)
  const slept = ledger(RunStore);
  const awake = ledger(RunStore);
  slept.store.startTicker();
  awake.store.startTicker();
  assert.deepEqual([slept.pending(), awake.pending()], [[30 * SEC], [30 * SEC]], "默认每 30 秒核对一次,同时只排一拍");
  const a = turn(slept);
  const b = turn(awake);
  for (const l of [slept, awake]) l.beat(30 * SEC);
  slept.at(40 * SEC);
  slept.store.activity(a.id, { kind: "model_call" });
  awake.at(40 * SEC);
  awake.store.activity(b.id, { kind: "model_call" });
  for (const l of [slept, awake]) l.beat(60 * SEC);
  // 60 秒那一拍之后合盖,下一拍在 175 秒才跑(间隔 115 秒):调用已发出 135 秒,超过首字节窗口,但其中 85 秒是休眠
  slept.beat(175 * SEC);
  assert.deepEqual(judged(slept, a.id), [], "醒来那一拍不判 no_response");
  assert.equal(waitingOf(slept, a.id), "sleep_grace");
  const sleptAt: string[] = [];
  for (let s = 205; s <= 355; s += 30) {
    slept.beat(s * SEC);
    if (judged(slept, a.id).length && !sleptAt.length) sleptAt.push(`${s}s`);
  }
  assert.deepEqual(judged(slept, a.id), ["no_response@355s/120s"], "宽限 3 分钟(到 355 秒)过后仍没回应,在下一拍照常判");
  assert.deepEqual(sleptAt, ["355s"]);
  assert.equal(slept.store.countEvents([a.id], "stall-judged", (d) => d.kind === "no_response"), 1, "之后的拍不重复判");
  // 对照:同样 40 秒发出的调用不合盖,每 30 秒核对,过了 120 秒窗口的第一拍(180 秒)就判,宽限门没有被正常核对间隔打开
  const awakeAt: string[] = [];
  for (let s = 90; s <= 210; s += 30) {
    awake.beat(s * SEC);
    assert.notEqual(waitingOf(awake, b.id), "sleep_grace", `${s} 秒不在休眠宽限里`);
    if (judged(awake, b.id).length && !awakeAt.length) awakeAt.push(`${s}s`);
  }
  assert.deepEqual(judged(awake, b.id), ["no_response@180s/120s"]);
  assert.deepEqual(awakeAt, ["180s"]);
  assert.equal(awake.store.countEvents([b.id], "stall-judged", (d) => d.kind === "no_response"), 1, "之后的拍不重复判");
  for (const l of [slept, awake]) {
    assert.equal(l.pending().length, 1, "每拍核对后只重排一拍");
    l.store.stopTicker();
    assert.deepEqual(l.pending(), [], "停核对后不留计时器");
    l.close();
  }
});

test("F11 宿主刚启动、第一拍核对前就合盖:构造时刻也算一次采样,第一拍(120 秒)就检出醒来,不判首字节超时", () => {
  const l = ledger(RunStore);
  l.store.startTicker();
  const u = turn(l);
  l.store.activity(u.id, { kind: "model_call" });
  // 构造后立刻发出调用,第一拍本该在 30 秒,合盖到 120 秒才跑:和构造时刻比相隔 120 秒,是休眠
  l.beat(120 * SEC);
  assert.deepEqual(judged(l, u.id), [], "第一拍不判 no_response");
  assert.equal(l.store.countEvents([u.id], "stall-judged", () => true), 0);
  assert.equal(waitingOf(l, u.id), "sleep_grace");
  l.close();
});

test("F11 时钟跳变 +10 分钟、宽限按给的参数 5 分钟:宽限期内不判卡死、显示休眠宽限,宽限过后真停滞按阈值判 stalled", () => {
  const l = ledger(RunStore, { wake: { jumpMs: 60 * SEC, graceMs: 5 * MIN }, thresholds: () => ({ defaults: { stallMs: MIN, firstByteMs: 20 * SEC } }) });
  l.store.startTicker();
  const u = turn(l);
  l.beat(30 * SEC);
  l.at(50 * SEC);
  l.store.activity(u.id, { kind: "progress", what: "output" });
  l.beat(60 * SEC);
  assert.deepEqual(judged(l, u.id), []);
  // 合盖 10 分钟:下一拍在 660 秒
  l.beat(660 * SEC);
  const graceAt: string[] = [];
  for (let s = 660; s <= 960; s += 30) {
    if (s > 660) l.beat(s * SEC);
    if (waitingOf(l, u.id) === "sleep_grace") graceAt.push(`${s}`);
  }
  assert.deepEqual(graceAt, ["660", "690", "720", "750", "780", "810", "840", "870", "900", "930"], "醒来后 5 分钟内都是休眠宽限");
  assert.deepEqual(judged(l, u.id), ["stalled@960s/60s"], "宽限 5 分钟到 960 秒结束,当拍按 1 分钟阈值判 stalled");
  assert.equal(l.store.countEvents([u.id], "stall-judged", (d) => d.kind === "stalled"), 1);
  const ev = l.store.events(u.id).find((e) => e.kind === "stall-judged")!.detail as { thresholdSource: string; lastProgressAt: string };
  assert.deepEqual([ev.thresholdSource, Date.parse(ev.lastProgressAt) / SEC], ["default", 50]);
  l.close();
});

/** 构造的结果:成功返回 ok,HostError 返回「code:message」,其他错误原样转成字符串 */
function outcome(build: () => void): string {
  try {
    build();
    return "ok";
  } catch (e) {
    return e instanceof HostError ? `${e.code}:${e.message}` : `other:${String(e)}`;
  }
}
type Clock = { ms: () => number; iso: () => string; advance: (d: number) => void };
function fakeClock(): Clock {
  let t = Date.parse("2026-11-10T02:00:00.000Z");
  return {
    ms: () => t,
    iso: () => new Date(t).toISOString(),
    advance: (d) => {
      t += d;
    },
  };
}
const hosts: Host[] = [];
after(async () => {
  for (const h of hosts) await Promise.race([h.close().catch(() => {}), sleep(2000)]);
});
/** 建宿主:被测类作为参数传入;时钟可拨,核对周期默认 10 毫秒,自动重试 0 次(失败当场出原位卡) */
function mk(H: typeof Host, clock: Clock, o: Partial<HostOptions> & Pick<HostOptions, "mind">): Host {
  const h = new H({ file: file(), clockMs: clock.ms, now: clock.iso, runCheckMs: 10, maxDeferMs: 5, retry: { maxAutoRetries: 0 }, ...o });
  hosts.push(h);
  return h;
}

test("F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动", () => {
  const bad = /^invalid_params:休眠门参数不合格:jumpMs 必须是正数、graceMs 必须是非负整数$/;
  assert.match(outcome(() => ledger(RunStore, { wake: { jumpMs: 0, graceMs: 0 } }).close()), bad);
  assert.match(outcome(() => ledger(RunStore, { wake: { jumpMs: 60 * SEC, graceMs: -1 } }).close()), bad);
  assert.match(outcome(() => ledger(RunStore, { wake: { jumpMs: 60 * SEC, graceMs: 0.5 } }).close()), bad);
  // 正常核对的间隔本来就有一个周期,跳变阈值低于 2 个周期,正常核对也会被当成刚醒来,宽限门会一直开着
  assert.equal(
    outcome(() => ledger(RunStore, { checkMs: 30 * SEC, wake: { jumpMs: 59_999, graceMs: 180 * SEC } }).close()),
    "invalid_params:休眠门参数不合格:jumpMs(59999 毫秒)不得小于核对周期的 2 倍(60000 毫秒),否则正常核对的间隔也会被当成休眠唤醒",
  );
  assert.equal(
    outcome(() => ledger(RunStore, { checkMs: 61 * SEC }).close()),
    "invalid_params:休眠门参数不合格:jumpMs(60000 毫秒)不得小于核对周期的 2 倍(122000 毫秒),否则正常核对的间隔也会被当成休眠唤醒",
    "只改核对周期、沿用默认跳变 60 秒也要拒",
  );
  assert.equal(outcome(() => ledger(RunStore, { checkMs: 30 * SEC, wake: { jumpMs: 60 * SEC, graceMs: 0 } }).close()), "ok", "恰好 2 倍可以");
  const clock = fakeClock();
  const mind = () => scriptedMind();
  assert.match(outcome(() => void mk(Host, clock, { mind, runWakePolicy: { graceMs: -1 } })), bad);
  assert.equal(
    outcome(() => void mk(Host, clock, { mind, runCheckMs: 40 * SEC })),
    "invalid_params:休眠门参数不合格:jumpMs(60000 毫秒)不得小于核对周期的 2 倍(80000 毫秒),否则正常核对的间隔也会被当成休眠唤醒",
  );
  assert.equal(outcome(() => void mk(Host, clock, { mind, runCheckMs: 40 * SEC, runWakePolicy: { jumpMs: 80 * SEC } })), "ok", "宿主的 runWakePolicy 透传给台账");
});

// ---------------- 宿主级:宽限不挡确定不会自愈的错误和人停的 ----------------
const started = { kind: "started", sessionId: "s", resumed: false } as const;
const runsOf = (host: Host, layer: string) => host.listRuns({}).runs.filter((r) => r.layer === layer);
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 400; i++) {
    await Promise.race([host.idle(), sleep(50)]);
    await sleep(5);
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await sleep(15);
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
async function waitFor(pred: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error(`没等到:${what}`);
}
/** 派一个 Compute 任务、发出模型调用后合盖 2 分钟,醒来后再过 5 分钟(超过默认宽限 3 分钟,仍在宿主设的 10 分钟宽限里) */
async function inGrace(H: typeof Host) {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(H, clock, { mind: () => scriptedMind(), compute: () => compute.adapter, runWakePolicy: { jumpMs: 60 * SEC, graceMs: 10 * MIN } });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我查一下天气" });
  await settle(host, compute);
  const t = runsOf(host, "compute-turn")[0]!;
  compute.pushActivity({ computeId: "cp-1", kind: "model_call" });
  await waitFor(() => host.runs.get(t.id)?.progress.awaitingSince !== null, "记下调用发出");
  clock.advance(2 * MIN);
  await sleep(40);
  for (let i = 0; i < 10; i++) {
    clock.advance(30 * SEC);
    await sleep(30);
  }
  const v = host.getRun(t.id).run;
  assert.deepEqual([v.status, v.waiting], ["running", "sleep_grace"], "醒来 5 分钟仍在宿主设的 10 分钟宽限里,没判卡死");
  return { host, compute, dm, turn: v };
}

test("F11 宽限期内 harness 报 401:不等宽限,当场停这一轮并记 auth_or_quota,任务走 ExecFailed", async () => {
  const { host, compute, dm, turn: t } = await inGrace(Host);
  compute.pushActivity({ computeId: "cp-1", kind: "retry", error: "API 重试 第 1/10 次:API Error: 401 invalid x-api-key", httpStatus: 401 });
  await waitFor(() => host.getRun(t.id).run.status === "failed", "当场判失败");
  await settle(host, compute);
  const v = host.getRun(t.id).run;
  assert.deepEqual([v.reasonClass, v.retryClass, v.thresholdMs, v.judgedAt], ["auth_or_quota", "Permanent", null, null], "不是卡死判定,是确定不会自愈的错误");
  assert.deepEqual(compute.stopped, ["cp-1"]);
  assert.equal(host.listTasks({ roomId: dm.id })[0]!.state, "T11_Failed");
  compute.close();
  await host.close();
});

test("F11 宽限期内用户停任务:记人停的 user_stopped、显示已停止,不被宽限挡住也不记成失败", async () => {
  const { host, compute, turn: t } = await inGrace(Host);
  host.stopTask(t.taskId!, host.userId);
  await settle(host, compute);
  const v = host.getRun(t.id).run;
  assert.deepEqual([v.status, v.reasonClass, v.tone, v.text], ["interrupted", "user_stopped", "stopped", "已停止"]);
  assert.deepEqual(compute.stopped, ["cp-1"]);
  compute.close();
  await host.close();
});
