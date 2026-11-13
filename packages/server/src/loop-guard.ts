// U15 / D07.0：联系人派生唤醒按稳定因果根共享总次数和滚动频率；不判断话题语义。
// 默认 4 次只是候选运行参数，调用者可配置；达到任一限制后该根持久停止，用户新输入建立新根。
import type { Inbound } from "@g-group/kernel";
import { type Db, all, one, run, tx } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_loop_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, roots TEXT NOT NULL, PRIMARY KEY(room_id,seq));
CREATE TABLE IF NOT EXISTS gg_loop_roots (root TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, stopped TEXT);
CREATE TABLE IF NOT EXISTS gg_loop_wakes (room_id TEXT NOT NULL, seq INTEGER NOT NULL, contact_id TEXT NOT NULL, roots TEXT NOT NULL, allowed INTEGER NOT NULL, reason TEXT, at INTEGER NOT NULL, PRIMARY KEY(room_id,seq,contact_id));
CREATE TABLE IF NOT EXISTS gg_loop_ticks (root TEXT NOT NULL, room_id TEXT NOT NULL, seq INTEGER NOT NULL, contact_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(root,room_id,seq,contact_id));
CREATE INDEX IF NOT EXISTS gg_loop_ticks_time ON gg_loop_ticks(root,at);
`;
export interface LoopLimits {
  /** 每个因果根最多派生多少次联系人唤醒，默认 4（候选，待实测）。 */
  readonly maxHops?: number;
  /** 滚动一分钟上限；null 不另加频率限制，总次数仍有限。 */
  readonly maxPerMinute?: number | null;
}
export interface WakeDecision {
  readonly allowed: boolean;
  readonly duplicate: boolean;
  readonly roots: readonly string[];
  readonly reason: "hops" | "rate" | null;
}
export interface BlockedWake {
  readonly roomId: string;
  readonly seq: number;
  readonly contactId: string;
  readonly roots: readonly string[];
  readonly reason: "hops" | "rate";
}
const messageRoot = (roomId: string, seq: number) => `message:${roomId}:${seq}`;
const sortedRoots = (roots: readonly string[]) => [...new Set(roots)].sort();
const validLimit = (name: string, n: number) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} 必须是有限正整数`);
  return n;
};
export class LoopGuard {
  private readonly db: Db;
  private readonly maxHops: number;
  private readonly maxPerMinute: number | null;
  private readonly clock: () => number;
  constructor(db: Db, limits: LoopLimits = {}, clock: () => number = Date.now) {
    this.maxHops = validLimit("maxHops", limits.maxHops ?? 4);
    this.maxPerMinute = limits.maxPerMinute == null ? null : validLimit("maxPerMinute", limits.maxPerMinute);
    this.db = db;
    this.clock = clock;
    db.store.db.exec(SCHEMA);
  }
  /** 在消息提交事务内写入：同消息的根不可被重投或后续派生重置。 */
  recordMessage(roomId: string, seq: number, roots: readonly string[]): void {
    const stable = sortedRoots(roots.length ? roots : [messageRoot(roomId, seq)]);
    run(this.db, "INSERT OR IGNORE INTO gg_loop_messages(room_id,seq,roots) VALUES(?,?,?)", roomId, seq, JSON.stringify(stable));
    for (const root of stable) run(this.db, "INSERT OR IGNORE INTO gg_loop_roots(root) VALUES(?)", root);
  }
  rootsOf(roomId: string, seq: number): string[] {
    const r = one<{ roots: string }>(this.db, "SELECT roots FROM gg_loop_messages WHERE room_id=? AND seq=?", roomId, seq);
    return r ? JSON.parse(r.roots) as string[] : [messageRoot(roomId, seq)];
  }
  /** 同会话新用户输入是显式续话；否则合并本轮全部派生因果，跨会话也不能凭输出重置。 */
  rootsFor(fresh: readonly Inbound[], roomId: string): string[] {
    const users = fresh.filter((f) => f.kind === "message" && f.roomId === roomId && f.sender.kind === "user");
    const latest = users.at(-1);
    if (latest?.kind === "message") return [messageRoot(latest.roomId, latest.seq)];
    const roots = fresh.flatMap((f) => f.kind === "message" && f.sender.kind !== "system"
      ? this.rootsOf(f.roomId, f.seq)
      : f.kind === "compute" ? [`compute:${f.computeId}:${f.signal}:${f.at}`]
      : f.kind === "schedule" ? [`schedule:${f.scheduleId}:${f.at}`] : []);
    return sortedRoots(roots);
  }
  /** 原子判定并消耗同根共享额度；允许在消息事务内调用，不开嵌套事务。 */
  admit(roomId: string, seq: number, contactId: string): WakeDecision {
    const apply = (): WakeDecision => {
      const prior = one<{ roots: string; allowed: number; reason: WakeDecision["reason"] }>(this.db, "SELECT roots,allowed,reason FROM gg_loop_wakes WHERE room_id=? AND seq=? AND contact_id=?", roomId, seq, contactId);
      if (prior) return { allowed: !!prior.allowed, duplicate: true, roots: JSON.parse(prior.roots) as string[], reason: prior.reason };
      const roots = this.rootsOf(roomId, seq);
      const now = this.clock();
      let reason: WakeDecision["reason"] = null;
      for (const root of roots) {
        run(this.db, "INSERT OR IGNORE INTO gg_loop_roots(root) VALUES(?)", root);
        const row = one<{ count: number; stopped: WakeDecision["reason"] }>(this.db, "SELECT count,stopped FROM gg_loop_roots WHERE root=?", root)!;
        const recent = one<{ n: number }>(this.db, "SELECT count(*) AS n FROM gg_loop_ticks WHERE root=? AND at>?", root, now - 60_000)!.n;
        const why = row.stopped ?? (row.count >= this.maxHops ? "hops" : this.maxPerMinute !== null && recent >= this.maxPerMinute ? "rate" : null);
        if (why) {
          reason ??= why;
          run(this.db, "UPDATE gg_loop_roots SET stopped=? WHERE root=?", why, root);
        }
      }
      run(this.db, "INSERT INTO gg_loop_wakes(room_id,seq,contact_id,roots,allowed,reason,at) VALUES(?,?,?,?,?,?,?)", roomId, seq, contactId, JSON.stringify(roots), reason === null ? 1 : 0, reason, now);
      if (reason === null) for (const root of roots) {
        run(this.db, "UPDATE gg_loop_roots SET count=count+1 WHERE root=?", root);
        run(this.db, "INSERT INTO gg_loop_ticks(root,room_id,seq,contact_id,at) VALUES(?,?,?,?,?)", root, roomId, seq, contactId, now);
      }
      return { allowed: reason === null, duplicate: false, roots, reason };
    };
    return this.db.store.db.isTransaction ? apply() : tx(this.db, apply);
  }
  /** 运行入口只把没有触发停止根的新消息当作自动工作；原文仍保留供用户查询。 */
  isStopped(roomId: string, seq: number): boolean {
    return this.rootsOf(roomId, seq).some((root) => !!one<{ stopped: string | null }>(this.db, "SELECT stopped FROM gg_loop_roots WHERE root=?", root)?.stopped);
  }
  pending(): BlockedWake[] {
    return all<{ room_id: string; seq: number; contact_id: string; roots: string; reason: "hops" | "rate" }>(this.db, "SELECT room_id,seq,contact_id,roots,reason FROM gg_loop_wakes WHERE allowed=0 ORDER BY room_id,seq,contact_id")
      .map((r) => ({ roomId: r.room_id, seq: r.seq, contactId: r.contact_id, roots: JSON.parse(r.roots) as string[], reason: r.reason }));
  }
}
