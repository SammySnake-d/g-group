// AC-22 代码任务工作树的合同增量(只增):tasks.integrate 与可选的 TaskView.workspace。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParams, checkResult, formatIssues } from "./index.ts";

test("合同:tasks.integrate 参数要 taskId 与 clientActionId;TaskView.workspace 可选,带上时按 W2–W6 校验", () => {
  assert.equal(checkParams("tasks.integrate", { taskId: "t1", clientActionId: "a1" }).ok, true);
  const missing = checkParams("tasks.integrate", { taskId: "t1" });
  assert.equal(missing.ok ? "" : formatIssues(missing.issues), "clientActionId: 缺少必填字段");
  const base = { id: "t1", title: "x", roomId: "r1", sourceSeq: 1, requesterId: "me", ownerContactId: "c1", state: "T8_Accepted", constraintVersion: 0, pendingQuestion: null, reviewGate: "waived-by-user", computeRuns: [], recentProgress: [], artifacts: [], createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z" };
  assert.equal(checkResult("tasks.get", base).ok, true, "不带 workspace 的旧形状仍合法");
  const ws = { dir: "/w", branch: "gg/task-t1", targetBranch: "main", baseSha: "a".repeat(40), candidateSha: "b".repeat(40), state: "W6_Merged", targetHead: "a".repeat(40), verifiedOn: null, mergedSha: "b".repeat(40), conflict: null };
  const ok = checkResult("tasks.integrate", { ...base, workspace: ws });
  assert.ok(ok.ok);
  assert.deepEqual((ok.value as { workspace: unknown }).workspace, ws);
  const badState = checkResult("tasks.integrate", { ...base, workspace: { ...ws, state: "merged" } });
  assert.equal(badState.ok ? "" : formatIssues(badState.issues), "workspace.state: 应为 W2_Active | W3_Pinned | W4_Integrating | W5_Conflict | W6_Merged 之一", "点名是哪个字段、允许哪些状态");
  assert.equal(checkResult("tasks.integrate", { ...base, workspace: { ...ws, conflict: { kind: "other", detail: "" } } }).ok, false);
});
