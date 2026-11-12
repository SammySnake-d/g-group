// AC-23: owned real process tree only; never touch a user's existing harness.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createProcessCleanup } from "./cleanup.ts";

const fixture = fileURLToPath(new URL("../test-support/tree.mjs", import.meta.url));
function live(pid: number): boolean {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8" });
  return rows.split("\n").some((line) => { const p = line.trim().split(/\s+/); return Number(p[0]) === pid && !p[1]?.startsWith("Z"); });
}

test("S-PROC-01 AC-23: shared cleanup confirms real main exit and kills a captured setsid child before success", async () => {
  const child = spawn(process.execPath, [fixture], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let descendant: number | undefined;
  try {
    const ready = await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    descendant = (JSON.parse(String(ready[0])) as { pid: number }).pid;
    const cleanup = createProcessCleanup(child);
    cleanup.requestStop(50);
    const result = await cleanup.quiesce(2000, 2000);
    assert.equal(result.ok, true);
    assert.equal(live(child.pid!), false, "main must actually exit, not just accept a signal");
    assert.equal(live(descendant), false, "detached descendant must actually exit too");
  } finally {
    if (descendant !== undefined) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});

test("S-PROC-02 AC-23: an unexited main fails closed; the same handle succeeds after a real stop", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const cleanup = createProcessCleanup(child);
    const pending = await cleanup.quiesce(0, 0);
    assert.equal(pending.ok, false);
    if (!pending.ok) assert.deepEqual(pending.remaining, [child.pid]);
    assert.equal(live(child.pid!), true);
    cleanup.requestStop(50);
    const stopped = await cleanup.quiesce(2000, 2000);
    assert.equal(stopped.ok, true);
    assert.equal(live(child.pid!), false);
  } finally {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});

test("S-PROC-03 AC-23: ignored SIGTERM escalates once and still confirms the detached descendant", async () => {
  const child = spawn(process.execPath, [fixture], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, Q08_IGNORE_TERM: "1" } });
  let descendant: number | undefined;
  try {
    const ready = await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    descendant = (JSON.parse(String(ready[0])) as { pid: number }).pid;
    const cleanup = createProcessCleanup(child);
    cleanup.requestStop(30);
    cleanup.requestStop(60000);
    const stopped = await cleanup.quiesce(2000, 2000);
    assert.equal(stopped.ok, true);
    assert.equal(child.signalCode, "SIGKILL");
    assert.equal(live(descendant), false);
  } finally {
    if (descendant !== undefined) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});

test("S-PROC-04 AC-23: invalid timeouts do not claim cleanup or signal a live process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const cleanup = createProcessCleanup(child);
    assert.throws(() => cleanup.requestStop(-1), /forceMs/);
    const invalid = await cleanup.quiesce(Number.NaN);
    assert.equal(invalid.ok, false);
    assert.equal(live(child.pid!), true);
    cleanup.requestStop(30);
    assert.equal((await cleanup.quiesce(2000, 2000)).ok, true);
  } finally {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});

test("S-PROC-05 AC-23: actual unavailable ps and pgrep fail closed instead of reporting an empty tree", () => {
  const probe = fileURLToPath(new URL("../test-support/unobservable.mjs", import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "/g-group-no-command-fixture" } })) as { ok: boolean; reason: string };
  assert.equal(result.ok, false);
  assert.match(result.reason, /读不到进程表/);
});
