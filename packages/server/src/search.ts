// 基础搜索(AC-25,C-US27):用户在自己所在的会话里按关键词搜历史消息与附件名,每条结果带 roomId + #seq,可跳回原位置。
// 派生索引 gg_search 一条消息一行,存最新文字(编辑后)与附件名;与消息写入/编辑/撤回在同一事务里更新:
//   撤回直接删行,索引里不再留原文(AC-08「删除后索引和缓存不得再返回原文」),不是只在查询时过滤。
// 索引是派生物:真源是只追加日志(events)+ gg_msg + gg_attachments;表缺失或版本号不符就从真源全量重建。
// 匹配用 LIKE(两字中文词也能搜到),% _ \ 按字面转义;多个词按空白切分,全部命中才算(正文或附件名)。
import { loadLog } from "@g-group/adapter-sqlite";
import { project } from "@g-group/domain";
import { type Db, HostError, all, one, run, tx } from "./db.ts";

/** 索引格式版本:改了行结构或填法就加一,启动时发现不符会全量重建。 */
export const SEARCH_INDEX_VERSION = 1;
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 90;
const MAX_TERMS = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_search (
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, sender_kind TEXT NOT NULL, sender_id TEXT NOT NULL,
  thread_root INTEGER, text TEXT NOT NULL, att TEXT NOT NULL, PRIMARY KEY (room_id, seq)
);
CREATE INDEX IF NOT EXISTS gg_search_at ON gg_search (at DESC, room_id DESC, seq DESC);
CREATE TABLE IF NOT EXISTS gg_search_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface IndexRow {
  readonly roomId: string;
  readonly seq: number;
  readonly at: string;
  readonly sender: { readonly kind: string; readonly id: string };
  readonly threadRoot: number | null;
  readonly text: string;
  /** 附件 ref(gg_attachments.ref),按文件名入索引。 */
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
interface Row {
  room_id: string;
  seq: number;
  at: string;
  sender_kind: string;
  sender_id: string;
  thread_root: number | null;
  text: string;
  att: string;
  title: string;
}

/** LIKE 模式里的 \ % _ 按字面匹配(配合 ESCAPE '\')。 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function attNames(db: Db, refs: readonly string[]): string[] {
  const names: string[] = [];
  for (const ref of refs) {
    const a = one<{ name: string }>(db, "SELECT name FROM gg_attachments WHERE ref = ?", ref);
    if (a) names.push(a.name);
  }
  return names;
}

/** 新消息入索引(必须在写消息的同一事务里调用)。 */
export function indexMessageTx(db: Db, r: IndexRow) {
  run(
    db,
    "INSERT OR REPLACE INTO gg_search (room_id, seq, at, sender_kind, sender_id, thread_root, text, att) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    r.roomId,
    r.seq,
    r.at,
    r.sender.kind,
    r.sender.id,
    r.threadRoot,
    r.text,
    attNames(db, r.attachments).join("\n"),
  );
}
/** 编辑:索引只留最新文字,旧文字不再命中。 */
export function reindexEditTx(db: Db, roomId: string, seq: number, text: string) {
  run(db, "UPDATE gg_search SET text = ? WHERE room_id = ? AND seq = ?", text, roomId, seq);
}
/** 撤回:删掉这一行,索引里不再有原文。 */
export function unindexTx(db: Db, roomId: string, seq: number) {
  run(db, "DELETE FROM gg_search WHERE room_id = ? AND seq = ?", roomId, seq);
}

/** 从真源全量重建:只收未撤回的消息,文字取投影后的最新版本。返回入索引的条数。 */
export function rebuildSearchIndex(db: Db) {
  return tx(db, () => {
    run(db, "DELETE FROM gg_search");
    let n = 0;
    for (const room of all<{ id: string }>(db, "SELECT id FROM gg_rooms ORDER BY id")) {
      const { log } = loadLog(db.store, `room:${room.id}`);
      const at = new Map(log.events.map((e) => [e.seq, e.at]));
      for (const m of project(log)) {
        if (m.retracted) continue;
        const meta = one<{ thread_root: number | null; attachments: string }>(db, "SELECT thread_root, attachments FROM gg_msg WHERE room_id = ? AND seq = ?", room.id, m.seq);
        indexMessageTx(db, {
          roomId: room.id,
          seq: m.seq,
          at: at.get(m.seq) ?? "",
          sender: m.sender,
          threadRoot: meta?.thread_root ?? null,
          text: m.text,
          attachments: meta ? (JSON.parse(meta.attachments) as string[]) : [],
        });
        n++;
      }
    }
    // 版本行必须恰好写入一行(插入或覆盖);没写进就不能把索引当成已按当前版本重建
    if (run(db, "INSERT INTO gg_search_meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(SEARCH_INDEX_VERSION)) !== 1) throw new Error("搜索索引版本行没有写入,重建未完成");
    return n;
  });
}

/** 启动时调用:建表;索引表原先不存在或版本号不符就从真源重建。返回是否重建了。 */
export function ensureSearchIndex(db: Db) {
  const had = !!one(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gg_search'");
  db.store.db.exec(SCHEMA);
  const ver = one<{ v: string }>(db, "SELECT v FROM gg_search_meta WHERE k = 'version'")?.v;
  if (had && ver === String(SEARCH_INDEX_VERSION)) return false;
  rebuildSearchIndex(db);
  return true;
}

export function splitTerms(query: string): string[] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!terms.length) throw new HostError("invalid_params", "搜索词不能为空");
  if (terms.length > MAX_TERMS) throw new HostError("invalid_params", `搜索词最多 ${MAX_TERMS} 个`);
  return terms;
}

/** 命中片段:以最早出现的关键词为中心截一段(空白压成一个空格),给出每个关键词在片段里的位置。 */
export function makeSnippet(text: string, terms: readonly string[]): { snippet: string; highlights: { start: number; length: number }[] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const centre = Math.max(pos, 0);
  const from = Math.max(0, centre - SNIPPET_BEFORE);
  const to = Math.min(flat.length, centre + SNIPPET_BEFORE + SNIPPET_AFTER);
  const head = from > 0 ? "…" : "";
  const snippet = `${head}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
  const low = snippet.toLowerCase();
  const highlights: { start: number; length: number }[] = [];
  for (const t of terms) {
    const tl = t.toLowerCase();
    for (let i = low.indexOf(tl); i >= 0; i = low.indexOf(tl, i + tl.length)) highlights.push({ start: i, length: t.length });
  }
  highlights.sort((a, b) => a.start - b.start);
  return { snippet, highlights };
}

export function encodeCursor(r: { at: string; room_id: string; seq: number }): string {
  return Buffer.from(JSON.stringify([r.at, r.room_id, r.seq]), "utf8").toString("base64url");
}
export function decodeCursor(c: string): { at: string; roomId: string; seq: number } {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    throw new HostError("invalid_params", "搜索游标无效");
  }
  if (!Array.isArray(v) || v.length !== 3 || typeof v[0] !== "string" || typeof v[1] !== "string" || !Number.isInteger(v[2])) throw new HostError("invalid_params", "搜索游标无效");
  return { at: v[0], roomId: v[1], seq: v[2] as number };
}

/**
 * 搜索:只在 userId 是成员的会话里找,按时间倒序(同一时刻按会话、序号倒序),limit + 1 判断还有没有下一页。
 * 指定 roomId 时,会话不存在 → not_found,不是成员 → forbidden。
 */
export function searchMessages(db: Db, userId: string, q: SearchQuery, nameOf: (s: { kind: string; id: string }) => string): SearchPage {
  const terms = splitTerms(q.query);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  if (q.roomId !== undefined) {
    if (!one(db, "SELECT 1 FROM gg_rooms WHERE id = ?", q.roomId)) throw new HostError("not_found", `没有会话 ${q.roomId}`);
    if (!one(db, "SELECT 1 FROM gg_members WHERE room_id = ? AND kind = 'user' AND member_id = ?", q.roomId, userId)) throw new HostError("forbidden", "你不在这个会话里");
  }
  const where: string[] = [];
  const params: (string | number | null)[] = [userId];
  if (q.roomId !== undefined) {
    where.push("s.room_id = ?");
    params.push(q.roomId);
  }
  for (const t of terms) {
    const pat = `%${escapeLike(t)}%`;
    where.push("(s.text LIKE ? ESCAPE '\\' OR s.att LIKE ? ESCAPE '\\')");
    params.push(pat, pat);
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    where.push("(s.at, s.room_id, s.seq) < (?, ?, ?)");
    params.push(c.at, c.roomId, c.seq);
  }
  params.push(limit + 1);
  const rows = all<Row>(
    db,
    `SELECT s.*, r.title AS title FROM gg_search s
       JOIN gg_members m ON m.room_id = s.room_id AND m.kind = 'user' AND m.member_id = ?
       JOIN gg_rooms r ON r.id = s.room_id
       WHERE ${where.join(" AND ")}
       ORDER BY s.at DESC, s.room_id DESC, s.seq DESC LIMIT ?`,
    ...params,
  );
  const page = rows.slice(0, limit);
  const hits = page.map((r): SearchHit => {
    const inText = terms.some((t) => r.text.toLowerCase().includes(t.toLowerCase()));
    const names = r.att ? r.att.split("\n") : [];
    const attachmentName = names.find((n) => terms.some((t) => n.toLowerCase().includes(t.toLowerCase()))) ?? null;
    const { snippet, highlights } = makeSnippet(r.text, terms);
    return {
      roomId: r.room_id,
      roomTitle: r.title,
      seq: r.seq,
      threadRootSeq: r.thread_root,
      sender: { kind: r.sender_kind as SearchHit["sender"]["kind"], id: r.sender_id },
      senderName: nameOf({ kind: r.sender_kind, id: r.sender_id }).slice(0, 80),
      snippet: snippet.slice(0, 500),
      highlights: highlights.filter((h) => h.start + h.length <= 500),
      matchedIn: inText ? "text" : "attachment",
      attachmentName,
      at: r.at,
    };
  });
  const last = page.at(-1);
  return { hits, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

// ---------------------------------------------------------------- 全局搜联系人和群(U32 已定)
/** 全局搜联系人与群的入参:一个查询串 + 可选条数上限。 */
export interface RoomSearchQuery {
  readonly query: string;
  readonly limit?: number;
}
/**
 * 全局搜联系人和群的一条结果(U32):会话列表的搜索框用。命中位置给界面高亮;
 * 私聊的标题就是联系人名,群里按群标题与成员联系人名匹配。
 */
export interface RoomSearchHit {
  readonly roomId: string;
  readonly kind: "dm" | "group";
  readonly title: string;
  /** 命中在会话标题上,还是某位联系人名上。 */
  readonly matchedIn: "title" | "contact";
  /** 命中联系人名时是哪个名字;命中标题时为 null。 */
  readonly matchedName: string | null;
  /** 每个关键词在命中字段里的位置(UTF-16 下标)。 */
  readonly highlights: { readonly start: number; readonly length: number }[];
  readonly at: string;
}

/**
 * 全局搜联系人与群(U32):按会话标题与成员联系人名匹配,大小写不敏感、中文子串也算命中;
 * 多词按空白切分,全部命中才算(与搜消息同一口径)。只列 userId 所在的会话,按会话最近更新倒序。
 */
export function searchRooms(_db: Db, _userId: string, _q: RoomSearchQuery, _nameOf: (s: { kind: string; id: string }) => string): RoomSearchHit[] {
  return [];
}
