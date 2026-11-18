import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import type { SpawnOptions } from "@g-group/kernel/compute";
import { createCodexComputeAdapter } from "./adapter.ts";

function fixture(t: TestContext, createAdapter: typeof createCodexComputeAdapter, mode = "normal") {
  const root = mkdtempSync(path.join(tmpdir(), "gg-codex-adapter-"));
  const adapter = createAdapter({
    runner: { command: process.execPath, args: [path.resolve(import.meta.dirname, "../test-support/native-wire.mjs")] },
    hostEnv: { FIXTURE_MODE: mode },
    dataDir: root,
    timeoutMs: 1500,
    reapForceMs: 250,
  });
  const ids: string[] = [];
  t.after(async () => {
    try {
      for (const id of ids) await adapter.quiesce!(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  async function spawn(tools: string[] = [], opts: SpawnOptions = {}) {
    const result = await adapter.spawn({ task: "fixture task", rules: [], tools, credentialRefs: [], placement: "local" }, { cwd: root, model: "probe-A", ...opts });
    if (result.ok) ids.push(result.computeId);
    return result;
  }
  return { adapter, spawn };
}

function requests(home: string) {
  return readFileSync(path.join(home, "wire-requests.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: { sandbox?: string; threadId?: string; expectedTurnId?: string } });
}

test("P1B adapter snapshots only after quiescence", async (t) => {
  const { adapter, spawn } = fixture(t, createCodexComputeAdapter, "progress");
  const result = await spawn();
  assert.ok(result.ok);
  const id = result.computeId;
  assert.equal((await adapter.settled(id)).at(-1)?.kind, "completed");
  assert.deepEqual(adapter.snapshot(id), { ok: false, reason: "not-quiescent" });
  assert.equal((await adapter.quiesce!(id)).ok, true);
  assert.deepEqual(adapter.snapshot(id), {
    ok: true,
    snapshot: { constraintVer: 0, openQuestions: [], doneSideEffects: ["structured native progress"] },
  });
});

test("P1B adapter refuses Claude plugin directories", async (t) => {
  const { spawn } = fixture(t, createCodexComputeAdapter);
  const result = await spawn([], { pluginDirs: ["/some/plugin"] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /plugin/i);
});

test("P1B adapter rejects partial tool lists and maps both supported sandbox scopes", async (t) => {
  const { adapter, spawn } = fixture(t, createCodexComputeAdapter);
  const partial = await spawn(["Read"]);
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /Codex cannot enforce this per-tool whitelist/);

  const result = await spawn();
  assert.ok(result.ok);
  const id = result.computeId;
  await adapter.settled(id);
  const refused = await adapter.resume(id, "partial", undefined, { tools: ["Read"] });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Codex cannot enforce this per-tool whitelist/);
  const full = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
  assert.deepEqual(await adapter.resume(id, "full", undefined, { tools: full }), { ok: true });
  assert.equal((await adapter.settled(id)).at(-1)?.kind, "completed");
  assert.deepEqual(await adapter.resume(id, "read-only again", undefined, { tools: [] }), { ok: true });
  assert.equal((await adapter.settled(id)).at(-1)?.kind, "completed");
  assert.deepEqual(
    requests(result.manifest.configDir!).filter((r) => r.method === "thread/start" || r.method === "thread/resume").map((r) => r.params.sandbox),
    ["read-only", "workspace-write", "read-only"],
  );

  const writable = await spawn(full);
  assert.ok(writable.ok);
  assert.equal(requests(writable.manifest.configDir!).find((r) => r.method === "thread/start")?.params.sandbox, "workspace-write");
});

test("P1B adapter resumes the same native thread across turns and stops once after completion", async (t) => {
  const { adapter, spawn } = fixture(t, createCodexComputeAdapter);
  const result = await spawn();
  assert.ok(result.ok);
  const id = result.computeId;
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "completed"]);
  assert.deepEqual(await adapter.resume(id, "next"), { ok: true });
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "completed"]);
  assert.equal((await adapter.quiesce!(id)).ok, true);
  assert.deepEqual(await adapter.resume(id, "reopen"), { ok: true });
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "completed"]);
  const wire = requests(result.manifest.configDir!);
  assert.equal(wire.filter((r) => r.method === "thread/start").length, 1);
  assert.deepEqual(wire.filter((r) => r.method === "thread/resume").map((r) => r.params.threadId), ["native-thread-1"]);
  assert.deepEqual(wire.filter((r) => r.method === "turn/start").map((r) => r.params.threadId), Array(3).fill("native-thread-1"));
  assert.deepEqual(await adapter.stop(id), { ok: true });
  assert.deepEqual(await adapter.stop(id), { ok: true });
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "completed", "stopped"]);
});

test("P1B adapter steers and interrupts each active turn with one stopped event", async (t) => {
  const { adapter, spawn } = fixture(t, createCodexComputeAdapter, "hold");
  const result = await spawn();
  assert.ok(result.ok);
  const id = result.computeId;
  assert.deepEqual(await adapter.steer!(id, "new direction"), { ok: true });
  assert.deepEqual(await adapter.stop(id), { ok: true });
  assert.deepEqual(await adapter.stop(id), { ok: true });
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "stopped"]);
  assert.deepEqual(await adapter.resume(id, "next"), { ok: true });
  assert.deepEqual(await adapter.stop(id), { ok: true });
  assert.deepEqual((await adapter.settled(id)).map((e) => e.kind), ["started", "stopped"]);
  const steer = requests(result.manifest.configDir!).find((r) => r.method === "turn/steer");
  assert.equal(steer?.params.threadId, "native-thread-1");
  assert.equal(steer.params.expectedTurnId, "native-turn-1");
});
