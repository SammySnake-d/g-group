// AC-04 工件回传的合同增量(只增):artifacts.get、MessageView.artifacts、TaskView 文件工件的 sha256/bytes/mime。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParams, checkResult, formatIssues } from "./index.ts";

test("合同:artifacts.get 结果带 sha256 与路径;消息 artifacts 与任务文件工件的 sha256 可选,带上时按 64 位小写十六进制校验", () => {
  const h = "a".repeat(64);
  assert.equal(checkParams("artifacts.get", { ref: "art-x.md" }).ok, true);
  const noRef = checkParams("artifacts.get", {});
  assert.equal(noRef.ok ? "" : formatIssues(noRef.issues), "ref: 缺少必填字段");
  const good = { ref: "art-x.md", name: "x.md", mime: "text/markdown", bytes: 3, sha256: h, path: "/d/x.md", text: "abc" };
  assert.ok(checkResult("artifacts.get", good).ok);
  assert.ok(checkResult("artifacts.get", { ...good, text: null }).ok);
  const upper = checkResult("artifacts.get", { ...good, sha256: "A".repeat(64) });
  assert.equal(upper.ok ? "" : formatIssues(upper.issues), "sha256: 格式不符 ^[0-9a-f]{64}$", "大写十六进制不认");
  const base = { id: "t1", title: "x", roomId: "r1", sourceSeq: 1, requesterId: "me", ownerContactId: "c1", state: "T5_InReview", constraintVersion: 0, pendingQuestion: null, reviewGate: "none", computeRuns: [], recentProgress: [], createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z" };
  assert.ok(checkResult("tasks.get", { ...base, artifacts: [{ ref: "task:t1/result", name: "结果", kind: "text" }] }).ok, "旧形状仍合法");
  const withFile = checkResult("tasks.get", { ...base, artifacts: [{ ref: "art-x.md", name: "x.md", kind: "file", sha256: h, bytes: 3, mime: "text/markdown" }] });
  assert.ok(withFile.ok);
  assert.equal((withFile.value as { artifacts: { sha256?: string }[] }).artifacts[0]!.sha256, h);
  assert.equal(checkResult("tasks.get", { ...base, artifacts: [{ ref: "art-x.md", name: "x.md", kind: "file", sha256: "zz" }] }).ok, false);
  const msg = { roomId: "r1", seq: 3, threadRootSeq: null, sender: { kind: "contact", id: "c1" }, text: "做完了", mentions: [], replyToSeq: null, quotedSeqs: [], quotes: [], attachments: [], command: null, reactions: [], edited: false, retracted: false, clientActionId: null, at: "2026-11-09T00:00:00Z" };
  assert.ok(checkResult("messages.list", { messages: [{ ...msg, card: null }], hasMore: false }).ok, "不带 artifacts 的消息仍合法");
  const withArts = checkResult("messages.list", { messages: [{ ...msg, card: null, artifacts: [{ ref: "art-x.md", name: "x.md", mime: "text/markdown", bytes: 3, sha256: h }] }], hasMore: false });
  assert.ok(withArts.ok);
  assert.equal((withArts.value as { messages: { artifacts: { sha256: string }[] }[] }).messages[0]!.artifacts[0]!.sha256, h);
  assert.equal(checkResult("messages.list", { messages: [{ ...msg, card: null, artifacts: [{ ref: "art-x.md", name: "x.md", mime: "text/markdown", bytes: 3 }] }], hasMore: false }).ok, false);
});
