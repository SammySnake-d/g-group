// 一轮 Compute 的已知后代树:从 CLI 进程出发,按 ppid 递归找后代,并把这些进程所在进程组的成员一并纳入。
// 用 ps 采样;每个进程按 pid + 启动时间记身份,pid 被系统复用给无关进程时不会误发信号。
//
// 覆盖范围(scope: "descendant-tree"):只覆盖采样时还挂在这棵树上的进程。双 fork 后在采样之前就被
// init/launchd 收养的守护进程、经 launchd/systemd 等托管另起的进程不在范围内。内核不得把"后代树已空"
// 当成容器级静止;完全隔离归 placement=cloud_sandbox / 容器,不在本片。
import { execFile, execFileSync } from "node:child_process";

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly zombie: boolean;
  readonly start: string;
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4]!.startsWith("Z"), start: m[5]! });
  }
  return procs;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="];
const PS_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };

/** 全系统进程表;ps 失败返回 null(调用方当作"无法确认",不能当作树已空) */
export function listProcs(): Promise<Proc[] | null> {
  return new Promise((resolve) => {
    execFile("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: PS_ENV }, (err, stdout) => resolve(err ? null : parsePs(stdout)));
  });
}

let own: number | undefined;
/** 宿主自己所在的进程组:永远不对它发组信号 */
export function ownPgid(): number {
  if (own === undefined) own = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", env: PS_ENV }).trim());
  return own;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 只对 >1 的 pid 或 <-1 的进程组发信号:kill(0)/kill(-1)/kill(1) 会打到宿主自己的组、本用户全部进程或 init,永远不发 */
const send = (target: number, sig: NodeJS.Signals) => {
  if (!Number.isInteger(target) || (target >= -1 && target <= 1)) return;
  try { process.kill(target, sig); } catch { /* 已退出或无权限 */ }
};

export type ProcLister = () => Promise<Proc[] | null>;

export class DescendantTree {
  /** pid → 启动时间 */
  private readonly known = new Map<number, string>();
  private readonly list: ProcLister;
  private readonly root: number;

  constructor(root: number, list: ProcLister = listProcs) {
    this.root = root;
    this.list = list;
  }

  /** 采样一次,把根进程、ppid 递归后代、已知进程所在组的成员并入已知集合;ps 失败返回 false */
  async sample(): Promise<boolean> {
    const procs = await this.list();
    if (!procs) return false;
    this.absorb(procs);
    return true;
  }

  private groupOk(pgid: number): boolean {
    return pgid > 1 && pgid !== ownPgid();
  }

  private absorb(procs: readonly Proc[]): void {
    const live = procs.filter((p) => !p.zombie);
    const byPid = new Map(live.map((p) => [p.pid, p]));
    const root = this.root > 1 ? byPid.get(this.root) : undefined;
    if (root && !this.known.has(this.root)) this.known.set(this.root, root.start);
    const seeds = new Set([...this.known].filter(([pid, start]) => byPid.get(pid)?.start === start).map(([pid]) => pid));
    const groups = new Set([...seeds].map((pid) => byPid.get(pid)!.pgid).filter((g) => this.groupOk(g)));
    for (let grew = true; grew;) {
      grew = false;
      for (const p of live) {
        if (seeds.has(p.pid) || !(seeds.has(p.ppid) || groups.has(p.pgid))) continue;
        seeds.add(p.pid);
        this.known.set(p.pid, p.start);
        if (this.groupOk(p.pgid)) groups.add(p.pgid);
        grew = true;
      }
    }
  }

  /** 已知集合里仍存活(非僵尸、启动时间对得上)的进程 */
  private alive(procs: readonly Proc[]): Proc[] {
    return procs.filter((p) => !p.zombie && this.known.get(p.pid) === p.start);
  }

  private signal(procs: readonly Proc[], sig: NodeJS.Signals): void {
    const alive = this.alive(procs);
    for (const g of new Set(alive.map((p) => p.pgid).filter((g) => this.groupOk(g)))) send(-g, sig);
    for (const p of alive) send(p.pid, sig);
  }

  /** 不等 ps,立刻对根进程和根进程组发信号(冻结用,越早越好) */
  signalRootNow(sig: NodeJS.Signals): void {
    if (this.root <= 1) return;
    if (this.groupOk(this.root)) send(-this.root, sig);
    send(this.root, sig);
  }

  /** 回收整棵已知后代树:先发 first(默认 SIGTERM),graceMs 后 SIGKILL;确认已知树里没有存活进程才返回 true。
   *  再过 hardMs 仍有存活,或 ps 一直失败,返回 false。 */
  async reap(graceMs: number, hardMs = 5000, first: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
    const t0 = Date.now();
    let escalated = first === "SIGKILL";
    const initial = await this.list();
    if (initial) {
      this.absorb(initial);
      this.signal(initial, first);
    } else this.signalRootNow(first);
    for (;;) {
      const procs = await this.list();
      if (!escalated && Date.now() - t0 >= graceMs) escalated = true;
      if (procs) {
        this.absorb(procs);
        if (this.alive(procs).length === 0) return true;
        if (escalated) this.signal(procs, "SIGKILL");
      } else if (escalated) this.signalRootNow("SIGKILL"); // 看不到进程表:至少对根进程组下手,但不能据此判定已空
      if (Date.now() - t0 >= graceMs + hardMs) return false;
      await delay(25);
    }
  }

  /** 冻结:立刻 SIGSTOP 根进程组,采样后 SIGSTOP 整棵已知树,再直接 SIGKILL 回收(冻结的进程收不到 SIGTERM) */
  async freezeAndReap(hardMs = 5000): Promise<boolean> {
    this.signalRootNow("SIGSTOP");
    const procs = await this.list();
    if (procs) {
      this.absorb(procs);
      this.signal(procs, "SIGSTOP");
    }
    return this.reap(0, hardMs, "SIGKILL");
  }
}
