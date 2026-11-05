// SQLite 存储适配器:会话事件只追加(AC-05)、文档单一提交点 CAS(AC-21)、外发动作入库端 action_id 去重(AC-31③)。
// 用 Node 内置 node:sqlite,一个数据库文件就是宿主的权威落盘;关闭再打开同一文件,状态都在。
import { DatabaseSync } from "node:sqlite";
import { append, type EventBody, type Log, type LogEvent, type Sender, type VerifyResult, type Versioned, verify } from "@g-group/domain";

export interface OpenOptions {
  /** 拿不到写锁时最多等多久(毫秒),默认 5000 */
  readonly busyTimeoutMs?: number;
  /** 诊断/测试接缝:CAS 读到当前版本、还没写入时回调。用来在最坏时刻插入另一个连接的提交 */
  readonly onCasRead?: (key: string, ver: number) => void;
}
export interface SqliteStore {
  readonly file: string;
  readonly db: DatabaseSync;
  readonly onCasRead: ((key: string, ver: number) => void) | undefined;
}
export interface LoadedLog { readonly log: Log; readonly check: VerifyResult }
export type DocCommit = { ok: true; ver: number } | { ok: false; reason: "version-conflict"; currentVer: number };
export type ActionRecord = { recorded: true } | { recorded: false; reason: "already-exists" };
export interface StoredAction { actionId: string; payload: unknown }

// 触发器在库里,任何连接(包括不经本适配器的)改旧事件都会被拒绝。
// 覆盖写由 BEFORE INSERT 拦:INSERT OR REPLACE 删旧行时,删除触发器只在 recursive_triggers 打开时才触发,不能指望它。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  session TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL,
  sender_kind TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL,
  prev TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (session, seq)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_overwrite BEFORE INSERT ON events
  WHEN EXISTS (SELECT 1 FROM events WHERE session = NEW.session AND seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, ver INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS actions_action_id ON actions (action_id);
`;

export function openStore(file: string, opts: OpenOptions = {}): SqliteStore {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return { file, db, onCasRead: opts.onCasRead };
}

export function closeStore(s: SqliteStore): void {
  s.db.close();
}

/** 写事务:BEGIN IMMEDIATE 一开始就拿写锁,读到的状态在提交前不会被别的连接改掉。 */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

interface EventRow { seq: number; at: string; sender_kind: string; sender_id: string; body: string; prev: string; hash: string }

function readEvents(db: DatabaseSync, sessionId: string): LogEvent[] {
  const rows = db.prepare("SELECT seq, at, sender_kind, sender_id, body, prev, hash FROM events WHERE session = ? ORDER BY seq").all(sessionId) as unknown as EventRow[];
  return rows.map((r) => ({
    seq: r.seq, at: r.at, sender: { kind: r.sender_kind as Sender["kind"], id: r.sender_id },
    body: JSON.parse(r.body) as EventBody, prev: r.prev, hash: r.hash,
  }));
}

/** 用领域的 append 算 seq/prev/hash(并执行发言者等领域约束),再在同一事务里落盘。 */
export function appendEvent(s: SqliteStore, sessionId: string, sender: { kind: string; id: string }, body: EventBody, at: string): LogEvent {
  return tx(s.db, () => {
    const next = append({ events: readEvents(s.db, sessionId) }, sender, body, at);
    const e = next.events.at(-1)!;
    s.db.prepare("INSERT INTO events (session, seq, at, sender_kind, sender_id, body, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, e.seq, e.at, e.sender.kind, e.sender.id, JSON.stringify(e.body), e.prev, e.hash);
    return e;
  });
}

/** 读回整条会话并重算 hash 链;库被绕过触发器篡改时 check 报出第一个断点。 */
export function loadLog(s: SqliteStore, sessionId: string): LoadedLog {
  const log: Log = { events: readEvents(s.db, sessionId) };
  return { log, check: verify(log) };
}

export function readDoc(s: SqliteStore, key: string): Versioned<unknown> | undefined {
  const row = s.db.prepare("SELECT ver, value FROM docs WHERE key = ?").get(key) as { ver: number; value: string } | undefined;
  return row ? { value: JSON.parse(row.value) as unknown, ver: row.ver } : undefined;
}

function cas(s: SqliteStore, key: string, expectedVer: number, value: unknown): DocCommit {
  const row = s.db.prepare("SELECT ver FROM docs WHERE key = ?").get(key) as { ver: number } | undefined;
  const cur = row?.ver ?? 0;
  s.onCasRead?.(key, cur);
  if (cur !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur };
  s.db.prepare("INSERT INTO docs (key, ver, value) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET ver = excluded.ver, value = excluded.value")
    .run(key, cur + 1, JSON.stringify(value));
  return { ok: true, ver: cur + 1 };
}

/** 单一提交点:读版本、比对、写入在同一个写事务里。不存在的文档按版本 0。冲突不写入。 */
export function commitDoc(s: SqliteStore, key: string, expectedVer: number, value: unknown): DocCommit {
  return tx(s.db, () => cas(s, key, expectedVer, value));
}

/** 入库端幂等:同一 action_id 只落一行,重放返回已存在且不覆盖原 payload。 */
export function recordAction(s: SqliteStore, actionId: string, payload: unknown): ActionRecord {
  const r = s.db.prepare("INSERT OR IGNORE INTO actions (action_id, payload) VALUES (?, ?)").run(actionId, JSON.stringify(payload));
  return Number(r.changes) === 1 ? { recorded: true } : { recorded: false, reason: "already-exists" };
}

export function listActions(s: SqliteStore): StoredAction[] {
  const rows = s.db.prepare("SELECT action_id, payload FROM actions ORDER BY id").all() as unknown as { action_id: string; payload: string }[];
  return rows.map((r) => ({ actionId: r.action_id, payload: JSON.parse(r.payload) as unknown }));
}

export type { Sender };
