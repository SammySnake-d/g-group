// 定时:联系人在某个会话里按 cron + 时区做事(用户 #719「定时要能用 cron 表达式」;U74 常驻承诺「每天 8 点」)。
// 到点由宿主把 InboundSchedule 送进联系人的注意循环(唯一入口,不绕过联系人直通 Compute,M17/#118)。
// 错过(宿主没开、休眠)超过容差:missedPolicy=skip 记 missed 不补;run-once 只补一次,不按错过次数连发。
import type { ScheduleView } from "@g-group/api-contract";
import { type Inbound, type TimerApi, describeCron, isValidTimeZone, nextRuns, parseCron } from "@g-group/kernel";
import { type Db, HostError, all, one, run, tx } from "./db.ts";

interface Row {
  id: string;
  contact_id: string;
  room_id: string;
  title: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled: number;
  tolerance_sec: number;
  missed_policy: "skip" | "run-once";
  next_run_at: string | null;
  created_at: string;
}
export interface ScheduleInput {
  contactId: string;
  roomId: string;
  title: string;
  cron: string;
  tz: string;
  prompt: string;
  enabled?: boolean;
  toleranceSec?: number;
  missedPolicy?: "skip" | "run-once";
}
export interface SchedulerDeps {
  readonly db: Db;
  readonly clockMs: () => number;
  readonly timers: TimerApi;
  readonly newId: (p: string) => string;
  /** 校验联系人在会话里。 */
  readonly checkMember: (contactId: string, roomId: string) => void;
  /** 把触发送进联系人的注意循环。在事务里调用:写 inbox;事务后 notify。 */
  readonly deliverTx: (contactId: string, roomId: string, inbound: Inbound) => void;
  readonly notify: (contactId: string) => void;
  readonly emit: (s: ScheduleView | { removed: string }) => void;
  /** 视图里带上所属会话名与联系人名(AC-53);不存在的省略。 */
  readonly label?: (contactId: string, roomId: string) => { roomTitle?: string; contactName?: string };
}

const MAX_TIMER = 2 ** 31 - 1;
const iso = (ms: number) => new Date(ms).toISOString();

export function checkCron(cron: string, tz: string): { spec: NonNullable<Extract<ReturnType<typeof parseCron>, { ok: true }>["spec"]> } {
  const p = parseCron(cron);
  if (!p.ok) throw new HostError("invalid_params", p.error);
  if (!isValidTimeZone(tz)) throw new HostError("invalid_params", `不认识的时区 ${tz}`);
  return { spec: p.spec };
}

export function previewCron(cron: string, tz: string, count: number, nowMs: number): { valid: boolean; description: string | null; next: string[]; error: string | null } {
  const p = parseCron(cron);
  if (!p.ok) return { valid: false, description: null, next: [], error: p.error };
  if (!isValidTimeZone(tz)) return { valid: false, description: null, next: [], error: `不认识的时区 ${tz}` };
  const next = nextRuns(p.spec, tz, nowMs, count).map(iso);
  return { valid: true, description: describeCron(p.spec, tz), next, error: next.length ? null : "五年内不会触发" };
}

export class Scheduler {
  private readonly d: SchedulerDeps;
  private timer: unknown = null;
  private stopped = false;
  constructor(deps: SchedulerDeps) {
    this.d = deps;
  }

  private row(id: string): Row {
    const r = one<Row>(this.d.db, "SELECT * FROM gg_schedules WHERE id = ?", id);
    if (!r) throw new HostError("not_found", `没有定时 ${id}`);
    return r;
  }
  view(r: Row): ScheduleView {
    const last = one<{ at: string; status: "ok" | "failed" | "missed" | "running"; error: string | null }>(this.d.db, "SELECT at, status, error FROM gg_schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1", r.id);
    return {
      id: r.id,
      contactId: r.contact_id,
      roomId: r.room_id,
      title: r.title,
      cron: r.cron,
      tz: r.tz,
      prompt: r.prompt,
      enabled: !!r.enabled,
      toleranceSec: r.tolerance_sec,
      missedPolicy: r.missed_policy,
      nextRunAt: r.enabled ? r.next_run_at : null,
      lastRun: last ? { at: last.at, status: last.status, messageSeq: null } : null,
      commitmentId: null,
      createdAt: r.created_at,
      ...(this.d.label?.(r.contact_id, r.room_id) ?? {}),
    };
  }
  list(q: { contactId?: string; roomId?: string; order?: "next-run" | "created" }): ScheduleView[] {
    // 默认按下次触发(停用/不再触发的排后),其次创建顺序;order=created 只按创建顺序。总览排序待定(D28 待确认 ②)
    const sql =
      q.order === "created"
        ? "SELECT * FROM gg_schedules ORDER BY created_at, id"
        : "SELECT * FROM gg_schedules ORDER BY (enabled = 0 OR next_run_at IS NULL), CASE WHEN enabled = 1 THEN next_run_at END, created_at, id";
    return all<Row>(this.d.db, sql)
      .filter((r) => (!q.contactId || r.contact_id === q.contactId) && (!q.roomId || r.room_id === q.roomId))
      .map((r) => this.view(r));
  }
  private nextAfter(cron: string, tz: string, afterMs: number): string | null {
    const { spec } = checkCron(cron, tz);
    const n = nextRuns(spec, tz, afterMs, 1)[0];
    return n === undefined ? null : iso(n);
  }
  create(input: ScheduleInput): ScheduleView {
    checkCron(input.cron, input.tz);
    this.d.checkMember(input.contactId, input.roomId);
    const id = this.d.newId("sch");
    const now = this.d.clockMs();
    run(
      this.d.db,
      "INSERT INTO gg_schedules (id, contact_id, room_id, title, cron, tz, prompt, enabled, tolerance_sec, missed_policy, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.contactId,
      input.roomId,
      input.title,
      input.cron,
      input.tz,
      input.prompt,
      input.enabled === false ? 0 : 1,
      input.toleranceSec ?? 300,
      input.missedPolicy ?? "skip",
      this.nextAfter(input.cron, input.tz, now),
      iso(now),
    );
    const v = this.view(this.row(id));
    this.d.emit(v);
    this.arm();
    return v;
  }
  update(id: string, patch: Partial<Omit<ScheduleInput, "contactId" | "roomId">>): ScheduleView {
    const r = this.row(id);
    const cron = patch.cron ?? r.cron;
    const tz = patch.tz ?? r.tz;
    checkCron(cron, tz);
    const enabled = patch.enabled === undefined ? !!r.enabled : patch.enabled;
    const timingChanged = cron !== r.cron || tz !== r.tz || (enabled && !r.enabled);
    run(
      this.d.db,
      "UPDATE gg_schedules SET title = ?, cron = ?, tz = ?, prompt = ?, enabled = ?, tolerance_sec = ?, missed_policy = ?, next_run_at = ? WHERE id = ?",
      patch.title ?? r.title,
      cron,
      tz,
      patch.prompt ?? r.prompt,
      enabled ? 1 : 0,
      patch.toleranceSec ?? r.tolerance_sec,
      patch.missedPolicy ?? r.missed_policy,
      timingChanged ? this.nextAfter(cron, tz, this.d.clockMs()) : r.next_run_at,
      id,
    );
    const v = this.view(this.row(id));
    this.d.emit(v);
    this.arm();
    return v;
  }
  remove(id: string) {
    this.row(id);
    run(this.d.db, "DELETE FROM gg_schedules WHERE id = ?", id);
    this.d.emit({ removed: id });
    this.arm();
  }
  history(id: string, limit: number) {
    this.row(id);
    return all<{ at: string; status: "ok" | "failed" | "missed" | "running"; error: string | null }>(this.d.db, "SELECT at, status, error FROM gg_schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?", id, limit).map((x) => ({ ...x, messageSeq: null }));
  }
  /** 立即触发一次(不改下次计划时间)。 */
  runNow(id: string): ScheduleView {
    const r = this.row(id);
    this.fire(r, this.d.clockMs(), "manual");
    return this.view(this.row(id));
  }

  private fire(r: Row, dueMs: number, why: "due" | "manual" | "catch-up") {
    const now = this.d.clockMs();
    const inbound: Inbound = { kind: "schedule", roomId: r.room_id, scheduleId: r.id, prompt: why === "catch-up" ? `(补跑:原定 ${iso(dueMs)})${r.prompt}` : r.prompt, at: iso(now) };
    tx(this.d.db, () => {
      this.d.deliverTx(r.contact_id, r.room_id, inbound);
      run(this.d.db, "INSERT INTO gg_schedule_runs (schedule_id, due_at, at, status) VALUES (?, ?, ?, 'ok')", r.id, iso(dueMs), iso(now));
    });
    this.d.notify(r.contact_id);
  }

  /** 处理所有到期的定时,推进下次时间,再按最早的下一次重设计时器。 */
  tick() {
    if (this.stopped) return;
    const now = this.d.clockMs();
    for (const r of all<Row>(this.d.db, "SELECT * FROM gg_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at")) {
      const due = Date.parse(r.next_run_at!);
      if (due > now) continue;
      const late = now - due > r.tolerance_sec * 1000;
      if (!late) this.fire(r, due, "due");
      else if (r.missed_policy === "run-once") this.fire(r, due, "catch-up");
      else run(this.d.db, "INSERT INTO gg_schedule_runs (schedule_id, due_at, at, status, error) VALUES (?, ?, ?, 'missed', ?)", r.id, r.next_run_at!, iso(now), `晚了 ${Math.round((now - due) / 1000)} 秒,超过容差 ${r.tolerance_sec} 秒`);
      // 错过多次只算一次:下次时间从现在往后算
      run(this.d.db, "UPDATE gg_schedules SET next_run_at = ? WHERE id = ?", this.nextAfter(r.cron, r.tz, Math.max(now, due)), r.id);
      this.d.emit(this.view(this.row(r.id)));
    }
    this.arm();
  }
  arm() {
    if (this.timer !== null) this.d.timers.clear(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const next = one<{ t: string | null }>(this.d.db, "SELECT min(next_run_at) AS t FROM gg_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL")?.t;
    if (!next) return;
    const wait = Math.max(0, Math.min(MAX_TIMER, Date.parse(next) - this.d.clockMs()));
    this.timer = this.d.timers.set(() => {
      this.timer = null;
      this.tick();
    }, wait);
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.d.timers.clear(this.timer);
    this.timer = null;
  }
}
