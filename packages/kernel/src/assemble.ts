// 上下文装配:AC-06 引用旧消息确定性 Page-in + AC-39 / D22 群聊缓存前缀纪律 + AC-08 撤回不再暴露原文。
// 请求分三段,顺序固定:
//   stable  :system → 工具定义 → 人设规则,调用方给的固定文本;顺序在输入层校验;段内出现时间、消息序号、任务号、"最近 N 条"就报错;
//   history :已压缩块 + 压缩点之后的日志事件,按事件追加:消息按发出时的原文,编辑作为新事件"编辑 #x 为: …"追加在末尾,
//             不回头改旧消息,所以编辑不破坏前缀;
//   tail    :被引用旧消息的 Page-in(最新文字)与会变的状态,放在最末,不进缓存前缀。
// 撤回优先于缓存(AC-08 正确性优先于 AC-39):被撤回消息的原文和它的编辑都不再进请求。
//   在 history 里:从该位置起前缀作废,结果里标 prefixBreaks {reason:"retract"},宿主统计时不算前缀错误(同 TTL 过期);
//   在压缩块里:块是撤回前生成的就作废,调用方给 recompress 就重建,不给就返回 recompress-required;
//   recompress 只拿到冻结副本,只能返回压缩块文本;引用页入从权威日志重新投影;
//   最终请求的每一段内容(stable、压缩块、history、tail、会变状态)都逐字扫撤回原文(含短文本,去空白比对),命中即 retracted-text-leaked。
// 缓存断点(D22 规则 3):工具定义末尾、stable 末尾、已压缩块末尾、最新追加的事件,按构造最多 4 个。
// 超预算显式失败并要求压缩,禁止静默截断。
import { createHash } from "node:crypto";
import { type Log, type LogEvent, type ProjectedMessage, project } from "@g-group/domain";

export type StableKind = "system" | "tools" | "persona";
export interface StablePart { readonly kind: StableKind; readonly text: string }
/** 压缩块:throughSeq 及之前的日志事件已压缩成 text;builtAtSeq 是生成它时日志的最新 seq,用来判断之后的撤回是否让它作废 */
export interface CompressedBlock { readonly throughSeq: number; readonly builtAtSeq: number; readonly text: string }
/** 重建压缩块:给出 throughSeq 及之前仍可见的消息(最新文字),返回不含已撤回内容的新块 */
export type Recompress = (throughSeq: number, visible: readonly ProjectedMessage[]) => string;

export interface AssembleOptions {
  readonly stable: readonly StablePart[];
  readonly compressed?: CompressedBlock;
  readonly recompress?: Recompress;
  /** 上一次装配时日志的最新 seq;只把它之后发生的撤回报成 prefixBreak。不给就报全部 */
  readonly previousHeadSeq?: number;
  /** 被引用的 #seq,原文必须精确进装配 */
  readonly quotes: readonly number[];
  /** 会变的状态(当前时间、任务表、扫一眼摘要),只进 tail */
  readonly volatile?: string;
  /** 整个请求体的字节上限(UTF-8) */
  readonly budgetBytes: number;
}

export type Section = "stable" | "history" | "tail";
export interface Segment {
  readonly section: Section;
  readonly label: string;
  readonly seq?: number;
  readonly text: string;
  readonly bytes: number;
  readonly cacheBreakpoint: boolean;
}
export interface AssembledRequest { readonly segments: readonly Segment[] }
export interface ManifestEntry { readonly seq: number; readonly bytes: number; readonly via: "history" | "page-in" }
/** 前缀从这里起作废:撤回导致,宿主统计命中率时不算前缀错误 */
export interface PrefixBreak { readonly reason: "retract"; readonly seq: number; readonly at: "compressed" | "history" }
export const MAX_BREAKPOINTS = 4;
export const STABLE_ORDER: readonly StableKind[] = ["system", "tools", "persona"];

export type AssembleResult =
  | {
    ok: true; request: AssembledRequest; manifest: ManifestEntry[]; totalBytes: number; headSeq: number;
    skipped: { seq: number; reason: "retracted" }[]; prefixBreaks: PrefixBreak[]; compressed?: CompressedBlock;
  }
  | { ok: false; reason: "over-budget"; need: number; budget: number; action: "compress" }
  | { ok: false; reason: "quote-not-found"; seq: number }
  | { ok: false; reason: "volatile-in-stable"; part: StableKind; match: string }
  | { ok: false; reason: "invalid-stable"; detail: string }
  | { ok: false; reason: "invalid-compressed"; detail: string }
  | { ok: false; reason: "recompress-required"; fromSeq: number }
  | { ok: false; reason: "retracted-text-leaked"; where: LeakWhere; seq: number };
/** 撤回原文在最终请求里出现的位置 */
export type LeakWhere = "stable" | "compressed" | "history" | "tail" | "volatile";
const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const who = (e: { sender: { kind: string; id: string } }) => `${e.sender.kind}:${e.sender.id}`;
const renderMsg = (m: ProjectedMessage) => `#${m.seq} ${who(m)}: ${m.text}\n`;

/** stable 段自身不许出现的会变内容:只认可判定的动态格式(日期、时刻、#序号、任务号、带数字的最近 N 条),
 *  不认"新消息"这类普通词;只扫调用方给的固定文本,不拿会话消息去比对 */
const VOLATILE_PATTERNS: readonly [string, RegExp][] = [
  ["日期", /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/],
  ["时刻", /\b\d{1,2}:\d{2}(?::\d{2})?\b/],
  ["消息序号", /#\d+/],
  ["任务号", /\bT-\d+\b/],
  ["最近 N 条", /最近\s*\d+\s*条/],
];

function volatileIn(text: string): string | undefined {
  for (const [name, re] of VOLATILE_PATTERNS) {
    const m = re.exec(text);
    if (m) return `${name}:${m[0]}`;
  }
  return undefined;
}

/** 固定段:只能是 system、tools、persona,各至多一次,必须有 system,顺序必须 system → tools → persona */
function checkStable(parts: readonly StablePart[]): string | undefined {
  if (!Array.isArray(parts) || parts.length === 0) return "stable 不能为空";
  const seen = new Set<StableKind>();
  let last = -1;
  for (const p of parts) {
    const i = STABLE_ORDER.indexOf(p?.kind);
    if (i < 0) return `未知固定段 ${String(p?.kind)}`;
    if (typeof p.text !== "string") return `${p.kind} 的 text 必须是字符串`;
    if (seen.has(p.kind)) return `固定段 ${p.kind} 重复`;
    if (i < last) return `固定段顺序必须是 system → tools → persona,收到 ${parts.map((x) => x.kind).join(" → ")}`;
    seen.add(p.kind);
    last = i;
  }
  if (!seen.has("system")) return "缺 system 段";
  return undefined;
}

const isNat = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

/** 压缩点必须落在有效日志范围:0 ≤ throughSeq ≤ builtAtSeq ≤ 日志最新 seq,都是整数 */
function checkCompressed(c: CompressedBlock, head: number): string | undefined {
  if (!isNat(c.throughSeq)) return `throughSeq 必须是非负整数,收到 ${String(c.throughSeq)}`;
  if (!isNat(c.builtAtSeq)) return `builtAtSeq 必须是非负整数,收到 ${String(c.builtAtSeq)}`;
  if (typeof c.text !== "string") return "压缩块 text 必须是字符串";
  if (c.throughSeq > head) return `压缩点 #${c.throughSeq} 超过日志最新 #${head}`;
  if (c.builtAtSeq < c.throughSeq || c.builtAtSeq > head) return `builtAtSeq #${c.builtAtSeq} 必须在 #${c.throughSeq} 与日志最新 #${head} 之间`;
  return undefined;
}

/** 被撤回消息的全部原文:发出时的文字和它之后每次编辑的文字 */
function retractedTexts(events: readonly LogEvent[], retracted: ReadonlySet<number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const e of events) {
    const b = e.body;
    if (b.kind === "message" && retracted.has(e.seq)) out.set(e.seq, [...(out.get(e.seq) ?? []), b.text]);
    if (b.kind === "edit" && retracted.has(b.target)) out.set(b.target, [...(out.get(b.target) ?? []), b.text]);
  }
  return out;
}

/** 空白规范化:去掉全部空白后比对,"秘 密"和"秘密"算同一段 */
const squash = (t: string) => t.replace(/\s+/gu, "");

/** 在 text 里找被撤回的原文(含短文本);命中返回消息 seq */
function leakIn(text: string, texts: ReadonlyMap<number, string[]>): number | undefined {
  const hay = squash(text);
  for (const [seq, list] of texts) for (const t of list) { const needle = squash(t); if (needle !== "" && hay.includes(needle)) return seq; }
  return undefined;
}

/** 交给外部回调的消息:深拷贝后递归冻结,回调改不了宿主手里的投影 */
function frozenSnapshot(ms: readonly ProjectedMessage[]): readonly ProjectedMessage[] {
  return Object.freeze(ms.map((m) => Object.freeze({ seq: m.seq, sender: Object.freeze({ kind: m.sender.kind, id: m.sender.id }), text: m.text, edited: m.edited, retracted: m.retracted })));
}

const seg = (section: Section, label: string, text: string, extra: { seq?: number } = {}): Segment =>
  ({ section, label, text, bytes: bytesOf(text), cacheBreakpoint: false, ...extra });

export function assemble(log: Log, opts: AssembleOptions): AssembleResult {
  const stableBad = checkStable(opts.stable);
  if (stableBad) return { ok: false, reason: "invalid-stable", detail: stableBad };
  for (const part of opts.stable) {
    const hit = volatileIn(part.text);
    if (hit) return { ok: false, reason: "volatile-in-stable", part: part.kind, match: hit };
  }
  const events = log.events;
  const head = events.at(-1)?.seq ?? 0;
  const all = project(log);
  const retractSeqOf = new Map<number, number>(); // 被撤回的消息 → 撤回事件 seq
  for (const e of events) if (e.body.kind === "retract") retractSeqOf.set(e.body.target, e.seq);
  const retracted = new Set(retractSeqOf.keys());
  const isNew = (retractSeq: number) => opts.previousHeadSeq === undefined || retractSeq > opts.previousHeadSeq;
  const secret = retractedTexts(events, retracted);
  const prefixBreaks: PrefixBreak[] = [];

  // 压缩块:撤回发生在它生成之后,且撤回的消息在它覆盖的范围里 → 作废
  let block = opts.compressed;
  if (block) {
    const bad = checkCompressed(block, head);
    if (bad) return { ok: false, reason: "invalid-compressed", detail: bad };
    const b = block;
    const stale = [...retractSeqOf].filter(([target, rs]) => target <= b.throughSeq && rs > b.builtAtSeq).map(([target]) => target);
    if (stale.length > 0) {
      const fromSeq = Math.min(...stale);
      if (!opts.recompress) return { ok: false, reason: "recompress-required", fromSeq };
      const visible = frozenSnapshot(all.filter((m) => m.seq <= b.throughSeq && !m.retracted));
      let text: unknown;
      try { text = opts.recompress(b.throughSeq, visible); } catch (err) {
        return { ok: false, reason: "invalid-compressed", detail: `recompress 抛错(它只能返回压缩块文本,不能改消息投影):${err instanceof Error ? err.message : "未知错误"}` };
      }
      if (typeof text !== "string") return { ok: false, reason: "invalid-compressed", detail: "recompress 必须返回字符串" };
      block = Object.freeze({ throughSeq: b.throughSeq, builtAtSeq: head, text });
      prefixBreaks.push({ reason: "retract", seq: fromSeq, at: "compressed" });
    }
  }
  const through = block?.throughSeq ?? 0;

  // history:压缩点之后的事件按发生顺序追加;撤回的消息和它的编辑都不出现
  const segments: Segment[] = [];
  for (const part of opts.stable) segments.push(seg("stable", part.kind, `[${part.kind}]\n${part.text}\n`));
  if (block) segments.push(seg("history", "compressed", `[已压缩至 #${block.throughSeq}]\n${block.text}\n`));
  const inHistory = new Set<number>();
  for (const e of events) {
    if (e.seq <= through) continue;
    const b = e.body;
    if (b.kind === "message") {
      if (retracted.has(e.seq)) continue;
      inHistory.add(e.seq);
      segments.push(seg("history", "message", `#${e.seq} ${who(e)}: ${b.text}\n`, { seq: e.seq }));
    } else if (b.kind === "edit") {
      if (retracted.has(b.target)) continue;
      segments.push(seg("history", "edit", `#${e.seq} ${who(e)} 编辑 #${b.target} 为: ${b.text}\n`, { seq: e.seq }));
    }
  }
  for (const [target, rs] of retractSeqOf) if (target > through && isNew(rs)) prefixBreaks.push({ reason: "retract", seq: target, at: "history" });

  // tail:被引用旧消息按最新文字页入(all 来自权威日志;回调只拿到冻结深拷贝,改不了它);已在 history 的不重复;撤回的跳过
  const paged: ProjectedMessage[] = [];
  const skipped: { seq: number; reason: "retracted" }[] = [];
  for (const seq of opts.quotes) {
    const m = all.find((x) => x.seq === seq);
    if (!m) return { ok: false, reason: "quote-not-found", seq };
    if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }
    if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;
    paged.push(m);
  }
  for (const m of paged) segments.push(seg("tail", "page-in", `[引用页入] ${renderMsg(m)}`, { seq: m.seq }));
  if (opts.volatile !== undefined && opts.volatile !== "") segments.push(seg("tail", "volatile", `[当前状态]\n${opts.volatile}\n`));

  // 最终请求边界:每一段的内容(不含序号与发言者标签)逐字扫撤回原文,含短文本
  for (const sg of segments) {
    const content = scanContent(sg, opts, block);
    const leaked = leakIn(content, secret);
    if (leaked !== undefined) return { ok: false, reason: "retracted-text-leaked", where: whereOf(sg), seq: leaked };
  }

  // 断点:工具定义末尾、stable 末尾、已压缩块末尾、最新追加的事件;tail 里永远不放
  const lastOf = (pred: (s: Segment) => boolean) => segments.findLastIndex(pred);
  const marks = new Set([
    lastOf((s) => s.label === "tools"),
    lastOf((s) => s.section === "stable"),
    lastOf((s) => s.label === "compressed"),
    lastOf((s) => s.section === "history" && s.label !== "compressed"),
  ].filter((i) => i >= 0));
  const final = segments.map((s, i) => (marks.has(i) ? { ...s, cacheBreakpoint: true } : s));

  const need = final.reduce((a, s) => a + s.bytes, 0);
  if (need > opts.budgetBytes) return { ok: false, reason: "over-budget", need, budget: opts.budgetBytes, action: "compress" };
  const manifest: ManifestEntry[] = final.filter((s) => s.seq !== undefined).map((s) => ({ seq: s.seq as number, bytes: s.bytes, via: s.section === "tail" ? "page-in" : "history" }));
  const request = Object.freeze({ segments: Object.freeze(final.map((s) => Object.freeze(s))) });
  const base = { ok: true as const, request, manifest, totalBytes: need, headSeq: head, skipped, prefixBreaks };
  return block && block !== opts.compressed ? { ...base, compressed: block } : base;
}

function whereOf(sg: Segment): LeakWhere {
  if (sg.section === "stable") return "stable";
  if (sg.label === "compressed") return "compressed";
  if (sg.label === "volatile") return "volatile";
  return sg.section === "tail" ? "tail" : "history";
}

/** 段里由内容构成的部分:去掉宿主自己加的 "#seq kind:id:" 等标签,免得短原文撞上标签 */
function scanContent(sg: Segment, opts: AssembleOptions, block: CompressedBlock | undefined): string {
  if (sg.section === "stable") return opts.stable.find((p) => p.kind === sg.label)?.text ?? "";
  if (sg.label === "compressed") return block?.text ?? "";
  if (sg.label === "volatile") return opts.volatile ?? "";
  const i = sg.text.indexOf(": ");
  return i >= 0 ? sg.text.slice(i + 2) : sg.text;
}

/** 整个请求体:各段按顺序拼接 */
export function serialize(req: AssembledRequest): string {
  return req.segments.map((s) => s.text).join("");
}

/** 缓存前缀(stable + history)的字节长度 */
export function prefixLength(req: AssembledRequest): number {
  return req.segments.filter((s) => s.section !== "tail").reduce((a, s) => a + s.bytes, 0);
}

/** 请求体前 bytes 个字节的 sha256;默认取本请求自己的缓存前缀。宿主比较相邻两次:prefixHash(新, prefixLength(旧)) === prefixHash(旧) */
export function prefixHash(req: AssembledRequest, bytes: number = prefixLength(req)): string {
  return createHash("sha256").update(Buffer.from(serialize(req), "utf8").subarray(0, bytes)).digest("hex");
}
