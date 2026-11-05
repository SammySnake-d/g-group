// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly zombie: boolean;
  readonly start: string;
}

export function parsePs(out: string): Proc[] {
  throw new Error("未实现");
}

export function listProcs(): Promise<Proc[] | null> {
  throw new Error("未实现");
}

export function ownPgid(): number {
  throw new Error("未实现");
}

export type ProcLister = () => Promise<Proc[] | null>;

export class DescendantTree {
  constructor(root: number, list?: ProcLister) {
    throw new Error("未实现");
  }

  async sample(): Promise<boolean> {
    throw new Error("未实现");
  }

  signalRootNow(sig: NodeJS.Signals): void {
    throw new Error("未实现");
  }

  async reap(graceMs: number, hardMs?: number, first?: NodeJS.Signals): Promise<boolean> {
    throw new Error("未实现");
  }

  async freezeAndReap(hardMs?: number): Promise<boolean> {
    throw new Error("未实现");
  }
}
