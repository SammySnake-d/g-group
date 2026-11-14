// 停止确认(AC-23,需求 §8.1 已定第 16 条:停止照 mirasim、不用容器,
// 「助手启动的程序及其子程序全部找出来关掉、确认都退出才显示已停止;交给系统后台托管的程序找不到也关不掉」)。
// 一次性适配器(adapter.ts)与常驻适配器(resident.ts)共用:读进程表找后代,主进程退出之后把还活着的 SIGKILL,轮询到都退出。
// 父子链在停止前就断了的(双 fork 守护进程、launchd 托管)找不到,不在保证范围。只读 ps / pgrep,确认循环之外不发信号。
import { execFileSync } from "node:child_process";
import { type ProcRow, processMatch, processTable, treeByPgrep, treeOf } from "./procgroup.ts";
import type { QuiesceResult } from "./types.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 当前进程表;只读 ps,不发信号 */
const procs = () => processTable(() => execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
/** pgrep:有匹配给 pid 列表,没有匹配(退出码 1)给 [],其它失败给 null */
const pgrep = (args: readonly string[]): readonly number[] | null => {
  try {
    return execFileSync("pgrep", [...args], { encoding: "utf8" }).split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim()));
  } catch (e) {
    return (e as { status?: unknown }).status === 1 ? [] : null;
  }
};
/** root 的后代与同组成员:先用 ps,读不到退到 pgrep;都读不到返回 null */
export const treeNow = (root: number): readonly ProcRow[] | null => {
  const t = procs();
  return t ? treeOf(root, t) : treeByPgrep(root, pgrep);
};
/** CLI 主进程 root 已退出之后调用:停止时记下的后代(before)+ 此刻还在 root 进程组里的成员,还活着的全部 SIGKILL,
 *  轮询到都退出或 timeoutMs 到期。停止时和此刻都读不到进程表就不能确认(读不到 ≠ 没有) */
export async function confirmStopped(root: number, before: readonly ProcRow[] | null, timeoutMs: number): Promise<QuiesceResult> {
  const now = treeNow(root);
  if (before === null && now === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };
  const known = new Map<number, ProcRow>();
  for (const r of before ?? []) known.set(r.pid, r);
  for (const r of now ?? []) if (!known.has(r.pid)) known.set(r.pid, r);
  const killed = new Set<number>();
  const t0 = Date.now();
  for (;;) {
    const table = procs();
    if (table === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [...known.keys()] };
    const alive: ProcRow[] = [];
    const unknown: ProcRow[] = [];
    for (const knownRow of known.values()) {
      const match = processMatch(knownRow, table.find((r) => r.pid === knownRow.pid));
      if (match === "alive") alive.push(knownRow);
      else if (match === "unknown") unknown.push(knownRow);
    }
    if (unknown.length) return { ok: false, reason: "无法核对进程启动身份,不能确认已停止", remaining: unknown.map((r) => r.pid) };
    if (!alive.length) return { ok: true, killed: killed.size };
    if (Date.now() - t0 > timeoutMs) return { ok: false, reason: `还有 ${alive.length} 个进程没退出`, remaining: alive.map((r) => r.pid) };
    for (const r of alive) { try { process.kill(r.pid, "SIGKILL"); killed.add(r.pid); } catch { /* 刚退出 */ } }
    await delay(50);
  }
}
