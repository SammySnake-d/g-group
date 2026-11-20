// AC-23 R1-02/R1-03 (review round 1): a confirmed handle never re-enumerates or signals by pid; after the main exits only processes
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
    const listed = spawnSync("pgrep", ["-fl", "."], { encoding: "utf8" });
    if (listed.status === 1) return false;
    if (listed.error || listed.status !== 0) throw new Error(`pid enumeration unavailable: ${listed.error?.message ?? listed.stderr}`);
    return listed.stdout.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === pid);
  }
}
function jsonLines(child: ChildProcess) {
  const queue: Record<string, number>[] = [];
  let wake: (() => void) | undefined;
  readline.createInterface({ input: child.stdout! }).on("line", (l) => { queue.push(JSON.parse(l) as Record<string, number>); wake?.(); });
  return async (ms = 15000): Promise<Record<string, number>> => {
    const t0 = Date.now();
    while (!queue.length) {
      if (Date.now() - t0 > ms) throw new Error("fixture line timed out");
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
    }
    return queue.shift()!;
  };
}
function recordKills(forward: (target: number) => boolean) {
  const sent: [number, string][] = [];
  process.kill = ((target: number, sig?: NodeJS.Signals | number) => {
    if (sig === 0) return realKill.call(process, target, 0);
    sent.push([target, String(sig ?? "SIGTERM")]);
    return forward(target) ? realKill.call(process, target, sig) : true;
  }) as typeof process.kill;
  return sent;
}
async function bystander() {
  const by = spawn(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify({ kid: c.pid })); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const { kid } = await jsonLines(by)();
  return { by, leader: by.pid!, kid: kid! };
}
async function exitOf(child: ChildProcess, ms = 10000) {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit", { signal: AbortSignal.timeout(ms) });
}
async function endOwned(child: ChildProcess, extra: readonly number[] = []) {
  for (const pid of extra) { try { realKill.call(process, pid, "SIGKILL"); } catch { /* exited */ } }
  if (child.pid !== undefined) { try { realKill.call(process, -child.pid, "SIGKILL"); } catch { /* exited */ } }
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}
function onlyToolPath(tool: "ps" | "pgrep") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `q08-${tool}-only-`));
  const real = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, tool)).find((f) => fs.existsSync(f)) ?? `/usr/bin/${tool}`;
  fs.symlinkSync(real, path.join(dir, tool));
  return dir;
}
const pgrepOnlyPath = () => onlyToolPath("pgrep");
function psRuns(): boolean {
  try { execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] }); return true; } catch { return false; }
}
function scriptedPs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-scripted-ps-"));
  const table = path.join(dir, "table");
  fs.writeFileSync(table, "");
  fs.writeFileSync(path.join(dir, "ps"), `#!/bin/sh\nexec /bin/cat "${table}"\n`, { mode: 0o755 });
  const at = (ms: number) => { const [wd, mon, day, year, time] = new Date(ms).toString().split(" "); return `${wd} ${mon} ${String(Number(day)).padStart(2)} ${time} ${year}`; };
  return { dir, show: (rows: readonly (readonly [pid: number, ppid: number, pgid: number, stat: string, bornMs: number])[]) => fs.writeFileSync(table, rows.map(([pid, ppid, pgid, stat, born]) => `${pid} ${ppid} ${pgid} ${stat} ${at(born)}\n`).join("")) };
}
async function spentPid() {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exitOf(gone);
  return gone.pid!;
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
    await exitOf(child);
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
  const psDir = onlyToolPath("ps");
  const originalPath = process.env.PATH;
  const modes: readonly ("both" | "pgrep only" | "ps only")[] = psRuns() ? ["both", "pgrep only", "ps only"] : ["both", "pgrep only"];
  try {
    for (const mode of modes) {
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
        child.kill("SIGTERM");
        await exitOf(child);
        if (mode !== "both") process.env.PATH = mode === "ps only" ? psDir : pgrepDir;
        const result = await cleanup.quiesce(3000, 500);
        process.env.PATH = originalPath;
        assert.deepEqual(result, { ok: true, killed: 2 }, `enumeration: ${mode}`);
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
    fs.rmSync(psDir, { recursive: true, force: true });
  }
});

test("S-PROC-11 AC-23: an earlier capture does not replace a current observation after the main exits", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const originalPath = process.env.PATH;
  try {
    const cleanup = createProcessCleanup(child);
    cleanup.capture();
    child.kill("SIGKILL");
    await exitOf(child);
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
  const pgrepDir = pgrepOnlyPath();
  const originalPath = process.env.PATH;
  try {
    for (const onlyPgrep of [false, true]) {
      const child = spawn(process.execPath, ["-e", 'const c = require("node:child_process").spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(JSON.stringify({ c: c.pid })); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const owned: number[] = [];
      try {
        const cleanup = createProcessCleanup(child);
        const c = (await jsonLines(child)()).c!;
        owned.push(c);
        if (onlyPgrep) process.env.PATH = pgrepDir;
        child.kill("SIGTERM");
        await exitOf(child);
        const result = await cleanup.quiesce(2000, 500);
        process.env.PATH = originalPath;
        assert.equal(result.ok, true, onlyPgrep ? "pgrep-only enumeration" : "ps enumeration");
        assert.equal(live(c), false, `the member left in the group at main exit was closed before the receipt (${onlyPgrep ? "pgrep only" : "ps"})`);
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

test("S-PROC-15 AC-23: a recorded leftover is that process only while its start time matches; a later holder of the pid is not signalled", async () => {
  const { by, leader, kid } = await bystander();
  const ps = scriptedPs();
  const originalPath = process.env.PATH;
  try {
    const main = await spentPid();
    const t0 = Date.UTC(2026, 10, 1, 8, 0, 0);
    const stub = Object.assign(new EventEmitter(), { pid: main, exitCode: null as number | null, signalCode: null, kill: () => { throw new Error("stub: never signals"); } });
    const sent = recordKills(() => false);
    process.env.PATH = ps.dir;
    ps.show([[main, 1, main, "S", t0], [leader, main, leader, "Ss", t0 + 5000]]);
    const cleanup = createProcessCleanup(stub as unknown as ChildProcess);
    cleanup.capture();
    ps.show([[leader, 1, leader, "Ss", t0 + 5000]]);
    stub.exitCode = 0;
    stub.emit("exit", 0, null);
    ps.show([[leader, 1, leader, "Ss", t0 + 6000]]);
    const same = await cleanup.quiesce(150, 0);
    assert.deepEqual(same, { ok: false, reason: "还有 1 个进程没退出", remaining: [leader] });
    const before = sent.filter(([t]) => t === leader).length;
    assert.equal(before > 0, true, "control: with a matching start time the recorded leftover is signalled");
    ps.show([[leader, 1, leader, "Ss", t0 + 3 * 3600_000]]);
    const later = await cleanup.quiesce(150, 0);
    process.env.PATH = originalPath;
    process.kill = realKill;
    assert.deepEqual(later, { ok: true, killed: 0 });
    assert.equal(sent.filter(([t]) => t === leader).length, before, "no further signal to a pid whose holder started at another time");
    assert.deepEqual(sent.filter(([t]) => t === main || t === -main), [], "never the exited main's pid or group id");
    assert.deepEqual([live(leader), live(kid)], [true, true]);
  } finally {
    process.kill = realKill;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(ps.dir, { recursive: true, force: true });
    await endOwned(by, [kid]);
  }
});

test("S-PROC-16 AC-23: only the group members seen when the main exited are its leftovers; a later group under the same id is not adopted", async () => {
  const { by, leader, kid } = await bystander();
  const ps = scriptedPs();
  const originalPath = process.env.PATH;
  try {
    const main = await spentPid();
    const t0 = Date.UTC(2026, 10, 1, 8, 0, 0);
    const stub = Object.assign(new EventEmitter(), { pid: main, exitCode: null as number | null, signalCode: null, kill: () => { throw new Error("stub: never signals"); } });
    const sent = recordKills(() => false);
    process.env.PATH = ps.dir;
    ps.show([[main, 1, main, "S", t0]]);
    const cleanup = createProcessCleanup(stub as unknown as ChildProcess);
    ps.show([[leader, 1, main, "S", t0 + 5000]]);
    stub.exitCode = 0;
    stub.emit("exit", 0, null);
    ps.show([[kid, 1, main, "S", t0 + 3 * 3600_000]]);
    const result = await cleanup.quiesce(150, 0);
    process.env.PATH = originalPath;
    process.kill = realKill;
    assert.deepEqual(result, { ok: true, killed: 0 });
    assert.deepEqual(sent, [], "nothing recorded at the exit is alive, so nothing is signalled: not Y, not the group id");
    assert.deepEqual([live(leader), live(kid)], [true, true]);
  } finally {
    process.kill = realKill;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(ps.dir, { recursive: true, force: true });
    await endOwned(by, [kid]);
  }
});

test("S-PROC-17 AC-23: a spawn that never produced a process has nothing to wait for or close", async () => {
  const child = spawn(path.join(os.tmpdir(), "g-group-no-such-command-fixture"), [], { detached: true, stdio: "ignore" });
  const cleanup = createProcessCleanup(child);
  const failed = await once(child, "error", { signal: AbortSignal.timeout(5000) });
  assert.equal((failed[0] as NodeJS.ErrnoException).code, "ENOENT");
  cleanup.requestStop(20);
  const result = await cleanup.quiesce(200, 200);
  assert.deepEqual(result, { ok: true, killed: 0 }, "no process was started: confirmed at once, not reported as a main that will not exit");
});

test("S-PROC-18 AC-23: when the group left at the main's exit could not be read at that moment, a later readable table does not confirm", async () => {
  const blind = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const seen = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const originalPath = process.env.PATH;
  try {
    const unread = createProcessCleanup(blind);
    const read = createProcessCleanup(seen);
    process.env.PATH = "/g-group-no-command-fixture";
    blind.kill("SIGKILL");
    await exitOf(blind);
    process.env.PATH = originalPath;
    seen.kill("SIGKILL");
    await exitOf(seen);
    const result = await unread.quiesce(200, 200);
    assert.deepEqual(result, { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] });
    assert.deepEqual(await read.quiesce(200, 200), { ok: true, killed: 0 }, "control: the same exit, readable when it happened, is confirmed");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await endOwned(blind);
    await endOwned(seen);
  }
});
