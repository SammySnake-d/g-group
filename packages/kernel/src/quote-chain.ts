// 引用链投递(D24)。红提交:空壳。
export interface QuoteMsg { readonly seq: number; readonly author: string; readonly at: string; readonly text: string; readonly quoted: readonly number[]; readonly retracted: boolean }
export type QuoteStatus = "inline" | "in_context" | "deleted_or_withdrawn" | "not_visible" | "id_only";
export interface QuoteLevel { readonly seq: number; readonly author: string; readonly at: string; readonly depth: number; readonly via: number; readonly status: QuoteStatus; readonly text: string | null; readonly quotedSeqs: readonly number[]; readonly hasMoreAbove: boolean }
export interface QuoteChain { readonly levels: readonly QuoteLevel[]; readonly depthTotal: number; readonly depthCapped: boolean; readonly truncated: boolean; readonly nextSeqs: readonly number[] }
export interface QuoteChainInput { readonly fromSeq: number; readonly refs: readonly number[]; readonly messages: readonly QuoteMsg[]; readonly inContext: readonly number[]; readonly k: number; readonly scanCap: number; readonly budgetBytes: number }
export function buildQuoteChain(_i: QuoteChainInput): QuoteChain | null {
  return { levels: [], depthTotal: 0, depthCapped: false, truncated: false, nextSeqs: [] };
}
export function quoteParent(_i: { seq: number; messages: readonly QuoteMsg[]; inContext: readonly number[]; budgetBytes: number }): QuoteLevel[] {
  return [];
}
export function renderQuoteChain(_c: QuoteChain): string {
  return "";
}
