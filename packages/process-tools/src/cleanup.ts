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

/** A recorded process: the row it was found with, plus its start time (ms) when ps reported one */
type Known = ProcRow & { readonly born?: number };
interface Snapshot { readonly table: readonly ProcRow[]; readonly born: ReadonlyMap<number, number> }
/** Two ps runs may print the same process's start a second apart on some systems; a pid is never handed out again that fast */
const BORN_SLACK_MS = 2000;

/** One ps run: the four columns processTable reads, then the start time (a handle may be kept for hours, pid + group alone do not identify a process that long) */
const procs = (): Snapshot | null => {
  let out = "";
  try { out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }); } catch { return null; }
  const table = processTable(() => out);
  if (table === null) return null;
  const born = new Map<number, number>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+\d+\s+\d+\s+\S+\s+(\S.*?)\s*$/.exec(line);
    const at = m ? Date.parse(m[2]!) : Number.NaN;
    if (m && Number.isFinite(at)) born.set(Number(m[1]), at);
  }
  return { table, born };
};
const stamp = (rows: readonly ProcRow[], snap: Snapshot): Known[] => rows.map((r) => { const at = snap.born.get(r.pid); return at === undefined ? r : { ...r, born: at }; });
/** The recorded process is still that process and alive: pid and group match (stillAlive) and, when both sides have one, the start time too */
const ours = (r: Known, snap: Snapshot) => {
  if (!stillAlive(r, snap.table)) return false;
  const now = snap.born.get(r.pid);
  return r.born === undefined || now === undefined || Math.abs(now - r.born) <= BORN_SLACK_MS;
};
const pgrep = (args: readonly string[]): readonly number[] | null => {
  try { return execFileSync("pgrep", [...args], { encoding: "utf8" }).split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim())); }
  catch (e) { return (e as { status?: unknown }).status === 1 ? [] : null; }
};
/** Descendants and group members of a pid that still belongs to the caller's live main */
const liveTree = (pid: number): readonly Known[] | null => {
  const snap = procs();
  return snap ? stamp(treeOf(pid, snap.table), snap) : treeByPgrep(pid, pgrep);
};
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: unknown }).code === "EPERM"; }
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const validMs = (ms: number) => Number.isFinite(ms) && ms >= 0;
const groupRows = (group: readonly number[], pgid: number): Known[] => group.filter((k) => k > 1 && k !== pgid).map((k) => ({ pid: k, ppid: -1, pgid, stat: "?" }));

export function createProcessCleanup(child: ChildProcess, options: CleanupOptions = {}): ProcessCleanup {
  const pid = child.pid;
  const windows = options.platform === undefined ? IS_WINDOWS : options.platform === "win32";
  let requested = false;
  let known: Map<number, Known> | null = null;
  let confirmed: CleanupResult | null = null;
  /** The members left in the main's group were recorded (or the pid was seen to belong to someone else already) */
  let exitSeen = false;
  const mainExited = () => child.exitCode !== null || child.signalCode !== null;
  const remember = (rows: readonly Known[]) => { known ??= new Map(); for (const row of rows) known.set(row.pid, row); };
  // The main's group id stays reserved while any member is alive (POSIX never reuses a pid that is still a process-group id),
  // so a group still holding a member recorded as ours is ours, and every member of it is something the main left behind.
  const groupHeldByKnown = (snap: Snapshot, main: number) => [...(known?.values() ?? [])].some((r) => r.pgid === main && ours(r, snap));
  const exited = mainExited() ? Promise.resolve() : new Promise<void>((resolve) => {
    child.once("exit", () => { exitSnapshot(); resolve(); });
    // A failed spawn has no OS process to wait for and may not emit exit.
    child.once("error", () => { if (child.pid === undefined) resolve(); });
  });
  /**
   * Record the members still in the main's group once it has exited. Taken in the exit event itself, right after the main was
   * reaped (pids are handed out in sequence, so it is not reused yet); if nothing was readable then, or the handle was created
   * after the exit, the same rule is applied at the first confirmation. Children are never looked up by the old pid again.
   */
  function exitSnapshot() {
    if (exitSeen || pid === undefined || pid <= 1 || windows) return;
    const snap = procs();
    // The same pid listed again already belongs to another program; then the old group must have emptied first.
    if (snap) { exitSeen = true; remember(snap.table.some((r) => r.pid === pid) ? [] : stamp(treeOf(pid, snap.table), snap)); return; }
    const group = pgrep(["-g", String(pid)]);
    if (group !== null) { exitSeen = true; remember(group.includes(pid) ? [] : groupRows(group, pid)); }
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
  const treeNow = (main: number): readonly Known[] | null => {
    const snap = procs();
    if (snap) return groupHeldByKnown(snap, main) ? stamp(treeOf(main, snap.table), snap) : [];
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
      exitSnapshot();
      // A current observation after main exit is required: unreadable is never empty.
      const after = treeNow(pid);
      if (after !== null) { known ??= new Map(); for (const row of after) known.set(row.pid, row); }
      if (after === null || known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };
      const killed = new Set<number>();
      const start = Date.now();
      for (;;) {
        const snap = procs();
        // Refresh discoverable descendants while closing the captured tree.
        if (snap) {
          for (const root of [...known.values()].filter((r) => r.pgid !== -1 && ours(r, snap))) {
            for (const row of stamp(treeOf(root.pid, snap.table), snap)) known.set(row.pid, row);
          }
        } else {
          // No ps (restricted sandbox): the same refresh through pgrep, which can only tell liveness by pid.
          for (const root of [...known.values()].filter((r) => pidAlive(r.pid))) {
            for (const row of treeByPgrep(root.pid, pgrep) ?? []) if (!known.has(row.pid)) known.set(row.pid, row);
          }
        }
        const alive = [...known.values()].filter((r) => snap && r.pgid !== -1 ? ours(r, snap) : pidAlive(r.pid));
        if (!alive.length) {
          confirmed = { ok: true, killed: killed.size };
          return confirmed;
        }
        if (Date.now() - start > timeoutMs) return { ok: false, reason: `还有 ${alive.length} 个进程没退出`, remaining: alive.map((r) => r.pid) };
        // Group SIGKILL only while that group id is still held by a member recorded as ours.
        if (snap && groupHeldByKnown(snap, pid)) signalGroup(pid, "SIGKILL");
        for (const row of alive) { try { process.kill(row.pid, "SIGKILL"); killed.add(row.pid); } catch { /* just exited */ } }
        await delay(50);
      }
    },
  };
}
