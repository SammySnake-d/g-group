// 联系人注意循环的单飞调度器(AC-31 ②,需求文档 D15.1「唯一消息入口」)。
//   - 一轮返回 "stale"(发送前检出更新的用户消息,AC-31 ④)就立刻重跑,连续 stale 超过 maxStaleReruns 次后按 "done" 处理并报告,防止活锁;
//   - 一轮抛错不影响别的联系人,也不丢脏标记:报告后按 retryAfter 给的延迟退避重试(AC-36:宿主按失败策略算,返回 null 表示不再自动重试,

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
  readonly maxDeferMs: number;
  readonly retryMs?: number;
  /**
   * 一轮抛错后多久重试(AC-36):返回毫秒数就按它退避重跑;返回 null 就不自动重跑(失败已出卡或被共享熔断暂停,
   * 等用户处理或宿主显式 notify)。自身抛错或返回非法值时按 retryMs。
   */
  readonly retryAfter?: (contactId: string, error: unknown) => number | null;
  readonly maxStaleReruns?: number;
  readonly timers?: TimerApi;
  readonly onReport?: (contactId: string, what: "error" | "stale-limit", detail: unknown) => void;
}

export interface AttentionLoop {
  notify(contactId: string, urgency: Urgency): void;
  busy(): boolean;
  idle(): Promise<void>;
  stop(): Promise<void>;
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

function validDelay(ms: unknown, retryMs: number): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : retryMs;
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
  const delayAfter = (id: string, e: unknown): number | null => {
    if (!opts.retryAfter) return retryMs;
    try {
      const ms = opts.retryAfter(id, e);
      if (ms === null) return null;
      return validDelay(ms, retryMs);
    } catch {
      return retryMs;
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
      let failure: unknown;
      try {
        status = await opts.run(id, controller.signal);
      } catch (e) {
        status = "error";
        failure = e;
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
        // 出错的这轮没推进游标,输入还在;按失败策略退避后重跑,或者不再自动重跑。期间来的 now 通知照样能提前触发。
        const ms = delayAfter(id, failure);
        if (ms !== null && s.timer === null) arm(id, s, ms, "retry");
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
