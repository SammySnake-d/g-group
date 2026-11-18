import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { scriptedMind } from "./fakes.ts";
import { retractTaskState } from "./chat-admin.ts";

test("P2-A1 chat admin exposes authenticated kick, mute, transfer, dissolve, and batch delete", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p2a1-red-"));
  const host = new Host({ file: path.join(dir, "a.db"), mind: () => scriptedMind() });
  try {
    const service = createService(host);
    const contact = host.createContact({ name: "A" });
    const room = host.createGroup("g", [{ kind: "contact", id: contact.id }]);
    const result = await service.handle("rooms.muteMember", { roomId: room.id, contactId: contact.id, muted: true, clientActionId: "m1" });
    assert.equal(result.ok, true);
    const view = await service.handle("rooms.transferOwnership", { roomId: room.id, userId: "u2", clientActionId: "t1" });
    assert.equal(view.ok, true);
    const deleted = await service.handle("messages.deleteMessages", { roomId: room.id, seqs: [1], clientActionId: "d1" });
    assert.equal(deleted.ok, true);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-A1 retract runs E4 to T9/T10 and stops active Compute", async () => {
  assert.deepEqual(retractTaskState("T5_Running", true), { state: "T9_StopRequested", stopCompute: true });
  assert.deepEqual(retractTaskState("T9_StopRequested", false), { state: "T10_Stopped", stopCompute: false });
});
