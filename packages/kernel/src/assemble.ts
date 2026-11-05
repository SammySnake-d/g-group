// 上下文装配:AC-06 引用旧消息确定性 Page-in + AC-39 / D22 群聊缓存前缀纪律。
// 请求分三段,顺序固定:
//   stable  :system / 工具定义 / 人设规则,调用方给的固定文本;里面出现时间、消息序号、任务号、"最近 N 条"或会话里的消息原文就报错;
//   history :已压缩历史(固定块)+ 压缩点之后的全部可见消息,只追加,不按"最近 N 条"重截;
//   tail    :被引用旧消息的 Page-in 与会变的状态(当前时间、任务表……),放在最末,不进缓存前缀。
// 缓存断点(D22 规则 3):工具定义末尾、stable 末尾(人设规则)、已压缩块末尾、最新追加的那条消息,按构造最多 4 个。
// 超预算显式失败并要求压缩,禁止静默截断。
import { createHash } from "node:crypto";
import { type Log, type ProjectedMessage, project } from "@g-group/domain";

export type StableKind = "system" | "tools" | "persona";
export interface StablePart { readonly kind: StableKind; readonly text: string }
/** 压缩点:throughSeq 及之前的消息已压缩成 text,这块写入后固定,下一轮以它为前缀 */
export interface CompressedBlock { readonly throughSeq: number; readonly text: string }

export interface AssembleOptions {
  readonly stable: readonly StablePart[];
  readonly compressed?: CompressedBlock;
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
export const MAX_BREAKPOINTS = 4;

export type AssembleResult =
  | { ok: true; request: AssembledRequest; manifest: ManifestEntry[]; totalBytes: number; skipped: { seq: number; reason: "retracted" }[] }
  | { ok: false; reason: "over-budget"; need: number; budget: number; action: "compress" }
  | { ok: false; reason: "quote-not-found"; seq: number }
  | { ok: false; reason: "volatile-in-stable"; part: StableKind; match: string };

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const renderMsg = (m: ProjectedMessage) => `#${m.seq} ${m.sender.kind}:${m.sender.id}: ${m.text}\n`;

/** stable 段里不许出现的会变内容 */
const VOLATILE_PATTERNS: readonly [string, RegExp][] = [
  ["日期", /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/],
  ["时刻", /\b\d{1,2}:\d{2}(?::\d{2})?\b/],
  ["消息序号", /#\d+/],
  ["任务号", /\bT-\d+\b/],
  ["最近 N 条", /最近\s*\d+\s*条/],
];

function volatileIn(text: string, messages: readonly ProjectedMessage[]): string | undefined {
  for (const [name, re] of VOLATILE_PATTERNS) {
    const m = re.exec(text);
    if (m) return `${name}:${m[0]}`;
  }
  // 会话里的消息原文出现在 stable 段:新消息被注入了前部
  for (const msg of messages) if (msg.text.length >= 4 && text.includes(msg.text)) return `消息 #${msg.seq} 原文`;
  return undefined;
}

/** 被引用消息按 seq 精确查找,与它离现在多远、是否已压缩无关。 */
function lookup(all: readonly ProjectedMessage[], seq: number): ProjectedMessage | undefined {
  return all.find((m) => m.seq === seq);
}

const seg = (section: Section, label: string, text: string, extra: { seq?: number } = {}): Segment =>
  ({ section, label, text, bytes: bytesOf(text), cacheBreakpoint: false, ...extra });

export function assemble(log: Log, opts: AssembleOptions): AssembleResult {
  const all = project(log);
  for (const part of opts.stable) {
    const hit = volatileIn(part.text, all);
    if (hit) return { ok: false, reason: "volatile-in-stable", part: part.kind, match: hit };
  }
  const through = opts.compressed?.throughSeq ?? 0;
  const history = all.filter((m) => !m.retracted && m.seq > through);
  const inHistory = new Set(history.map((m) => m.seq));

  const paged: ProjectedMessage[] = [];
  const skipped: { seq: number; reason: "retracted" }[] = [];
  for (const seq of opts.quotes) {
    const m = lookup(all, seq);
    if (!m) return { ok: false, reason: "quote-not-found", seq };
    if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }
    if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;
    paged.push(m);
  }

  const segments: Segment[] = [];
  for (const part of opts.stable) segments.push(seg("stable", part.kind, `[${part.kind}]\n${part.text}\n`));
  if (opts.compressed) segments.push(seg("history", "compressed", `[已压缩至 #${opts.compressed.throughSeq}]\n${opts.compressed.text}\n`));
  for (const m of history) segments.push(seg("history", "message", renderMsg(m), { seq: m.seq }));
  for (const m of paged) segments.push(seg("tail", "page-in", `[引用页入] ${renderMsg(m)}`, { seq: m.seq }));
  if (opts.volatile !== undefined && opts.volatile !== "") segments.push(seg("tail", "volatile", `[当前状态]\n${opts.volatile}\n`));

  // 断点:工具定义末尾、stable 末尾、已压缩块末尾、最新追加的消息;tail 里永远不放
  const lastOf = (pred: (s: Segment) => boolean) => segments.findLastIndex(pred);
  const marks = new Set([
    lastOf((s) => s.label === "tools"),
    lastOf((s) => s.section === "stable"),
    lastOf((s) => s.label === "compressed"),
    lastOf((s) => s.label === "message"),
  ].filter((i) => i >= 0));
  const final = segments.map((s, i) => (marks.has(i) ? { ...s, cacheBreakpoint: true } : s));

  const need = final.reduce((a, s) => a + s.bytes, 0);
  if (need > opts.budgetBytes) return { ok: false, reason: "over-budget", need, budget: opts.budgetBytes, action: "compress" };
  const manifest: ManifestEntry[] = final.filter((s) => s.seq !== undefined).map((s) => ({ seq: s.seq as number, bytes: s.bytes, via: s.section === "tail" ? "page-in" : "history" }));
  return { ok: true, request: Object.freeze({ segments: Object.freeze(final.map((s) => Object.freeze(s))) }), manifest, totalBytes: need, skipped };
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
