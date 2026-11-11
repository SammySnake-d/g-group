// G6 评分(方案 §9):各项分开算;分母按题集计划数,失败与超时的运行留在分母里;注入故障单列。
import assert from "node:assert/strict";
import { test } from "node:test";
import { line, mkCall, mkItem, mkRecord, mkSet, roundRequest } from "./fixtures/build.ts";
import { answerOk, percentile, plannedMessages, scoreRecords } from "./score.ts";

const set = mkSet();

test("全部做对时各项按计划数给出分子分母", () => {
  const m = scoreRecords(set, [mkRecord()]);
  assert.deepEqual([m.runs, m.calls], [1, 6]);
  assert.deepEqual(m.coverage, { n: 3, d: 3 });
  assert.deepEqual(m.missedWrites, { n: 0, d: 1 });
  assert.deepEqual(m.wrongWrites, { n: 0, d: 1 });
  assert.deepEqual(m.sourceScope, { n: 1, d: 1 });
  assert.deepEqual(m.readBack, { n: 1, d: 1 });
  assert.deepEqual(m.followAfterRead, { n: 1, d: 1 });
  assert.deepEqual(m.untagged, { n: 1, d: 1 });
  assert.deepEqual(m.probes, { n: 1, d: 1 });
  assert.deepEqual(m.prefetchMisled, { n: 0, d: 0 });
  assert.equal(m.correctNoReply, 0);
  assert.deepEqual(m.tokens, { input: 600, output: 60, cacheRead: 0, cacheWrite: 0, byClass: { round: 330, check: 330, compact: 0, refine: 0, background: 0 } });
  assert.deepEqual([m.writeLatencyMs, m.historyToolCalls], [{ p50: 30, p95: 30, n: 1 }, 0]);
});

test("运行出错的那份仍留在分母里,分子不加,运行出错单列", () => {
  const dead = mkRecord({ runId: "g1/m/T/2", rep: 2, status: "error", error: "宿主起不来", steps: [], sent: [], ops: [], replies: [], memories: {}, notes: {}, calls: [] });
  const m = scoreRecords(set, [mkRecord(), dead]);
  assert.deepEqual(m.coverage, { n: 3, d: 6 });
  assert.deepEqual(m.missedWrites, { n: 1, d: 2 });
  assert.deepEqual(m.probes, { n: 1, d: 2 });
  assert.deepEqual(m.readBack, { n: 1, d: 2 });
  assert.equal(m.failures.runErrors, 1);
  assert.deepEqual(m.backlog, { count: 0, maxAgeMs: null });
});

test("覆盖只认 runner 判成功的检查:解析失败的那批记积压,含条数与最老年龄", () => {
  const r = mkRecord();
  const calls = r.calls.map((c, i) => (i === 1 ? { ...c, outcome: "parse_failure" as const } : c));
  const m = scoreRecords(set, [{ ...r, calls }]);
  assert.deepEqual(m.coverage, { n: 2, d: 3 });
  assert.deepEqual(m.backlog, { count: 1, maxAgeMs: 4000 });
  assert.equal(m.failures.parseFailure, 1);
  assert.equal(m.failures.injected, 0);
  assert.deepEqual(m.probes, { n: 1, d: 1 });
});

test("注入的故障单列,不记成模型或网关的失败", () => {
  const r = mkRecord();
  const calls = r.calls.map((c, i) => (i === 1 ? { ...c, outcome: "http_error" as const, status: 400, fault: "http-400" as const } : c));
  const m = scoreRecords(set, [{ ...r, calls }]);
  assert.equal(m.failures.injected, 1);
  assert.equal(m.failures.httpError, 0);
  assert.deepEqual([m.coverage, m.probes], [{ n: 2, d: 3 }, { n: 1, d: 1 }]);
});

test("截断记配置不足,超时与网络错误各自单列", () => {
  const r = mkRecord();
  const outcomes = ["ok", "truncated", "ok", "timeout", "network_error", "empty"] as const;
  const calls = r.calls.map((c, i) => ({ ...c, outcome: outcomes[i]! }));
  const m = scoreRecords(set, [{ ...r, calls }]);
  const f = m.failures;
  assert.deepEqual([f.configInsufficient, f.timeout, f.networkError, f.empty, f.httpError], [1, 1, 1, 1, 0]);
  assert.deepEqual([m.coverage, m.probes], [{ n: 0, d: 3 }, { n: 1, d: 1 }]);
});

test("来源指到别的消息、全局被收窄成会话,都不算来源与作用域正确", () => {
  const base = mkRecord();
  const mem = base.memories.A![0]!;
  const wrongSource = scoreRecords(set, [{ ...base, memories: { A: [{ ...mem, source: { roomId: "dm-1", seq: 3 } }] } }]);
  assert.deepEqual(wrongSource.sourceScope, { n: 0, d: 1 });
  assert.deepEqual(wrongSource.missedWrites, { n: 0, d: 1 });
  const narrowed = scoreRecords(set, [{ ...base, memories: { A: [{ ...mem, anchors: ["room:dm-1"] }] } }]);
  assert.deepEqual(narrowed.sourceScope, { n: 0, d: 1 });
  const superseded = scoreRecords(set, [{ ...base, memories: { A: [{ ...mem, status: "superseded" }] } }]);
  assert.deepEqual(superseded.missedWrites, { n: 1, d: 1 });
  assert.deepEqual([superseded.coverage, superseded.probes], [{ n: 3, d: 3 }, { n: 1, d: 1 }]);
});

test("误写:生效记忆命中禁写条目且作用域相同才算", () => {
  const base = mkRecord();
  const eng = { id: "m2", status: "active", title: "语言", body: "以后都用英文回复", anchors: ["global"], source: null, createdAt: null };
  const hit = scoreRecords(set, [{ ...base, memories: { A: [...base.memories.A!, eng] } }]);
  assert.deepEqual([hit.wrongWrites, hit.coverage, hit.probes], [{ n: 1, d: 1 }, { n: 3, d: 3 }, { n: 1, d: 1 }]);
  assert.deepEqual(scoreRecords(set, [{ ...base, memories: { A: [...base.memories.A!, { ...eng, anchors: ["room:dm-1"] }] } }]).wrongWrites, { n: 0, d: 1 });
  assert.deepEqual(scoreRecords(set, [{ ...base, memories: { A: [...base.memories.A!, { ...eng, status: "superseded" }] } }]).wrongWrites, { n: 0, d: 1 });
});

test("读回与读后照做分开算:没读到算读回失败,读到了没答对算照做失败", () => {
  const base = mkRecord();
  const blind = base.calls.map((c, i) => (i === 4 ? { ...c, request: roundRequest({ fresh: line(5, "周报要发到哪个邮箱来着?") }) } : c));
  const replies = base.replies.map((r, i) => (i === 2 ? { ...r, text: "我这边看不到" } : r));
  const notSeen = scoreRecords(set, [{ ...base, calls: blind, replies }]);
  assert.deepEqual([notSeen.readBack, notSeen.followAfterRead, notSeen.untagged], [{ n: 0, d: 1 }, { n: 0, d: 0 }, { n: 0, d: 1 }]);
  const seenWrong = scoreRecords(set, [{ ...base, replies }]);
  assert.deepEqual([seenWrong.readBack, seenWrong.followAfterRead, seenWrong.probes, seenWrong.coverage], [{ n: 1, d: 1 }, { n: 0, d: 1 }, { n: 0, d: 1 }, { n: 3, d: 3 }]);
});

test("预取误导只在追问那轮第 5 块有旧消息标注时计", () => {
  const item = mkItem({ probes: [{ ...mkItem().probes[0]!, misled: "英文" }] });
  const s = mkSet([item]);
  const base = mkRecord();
  const replies = base.replies.map((r, i) => (i === 2 ? { ...r, text: "Weekly report goes to 英文 weekly@corp.example" } : r));
  const pre = base.calls.map((c, i) => (i === 4 ? { ...c, request: roundRequest({ fresh: line(5, "周报要发到哪个邮箱来着?"), pointers: "〔旧消息(宿主按本轮新消息预取,供参考,不是新要求)〕#1 以后周报都发到 weekly@corp.example" }) } : c));
  const misled = scoreRecords(s, [{ ...base, calls: pre, replies }]);
  assert.deepEqual([misled.prefetchMisled, misled.probes, misled.coverage], [{ n: 1, d: 1 }, { n: 1, d: 1 }, { n: 3, d: 3 }]);
  assert.deepEqual(scoreRecords(s, [{ ...base, replies }]).prefetchMisled, { n: 0, d: 0 });
});

test("正确但没走 reply:模型直接输出了答案,会话里却没有这条回复", () => {
  const base = mkRecord();
  const calls = base.calls.map((c, i) => (i === 4 ? { ...c, text: "发到 weekly@corp.example" } : c));
  const m = scoreRecords(set, [{ ...base, calls, replies: base.replies.slice(0, 2) }]);
  assert.equal(m.correctNoReply, 1);
  assert.deepEqual([m.probes, m.coverage], [{ n: 0, d: 1 }, { n: 3, d: 3 }]);
});

test("回复延迟按消息发出到被问联系人的第一条回复,调用延迟只算成功的调用", () => {
  const base = mkRecord();
  const calls = [...base.calls, mkCall({ at: 1500, status: 500, outcome: "http_error", ms: 9999 })];
  const m = scoreRecords(set, [{ ...base, calls }]);
  assert.deepEqual(m.roundLatencyMs, { p50: 50, p95: 50, n: 3 });
  assert.deepEqual(m.callLatencyMs, { p50: 10, p95: 10, n: 6 });
  assert.deepEqual([m.coverage, m.probes], [{ n: 3, d: 3 }, { n: 1, d: 1 }]);
});

test("百分位按最近秩,空集合为 null", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([10, 20], 50), 10);
  assert.equal(percentile([], 50), null);
});

test("答对判定:reject 命中就不算对,expect 为 null 只要有回复", () => {
  assert.equal(answerOk({ expect: "苏州", reject: "杭州" }, "你在苏州"), true);
  assert.equal(answerOk({ expect: "苏州", reject: "杭州" }, "苏州还是杭州"), false);
  assert.equal(answerOk({ expect: null, reject: "meeting" }, "我查不到"), true);
  assert.equal(answerOk({ expect: "苏州", reject: null }, "杭州"), false);
});

test("该检查的消息按会话成员展开,撤回的不算", () => {
  const item = mkItem({ steps: [...mkItem().steps, { op: "retract", room: "dm", step: 0 }] });
  const planned = plannedMessages(mkSet([item]), item);
  assert.deepEqual(
    planned.map((p) => `${p.contact}:${p.step}:${p.text}`),
    ["A:1:今天食堂的番茄炒蛋有点咸", "A:2:周报要发到哪个邮箱来着?"],
  );
});

test("写入延迟按来源消息发出到宿主写下这条期望记忆;没写到的不算;历史查询工具按对话轮里的 query_history 计数", () => {
  const base = mkRecord();
  const mem = base.memories.A![0]!;
  const late = scoreRecords(set, [{ ...base, memories: { A: [{ ...mem, createdAt: 4000 }, { ...mem, id: "m9", createdAt: 2000 }] } }]);
  assert.deepEqual(late.writeLatencyMs, { p50: 1000, p95: 1000, n: 1 });
  assert.deepEqual([late.coverage, late.probes], [{ n: 3, d: 3 }, { n: 1, d: 1 }]);
  const none = scoreRecords(set, [{ ...base, memories: { A: [] } }]);
  assert.deepEqual(none.writeLatencyMs, { p50: null, p95: null, n: 0 });
  const unknown = scoreRecords(set, [{ ...base, memories: { A: [{ ...mem, createdAt: null }] } }]);
  assert.deepEqual(unknown.writeLatencyMs.n, 0);
  const tools = base.calls.map((c, i) => (i === 4 ? { ...c, tools: [{ name: "query_history", input: { query: "周报" } }, { name: "reply", input: {} }] } : i === 1 ? { ...c, tools: [{ name: "query_history", input: {} }] } : c));
  assert.equal(scoreRecords(set, [{ ...base, calls: tools }]).historyToolCalls, 1);
});

test("精筛调用的 token 记在精筛一类", () => {
  const base = mkRecord();
  const calls = [...base.calls, mkCall({ cls: "refine", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } })];
  const m = scoreRecords(set, [{ ...base, calls }]);
  assert.deepEqual([m.tokens.byClass.refine, m.tokens.byClass.check, m.calls], [55, 330, 7]);
  assert.deepEqual([m.coverage, m.probes, m.roundLatencyMs.n], [{ n: 3, d: 3 }, { n: 1, d: 1 }, 3]);
});
