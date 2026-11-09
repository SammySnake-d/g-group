// AC-10 状态性切片模型检查:TLC 反例转回归用例。
// 规格在 packages/domain/tla/,TLC 原始输出在 packages/domain/proof/tlc-*.txt,反例与见证行为(-dumpTrace json)在 tla/traces/。
// 本文件只读存下的 JSON,不需要 java。去掉 CAS 的反例:模型接受、真实实现拒绝的那一步必须是分歧点;
// 带 CAS 的见证行为:真实实现必须逐步一致(阴性对照)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { acquireLease, readLease, releaseLease } from "./lease.ts";
import { divergence, finalState, replayClaim, replayLease, replayPublish, traceSteps } from "./trace-replay.ts";

const trace = (name: string): unknown => JSON.parse(readFileSync(new URL(`../tla/traces/${name}.json`, import.meta.url), "utf8"));
const ORDER = ["a", "b", "c"] as const;

test("TLA-01 发言发布:去掉 CAS 的 TLC 反例(读到 v0 → 用户新消息 → 发旧稿)在真实 commitIn 上被拒,旧稿不上屏", () => {
  const dump = trace("Publish-nocas");
  // 存下的确实是违反 NoStalePublish 的那条行为:模型里有一条基于 v0、在 v1 上发出的发布
  assert.deepEqual(finalState(dump).published, [{ who: "c1", base: 0, over: 1 }]);
  const r = replayPublish(dump);
  const d = divergence(r.steps);
  assert.ok(d, "去掉 CAS 的反例必须在真实实现上出现分歧");
  assert.deepEqual({ op: d.op, who: d.who, model: d.model, real: d.real, reason: d.reason }, { op: "publish", who: "c1", model: "ok", real: "conflict", reason: "version-conflict" });
  assert.deepEqual(r.published, []);
  assert.equal(r.ver, 1);
});

test("TLA-02 发言发布:去掉 CAS 的双写反例(两人都基于 v0 发布)在真实实现上只有先提交者成功", () => {
  const dump = trace("Publish-nocas-double");
  const model = finalState(dump).published as { base: number }[];
  assert.equal(model.length, 2);
  assert.ok(model.every((p) => p.base === 0));
  const r = replayPublish(dump);
  assert.deepEqual(r.published, [{ who: "c1", base: 0, over: 0 }]);
  const d = divergence(r.steps);
  assert.deepEqual(d && { index: d.index, who: d.who, real: d.real }, { index: 5, who: "c2", real: "conflict" });
  // 真实实现里没有双写:每条成功发布都基于提交瞬间的版本
  assert.ok(r.published.every((p) => p.base === p.over));
});

test("TLA-03 发言发布:带 CAS 的 TLC 见证行为(冲突 → 复核重读 → 发布)在真实实现上逐步一致(阴性对照)", () => {
  const r = replayPublish(trace("Publish-witness"));
  assert.equal(divergence(r.steps), null);
  assert.deepEqual(
    r.steps.map((s) => `${s.op}:${s.real}`),
    ["read:read", "msg:ok", "conflict:conflict", "read:read", "publish:ok"],
  );
  assert.deepEqual(r.published, [{ who: "c1", base: 1, over: 1 }]);
});

test("TLA-04 排他认领:去掉 CAS 的 TLC 反例(两人都读到 T1 后先后提交)在真实实现上第二人收到冲突,只有一个负责人", () => {
  const dump = trace("Claim-nocas");
  assert.deepEqual(finalState(dump).winners, ["c1", "c2"]);
  const r = replayClaim(dump);
  assert.deepEqual(r.winners, ["c1"]);
  assert.equal(r.owner, "c1");
  assert.equal(r.state, "T2_Claimed");
  assert.equal(r.ver, 1);
  const d = divergence(r.steps);
  assert.deepEqual(d && { index: d.index, who: d.who, model: d.model, real: d.real, reason: d.reason }, { index: 5, who: "c2", model: "ok", real: "conflict", reason: "version-conflict" });
});

test("TLA-05 排他认领:带 CAS 的 TLC 见证行为(冲突 → 重读 → 状态机拒绝重复认领)在真实实现上逐步一致(阴性对照)", () => {
  const r = replayClaim(trace("Claim-witness"));
  assert.equal(divergence(r.steps), null);
  assert.deepEqual(
    r.steps.map((s) => `${s.who}:${s.op}:${s.real}`),
    ["c1:read:read", "c2:read:read", "c1:commit:ok", "c2:conflict:conflict", "c2:read:read", "c2:rejected:rejected"],
  );
  const last = r.steps.at(-1);
  assert.match(last?.reason ?? "", /T2_Claimed × Claim/);
  assert.deepEqual(r.winners, ["c1"]);
});

test("TLA-06 多资源租约:去掉 CAS 的双持有反例在真实租约原语上后提交者收到冲突,资源只归先到者", () => {
  const dump = trace("Lease-nocas");
  const held = finalState(dump).held as Record<string, string[]>;
  assert.deepEqual([held.h1, held.h2], [["a"], ["a"]]);
  const r = replayLease(dump, ORDER);
  const d = divergence(r.steps);
  assert.deepEqual(d && { index: d.index, who: d.who, model: d.model, real: d.real, reason: d.reason }, { index: 5, who: "h2", model: "ok", real: "conflict", reason: "version-conflict" });
  assert.deepEqual(r.held, { h1: { a: 1 }, h2: {} });
  assert.equal(readLease(r.table, "a").holder, "h1");
});

test("TLA-07 多资源租约:去掉全序的死锁反例在真实实现上被全序规则打破:逆序申请当场拒绝,释放后对方继续", () => {
  const dump = trace("Lease-noorder");
  const fin = finalState(dump) as { held: Record<string, string[]>; pc: Record<string, string> };
  // TLC 报的死锁现场:h1 持有 a、b 等 c,h2 持有 c 等 a,谁都走不动
  assert.deepEqual([fin.held.h1, fin.held.h2], [["a", "b"], ["c"]]);
  assert.deepEqual(Object.values(fin.pc), ["acquiring", "acquiring", "acquiring"]);
  const r = replayLease(dump, ORDER);
  assert.equal(divergence(r.steps), null);
  assert.deepEqual(r.held, { h1: { a: 1, b: 1 }, h2: { c: 1 } });
  // h2 持有 c(rank 2)还要 a(rank 0):真实原语直接拒绝,不原地等
  const rev = acquireLease(r.table, { resource: "a", holder: "h2", expectedVer: readLease(r.table, "a").ver, rank: 0, heldRanks: [2] });
  assert.deepEqual(rev, { ok: false, reason: "reverse-order", rank: 0, heldRank: 2 });
  // h1 要 c:c 被 h2 占着,排队
  const busy = acquireLease(r.table, { resource: "c", holder: "h1", expectedVer: readLease(r.table, "c").ver, rank: 2, heldRanks: [0, 1] });
  assert.deepEqual(busy, { ok: false, reason: "held-by-other", holder: "h2" });
  // h2 按规则先释放 c,h1 随即拿到 c,环被打破
  const rel = releaseLease(r.table, { resource: "c", holder: "h2", epoch: 1 });
  assert.ok(rel.ok);
  const got = acquireLease(rel.table, { resource: "c", holder: "h1", expectedVer: readLease(rel.table, "c").ver, rank: 2, heldRanks: [0, 1] });
  assert.ok(got.ok);
  assert.equal(got.epoch, 2);
  assert.equal(readLease(got.table, "c").holder, "h1");
});

test("TLA-08 多资源租约:带 CAS 与全序的 TLC 见证行为(后提交者冲突 → 先到者用完释放 → 冲突方重读拿齐)在真实实现上逐步一致(阴性对照)", () => {
  const r = replayLease(trace("Lease-witness"), ORDER);
  assert.equal(divergence(r.steps), null);
  assert.deepEqual(
    r.steps.map((s) => `${s.who}:${s.op}:${s.real}`),
    [
      "h1:read:read", "h2:read:read", "h1:grant:ok", "h1:read:read", "h1:grant:ok", "h1:read:read", "h1:grant:ok", "h1:release:ok",
      "h2:conflict:conflict", "h2:read:read", "h2:grant:ok", "h2:read:read", "h2:grant:ok", "h2:read:read", "h2:grant:ok",
    ],
  );
  // 释放后再授予,epoch 递增:h1 那一代(epoch 1)的令牌对 h2 这一代无效
  assert.deepEqual(r.held, { h1: {}, h2: { a: 2, b: 2, c: 2 } });
  assert.deepEqual(readLease(r.table, "a"), { resource: "a", ver: 3, holder: "h2", epoch: 2 });
  assert.deepEqual(releaseLease(r.table, { resource: "a", holder: "h2", epoch: 1 }), { ok: false, reason: "stale-epoch", epoch: 2 });
});

test("TLA-10 多资源租约:去掉全序的逆序授予反例(先拿 b 再拿 a)在真实实现上第二次申请被当场拒绝", () => {
  const dump = trace("Lease-noorder-reverse");
  assert.deepEqual((finalState(dump).held as Record<string, string[]>).h1, ["a", "b"]);
  const r = replayLease(dump, ORDER);
  const d = divergence(r.steps);
  assert.deepEqual(d && { index: d.index, who: d.who, model: d.model, real: d.real, reason: d.reason }, { index: 5, who: "h1", model: "ok", real: "rejected", reason: "reverse-order" });
  assert.deepEqual(r.held, { h1: { b: 1 } });
  assert.equal(readLease(r.table, "a").holder, null);
});

test("TLA-09 回放只收 TLC -dumpTrace json:格式不对或出现规格里没有的动作就抛 TypeError", () => {
  assert.throws(() => traceSteps({}), { name: "TypeError", message: /不是 TLC -dumpTrace json 的输出/ });
  assert.throws(() => traceSteps({ counterexample: { state: [[1, { act: { op: "init" } }], ["2", {}]] } }), { name: "TypeError", message: /TLC 状态条目格式不对/ });
  assert.throws(() => traceSteps({ counterexample: { state: [[1, { act: { op: "init" } }], [2, {}]] } }), { name: "TypeError", message: /第 2 个状态缺少 act.op/ });
  const bogus = { counterexample: { state: [[1, { act: { op: "init" } }], [2, { act: { op: "teleport", who: "c1" } }]] } };
  assert.throws(() => replayPublish(bogus), { name: "TypeError", message: /发布规格里没有动作 teleport/ });
  assert.throws(() => replayClaim(bogus), { name: "TypeError", message: /认领规格里没有动作 teleport/ });
  assert.throws(() => replayLease(bogus, ORDER), { name: "TypeError", message: /租约规格里没有动作 teleport/ });
  assert.throws(() => replayClaim({ counterexample: { state: [[1, { act: { op: "init" } }], [2, { act: { op: "read" } }]] } }), { name: "TypeError", message: /缺少字符串字段 who/ });
  assert.throws(() => finalState({ counterexample: { state: [] } }), { name: "TypeError", message: /trace 是空的/ });
  assert.deepEqual(traceSteps(trace("Claim-nocas")).map((s) => s.index), [2, 3, 4, 5]);
});
