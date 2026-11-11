// AC-43 ⑧/⑬/⑭ 失败原因分类(需求文档 D26 第 8.4 节):归类由代码按规则表做,宿主自己的结构化事实与 harness 结构化字段优先、原文规则其次;
// 认不出记 unknown 并保留原文,不硬塞别的类;reason_class 与 retry_class(AC-36)分开存;规则表带版本号,导出的表冻结。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, FAILURE_RULES, FAILURE_RULES_VERSION, REASON_CLASSES, REASON_TABLE } from "./failure-class.ts";

const brief = (x: ReturnType<typeof classifyFailure>) => [x.reasonClass, x.retryClass, x.autoRerun, x.label];

test("第 8.4 节表每一行:按原文认出类别,画板人话、retry_class、自动重跑列与表一致", () => {
  const rows: [string, unknown[]][] = [
    ["API Error: 529 Overloaded", ["upstream_unavailable", "Transient", "allowed", "上游不可用"]],
    ["平台繁忙,请稍后再试", ["upstream_unavailable", "Transient", "allowed", "上游不可用"]],
    ["no upstream available for model deepseek-v4.1-flash", ["upstream_unavailable", "Transient", "allowed", "上游不可用"]],
    ["API Error: 429 Too Many Requests", ["rate_limited", "Transient", "backoff", "被限流"]],
    ["共享额度暂时用尽,请稍后", ["rate_limited", "Transient", "backoff", "被限流"]],
    ["stream disconnected before completion", ["stream_dropped", "Transient", "allowed", "上游一直断流"]],
    ["Prompt is too long", ["context_overflow", "Permanent", "new_session_only", "上下文超长,压缩失败"]],
    ["API Error: 401 invalid x-api-key", ["auth_or_quota", "Permanent", "never", "鉴权或额度问题"]],
    ["403 not authorized", ["auth_or_quota", "Permanent", "never", "鉴权或额度问题"]],
    ["OAuth token has been revoked", ["auth_or_quota", "Permanent", "never", "鉴权或额度问题"]],
    ["The model `gpt-9` does not exist or you do not have access to it", ["invalid_request", "Permanent", "never", "请求被拒"]],
    ["API Error: 400", ["invalid_request", "Permanent", "never", "请求被拒"]],
    ["error_during_execution", ["harness_crashed", "MidTurn", "allowed", "执行器崩溃"]],
    ["进程以 1 退出", ["harness_crashed", "MidTurn", "allowed", "执行器崩溃"]],
    ["No conversation found with session ID: 1f0c", ["session_lost", "Permanent", "new_session_only", "原会话找不到"]],
    ["Request flagged by cyber_policy", ["platform_refused", "Permanent", "new_session_only", "平台拒绝"]],
    ["Our safeguards flagged this request", ["platform_refused", "Permanent", "new_session_only", "平台拒绝"]],
    ["Interrupted by user.", ["user_stopped", "Permanent", "never", "已停止"]],
  ];
  for (const [text, want] of rows) {
    const got = classifyFailure({ text });
    assert.deepEqual(brief(got), want, text);
    assert.equal(got.raw, text, `${text} 原文保留`);
  }
  // 卡死、无响应两行由宿主的卡死判定给出(结构化),不靠原文
  assert.deepEqual(brief(classifyFailure({ text: "", stall: "stalled" })), ["stalled", "MidTurn", "allowed", "卡住无进展"]);
  assert.deepEqual(brief(classifyFailure({ text: "", stall: "no_response" })), ["no_response", "Transient", "not_same_upstream", "上游没回应"]);
  assert.deepEqual(brief(classifyFailure({ text: "", stall: "stream_dropped" })), ["stream_dropped", "Transient", "allowed", "上游一直断流"]);
  assert.deepEqual(brief(classifyFailure({ text: "随便一句", userStopped: true })), ["user_stopped", "Permanent", "never", "已停止"]);
});

test("认不出的失败记 unknown 并原样保留原文,不硬塞别的类(AC-43 ⑬);空原文也是 unknown", () => {
  const raw = "something odd happened: frobnicator out of phase (code=7)";
  const u = classifyFailure({ text: raw });
  assert.equal(u.reasonClass, "unknown");
  assert.equal(u.raw, raw);
  assert.equal(u.label, "未识别的失败");
  assert.equal(u.retryClass, "UnknownEffect");
  assert.equal(u.autoRerunCap, 1, "按 AC-36 低上限兜底");
  assert.equal(u.via, "none");
  const empty = classifyFailure({ text: "" });
  assert.equal(empty.reasonClass, "unknown");
  assert.equal(empty.raw, "");
  // harness 自报的 kind=unknown 不算结构化依据,也不把原文认不出的硬归到别处
  assert.equal(classifyFailure({ text: raw, kind: "unknown" }).reasonClass, "unknown");
  assert.equal(classifyFailure({ text: raw, kind: "weird_kind" }).reasonClass, "unknown");
});

test("重放 2734 号截图那次:Prompt is too long · automatic compaction failed 记 context_overflow,harness 报 invalid_request/400 也不改(AC-43 ⑭)", () => {
  const raw = "Couldn't finish: Prompt is too long · automatic compaction failed: no assistant message in summarization response";
  for (const input of [{ text: raw }, { text: raw, kind: "invalid_request" }, { text: raw, httpStatus: 400, kind: "invalid_request" }, { text: "automatic compaction failed" }]) {
    const c = classifyFailure(input);
    assert.equal(c.reasonClass, "context_overflow", JSON.stringify(input));
    assert.equal(c.autoRerun, "new_session_only", "不在原会话自动继续");
    assert.equal(c.failFast, true, "确定不会自愈:不等阈值");
    assert.equal(c.raw, input.text);
  }
});

test("用户指定的几类:cyber_policy 平台拒绝、403 额度不足 Permanent、502 EOF 瞬态、429 限流瞬态、用户停止 never", () => {
  assert.equal(classifyFailure({ text: "400 cyber_policy violation", httpStatus: 400 }).reasonClass, "platform_refused");
  const quota = classifyFailure({ text: "403 Insufficient user quota", httpStatus: 403 });
  assert.deepEqual([quota.reasonClass, quota.retryClass, quota.autoRerun], ["auth_or_quota", "Permanent", "never"]);
  assert.deepEqual(brief(classifyFailure({ text: "Insufficient user quota" })).slice(0, 2), ["auth_or_quota", "Permanent"]);
  const eof = "stream disconnected before completion: error sending request: EOF (502: you can retry your request)";
  for (const input of [{ text: eof }, { text: eof, httpStatus: 502 }]) {
    const c = classifyFailure(input);
    assert.ok(c.reasonClass === "upstream_unavailable" || c.reasonClass === "stream_dropped", c.reasonClass);
    assert.equal(c.retryClass, "Transient");
  }
  const rl = classifyFailure({ text: "slow down", httpStatus: 429 });
  assert.deepEqual([rl.reasonClass, rl.retryClass, rl.autoRerun], ["rate_limited", "Transient", "backoff"]);
  const stop = classifyFailure({ text: "", userStopped: true });
  assert.deepEqual([stop.reasonClass, stop.autoRerun], ["user_stopped", "never"]);
});

test("断流与用户停止不记成同一个原因(AC-43 坏实现 ②)", () => {
  const dropped = classifyFailure({ text: "stream disconnected before completion" });
  const stopped = classifyFailure({ text: "stream disconnected before completion", userStopped: true });
  assert.equal(dropped.reasonClass, "stream_dropped");
  assert.equal(stopped.reasonClass, "user_stopped");
  assert.notEqual(dropped.label, stopped.label);
  assert.notEqual(dropped.autoRerun, stopped.autoRerun);
});

test("结构化字段优先于原文:用户停止 > 卡死判定 > HTTP 状态 > harness kind > 原文", () => {
  assert.equal(classifyFailure({ text: "API Error: 429", userStopped: true, stall: "stalled" }).via, "userStopped");
  const s = classifyFailure({ text: "API Error: 401 unauthorized", stall: "no_response", httpStatus: 401 });
  assert.deepEqual([s.reasonClass, s.via], ["no_response", "stall"]);
  const h = classifyFailure({ text: "upstream overloaded", httpStatus: 429 });
  assert.deepEqual([h.reasonClass, h.via], ["rate_limited", "httpStatus"]);
  assert.equal(classifyFailure({ text: "x", httpStatus: 503 }).reasonClass, "upstream_unavailable");
  assert.equal(classifyFailure({ text: "x", httpStatus: 401 }).reasonClass, "auth_or_quota");
  assert.equal(classifyFailure({ text: "x", httpStatus: 404 }).reasonClass, "invalid_request");
  const k = classifyFailure({ text: "Overloaded", kind: "rate_limit_error" });
  assert.deepEqual([k.reasonClass, k.via], ["rate_limited", "kind"]);
  assert.equal(classifyFailure({ text: "x", kind: "authentication_error" }).reasonClass, "auth_or_quota");
  // 结构化只给笼统类(404 / invalid_request)时,原文命中更具体的会话丢失用具体类
  assert.equal(classifyFailure({ text: "No conversation found with session ID: 9", httpStatus: 404 }).reasonClass, "session_lost");
  // 笼统类不能被不具体的原文改写:400 + 「overloaded」仍是请求无效
  assert.equal(classifyFailure({ text: "overloaded", httpStatus: 400 }).reasonClass, "invalid_request");
  // 原文判据:真正的原文命中记 via=text 和命中的规则
  const t = classifyFailure({ text: "Prompt is too long" });
  assert.equal(t.via, "text");
  assert.match(t.pattern ?? "", /prompt is too long/i);
});

test("Compute 适配器的失败说明:stderr 里有上游原因按上游原因归类,只有退出码才算执行器崩溃", () => {
  assert.equal(classifyFailure({ text: "进程以 1 退出:API Error: 403 Insufficient user quota" }).reasonClass, "auth_or_quota");
  assert.equal(classifyFailure({ text: "进程以 1 退出:Prompt is too long" }).reasonClass, "context_overflow");
  assert.equal(classifyFailure({ text: "进程被信号 SIGKILL 结束" }).reasonClass, "harness_crashed");
  assert.equal(classifyFailure({ text: "CLI 没有给出结束结果" }).reasonClass, "harness_crashed");
});

test("规则表带版本号且冻结:每次归类带同一个版本号,表与常量改不动", () => {
  const c = classifyFailure({ text: "API Error: 429" });
  assert.equal(c.rulesVersion, FAILURE_RULES_VERSION);
  assert.match(FAILURE_RULES_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.ok(Object.isFrozen(FAILURE_RULES) && FAILURE_RULES.length > 0 && FAILURE_RULES.every((r) => Object.isFrozen(r) && Object.isFrozen(r.patterns)));
  assert.ok(Object.isFrozen(REASON_CLASSES) && Object.isFrozen(REASON_TABLE));
  assert.ok(REASON_CLASSES.every((k) => Object.isFrozen(REASON_TABLE[k])));
  assert.equal(REASON_CLASSES.length, 13, "第 8.4 节 13 类");
  assert.throws(() => (FAILURE_RULES as unknown as unknown[]).push({}), TypeError);
  assert.throws(() => {
    (REASON_TABLE.unknown as { label: string }).label = "改掉";
  }, TypeError);
  assert.ok(Object.isFrozen(c), "归类结果冻结");
  assert.equal(classifyFailure({ text: "API Error: 429" }).reasonClass, "rate_limited");
});

test("每一类在表里都有人话标签、修法与 retry_class;不会自愈的几类标 failFast,同一上游连续失败则停的几类标 sameUpstreamStop", () => {
  const fast = REASON_CLASSES.filter((k) => REASON_TABLE[k].failFast).sort();
  assert.deepEqual(fast, ["auth_or_quota", "context_overflow", "invalid_request", "platform_refused", "session_lost"]);
  const same = REASON_CLASSES.filter((k) => REASON_TABLE[k].sameUpstreamStop).sort();
  assert.deepEqual(same, ["no_response", "stream_dropped", "upstream_unavailable"]);
  for (const k of REASON_CLASSES) {
    const info = REASON_TABLE[k];
    assert.ok(info.label && info.fix, k);
    const c = classifyFailure({ text: "", ...(k === "user_stopped" ? { userStopped: true } : {}), ...(k === "stalled" || k === "no_response" || k === "stream_dropped" ? { stall: k } : {}) });
    if (c.reasonClass === k) assert.deepEqual([c.label, c.retryClass, c.autoRerun, c.fix], [info.label, info.retryClass, info.autoRerun, info.fix]);
  }
  // 人停的不是失败的一类:画板文字和失败不同
  assert.notEqual(classifyFailure({ text: "", userStopped: true }).label, classifyFailure({ text: "" }).label);
});

test("原文很长也照样保留全文,只按开头一段匹配不影响归类", () => {
  const raw = `API Error: 429 rate limited ${"x".repeat(50_000)}`;
  const c = classifyFailure({ text: raw });
  assert.equal(c.reasonClass, "rate_limited");
  assert.equal(c.raw.length, raw.length);
});
