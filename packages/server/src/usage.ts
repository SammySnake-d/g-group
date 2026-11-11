// 模型调用用量表 gg_usage(AC-39 ⑤:每次调用记录 input / cache_read / cache_write / 线路)与 usage.cacheStats 统计入口。
// 只追加:适配器每发完一次模型请求经回执口报一次,宿主补上种类、联系人、本轮涉及的会话、轮次号与时间后插一行,从不改、不删。
// 统计是纯函数(cache-stats.ts);这里只负责落表、读表和参数校验。回执口出错只报告,不影响联系人这一轮。
import type { ModelUsage, UsageKind, UsageSink } from "@g-group/kernel";
import { type CacheStatsQuery, type CacheStatsResult, cacheStats, type UsageRow } from "./cache-stats.ts";
import { type Db, HostError, all, run } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, line TEXT NOT NULL, contact_id TEXT NOT NULL,
  room_ids TEXT NOT NULL, round_id TEXT NOT NULL, request INTEGER NOT NULL, prefix_hash TEXT NOT NULL,
  breakpoints INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_usage_at ON gg_usage (at);
`;

/** 宿主这一次调用的来历:哪种调用、哪位联系人、本轮涉及哪些会话、哪一轮 */
export interface UsageMeta {
  readonly kind: UsageKind;
  readonly contactId: string;
  readonly roomIds: readonly string[];
  readonly roundId: string;
}

const HASH = /^[0-9a-f]{64}$/;
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/** 回执内容的形状检查:不合格的整条不落表(返回原因) */
export function usageProblem(u: unknown): string | null {
  if (typeof u !== "object" || u === null) return "不是对象";
  const r = u as Partial<Record<keyof ModelUsage, unknown>>;
  if (typeof r.line !== "string" || r.line.length === 0 || r.line.length > 400) return "line 必须是 1–400 字符的字符串";
  if (!count(r.request) || r.request < 1) return "request 必须是正整数";
  if (typeof r.prefixHash !== "string" || !HASH.test(r.prefixHash)) return "prefixHash 必须是 sha256 十六进制";
  for (const k of ["breakpoints", "input", "cacheRead", "cacheWrite", "output"] as const) if (!count(r[k])) return `${k} 必须是非负整数`;
  return null;
}

export class UsageLedger {
  private readonly db: Db;
  private readonly now: () => string;
  private readonly report: (what: string, detail: unknown) => void;
  constructor(o: { db: Db; now: () => string; report: (what: string, detail: unknown) => void }) {
    this.db = o.db;
    this.now = o.now;
    this.report = o.report;
    this.db.store.db.exec(SCHEMA);
  }
  /** 给适配器的回执口:每次回报落一行 */
  sink(meta: UsageMeta): UsageSink {
    return (u) => this.record(meta, u);
  }
  /** 落一行;形状不合格或写库出错只报告,不抛给适配器 */
  record(meta: UsageMeta, u: ModelUsage): void {
    const why = usageProblem(u);
    if (why !== null) {
      this.report("usage-rejected", { kind: meta.kind, contactId: meta.contactId, roundId: meta.roundId, why });
      return;
    }
    try {
      run(
        this.db,
        "INSERT INTO gg_usage (at, kind, line, contact_id, room_ids, round_id, request, prefix_hash, breakpoints, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        this.now(),
        meta.kind,
        u.line,
        meta.contactId,
        JSON.stringify([...new Set(meta.roomIds)].sort()),
        meta.roundId,
        u.request,
        u.prefixHash,
        u.breakpoints,
        u.input,
        u.cacheRead,
        u.cacheWrite,
        u.output,
      );
    } catch (e) {
      this.report("usage-record-failed", { kind: meta.kind, contactId: meta.contactId, roundId: meta.roundId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  /** 按落表顺序读出 until 之前(不含)的全部行 */
  rows(until?: string): UsageRow[] {
    const xs = all<{
      id: number; at: string; kind: UsageKind; line: string; contact_id: string; room_ids: string; round_id: string; request: number;
      prefix_hash: string; breakpoints: number; input: number; cache_read: number; cache_write: number; output: number;
    }>(this.db, "SELECT * FROM gg_usage ORDER BY id");
    const end = until === undefined ? Number.POSITIVE_INFINITY : Date.parse(until);
    return xs
      .filter((r) => Date.parse(r.at) < end)
      .map((r) => ({
        id: r.id, at: r.at, kind: r.kind, line: r.line, contactId: r.contact_id, roomIds: JSON.parse(r.room_ids) as string[], roundId: r.round_id,
        request: r.request, prefixHash: r.prefix_hash, breakpoints: r.breakpoints,
        input: r.input, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output,
      }));
  }
  /** usage.cacheStats:参数越界抛 invalid_params */
  cacheStats(q: CacheStatsQuery): CacheStatsResult {
    const bad = (why: string): never => { throw new HostError("invalid_params", `usage.cacheStats 参数不合格:${why}`); };
    const frac = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
    if (q.alertBelow !== undefined && !frac(q.alertBelow)) bad("alertBelow 必须在 0–1 之间");
    for (const x of q.alertBelowByLine ?? []) if (!frac(x.below)) bad(`线路 ${x.line} 的阈值必须在 0–1 之间`);
    if (q.since !== undefined && q.until !== undefined && Date.parse(q.since) > Date.parse(q.until)) bad("since 不能晚于 until");
    return cacheStats(this.rows(q.until), q);
  }
}
