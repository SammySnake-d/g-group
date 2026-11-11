// 模型调用用量表 gg_usage 与 usage.cacheStats 统计入口(AC-39 ⑤)——红提交的空壳:回执口不落表,读表为空。
import type { ModelUsage, UsageKind, UsageSink } from "@g-group/kernel";
import { type CacheStatsQuery, type CacheStatsResult, cacheStats, type UsageRow } from "./cache-stats.ts";
import type { Db } from "./db.ts";

export interface UsageMeta {
  readonly kind: UsageKind;
  readonly contactId: string;
  readonly roomIds: readonly string[];
  readonly roundId: string;
}
export function usageProblem(_u: unknown): string | null {
  return null;
}
export class UsageLedger {
  constructor(_o: { db: Db; now: () => string; report: (what: string, detail: unknown) => void }) {}
  sink(_meta: UsageMeta): UsageSink {
    return () => {};
  }
  record(_meta: UsageMeta, _u: ModelUsage): void {}
  rows(_until?: string): UsageRow[] {
    return [];
  }
  cacheStats(q: CacheStatsQuery): CacheStatsResult {
    return cacheStats(this.rows(q.until), q);
  }
}
