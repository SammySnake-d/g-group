/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 上下文装配(AC-06):窗口 + 被引用 #seq 的确定性 Page-in;超预算显式失败,禁止静默截断。
import type { Log } from "@g-group/domain";

export interface AssembleOptions {
  /** 最近多少条可见消息进窗口(撤回的不算) */
  readonly window: number;
  /** 被引用的 #seq,原文必须精确进装配 */
  readonly quotes: readonly number[];
  /** 装配内容的字节上限(UTF-8) */
  readonly budgetBytes: number;
}
export interface ManifestEntry { readonly seq: number; readonly bytes: number; readonly via: "window" | "page-in" }
export type AssembleResult =
  | { ok: true; manifest: ManifestEntry[]; content: string; totalBytes: number; skipped: { seq: number; reason: "retracted" }[] }
  | { ok: false; reason: "over-budget"; need: number; budget: number }
  | { ok: false; reason: "quote-not-found"; seq: number };

export function assemble(log: Log, opts: AssembleOptions): AssembleResult {
  throw new Error("未实现");
}
