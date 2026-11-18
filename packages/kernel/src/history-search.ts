// 旧消息与记忆的检索接缝(T-177 G3;实施方案 §5、审查条件 G3-a/G3-b)。
//   全仓业务代码只有这个文件 import 上游 acp-kernel(third_party/acp-kernel,billion-context 541cf26 的 kernel/,
//   来源、构建与许可见 third_party/acp-kernel/UPSTREAM.md)。只用它的 hybrid 检索(messageDocs + searchBlocks,BM25 + 模糊 + 中文分词);
//   不用旧的子串接口 CompressionCore.search(),不接块压缩、nudge、紧急截断、默认 processTurn。
//   权限、撤回、编辑版本由调用方先过滤:这里只对传进来的、调用方已确认可见的文本排序,不碰存储、不做权限裁决,
//   空查询和没有命中都返回空,不回退成整个集合。
import { messageDocs, searchBlocks } from "acp-kernel";

export interface HistoryDoc { readonly ref: string; readonly role: "user" | "assistant" | "tool"; readonly text: string }
export interface HistoryHit { readonly ref: string; readonly score: number; readonly preview: string }

/**
 * 在 docs 里按 query 检索,返回最多 limit 条命中:分数从高到低,同分按 docs 里的先后(与上游内部顺序无关)。
 * 空查询、空集合、limit 小于 1 返回空;ref 必须唯一(上游按 ref 建索引,重复会串文),重复直接报错。
 */
/** 空查询(只有空白)或 limit 小于 1:不检索 */
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
