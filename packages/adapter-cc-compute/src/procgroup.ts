// 进程组信号。停止语义对齐 mirasim 0.0.774(server-main.cjs)的做法,用户在 g-group#2309 定为"按照 mirasim 的做法来":
// - POSIX 上 CLI 以 detached:true 启动,自成进程组;Windows 不 detached,只能对 CLI 进程本身发信号。
// - 停止对整个进程组发 SIGTERM,立即把这一轮标为已停止,不等进程退出确认;
// - 过了 reapForceMs(默认 10000,对应 mirasim 的 MIRASIM_REAP_FORCE_MS)进程组仍有进程,对进程组发 SIGKILL。
// - 不按 ppid 遍历后代树、不追 setsid 脱组的进程、报停止前不确认进程树为空。
//   所以 stopped 的范围是 scope:"process-group":脱离进程组的后代(setsid、双 fork 守护进程、launchd/systemd 托管)不覆盖。
export const IS_WINDOWS = process.platform === "win32";

/** 对 CLI 的进程组发信号;pid 不合法(≤1)时什么都不做,永远不会落到 kill(0)/kill(-1) */
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

/** 进程组里是否还有进程(Windows 上只看 CLI 进程本身) */
export function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(IS_WINDOWS ? pid : -pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
