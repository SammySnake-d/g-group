// 按消息数触发(U80,D21.3 第 14 项、D21.4 第 1 步):「每 N 条消息」是联系人承诺的一种触发方式,和定时同一条线,不放进插件。
// 一条触发 = 一条联系人承诺(commitmentId)+ 会话 + 每 N 条 + 上次覆盖到的 seq(coveredSeq)。
// 到点 = coveredSeq 之后算群聊发言的消息(口径见 chat-range.ts)攒够 N 条:冻结一个窗口 (from, to],to 是第 N 条的 seq,
// coveredSeq 前进到 to。窗口与 coveredSeq 同一事务落盘,主键 (trigger, to) 加唯一 (trigger, from):重放、重启都不会多冻一次。
// 计数不留在内存里,每次从只追加记录现算;宿主启动时 reconcile 补上「消息已落盘、还没来得及计数」的那一拍。
// 本模块只管触发与窗口,不调模型:窗口交给消费方(动向摘要),它做完后 settle。承诺撤销、联系人不在群里、群已解散 → 触发关闭,
// 还没处理的窗口一并取消:没人开就不花模型调用,撤销后也不再花。
import { chatLines } from "./chat-range.ts";
import { type Db, all, one, run } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_count_triggers (
  id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, requester_id TEXT NOT NULL,
  every_n INTEGER NOT NULL, source_seq INTEGER NOT NULL, covered_seq INTEGER NOT NULL, status TEXT NOT NULL, closed_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_count_triggers_room ON gg_count_triggers (room_id, status);
CREATE TABLE IF NOT EXISTS gg_count_windows (
  trigger_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, status TEXT NOT NULL, frozen_at TEXT NOT NULL, settled_at TEXT,
  PRIMARY KEY (trigger_id, to_seq), UNIQUE (trigger_id, from_seq)
);
`;

/** 每 N 条的 N 的取值范围。下限 1 就是每条都触发;上限只防离谱的数,不是产品阈值。 */
export const EVERY_N_MIN = 1;
export const EVERY_N_MAX = 10_000;

export interface CountTrigger {
  readonly id: string;
  readonly commitmentId: string;
  readonly contactId: string;
  readonly roomId: string;
  /** 提出这条承诺的用户:计数与读取区间时,他在自己这一端删掉的消息不算 */
  readonly requesterId: string;
  readonly everyN: number;
  readonly sourceSeq: number;
  /** 上次覆盖到的 seq:下一个窗口从它之后开始数 */
  readonly coveredSeq: number;
  readonly status: "active" | "closed";
  readonly closedReason: string | null;
}
export type WindowStatus = "pending" | "done" | "failed" | "cancelled";
export interface CountWindow {
  readonly triggerId: string;
  readonly commitmentId: string;
  readonly contactId: string;
  readonly roomId: string;
  readonly requesterId: string;
  readonly fromSeqExclusive: number;
  readonly toSeqInclusive: number;
  readonly status: WindowStatus;
}
/** 承诺视图里的触发信息(CommitmentView.trigger)。 */
export interface CountTriggerView {
  readonly kind: "message-count";
  readonly everyN: number;
  readonly coveredSeq: number;
  /** coveredSeq 之后已经攒了几条 */
  readonly count: number;
  readonly active: boolean;
  /** 已冻结过的窗口数 */
  readonly windows: number;
}
export interface CountTriggerDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 这条触发现在还该不该数;不该就给出关闭原因(承诺已不是 active、联系人不在这个会话、会话已解散)。 */
  readonly closedWhy: (t: CountTrigger) => string | null;
  /** 某位用户在某个会话这一端隐藏了哪些 seq。 */
  readonly hidden: (roomId: string, viewerId: string) => (seq: number) => boolean;
  /** 提交之后:某条承诺的触发状态变了(冻结了窗口、关闭)。 */
  readonly changed: (commitmentId: string) => void;
  /** 提交之后:有新窗口等消费方处理(每个窗口在一次宿主运行里只通知一次;重启后还没处理完的会再通知)。 */
  readonly fired: (w: CountWindow) => void;
}

interface TriggerRow {
  id: string;
  commitment_id: string;
  contact_id: string;
  room_id: string;
  requester_id: string;
  every_n: number;
  source_seq: number;
  covered_seq: number;
  status: "active" | "closed";
  closed_reason: string | null;
}
interface WindowRow {
  trigger_id: string;
  from_seq: number;
  to_seq: number;
  status: WindowStatus;
  commitment_id: string;
  contact_id: string;
  room_id: string;
  requester_id: string;
}
const WINDOW_SQL =
  "SELECT w.trigger_id, w.from_seq, w.to_seq, w.status, t.commitment_id, t.contact_id, t.room_id, t.requester_id FROM gg_count_windows w JOIN gg_count_triggers t ON t.id = w.trigger_id";

const toTrigger = (r: TriggerRow): CountTrigger => ({
  id: r.id,
  commitmentId: r.commitment_id,
  contactId: r.contact_id,
  roomId: r.room_id,
  requesterId: r.requester_id,
  everyN: r.every_n,
  sourceSeq: r.source_seq,
  coveredSeq: r.covered_seq,
  status: r.status,
  closedReason: r.closed_reason,
});
const toWindow = (r: WindowRow): CountWindow => ({
  triggerId: r.trigger_id,
  commitmentId: r.commitment_id,
  contactId: r.contact_id,
  roomId: r.room_id,
  requesterId: r.requester_id,
  fromSeqExclusive: r.from_seq,
  toSeqInclusive: r.to_seq,
  status: r.status,
});

/** N 合不合格;不合格给出原因(给联系人看的拒收原因)。 */
export function everyNProblem(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < EVERY_N_MIN || n > EVERY_N_MAX) return `everyNMessages 必须是 ${EVERY_N_MIN}–${EVERY_N_MAX} 的整数`;
  return null;
}

export class CountTriggers {
  private readonly d: CountTriggerDeps;
  /** 这次宿主运行里已经通知过消费方的窗口 */
  private readonly announced = new Set<string>();
  /** 事务里状态变了、提交后要通知的承诺 */
  private readonly dirty = new Set<string>();
  constructor(deps: CountTriggerDeps) {
    this.d = deps;
    deps.db.store.db.exec(SCHEMA);
  }

  /** 登记一条按消息数触发的承诺(在登记承诺的同一事务里调用)。同一条承诺重复登记不变。coveredSeq 取登记时会话的末尾:之前的消息不算。N 合不合格由调用方先用 everyNProblem 判,不合格的不该走到这里。 */
  createTx(input: { commitmentId: string; contactId: string; roomId: string; requesterId: string; everyN: number; sourceSeq: number; coveredSeq: number }): CountTrigger {
    const at = this.d.now();
    run(
      this.d.db,
      "INSERT OR IGNORE INTO gg_count_triggers (id, commitment_id, contact_id, room_id, requester_id, every_n, source_seq, covered_seq, status, closed_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)",
      this.d.newId("ct"),
      input.commitmentId,
      input.contactId,
      input.roomId,
      input.requesterId,
      input.everyN,
      input.sourceSeq,
      input.coveredSeq,
      at,
      at,
    );
    this.dirty.add(input.commitmentId);
    return this.byCommitment(input.commitmentId)!;
  }
  byCommitment(commitmentId: string): CountTrigger | null {
    const r = one<TriggerRow>(this.d.db, "SELECT * FROM gg_count_triggers WHERE commitment_id = ?", commitmentId);
    return r ? toTrigger(r) : null;
  }
  get(triggerId: string): CountTrigger | null {
    const r = one<TriggerRow>(this.d.db, "SELECT * FROM gg_count_triggers WHERE id = ?", triggerId);
    return r ? toTrigger(r) : null;
  }
  /** 这条触发的 coveredSeq 之后,现在算群聊发言的消息。 */
  private pendingLines(t: CountTrigger) {
    return chatLines(this.d.db, { roomId: t.roomId, afterSeq: t.coveredSeq, hidden: this.d.hidden(t.roomId, t.requesterId) });
  }
  viewOf(commitmentId: string): CountTriggerView | null {
    const t = this.byCommitment(commitmentId);
    if (!t) return null;
    const active = t.status === "active" && this.d.closedWhy(t) === null;
    const windows = one<{ n: number }>(this.d.db, "SELECT count(*) AS n FROM gg_count_windows WHERE trigger_id = ?", t.id)?.n ?? 0;
    return { kind: "message-count", everyN: t.everyN, coveredSeq: t.coveredSeq, count: active ? this.pendingLines(t).length : 0, active, windows };
  }

  /** 会话里新落了一条消息(在写消息的同一事务里调用):这个会话里还开着的触发各数一遍。 */
  onAppendTx(roomId: string): void {
    for (const r of all<TriggerRow>(this.d.db, "SELECT * FROM gg_count_triggers WHERE room_id = ? AND status = 'active' ORDER BY created_at, id", roomId)) this.evaluateTx(toTrigger(r));
  }
  /** 数一遍:不该再数的关掉;攒够 N 条就冻结窗口,一次攒了几个 N 就冻结几个(每个窗口正好 N 条)。必须在事务里调用。 */
  private evaluateTx(t: CountTrigger): void {
    const why = this.d.closedWhy(t);
    if (why !== null) {
      this.closeRowTx(t, why);
      return;
    }
    let lines = this.pendingLines(t);
    let covered = t.coveredSeq;
    while (lines.length >= t.everyN) {
      const to = lines[t.everyN - 1]!.seq;
      run(this.d.db, "INSERT OR IGNORE INTO gg_count_windows (trigger_id, from_seq, to_seq, status, frozen_at) VALUES (?, ?, ?, 'pending', ?)", t.id, covered, to, this.d.now());
      covered = to;
      lines = lines.slice(t.everyN);
    }
    if (covered !== t.coveredSeq) {
      run(this.d.db, "UPDATE gg_count_triggers SET covered_seq = ?, updated_at = ? WHERE id = ? AND covered_seq = ?", covered, this.d.now(), t.id, t.coveredSeq);
      this.dirty.add(t.commitmentId);
    }
  }
  private closeRowTx(t: CountTrigger, reason: string): void {
    if (run(this.d.db, "UPDATE gg_count_triggers SET status = 'closed', closed_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'", reason, this.d.now(), t.id) !== 1) return;
    run(this.d.db, "UPDATE gg_count_windows SET status = 'cancelled', settled_at = ? WHERE trigger_id = ? AND status = 'pending'", this.d.now(), t.id);
    this.dirty.add(t.commitmentId);
  }
  /** 承诺了结或被撤销(在同一事务里调用):触发关闭,还没处理的窗口取消。没有触发的承诺什么都不做。 */
  closeTx(commitmentId: string, reason: string): void {
    const t = this.byCommitment(commitmentId);
    if (!t) return;
    this.closeRowTx(t, reason);
    // 调用方自己推这条承诺的事件,这里不再重复通知
    this.dirty.delete(commitmentId);
  }
  /** 消费方处理完一个窗口(在它落自己结果的同一事务里调用);窗口已不是 pending(被取消、已处理过)返回 false。 */
  settleWindowTx(triggerId: string, toSeqInclusive: number, status: "done" | "failed"): boolean {
    return run(this.d.db, "UPDATE gg_count_windows SET status = ?, settled_at = ? WHERE trigger_id = ? AND to_seq = ? AND status = 'pending'", status, this.d.now(), triggerId, toSeqInclusive) === 1;
  }
  windows(triggerId: string): CountWindow[] {
    return all<WindowRow>(this.d.db, `${WINDOW_SQL} WHERE w.trigger_id = ? ORDER BY w.to_seq`, triggerId).map(toWindow);
  }
  window(triggerId: string, toSeqInclusive: number): CountWindow | null {
    const r = one<WindowRow>(this.d.db, `${WINDOW_SQL} WHERE w.trigger_id = ? AND w.to_seq = ?`, triggerId, toSeqInclusive);
    return r ? toWindow(r) : null;
  }

  /** 事务提交之后调用:推状态变化,把还没通知过的待处理窗口交给消费方。 */
  announce(): void {
    for (const c of [...this.dirty]) {
      this.dirty.delete(c);
      this.d.changed(c);
    }
    for (const r of all<WindowRow>(this.d.db, `${WINDOW_SQL} WHERE w.status = 'pending' AND t.status = 'active' ORDER BY w.frozen_at, w.trigger_id, w.to_seq`)) {
      const key = `${r.trigger_id}:${r.to_seq}`;
      if (this.announced.has(key)) continue;
      this.announced.add(key);
      this.d.fired(toWindow(r));
    }
  }
  /** 宿主启动时:把所有还开着的触发数一遍(补上「消息已落盘、还没计数」的那一拍)。在事务里调用,之后调 announce。 */
  reconcileTx(): void {
    for (const r of all<TriggerRow>(this.d.db, "SELECT * FROM gg_count_triggers WHERE status = 'active' ORDER BY created_at, id")) this.evaluateTx(toTrigger(r));
  }
}
