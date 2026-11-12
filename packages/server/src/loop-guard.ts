// 联系人派生唤醒按稳定因果根共享额度；不是话题语义分类。
import type { Inbound } from "@g-group/kernel";
import type { Db } from "./db.ts";

export interface LoopLimits {
  readonly maxHops?: number;
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
  constructor(_db: Db, _limits: LoopLimits = {}, _clock: () => number = Date.now) {}
  recordMessage(_roomId: string, _seq: number, _roots: readonly string[]): void {}
  rootsOf(_roomId: string, _seq: number): string[] { return []; }
  rootsFor(_fresh: readonly Inbound[], _roomId: string): string[] { return []; }
  admit(_roomId: string, _seq: number, _contactId: string): WakeDecision { return { allowed: false, duplicate: false, roots: [], reason: "hops" }; }
  pending(): BlockedWake[] { return []; }
}
