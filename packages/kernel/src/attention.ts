// 联系人注意循环的单飞调度器(AC-31 ②,需求文档 D15.1「唯一消息入口」)。
// 只管「什么时候跑下一轮」,不读消息正文:
//   - 每位联系人同一时刻最多一轮在跑(单飞);跑的期间新来的通知只记一个「脏」标记,本轮结束后立刻补跑一轮,不并发、不丢;
//   - urgency=now(被 @、私聊、Compute 终态/受阻、用户控制指令)立刻跑;urgency=batch(群里未 @ 的消息、进度里程碑)攒批,
//     最迟 maxDeferMs 后必跑(有界攒批,防无限延期);
//   - 一轮返回 "stale"(发送前检出更新的用户消息,AC-31 ④)就立刻重跑,连续 stale 超过 maxStaleReruns 次后按 "done" 处理并报告,防止活锁;
//   - 一轮抛错不影响别的联系人,也不丢脏标记:报告后按 retryMs 退避重试。
// 计时器、时钟都可注入,测试用假计时器逐步推进。

export type Urgency = "now" | "batch";
export type RoundStatus = "done" | "stale";

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AttentionOptions {
  /** 跑某位联系人的一轮。宿主在里面读游标、装配、调模型、发送前检查、原子落盘。 */
  readonly run: (contactId: string, signal: AbortSignal) => Promise<RoundStatus>;
  /** 未 @ 消息的攒批上界(毫秒)。 */
  readonly maxDeferMs: number;
  /** 一轮抛错后多久重试(毫秒),默认 1000。 */
  readonly retryMs?: number;
  /** 一轮抛错后多久重试(AC-36);返回 null 表示不自动重跑。 */
  readonly retryAfter?: (contactId: string, error: unknown) => number | null;
  /** 连续 stale 的重跑上限,默认 3。 */
  readonly maxStaleReruns?: number;
  readonly timers?: TimerApi;
  /** 报告:一轮出错、stale 超限。不抛出。 */
  readonly onReport?: (contactId: string, what: "error" | "stale-limit", detail: unknown) => void;
}

export interface AttentionLoop {
  /** 有新输入送达这位联系人。 */
  notify(contactId: string, urgency: Urgency): void;
  /** 当前有没有在跑或排着的轮次(给 CLI/测试等待用)。 */
  busy(): boolean;
  /** 等到所有联系人都空闲(没有在跑、没有排队、没有攒批计时器)。 */
  idle(): Promise<void>;
  /** 停止:中止在跑的轮次,清掉计时器;之后的 notify 忽略。 */
  stop(): Promise<void>;
  /** 某位联系人跑过的轮次数(观测用)。 */
  rounds(contactId: string): number;
}

interface Slot {
  running: Promise<void> | null;
  controller: AbortController | null;
  dirty: Urgency | null;
  timer: unknown;
  timerDue: "batch" | "retry" | null;
  staleRuns: number;
  count: number;
}

export function createAttentionLoop(opts: AttentionOptions): AttentionLoop {
  if (!(opts.maxDeferMs >= 0) || !Number.isFinite(opts.maxDeferMs)) throw new RangeError("maxDeferMs 必须是有限非负数");
  const timers = opts.timers ?? realTimers;
  const retryMs = opts.retryMs ?? 1000;
  const maxStale = opts.maxStaleReruns ?? 3;
  const slots = new Map<string, Slot>();
  let stopped = false;
  let waiters: (() => void)[] = [];

  const slot = (id: string): Slot => {
    let s = slots.get(id);
    if (!s) {
      s = { running: null, controller: null, dirty: null, timer: null, timerDue: null, staleRuns: 0, count: 0 };
      slots.set(id, s);
    }
    return s;
  };
  const report = (id: string, what: "error" | "stale-limit", detail: unknown) => {
    try {
      opts.onReport?.(id, what, detail);
    } catch {
      /* 报告回调出错不影响调度 */
    }
  };
  const isBusy = () => [...slots.values()].some((s) => s.running !== null || s.timer !== null || s.dirty !== null);
  const settleWaiters = () => {
    if (isBusy()) return;
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const clearTimer = (s: Slot) => {
    if (s.timer !== null) timers.clear(s.timer);
    s.timer = null;
    s.timerDue = null;
  };
  const arm = (id: string, s: Slot, ms: number, due: "batch" | "retry") => {
    s.timerDue = due;
    s.timer = timers.set(() => {
      s.timer = null;
      s.timerDue = null;
      start(id);
    }, ms);
  };

  const start = (id: string): void => {
    if (stopped) return;
    const s = slot(id);
    if (s.running) return;
    clearTimer(s);
    s.dirty = null;
    const controller = new AbortController();
    s.controller = controller;
    s.count++;
    s.running = (async () => {
      let status: RoundStatus | "error" = "done";
      try {
        status = await opts.run(id, controller.signal);
      } catch (e) {
        status = "error";
        report(id, "error", e);
      }
      s.running = null;
      s.controller = null;
      if (stopped) return settleWaiters();
      if (status === "stale") {
        s.staleRuns++;
        if (s.staleRuns <= maxStale) {
          start(id);
          return;
        }
        report(id, "stale-limit", s.staleRuns);
      }
      s.staleRuns = 0;
      if (status === "error") {
        // 出错的这轮没推进游标,输入还在;退避后重跑。期间来的 now 通知照样能提前触发。
        if (s.timer === null) arm(id, s, retryMs, "retry");
        s.dirty = null;
        return settleWaiters();
      }
      const pending = s.dirty;
      if (pending === "now") start(id);
      else if (pending === "batch") {
        s.dirty = null;
        if (s.timer === null) arm(id, s, opts.maxDeferMs, "batch");
      }
      settleWaiters();
    })();
  };

  return {
    notify(contactId, urgency) {
      if (stopped) return;
      if (urgency !== "now" && urgency !== "batch") throw new TypeError(`未知紧急度 ${String(urgency)}`);
      const s = slot(contactId);
      if (s.running) {
        if (urgency === "now" || s.dirty === null) s.dirty = urgency;
        return;
      }
      if (urgency === "now") {
        start(contactId);
        return;
      }
      // batch:已有计时器(攒批或退避)就沿用,不推迟——最迟 maxDeferMs 必跑
      if (s.timer === null) arm(contactId, s, opts.maxDeferMs, "batch");
    },
    busy: isBusy,
    idle() {
      if (!isBusy()) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    async stop() {
      stopped = true;
      const running: Promise<void>[] = [];
      for (const s of slots.values()) {
        clearTimer(s);
        s.dirty = null;
        s.controller?.abort();
        if (s.running) running.push(s.running);
      }
      await Promise.allSettled(running);
      for (const s of slots.values()) s.running = null;
      settleWaiters();
    },
    rounds(contactId) {
      return slots.get(contactId)?.count ?? 0;
    },
  };
}
