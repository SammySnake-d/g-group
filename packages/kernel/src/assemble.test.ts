// AC-06 引用旧消息确定性 Page-in:被引用 #seq 原文精确进装配;超预算显式失败,禁止静默截断;窗口内引用不重复页入。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log } from "@g-group/domain";
import { assemble } from "./assemble.ts";

const user = { kind: "user", id: "u1" } as const;
const contact = { kind: "contact", id: "c-astra" } as const;
const at = "2026-11-05T13:40:00Z";
const OLD = "压测报告结论:p99 在 820ms,瓶颈在登录接口的 bcrypt 轮数";

/** 10 条消息:#1 是早已滑出窗口的旧结论,#2..#10 是日常闲聊 */
function history(): Log {
  let log = append(emptyLog(), contact, { kind: "message", text: OLD }, at);
  for (let i = 2; i <= 10; i++) log = append(log, i % 2 ? contact : user, { kind: "message", text: `闲聊 ${i}` }, at);
  return log;
}
const BIG = 1_000_000;

test("被引用的旧消息不在窗口内也按原文精确页入,清单记 seq 与字节数", () => {
  const r = assemble(history(), { window: 3, quotes: [1], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.content.includes(OLD), "#1 原文必须逐字出现在装配内容里");
  const paged = r.manifest.find((m) => m.seq === 1);
  assert.equal(paged?.via, "page-in");
  assert.ok((paged?.bytes ?? 0) >= Buffer.byteLength(OLD, "utf8"));
  assert.deepEqual(r.manifest.filter((m) => m.via === "window").map((m) => m.seq), [8, 9, 10]);
});

test("同一窗口只切引用开关:不引用 1 号旧消息时它不进装配(阴性对照)", () => {
  const r = assemble(history(), { window: 3, quotes: [], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.content.includes(OLD), false);
  assert.deepEqual(r.manifest.map((m) => m.seq), [8, 9, 10]);
});

test("清单字节数之和等于装配内容的实际 UTF-8 字节数", () => {
  const r = assemble(history(), { window: 4, quotes: [1, 2], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const sum = r.manifest.reduce((a, m) => a + m.bytes, 0);
  assert.equal(sum, Buffer.byteLength(r.content, "utf8"));
  assert.equal(r.totalBytes, sum);
});

test("超预算一个字节就显式失败并报出需要多少,而不是静默截断(阳性埋雷)", () => {
  const full = assemble(history(), { window: 3, quotes: [1], budgetBytes: BIG });
  assert.equal(full.ok, true);
  if (!full.ok) return;
  const r = assemble(history(), { window: 3, quotes: [1], budgetBytes: full.totalBytes - 1 });
  assert.deepEqual(r, { ok: false, reason: "over-budget", need: full.totalBytes, budget: full.totalBytes - 1 });
});

test("预算恰好等于所需字节时装配成功(阴性对照)", () => {
  const full = assemble(history(), { window: 3, quotes: [1], budgetBytes: BIG });
  assert.equal(full.ok, true);
  if (!full.ok) return;
  const r = assemble(history(), { window: 3, quotes: [1], budgetBytes: full.totalBytes });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, full.content);
});

test("引用窗口内的消息不触发页入,原文只出现一次", () => {
  const r = assemble(history(), { window: 3, quotes: [9], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.manifest.map((m) => [m.seq, m.via]), [[8, "window"], [9, "window"], [10, "window"]]);
  assert.equal(r.content.split("闲聊 9").length - 1, 1);
});

test("撤回的消息既不进窗口也不能被引用页入,清单把它列为跳过", () => {
  let log = history();
  log = append(log, user, { kind: "retract", target: 10 }, at);
  log = append(log, contact, { kind: "retract", target: 1 }, at);
  const r = assemble(log, { window: 2, quotes: [1], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.content.includes(OLD), false);
  assert.equal(r.content.includes("闲聊 10"), false);
  assert.deepEqual(r.manifest.map((m) => m.seq), [8, 9]);
  assert.deepEqual(r.skipped, [{ seq: 1, reason: "retracted" }]);
});

test("编辑过的消息按最新文字装配", () => {
  let log = history();
  log = append(log, contact, { kind: "edit", target: 1, text: "压测报告结论(订正):p99 在 640ms" }, at);
  const r = assemble(log, { window: 2, quotes: [1], budgetBytes: BIG });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.content.includes("p99 在 640ms"));
  assert.equal(r.content.includes(OLD), false);
});

test("引用不存在的消息序号显式失败", () => {
  const r = assemble(history(), { window: 2, quotes: [99], budgetBytes: BIG });
  assert.deepEqual(r, { ok: false, reason: "quote-not-found", seq: 99 });
});
