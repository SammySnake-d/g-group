// P1:撤销的共享文档不再出现在公开合同中。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEvent, isMethodName, METHOD_NAMES } from "./index.ts";

test("P1 合同没有 docs 方法", () => {
  assert.deepEqual(METHOD_NAMES.filter((name) => name.startsWith("docs.")), []);
  assert.equal(isMethodName("docs.list"), false);
  assert.equal(isMethodName("docs.get"), false);
  assert.equal(isMethodName("docs.create"), false);
  assert.equal(isMethodName("docs.commit"), false);
  assert.equal(isMethodName("docs.history"), false);
});

test("P1 合同拒绝 doc.updated 事件", () => {
  const r = checkEvent({ type: "doc.updated", eventSeq: 1, at: "2026-11-11T00:00:00Z", doc: {
    id: "d1", roomId: null, title: "中性样例", content: "", version: 1,
    createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", updatedBy: { kind: "user", id: "me" },
  } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.issues, [{ path: "type", message: "未知的 type: doc.updated" }]);
});
