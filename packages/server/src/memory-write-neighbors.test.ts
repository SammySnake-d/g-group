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
function setup(t: TestContext, HostClass: typeof Host) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-write-neighbors-"));
  const coarse: ReflectRequest[] = [];
  const fine: RefineRequest[] = [];
  const host = new HostClass({
    file: path.join(dir, "db.sqlite"), dataDir: dir, maxDeferMs: 2,
    fineScreen: { quietMs: 5 },
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
  const s = setup(t, Host);
  s.seed("m-0", "紫罗兰花期", [`room:${s.room.id}`]);
  s.seed("m-a", NEEDLE, ["global"]);
  s.seed("m-z", NEEDLE, [`room:${s.room.id}`], { status: "degraded", createdAt: "2025-01-01T00:00:00.000Z" });
  const requests = await s.request();
  for (const stage of ["coarse", "fine"] as const) {
    const neighbors = requests[stage];
    assert.deepEqual(neighbors.map((n) => n.id), ["m-a", "m-z"], `${stage}: only hybrid matches, in stable tie order`);
    assert.deepEqual(neighbors.map((n) => n.body), [NEEDLE, NEEDLE], `${stage}: preserve matched bodies`);
  }
});

test("G35-02 a query with no matching memory gives both write paths an empty neighborhood", async (t) => {
  const s = setup(t, Host);
  s.seed("m-unrelated", "紫罗兰花期", ["global"]);
  const requests = await s.request();
  assert.deepEqual(requests.coarse, [], "coarse: no full-library fallback");
  assert.deepEqual(requests.fine, [], "fine: no full-library fallback");
});

test("G35-03 both write paths keep contact, room, status and persona boundaries before retrieval", async (t) => {
  const s = setup(t, Host);
  const other = s.host.createContact({ name: "other", speakingModel: "fixture-model" });
  s.seed("m-unrelated", "紫罗兰花期", [`room:${s.room.id}`]);
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

test("G35-R1-01 coarse and fine retrieve a query found only in the body", async (t) => {
  const s = setup(t, Host);
  s.seed("m-body", `正文 ${NEEDLE}`, ["global"], { title: "与查询不同的标题" });
  const requests = await s.request();
  for (const stage of ["coarse", "fine"] as const) {
    assert.deepEqual(requests[stage], [{ id: "m-body", title: "与查询不同的标题", body: `正文 ${NEEDLE}` }], `${stage}: body-only hit and all returned fields`);
  }
});

test("G35-R1-02 coarse and fine retrieve a query found only in the title", async (t) => {
  const s = setup(t, Host);
  s.seed("m-title", "与查询不同的正文", ["global"], { title: `标题 ${NEEDLE}` });
  const requests = await s.request();
  for (const stage of ["coarse", "fine"] as const) {
    assert.deepEqual(requests[stage], [{ id: "m-title", title: `标题 ${NEEDLE}`, body: "与查询不同的正文" }], `${stage}: title-only hit and all returned fields`);
  }
});

test("G35-R1-03 coarse and fine return the entire distinct title and body", async (t) => {
  const s = setup(t, Host);
  const title = `标题 ${NEEDLE} 完整末尾`;
  const body = `正文开头 ${NEEDLE}\n正文完整末尾`;
  s.seed("m-fields", body, ["global"], { title });
  const requests = await s.request();
  for (const stage of ["coarse", "fine"] as const) {
    assert.deepEqual(requests[stage], [{ id: "m-fields", title, body }], `${stage}: distinct title and body preserved`);
  }
});

test("G35-R1-04 coarse and fine return every one of five matching memories", async (t) => {
  const s = setup(t, Host);
  for (const id of ["m-e", "m-c", "m-a", "m-d", "m-b"]) s.seed(id, NEEDLE, ["global"]);
  const requests = await s.request();
  const expected = ["m-a", "m-b", "m-c", "m-d", "m-e"].map((id) => ({ id, title: NEEDLE, body: NEEDLE }));
  for (const stage of ["coarse", "fine"] as const) {
    assert.deepEqual(requests[stage], expected, `${stage}: no unrequested two-item truncation`);
  }
});

test("G35-R1-05 coarse and fine rank a higher-scoring hit before lower id", async (t) => {
  const s = setup(t, Host);
  s.seed("m-a", "plain", ["global"], { title: NEEDLE });
  s.seed("m-z", NEEDLE, ["global"], { title: NEEDLE });
  const requests = await s.request();
  const expected = [
    { id: "m-z", title: NEEDLE, body: NEEDLE },
    { id: "m-a", title: NEEDLE, body: "plain" },
  ];
  for (const stage of ["coarse", "fine"] as const) {
    assert.deepEqual(requests[stage], expected, `${stage}: score outranks id; expected values are fixed`);
  }
});
