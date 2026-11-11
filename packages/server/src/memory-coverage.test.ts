import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_RETRY_POLICY, parseMemory, planMemoryWrite, type MemoryEntry } from "@g-group/kernel";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory-store.ts";
import { MemoryCoverage, type CaptureWrite, type CoverageRef } from "./memory-coverage.ts";
const dir = mkdtempSync(path.join(tmpdir(), "gg-memory-coverage-"));
after(() => rmSync(dir, { recursive: true, force: true })); let num = 0;
const ref: CoverageRef = { roomId: "r", seq: 2, revision: 2 };
const now = "2026-11-11T00:00:00.000Z";
function fixture(Coverage: typeof MemoryCoverage, Store: typeof MemoryStore) {
  const root = path.join(dir, String(++num)); const db = openDb(path.join(dir, `db-${num}.sqlite`));
  const memory = new Store(db, root, () => {}); const coverage = new Coverage(db, memory);
  after(() => db.close()); return { root, db, memory, coverage };
}
function plan(entries: MemoryEntry[], body: string, id: string, writeId: string, relation: { kind: "change"; target: string } | null = null): CaptureWrite {
  const p = planMemoryWrite(entries, { title: body, body, anchors: ["room:r"], source: { roomId: "r", seq: 2, userQuote: true, revision: 2, quote: body, senderId: "u" }, relation }, now, () => id);
  if (p.kind === "invalid") throw new Error(p.why);
  return { id: writeId, before: p.changed.map(e => entries.find(x => x.id === e.id) ?? null), after: p.changed.map(e => ({ ...e, captureIds: [...new Set([...(e.captureIds ?? []), writeId])] })), question: null };
}
function work(s: ReturnType<typeof fixture>) { return s.coverage.begin("c", [ref], [], ["r"], "model"); }
test("G1-01B 覆盖按实际投递版本登记且同批重复幂等", () => {
  const s = fixture(MemoryCoverage, MemoryStore);
  const one = s.coverage.begin("c", [ref, { roomId: "r", seq: 9, revision: 11 }], [], ["r"], "model");
  const again = s.coverage.begin("c", [{ roomId: "r", seq: 9, revision: 11 }, ref], [], ["r"], "model");
  assert.equal(one.id, again.id); assert.equal(one.state, "pending");
  assert.deepEqual(one.sources.map(x => x.seq), [2, 9]); assert.equal(s.coverage.list("c").length, 1);
  assert.equal(s.coverage.dirty("c"), false, "检查pending不等于md半写入");
  const other = s.coverage.begin("other", [ref], [], ["r"], "model"); assert.notEqual(one.id, other.id);
});
test("G1-01R 失败补查复用重试策略的退避和上限", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s); const policy = { ...DEFAULT_RETRY_POLICY, maxAutoRetries: 1, baseDelayMs: 20, maxDelayMs: 20, jitter: 0 };
  s.coverage.fail(w.id, "503", "A1", policy, 100);
  assert.equal(s.coverage.due("c", 119).length, 0); assert.equal(s.coverage.due("c", 120).length, 1);
  assert.equal(s.coverage.get(w.id).attempts, 1);
  s.coverage.fail(w.id, "503", "A1", policy, 120);
  assert.equal(s.coverage.due("c", 99999).length, 0); assert.equal(s.coverage.get(w.id).blocked, true);
  assert.equal(s.coverage.get(w.id).state, "failed");
  assert.equal(s.coverage.dirty("c"), false, "重试耗尽仍无未完成md事务");
});
test("G1-01A 鉴权额度失败不逐轮重试且不清欠账", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s);
  s.coverage.fail(w.id, "401", "A2", DEFAULT_RETRY_POLICY, 0);
  assert.equal(s.coverage.get(w.id).attempts, 0); assert.equal(s.coverage.due("c", 999999).length, 0);
  assert.equal(s.coverage.dirty("c"), false, "鉴权失败不能制造md写入栅栏");
  assert.equal(s.coverage.list("c").length, 1); s.coverage.retry(w.id); assert.equal(s.coverage.due("c", 999999).length, 1);
});
test("G1-03Z 合法零结果完成而无结果 pending 不冒成功", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s);
  assert.equal(s.coverage.get(w.id).state, "pending"); s.coverage.prepare(w.id, [], 0); s.coverage.apply(w.id);
  assert.equal(s.coverage.get(w.id).state, "ok"); assert.equal(s.memory.list("c").length, 0);
});
test("G1-04N md 已写而数据库未确认重开后不新建第二条", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s); const p = plan([], "事实一", "m-one", `${w.id}:one`);
  s.coverage.prepare(w.id, [p], 0);
  const put = s.memory.put.bind(s.memory); s.memory.put = (c, e) => { put(c, e); throw new Error("after-md"); };
  assert.throws(() => s.coverage.apply(w.id), /after-md/); assert.equal(s.coverage.dirty("c"), true);
  s.memory.put = put;
  const db2 = openDb(path.join(dir, `db-${num}.sqlite`));
  try {
    const memory2 = new MemoryStore(db2, s.root, () => {}); const c2 = new MemoryCoverage(db2, memory2); c2.apply(w.id);
    assert.equal(memory2.list("c").length, 1); assert.equal(c2.get(w.id).state, "ok");
  } finally { db2.close(); }
  assert.equal(readdirSync(path.join(s.root, "c")).filter(x => x.endsWith(".md")).length, 1);
});
test("G1-04E 重复恢复不多挂佐证或多升版本", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const first = plan([], "同一个事实", "m-one", "old"); s.memory.put("c", first.after[0]!);
  const w = work(s); const p = plan(s.memory.list("c"), "同一个事实", "unused", `${w.id}:one`); s.coverage.prepare(w.id, [p], 0);
  const put = s.memory.put.bind(s.memory); s.memory.put = (c,e) => { put(c,e); throw new Error("after-evidence"); };
  assert.throws(() => s.coverage.apply(w.id), /after-evidence/); s.memory.put = put;
  s.coverage.apply(w.id); s.coverage.apply(w.id);
  assert.equal(s.memory.list("c")[0]!.version, 2); assert.equal(s.memory.list("c")[0]!.evidence.length, 1);
});
test("G1-04C 替代两文件中途失败重启只补未写文件", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const first = plan([], "旧结论", "m-old", "old"); s.memory.put("c", first.after[0]!);
  const w = work(s); const p = plan(s.memory.list("c"), "新结论", "m-new", `${w.id}:change`, { kind: "change", target: "m-old" }); s.coverage.prepare(w.id, [p], 0);
  const put = s.memory.put.bind(s.memory); let calls=0; s.memory.put = (c,e) => { put(c,e); if (++calls===1) throw new Error("half-change"); };
  assert.throws(() => s.coverage.apply(w.id), /half-change/); s.memory.put=put; s.coverage.apply(w.id); s.coverage.apply(w.id);
  assert.deepEqual(s.memory.list("c").map(e => [e.id,e.status,e.version]).sort(), [["m-new","active",1],["m-old","superseded",2]]);
});
test("G1-04I 部分写入后来源失效只撤回自己未完成的写入", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s); const p = plan([], "待处置事实", "m-new", `${w.id}:new`); s.coverage.prepare(w.id, [p], 0);
  const put = s.memory.put.bind(s.memory); s.memory.put = (c,e) => { put(c,e); throw new Error("partial"); };
  assert.throws(() => s.coverage.apply(w.id), /partial/); s.memory.put=put; s.coverage.invalidate(w.id, "source-retracted");
  assert.equal(s.coverage.get(w.id).state, "failed"); assert.equal(s.coverage.get(w.id).disposition, "source-retracted");
  assert.equal(s.memory.list("c").length, 0); assert.deepEqual(readdirSync(path.join(s.root, "c")), []);
  assert.equal(s.coverage.get(w.id).writes, null, "处置记录不保留原文快照");
});
test("G1-04T 一条消息两件事两个稳定写入身份不会互吞", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s);
  const a = plan([], "事实一", "m-one", `${w.id}:one`); const b = plan([...a.after], "事实二", "m-two", `${w.id}:two`);
  s.coverage.prepare(w.id, [a,b], 0); s.coverage.apply(w.id);
  assert.equal(s.memory.list("c").length, 2);
  const parsed = parseMemory(readFileSync(path.join(s.root, "c", "m-two.md"), "utf8")); assert.ok(parsed.ok); assert.deepEqual(parsed.entry.captureIds, [`${w.id}:two`]);
});
test("G1-03P 有合法项可落地但部分无效不冒充整批检查完成", () => {
  const s = fixture(MemoryCoverage, MemoryStore); const w = work(s); const p = plan([], "合法事实", "m-one", `${w.id}:one`);
  s.coverage.prepare(w.id, [p], 1); s.coverage.apply(w.id);
  assert.equal(s.memory.list("c").length, 1); assert.equal(s.coverage.get(w.id).state, "failed"); assert.equal(s.coverage.get(w.id).unresolved, 1);
});
