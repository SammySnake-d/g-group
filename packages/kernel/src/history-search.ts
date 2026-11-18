// 旧消息与记忆的检索接缝(T-177 G3;实施方案 §5、审查条件 G3-a/G3-b)。红提交空壳:签名在,返回假值(整个集合原样当命中)。
export interface HistoryDoc { readonly ref: string; readonly role: "user" | "assistant" | "tool"; readonly text: string }
export interface HistoryHit { readonly ref: string; readonly score: number; readonly preview: string }

export function searchHistory(docs: readonly HistoryDoc[], _query: string, _limit = 5): HistoryHit[] {
  return docs.map((d) => ({ ref: d.ref, score: 0, preview: d.text }));
}
