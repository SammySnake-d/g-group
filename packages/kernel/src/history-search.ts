// 旧消息与记忆的检索接缝(T-177 G3;实施方案 §5、审查条件 G3-a/G3-b)。
//   来源、构建与许可见 third_party/acp-kernel/UPSTREAM.md)。只用它的 hybrid 检索(messageDocs + searchBlocks,BM25 + 模糊 + 中文分词);
import { messageDocs, searchBlocks } from "acp-kernel";

export interface HistoryDoc { readonly ref: string; readonly role: "user" | "assistant" | "tool"; readonly text: string }
export interface HistoryHit { readonly ref: string; readonly score: number; readonly preview: string }

/**
 * 在 docs 里按 query 检索,返回最多 limit 条命中:分数从高到低,同分按 docs 里的先后(与上游内部顺序无关)。
 * 空查询、空集合、limit 小于 1 返回空;ref 必须唯一(上游按 ref 建索引,重复会串文),重复直接报错。
 */
function blankRequest(query: string, limit: number): boolean {
  return query.trim() === "" || !(limit >= 1);
}

export function searchHistory(docs: readonly HistoryDoc[], query: string, limit = 5): HistoryHit[] {
  if (blankRequest(query, limit) || docs.length === 0) return [];
  const order = new Map<string, number>();
  docs.forEach((d, i) => {
    if (order.has(d.ref)) throw new Error(`searchHistory:ref 重复(${d.ref})`);
    order.set(d.ref, i);
  });
  const hits = searchBlocks(messageDocs(docs.map((d) => ({ ref: d.ref, role: d.role, text: d.text }))), query, { limit: docs.length });
  return hits
    .filter((h) => order.has(h.ref))
    .sort((a, b) => b.score - a.score || order.get(a.ref)! - order.get(b.ref)!)
    .slice(0, Math.floor(limit))
    .map((h) => ({ ref: h.ref, score: h.score, preview: h.preview }));
}
