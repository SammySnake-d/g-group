// 进程组信号。对照 mirasim 0.0.774 server-main.cjs(用户 g-group#2309 定"按照 mirasim 的做法来"):
export const IS_WINDOWS = process.platform === "win32";

export function signalGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  if (!IS_WINDOWS) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* 组已退空,或不是组长:退回对进程本身发 */
    }
  }
  try { process.kill(pid, sig); } catch { /* 已退出 */ }
}

// ---- 停止确认(AC-23;需求 §8.1 已定第 16 条:停止照 mirasim、不用容器,

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly stat: string;
  /** ps 的 lstart 进程启动身份;读不到时为 null,不能用来确认同一 PID */
  readonly identity: string | null;
}

/** 当前进程表(POSIX ps);命令执行失败返回 null(读不到 ≠ 没有进程,调用方不能当成「都退出了」) */
export function processTable(run: () => string): readonly ProcRow[] | null {
  let out = "";
  try { out = run(); } catch { return null; }
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (![pid, ppid, pgid].every(Number.isInteger) || !fields[3]) continue;
    rows.push({ pid, ppid, pgid, stat: fields[3], identity: fields.length > 4 ? fields.slice(4).join(" ") : null });
  }
  return rows;
}

export function treeOf(root: number, table: readonly ProcRow[]): readonly ProcRow[] {
  const live = table.filter((r) => !r.stat.startsWith("Z") && r.pid > 1);
  const found = new Map<number, ProcRow>();
  let frontier = [root];
  while (frontier.length) {
    const next: number[] = [];
    for (const r of live) if (frontier.includes(r.ppid) && r.pid !== root && !found.has(r.pid)) { found.set(r.pid, r); next.push(r.pid); }
    frontier = next;
  }
  for (const r of live) if (r.pgid === root && r.pid !== root && !found.has(r.pid)) found.set(r.pid, r);
  return [...found.values()];
}

/**
 * 读不到 ps 时的退路(macOS 的 /bin/ps 是 setuid 程序,受限沙箱里不让执行;pgrep 不是):
 * 按 `pgrep -P <父>` 逐层找后代、`pgrep -g <组>` 找同组成员。pgrep(pattern) 返回 pid 列表,没有匹配返回 [],执行失败返回 null。
 * 找到的行进程组与启动身份未知记 -1/null;身份无法核对时停止确认不能宣称已退出。
 */
export function treeByPgrep(root: number, pgrep: (args: readonly string[]) => readonly number[] | null): readonly ProcRow[] | null {
  const found = new Map<number, ProcRow>();
  let frontier = [root];
  while (frontier.length) {
    const next: number[] = [];
    for (const parent of frontier) {
      const kids = pgrep(["-P", String(parent)]);
      if (kids === null) return null;
      for (const k of kids) if (k > 1 && k !== root && !found.has(k)) { found.set(k, { pid: k, ppid: parent, pgid: -1, stat: "?", identity: null }); next.push(k); }
    }
    frontier = next;
  }
  const group = pgrep(["-g", String(root)]);
  if (group === null) return null;
  for (const k of group) if (k > 1 && k !== root && !found.has(k)) found.set(k, { pid: k, ppid: -1, pgid: root, stat: "?", identity: null });
  return [...found.values()];
}

export type ProcessMatch = "alive" | "gone" | "unknown";

export function processMatch(known: ProcRow, now: ProcRow | undefined): ProcessMatch {
  if (!now || now.stat.startsWith("Z")) return "gone";
  if (known.identity === null || now.identity === null) return "unknown";
  if (known.identity === now.identity) return "alive";
  const before = Date.parse(known.identity), after = Date.parse(now.identity);
  return Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) <= 2000 ? "alive" : "gone";
}

/** 记下的进程现在还是不是同一个活进程;身份缺失时按不活返回,确认调用方必须另行处理 unknown。 */
export function stillAlive(known: ProcRow, table: readonly ProcRow[]): boolean {
  const now = table.find((r) => r.pid === known.pid);
  return processMatch(known, now) === "alive";
}
