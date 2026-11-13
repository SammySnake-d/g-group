// OS resource boundary only: no harness/session/turn scheduling lives here.
import { type ChildProcess, execFileSync } from "node:child_process";
import { IS_WINDOWS, type ProcRow, processTable, signalGroup, stillAlive, treeByPgrep, treeOf } from "./procgroup.ts";

export type CleanupResult =
  | { readonly ok: true; readonly killed: number }
  | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };
export interface ProcessCleanup {
  /** Capture before a protocol shutdown or signal can orphan descendants. Only while the main has not exited (its pid is still its own). */
  capture(): void;
  /** Request only; a signal or main exit is not confirmation. Idempotent per child. */
  requestStop(forceMs: number): void;
  /**
   * Success means actual main exit and no remaining discoverable live descendants. A success is remembered: later calls return
   * it without enumerating or signalling by the old pid again (that pid may belong to another program by then).
   */
  quiesce(timeoutMs?: number, mainExitTimeoutMs?: number): Promise<CleanupResult>;
}
export interface CleanupOptions {
  /** Platform whose process-tree rules apply; defaults to the current one (injectable so the Windows refusal is testable anywhere) */
  readonly platform?: NodeJS.Platform;
}

const procs = () => processTable(() => execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const pgrep = (args: readonly string[]): readonly number[] | null => {
  try { return execFileSync("pgrep", [...args], { encoding: "utf8" }).split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim())); }
  catch (e) { return (e as { status?: unknown }).status === 1 ? [] : null; }
};
/** Descendants and group members of a pid that still belongs to the caller's live main */
const liveTree = (pid: number) => {
  const table = procs();
  return table ? treeOf(pid, table) : treeByPgrep(pid, pgrep);
};
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: unknown }).code === "EPERM"; }
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const validMs = (ms: number) => Number.isFinite(ms) && ms >= 0;
const groupRows = (group: readonly number[], pgid: number): ProcRow[] => group.filter((k) => k > 1 && k !== pgid).map((k) => ({ pid: k, ppid: -1, pgid, stat: "?" }));

export function createProcessCleanup(child: ChildProcess, options: CleanupOptions = {}): ProcessCleanup {
  const pid = child.pid;
  const windows = options.platform === undefined ? IS_WINDOWS : options.platform === "win32";
  let requested = false;
  let known: Map<number, ProcRow> | null = null;
  let confirmed: CleanupResult | null = null;
  const mainExited = () => child.exitCode !== null || child.signalCode !== null;
  const remember = (rows: readonly ProcRow[]) => { known ??= new Map(); for (const row of rows) known.set(row.pid, row); };
  // The main's group id stays reserved while any member is alive (POSIX never reuses a pid that is still a process-group id),
  // so a group still holding a member recorded as ours is ours, and every member of it is something the main left behind.
  const groupHeldByKnown = (table: readonly ProcRow[], main: number) => [...(known?.values() ?? [])].some((r) => r.pgid === main && stillAlive(r, table));
  const exited = mainExited() ? Promise.resolve() : new Promise<void>((resolve) => {
    child.once("exit", () => { atExit(); resolve(); });
    // A failed spawn has no OS process to wait for and may not emit exit.
    child.once("error", () => { if (child.pid === undefined) resolve(); });
  });
  /**
   * In the exit event itself, right after the main was reaped (pids are handed out in sequence, so it is not reused yet):
   * record the members still in its group. After this the old pid is never used to look up children again.
   */
  function atExit() {
    if (pid === undefined || pid <= 1 || windows || confirmed) return;
    const table = procs();
    // The same pid listed again already belongs to another program; then the old group must have emptied first.
    if (table) { remember(table.some((r) => r.pid === pid) ? [] : treeOf(pid, table)); return; }
    const group = pgrep(["-g", String(pid)]);
    if (group !== null) remember(group.includes(pid) ? [] : groupRows(group, pid));
  }
  function capture() {
    // Only while the main is unreaped: the enumeration runs synchronously, so the event loop cannot reap it and free its pid meanwhile.
    if (pid === undefined || pid <= 1 || windows || confirmed || mainExited()) return;
    const rows = liveTree(pid);
    if (rows === null) return;
    remember(rows);
  }
  /**
   * Main already exited: what it provably left behind, now. Never children by the old pid (that pid may be someone else's);
   * other members of its group only while a member recorded as ours still holds that group. Unreadable gives null.
   */
  const treeNow = (main: number): readonly ProcRow[] | null => {
    const table = procs();
    if (table) return groupHeldByKnown(table, main) ? treeOf(main, table) : [];
    const group = pgrep(["-g", String(main)]);
    if (group === null) return null;
    return group.some((k) => known?.get(k)?.pgid === main) ? groupRows(group, main) : [];
  };
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
      if (confirmed) return confirmed;
      capture();
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), mainExitTimeoutMs); })]);
      clearTimeout(timer);
      if (!done) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };
      if (pid === undefined) return { ok: true, killed: 0 };
      if (windows) return { ok: false, reason: "当前平台无法确认完整进程树已退出", remaining: [] };
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
        } else {
          // No ps (restricted sandbox): the same refresh through pgrep, which can only tell liveness by pid.
          for (const root of [...known.values()].filter((r) => pidAlive(r.pid))) {
            for (const row of treeByPgrep(root.pid, pgrep) ?? []) if (!known.has(row.pid)) known.set(row.pid, row);
          }
        }
        const alive = [...known.values()].filter((r) => table && r.pgid !== -1 ? stillAlive(r, table) : pidAlive(r.pid));
        if (!alive.length) return (confirmed = { ok: true, killed: killed.size });
        if (Date.now() - start > timeoutMs) return { ok: false, reason: `还有 ${alive.length} 个进程没退出`, remaining: alive.map((r) => r.pid) };
        // Group SIGKILL only while that group id is still held by a member recorded as ours.
        if (table && groupHeldByKnown(table, pid)) signalGroup(pid, "SIGKILL");
        for (const row of alive) { try { process.kill(row.pid, "SIGKILL"); killed.add(row.pid); } catch { /* just exited */ } }
        await delay(50);
      }
    },
  };
}
