// 单一并发原语:基于版本号的比较并提交(AC-21)。—— 红提交:空壳
export interface Versioned<T> { readonly value: T; readonly ver: number }
export type CommitResult<T> = { ok: true; cell: Versioned<T> } | { ok: false; reason: "version-conflict"; currentVer: number };
export type Store<T> = ReadonlyMap<string, Versioned<T>>;
export type StoreCommit<T> = { ok: true; store: Store<T> } | { ok: false; reason: "version-conflict"; currentVer: number };

export function cell<T>(_value: T): Versioned<T> { throw new Error("未实现"); }
export function commit<T>(_cur: Versioned<T>, _expectedVer: number, _next: T): CommitResult<T> { throw new Error("未实现"); }
export function commitIn<T>(_store: Store<T>, _key: string, _expectedVer: number, _next: T): StoreCommit<T> { throw new Error("未实现"); }
