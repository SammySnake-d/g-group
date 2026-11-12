// OS resource boundary only: no harness/session/turn scheduling lives here.
import { type ChildProcess, execFileSync } from "node:child_process";
import { IS_WINDOWS, type ProcRow, processTable, signalGroup, stillAlive, treeByPgrep, treeOf } from "./procgroup.ts";

export type CleanupResult =
  | { readonly ok: true; readonly killed: number }
  | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };
export interface ProcessCleanup {
  /** Capture before a protocol shutdown or signal can orphan descendants. */
  capture(): void;
  /** Request only; a signal or main exit is not confirmation. Idempotent per child. */
  requestStop(forceMs: number): void;
  /** Success means actual main exit and no remaining discoverable live descendants. */
  quiesce(timeoutMs?: number, mainExitTimeoutMs?: number): Promise<CleanupResult>;
}

const procs = () => processTable(() => execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const pgrep = (args: readonly string[]): readonly number[] | null => {
  try { return execFileSync("pgrep", [...args], { encoding: "utf8" }).split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim())); }
  catch (e) { return (e as { status?: unknown }).status === 1 ? [] : null; }
};
const treeNow = (pid: number): readonly ProcRow[] | null => {
  const table = procs();
  return table ? treeOf(pid, table) : treeByPgrep(pid, pgrep);
};
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: unknown }).code === "EPERM"; }
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const validMs = (ms: number) => Number.isFinite(ms) && ms >= 0;

export function createProcessCleanup(child: ChildProcess): ProcessCleanup {
  const pid = child.pid;
  let requested = false;
  let known: Map<number, ProcRow> | null = null;
  const mainExited = () => child.exitCode !== null || child.signalCode !== null;
  const exited = mainExited() ? Promise.resolve() : new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    // A failed spawn has no OS process to wait for and may not emit exit.
    child.once("error", () => { if (child.pid === undefined) resolve(); });
  });
  function capture() {
    if (pid === undefined || pid <= 1 || IS_WINDOWS) return;
    const rows = treeNow(pid);
    if (rows === null) return;
    known ??= new Map();
    for (const row of rows) known.set(row.pid, row);
  }
  return {
    capture,
    requestStop(forceMs) {
      if (!validMs(forceMs)) throw new TypeError("forceMs 必须是非负有限数");
      if (requested) return;
      requested = true;
      capture();
      if (mainExited()) return;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      const timer = setTimeout(() => signalGroup(pid, "SIGKILL"), forceMs);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    },
    async quiesce(timeoutMs = 5000, mainExitTimeoutMs = timeoutMs) {
      if (!validMs(timeoutMs) || !validMs(mainExitTimeoutMs)) return { ok: false, reason: "timeoutMs 必须是非负有限数", remaining: [] };
      capture();
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), mainExitTimeoutMs); })]);
      clearTimeout(timer);
      if (!done) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };
      if (pid === undefined) return { ok: true, killed: 0 };
      if (IS_WINDOWS) return { ok: false, reason: "当前平台无法确认完整进程树已退出", remaining: [] };
      // A current observation after main exit is required: unreadable is never empty.
      const after = treeNow(pid);
      if (after !== null) { known ??= new Map(); for (const row of after) known.set(row.pid, row); }
      if (after === null || known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };
      const killed = new Set<number>();
      const start = Date.now();
      for (;;) {
        const table = procs();
        // Refresh discoverable descendants while closing the captured tree.
        if (table) {
          for (const root of [...known.values()].filter((r) => r.pgid !== -1 && stillAlive(r, table))) {
            for (const row of treeOf(root.pid, table)) known.set(row.pid, row);
          }
        }
        const alive = [...known.values()].filter((r) => table && r.pgid !== -1 ? stillAlive(r, table) : pidAlive(r.pid));
        if (!alive.length) return { ok: true, killed: killed.size };
        if (Date.now() - start > timeoutMs) return { ok: false, reason: `还有 ${alive.length} 个进程没退出`, remaining: alive.map((r) => r.pid) };
        signalGroup(pid, "SIGKILL");
        for (const row of alive) { try { process.kill(row.pid, "SIGKILL"); killed.add(row.pid); } catch { /* just exited */ } }
        await delay(50);
      }
    },
  };
}
