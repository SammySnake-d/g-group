// AC-43 运行台账的接口合同(向后兼容增量):runs.list / runs.get / runs.rerun 三个方法与 run.updated 事件,
// 全景画板和联系人查询读同一张台账;失败单元带原因类别、原文、用时、最后进展与判定阈值,人停的与失败色调分开。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEvent, checkParams, checkResult, formatIssues, METHOD_NAMES } from "./index.ts";

const AT = "2026-11-09T02:00:00.000Z";
const failed = {
  id: "run-1",
  layer: "compute-session",
  parentId: "run-0",
  children: ["run-2"],
  roomId: "g1",
  sourceSeq: 3,
  contactId: "c1",
  taskId: "t-1",
  computeId: "cp-1",
  upstream: "claude-sonnet-4-6",
  status: "failed",
  tone: "failed",
  text: "失败 · 上游没回应 · 用时 2 分",
  reasonClass: "no_response",
  label: "上游没回应",
  raw: "模型调用发出后 121 秒没有任何回应(首字节窗口 120 秒,按默认值)",
  retryClass: "Transient",
  rulesVersion: "2026-11-09.1",
  note: null,
  startedAt: AT,
  endedAt: AT,
  durationMs: 121000,
  lastProgressAt: AT,
  thresholdMs: 120000,
  thresholdSource: "default",
  judgedAt: AT,
  waiting: null,
  idleMs: 0,
  rerunOf: null,
  attempt: 0,
  updatedAt: AT,
};

test("runs.list / runs.get / runs.rerun 在方法表里;状态只收七种之一,rerun 必须带 clientActionId,问题指出字段路径", () => {
  for (const m of ["runs.list", "runs.get", "runs.rerun"]) assert.ok((METHOD_NAMES as readonly string[]).includes(m), m);
  const ok = checkParams("runs.list", { roomId: "g1", statuses: ["running", "failed", "orphaned"], limit: 50 });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, { roomId: "g1", statuses: ["running", "failed", "orphaned"], limit: 50 });
  const bad = checkParams("runs.list", { statuses: ["stuck"] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.issues.map((i) => i.path), ["statuses[0]"]);
  const noKey = checkParams("runs.rerun", { runId: "run-1" });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.ok ? "" : formatIssues(noKey.issues), "clientActionId: 缺少必填字段");
  assert.equal(checkParams("runs.get", { runId: "run-1" }).ok, true);
});

test("RunView:原因类别、retry_class、色调只收固定枚举;失败单元的原文、用时、最后进展、判定阈值与来源原样通过", () => {
  const list = checkResult("runs.list", { runs: [failed], hints: [{ roomId: "g1", upstream: "claude-sonnet-4-6", reasonClass: "rate_limited", label: "被限流", runIds: ["run-1", "run-3"] }] });
  assert.ok(list.ok, list.ok ? "" : formatIssues(list.issues));
  assert.deepEqual(list.value, { runs: [failed], hints: [{ roomId: "g1", upstream: "claude-sonnet-4-6", reasonClass: "rate_limited", label: "被限流", runIds: ["run-1", "run-3"] }] });
  for (const [k, v] of [["reasonClass", "network"], ["retryClass", "Retry"], ["tone", "red"], ["status", "stuck"], ["layer", "thread"], ["thresholdSource", "room"]] as const) {
    const r = checkResult("runs.get", { run: { ...failed, [k]: v }, children: [], events: [] });
    assert.equal(r.ok, false, k);
    assert.ok(!r.ok && r.issues.some((i) => i.path.endsWith(k)), k);
  }
  const stopped = { ...failed, status: "interrupted", tone: "stopped", text: "已停止", reasonClass: "user_stopped", label: "已停止", retryClass: "Permanent" };
  const got = checkResult("runs.get", { run: stopped, children: [failed], events: [{ runId: "run-1", kind: "status", detail: { to: "interrupted" }, at: AT }] });
  assert.ok(got.ok, got.ok ? "" : formatIssues(got.issues));
  assert.equal(checkResult("runs.rerun", { runId: "run-1", mode: "new_session", taskId: "t-2", attempt: 1 }).ok, true);
  assert.equal(checkResult("runs.rerun", { runId: "run-1", mode: "continue", taskId: null, attempt: 1 }).ok, false);
});

test("run.updated 事件按 RunView 校验:缺字段或枚举越界被拒", () => {
  const ev = checkEvent({ type: "run.updated", eventSeq: 7, at: AT, run: failed });
  assert.ok(ev.ok, ev.ok ? "" : formatIssues(ev.issues));
  const { durationMs: _d, ...missing } = failed;
  const bad = checkEvent({ type: "run.updated", eventSeq: 8, at: AT, run: missing });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.issues.some((i) => i.path.endsWith("durationMs")));
});
