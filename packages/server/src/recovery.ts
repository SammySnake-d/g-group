// AC-15 工作树恢复：Git 副作用与 SQLite 意图分别落盘；不把 phase 当作备份存在证明。
import { type Db, getDoc, putDoc, tx, HostError } from "./db.ts";
import type { Workspace, Worktrees } from "./worktree.ts";
export interface DeliveryCheckpoint { taskId: string; deliveryId: string; ordinal: number; resultVer: number; artifact: string; candidateSha: string }
export interface RestoreIntent { taskId: string; ver: number; targetSha: string; backupRef: string; actionId: string; phase: "pending" | "done"; error: string | null; backupSha: string | null }
export class RecoveryStore {
  readonly db: Db;
  readonly worktrees: Worktrees;
  constructor(db: Db, worktrees: Worktrees) { this.db = db; this.worktrees = worktrees; }
  /** 仅在新工作树创建事务里调用；升级旧工作树不得补造“历史完整”标记。 */
  initialize(ws: Workspace): void {
    const key = `delivery-origin:${ws.taskId}`;
    const old = getDoc<string>(this.db, key);
    if (old) {
      if (old.value !== ws.baseSha) throw new HostError("conflict", "checkpoint-unavailable: 工作树代次不一致");
      return;
    }
    putDoc(this.db, key, 0, ws.baseSha);
  }
  record(checkpoint: Omit<DeliveryCheckpoint, "ordinal">): void {
    const key = `delivery-history:${checkpoint.taskId}`;
    const cur = getDoc<DeliveryCheckpoint[]>(this.db, key);
    const entries = cur?.value ?? [];
    const prior = entries.find(c => c.deliveryId === checkpoint.deliveryId);
    if (prior) {
      if (prior.artifact !== checkpoint.artifact || prior.resultVer !== checkpoint.resultVer || prior.candidateSha !== checkpoint.candidateSha) throw new HostError("conflict", "交付身份与已登记历史不一致");
      return;
    }
    putDoc(this.db, key, cur?.ver ?? 0, [...entries, { ...checkpoint, ordinal: (entries.at(-1)?.ordinal ?? 0) + 1 }]);
  }
  history(taskId: string): DeliveryCheckpoint[] { return getDoc<DeliveryCheckpoint[]>(this.db, `delivery-history:${taskId}`)?.value ?? []; }
  target(ws: Workspace, ver: number, artifact: string): string | null {
    const entries = this.history(ws.taskId);
    if (!entries.length) return null;
    const origin = getDoc<string>(this.db, `delivery-origin:${ws.taskId}`)?.value;
    if (origin !== undefined && origin !== ws.baseSha) throw new HostError("conflict", "checkpoint-unavailable: 工作树代次不一致");
    if (!entries.some(c => c.taskId === ws.taskId && c.resultVer === ver && c.artifact === artifact)) {
      // 升级前的交付可能与首条新记录同版本；版本单调，首条之后的缺失则是真正不匹配。
      if (origin === undefined && ver <= entries[0]!.resultVer) return null;
      throw new HostError("conflict", "checkpoint-unavailable: fromArtifact 不属于本任务交付历史");
    }
    const prior = entries.filter(c => c.resultVer < ver).sort((a, b) => b.ordinal - a.ordinal)[0];
    if (!prior && origin === undefined) return null;
    const sha = prior?.candidateSha ?? ws.baseSha;
    this.worktrees.validateRecovery(ws, sha);
    return sha;
  }
  enqueue(input: Omit<RestoreIntent, "phase" | "error" | "backupSha" | "backupRef">): RestoreIntent {
    const key = `restore:${input.taskId}:${input.ver}`;
    const old = getDoc<RestoreIntent>(this.db, key)?.value;
    if (old) {
      if (old.targetSha !== input.targetSha || old.actionId !== input.actionId) throw new HostError("conflict", "恢复身份冲突");
      return old;
    }
    const intent: RestoreIntent = { ...input, backupRef: `refs/gg/backup/${Buffer.from(input.taskId).toString("hex")}/${input.ver}`, phase: "pending", error: null, backupSha: null };
    putDoc(this.db, key, 0, intent);
    const pointer = getDoc<string>(this.db, `restore-current:${input.taskId}`);
    putDoc(this.db, `restore-current:${input.taskId}`, pointer?.ver ?? 0, key);
    return intent;
  }
  current(taskId: string): RestoreIntent | null {
    const key = getDoc<string>(this.db, `restore-current:${taskId}`)?.value;
    return key ? getDoc<RestoreIntent>(this.db, key)?.value ?? null : null;
  }
  execute(taskId: string, done: (intent: RestoreIntent, ws: Workspace) => void): void {
    const intent = this.current(taskId);
    if (!intent || intent.phase === "done") return;
    const key = `restore:${taskId}:${intent.ver}`;
    try {
      const doc = getDoc<Workspace>(this.db, `ws:${taskId}`);
      if (!doc) throw new Error("恢复工作树不存在");
      const ws = { ...doc.value, recovery: { ver: intent.ver, backupRef: intent.backupRef } };
      const backup = this.worktrees.backup(ws);
      const restored = this.worktrees.restoreTo(ws, intent.targetSha);
      tx(this.db, () => {
        const cur = getDoc<RestoreIntent>(this.db, key)!;
        putDoc(this.db, `ws:${taskId}`, doc.ver, restored);
        const completed: RestoreIntent = { ...intent, phase: "done", error: null, backupSha: backup.backupSha };
        putDoc(this.db, key, cur.ver, completed);
        done(completed, restored);
      });
    } catch (error) {
      const cur = getDoc<RestoreIntent>(this.db, key)!;
      putDoc(this.db, key, cur.ver, { ...cur.value, error: String(error) });
      throw error;
    }
  }
}
