import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexComputeProtocol } from "./protocol.ts";
const fixture = path.resolve(import.meta.dirname, "../test-support/native-wire.mjs");
const homes: string[] = [];
function options(mode = "normal") {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-wire-test-")); homes.push(home);
  return { runner: { command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode } }, cwd: home, configDir: home, models: { "probe-A": ["low"], "probe-B": ["high"] }, timeoutMs: 500 };
}
test.after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

test("CXP-01 native initialize is acknowledged before initialized and first thread", async () => {
  const client = createCodexComputeProtocol(options());
  try {
    const initialized = await client.initialize();
    assert.equal(initialized.ok, true);
    if (!initialized.ok) throw new Error(initialized.reason);
    const thread = await client.startThread({ model: "probe-A", effort: "low" });
    assert.deepEqual(thread, { ok: true, value: { threadId: "native-thread-1" } });
  } finally { await client.quiesce(1000); }
});

test("CXP-02 native turn IDs and completed payload map to kernel ComputeEvent without a replacement loop", async () => {
  const client = createCodexComputeProtocol(options());
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    const turn = await client.startTurn("native-thread-1", "literal task", { model: "probe-A", effort: "low" });
    assert.deepEqual(turn, { ok: true, value: { turnId: "native-turn-1" } });
    const done = await client.settled("native-thread-1", "native-turn-1");
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "completed", result: "reply-native-turn-1" } });
  } finally { await client.quiesce(1000); }
});
