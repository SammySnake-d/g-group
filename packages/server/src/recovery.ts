// AC-15 工作树恢复：Git 副作用与 SQLite 意图分别落盘。
import type { Db } from "./db.ts";
import type { Workspace, Worktrees } from "./worktree.ts";
export interface DeliveryCheckpoint { taskId: string; deliveryId: string; ordinal: number; resultVer: number; artifact: string; candidateSha: string }
export interface RestoreIntent { taskId: string; ver: number; targetSha: string; backupRef: string; actionId: string; phase: "pending" | "done"; error: string | null; backupSha: string | null }
export class RecoveryStore {
  readonly db: Db;
  readonly worktrees: Worktrees;
  constructor(db: Db, worktrees: Worktrees) { this.db = db; this.worktrees = worktrees; }
  initialize(_ws: Workspace): void {}
  record(_checkpoint: Omit<DeliveryCheckpoint, "ordinal">): void { throw new Error("A 待实现 record"); }
  history(_taskId: string): DeliveryCheckpoint[] { throw new Error("A 待实现 history"); }
  target(_ws: Workspace, _ver: number, _artifact: string): string | null { throw new Error("A 待实现 target"); }
  enqueue(_input: Omit<RestoreIntent, "phase" | "error" | "backupSha" | "backupRef">): RestoreIntent { throw new Error("A 待实现 enqueue"); }
  current(_taskId: string): RestoreIntent | null { throw new Error("A 待实现 current"); }
  execute(_taskId: string, _done: (intent: RestoreIntent, ws: Workspace) => void): void { throw new Error("A 待实现 execute"); }
}
