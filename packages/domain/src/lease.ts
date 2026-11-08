// 多资源排他租约的最小原语(需求文档 D20 第四台 4A R-Quota / 4C R-Worktree / 4D R-Env 的共同部分,AC-10)。
// 模型检查规格见 packages/domain/tla/Lease.tla;TLC 反例在本原语上的回放见 trace-replay.ts。
// - 每个资源是一个 CAS 单元 {holder, epoch}(cas.ts 的 commitIn):申请 = 读快照,再以快照版本比较并提交;
//   版本变了收到 version-conflict,资源被别人占着收到 held-by-other(调用方排队等释放),都不写入。授予时 epoch+1。
// - 按 rank 全序申请((category_rank, res_id) 排好的先后):已持有同序或更高序资源时再申请更低序资源,
//   直接拒绝 reverse-order(4D E0 行 ReverseOrderRejected),调用方要先释放已持有的再按序重排。这是查无死锁的前提。
// - 释放必须由当前持有者带授予时的 epoch;旧 epoch 的迟到释放拒绝 stale-epoch,不会释放后来者的租约。
// 纯函数:不改入参表,成功时返回新表。宿主尚未接入(底座),接入时把表放进同一提交点的文档里。
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
  /** 申请方读快照时看到的版本 */
  readonly expectedVer: number;
  /** 本资源在全序里的序号 */
  readonly rank: number;
  /** 申请方当前已持有资源的序号 */
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
  /** 授予时拿到的 epoch */
  readonly epoch: number;
}
export type ReleaseResult =
  | { readonly ok: true; readonly table: LeaseTable }
  | { readonly ok: false; readonly reason: "not-holder"; readonly holder: string | null }
  | { readonly ok: false; readonly reason: "stale-epoch"; readonly epoch: number }
  | { readonly ok: false; readonly reason: "invalid-request"; readonly detail: string };

const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isNat = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** 读资源快照;从未登记过的资源是版本 0、空闲、epoch 0。 */
export function readLease(table: LeaseTable, resource: string): LeaseSnapshot {
  const c = table.get(resource);
  return { resource, ver: c?.ver ?? 0, holder: c?.value.holder ?? null, epoch: c?.value.epoch ?? 0 };
}

export function acquireLease(table: LeaseTable, req: AcquireRequest): AcquireResult {
  if (!isName(req.resource) || !isName(req.holder)) return { ok: false, reason: "invalid-request", detail: "resource 与 holder 必须是非空字符串" };
  if (!isNat(req.expectedVer) || !isNat(req.rank)) return { ok: false, reason: "invalid-request", detail: "expectedVer 与 rank 必须是非负整数" };
  if (!Array.isArray(req.heldRanks) || !req.heldRanks.every(isNat)) return { ok: false, reason: "invalid-request", detail: "heldRanks 必须是非负整数数组" };
  // 全序:手里已有同序或更高序的资源,再要低序的就拒绝(不原地等,防环形等待)
  const heldRank = req.heldRanks.reduce((m, r) => Math.max(m, r), -1);
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
