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
