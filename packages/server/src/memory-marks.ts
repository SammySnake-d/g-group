// G5 待精筛标记与写入器代次(BC 定稿 v0.2 §7;G1→G5 写入切换规则,审查条件 S-1/S-2)。红提交:只有签名与假返回值。
// 「粗筛 / 精筛」是记忆提炼的两段,不是 D06 找旧消息的粗筛/精筛(G4)。
import type { HealClass, MarkKind, RetryPolicy } from "@g-group/kernel";
import type { Db } from "./db.ts";

export interface MarkOrigin {
  readonly coverageId: string;
  readonly candidateKey: string;
  readonly takeover: boolean;
}
export interface MemoryMark {
  readonly id: string;
  readonly contactId: string;
  readonly roomId: string;
  readonly seq: number;
  readonly revision: number;
  readonly kind: MarkKind;
  readonly evidence: string | null;
  readonly origin: MarkOrigin;
  readonly state: "pending" | "done" | "disposed";
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly blocked: boolean;
  readonly error: string | null;
  readonly failureHeal?: HealClass;
  readonly askedTarget: boolean;
  readonly createdAt: number;
  readonly disposition: string | null;
  readonly next: string | null;
  readonly doneBy: string | null;
}
export interface FineLease {
  readonly holder: string;
  readonly boot: string;
  readonly until: number;
}

export class MemoryMarks {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  addTx(_marks: readonly MemoryMark[]) {
    return 0;
  }
  get(_contactId: string, _id: string): MemoryMark | null {
    return null;
  }
  list(_contactId?: string): MemoryMark[] {
    return [];
  }
  open(_contactId: string): MemoryMark[] {
    return [];
  }
  due(_contactId: string, _now: number): MemoryMark[] {
    return [];
  }
  done(_contactId: string, _id: string, _batchId: string): void {}
  dispose(_contactId: string, _id: string, _reason: string, _next: string | null): void {}
  fail(_contactId: string, _id: string, _error: string, _heal: HealClass, _policy: RetryPolicy, _now: number, _rand?: () => number, _stallJudged = false): MemoryMark | null {
    return null;
  }
  askedTarget(_contactId: string, _id: string): void {}
  unblock(_contactId: string): void {}
  claimLease(_contactId: string, _holder: string, _boot: string, _now: number, _leaseMs: number) {
    return false;
  }
  releaseLease(_contactId: string, _holder: string): void {}
  lease(_contactId: string): FineLease | null {
    return null;
  }
  generation(_contactId: string) {
    return 1;
  }
  switchTx(_contactId: string, _at: number): void {}
}
