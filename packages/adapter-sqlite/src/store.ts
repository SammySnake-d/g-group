// SQLite 存储适配器:会话事件只追加(AC-05)、文档单一提交点 CAS(AC-21)、外发动作入库端 action_id 去重(AC-31③)。
// 用 Node 内置 node:sqlite,一个数据库文件就是宿主的权威落盘;关闭再打开同一文件,状态都在。
import type { DatabaseSync } from "node:sqlite";
import type { EventBody, Log, LogEvent, Sender, VerifyResult, Versioned } from "@g-group/domain";

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
/** busy:另一个连接(可能是另一个进程)持有写锁,超过 busyTimeoutMs 仍拿不到;什么都没写。调用方应重新读版本后再决定是否重试。 */
export type DocCommit = { ok: true; ver: number } | { ok: false; reason: "version-conflict"; currentVer: number } | { ok: false; reason: "busy" };
export type ActionRecord = { recorded: true } | { recorded: false; reason: "already-exists" };
export interface StoredAction { actionId: string; payload: unknown }

export function openStore(_file: string, _opts: OpenOptions = {}): SqliteStore {
  throw new Error("未实现");
}

export function closeStore(_s: SqliteStore): void {
  throw new Error("未实现");
}

export function appendEvent(_s: SqliteStore, _sessionId: string, _sender: { kind: string; id: string }, _body: EventBody, _at: string): LogEvent {
  throw new Error("未实现");
}

export function loadLog(_s: SqliteStore, _sessionId: string): LoadedLog {
  throw new Error("未实现");
}

export function readDoc(_s: SqliteStore, _key: string): Versioned<unknown> | undefined {
  throw new Error("未实现");
}

export function commitDoc(_s: SqliteStore, _key: string, _expectedVer: number, _value: unknown): DocCommit {
  throw new Error("未实现");
}

export function recordAction(_s: SqliteStore, _actionId: string, _payload: unknown): ActionRecord {
  throw new Error("未实现");
}

export function listActions(_s: SqliteStore): StoredAction[] {
  throw new Error("未实现");
}

export type { Sender };
