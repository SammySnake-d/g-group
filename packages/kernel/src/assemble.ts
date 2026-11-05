/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 上下文装配:AC-06 引用旧消息确定性 Page-in + AC-39 / D22 群聊缓存前缀纪律。
// 请求分三段,顺序固定:
//   stable  :system / 工具定义 / 人设规则,调用方给的固定文本;里面出现时间、消息序号、任务号、"最近 N 条"或会话里的消息原文就报错;
//   history :已压缩历史(固定块)+ 压缩点之后的全部可见消息,只追加,不按"最近 N 条"重截;
//   tail    :被引用旧消息的 Page-in 与会变的状态(当前时间、任务表……),放在最末,不进缓存前缀。
// 缓存断点(D22 规则 3):工具定义末尾、stable 末尾(人设规则)、已压缩块末尾、最新追加的那条消息,按构造最多 4 个。
// 超预算显式失败并要求压缩,禁止静默截断。
import type { Log } from "@g-group/domain";

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
