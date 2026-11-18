import type { Inbound } from "@g-group/kernel";
import type { Db } from "./db.ts";

export interface LoopLimits {
  /** 每个因果根最多派生多少次联系人唤醒，默认 4（候选，待实测）。 */
  readonly maxHops?: number;
  /** 滚动一分钟上限；null 不另加频率限制，总次数仍有限。 */
  readonly maxPerMinute?: number | null;
}
export interface WakeDecision {
  readonly allowed: boolean;
  readonly duplicate: boolean;
  readonly roots: readonly string[];
  readonly reason: "hops" | "rate" | null;
}
export interface BlockedWake {
  readonly roomId: string;
  readonly seq: number;
  readonly contactId: string;
  readonly roots: readonly string[];
  readonly reason: "hops" | "rate";
}
export class LoopGuard {
  constructor(_db: Db, _limits?: LoopLimits, _clock?: () => number) {}
  recordMessage(_roomId: string, _seq: number, _roots: readonly string[]): void {}
  rootsOf(_roomId: string, _seq: number): string[] { return []; }
  taskRoots(_taskId: string): string[] { return []; }
  rootsFor(_fresh: readonly Inbound[], _roomId: string): string[] { return []; }
  admit(_roomId: string, _seq: number, _contactId: string): WakeDecision {
    return { allowed: true, duplicate: false, roots: [], reason: null };
  }
  isStopped(_roomId: string, _seq: number): boolean { return false; }
  blockedWakes(): BlockedWake[] { return []; }
}
