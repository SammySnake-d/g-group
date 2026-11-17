// 搜索与跳转的合同(AC-25):search.messages 的参数与结果、messages.list 的 aroundSeq / hasMoreAfter 增量字段。
// 只验合同本身的判别力;宿主侧行为在 packages/server/src/search.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParams, checkResult, formatIssues } from "./index.ts";

const AT = "2026-11-09T01:40:00+08:00";

test("search.messages:query 必填且非空,roomId/cursor/limit 可选;结果每条必须带 roomId 与 seq", () => {
  const good = checkParams("search.messages", { query: "限流", roomId: "g1", cursor: null, limit: 20, extra: "丢弃" });
  assert.ok(good.ok, good.ok ? "" : formatIssues(good.issues));
  assert.deepEqual(good.value, { query: "限流", roomId: "g1", cursor: null, limit: 20 });
  const noQuery = checkParams("search.messages", { roomId: "g1" });
  assert.equal(noQuery.ok, false);
  assert.deepEqual(noQuery.ok ? [] : noQuery.issues.map((i) => i.path), ["query"]);
  assert.equal(formatIssues(noQuery.ok ? [] : noQuery.issues), "query: 缺少必填字段");
  assert.equal(checkParams("search.messages", { query: "" }).ok, false);
  assert.equal(checkParams("search.messages", { query: "x", limit: 101 }).ok, false);
  const hit = {
    roomId: "g1", roomTitle: "登录组", seq: 12, threadRootSeq: null, sender: { kind: "user", id: "me" }, senderName: "我",
    snippet: "…接口限流阈值…", highlights: [{ start: 3, length: 2 }], matchedIn: "text", attachmentName: null, at: AT,
  };
  const res = checkResult("search.messages", { hits: [hit], nextCursor: "abc" });
  assert.ok(res.ok, res.ok ? "" : formatIssues(res.issues));
  assert.deepEqual(res.value, { hits: [hit], nextCursor: "abc" });
  const { seq: _seq, ...noSeq } = hit;
  const bad = checkResult("search.messages", { hits: [noSeq], nextCursor: null });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.issues.map((i) => i.path), ["hits[0].seq"]);
  assert.equal(checkResult("search.messages", { hits: [{ ...hit, matchedIn: "title" }], nextCursor: null }).ok, false);
});

test("messages.list:aroundSeq 为可选非负序号,结果可带 hasMoreAfter", () => {
  const r = checkParams("messages.list", { roomId: "g1", aroundSeq: 12, limit: 30 });
  assert.ok(r.ok, r.ok ? "" : formatIssues(r.issues));
  assert.deepEqual(r.value, { roomId: "g1", aroundSeq: 12, limit: 30 });
  assert.equal(checkParams("messages.list", { roomId: "g1", aroundSeq: -1 }).ok, false);
  const res = checkResult("messages.list", { messages: [], hasMore: true, hasMoreAfter: false });
  assert.ok(res.ok);
  assert.deepEqual(res.value, { messages: [], hasMore: true, hasMoreAfter: false });
});
