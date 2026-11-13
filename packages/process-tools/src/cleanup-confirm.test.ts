// AC-23 R1-02/R1-03 (review round 1): a confirmed handle never re-enumerates or signals by pid; after the main exits only processes
// it provably left behind are touched. Owned processes only: every "unrelated" process here is a group this test started itself,
// and every check that a signal was NOT sent uses a replaced process.kill that records instead of signalling.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createProcessCleanup } from "./cleanup.ts";

const tree = fileURLToPath(new URL("../test-support/tree.mjs", import.meta.url));
const refreshTree = fileURLToPath(new URL("../test-support/refresh-tree.mjs", import.meta.url));
const realKill = process.kill;
function live(pid: number): boolean {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return rows.split("\n").some((line) => { const p = line.trim().split(/\s+/); return Number(p[0]) === pid && !p[1]?.startsWith("Z"); });
  } catch {
    // macOS seatbelt denies setuid ps; use an independent OS pid listing, never assume absent on error.
    const listed = spawnSync("pgrep", ["-fl", "."], { encoding: "utf8" });
    if (listed.status === 1) return false;
    if (listed.error || listed.status !== 0) throw new Error(`pid enumeration unavailable: ${listed.error?.message ?? listed.stderr}`);
    return listed.stdout.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === pid);
  }
}
/** JSON lines from an owned child's stdout, in order */
function jsonLines(child: ChildProcess) {
  const queue: Record<string, number>[] = [];
  let wake: (() => void) | undefined;
  readline.createInterface({ input: child.stdout! }).on("line", (l) => { queue.push(JSON.parse(l) as Record<string, number>); wake?.(); });
  return async (ms = 5000): Promise<Record<string, number>> => {
    const t0 = Date.now();
    while (!queue.length) {
      if (Date.now() - t0 > ms) throw new Error("fixture line timed out");
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
    }
    return queue.shift()!;
  };
}
/** Replace process.kill: signal 0 (existence probe) passes through; every real signal is recorded and only forwarded when allowed */
function recordKills(forward: (target: number) => boolean) {
  const sent: [number, string][] = [];
  process.kill = ((target: number, sig?: NodeJS.Signals | number) => {
    if (sig === 0) return realKill.call(process, target, 0);
    sent.push([target, String(sig ?? "SIGTERM")]);
    return forward(target) ? realKill.call(process, target, sig) : true;
  }) as typeof process.kill;
  return sent;
}
/** A test-owned process group (leader + one same-group child) standing in for an unrelated program that later got the old pid */
async function bystander() {
  const by = spawn(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify({ kid: c.pid })); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const { kid } = await jsonLines(by)();
  return { by, leader: by.pid!, kid: kid! };
}
async function endOwned(child: ChildProcess, extra: readonly number[] = []) {
  for (const pid of extra) { try { realKill.call(process, pid, "SIGKILL"); } catch { /* exited */ } }
  if (child.pid !== undefined) { try { realKill.call(process, -child.pid, "SIGKILL"); } catch { /* exited */ } }
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}
/** pgrep available, ps not: the restricted-sandbox enumeration path, on any platform */
function pgrepOnlyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-pgrep-only-"));
  fs.symlinkSync("/usr/bin/pgrep", path.join(dir, "pgrep"));
  return dir;
}

test("S-PROC-07 AC-23: a confirmed handle remembers its receipt and never enumerates or signals by the old pid again", async () => {
  const child = spawn(process.execPath, [tree], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const main = child.pid!;
  let descendant: number | undefined;
  const originalPath = process.env.PATH;
  try {
    descendant = (await jsonLines(child)()).pid;
    const cleanup = createProcessCleanup(child);
    cleanup.requestStop(50);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    // the main is gone and reaped: from here on its pid may belong to anyone, so nothing may be sent to it or its group id
    const sent = recordKills((target) => target !== main && target !== -main);
    const first = await cleanup.quiesce(2000, 2000);
    assert.deepEqual(first, { ok: true, killed: 1 });
    assert.equal(live(descendant!), false, "the captured setsid descendant actually exited");
    assert.deepEqual(sent.filter(([t]) => t === main || t === -main), [], "no signal to the exited main pid or its now-empty group id");
    const before = sent.length;
    process.env.PATH = "/g-group-no-command-fixture";
    cleanup.capture();
    const again = await cleanup.quiesce(2000, 2000);
    assert.deepEqual(again, first, "the remembered receipt, not a fresh enumeration (which would fail closed without ps/pgrep)");
    assert.equal(sent.length, before, "no signal at all after confirmation");
  } finally {
    process.kill = realKill;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await endOwned(child, descendant === undefined ? [] : [descendant]);
  }
});

test("S-PROC-08 AC-23: a stale handle whose pid now leads an unrelated group signals nothing in that group, with ps and with pgrep only", async () => {
  const pgrepDir = pgrepOnlyPath();
  const originalPath = process.env.PATH;
  try {
    for (const onlyPgrep of [false, true]) {
      const { by, leader, kid } = await bystander();
      try {
        // the old main exited long ago (exit already observed before this handle looked); its pid now belongs to the bystander group
        const stale = Object.assign(new EventEmitter(), { pid: leader, exitCode: 0, signalCode: null, kill: () => { throw new Error("stub: never signals"); } }) as unknown as ChildProcess;
        const cleanup = createProcessCleanup(stale);
        const sent = recordKills(() => false);
        if (onlyPgrep) process.env.PATH = pgrepDir;
        const result = await cleanup.quiesce(300, 0);
        process.env.PATH = originalPath;
        process.kill = realKill;
        assert.deepEqual(result, { ok: true, killed: 0 }, onlyPgrep ? "pgrep-only enumeration" : "ps enumeration");
        assert.deepEqual(sent.filter(([t]) => t === leader || t === -leader || t === kid), [], "the bystander leader, its group and its child are not this handle's");
        assert.deepEqual([live(leader), live(kid)], [true, true]);
      } finally {
        process.env.PATH = originalPath;
        process.kill = realKill;
        await endOwned(by, [kid]);
      }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(pgrepDir, { recursive: true, force: true });
  }
});

test("S-PROC-09 AC-23: the group recorded at main exit excludes a group that already belongs to whoever holds that pid, with ps and with pgrep only", async () => {
  const pgrepDir = pgrepOnlyPath();
  const originalPath = process.env.PATH;
  try {
    for (const onlyPgrep of [false, true]) {
      const { by, leader, kid } = await bystander();
      try {
        const stub = Object.assign(new EventEmitter(), { pid: leader, exitCode: null as number | null, signalCode: null, kill: () => { throw new Error("stub: never signals"); } });
        const cleanup = createProcessCleanup(stub as unknown as ChildProcess);
        // exit observed while the pid is (in this simulation) already held by the bystander leader
        if (onlyPgrep) process.env.PATH = pgrepDir;
        stub.exitCode = 0;
        stub.emit("exit", 0, null);
        const sent = recordKills(() => false);
        const result = await cleanup.quiesce(300, 0);
        process.env.PATH = originalPath;
        process.kill = realKill;
        assert.deepEqual(result, { ok: true, killed: 0 }, onlyPgrep ? "pgrep-only enumeration" : "ps enumeration");
        assert.deepEqual(sent.filter(([t]) => t === leader || t === -leader || t === kid), []);
        assert.equal(live(kid), true);
      } finally {
        process.env.PATH = originalPath;
        process.kill = realKill;
        await endOwned(by, [kid]);
      }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(pgrepDir, { recursive: true, force: true });
  }
});

test("S-PROC-10 AC-23: a descendant started by a known process after capture is found and closed, with ps and with pgrep only", async () => {
  const pgrepDir = pgrepOnlyPath();
  const originalPath = process.env.PATH;
  try {
    for (const onlyPgrep of [false, true]) {
      const child = spawn(process.execPath, [refreshTree], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const next = jsonLines(child);
      const owned: number[] = [];
      try {
        const d = (await next()).d!;
        owned.push(d);
        const cleanup = createProcessCleanup(child);
        cleanup.capture();
        realKill.call(process, d, "SIGUSR2");
        const g = (await next()).g!;
        owned.push(g);
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
        if (onlyPgrep) process.env.PATH = pgrepDir;
        const result = await cleanup.quiesce(3000, 500);
        process.env.PATH = originalPath;
        assert.deepEqual(result, { ok: true, killed: 2 }, onlyPgrep ? "pgrep-only enumeration" : "ps enumeration");
        assert.deepEqual([live(d), live(g)], [false, false], "the late descendant G was not captured but must be closed too");
      } finally {
        process.env.PATH = originalPath;
        await endOwned(child, owned);
      }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(pgrepDir, { recursive: true, force: true });
  }
});

test("S-PROC-11 AC-23: an earlier capture does not replace a current observation after the main exits", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const originalPath = process.env.PATH;
  try {
    const cleanup = createProcessCleanup(child);
    cleanup.capture();
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    process.env.PATH = "/g-group-no-command-fixture";
    const result = await cleanup.quiesce(50, 50);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreadable tree was accepted");
    assert.match(result.reason, /读不到进程表/);
    assert.deepEqual(result.remaining, []);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await endOwned(child);
  }
});

test("S-PROC-12 AC-23: requestStop is idempotent, a second call neither re-signals nor shortens the escalation", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => { out += b.toString("utf8"); });
  try {
    for (let i = 0; i < 100 && !out.includes("ready"); i++) await new Promise((r) => setTimeout(r, 50));
    const cleanup = createProcessCleanup(child);
    cleanup.requestStop(60000);
    cleanup.requestStop(20);
    for (let i = 0; i < 100 && !out.includes("term"); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const pending = await cleanup.quiesce(0, 200);
    assert.deepEqual(pending, { ok: false, reason: "CLI 主进程没有退出", remaining: [child.pid] }, "the first grace (60s) still applies; the second request changed nothing");
    assert.equal(out.split("\n").filter((l) => l === "term").length, 1, "exactly one SIGTERM for two requests");
    assert.equal(live(child.pid!), true);
  } finally {
    await endOwned(child);
  }
});

test("S-PROC-13 AC-23: on an injected Windows platform cleanup refuses to claim an all-exit receipt", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  const control = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  try {
    const windows = createProcessCleanup(child, { platform: "win32" });
    const posix = createProcessCleanup(control, { platform: "linux" });
    windows.capture();
    const result = await windows.quiesce(200, 2000);
    assert.deepEqual(result, { ok: false, reason: "当前平台无法确认完整进程树已退出", remaining: [] });
    assert.deepEqual(await posix.quiesce(200, 2000), { ok: true, killed: 0 }, "same exited main on a POSIX platform is confirmed");
  } finally {
    await endOwned(child);
    await endOwned(control);
  }
});

test("S-PROC-14 AC-23: same-group members alive when the main exits are still closed without any earlier capture", async () => {
  const child = spawn(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify({ c: c.pid })); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const owned: number[] = [];
  try {
    const cleanup = createProcessCleanup(child);
    const c = (await jsonLines(child)()).c!;
    owned.push(c);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
    assert.equal(live(c), true, "only the main got SIGTERM; its same-group child is left");
    const result = await cleanup.quiesce(2000, 500);
    // the group SIGKILL may reap it before the per-pid kill is counted, so the count is not pinned here
    assert.equal(result.ok, true);
    assert.equal(live(c), false, "the member recorded at main exit was closed before the receipt");
  } finally {
    await endOwned(child, owned);
  }
});
