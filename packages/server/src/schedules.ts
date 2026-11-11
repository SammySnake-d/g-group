// 定时:联系人在某个会话里按 cron + 时区做事(用户 #719「定时要能用 cron 表达式」;U74 常驻承诺「每天 8 点」)。
// 到点由宿主把 InboundSchedule 送进联系人的注意循环(唯一入口,不绕过联系人直通 Compute,M17/#118)。
// 错过(宿主没开、休眠)超过容差:missedPolicy=skip 记 missed 不补;run-once 只补一次,不按错过次数连发。
// 运行记录写实(U20、D02③):投递时记 running,等这一轮联系人结束才写 ok(有发言,回填 messageSeq)/ silent(跑了没发言)/
// failed(这一轮失败出卡,带原因);联系人自设的定时同时是一条常驻承诺,gg_schedule_meta 记两边的引用(D04.2-1)。
import type { ScheduleView } from "@g-group/api-contract";
import { type Inbound, type TimerApi, describeCron, isValidTimeZone, nextRuns, parseCron } from "@g-group/kernel";
import { type Db, HostError, all, one, run, tx } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_schedule_meta (schedule_id TEXT PRIMARY KEY, commitment_id TEXT, source_room TEXT, source_seq INTEGER);
CREATE INDEX IF NOT EXISTS gg_schedule_meta_commitment ON gg_schedule_meta (commitment_id);
CREATE TABLE IF NOT EXISTS gg_schedule_requests (client_action_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_schedule_run_inbox (run_id INTEGER PRIMARY KEY, inbox_id INTEGER NOT NULL UNIQUE, message_seq INTEGER);
`;

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
export type ScheduleRow = Readonly<Row>;
export type RunStatus = "ok" | "failed" | "missed" | "running" | "silent";
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
  /** 把触发送进联系人的注意循环。在事务里调用:写 inbox,返回这条待处理输入的 id;事务后 notify。 */
  readonly deliverTx: (contactId: string, roomId: string, inbound: Inbound) => number;
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
/** 「每天 08:00(Asia/Shanghai)」这类人话;cron 不合法时原样给出。 */
export function cronText(cron: string, tz: string): string {
  const p = parseCron(cron);
  return p.ok ? describeCron(p.spec, tz) : `${cron}(${tz})`;
}

export class Scheduler {
  private readonly d: SchedulerDeps;
  private timer: unknown = null;
  private stopped = false;
  constructor(deps: SchedulerDeps) {
    this.d = deps;
    deps.db.store.db.exec(SCHEMA);
  }

  private row(id: string): Row {
    const r = this.get(id);
    if (!r) throw new HostError("not_found", `没有定时 ${id}`);
    return r;
  }
  get(id: string): ScheduleRow | undefined {
    return one<Row>(this.d.db, "SELECT * FROM gg_schedules WHERE id = ?", id);
  }
  /** 定时对应的常驻承诺;用户在界面建的没有 */
  commitmentOf(scheduleId: string): string | null {
    return one<{ commitment_id: string | null }>(this.d.db, "SELECT commitment_id FROM gg_schedule_meta WHERE schedule_id = ?", scheduleId)?.commitment_id ?? null;
  }
  /** 常驻承诺对应的定时;没有返回 null */
  byCommitment(commitmentId: string): string | null {
    return one<{ schedule_id: string }>(this.d.db, "SELECT m.schedule_id FROM gg_schedule_meta m JOIN gg_schedules s ON s.id = m.schedule_id WHERE m.commitment_id = ?", commitmentId)?.schedule_id ?? null;
  }
  view(r: Row): ScheduleView {
    const last = one<{ at: string; status: RunStatus; message_seq: number | null }>(
      this.d.db,
      "SELECT r.at, r.status, l.message_seq FROM gg_schedule_runs r LEFT JOIN gg_schedule_run_inbox l ON l.run_id = r.id WHERE r.schedule_id = ? ORDER BY r.id DESC LIMIT 1",
      r.id,
    );
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
      lastRun: last ? { at: last.at, status: last.status, messageSeq: last.message_seq ?? null } : null,
      commitmentId: this.commitmentOf(r.id),
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
  /** 事务内建一条(不推事件、不重设计时器;提交后调 changed)。meta 记联系人自设时的来源与常驻承诺。 */
  insertTx(input: ScheduleInput, meta?: { commitmentId: string | null; sourceRoom: string; sourceSeq: number }): string {
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
    if (meta) run(this.d.db, "INSERT INTO gg_schedule_meta (schedule_id, commitment_id, source_room, source_seq) VALUES (?, ?, ?, ?)", id, meta.commitmentId, meta.sourceRoom, meta.sourceSeq);
    return id;
  }
  /** 改定时对应的常驻承诺(联系人重新设一条已了结或界面建的定时时,挂到这一轮新登记的承诺上) */
  linkTx(scheduleId: string, commitmentId: string, source: { room: string; seq: number }) {
    run(
      this.d.db,
      "INSERT INTO gg_schedule_meta (schedule_id, commitment_id, source_room, source_seq) VALUES (?, ?, ?, ?) ON CONFLICT (schedule_id) DO UPDATE SET commitment_id = excluded.commitment_id, source_room = excluded.source_room, source_seq = excluded.source_seq",
      scheduleId,
      commitmentId,
      source.room,
      source.seq,
    );
  }
  /** 提交后:推这条的最新视图并重设计时器 */
  changed(id: string) {
    const r = this.get(id);
    if (r) this.d.emit(this.view(r));
    this.arm();
  }
  /** 用户经界面建。clientActionId 相同的重投返回第一次建的那条,不再建;同号但内容不同拒收(D02①「同一请求重投不产生两个定时器」) */
  create(input: ScheduleInput, opts: { clientActionId?: string } = {}): ScheduleView {
    const key = opts.clientActionId;
    const fingerprint = JSON.stringify([input.contactId, input.roomId, input.title, input.cron, input.tz, input.prompt, input.enabled ?? true, input.toleranceSec ?? 300, input.missedPolicy ?? "skip"]);
    const r = tx(this.d.db, () => {
      if (key !== undefined) {
        const prior = one<{ schedule_id: string; fingerprint: string }>(this.d.db, "SELECT schedule_id, fingerprint FROM gg_schedule_requests WHERE client_action_id = ?", key);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new HostError("conflict", `请求 ${key} 已用来建定时 ${prior.schedule_id},这次内容不同`);
          const existing = this.get(prior.schedule_id);
          if (!existing) throw new HostError("conflict", `请求 ${key} 建的定时 ${prior.schedule_id} 已删除`);
          return { id: existing.id, replay: true };
        }
      }
      const id = this.insertTx(input);
      if (key !== undefined) run(this.d.db, "INSERT INTO gg_schedule_requests (client_action_id, schedule_id, fingerprint) VALUES (?, ?, ?)", key, id, fingerprint);
      return { id, replay: false };
    });
    if (!r.replay) this.changed(r.id);
    return this.view(this.row(r.id));
  }
  /** 事务内改(不推事件;提交后调 changed)。 */
  patchTx(id: string, patch: Partial<Omit<ScheduleInput, "contactId" | "roomId">>) {
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
  }
  update(id: string, patch: Partial<Omit<ScheduleInput, "contactId" | "roomId">>): ScheduleView {
    this.patchTx(id, patch);
    this.changed(id);
    return this.view(this.row(id));
  }
  /** 事务内删(不推事件;提交后调 removed)。 */
  deleteTx(id: string) {
    this.row(id);
    run(this.d.db, "DELETE FROM gg_schedules WHERE id = ?", id);
    run(this.d.db, "DELETE FROM gg_schedule_meta WHERE schedule_id = ?", id);
  }
  removed(id: string) {
    this.d.emit({ removed: id });
    this.arm();
  }
  remove(id: string) {
    this.deleteTx(id);
    this.removed(id);
  }
  /** 事务内:常驻承诺了结(撤销、回退、完成)时停用对应的定时,返回停用了哪些(提交后逐个 changed) */
  disableByCommitmentTx(commitmentId: string): string[] {
    const ids = all<{ id: string }>(this.d.db, "SELECT s.id FROM gg_schedules s JOIN gg_schedule_meta m ON m.schedule_id = s.id WHERE m.commitment_id = ? AND s.enabled = 1", commitmentId).map((x) => x.id);
    for (const id of ids) run(this.d.db, "UPDATE gg_schedules SET enabled = 0 WHERE id = ?", id);
    return ids;
  }
  history(id: string, limit: number) {
    this.row(id);
    return all<{ at: string; status: RunStatus; error: string | null; message_seq: number | null }>(
      this.d.db,
      "SELECT r.at, r.status, r.error, l.message_seq FROM gg_schedule_runs r LEFT JOIN gg_schedule_run_inbox l ON l.run_id = r.id WHERE r.schedule_id = ? ORDER BY r.id DESC LIMIT ?",
      id,
      limit,
    ).map(({ message_seq, ...x }) => ({ ...x, messageSeq: message_seq ?? null }));
  }
  /** 立即触发一次(不改下次计划时间)。 */
  runNow(id: string): ScheduleView {
    const r = this.row(id);
    this.fire(r, this.d.clockMs(), "manual");
    return this.view(this.row(id));
  }

  /**
   * 事务内:把一次触发送进联系人的注意循环,记一条 running 的运行记录并挂上这条待处理输入;
   * 这一轮联系人结束后由 settleRunsTx / failRunsTx 写结果。定时与「每 N 条消息」触发器共用(scheduleId 是各自的 id)。
   */
  deliverRunTx(scheduleId: string, contactId: string, roomId: string, inbound: Inbound, dueAt: string) {
    const inboxId = this.d.deliverTx(contactId, roomId, inbound);
    run(this.d.db, "INSERT INTO gg_schedule_runs (schedule_id, due_at, at, status) VALUES (?, ?, ?, 'running')", scheduleId, dueAt, iso(this.d.clockMs()));
    const runId = one<{ id: number }>(this.d.db, "SELECT last_insert_rowid() AS id")!.id;
    run(this.d.db, "INSERT INTO gg_schedule_run_inbox (run_id, inbox_id) VALUES (?, ?)", runId, inboxId);
  }
  /**
   * 事务内:这一轮联系人提交了,领走的待处理输入里有定时触发的,按它这一轮在那个会话里有没有发言写 ok(回填第一条的 seq)或 silent。
   * 先前失败出卡、后来重试成功的,改写成这次的结果。
   */
  settleRunsTx(inboxIds: readonly number[], spoke: (roomId: string) => number | null) {
    for (const inboxId of inboxIds) {
      const r = one<{ run_id: number; room_id: string }>(
        this.d.db,
        "SELECT l.run_id, i.room_id FROM gg_schedule_run_inbox l JOIN gg_inbox i ON i.id = l.inbox_id JOIN gg_schedule_runs r ON r.id = l.run_id WHERE l.inbox_id = ? AND r.status IN ('running', 'failed')",
        inboxId,
      );
      if (!r) continue;
      const seq = spoke(r.room_id);
      run(this.d.db, "UPDATE gg_schedule_runs SET status = ?, error = NULL WHERE id = ?", seq === null ? "silent" : "ok", r.run_id);
      run(this.d.db, "UPDATE gg_schedule_run_inbox SET message_seq = ? WHERE run_id = ?", seq, r.run_id);
    }
  }
  /** 事务内:联系人这一轮失败、不再自动重试(出卡)时,这批里还在 running 的定时触发记 failed 并带原因 */
  failRunsTx(contactId: string, upToInboxId: number, reason: string) {
    run(
      this.d.db,
      "UPDATE gg_schedule_runs SET status = 'failed', error = ? WHERE status = 'running' AND id IN (SELECT l.run_id FROM gg_schedule_run_inbox l JOIN gg_inbox i ON i.id = l.inbox_id WHERE i.contact_id = ? AND i.consumed = 0 AND i.id <= ?)",
      reason,
      contactId,
      upToInboxId,
    );
  }

  private fire(r: Row, dueMs: number, why: "due" | "manual" | "catch-up") {
    const now = this.d.clockMs();
    const inbound: Inbound = { kind: "schedule", roomId: r.room_id, scheduleId: r.id, prompt: why === "catch-up" ? `(补跑:原定 ${iso(dueMs)})${r.prompt}` : r.prompt, at: iso(now) };
    tx(this.d.db, () => this.deliverRunTx(r.id, r.contact_id, r.room_id, inbound, iso(dueMs)));
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
