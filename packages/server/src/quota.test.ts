// AC-23 Compute 槽位租约(纯数据结构):个人槽位 + 本群临时槽位,不跨群;停止确认后才归还;不重复授予、不重复释放。
import assert from "node:assert/strict";
import { test } from "node:test";
import { QuotaTable } from "./quota.ts";

/** 槽位配置:每位联系人 personal 个个人槽位,群临时槽位按 groups 表 */
function cfg(personal: number, groups: Record<string, number>) {
  let n = 0;
  return { personal: () => personal, group: (roomId: string) => groups[roomId] ?? 0, newId: () => `${++n}` };
}
const req = (taskId: string, contactId: string, roomId: string, isGroup = roomId.startsWith("g")) => ({ taskId, contactId, roomId, isGroup });

test("个人槽位满了借本群临时槽位;本群也满就排队并写明原因;别的群有空槽也不借", () => {
  const q = new QuotaTable(cfg(1, { gA: 1, gB: 0 }));
  const a1 = q.acquire(req("a1", "x", "gA"));
  assert.ok("granted" in a1 && a1.granted.scope === "personal:x");
  const b1 = q.acquire(req("b1", "x", "gB"));
  assert.deepEqual(b1, { queued: "个人算力正被 gA 里的任务占用,本群临时 Compute 也满了;排队等,或转交别人" });
  const a2 = q.acquire(req("a2", "x", "gA"));
  assert.ok("granted" in a2 && a2.granted.scope === "group:gA");
  assert.deepEqual(q.view().leases.map((l) => [l.taskId, l.scope]), [["a1", "personal:x"], ["a2", "group:gA"]]);
  assert.deepEqual(q.view().waiting.map((w) => w.taskId), ["b1"]);
});

test("停止请求不归还槽位;确认停下后才释放,并按先来先到授予排队者", () => {
  const q = new QuotaTable(cfg(1, {}));
  const t1 = q.acquire(req("t1", "x", "dm-x"));
  assert.ok("granted" in t1);
  assert.ok("queued" in q.acquire(req("t2", "x", "dm-x")));
  assert.ok("queued" in q.acquire(req("t3", "x", "dm-x")));
  q.markStopping("t1");
  assert.equal(q.leaseOf("t1")?.stopping, true);
  assert.equal(q.leaseOf("t2"), undefined, "停止请求之后、确认之前,排队的不开工");
  const r = q.release(t1.granted.leaseId);
  assert.equal(r.released, true);
  assert.deepEqual(r.granted.map((l) => l.taskId), ["t2"]);
  assert.equal(q.waitingReason("t3"), "个人算力正被 dm-x 里的任务占用;排队等,或转交别人");
});

test("同一任务不重复授予;重复释放、迟到的旧租约号释放都幂等忽略", () => {
  const q = new QuotaTable(cfg(2, {}));
  const a = q.acquire(req("t1", "x", "dm-x"));
  const again = q.acquire(req("t1", "x", "dm-x"));
  assert.ok("granted" in a && "granted" in again);
  assert.equal(again.granted.leaseId, a.granted.leaseId);
  assert.equal(again.reused, true);
  assert.equal(q.view().leases.length, 1);
  assert.equal(q.release(a.granted.leaseId).released, true);
  assert.deepEqual(q.release(a.granted.leaseId), { released: false, granted: [] });
  assert.deepEqual(q.release("lease-旧"), { released: false, granted: [] });
  const b = q.acquire(req("t2", "x", "dm-x"));
  const c = q.acquire(req("t3", "x", "dm-x"));
  assert.ok("granted" in b && "granted" in c, "重复释放没有多出槽位,也没有少掉");
  assert.ok("queued" in q.acquire(req("t4", "x", "dm-x")));
});

test("排队先来先到不插队;能借本群临时槽位的不必等个人槽位;别的联系人不受影响", () => {
  const q = new QuotaTable(cfg(1, { gG: 1 }));
  assert.ok("granted" in q.acquire(req("dm1", "x", "dm-x")));
  assert.ok("queued" in q.acquire(req("dm2", "x", "dm-x")));
  const g = q.acquire(req("g1", "x", "gG"));
  assert.ok("granted" in g && g.granted.scope === "group:gG");
  const y = q.acquire(req("y1", "y", "gG"));
  assert.ok("granted" in y && y.granted.scope === "personal:y");
  // dm2 还在等 x 的个人槽位;g2 也要 x 的个人槽位且本群临时满了,排在 dm2 后面
  assert.ok("queued" in q.acquire(req("g2", "x", "gG")));
  const lease = q.leaseOf("dm1")!;
  assert.deepEqual(q.release(lease.leaseId).granted.map((l) => l.taskId), ["dm2"]);
  assert.deepEqual(q.view().waiting.map((w) => w.taskId), ["g2"]);
});

test("取消排队后不再被授予", () => {
  const q = new QuotaTable(cfg(1, {}));
  const t1 = q.acquire(req("t1", "x", "dm-x"));
  q.acquire(req("t2", "x", "dm-x"));
  assert.equal(q.cancelWait("t2"), true);
  assert.equal(q.cancelWait("t2"), false);
  assert.ok("granted" in t1);
  assert.deepEqual(q.release(t1.granted.leaseId).granted, []);
  assert.equal(q.waitingReason("t2"), null);
});
