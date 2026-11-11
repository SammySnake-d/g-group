// 缓存命中统计(AC-39 ⑤⑥、D22 第 3 节第 7 条)——红提交的空壳:类型与常量在,函数返回假值。以下是要实现的口径:
//纯函数,不做 I/O:输入 gg_usage 的行,输出按「线路 × 联系人 × 群」(可加种类)分组的命中率。
// 口径(D22、evidence/cache-20261105):命中率 = cache_read / (input + cache_read + cache_write)。
// 可信度检查按线路做(拆账口径不计入命中率,只标出来):
//   constant-ratio   :cache_read / input 在样本里恒为同一比例(kiro 式 4:1,允许四舍五入的 ±2 token),且 input 本身有变化;
//   hit-without-breakpoint:请求里一个 cache_control 都没有(压缩、检查),服务端不该有可读的缓存,却报 cache_read > 0。
//     这是验收文档「全新随机前缀首调即报命中」在生产流量里的可观测形态:生产不发随机前缀探测;不声明缓存的请求对缓存而言就是没写过的前缀
//     (D22 实测 kiro 线带不带 cache_control 结果一样)。不用「工具声明这段在本库里头一次出现就报命中」判:同一账号上另一个实例
//     刚发过同样的工具声明时,这段缓存本来就是热的,真实运行里就是这样误判的(proof/cache-observability-real.txt)。
// 只缓存首段(first-segment-only):同一轮的后续请求(前一次请求的完整前缀已带断点发过)命中数不比前一次多——
//   五块每轮重拼,轮与轮之间本来只有固定前缀可命中;只有轮内工具往返才看得出渠道是否缓存了第 1 块之后的内容。
// 未命中归因(只看带断点的请求):同线路同前缀上一次调用超过 TTL → expired(过期,不算前缀错误);TTL 内同前缀仍没命中 → uncached;
//   同线路从没见过这个前缀,而同一联系人同种调用以前发过别的前缀 → prefix-changed(前缀变了,规矩变更如实计入);都没有 → cold(首调)。
// 低于阈值:给了阈值(alertBelow,或 alertBelowByLine 按线路单独设)时,计入命中率的调用不少于 minCalls 且命中率低于阈值标 low-hit-rate。
//   阈值待用户按线路定(验收文档 §8.1「AC-39 缓存命中率报警阈值」待定,#1074 不自行硬填数字),所以默认不设、不标;只是统计结果里的标记,不推送。
import type { UsageKind } from "@g-group/kernel";

export interface UsageRow {
  readonly id: number;
  readonly at: string;
  readonly kind: UsageKind;
  readonly line: string;
  readonly contactId: string;
  readonly roomIds: readonly string[];
  readonly roundId: string;
  readonly request: number;
  readonly prefixHash: string;
  readonly breakpoints: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export type StatsDim = "line" | "contact" | "room" | "kind";
export type CacheFlag = "split-accounting" | "first-segment-only" | "low-hit-rate";
export type SplitReason = "constant-ratio" | "hit-without-breakpoint";
export type MissKind = "cold" | "prefix-changed" | "expired" | "uncached";

/** 缓存 TTL 默认 5 分钟(短缓存;宿主没开 1 小时缓存) */
export const DEFAULT_CACHE_TTL_MS = 300_000;
/** 至少这么多次计入命中率的调用才判低于阈值,避免一两次冷启动就标 */
export const DEFAULT_CACHE_MIN_CALLS = 3;
/** 可信度检查至少要的样本数 */
export const TRUST_MIN_SAMPLES = 3;

export interface CacheStatsQuery {
  readonly since?: string;
  readonly until?: string;
  readonly by: readonly StatsDim[];
  readonly kinds?: readonly UsageKind[];
  readonly ttlMs?: number;
  readonly alertBelow?: number;
  readonly alertBelowByLine?: readonly { readonly line: string; readonly below: number }[];
  readonly minCalls?: number;
}
export interface MissCounts {
  cold: number;
  prefixChanged: number;
  expired: number;
  uncached: number;
}
export interface CacheStatsGroup {
  readonly line: string | null;
  readonly contactId: string | null;
  readonly room: string | null;
  readonly kind: UsageKind | null;
  readonly calls: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** 计入命中率的调用数(拆账口径线路上的调用不计) */
  readonly countedCalls: number;
  /** 计入部分的命中率;没有可计入的输入为 null */
  readonly hitRate: number | null;
  /** 这一组用的阈值;没设为 null(不标 low-hit-rate) */
  readonly alertBelow: number | null;
  readonly flags: readonly CacheFlag[];
  readonly misses: Readonly<MissCounts>;
}
export interface LineVerdict {
  readonly line: string;
  readonly calls: number;
  readonly splitAccounting: SplitReason | null;
  readonly firstSegmentOnly: boolean;
}
export interface CacheStatsResult {
  readonly since: string | null;
  readonly until: string | null;
  readonly by: readonly StatsDim[];
  readonly ttlMs: number;
  readonly groups: readonly CacheStatsGroup[];
  readonly lines: readonly LineVerdict[];
}

export function hitRateOf(_rows: readonly UsageRow[]): number | null {
  return null;
}
export function constantRatio(_rows: readonly UsageRow[]): boolean {
  return false;
}
export function hitWithoutBreakpoint(_rows: readonly UsageRow[]): boolean {
  return false;
}
export function firstSegmentOnly(_rows: readonly UsageRow[], _ttlMs: number): boolean {
  return false;
}
export function classifyMisses(_rows: readonly UsageRow[], _ttlMs: number): Map<number, MissKind> {
  return new Map();
}
export function judgeLines(_rows: readonly UsageRow[], _ttlMs: number): LineVerdict[] {
  return [];
}
export function cacheStats(_history: readonly UsageRow[], q: CacheStatsQuery): CacheStatsResult {
  return { since: q.since ?? null, until: q.until ?? null, by: [...q.by], ttlMs: q.ttlMs ?? DEFAULT_CACHE_TTL_MS, groups: [], lines: [] };
}
