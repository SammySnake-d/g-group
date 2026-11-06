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
import { appendOwn, describeThrown, plainData } from "./plain.ts";

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
/** 固定段顺序:宿主只用模块私有的这份;导出的 STABLE_ORDER 是冻结副本,调用方改不了宿主的判定 */
const ORDER: readonly StableKind[] = Object.freeze(["system", "tools", "persona"] as StableKind[]);
export const STABLE_ORDER: readonly StableKind[] = Object.freeze([...ORDER]);

export type AssembleResult =
  | {
    ok: true; request: AssembledRequest; manifest: ManifestEntry[]; totalBytes: number; headSeq: number;
    skipped: { seq: number; reason: "retracted" }[]; prefixBreaks: PrefixBreak[]; compressed?: CompressedBlock;
  }
  | { ok: false; reason: "over-budget"; need: number; budget: number; action: "compress" }
  | { ok: false; reason: "quote-not-found"; seq: number }
  | { ok: false; reason: "volatile-in-stable"; part: StableKind; match: string }
  | { ok: false; reason: "invalid-input"; detail: string }
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
    const i = ORDER.indexOf(p?.kind);
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

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** 日志事件的最小形状:装配会读 seq、sender.kind/id、body.kind 与 body.text/target */
function eventShaped(e: unknown): boolean {
  if (!isRecord(e) || !Number.isInteger(e.seq) || !isRecord(e.sender) || !isRecord(e.body)) return false;
  if (typeof e.sender.kind !== "string" || typeof e.sender.id !== "string") return false;
  const b = e.body;
  if (b.kind === "message") return typeof b.text === "string";
  if (b.kind === "edit") return typeof b.text === "string" && Number.isInteger(b.target);
  if (b.kind === "retract") return Number.isInteger(b.target);
  return false;
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

/** 撤回比对时去掉的不可见字符:Unicode White_Space 全集(JS 的 \s 已含 U+0009–000D、U+0020、U+00A0、U+1680、U+2000–200A、
 *  U+2028/2029、U+202F、U+205F、U+3000 与 BOM U+FEFF,但不含 U+0085,这里补上),再加零宽字符 U+200B–U+200D、U+2060。
 *  实现和测试都用这一个定义。 */
const INVISIBLE = /[\s\u0085\u200B-\u200D\u2060\uFEFF]+/gu;
/** 正则对象可以被 compile() 改掉,所以不导出实例:只导出它的规范文本(字符串不可变),宿主只用模块私有的那个实例 */
export const INVISIBLE_SOURCE: string = INVISIBLE.source;
/** 空白规范化:去掉 INVISIBLE 里的全部字符后比对,"秘 密"和"秘密"算同一段。公开入口:只收字符串,其它一律抛受控 TypeError(不读 .replace) */
export const squash = (t: string): string => {
  if (typeof t !== "string") throw new TypeError("squash 只接受字符串");
  return t.replace(INVISIBLE, "");
};

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

export function assemble(logInput: Log, optsInput: AssembleOptions): AssembleResult {
  // 日志与选项先过统一的普通数据对象判定(plain.ts),getter 永不调用;之后只读冻结副本
  const pl = plainData(logInput, "日志");
  if (!pl.ok) return { ok: false, reason: "invalid-input", detail: `日志只接受普通数据对象:${pl.path} ${pl.why}` };
  const po = plainData(optsInput, "装配选项", { topFunctions: true });
  if (!po.ok) return { ok: false, reason: "invalid-input", detail: `装配选项只接受普通数据对象:${po.path} ${po.why}` };
  // 普通数据也可能是 null、数字、字符串或数组:先确认是对象再读字段,不让合法 JSON 值抛错
  if (!isRecord(pl.value)) return { ok: false, reason: "invalid-input", detail: "日志必须是对象" };
  if (!isRecord(po.value)) return { ok: false, reason: "invalid-input", detail: "装配选项必须是对象" };
  const log = pl.value as unknown as Log;
  const opts = po.value as unknown as AssembleOptions;
  if (!Array.isArray(log.events)) return { ok: false, reason: "invalid-input", detail: "日志 events 必须是数组" };
  const badEvent = log.events.findIndex((e) => !eventShaped(e));
  if (badEvent >= 0) return { ok: false, reason: "invalid-input", detail: `日志 events[${badEvent}] 必须是带整数 seq、sender{kind,id} 与 body{kind} 的对象` };
  if (!Array.isArray(opts.quotes)) return { ok: false, reason: "invalid-input", detail: "quotes 必须是数组" };
  if (opts.volatile !== undefined && typeof opts.volatile !== "string") return { ok: false, reason: "invalid-input", detail: "volatile 必须是字符串" };
  if (!isNat(opts.budgetBytes)) return { ok: false, reason: "invalid-input", detail: "budgetBytes 必须是非负整数" };
  if (opts.previousHeadSeq !== undefined && !isNat(opts.previousHeadSeq)) return { ok: false, reason: "invalid-input", detail: "previousHeadSeq 必须是非负整数" };
  if (opts.compressed !== undefined && !isRecord(opts.compressed)) return { ok: false, reason: "invalid-compressed", detail: "压缩块必须是对象" };
  if (opts.recompress !== undefined && typeof opts.recompress !== "function") return { ok: false, reason: "invalid-input", detail: "recompress 必须是函数" };
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
        return { ok: false, reason: "invalid-compressed", detail: `recompress 抛错(它只能返回压缩块文本,不能改消息投影):${describeThrown(err)}` };
      }
      if (typeof text !== "string") return { ok: false, reason: "invalid-compressed", detail: "recompress 必须返回字符串" };
      block = Object.freeze({ throughSeq: b.throughSeq, builtAtSeq: head, text });
      appendOwn(prefixBreaks, { reason: "retract", seq: fromSeq, at: "compressed" });
    }
  }
  const through = block?.throughSeq ?? 0;

  // history:压缩点之后的事件按发生顺序追加;撤回的消息和它的编辑都不出现
  // 每段渲染时同时记下它的正文(调用方给的文本或消息事件自己的文字),撤回扫描只扫正文,不扫宿主加的序号与发言者标签
  const segments: Segment[] = [];
  const bodies: string[] = [];
  const push = (sg: Segment, body: string) => { appendOwn(segments, sg); appendOwn(bodies, body); };
  for (const part of opts.stable) push(seg("stable", part.kind, `[${part.kind}]\n${part.text}\n`), part.text);
  if (block) push(seg("history", "compressed", `[已压缩至 #${block.throughSeq}]\n${block.text}\n`), block.text);
  const inHistory = new Set<number>();
  for (const e of events) {
    if (e.seq <= through) continue;
    const b = e.body;
    if (b.kind === "message") {
      if (retracted.has(e.seq)) continue;
      inHistory.add(e.seq);
      push(seg("history", "message", `#${e.seq} ${who(e)}: ${b.text}\n`, { seq: e.seq }), b.text);
    } else if (b.kind === "edit") {
      if (retracted.has(b.target)) continue;
      push(seg("history", "edit", `#${e.seq} ${who(e)} 编辑 #${b.target} 为: ${b.text}\n`, { seq: e.seq }), b.text);
    }
  }
  for (const [target, rs] of retractSeqOf) if (target > through && isNew(rs)) appendOwn(prefixBreaks, { reason: "retract", seq: target, at: "history" });

  // tail:被引用旧消息按最新文字页入(all 来自权威日志;回调只拿到冻结深拷贝,改不了它);已在 history 的不重复;撤回的跳过
  const paged: ProjectedMessage[] = [];
  const skipped: { seq: number; reason: "retracted" }[] = [];
  for (const seq of opts.quotes) {
    const m = all.find((x) => x.seq === seq);
    if (!m) return { ok: false, reason: "quote-not-found", seq };
    if (m.retracted) { appendOwn(skipped, { seq, reason: "retracted" }); continue; }
    if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;
    appendOwn(paged, m);
  }
  for (const m of paged) push(seg("tail", "page-in", `[引用页入] ${renderMsg(m)}`, { seq: m.seq }), m.text);
  if (opts.volatile !== undefined && opts.volatile !== "") push(seg("tail", "volatile", `[当前状态]\n${opts.volatile}\n`), opts.volatile);

  // 最终请求边界:每一段的正文逐字扫撤回原文,含短文本;序号与发言者标签不在正文里
  for (const [i, sg] of segments.entries()) {
    const leaked = leakIn(bodies[i] ?? "", secret);
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

/** serialize / prefixLength / prefixHash 的入口判定:请求先过统一判定(不调 getter),每段要有 section、text、bytes;
 *  不合规抛受控的 TypeError,不读调用方原对象 */
function segmentsOf(input: unknown, fn: string): readonly Segment[] {
  const plain = plainData(input, `${fn} 请求`);
  if (!plain.ok) throw new TypeError(`${fn} 只接受普通数据对象:${plain.path} ${plain.why}`);
  if (!isRecord(plain.value)) throw new TypeError(`${fn} 请求必须是对象`);
  const segs = plain.value.segments;
  if (!Array.isArray(segs)) throw new TypeError(`${fn} 请求的 segments 必须是数组`);
  for (const [i, s] of segs.entries()) {
    const sg = s as Partial<Segment> | null;
    if (typeof sg !== "object" || sg === null || typeof sg.text !== "string" || typeof sg.section !== "string" || !Number.isInteger(sg.bytes)) {
      throw new TypeError(`${fn} 请求的 segments[${i}] 必须带字符串 section、text 与整数 bytes`);
    }
  }
  return segs as readonly Segment[];
}

const joined = (segs: readonly Segment[]) => segs.map((s) => s.text).join("");
const prefixBytes = (segs: readonly Segment[]) => segs.filter((s) => s.section !== "tail").reduce((a, s) => a + s.bytes, 0);

/** 整个请求体:各段按顺序拼接 */
export function serialize(req: AssembledRequest): string {
  return joined(segmentsOf(req, "serialize"));
}

/** 缓存前缀(stable + history)的字节长度 */
export function prefixLength(req: AssembledRequest): number {
  return prefixBytes(segmentsOf(req, "prefixLength"));
}

/** 请求体前 bytes 个字节的 sha256;默认取本请求自己的缓存前缀。宿主比较相邻两次:prefixHash(新, prefixLength(旧)) === prefixHash(旧) */
export function prefixHash(req: AssembledRequest, bytes?: number): string {
  const segs = segmentsOf(req, "prefixHash");
  if (bytes !== undefined && !(Number.isInteger(bytes) && bytes >= 0)) throw new TypeError("prefixHash 的 bytes 必须是非负整数");
  return createHash("sha256").update(Buffer.from(joined(segs), "utf8").subarray(0, bytes ?? prefixBytes(segs))).digest("hex");
}
