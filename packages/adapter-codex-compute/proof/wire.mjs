// Deterministic D-layer native-wire proof. No model or real Codex binary is contacted.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexComputeAdapter } from "../src/adapter.ts";
const root = mkdtempSync(path.join(tmpdir(), "p1b-adapter-proof-"));
const fixture = path.resolve(import.meta.dirname, "../test-support/native-wire.mjs");
const adapter = createCodexComputeAdapter({ runner: { command: process.execPath, args: [fixture] }, dataDir: root, timeoutMs: 1000, reapForceMs: 250 });
const brief = { task: "neutral owned fixture", rules: ["owner developer rule"], tools: [], credentialRefs: [], placement: "local" };
let id;
try {
  const r = await adapter.spawn(brief, { cwd: root, model: "probe-A", effort: "low" });
  assert.equal(r.ok, true);
  id = r.computeId;
  const events = await adapter.settled(id);
  assert.deepEqual(events.map(e => e.kind), ["started", "completed"]);
  const home = r.manifest.configDir;
  assert.equal(home.startsWith(root + path.sep), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "fixture-env.json"), "utf8")), { home: process.env.HOME, codexHome: home });
  assert.deepEqual(await adapter.resume(id, "switch model in same thread", { model: "probe-B", effort: "high" }), { ok: true });
  assert.equal((await adapter.settled(id)).at(-1).kind, "completed");
  assert.equal((await adapter.quiesce(id, 1000)).ok, true);
  assert.deepEqual(await adapter.resume(id, "resume same native thread", { model: "probe-A", effort: "low" }), { ok: true });
  assert.equal((await adapter.settled(id)).at(-1).kind, "completed");
  const requests = readFileSync(path.join(home, "wire-requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(r => r.method === "thread/start").length, 1);
  assert.equal(requests.filter(r => r.method === "thread/resume").length, 1);
  assert.deepEqual(requests.filter(r => r.method === "turn/start").map(r => [r.params.model, r.params.effort]), [["probe-A", "low"], ["probe-B", "high"], ["probe-A", "low"]]);
  assert.equal(requests.filter(r => r.method === "turn/start").some(r => JSON.stringify(r).includes("owner developer rule")), false);
  assert.equal((await adapter.stop(id)).ok, true);
  assert.equal((await adapter.quiesce(id, 1000)).ok, true);
  console.log("P1B wire adapter: isolated home, model override, native resume continuity, stop and confirmed cleanup passed");
} finally {
  if (id) { await adapter.stop(id); await adapter.quiesce(id, 1000); }
  rmSync(root, { recursive: true, force: true });
}
