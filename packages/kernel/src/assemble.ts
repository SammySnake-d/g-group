/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
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
import type { Log, ProjectedMessage } from "@g-group/domain";

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
  | { ok: false; reason: "invalid-input"; detail: string }
  | { ok: false; reason: "invalid-stable"; detail: string }
  | { ok: false; reason: "invalid-compressed"; detail: string }
  | { ok: false; reason: "recompress-required"; fromSeq: number }
  | { ok: false; reason: "retracted-text-leaked"; where: LeakWhere; seq: number };
/** 撤回原文在最终请求里出现的位置 */
export type LeakWhere = "stable" | "compressed" | "history" | "tail" | "volatile";
export const INVISIBLE = /(?:)/gu;
export const squash = (t: string): string => {
  throw new Error("未实现");
};

export function assemble(log: Log, opts: AssembleOptions): AssembleResult {
  throw new Error("未实现");
}

export function serialize(req: AssembledRequest): string {
  throw new Error("未实现");
}

export function prefixLength(req: AssembledRequest): number {
  throw new Error("未实现");
}

export function prefixHash(req: AssembledRequest, bytes?: number): string {
  throw new Error("未实现");
}
