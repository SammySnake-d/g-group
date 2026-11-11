// G1：检查覆盖与 md 写入意图不是第三份摘要，不进入模型请求；沿用 docs/CAS 与原重试策略。
import type { MemoryEntry, RetryPolicy, HealClass } from "@g-group/kernel";
import type { Db } from "./db.ts";
import type { MemoryStore } from "./memory-store.ts";
export interface CoverageRef { roomId: string; seq: number; revision: number }
export interface CaptureWrite {
  id: string;
  before: readonly (MemoryEntry | null)[];
  after: readonly MemoryEntry[];
  question: { roomId: string; text: string } | null;
}
export interface CoverageWork {
  id: string; contactId: string; sources: readonly CoverageRef[]; inboxIds: readonly number[]; rooms: readonly string[];
  state: "pending" | "failed" | "ok"; attempts: number; retryAt: number | null; blocked: boolean; error: string | null;
  writes: readonly CaptureWrite[] | null; writesDone: boolean; unresolved: number;
  disposition: string | null; upstream: string; alerted: boolean;
}
export class MemoryCoverage {
  readonly db: Db; readonly memory: MemoryStore;
  constructor(db: Db, memory: MemoryStore) { this.db = db; this.memory = memory; }
  begin(_contactId: string, _sources: readonly CoverageRef[], _inboxIds: readonly number[], _rooms: readonly string[], _upstream: string): CoverageWork { throw new Error("G1 待实现覆盖登记"); }
  get(_id: string): CoverageWork { throw new Error("G1 待实现覆盖读取"); }
  list(_contactId?: string): CoverageWork[] { throw new Error("G1 待实现覆盖列表"); }
  start(_id: string): void { throw new Error("G1 待实现检查认领"); }
  prepare(_id: string, _writes: readonly CaptureWrite[], _unresolved: number): void { throw new Error("G1 待实现规范化结果"); }
  apply(_id: string, _notify?: (q: { roomId: string; text: string }, actionId: string) => void): void { throw new Error("G1 待实现幂等落地"); }
  invalidate(_id: string, _reason: string): void { throw new Error("G1 待实现来源处置"); }
  fail(_id: string, _error: string, _heal: HealClass, _policy: RetryPolicy, _now: number, _rand?: () => number): void { throw new Error("G1 待实现失败记账"); }
  due(_contactId: string, _now: number): CoverageWork[] { throw new Error("G1 待实现补查选择"); }
  retry(_id: string): void { throw new Error("G1 待实现显式重试"); }
  unblock(_upstream: string): void { throw new Error("G1 待实现上游恢复"); }
  markAlerted(_id: string): void { throw new Error("G1 待实现告警幂等"); }
  dirty(_contactId: string): boolean { throw new Error("G1 待实现写入栅栏"); }
}
