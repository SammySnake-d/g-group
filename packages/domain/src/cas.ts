// 单一并发原语:基于版本号的比较并提交(AC-21)。发言发布、任务认领、共享文档提交都走它。
// 纯函数:不改入参,返回新值;调用方把"读到的版本"作为 expectedVer 交回来,版本变了就冲突,绝不静默覆盖。
export interface Versioned<T> { readonly value: T; readonly ver: number }
export type CommitResult<T> = { ok: true; cell: Versioned<T> } | { ok: false; reason: "version-conflict"; currentVer: number };
export type Store<T> = ReadonlyMap<string, Versioned<T>>;
export type StoreCommit<T> = { ok: true; store: Store<T> } | { ok: false; reason: "version-conflict"; currentVer: number };

export function cell<T>(value: T): Versioned<T> {
  return { value, ver: 0 };
}

export function commit<T>(cur: Versioned<T>, expectedVer: number, next: T): CommitResult<T> {
  if (cur.ver !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };
  return { ok: true, cell: { value: next, ver: cur.ver + 1 } };
}

/** 不存在的键视为版本 0 的空单元:首次写入要求 expectedVer = 0,写入后版本为 1。 */
export function commitIn<T>(store: Store<T>, key: string, expectedVer: number, next: T): StoreCommit<T> {
  const cur = store.get(key);
  const curVer = cur?.ver ?? 0;
  if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };
  const out = new Map(store);
  out.set(key, { value: next, ver: curVer + 1 });
  return { ok: true, store: out };
}
