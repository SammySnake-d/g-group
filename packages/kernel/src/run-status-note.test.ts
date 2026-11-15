import assert from "node:assert/strict";
import { test } from "node:test";
import { newRun, runDisplay, setStatus } from "./run-ledger.ts";

test("运行中单元保留本次等待原因，续跑后不会把旧完成原因当成新的提问", () => {
  const run = newRun({ id: "r", layer: "compute-session", parentId: null, roomId: "dm", sourceSeq: 1, contactId: "c", bootId: "boot", at: 0 });
  const completed = setStatus([run], run.id, "waiting_user", 1000, { note: "Compute 已完成,等交付与验收" });
  assert.ok(completed.ok);
  const waiting = completed.changed[0]!;
  assert.equal(waiting.note, "Compute 已完成,等交付与验收");
  assert.match(runDisplay(waiting, 2000).text, /Compute 已完成.*交付/);
  const resumed = setStatus([waiting], run.id, "running", 3000);
  assert.ok(resumed.ok);
  assert.equal(resumed.changed[0]!.note, null, "进入新一轮应清掉旧等待说明");
  const blocked = setStatus(resumed.changed, run.id, "waiting_user", 4000);
  assert.ok(blocked.ok);
  assert.equal(blocked.changed[0]!.note, null);
  assert.match(runDisplay(blocked.changed[0]!, 5000).text, /等你回答/, "真正受阻仍须提示等用户回答");
});
