// 缓存命中统计(AC-39 ⑤⑥、D22 第 3 节第 7 条)。纯函数,不做 I/O:输入 gg_usage 的行,输出按「线路 × 联系人 × 群」(可加种类)分组的命中率。
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

const ms = (iso: string): number => Date.parse(iso);
/** 先按时间、再按落表顺序 */
const chrono = (a: UsageRow, b: UsageRow): number => ms(a.at) - ms(b.at) || a.id - b.id;
const prompt = (r: UsageRow): number => r.input + r.cacheRead + r.cacheWrite;

/** 命中率口径(D22):cache_read / (input + cache_read + cache_write);分母为 0 返回 null */
export function hitRateOf(rows: readonly UsageRow[]): number | null {
  const total = rows.reduce((n, r) => n + prompt(r), 0);
  return total === 0 ? null : rows.reduce((n, r) => n + r.cacheRead, 0) / total;
}

/** kiro 式拆账:cache_read 与 input 恒成同一比例(四舍五入允许 ±2 token),input 本身有变化 */
export function constantRatio(rows: readonly UsageRow[]): boolean {
  const xs = rows.filter((r) => r.input > 0 && r.cacheRead > 0);
  if (xs.length < TRUST_MIN_SAMPLES) return false;
  const ins = xs.map((r) => r.input);
  const lo = Math.min(...ins);
  const hi = Math.max(...ins);
  if ((hi - lo) / hi < 0.05) return false;
  const ratios = xs.map((r) => r.cacheRead / r.input).sort((a, b) => a - b);
  const k = ratios[Math.floor(ratios.length / 2)]!;
  return xs.every((r) => Math.abs(r.cacheRead - k * r.input) <= Math.max(2, 0.002 * r.cacheRead));
}

/** 不声明缓存却报命中:请求里没有任何 cache_control,端点还报 cache_read > 0 */
export function hitWithoutBreakpoint(rows: readonly UsageRow[]): boolean {
  return rows.some((r) => r.breakpoints === 0 && r.cacheRead > 0);
}

/** 只缓存首段:同一轮的后续请求命中数不比前一次多(至少 TRUST_MIN_SAMPLES 对,八成以上如此) */
export function firstSegmentOnly(rows: readonly UsageRow[], ttlMs: number): boolean {
  const byKey = new Map<string, UsageRow>();
  for (const r of rows) if (r.kind === "round") byKey.set(`${r.roundId}#${r.request}`, r);
  let pairs = 0;
  let flat = 0;
  for (const r of rows) {
    if (r.kind !== "round" || r.request < 2 || r.breakpoints === 0) continue;
    const prev = byKey.get(`${r.roundId}#${r.request - 1}`);
    if (!prev || prev.cacheRead === 0 || ms(r.at) - ms(prev.at) > ttlMs) continue;
    pairs++;
    if (r.cacheRead <= prev.cacheRead) flat++;
  }
  return pairs >= TRUST_MIN_SAMPLES && flat >= 0.8 * pairs;
}

/** 每次未命中(带断点、cache_read 为 0)的归因;命中或不带断点的请求不在结果里 */
export function classifyMisses(rows: readonly UsageRow[], ttlMs: number): Map<number, MissKind> {
  const out = new Map<number, MissKind>();
  const lastByPrefix = new Map<string, UsageRow>();
  const seenBySender = new Set<string>();
  for (const r of [...rows].sort(chrono)) {
    const pk = `${r.line}\n${r.prefixHash}`;
    const sk = `${r.line}\n${r.contactId}\n${r.kind}`;
    if (r.breakpoints > 0 && r.cacheRead === 0) {
      const prev = lastByPrefix.get(pk);
      if (prev) out.set(r.id, ms(r.at) - ms(prev.at) > ttlMs ? "expired" : "uncached");
      else out.set(r.id, seenBySender.has(sk) ? "prefix-changed" : "cold");
    }
    lastByPrefix.set(pk, r);
    seenBySender.add(sk);
  }
  return out;
}

/** 线路可信度(按窗口内的行):拆账口径(两种判据之一)、只缓存首段 */
export function judgeLines(rows: readonly UsageRow[], ttlMs: number): LineVerdict[] {
  const byLine = new Map<string, UsageRow[]>();
  for (const r of rows) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  const out: LineVerdict[] = [];
  for (const [line, win] of [...byLine].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const split: SplitReason | null = constantRatio(win) ? "constant-ratio" : hitWithoutBreakpoint(win) ? "hit-without-breakpoint" : null;
    out.push(Object.freeze({ line, calls: win.length, splitAccounting: split, firstSegmentOnly: split === null && firstSegmentOnly(win, ttlMs) }));
  }
  return out;
}

const roomKey = (r: UsageRow): string => [...r.roomIds].sort().join(",");

/** 按维度分组出命中率、可信度标记、低于阈值标记与未命中归因 */
export function cacheStats(history: readonly UsageRow[], q: CacheStatsQuery): CacheStatsResult {
  const ttlMs = q.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const since = q.since ?? null;
  const until = q.until ?? null;
  const lo = since === null ? Number.NEGATIVE_INFINITY : ms(since);
  const hi = until === null ? Number.POSITIVE_INFINITY : ms(until);
  const upto = history.filter((r) => ms(r.at) < hi);
  const inWindow = (r: UsageRow) => ms(r.at) >= lo && ms(r.at) < hi;
  const lines = judgeLines(upto.filter(inWindow), ttlMs);
  const verdict = new Map(lines.map((v) => [v.line, v]));
  const misses = classifyMisses(upto, ttlMs);
  const kinds = q.kinds ? new Set(q.kinds) : null;
  const rows = upto.filter((r) => inWindow(r) && (kinds === null || kinds.has(r.kind)));
  const dims = new Set(q.by);
  const keyOf = (r: UsageRow) => ({
    line: dims.has("line") ? r.line : null,
    contactId: dims.has("contact") ? r.contactId : null,
    room: dims.has("room") ? roomKey(r) : null,
    kind: dims.has("kind") ? r.kind : null,
  });
  const groups = new Map<string, { key: ReturnType<typeof keyOf>; rows: UsageRow[] }>();
  for (const r of rows) {
    const key = keyOf(r);
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  const byLine = new Map((q.alertBelowByLine ?? []).map((x) => [x.line, x.below]));
  const minCalls = q.minCalls ?? DEFAULT_CACHE_MIN_CALLS;
  const sum = (xs: UsageRow[], f: (r: UsageRow) => number) => xs.reduce((n, r) => n + f(r), 0);
  const out: CacheStatsGroup[] = [];
  for (const { key, rows: gr } of [...groups.values()].sort((a, b) => (JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : 1))) {
    const counted = gr.filter((r) => !verdict.get(r.line)?.splitAccounting);
    const hitRate = hitRateOf(counted);
    const lineSet = new Set(gr.map((r) => r.line));
    const only = lineSet.size === 1 ? [...lineSet][0]! : null;
    const alertBelow = (only !== null ? byLine.get(only) : undefined) ?? q.alertBelow ?? null;
    const flags: CacheFlag[] = [];
    if ([...lineSet].some((l) => verdict.get(l)?.splitAccounting)) flags.push("split-accounting");
    if ([...lineSet].some((l) => verdict.get(l)?.firstSegmentOnly)) flags.push("first-segment-only");
    if (alertBelow !== null && hitRate !== null && counted.length >= minCalls && hitRate < alertBelow) flags.push("low-hit-rate");
    const m: MissCounts = { cold: 0, prefixChanged: 0, expired: 0, uncached: 0 };
    for (const r of gr) {
      const why = misses.get(r.id);
      if (why === "cold") m.cold++;
      else if (why === "prefix-changed") m.prefixChanged++;
      else if (why === "expired") m.expired++;
      else if (why === "uncached") m.uncached++;
    }
    out.push(
      Object.freeze({
        ...key,
        calls: gr.length,
        input: sum(gr, (r) => r.input),
        cacheRead: sum(gr, (r) => r.cacheRead),
        cacheWrite: sum(gr, (r) => r.cacheWrite),
        output: sum(gr, (r) => r.output),
        countedCalls: counted.length,
        hitRate,
        alertBelow,
        flags: Object.freeze(flags),
        misses: Object.freeze(m),
      }),
    );
  }
  return Object.freeze({ since, until, by: Object.freeze([...q.by]), ttlMs, groups: Object.freeze(out), lines: Object.freeze(lines) });
}
