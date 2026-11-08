// 宿主状态落盘:全部在 adapter-sqlite 打开的同一个 SQLite 文件里。
//   - 会话消息正文:adapter-sqlite 的只追加事件表(session = room:<id>,hash 链,AC-05);
//   - 消息结构化字段(回复、引用、@、卡片、命令):gg_msg,按 (room, seq) 一行,与正文同事务写入;
//   - 发送去重:adapter-sqlite 的 actions 表(入库端 action_id 唯一,AC-31 ③);
//   - 版本化文档(联系人、任务、状态笔记、承诺账本、设置):adapter-sqlite 的 docs 表(CAS,AC-21);
//   - 其余索引表(会话、成员、游标、已读、待处理输入、Compute、进度、卡片)由本文件建。
import { type SqliteStore, closeStore, commitDoc, openStore, readDoc, transaction } from "@g-group/adapter-sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_rooms (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '', rules_version INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, dm_contact TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gg_rooms_dm ON gg_rooms (dm_contact) WHERE dm_contact IS NOT NULL;
CREATE TABLE IF NOT EXISTS gg_members (room_id TEXT NOT NULL, kind TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (room_id, kind, member_id));
CREATE TABLE IF NOT EXISTS gg_msg (
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, thread_root INTEGER, reply_to INTEGER, quoted TEXT NOT NULL, mentions TEXT NOT NULL,
  attachments TEXT NOT NULL, command TEXT, card_id TEXT, client_action_id TEXT, PRIMARY KEY (room_id, seq)
);
CREATE TABLE IF NOT EXISTS gg_cards (
  card_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, task_id TEXT, title TEXT NOT NULL,
  body TEXT NOT NULL, state TEXT NOT NULL, actions TEXT NOT NULL, meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gg_reactions (room_id TEXT NOT NULL, seq INTEGER NOT NULL, emoji TEXT NOT NULL, kind TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (room_id, seq, emoji, kind, member_id));
CREATE TABLE IF NOT EXISTS gg_cursor (contact_id TEXT NOT NULL, room_id TEXT NOT NULL, processed_seq INTEGER NOT NULL, PRIMARY KEY (contact_id, room_id));
CREATE TABLE IF NOT EXISTS gg_read (room_id TEXT NOT NULL, kind TEXT NOT NULL, member_id TEXT NOT NULL, upto_seq INTEGER NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gg_read_idx ON gg_read (room_id, kind, member_id, upto_seq);
CREATE TABLE IF NOT EXISTS gg_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS gg_compute (
  compute_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS gg_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, compute_id TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT, summary TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_schedules (
  id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, title TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL, prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL, tolerance_sec INTEGER NOT NULL, missed_policy TEXT NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gg_schedule_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, due_at TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS gg_plugins (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, source TEXT NOT NULL, origin TEXT NOT NULL, dir TEXT NOT NULL, enabled INTEGER NOT NULL,
  status TEXT NOT NULL, error TEXT, manifest TEXT NOT NULL, config TEXT, granted TEXT NOT NULL, installed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gg_attachments (ref TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, path TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_effects (action_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gg_announcements (
  ord INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL,
  client_action_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT, UNIQUE (room_id, client_action_id)
);
CREATE TABLE IF NOT EXISTS gg_member_exits (room_id TEXT NOT NULL, contact_id TEXT NOT NULL, started_at TEXT NOT NULL, PRIMARY KEY (room_id, contact_id));
-- 私聊 rewind(AC-48):每次回退撤下 (to_seq, upto_seq] 范围内的消息;result 是当时返回给用户的结果,同一 client_action_id 重放原样返回
CREATE TABLE IF NOT EXISTS gg_rewinds (
  room_id TEXT NOT NULL, client_action_id TEXT NOT NULL, to_seq INTEGER NOT NULL, upto_seq INTEGER NOT NULL, marker_seq INTEGER NOT NULL,
  result TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (room_id, client_action_id)
);
`;

export interface Db {
  readonly store: SqliteStore;
  close(): void;
}

export function openDb(file: string): Db {
  const store = openStore(file);
  store.db.exec(SCHEMA);
  return { store, close: () => closeStore(store) };
}

export const tx = <T>(db: Db, fn: () => T): T => transaction(db.store, fn);

export function all<T>(db: Db, sql: string, ...params: (string | number | null)[]): T[] {
  return db.store.db.prepare(sql).all(...params) as unknown as T[];
}
export function one<T>(db: Db, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.store.db.prepare(sql).get(...params) as unknown as T | undefined;
}
export function run(db: Db, sql: string, ...params: (string | number | null)[]): number {
  return Number(db.store.db.prepare(sql).run(...params).changes);
}

/** 读文档(不存在返回 undefined)。 */
export function getDoc<T>(db: Db, key: string): { value: T; ver: number } | undefined {
  const d = readDoc(db.store, key);
  return d ? { value: d.value as T, ver: d.ver } : undefined;
}
/** CAS 写文档;版本冲突抛错(在事务里会回滚整次提交)。 */
export function putDoc(db: Db, key: string, expectedVer: number, value: unknown): number {
  const r = commitDoc(db.store, key, expectedVer, value);
  if (!r.ok) throw new HostError("conflict", `文档 ${key} 写入失败:${r.reason}`, r.reason === "version-conflict" ? { currentVer: r.currentVer } : undefined);
  return r.ver;
}
export function listDocs<T>(db: Db, prefix: string): { key: string; value: T; ver: number }[] {
  return all<{ key: string; ver: number; value: string }>(db, "SELECT key, ver, value FROM docs WHERE substr(key, 1, ?) = ? ORDER BY key", prefix.length, prefix).map((r) => ({
    key: r.key,
    ver: r.ver,
    value: JSON.parse(r.value) as T,
  }));
}

export type HostErrorCode = "invalid_params" | "not_found" | "conflict" | "forbidden" | "unavailable" | "unknown_method" | "internal";
export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly detail: unknown;
  constructor(code: HostErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
