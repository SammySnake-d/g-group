// 多资源排他租约原语(第四台 4A/4C/4D 共同部分,AC-10 Lease.tla 的真实实现):
// 按资源排他、以快照版本比较并提交、全序申请(逆序拒绝)、释放带 epoch(旧 epoch 迟到释放拒绝)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LeaseTable, acquireLease, readLease, releaseLease } from "./lease.ts";

const empty = (): LeaseTable => new Map();
const grant = (t: LeaseTable, resource: string, holder: string, rank: number, heldRanks: number[] = []) => {
  const r = acquireLease(t, { resource, holder, expectedVer: readLease(t, resource).ver, rank, heldRanks });
  if (!r.ok) throw new Error(`授予失败:${r.reason}`);
  return r;
};

test("LEASE-01 空闲资源基于快照版本授予:持有者登记、epoch+1、版本+1,不改入参表", () => {
  const t = empty();
  const r = acquireLease(t, { resource: "a", holder: "h1", expectedVer: 0, rank: 0, heldRanks: [] });
  assert.ok(r.ok);
  assert.equal(r.epoch, 1);
  assert.deepEqual(readLease(r.table, "a"), { resource: "a", ver: 1, holder: "h1", epoch: 1 });
  assert.equal(t.size, 0);
  assert.deepEqual(readLease(t, "a"), { resource: "a", ver: 0, holder: null, epoch: 0 });
});

test("LEASE-02 两个持有者基于同一快照申请:后到者收到版本冲突,租约仍归先到者(阳性埋雷:去掉版本校验就双持有)", () => {
  const t = empty();
  const snap = readLease(t, "a");
  const first = acquireLease(t, { resource: "a", holder: "h1", expectedVer: snap.ver, rank: 0, heldRanks: [] });
  assert.ok(first.ok);
  const second = acquireLease(first.table, { resource: "a", holder: "h2", expectedVer: snap.ver, rank: 0, heldRanks: [] });
  assert.deepEqual(second, { ok: false, reason: "version-conflict", currentVer: 1 });
  assert.equal(readLease(first.table, "a").holder, "h1");
});

test("LEASE-03 资源被占用时基于最新版本申请:收到 held-by-other 排队,不写入", () => {
  const { table } = grant(empty(), "a", "h1", 0);
  const r = acquireLease(table, { resource: "a", holder: "h2", expectedVer: readLease(table, "a").ver, rank: 0, heldRanks: [] });
  assert.deepEqual(r, { ok: false, reason: "held-by-other", holder: "h1" });
  assert.deepEqual(readLease(table, "a"), { resource: "a", ver: 1, holder: "h1", epoch: 1 });
});

test("LEASE-04 全序:持有更高或同序资源再申请低序资源当场拒绝;按序递增申请照常(对照)", () => {
  const t = empty();
  assert.deepEqual(acquireLease(t, { resource: "a", holder: "h2", expectedVer: 0, rank: 0, heldRanks: [2] }), { ok: false, reason: "reverse-order", rank: 0, heldRank: 2 });
  assert.deepEqual(acquireLease(t, { resource: "c", holder: "h2", expectedVer: 0, rank: 2, heldRanks: [2] }), { ok: false, reason: "reverse-order", rank: 2, heldRank: 2 });
  assert.equal(t.size, 0);
  const a = grant(t, "a", "h1", 0);
  const b = acquireLease(a.table, { resource: "b", holder: "h1", expectedVer: 0, rank: 1, heldRanks: [0] });
  assert.ok(b.ok);
  assert.equal(readLease(b.table, "b").holder, "h1");
});

test("LEASE-05 释放:当前持有者带授予时的 epoch 释放成功;旧 epoch 迟到释放、非持有者释放都拒绝且不动后来者的租约", () => {
  const g1 = grant(empty(), "a", "h1", 0);
  const rel = releaseLease(g1.table, { resource: "a", holder: "h1", epoch: g1.epoch });
  assert.ok(rel.ok);
  assert.deepEqual(readLease(rel.table, "a"), { resource: "a", ver: 2, holder: null, epoch: 1 });
  // h1 重新拿到 a(epoch 2)后,上一次租约(epoch 1)的迟到释放不能释放这一次
  const g2 = grant(rel.table, "a", "h1", 0);
  assert.equal(g2.epoch, 2);
  assert.deepEqual(releaseLease(g2.table, { resource: "a", holder: "h1", epoch: 1 }), { ok: false, reason: "stale-epoch", epoch: 2 });
  assert.deepEqual(releaseLease(g2.table, { resource: "a", holder: "h2", epoch: 2 }), { ok: false, reason: "not-holder", holder: "h1" });
  assert.equal(readLease(g2.table, "a").holder, "h1");
  assert.deepEqual(releaseLease(empty(), { resource: "a", holder: "h1", epoch: 0 }), { ok: false, reason: "not-holder", holder: null });
});

test("LEASE-06 不同资源互不影响:各自授予、各自版本(阴性对照)", () => {
  const a = grant(empty(), "a", "h1", 0);
  const b = acquireLease(a.table, { resource: "b", holder: "h2", expectedVer: 0, rank: 1, heldRanks: [] });
  assert.ok(b.ok);
  assert.deepEqual([readLease(b.table, "a").holder, readLease(b.table, "b").holder], ["h1", "h2"]);
  assert.deepEqual([readLease(b.table, "a").ver, readLease(b.table, "b").ver], [1, 1]);
});

test("LEASE-07 非法请求返回 invalid-request,不写入", () => {
  const t = empty();
  const bad = [
    { resource: "", holder: "h1", expectedVer: 0, rank: 0, heldRanks: [] },
    { resource: "a", holder: "h1", expectedVer: -1, rank: 0, heldRanks: [] },
    { resource: "a", holder: "h1", expectedVer: 0, rank: 0.5, heldRanks: [] },
    { resource: "a", holder: "h1", expectedVer: 0, rank: 0, heldRanks: [-1] },
  ];
  for (const req of bad) assert.equal(acquireLease(t, req).ok === false && (acquireLease(t, req) as { reason: string }).reason, "invalid-request");
  assert.equal((releaseLease(t, { resource: "a", holder: "", epoch: 0 }) as { reason: string }).reason, "invalid-request");
  assert.equal((releaseLease(t, { resource: "a", holder: "h1", epoch: 1.5 }) as { reason: string }).reason, "invalid-request");
  assert.equal(t.size, 0);
});
