import assert from "node:assert/strict";
import { test } from "node:test";
import * as legacy from "../src/procgroup.ts";
import * as shared from "@g-group/process-tools";
test("S-PROC-LEGACY-01 AC-23: every original CC procgroup runtime export is the shared function identity", () => {
  assert.deepEqual(Object.keys(legacy).sort(), ["IS_WINDOWS", "processTable", "signalGroup", "stillAlive", "treeByPgrep", "treeOf"].sort());
  for (const name of Object.keys(legacy)) assert.equal(legacy[name], shared[name], name);
  assert.deepEqual(legacy.processTable(() => "  42  1  42 S"), [{ pid: 42, ppid: 1, pgid: 42, stat: "S" }]);
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter } from "../src/resident.ts";
const alive = (pid) => execFileSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8" }).split("\n").some((l) => { const p = l.trim().split(/\s+/); return Number(p[0]) === pid && !p[1]?.startsWith("Z"); });
test("S-PROC-CC-RESIDENT-01 AC-23: CC resident uses shared all-exit confirmation, not its stopped request event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-resident-cleanup-"));
  const pidFile = path.join(dir, "pids.json");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("./resident-tree-fixture.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: "{}", FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PID_FILE: pidFile }, reapForceMs: 30 });
  let id; let pids;
  try {
    const result = await adapter.spawn({ task: "neutral fixture", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" });
    assert.equal(result.ok, true); id = result.computeId;
    await adapter.settled(id);
    pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    assert.equal(alive(pids.main), true);
    assert.equal((await adapter.quiesce(id, Number.NaN)).ok, false);
    assert.deepEqual(await adapter.quiesce(id, 0), { ok: true, killed: 0 }, "turn completion without stop keeps the resident process; nothing is killed");
    assert.equal(alive(pids.main), true);
    assert.equal((await adapter.stop(id)).ok, true);
    assert.equal((await adapter.quiesce(id, 2000)).ok, true);
    assert.equal(alive(pids.main), false);
    assert.equal(alive(pids.descendant), false);
  } finally {
    if (id) { await adapter.stop(id); await adapter.quiesce(id, 2000); }
    if (!pids && fs.existsSync(pidFile)) pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    for (const pid of [pids?.descendant, pids?.main]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
