// T-177 G3/G5 integration: both write paths retrieve their visible memory neighborhood through the BC seam.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { MemoryEntry, RefineRequest, ReflectRequest } from "@g-group/kernel";
import { Host } from "./host.ts";
import { MemoryStore } from "./memory-store.ts";

const NEEDLE = "NEIGHBOR_MATCH_NEEDLE";
const empty = () => ({ note: null, memories: [], personaSuggestion: null });
async function until(ready: () => boolean) {
  const end = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > end) throw new Error("write-neighborhood request was not observed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-write-neighbors-"));
  const coarse: ReflectRequest[] = [];
  const fine: RefineRequest[] = [];
  const host = new Host({
    file: path.join(dir, "db.sqlite"), dataDir: dir, maxDeferMs: 2,
    fineScreen: { quietMs: 5 }, historyPrefetch: false,
    mind: () => ({ async round() { return { actions: [], stateNote: "MAIN" }; } }),
    compactor: () => ({
      async compact() { return "MAIN"; },
      async reflect(request) {
        coarse.push(request);
        return { ...empty(), marks: request.sources.filter((source) => source.senderKind === "user" && source.text.includes(NEEDLE)).map((source) => ({ roomId: source.roomId, seq: source.seq, kind: "fact" as const, evidence: NEEDLE })) };
      },
      async refine(request) { fine.push(request); return { memories: [] }; },
    }),
  });
  t.after(async () => { await host.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const contact = host.createContact({ name: "fixture", speakingModel: "fixture-model" });
  const room = host.openDm(contact.id);
  const store = new MemoryStore(host.db, path.join(dir, "memory"), () => {});
  function seed(id: string, body: string, anchors: readonly string[], extra: Partial<MemoryEntry> = {}, owner = contact.id) {
    const now = "2026-01-01T00:00:00.000Z";
    store.put(owner, { id, version: 1, status: "active", title: body, body, anchors, validFrom: null, validTo: null, source: null, supersedes: [], supersededBy: null, refines: [], conflictsWith: [], derivedFrom: [], evidence: [], uses: [], createdAt: now, updatedAt: now, ...extra });
  }
  async function request() {
    host.send({ roomId: room.id, clientActionId: "lookup", text: NEEDLE });
    await until(() => coarse.length > 0 && fine.length > 0);
    await host.idle();
    return { coarse: coarse[0]!.neighbors, fine: fine[0]!.neighbors };
  }
  return { host, contact, room, seed, request };
}

test("G35-01 coarse and fine use the query, preserve global/degraded hits and stable tied order", async (t) => {
  const s = setup(t);
  s.seed("m-0", "BANANA_UNRELATED", [`room:${s.room.id}`]);
  s.seed("m-a", NEEDLE, ["global"]);
  s.seed("m-z", NEEDLE, [`room:${s.room.id}`], { status: "degraded", createdAt: "2025-01-01T00:00:00.000Z" });
  const requests = await s.request();
  for (const [stage, neighbors] of Object.entries(requests)) {
    assert.deepEqual(neighbors.map((n) => n.id), ["m-a", "m-z"], `${stage}: only hybrid matches, in stable tie order`);
    assert.deepEqual(neighbors.map((n) => n.body), [NEEDLE, NEEDLE], `${stage}: preserve matched bodies`);
  }
});

test("G35-02 a query with no matching memory gives both write paths an empty neighborhood", async (t) => {
  const s = setup(t);
  s.seed("m-unrelated", "BANANA_UNRELATED", ["global"]);
  const requests = await s.request();
  assert.deepEqual(requests.coarse, [], "coarse: no full-library fallback");
  assert.deepEqual(requests.fine, [], "fine: no full-library fallback");
});

test("G35-03 both write paths keep contact, room, status and persona boundaries before retrieval", async (t) => {
  const s = setup(t);
  const other = s.host.createContact({ name: "other", speakingModel: "fixture-model" });
  s.seed("m-unrelated", "BANANA_UNRELATED", [`room:${s.room.id}`]);
  s.seed("m-visible", NEEDLE, [`room:${s.room.id}`]);
  s.seed("m-room", NEEDLE, ["room:unrelated-room"]);
  s.seed("m-revoked", NEEDLE, ["global"], { status: "revoked" });
  s.seed("m-superseded", NEEDLE, ["global"], { status: "superseded" });
  s.seed("m-persona", NEEDLE, ["global", "persona-suggestion"]);
  s.seed("m-other", NEEDLE, ["global"], {}, other.id);
  const requests = await s.request();
  assert.deepEqual(requests.coarse.map((n) => n.id), ["m-visible"], "coarse: only this contact's visible matching memory");
  assert.deepEqual(requests.fine.map((n) => n.id), ["m-visible"], "fine: only this contact's visible matching memory");
});
