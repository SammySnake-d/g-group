// 联系人记忆的纯函数(需求文档 D25;验收 AC-42)。不做 I/O、不调用模型。
//   存储:每条记忆一个 md 文件(真源),frontmatter 是 JSON(YAML 的子集,不加依赖),正文是记忆原文。索引由宿主从 md 派生、可重建。
//   写:planMemoryWrite 只在锚点相交的邻域里判关系——内容相同(去空白)算复述,只挂佐证;模型指明 change 出新版本并把旧条目标已替代;
//       refine 挂细化关系;conflict 且两边都来自用户原话时不自动替代,交用户拍板;其余新建。写下即生效(#2375),不进候选区。
//   读:selectMemories 硬筛(生效或降级、在有效期内、锚点相交、非全局),按锚点命中、与本轮文字的全文相关名次、使用记录排序;
//       同分按 id;在分数最大落差处截断(不用固定条数或固定阈值,#2391),内容重复的只展开一条,其余给 id 加标题。
//       全文相关只在硬筛后的候选里经检索接缝 history-search.ts(上游 acp-kernel 的 hybrid 检索)算名次,见 memoryTextRanks(T-177 G3-a)。
//   前缀:prefixMemories 只收生效的全局条目(每轮都适用的才进前缀,不设 token 上限)。
//   反馈:recordMemoryUse 记 uses;连续 DEGRADE_AFTER 次结果不好降级(不删除),降级后一次好结果恢复。
import { INVISIBLE_SOURCE } from "./assemble.ts";
import { searchHistory } from "./history-search.ts";

// 去掉空白与零宽字符后比对(与 assemble.ts 撤回比对同一套字符)。复述判定、去重都对两边同样处理,
// 不写返回类型标注:G-STUB 的返回值变异对两边同时生效时改不了行为(等价变异),这里不让它把对称用法误报成「没测计算结果」
const INVIS = new RegExp(INVISIBLE_SOURCE, "gu");
const squash = (t: string) => t.replace(INVIS, "");

export type MemoryStatus = "active" | "superseded" | "revoked" | "degraded";
export interface MemorySource { readonly roomId: string; readonly seq: number; readonly userQuote: boolean; readonly revision?: number; readonly quote?: string; readonly senderId?: string }
export interface MemoryUse { readonly at: string; readonly good: boolean; readonly note?: string }
export interface MemoryEntry {
  /** 已落实的自动检查写入身份；随 md 真源保存，重建索引不丢。 */
  readonly captureIds?: readonly string[];
  readonly id: string;
  readonly version: number;
  readonly status: MemoryStatus;
  readonly title: string;
  readonly body: string;
  /** 锚点:"room:<id>"、"user:<uid>"、"contact:<id>"、"task:<id>"、"tool:<名>"、"path:<路径>"、"module:<名>",或 "global" */
  readonly anchors: readonly string[];
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly source: MemorySource | null;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly refines: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly derivedFrom: readonly string[];
  readonly evidence: readonly { readonly roomId: string; readonly seq: number; readonly at: string }[];
  readonly uses: readonly MemoryUse[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MemoryWrite {
  readonly title: string;
  readonly body: string;
  readonly anchors: readonly string[];
  readonly source: MemorySource | null;
  readonly relation: { readonly kind: "change" | "refine" | "conflict"; readonly target: string } | null;
}
export type MemoryPlan =
  | { readonly kind: "new" | "change" | "refine"; readonly entry: MemoryEntry; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "restate"; readonly target: string; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "ask-user"; readonly target: string; readonly entry: MemoryEntry; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "invalid"; readonly why: string };

export const GLOBAL_ANCHOR = "global";
export const DEGRADE_AFTER = 3;
const STATUSES: readonly MemoryStatus[] = ["active", "superseded", "revoked", "degraded"];

// ---------------------------------------------------------------- md 真源

export function serializeMemory(e: MemoryEntry): string {
  const { body, ...front } = e;
  return `---\n${JSON.stringify(front, null, 2)}\n---\n${body}\n`;
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isStrOrNull = (x: unknown) => x === null || isStr(x);
const isStrs = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isNat = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

export function parseMemory(text: string): { ok: true; entry: MemoryEntry } | { ok: false; why: string } {
  if (!text.startsWith("---\n")) return { ok: false, why: "缺少 frontmatter(文件应以 --- 开头)" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { ok: false, why: "frontmatter 没有结束行 ---" };
  let f: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text.slice(4, end));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, why: "frontmatter 必须是对象" };
    f = v as Record<string, unknown>;
  } catch (e) {
    return { ok: false, why: `frontmatter 不是合法 JSON:${e instanceof Error ? e.message : String(e)}` };
  }
  let body = text.slice(end + 5);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  const bad = (k: string) => ({ ok: false as const, why: `字段 ${k} 缺失或类型不对` });
  if (!isStr(f.id) || f.id === "") return bad("id");
  if (!isNat(f.version)) return bad("version");
  if (!STATUSES.includes(f.status as MemoryStatus)) return bad("status");
  if (!isStr(f.title)) return bad("title");
  if (!isStrs(f.anchors)) return bad("anchors");
  if (!isStrOrNull(f.validFrom)) return bad("validFrom");
  if (!isStrOrNull(f.validTo)) return bad("validTo");
  const s = f.source as Record<string, unknown> | null;
  if (s !== null && (typeof s !== "object" || !isStr(s.roomId) || !isNat(s.seq) || typeof s.userQuote !== "boolean")) return bad("source");
  for (const k of ["supersedes", "refines", "conflictsWith", "derivedFrom"]) if (!isStrs(f[k])) return bad(k);
  if (!isStrOrNull(f.supersededBy)) return bad("supersededBy");
  if (!Array.isArray(f.evidence) || !f.evidence.every((x: unknown) => typeof x === "object" && x !== null && isStr((x as Record<string, unknown>).roomId) && isNat((x as Record<string, unknown>).seq) && isStr((x as Record<string, unknown>).at))) return bad("evidence");
  if (!Array.isArray(f.uses) || !f.uses.every((x: unknown) => typeof x === "object" && x !== null && isStr((x as Record<string, unknown>).at) && typeof (x as Record<string, unknown>).good === "boolean")) return bad("uses");
  if (!isStr(f.createdAt) || !isStr(f.updatedAt)) return bad("createdAt/updatedAt");
  return { ok: true, entry: { ...(f as unknown as Omit<MemoryEntry, "body">), body } };
}

// ---------------------------------------------------------------- 写

const live = (e: MemoryEntry) => e.status === "active" || e.status === "degraded";
const meets = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

function blank(id: string, w: MemoryWrite, now: string): MemoryEntry {
  return {
    id, version: 1, status: "active", title: w.title, body: w.body, anchors: [...w.anchors], validFrom: null, validTo: null, source: w.source,
    supersedes: [], supersededBy: null, refines: [], conflictsWith: [], derivedFrom: [], evidence: [], uses: [], createdAt: now, updatedAt: now,
  };
}

export function planMemoryWrite(entries: readonly MemoryEntry[], w: MemoryWrite, now: string, newId: () => string): MemoryPlan {
  if (!isStr(w.title) || w.title.trim() === "") return { kind: "invalid", why: "title 不能为空" };
  if (!isStr(w.body) || w.body.trim() === "") return { kind: "invalid", why: "正文不能为空" };
  if (!isStrs(w.anchors) || w.anchors.length === 0 || w.anchors.some((a) => a.trim() === "")) return { kind: "invalid", why: "至少要有一个非空锚点" };
  if (w.relation !== null) {
    const target = entries.find((e) => e.id === w.relation?.target);
    if (!target) return { kind: "invalid", why: `没有记忆 ${w.relation.target}` };
    if (!live(target)) return { kind: "invalid", why: `记忆 ${target.id} 已${target.status === "superseded" ? "被替代" : "撤销"},只能对生效条目判关系` };
    const fresh = blank(newId(), w, now);
    const bothQuotes = w.source?.userQuote === true && target.source?.userQuote === true;
    if (w.relation.kind === "refine") {
      const e = { ...fresh, refines: [target.id] };
      return { kind: "refine", entry: e, changed: [e] };
    }
    if (w.relation.kind === "conflict" && bothQuotes) {
      const e = { ...fresh, conflictsWith: [target.id] };
      return { kind: "ask-user", target: target.id, entry: e, changed: [e] };
    }
    const e = { ...fresh, supersedes: [target.id] };
    const old: MemoryEntry = { ...target, status: "superseded", supersededBy: e.id, version: target.version + 1, updatedAt: now };
    return { kind: "change", entry: e, changed: [e, old] };
  }
  const key = squash(w.body);
  const same = entries.find((e) => live(e) && meets(e.anchors, w.anchors) && squash(e.body) === key);
  if (same) {
    const ev = w.source === null ? { roomId: "", seq: 0, at: now } : { roomId: w.source.roomId, seq: w.source.seq, at: now };
    return { kind: "restate", target: same.id, changed: [{ ...same, evidence: [...same.evidence, ev], version: same.version + 1, updatedAt: now }] };
  }
  const e = blank(newId(), w, now);
  return { kind: "new", entry: e, changed: [e] };
}

// ---------------------------------------------------------------- 读

const inWindow = (e: MemoryEntry, now: string) => (e.validFrom === null || e.validFrom <= now) && (e.validTo === null || e.validTo > now);

/** 旧全文分量(字面重合个数)所在整数区间的上界:本轮文字里不同的相邻二字与英文词的个数。只用来给名次封顶,不再拿它打分 */
function literalUnits(text: string) {
  const grams = new Set<string>();
  const chars = [...squash(text).toLowerCase()];
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i]! + chars[i + 1]!);
  for (const w of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) grams.add(w);
  return grams.size;
}

/**
 * 全文分量(T-177 G3-a):检索接缝只给名次,不直接用它的小数分。命中的条目按检索分数从高到低分档(同分同档),
 * 第 k 档(0 起)记 max(1, min(上界, 档数) − k),未命中记 0。上界是旧分量「字面重合个数」能取到的最大值(literalUnits),
 * 所以新分量仍是 0 起、步长 1、落在旧整数区间里的整数,锚点 ×10、好评/差评 ±1、降级 −5 的相对权重和断崖量纲不变。
 * 只在传入的条目里检索(调用方先做硬筛),空文字、没有条目时全为 0。
 */
export function memoryTextRanks(entries: readonly MemoryEntry[], text: string): Map<string, number> {
  const out = new Map(entries.map((e) => [e.id, 0]));
  const cap = literalUnits(text);
  if (cap === 0 || entries.length === 0) return out;
  const hits = searchHistory(entries.map((e) => ({ ref: e.id, role: "user" as const, text: `${e.title}\n${e.body}` })), text, entries.length);
  const levels = [...new Set(hits.map((h) => h.score))];
  const top = Math.min(cap, levels.length);
  for (const h of hits) out.set(h.ref, Math.max(1, top - levels.indexOf(h.score)));
  return out;
}

function score(e: MemoryEntry, anchors: readonly string[], ranks: ReadonlyMap<string, number>) {
  const hits = e.anchors.filter((a) => anchors.includes(a)).length;
  const good = e.uses.filter((u) => u.good).length;
  const badN = e.uses.length - good;
  return hits * 10 + (ranks.get(e.id) ?? 0) + good - badN - (e.status === "degraded" ? 5 : 0);
}
const byId = (a: MemoryEntry, b: MemoryEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function selectMemories(entries: readonly MemoryEntry[], ctx: { anchors: readonly string[]; text: string; now: string }): { expanded: MemoryEntry[]; listed: { id: string; title: string }[] } {
  const cand = entries.filter((e) => live(e) && inWindow(e, ctx.now) && !e.anchors.includes(GLOBAL_ANCHOR) && meets(e.anchors, ctx.anchors));
  const ranks = memoryTextRanks(cand, ctx.text);
  const ranked = cand.map((e) => ({ e, s: score(e, ctx.anchors, ranks) })).sort((a, b) => b.s - a.s || byId(a.e, b.e));
  // 断崖:相邻分数的最大落差处;没有落差就全部展开
  let cut = ranked.length;
  let maxDrop = 0;
  for (let i = 0; i + 1 < ranked.length; i++) {
    const d = ranked[i]!.s - ranked[i + 1]!.s;
    if (d > maxDrop) { maxDrop = d; cut = i + 1; }
  }
  const expanded: MemoryEntry[] = [];
  const listed: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  ranked.forEach(({ e }, i) => {
    const k = squash(e.body);
    if (i < cut && !seen.has(k)) { expanded.push(e); seen.add(k); }
    else listed.push({ id: e.id, title: e.title });
  });
  return { expanded, listed };
}

export function prefixMemories(entries: readonly MemoryEntry[], now: string): MemoryEntry[] {
  return entries
    .filter((e) => e.status === "active" && inWindow(e, now) && e.anchors.includes(GLOBAL_ANCHOR))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------- 用后反馈

export function recordMemoryUse(e: MemoryEntry, use: MemoryUse, now: string): MemoryEntry {
  const uses = [...e.uses, use];
  let status = e.status;
  if (status === "active" && uses.length >= DEGRADE_AFTER && uses.slice(-DEGRADE_AFTER).every((u) => !u.good)) status = "degraded";
  else if (status === "degraded" && use.good) status = "active";
  return { ...e, uses, status, version: e.version + 1, updatedAt: now };
}
