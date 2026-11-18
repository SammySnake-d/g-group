import assert from "node:assert/strict";
import test from "node:test";
import { roomBlockedSummary } from "./room-blocked-summary.ts";

test("P2-A1 summary orders by question message, counts extras, and preserves the 500-byte contract", () => {
  assert.equal(roomBlockedSummary([]), null);
  const first = roomBlockedSummary([
    { taskId: "later-task", seq: 20, text: "later" },
    { taskId: "first-task", seq: 10, text: "first" },
  ]);
  assert.equal(first, "等待你：first（另有 1 项）");

  const exact = roomBlockedSummary([{ taskId: "a", seq: 1, text: "x".repeat(494) }]);
  assert.ok(exact!.length <= 500);
  assert.equal(exact?.endsWith("…"), false);

  const long = roomBlockedSummary([
    { taskId: "a", seq: 1, text: "中".repeat(600) },
    { taskId: "b", seq: 2, text: "second" },
  ]);
  assert.equal(long?.length, 500);
  assert.equal(long?.endsWith("（另有 1 项）"), true);
  assert.equal([...long!].some((_, i) => long!.charCodeAt(i) >= 0xd800 && long!.charCodeAt(i) <= 0xdbff && !long!.charCodeAt(i + 1)), false);
});
