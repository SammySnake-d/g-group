// 运行台账的宿主侧(需求文档 D26 第 3–5、8 节,AC-43;AC-14 停滞事件的底座)。纯规则在 @g-group/kernel 的 run-ledger.ts,这里只管:
//   - 落盘:gg_runs 存每个单元的当前态(整行 JSON + 查询用的列),gg_run_events 只追加,记每次状态变化、卡死判定与重跑,gg_run_leases 是重跑租约;
//   - 内存里保留在跑单元的最新进展(harness 每个事件都记,落盘按间隔合并;状态变化立即落盘);
//   - 周期核对(计时器与时钟可注入):在跑轮次到阈值判卡死,交给宿主先停这一轮再写失败;同一启动里进程已不在的成孤儿;
//   - 启动核对:上一次启动留下的在跑单元改成 orphaned「宿主进程退出」;
//   - 父单元自己的活做完、子单元还在跑时等子单元(不记 done);子孙都结束后再 done;
//   - 查询按可见范围机械过滤(不看联系人自报),画板和联系人读的是同一份。
import type { RunHint, RunView } from "@g-group/api-contract";
import {
  type NewRun,
  type RunActivity,
  type RunFailure,
  type RunStatus,
  type RunUnit,
  type RunViewer,
  type StallVerdict,
  type ThresholdConfig,
  type TimerApi,
  type Transition,
  DEFAULT_SLEEP_GRACE_MS,
  failureGroups,
  isLiveRun,
  newRun,
  noteActivity,
  reconcileOrphans,
  resolveThresholds,
  runDisplay,
  setStatus,
  stallCheck,
  visibleRuns,
} from "@g-group/kernel";
import { type Db, all, one, run, tx } from "./db.ts";

const RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_runs (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, room_id TEXT NOT NULL, contact_id TEXT NOT NULL, task_id TEXT, compute_id TEXT,
  status TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_runs_root ON gg_runs (root_id);
CREATE INDEX IF NOT EXISTS gg_runs_room ON gg_runs (room_id);
CREATE INDEX IF NOT EXISTS gg_runs_parent ON gg_runs (parent_id);
CREATE INDEX IF NOT EXISTS gg_runs_status ON gg_runs (status);
CREATE TABLE IF NOT EXISTS gg_run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gg_run_events_run ON gg_run_events (run_id);
CREATE TABLE IF NOT EXISTS gg_run_leases (run_id TEXT PRIMARY KEY, holder TEXT NOT NULL, until_ms INTEGER NOT NULL);
`;
const LIVE_SQL = "('queued','running','waiting_user')";
/** 默认核对周期 */
export const DEFAULT_RUN_CHECK_MS = 30_000;

export interface RunStoreOptions {
  readonly db: Db;
  /** 本次宿主启动号 */
  readonly bootId: string;
  readonly clockMs: () => number;
  readonly timers: TimerApi;
  readonly newId: (prefix: string) => string;
  /** 卡死阈值配置(默认 15 分钟 / 120 秒;可按联系人或按上游单独设) */
  readonly thresholds: () => ThresholdConfig;
  readonly checkMs?: number;
  readonly sleepGraceMs?: number;
  /** 同一启动里核对执行进程是否还在;不给就只核对启动号 */
  readonly alive?: (pid: number) => boolean;
  /** 在跑单元的进展落盘最短间隔,默认 5 秒 */
  readonly persistEveryMs?: number;
  /** 单元状态变化已落盘 */
  readonly changed?: (units: readonly RunUnit[]) => void;
  /** 判出卡死:宿主先停这一轮,再调 failStalled 写失败 */
  readonly stalled?: (unit: RunUnit, verdict: StallVerdict) => void;
}

export interface RunEventRow {
  readonly runId: string;
  readonly kind: string;
  readonly detail: unknown;
  readonly at: string;
}

export class RunStore {
  private readonly opts: RunStoreOptions;
  private readonly db: Db;
  /** 在跑单元(权威,进展最新) */
  private readonly live = new Map<string, RunUnit>();
  private readonly persistedAt = new Map<string, number>();
  /** 自己的活已做完、在等子单元结束的单元 */
  private readonly settled = new Set<string>();
  /** 已判卡死、等宿主写失败的单元(不重复判) */
  private readonly judging = new Set<string>();
  private timer: unknown = null;
  private lastTick: number;
  private awakeSince: number | null = null;
  readonly checkMs: number;

  constructor(opts: RunStoreOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.db.store.db.exec(RUN_SCHEMA);
    this.checkMs = opts.checkMs ?? DEFAULT_RUN_CHECK_MS;
    for (const r of all<{ unit: string; settled: number }>(this.db, `SELECT unit, settled FROM gg_runs WHERE status IN ${LIVE_SQL} ORDER BY rowid`)) {
      const u = JSON.parse(r.unit) as RunUnit;
      this.live.set(u.id, u);
      if (r.settled) this.settled.add(u.id);
    }
    this.lastTick = opts.clockMs();
  }

  private iso(ms: number) {
    return new Date(ms).toISOString();
  }
  private now() {
    return this.opts.clockMs();
  }
  private writeTx(u: RunUnit) {
    const root = u.parentId ? (one<{ root_id: string }>(this.db, "SELECT root_id FROM gg_runs WHERE id = ?", u.parentId)?.root_id ?? u.parentId) : u.id;
    run(
      this.db,
      "INSERT INTO gg_runs (id, root_id, parent_id, room_id, contact_id, task_id, compute_id, status, settled, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET status = excluded.status, settled = excluded.settled, unit = excluded.unit, updated_at = excluded.updated_at",
      u.id,
      root,
      u.parentId,
      u.roomId,
      u.contactId,
      u.taskId,
      u.computeId,
      u.status,
      this.settled.has(u.id) ? 1 : 0,
      JSON.stringify(u),
      this.iso(this.now()),
    );
    this.persistedAt.set(u.id, this.now());
  }
  private eventTx(runId: string, kind: string, detail: unknown) {
    run(this.db, "INSERT INTO gg_run_events (run_id, kind, detail, at) VALUES (?, ?, ?, ?)", runId, kind, JSON.stringify(detail ?? {}), this.iso(this.now()));
  }
  private notify(units: readonly RunUnit[]) {
    if (!units.length) return;
    try {
      this.opts.changed?.(units);
    } catch {
      /* 回调出错不影响台账 */
    }
  }

  /** 记一个新单元(在跑)。parentId 必须是已有单元 */
  start(input: Omit<NewRun, "bootId" | "at" | "id"> & { readonly id?: string }): RunUnit {
    const u = newRun({ ...input, id: input.id ?? this.opts.newId("run"), bootId: this.opts.bootId, at: this.now() });
    tx(this.db, () => {
      this.writeTx(u);
      this.eventTx(u.id, "start", { layer: u.layer, parentId: u.parentId, roomId: u.roomId, sourceSeq: u.sourceSeq, contactId: u.contactId, taskId: u.taskId, computeId: u.computeId, upstream: u.upstream, rerunOf: u.rerunOf, attempt: u.attempt, bootId: u.bootId });
    });
    if (isLiveRun(u.status)) this.live.set(u.id, u);
    this.notify([u]);
    return u;
  }

  /** harness 的一件事:只改内存里的进展,按间隔落盘(重试公告、心跳都不算进展,由 noteActivity 判) */
  activity(id: string, a: RunActivity): RunUnit | null {
    const u = this.live.get(id);
    if (!u) return null;
    const next = noteActivity(u, a, this.now());
    if (next === u) return u;
    this.live.set(id, next);
    if (this.now() - (this.persistedAt.get(id) ?? 0) >= (this.opts.persistEveryMs ?? 5000)) tx(this.db, () => this.writeTx(next));
    return next;
  }

  get(id: string): RunUnit | null {
    const l = this.live.get(id);
    if (l) return l;
    const r = one<{ unit: string }>(this.db, "SELECT unit FROM gg_runs WHERE id = ?", id);
    return r ? (JSON.parse(r.unit) as RunUnit) : null;
  }
  private load(where: string, ...params: (string | number | null)[]): RunUnit[] {
    return all<{ unit: string; id: string }>(this.db, `SELECT id, unit FROM gg_runs ${where} ORDER BY rowid`, ...params).map((r) => this.live.get(r.id) ?? (JSON.parse(r.unit) as RunUnit));
  }
  /** 同一棵树(同根)的全部单元 */
  private family(id: string): RunUnit[] {
    const root = one<{ root_id: string }>(this.db, "SELECT root_id FROM gg_runs WHERE id = ?", id)?.root_id;
    return root ? this.load("WHERE root_id = ?", root) : [];
  }
  /** 全部单元(可按会话、联系人过滤),在跑的用内存里最新的进展 */
  list(filter: { readonly roomId?: string; readonly contactId?: string } = {}): RunUnit[] {
    const conds: string[] = [];
    const params: string[] = [];
    if (filter.roomId) {
      conds.push("room_id = ?");
      params.push(filter.roomId);
    }
    if (filter.contactId) {
      conds.push("contact_id = ?");
      params.push(filter.contactId);
    }
    return this.load(conds.length ? `WHERE ${conds.join(" AND ")}` : "", ...params);
  }
  visible(viewer: RunViewer, filter: { readonly roomId?: string; readonly contactId?: string } = {}): RunUnit[] {
    return [...visibleRuns(this.list(viewer.kind === "contact" ? { ...filter, roomId: viewer.roomId } : filter), viewer)];
  }
  childIds(id: string): string[] {
    return all<{ id: string }>(this.db, "SELECT id FROM gg_runs WHERE parent_id = ? ORDER BY rowid", id).map((r) => r.id);
  }
  liveByCompute(computeId: string): RunUnit[] {
    return [...this.live.values()].filter((u) => u.computeId === computeId);
  }
  liveByTask(taskId: string): RunUnit[] {
    return [...this.live.values()].filter((u) => u.taskId === taskId);
  }
  events(runId: string, limit = 50): RunEventRow[] {
    return all<{ run_id: string; kind: string; detail: string; at: string }>(this.db, "SELECT * FROM (SELECT * FROM gg_run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id", runId, limit).map((r) => ({
      runId: r.run_id,
      kind: r.kind,
      detail: JSON.parse(r.detail) as unknown,
      at: r.at,
    }));
  }
  /** 一个单元某种事件的条数(重跑次数等) */
  countEvents(runIds: readonly string[], kind: string, where: (detail: Record<string, unknown>) => boolean): number {
    let n = 0;
    for (const id of runIds) for (const e of this.events(id, 10_000)) if (e.kind === kind && where(e.detail as Record<string, unknown>)) n++;
    return n;
  }
  addEvent(runId: string, kind: string, detail: unknown) {
    tx(this.db, () => this.eventTx(runId, kind, detail));
  }
  /** 必须在调用方的事务里调用 */
  addEventTx(runId: string, kind: string, detail: unknown) {
    this.eventTx(runId, kind, detail);
  }

  /** 改状态(含级联成孤儿的子孙),整批落盘、每个单元记一条事件;被拒绝(终态、子单元在跑等)原样返回 */
  setStatus(id: string, to: RunStatus, extra: { readonly failure?: RunFailure; readonly note?: string; readonly verdict?: StallVerdict } = {}, detail: Record<string, unknown> = {}): Transition {
    const fam = this.family(id);
    const r = setStatus(fam, id, to, this.now(), extra);
    if (!r.ok) return r;
    tx(this.db, () => {
      for (const c of r.changed) {
        if (!isLiveRun(c.status)) this.settled.delete(c.id);
        this.writeTx(c);
        this.eventTx(c.id, "status", {
          to: c.status,
          ...(c.id === id ? detail : { cascadeFrom: id }),
          ...(c.failure ? { reasonClass: c.failure.reasonClass, retryClass: c.failure.retryClass, label: c.failure.label, raw: c.failure.raw, rulesVersion: c.failure.rulesVersion } : {}),
          ...(c.note ? { note: c.note } : {}),
          ...(c.verdict ? { lastProgressAt: this.iso(c.verdict.lastProgressAt), judgedAt: this.iso(c.verdict.judgedAt), durationMs: c.verdict.durationMs, thresholdMs: c.verdict.thresholdMs, thresholdSource: c.verdict.thresholdSource } : {}),
        });
      }
    });
    for (const c of r.changed) {
      if (isLiveRun(c.status)) this.live.set(c.id, c);
      else {
        this.live.delete(c.id);
        this.judging.delete(c.id);
      }
    }
    this.notify(r.changed);
    for (const c of r.changed) if (!isLiveRun(c.status) && c.parentId) this.finishWaitingParent(c.parentId);
    return r;
  }

  /** 结束一个单元:还在跑的子单元先标 orphaned(写明所属单元已结束),再改它自己的状态 */
  end(id: string, to: "done" | "failed" | "interrupted", extra: { readonly failure?: RunFailure; readonly verdict?: StallVerdict } = {}, detail: Record<string, unknown> = {}): Transition {
    const u = this.live.get(id);
    if (!u) return { ok: false, reason: this.get(id) ? "terminal" : "not-found" };
    for (const cid of this.childIds(id)) if (this.live.has(cid)) this.setStatus(cid, "orphaned", { note: "所属单元已结束,结束情况未知" });
    return this.setStatus(id, to, extra, detail);
  }

  /** 单元自己的活做完了:没有在跑的子孙就 done,否则等子孙都结束(父子一致:子单元在跑,父单元不记 done) */
  settle(id: string, detail: Record<string, unknown> = {}) {
    const u = this.live.get(id);
    if (!u) return;
    if (this.liveDescendants(id).length === 0) {
      this.setStatus(id, "done", {}, detail);
      return;
    }
    this.settled.add(id);
    tx(this.db, () => {
      this.writeTx(u);
      this.eventTx(id, "settled", { ...detail, waitingFor: this.liveDescendants(id) });
    });
  }
  isSettled(id: string) {
    return this.settled.has(id);
  }
  private liveDescendants(id: string): string[] {
    const out: string[] = [];
    const walk = (pid: string) => {
      for (const cid of this.childIds(pid)) {
        if (this.live.has(cid)) out.push(cid);
        walk(cid);
      }
    };
    walk(id);
    return out;
  }
  private finishWaitingParent(parentId: string) {
    if (this.settled.has(parentId) && this.liveDescendants(parentId).length === 0) this.setStatus(parentId, "done", {}, { note: "子单元都已结束" });
  }

  /** 启动核对:上一次启动留下的在跑单元一律改成 orphaned「宿主进程退出」 */
  reconcileBoot(): RunUnit[] {
    const changed = reconcileOrphans([...this.live.values()], { bootId: this.opts.bootId, at: this.now(), alive: () => true });
    this.persistOrphans(changed, "boot");
    return [...changed];
  }
  private persistOrphans(changed: readonly RunUnit[], why: string) {
    if (!changed.length) return;
    tx(this.db, () => {
      for (const c of changed) {
        this.settled.delete(c.id);
        this.writeTx(c);
        this.eventTx(c.id, "status", { to: "orphaned", note: c.note, by: why });
      }
    });
    for (const c of changed) {
      this.live.delete(c.id);
      this.judging.delete(c.id);
    }
    this.notify(changed);
  }

  /** 一个核对周期:时钟跳变记休眠唤醒;同一启动里进程已不在的成孤儿;在跑的轮次判卡死 */
  tick(): void {
    const now = this.now();
    if (now - this.lastTick > this.checkMs * 2 + 60_000) this.awakeSince = now;
    this.lastTick = now;
    if (this.opts.alive) this.persistOrphans(reconcileOrphans([...this.live.values()], { bootId: this.opts.bootId, at: now, alive: this.opts.alive }), "pid");
    for (const u of [...this.live.values()]) {
      if (this.judging.has(u.id) || this.settled.has(u.id)) continue;
      const th = resolveThresholds(this.opts.thresholds(), u.contactId, u.upstream);
      const c = stallCheck(u, now, th, { awakeSince: this.awakeSince, graceMs: this.opts.sleepGraceMs ?? DEFAULT_SLEEP_GRACE_MS });
      if (!c.verdict) continue;
      this.judging.add(u.id);
      this.addEvent(u.id, "stall-judged", {
        kind: c.verdict.kind,
        reasonClass: c.verdict.failure.reasonClass,
        raw: c.verdict.failure.raw,
        lastProgressAt: this.iso(c.verdict.lastProgressAt),
        judgedAt: this.iso(c.verdict.judgedAt),
        thresholdMs: c.verdict.thresholdMs,
        thresholdSource: c.verdict.thresholdSource,
        rulesVersion: c.verdict.failure.rulesVersion,
      });
      try {
        this.opts.stalled?.(u, c.verdict);
      } catch {
        /* 宿主处理出错不影响别的单元的核对 */
      }
    }
  }
  /** 宿主停完这一轮后写失败 */
  failStalled(id: string, verdict: StallVerdict): Transition {
    const r = this.end(id, "failed", { failure: verdict.failure, verdict }, { stall: verdict.kind });
    this.judging.delete(id);
    return r;
  }
  thresholdsFor(contactId: string, upstream: string | null) {
    return resolveThresholds(this.opts.thresholds(), contactId, upstream);
  }
  /** 在跑单元此刻的合法等待与已计入的无进展时长(画板「N 分钟无进展」用) */
  liveCheck(u: RunUnit): { waiting: RunView["waiting"]; idleMs: number } {
    if (!isLiveRun(u.status)) return { waiting: null, idleMs: 0 };
    if (this.settled.has(u.id)) return { waiting: "children", idleMs: 0 };
    const c = stallCheck(u, this.now(), resolveThresholds(this.opts.thresholds(), u.contactId, u.upstream), { awakeSince: this.awakeSince, graceMs: this.opts.sleepGraceMs ?? DEFAULT_SLEEP_GRACE_MS });
    return { waiting: c.waiting, idleMs: Math.max(0, Math.round(c.idleMs)) };
  }
  /** 起周期核对。计时器不单独撑住进程(unref):宿主关了或测试结束,不因为它挂着 */
  startTicker() {
    if (this.timer !== null) return;
    const loop = () => {
      this.timer = this.opts.timers.set(() => {
        this.timer = null;
        try {
          this.tick();
        } finally {
          loop();
        }
      }, this.checkMs);
      (this.timer as { unref?: () => void } | null)?.unref?.();
    };
    loop();
  }
  stopTicker() {
    if (this.timer !== null) this.opts.timers.clear(this.timer);
    this.timer = null;
  }

  /** 重跑租约(CAS):没有租约或已过期才领得到;同一单元同时只有一个重跑 */
  claimLeaseTx(runId: string, holder: string, untilMs: number): boolean {
    return run(this.db, "INSERT INTO gg_run_leases (run_id, holder, until_ms) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET holder = excluded.holder, until_ms = excluded.until_ms WHERE gg_run_leases.until_ms <= ?", runId, holder, untilMs, this.now()) === 1;
  }
  lease(runId: string): { holder: string; until: number } | null {
    const r = one<{ holder: string; until_ms: number }>(this.db, "SELECT holder, until_ms FROM gg_run_leases WHERE run_id = ?", runId);
    return r ? { holder: r.holder, until: r.until_ms } : null;
  }
  /** 重跑链:这个单元和它之前被重跑过的单元(按 rerunOf 往回找),最新的在前 */
  chain(id: string): RunUnit[] {
    const out: RunUnit[] = [];
    let cur = this.get(id);
    while (cur && !out.some((u) => u.id === cur!.id)) {
      out.push(cur);
      cur = cur.rerunOf ? this.get(cur.rerunOf) : null;
    }
    return out;
  }

  view(u: RunUnit): RunView {
    const now = this.now();
    const d = runDisplay(u, now);
    const lc = this.liveCheck(u);
    const f = u.failure;
    return {
      id: u.id,
      layer: u.layer,
      parentId: u.parentId,
      children: this.childIds(u.id),
      roomId: u.roomId,
      sourceSeq: u.sourceSeq,
      contactId: u.contactId,
      taskId: u.taskId,
      computeId: u.computeId,
      upstream: u.upstream,
      status: u.status,
      tone: d.tone,
      text: lc.waiting === "children" ? `${d.text} · 等子任务` : d.text,
      reasonClass: f?.reasonClass ?? null,
      label: f?.label ?? null,
      raw: f ? f.raw.slice(0, 20000) : null,
      retryClass: f?.retryClass ?? null,
      rulesVersion: f?.rulesVersion ?? null,
      note: u.note,
      startedAt: this.iso(u.startedAt),
      endedAt: u.endedAt === null ? null : this.iso(u.endedAt),
      durationMs: Math.max(0, Math.round((u.endedAt ?? now) - u.startedAt)),
      lastProgressAt: this.iso(u.progress.lastProgressAt),
      thresholdMs: u.verdict?.thresholdMs ?? null,
      thresholdSource: u.verdict?.thresholdSource ?? null,
      judgedAt: u.verdict ? this.iso(u.verdict.judgedAt) : null,
      waiting: lc.waiting,
      idleMs: lc.idleMs,
      rerunOf: u.rerunOf,
      attempt: u.attempt,
      updatedAt: this.iso(now),
    };
  }
  hints(units: readonly RunUnit[]): RunHint[] {
    return failureGroups(units).map((g) => ({ roomId: g.roomId, upstream: g.upstream, reasonClass: g.reasonClass, label: g.label, runIds: [...g.unitIds] }));
  }
}
