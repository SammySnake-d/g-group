// 进程组信号。对照 mirasim 0.0.774 server-main.cjs(用户 g-group#2309 定"按照 mirasim 的做法来"):
// - POSIX 上 CLI 以 detached:true 启动,自成进程组;Windows 不 detached。
// - 停止(z2 的 l2 → MLe)只对 CLI 主进程发 SIGTERM;reapForceMs 后主进程仍未退出才对进程组 SIGKILL(k2 → FG,process.kill(-pid));
//   主进程先退出就清掉这个计时器(j2)。主进程已退出时 z2 什么都不发。
// - 不按 ppid 遍历后代树、不追 setsid 脱组的进程、报停止前不确认任何进程已退出。
// - 已受理 blocked 时对进程组 SIGSTOP 是本适配器自己的做法,mirasim 0.0.774 没有对照(非 mirasim 对照项)。
export const IS_WINDOWS = process.platform === "win32";

/** 对 CLI 的进程组发信号(mirasim 的 FG);pid 不合法(≤1)时什么都不做,永远不会落到 kill(0)/kill(-1) */
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
//      「助手启动的程序及其子程序全部找出来关掉、确认都退出才显示已停止;交给系统后台托管的程序找不到也关不掉」)----
// 上面的 mirasim 对照只管「发停止」;这里管「确认停下」:按进程表找 CLI 主进程的后代(含 setsid 脱组但父子链还在的)与同进程组成员,
// 主进程退出后把还活着的全部 SIGKILL,轮询到都退出。父子链在停止前就断了的(双 fork 守护进程、launchd 托管)找不到,不在保证范围。

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** ps 的 stat;Z 开头是已退出待回收 */
  readonly stat: string;
}

/** 当前进程表(POSIX ps);命令执行失败返回 null(读不到 ≠ 没有进程,调用方不能当成「都退出了」) */
export function processTable(run: () => string): readonly ProcRow[] | null {
  let out = "";
  try { out = run(); } catch { return null; }
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4]! });
  }
  return rows;
}

/** root 的全部后代(按 ppid 链)与同进程组(pgid = root)成员,不含 root 自己;已是僵尸的不算 */
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
 * 找到的行进程组未知记 -1,之后只能按 pid 判断是否还活着。
 */
export function treeByPgrep(root: number, pgrep: (args: readonly string[]) => readonly number[] | null): readonly ProcRow[] | null {
  const found = new Map<number, ProcRow>();
  let frontier = [root];
  while (frontier.length) {
    const next: number[] = [];
    for (const parent of frontier) {
      const kids = pgrep(["-P", String(parent)]);
      if (kids === null) return null;
      for (const k of kids) if (k > 1 && k !== root && !found.has(k)) { found.set(k, { pid: k, ppid: parent, pgid: -1, stat: "?" }); next.push(k); }
    }
    frontier = next;
  }
  const group = pgrep(["-g", String(root)]);
  if (group === null) return null;
  for (const k of group) if (k > 1 && k !== root && !found.has(k)) found.set(k, { pid: k, ppid: -1, pgid: root, stat: "?" });
  return [...found.values()];
}

/** 记下的进程现在还是不是同一个、还活着:pid 与进程组都对得上且不是僵尸(防 pid 被复用误杀) */
export function stillAlive(known: ProcRow, table: readonly ProcRow[]): boolean {
  const now = table.find((r) => r.pid === known.pid);
  return now !== undefined && now.pgid === known.pgid && !now.stat.startsWith("Z");
}
