// G1：检查覆盖与 md 写入意图不是第三份摘要，不进入模型请求；沿用 docs/CAS 与原重试策略。
import { decideRetry, type MemoryEntry, type RetryPolicy, type HealClass } from "@g-group/kernel";
import { type Db, getDoc, putDoc, listDocs, tx } from "./db.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  disposition: string | null; upstream: string; alerted: boolean; failureHeal?: HealClass;
}
const key = (id: string) => `memory-coverage:${id}`;
export class MemoryCoverage {
  readonly db: Db; readonly memory: MemoryStore;
  constructor(db: Db, memory: MemoryStore) { this.db = db; this.memory = memory; }
  private set(id: string, change: Partial<CoverageWork>): CoverageWork { throw new Error("P1-A compile-only stub"); }
  begin(contactId: string, sources: readonly CoverageRef[], inboxIds: readonly number[], rooms: readonly string[], upstream: string): CoverageWork { throw new Error("P1-A compile-only stub"); }
  get(id: string): CoverageWork { throw new Error("P1-A compile-only stub"); }
  list(contactId?: string): CoverageWork[] { throw new Error("P1-A compile-only stub"); }
  start(id: string): void { throw new Error("P1-A compile-only stub"); }
  prepare(id: string, writes: readonly CaptureWrite[], unresolved: number): void { throw new Error("P1-A compile-only stub"); }
  apply(id: string, notify?: (q: { roomId: string; text: string }, actionId: string) => void): void { throw new Error("P1-A compile-only stub"); }
  invalidate(id: string, reason: string): void { throw new Error("P1-A compile-only stub"); }
  fail(id: string, error: string, heal: HealClass, policy: RetryPolicy, now: number, rand?: () => number): void { throw new Error("P1-A compile-only stub"); }
  due(contactId: string, now: number): CoverageWork[] { throw new Error("P1-A compile-only stub"); }
  retry(id: string): void { throw new Error("P1-A compile-only stub"); }
  unblock(upstream: string): void { throw new Error("P1-A compile-only stub"); }
  markAlerted(id: string): void { throw new Error("P1-A compile-only stub"); }
  dirty(contactId: string): boolean { throw new Error("P1-A compile-only stub"); }
}
