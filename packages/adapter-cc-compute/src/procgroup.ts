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

/** 当前 POSIX 进程组确已不存在。信号 0 只询问内核，不改变停止信号路径。
 *  只有 ESRCH 是确认；存在、权限不足、未知 pid 与 Windows 都保持未确认。
 *  不把僵尸/冻结进程当作已回收，也不把同组确认冒充脱组后代或容器隔离证明。 */
export function groupExited(pid: number | undefined): boolean {
  if (IS_WINDOWS || pid === undefined || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
}
