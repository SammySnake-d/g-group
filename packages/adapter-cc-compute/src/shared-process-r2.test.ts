// AC-23 R1-02/R1-03 (review round 1) at the CC owning boundary; none of the seven original CC test files is modified.
// Owned processes only: the fake CLIs and the children they leave are started by these tests and closed in finally.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { createResidentComputeAdapter } from "./resident.ts";

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
async function until(cond: () => boolean, what: string, ms = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const readPids = (log: string): { main: number; descendant: number }[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { main: number; descendant: number }) : []);
/** Last-resort cleanup of what this test started: each pid, and the group it leads (the fake CLI and its helper share one) */
function killOwn(pids: readonly number[]) {
  for (const pid of pids) if (pid > 1) for (const target of [-pid, pid]) { try { process.kill(target, "SIGKILL"); } catch { /* exited */ } }
}

test("S-PROC-CC-03 AC-23: resident stop confirms the leftovers of an idle-reclaimed process too, and a confirmed handle is dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-ccr-retired-"));
  const log = path.join(dir, "pids.jsonl");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("../test-support/resident-leaver.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: "{}", FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PIDS_LOG: log }, reapForceMs: 30, idleReclaimMs: 200 });
  let id: string | undefined;
  const originalPath = process.env.PATH;
  try {
    const result = await adapter.spawn(brief);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("spawn failed");
    id = result.computeId;
    await adapter.settled(id);
    const [retired] = readPids(log);
    if (!retired) throw new Error("first launch not recorded");
    await until(() => !live(retired.main), "idle reclaim ends the first process");
    assert.equal(live(retired.descendant), true, "reclaiming the idle process leaves its setsid child; confirmation is owed at stop");
    assert.deepEqual(await adapter.resume(id, "第二轮"), { ok: true });
    await until(() => readPids(log).length === 2, "the session resumes in a new process");
    await adapter.settled(id);
    assert.deepEqual(await adapter.stop(id), { ok: true });
    const stopped = await adapter.quiesce!(id, 3000);
    assert.equal(stopped.ok, true);
    const all = readPids(log);
    assert.deepEqual(all.flatMap((p) => [p.main, p.descendant]).map(live), [false, false, false, false], "both processes and both leftovers exited, including the reclaimed one's");
    process.env.PATH = "/g-group-no-command-fixture";
    const again = await adapter.quiesce!(id, 50);
    process.env.PATH = originalPath;
    assert.deepEqual(again, { ok: true, killed: 0 }, "confirmed handles were dropped: nothing left to enumerate, signal or count");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    try { if (id) { await adapter.stop(id); await adapter.quiesce!(id, 2000); } } finally {
      killOwn(readPids(log).flatMap((p) => [p.descendant, p.main]));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("S-PROC-CC-05 AC-23: resident stop confirmation waits for a CLI that ignores SIGTERM until the forced group kill ends it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-ccr-stubborn-"));
  const log = path.join(dir, "pids.jsonl");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("../test-support/resident-leaver.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: "{}", FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PIDS_LOG: log, Q08_IGNORE_TERM: "1" }, reapForceMs: 400 });
  let id: string | undefined;
  try {
    const result = await adapter.spawn(brief);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("spawn failed");
    id = result.computeId;
    await adapter.settled(id);
    const [resident] = readPids(log);
    if (!resident) throw new Error("launch not recorded");
    // give the fixture time to replace the fake CLI's SIGTERM handler (it does so right after the fake finished loading)
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await adapter.stop(id), { ok: true });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(live(resident.main), true, "SIGTERM alone does not end this CLI; the stop is only a request so far");
    const stopped = await adapter.quiesce!(id, 3000);
    assert.equal(stopped.ok, true);
    assert.deepEqual([live(resident.main), live(resident.descendant)], [false, false], "confirmed only after the forced kill ended the main and its leftover was closed");
  } finally {
    try { if (id) { await adapter.stop(id); await adapter.quiesce!(id, 2000); } } finally {
      killOwn(readPids(log).flatMap((p) => [p.descendant, p.main]));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("S-PROC-CC-04 AC-23: stopping a frozen one-shot round captures the tree before the group SIGKILL, so its setsid child is closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-cc-frozen-"));
  const record = path.join(dir, "record.jsonl");
  const adapter = createComputeAdapter({
    runner: { command: process.execPath, args: [fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url)), `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: JSON.stringify({ reports: [{ kind: "started", summary: "neutral" }, { kind: "blocked", summary: "neutral", needs: "neutral token" }], hang: "graceful", grandchild: { marker: path.join(dir, "marker"), setsid: true, ignoreTerm: true } }), FAKE_RECORD: record }, reapForceMs: 30 });
  let id: string | undefined;
  let descendant: number | undefined;
  try {
    const result = await adapter.spawn(brief);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("spawn failed");
    id = result.computeId;
    const events = await adapter.settled(id);
    assert.deepEqual(events.map((e) => e.kind), ["started", "blocked"], "the round is paused (frozen) on an accepted blocked report");
    descendant = Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
    assert.equal(live(descendant), true);
    assert.deepEqual(await adapter.stop(id), { ok: true });
    const stopped = await adapter.quiesce!(id, 3000);
    assert.equal(stopped.ok, true);
    assert.equal(live(descendant), false, "the setsid child outside the frozen group is found only through the capture taken at stop");
  } finally {
    try { if (id) { await adapter.stop(id); await adapter.quiesce!(id, 2000); } } finally {
      if (descendant === undefined && fs.existsSync(`${record}.grandchild.pid`)) descendant = Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
      const main = fs.existsSync(record) ? (JSON.parse(fs.readFileSync(record, "utf8").split("\n")[0]!) as { pid: number }).pid : undefined;
      killOwn([...(descendant ? [descendant] : []), ...(main ? [main] : [])]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
