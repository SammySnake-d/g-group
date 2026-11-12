// New owning-boundary witnesses; none of the seven original CC tests is modified.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { createResidentComputeAdapter } from "./resident.ts";
import type { ComputeAdapter } from "./types.ts";
const brief = { task: "neutral cleanup fixture", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };
const live = (pid: number) => {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").some((l) => { const p = l.trim().split(/\s+/); return Number(p[0]) === pid && !p[1]?.startsWith("Z"); });
  } catch {
    const listed = spawnSync("pgrep", ["-fl", "."], { encoding: "utf8" });
    if (listed.status === 1) return false;
    if (listed.error || listed.status !== 0) throw new Error(`pid enumeration unavailable: ${listed.error?.message ?? listed.stderr}`);
    return listed.stdout.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === pid);
  }
};
async function started(adapter: ComputeAdapter, id: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => { for await (const e of adapter.events()) if (e.computeId === id && e.kind === "started") return; throw new Error("no started event"); })(),
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("start timed out")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function killOwn(pids: readonly number[]) {
  for (const pid of pids) if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
}

test("S-PROC-CC-01 AC-23: one-shot CC delegates captured setsid cleanup and refuses an unended round", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-cc-shared-"));
  const record = path.join(dir, "record.jsonl");
  const adapter = createComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: JSON.stringify({ reports: [{ kind: "started", summary: "neutral" }], hang: "graceful", grandchild: { marker: path.join(dir, "marker"), setsid: true, ignoreTerm: true } }), FAKE_RECORD: record }, reapForceMs: 30 });
  let id: string | undefined;
  let descendant: number | undefined;
  try {
    const result = await adapter.spawn(brief);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("spawn failed");
    id = result.computeId;
    await started(adapter, id);
    descendant = Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
    assert.equal((await adapter.quiesce!(id, 0)).ok, false);
    assert.equal((await adapter.stop(id)).ok, true);
    assert.equal((await adapter.quiesce!(id, 2000)).ok, true);
    assert.equal(live(descendant), false);
  } finally {
    try { if (id) { await adapter.stop(id); await adapter.quiesce!(id, 2000); } } finally {
      if (descendant === undefined && fs.existsSync(`${record}.grandchild.pid`)) descendant = Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
      const main = fs.existsSync(record) ? (JSON.parse(fs.readFileSync(record, "utf8").split("\n")[0]!) as { pid: number }).pid : undefined;
      killOwn([...(descendant ? [descendant] : []), ...(main ? [main] : [])]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("S-PROC-CC-02 AC-23: resident CC distinguishes a finished turn from shared actual all-exit confirmation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-ccr-shared-"));
  const pidFile = path.join(dir, "pids.json");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("../proof/resident-tree-fixture.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: "{}", FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PID_FILE: pidFile }, reapForceMs: 30 });
  let id: string | undefined;
  let pids: { main: number; descendant: number } | undefined;
  try {
    const result = await adapter.spawn(brief);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("spawn failed");
    id = result.computeId;
    await adapter.settled(id);
    pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { main: number; descendant: number };
    assert.equal((await adapter.quiesce!(id, Number.NaN)).ok, false);
    assert.equal((await adapter.quiesce!(id, 0)).ok, false);
    assert.equal(live(pids.main), true);
    assert.equal((await adapter.stop(id)).ok, true);
    assert.equal((await adapter.quiesce!(id, 2000)).ok, true);
    assert.equal(live(pids.main), false);
    assert.equal(live(pids.descendant), false);
  } finally {
    try { if (id) { await adapter.stop(id); await adapter.quiesce!(id, 2000); } } finally {
      if (!pids && fs.existsSync(pidFile)) pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { main: number; descendant: number };
      if (pids) killOwn([pids.main, pids.descendant]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
