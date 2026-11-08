// 基础搜索(AC-25,C-US27):用户在自己所在的会话里按关键词搜历史消息与附件名,每条结果带 roomId + #seq,可跳回原位置。
// 派生索引 gg_search 一条消息一行,存最新文字(编辑后)与附件名;与消息写入/编辑/撤回在同一事务里更新:
//   撤回直接删行,索引里不再留原文(AC-08「删除后索引和缓存不得再返回原文」),不是只在查询时过滤。
// 索引是派生物:真源是只追加日志(events)+ gg_msg + gg_attachments;表缺失或版本号不符就从真源全量重建。
// 匹配用 LIKE(两字中文词也能搜到),% _ \ 按字面转义;多个词按空白切分,全部命中才算(正文或附件名)。
import type { Db } from "./db.ts";

/** 索引格式版本:改了行结构或填法就加一,启动时发现不符会全量重建。 */
export const SEARCH_INDEX_VERSION = 1;

export interface IndexRow {
  readonly roomId: string;
  readonly seq: number;
  readonly at: string;
  readonly sender: { readonly kind: string; readonly id: string };
  readonly threadRoot: number | null;
  readonly text: string;
  readonly attachments: readonly string[];
}
export interface SearchQuery {
  readonly query: string;
  readonly roomId?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}
export interface SearchHit {
  roomId: string;
  roomTitle: string;
  seq: number;
  threadRootSeq: number | null;
  sender: { kind: "user" | "contact" | "helper" | "system"; id: string };
  senderName: string;
  snippet: string;
  highlights: { start: number; length: number }[];
  matchedIn: "text" | "attachment";
  attachmentName: string | null;
  at: string;
}
export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
}

// 红提交:空壳,下一提交实现
export function indexMessageTx(_db: Db, _r: IndexRow) {}
export function reindexEditTx(_db: Db, _roomId: string, _seq: number, _text: string) {}
export function unindexTx(_db: Db, _roomId: string, _seq: number) {}
export function ensureSearchIndex(_db: Db) {
  return false;
}
export function searchMessages(_db: Db, _userId: string, _q: SearchQuery, _nameOf: (s: { kind: string; id: string }) => string): SearchPage {
  return { hits: [], nextCursor: null };
}
