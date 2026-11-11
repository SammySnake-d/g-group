// 缓存命中统计接口(AC-39 ⑤⑥,向后兼容增量):usage.cacheStats 按「线路 × 联系人 × 群」(可加种类)出命中率,
// 带拆账口径(split-accounting,不计入命中率)、只缓存首段(first-segment-only)、低于阈值(low-hit-rate)标记与未命中归因。
// 命中率口径 = cache_read / (input + cache_read + cache_write)(需求文档 D22)。报警阈值待用户按线路定:不给就不标,只是结果里的标记。
import { arr, bool, int, isoTime, nullable, num, obj, oneOf, opt, str } from "./schema.ts";

export const USAGE_CALL_KINDS = ["round", "compact", "reflect", "compute"] as const;
export const CACHE_STATS_DIMS = ["line", "contact", "room", "kind"] as const;
export const CACHE_FLAGS = ["split-accounting", "first-segment-only", "low-hit-rate"] as const;
export const SPLIT_REASONS = ["constant-ratio", "hit-without-breakpoint"] as const;

const count = () => int({ min: 0 });

export const CacheStatsParams = obj({
  /** 统计窗口 [since, until);不给就是全部 */
  since: opt(isoTime()),
  until: opt(isoTime()),
  /** 分组维度,常用 ["line","contact","room"] */
  by: arr(oneOf(CACHE_STATS_DIMS), { max: 4 }),
  /** 只统计这些种类的调用;不给是全部 */
  kinds: opt(arr(oneOf(USAGE_CALL_KINDS), { max: 4 })),
  /** 缓存 TTL(毫秒),默认 5 分钟;同前缀间隔超过它的未命中记「过期」 */
  ttlMs: opt(int({ min: 1, max: 86_400_000 })),
  /** 命中率报警阈值(0–1);不给不标(阈值待用户定)。alertBelowByLine 按线路单独设 */
  alertBelow: opt(num()),
  alertBelowByLine: opt(arr(obj({ line: str({ min: 1, max: 400 }), below: num() }), { max: 200 })),
  /** 计入命中率的调用至少几次才判低于阈值 */
  minCalls: opt(int({ min: 1, max: 1_000_000 })),
});

export const CacheStatsGroupView = obj({
  line: nullable(str({ max: 400 })),
  contactId: nullable(str({ max: 200 })),
  /** 本次调用涉及的会话(多个时按 id 排序用逗号连) */
  room: nullable(str()),
  kind: nullable(oneOf(USAGE_CALL_KINDS)),
  calls: count(),
  input: count(),
  cacheRead: count(),
  cacheWrite: count(),
  output: count(),
  countedCalls: count(),
  hitRate: nullable(num()),
  alertBelow: nullable(num()),
  flags: arr(oneOf(CACHE_FLAGS)),
  misses: obj({ cold: count(), prefixChanged: count(), expired: count(), uncached: count() }),
});

export const CacheStatsView = obj({
  since: nullable(isoTime()),
  until: nullable(isoTime()),
  by: arr(oneOf(CACHE_STATS_DIMS)),
  ttlMs: int({ min: 1 }),
  groups: arr(CacheStatsGroupView),
  lines: arr(obj({ line: str({ max: 400 }), calls: count(), splitAccounting: nullable(oneOf(SPLIT_REASONS)), firstSegmentOnly: bool() })),
});

export const USAGE_METHODS = {
  "usage.cacheStats": { params: CacheStatsParams, result: CacheStatsView },
} as const;
