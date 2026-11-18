import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { MemoryEntry, ReflectRequest } from "@g-group/kernel";
import { Host } from "./host.ts";
function setup(t: TestContext, HostClass: typeof Host) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1a-neighbors-"));
  const requests: ReflectRequest[] = [];
  const host = new HostClass({ file: path.join(dir, "db"), dataDir: dir, maxDeferMs: 1,
    mind: () => ({ async round() { return { actions: [], stateNote: "note" }; } }),
    compactor: () => ({ async compact() { return "note"; }, async reflect(r) { requests.push(r); return { note: null, memories: [], personaSuggestion: null }; } }),
  });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });
  const c = host.createContact({ name: "c" }), room = host.openDm(c.id);
  const seed = (id: string, title: string, body: string, extra: Partial<MemoryEntry> = {}, owner = c.id) => {
    host.memory.put(owner, { id, title, body, status: "active", version: 1, anchors: [`room:${room.id}`], source: null, validFrom: null, validTo: null, supersedes: [], supersededBy: null, refines: [], conflictsWith: [], derivedFrom: [], evidence: [], uses: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra });
  };
  return { host, c, room, seed, requests };
}
test("T95-R1-01 title-only retrieval preserves distinct id title body (C95-02 C95-03)", (t) => {
  const s = setup(t, Host); s.seed("m-title", "quartzneedle", "紫罗兰花期");
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: "quartzneedle" }), [{ id: "m-title", title: "quartzneedle", body: "紫罗兰花期" }]);
});
test("T95-R1-01 body-only retrieval preserves distinct id title body (C95-01)", (t) => {
  const s = setup(t, Host); s.seed("m-body", "紫罗兰花期", "quartzneedle");
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: "quartzneedle" }), [{ id: "m-body", title: "紫罗兰花期", body: "quartzneedle" }]);
});
test("T95-R1-02 five neighbors survive intact ordered by lexical id for equal relevance (C95-04)", (t) => {
  const s = setup(t, Host); for (const id of ["m-e", "m-c", "m-b", "m-d", "m-a"]) s.seed(id, "quartzneedle", "same body");
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: `quartzneedle` }).map(x => x.id), ["m-a", "m-b", "m-c", "m-d", "m-e"]);
});
test("T95-R1-03 relevance DESC opposes lexical ID ASC (C95-05)", (t) => {
  const s = setup(t, Host); s.seed("m-a", "gardening", `quartzneedle ${"violet garden water ".repeat(100)}`); s.seed("m-z", "quartzneedle", "quartzneedle");
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: "quartzneedle" }).map(x => x.id), ["m-z", "m-a"]);
});
test("G35 contact status persona room and validity hard filters precede retrieval", (t) => {
  const s = setup(t, Host); const other = s.host.createContact({ name: "other" });
  s.seed("m-good", "quartzneedle", "body", { anchors: ["global"], status: "degraded" });
  s.seed("m-other", "quartzneedle", "body", {}, other.id);
  s.seed("m-room", "quartzneedle", "body", { anchors: ["room:other"] });
  s.seed("m-persona", "quartzneedle", "body", { anchors: ["global", "persona-suggestion"] });
  s.seed("m-revoked", "quartzneedle", "body", { status: "revoked" });
  s.seed("m-expired", "quartzneedle", "body", { validTo: "2000-01-01T00:00:00.000Z" });
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: "quartzneedle" }).map(x => x.id), ["m-good"]);
  assert.deepEqual(s.host.memoryNeighbors(s.c.id, { rooms: [s.room.id], text: " " }), []);
});
test("G35 single-stage reflect actually receives retrieved title/body neighborhood", async (t) => {
  const s = setup(t, Host); s.seed("m-r", "violet", "quartzneedle");
  s.host.send({ roomId: s.room.id, clientActionId: "q", text: "quartzneedle" });
  const end = Date.now() + 2000;
  while (!s.requests.length && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  await s.host.idle();
  assert.deepEqual(s.requests[0]?.neighbors, [{ id: "m-r", title: "violet", body: "quartzneedle" }]);
});
