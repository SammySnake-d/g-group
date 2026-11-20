// 多资源排他租约的最小原语(需求文档 D20 第四台 4A R-Quota / 4C R-Worktree / 4D R-Env 的共同部分,AC-10)。
// 模型检查规格见 packages/domain/tla/Lease.tla;TLC 反例在本原语上的回放见 trace-replay.ts。
// - 释放必须由当前持有者带授予时的 epoch;旧 epoch 的迟到释放拒绝 stale-epoch,不会释放后来者的租约。
import { type Store, commitIn } from "./cas.ts";

export interface LeaseCell {
  readonly holder: string | null;
  readonly epoch: number;
}
export type LeaseTable = Store<LeaseCell>;
export interface LeaseSnapshot {
  readonly resource: string;
  readonly ver: number;
  readonly holder: string | null;
  readonly epoch: number;
}
export interface AcquireRequest {
  readonly resource: string;
  readonly holder: string;
  readonly expectedVer: number;
  readonly rank: number;
  readonly heldRanks: readonly number[];
}
export type AcquireResult =
  | { readonly ok: true; readonly table: LeaseTable; readonly epoch: number }
  | { readonly ok: false; readonly reason: "version-conflict"; readonly currentVer: number }
  | { readonly ok: false; readonly reason: "held-by-other"; readonly holder: string }
  | { readonly ok: false; readonly reason: "reverse-order"; readonly rank: number; readonly heldRank: number }
  | { readonly ok: false; readonly reason: "invalid-request"; readonly detail: string };
export interface ReleaseRequest {
  readonly resource: string;
  readonly holder: string;
  readonly epoch: number;
}
export type ReleaseResult =
  | { readonly ok: true; readonly table: LeaseTable }
  | { readonly ok: false; readonly reason: "not-holder"; readonly holder: string | null }
  | { readonly ok: false; readonly reason: "stale-epoch"; readonly epoch: number }
  | { readonly ok: false; readonly reason: "invalid-request"; readonly detail: string };

const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isNat = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

export function readLease(table: LeaseTable, resource: string): LeaseSnapshot {
  const c = table.get(resource);
  return { resource, ver: c?.ver ?? 0, holder: c?.value.holder ?? null, epoch: c?.value.epoch ?? 0 };
}

export function maxHeldRank(heldRanks: readonly number[]): number {
  return heldRanks.reduce((m, r) => Math.max(m, r), -1);
}

export function acquireLease(table: LeaseTable, req: AcquireRequest): AcquireResult {
  if (!isName(req.resource) || !isName(req.holder)) return { ok: false, reason: "invalid-request", detail: "resource 与 holder 必须是非空字符串" };
  if (!isNat(req.expectedVer) || !isNat(req.rank)) return { ok: false, reason: "invalid-request", detail: "expectedVer 与 rank 必须是非负整数" };
  if (!Array.isArray(req.heldRanks) || !req.heldRanks.every(isNat)) return { ok: false, reason: "invalid-request", detail: "heldRanks 必须是非负整数数组" };
  const heldRank = maxHeldRank(req.heldRanks);
  if (heldRank >= req.rank) return { ok: false, reason: "reverse-order", rank: req.rank, heldRank };
  const cur = readLease(table, req.resource);
  if (cur.ver !== req.expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };
  if (cur.holder !== null) return { ok: false, reason: "held-by-other", holder: cur.holder };
  const epoch = cur.epoch + 1;
  const r = commitIn(table, req.resource, req.expectedVer, { holder: req.holder, epoch });
  if (!r.ok) return { ok: false, reason: "version-conflict", currentVer: r.currentVer };
  return { ok: true, table: r.store, epoch };
}

export function releaseLease(table: LeaseTable, req: ReleaseRequest): ReleaseResult {
  if (!isName(req.resource) || !isName(req.holder)) return { ok: false, reason: "invalid-request", detail: "resource 与 holder 必须是非空字符串" };
  if (!isNat(req.epoch)) return { ok: false, reason: "invalid-request", detail: "epoch 必须是非负整数" };
  const cur = readLease(table, req.resource);
  if (cur.holder !== req.holder) return { ok: false, reason: "not-holder", holder: cur.holder };
  if (cur.epoch !== req.epoch) return { ok: false, reason: "stale-epoch", epoch: cur.epoch };
  const r = commitIn(table, req.resource, cur.ver, { holder: null, epoch: cur.epoch });
  if (!r.ok) return { ok: false, reason: "not-holder", holder: cur.holder };
  return { ok: true, table: r.store };
}
