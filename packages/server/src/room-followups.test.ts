import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Host } from "./host.ts";

test("默认宿主保留独立群发言，不按短时间内的相同正文或条数截断", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-live-followups-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-20T00:00:20Z");
  const lines = Array.from({ length: 12 }, (_, n) => `第 ${n + 1} 项检查已完成`).concat("第 1 项检查已完成");
  const host = new Host({ file: path.join(dir, "gg.db"), clockMs: () => now, maxDeferMs: 5, mind: () => ({
    async round(input) {
      const trigger = input.fresh.find(row => row.kind === "schedule");
      return {
        actions: trigger ? lines.map(text => ({ kind: "reply", roomId: trigger.roomId, text, replyToSeq: null })) : [],
        stateNote: null,
      };
    },
  }) });
  t.after(() => host.close());
  const contact = host.createContact({ name: "值班联系人" });
  const room = host.createGroup("检查结果", [{ kind: "contact", id: contact.id }]);
  host.scheduler.create({ contactId: contact.id, roomId: room.id, title: "检查", cron: "* * * * *", tz: "UTC", prompt: "报告检查结果" });
  now = Date.parse("2026-11-20T00:01:00Z");
  host.scheduler.tick();
  await host.idle();
  const posted = host.listMessages(room.id, {}).messages.filter(row => row.sender.id === contact.id);
  assert.deepEqual(posted.map(row => row.text), lines);
  assert.equal(new Set(posted.map(row => row.seq)).size, lines.length);
});
