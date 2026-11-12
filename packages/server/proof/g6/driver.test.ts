// G6 driver 端到端(规则替身,不联网):按本树自己的装配入口 start.ts 起宿主,逐步发消息、等安静,冻结原始记录;
// 注入的故障按题集落在指定那次调用上;缺网关配置不跑、记 config_insufficient。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { accounting, sameModel } from "./contracts.ts";
import { applyHostPatch, contactOf, driveItem, gatewayEnv } from "./driver.ts";
import { A, B, mkItem, mkSet } from "./fixtures/build.ts";
import { scoreRecords } from "./score.ts";

const dir = mkdtempSync(path.join(tmpdir(), "g6-drive-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let no = 0;
const opts = (item = mkItem()) => ({ set: mkSet([item]), item, group: "g1", commit: "c", rep: 1, mode: "standin" as const, model: "standin/rules-v1", env: {}, dataDir: path.join(dir, `d${++no}`), fingerprint: "fp", reuseKey: "rk", stepTimeoutMs: 20_000, callTimeoutMs: 20_000, quietMs: 30, settleMs: 0 });

test("替身跑完一道题:每步都有记录,每次调用都记账并归到联系人,第 1 次检查按题集换成解析失败", async () => {
  const item = mkItem({ faults: [{ contact: "A", cls: "check", nth: 1, fault: "malformed" }] });
  const rec = await driveItem(opts(item));
  assert.deepEqual([rec.status, rec.error], ["ok", null]);
  assert.deepEqual(rec.steps.map((s) => [s.step, s.op, s.timedOut]), [[0, "send", false], [1, "filler", false], [2, "send", false]]);
  assert.deepEqual(rec.sent.map((s) => s.text), ["以后周报都发到 weekly@corp.example", "今天食堂的番茄炒蛋有点咸", "周报要发到哪个邮箱来着?"]);
  assert.ok(rec.sent.every((s, i) => i === 0 || s.seq > rec.sent[i - 1]!.seq));
  assert.ok(rec.calls.length >= 6);
  assert.deepEqual([...new Set(rec.calls.map((c) => c.contact))], ["A"]);
  const checks = rec.calls.filter((c) => c.cls === "check");
  assert.deepEqual([checks[0]!.fault, checks[0]!.outcome, checks[0]!.usage.input], ["malformed", "parse_failure", 0]);
  assert.ok(checks.slice(1).every((c) => c.fault === null && c.outcome === "ok"));
  assert.ok(rec.replies.length >= 3 && rec.replies.every((r) => r.contact === "A" && r.room === "dm"));
  assert.deepEqual(Object.keys(rec.memories), ["A"]);
  assert.deepEqual(Object.keys(rec.notes), ["A"]);
  const m = scoreRecords(mkSet([item]), [rec]);
  assert.deepEqual([m.coverage.d, m.failures.injected, m.calls], [3, 1, rec.calls.length]);
  assert.equal(sameModel(rec).verdict, "pass");
  assert.equal(accounting(rec).verdict, "pass");
});

test("缺网关配置不跑:记 config_insufficient,一次模型调用也没有", async () => {
  const rec = await driveItem({ ...opts(), mode: "real", env: {} });
  assert.deepEqual([rec.status, rec.calls.length, rec.sent.length], ["config_insufficient", 0, 0]);
  assert.match(rec.error!, /^缺网关环境/);
  assert.equal(gatewayEnv({ mode: "real", model: "m", env: { ANTHROPIC_BASE_URL: "http://x.invalid" } }), null);
  assert.deepEqual(gatewayEnv({ mode: "real", model: "m", env: { ANTHROPIC_BASE_URL: "http://x.invalid", ANTHROPIC_API_KEY: "k" } }), { ANTHROPIC_BASE_URL: "http://x.invalid", ANTHROPIC_API_KEY: "k", ANTHROPIC_DEFAULT_SONNET_MODEL: "m" });
  assert.equal(gatewayEnv({ mode: "standin", model: "s", env: {} })?.ANTHROPIC_AUTH_TOKEN, "NEUTRAL_FIXTURE_NO_CREDENTIALS");
});

test("调用归属:认人设 marker;不带人设的补写请求只有一位联系人时归它,两位时记不明", () => {
  const one = mkItem();
  const two = mkItem({ contacts: [A, B] });
  assert.equal(contactOf(two, `前缀 ${B.marker}`), "B");
  assert.equal(contactOf(one, "[旧状态笔记] 没有人设"), "A");
  assert.equal(contactOf(two, "[旧状态笔记] 没有人设"), null);
  assert.equal(contactOf(two, `${A.marker} ${B.marker}`), null);
});

test("组级宿主选项覆盖:并进宿主已有的选项对象与精筛参数,被测提交里没有的字段如实记缺", () => {
  const host = { opts: { a: 1 }, finePolicy: { quietMs: 300_000, maxMarks: 8 } };
  const r = applyHostPatch(host, { opts: { historyPrefetch: false }, fineScreen: { quietMs: 20_000 } });
  assert.deepEqual(r, { applied: ["opts.historyPrefetch", "fineScreen.quietMs"], missing: [] });
  assert.deepEqual(host, { opts: { a: 1, historyPrefetch: false }, finePolicy: { quietMs: 20_000, maxMarks: 8 } });
  const old = { opts: { a: 1 } };
  assert.deepEqual(applyHostPatch(old, { fineScreen: { quietMs: 1 } }), { applied: [], missing: ["fineScreen.quietMs"] });
  assert.deepEqual(applyHostPatch(old, null), { applied: [], missing: [] });
});

test("替身跑一道题时 driver 把组级覆盖落到宿主上并记进原始记录;记忆带写下时刻", async () => {
  const rec = await driveItem({ ...opts(), hostPatch: { opts: { stateNoteMaxBytes: 4000 } }, serial: true });
  assert.deepEqual([rec.status, rec.hostPatch, rec.reuseKey], ["ok", { applied: ["opts.stateNoteMaxBytes"], missing: [] }, "rk"]);
  const m = rec.memories.A!.find((x) => x.body.includes("weekly@corp.example"));
  assert.ok(m && typeof m.createdAt === "number" && m.createdAt >= rec.startedAt && m.createdAt <= rec.endedAt);
  assert.ok(rec.calls.every((c) => c.queuedMs >= 0));
});
