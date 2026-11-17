// AC-32 ④ / AC-51 ⑥:不可变启动快照 + 只追加尝试账本,派生累积生产厂商集合(修复 A27-01)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyModelRecord, isAppendOnly, producerModels, producerVendors, recordAttempt } from "./model-ledger.ts";

const at = "2026-11-09T02:00:00.000Z";

test("首次启动写入启动快照 {harness, model, effort, vendor};之后的轮次只追加账本,快照不变", () => {
  const r1 = recordAttempt(emptyModelRecord, { computeId: "cp1", harness: "claude-code", model: "claude-opus-5-5", effort: "high", reason: "start", at });
  assert.deepEqual(r1.initial, { harness: "claude-code", model: "claude-opus-5-5", effort: "high", vendor: "anthropic" });
  const r2 = recordAttempt(r1, { computeId: "cp1", harness: "claude-code", model: "deepseek-v4", effort: "medium", reason: "turn", at });
  assert.deepEqual(r2.initial, r1.initial, "后续轮次换了模型,启动快照仍是启动时的值");
  assert.deepEqual(r2.attempts.map((a) => [a.seq, a.model, a.reason, a.vendor]), [[1, "claude-opus-5-5", "start", "anthropic"], [2, "deepseek-v4", "turn", "deepseek"]]);
  assert.equal(r1.attempts.length, 1, "不改入参");
  assert.equal(Object.isFrozen(r2.attempts[0]), true);
});

test("半途换厂商重试:累积厂商集合含新旧两家,启动快照仍是 A(埋雷:只记末次厂商必红)", () => {
  let r = recordAttempt(emptyModelRecord, { computeId: "cp1", harness: "claude-code", model: "claude-opus-5-5", effort: "high", reason: "start", at });
  r = recordAttempt(r, { computeId: "cp2", harness: "codex", model: "gpt-6-astra", effort: "high", reason: "switch-retry", at });
  r = recordAttempt(r, { computeId: "cp2", harness: "codex", model: "gpt-6-astra", effort: "high", reason: "turn", at });
  assert.deepEqual(producerVendors(r), ["anthropic", "openai"]);
  assert.deepEqual(producerModels(r), ["claude-opus-5-5", "gpt-6-astra"]);
  assert.equal(r.initial?.model, "claude-opus-5-5");
  const u = recordAttempt(r, { computeId: "cp2", harness: "codex", model: "stealth/crouton-alpha", effort: "high", reason: "observed", at });
  assert.deepEqual(producerVendors(u), ["anthropic", "openai", "unknown"], "认不出的记 unknown,供门禁阻断");
});

test("只追加守卫:改写启动快照或旧条目判为违规,正常追加判为合规", () => {
  const r1 = recordAttempt(emptyModelRecord, { computeId: "cp1", harness: "claude-code", model: "claude-opus-5-5", effort: "high", reason: "start", at });
  const r2 = recordAttempt(r1, { computeId: "cp1", harness: "claude-code", model: "deepseek-v4", effort: "high", reason: "turn", at });
  assert.equal(isAppendOnly(r1, r2), true);
  assert.equal(isAppendOnly(r1, { ...r2, initial: { ...r2.initial!, model: "deepseek-v4" } }), false, "批量替换覆写启动快照必须判违规");
  assert.equal(isAppendOnly(r2, { initial: r2.initial, attempts: [{ ...r2.attempts[0]!, model: "x" }, r2.attempts[1]!] }), false);
  assert.equal(isAppendOnly(r2, { initial: r2.initial, attempts: [r2.attempts[0]!] }), false, "删掉条目也判违规");
  assert.equal(isAppendOnly(emptyModelRecord, r1), true);
});
