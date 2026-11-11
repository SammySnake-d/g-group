// G5 待精筛标记与写入器代次(BC 定稿 v0.2 §7;G1→G5 写入切换规则,审查条件 S-1/S-2)。
// 「粗筛 / 精筛」是记忆提炼的两段,不是 D06 找旧消息的粗筛/精筛(G4)。
// 标记是未完成的提炼工作,不是记忆真源、不进模型请求、不是记忆审批区;和 G1 覆盖台账同库(gg_doc),出口在宿主的同一个 SQLite 事务里选定。
// 写入器代次按联系人记(S-1):没有记录就是第 1 代(G1 直接写);切到 2 以后不回退。回退 G5 代码时这些文档原样留下,G1 代码不读也不删。
import { decideRetry, type HealClass, type MarkKind, type RetryPolicy } from "@g-group/kernel";
import { type Db, getDoc, HostError, listDocs, putDoc } from "./db.ts";

export interface MarkOrigin {
  /** 产出这个标记的覆盖工作(粗筛那一批) */
  readonly coverageId: string;
  /** S-2 的候选身份:房间 + seq + 消息版本 + kind + 规范化 evidence 哈希 */
  readonly candidateKey: string;
  /** 来自接管的 G1 待复查项(身份 = coverageId + candidateKey + sourceRevision) */
  readonly takeover: boolean;
}
export interface MemoryMark {
  readonly id: string;
  readonly contactId: string;
  readonly roomId: string;
  readonly seq: number;
  readonly revision: number;
  readonly kind: MarkKind;
  /** 原话;来源编辑、撤回或失权后清空,只留处置记录 */
  readonly evidence: string | null;
  readonly origin: MarkOrigin;
  readonly state: "pending" | "done" | "disposed";
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly blocked: boolean;
  readonly error: string | null;
  readonly failureHeal?: HealClass;
  /** 缺 target 已回问过一次 */
  readonly askedTarget: boolean;
  readonly createdAt: number;
  readonly disposition: string | null;
  /** 来源编辑后接手的新版工作项(覆盖工作 id) */
  readonly next: string | null;
  /** 完成它的精筛批次 */
  readonly doneBy: string | null;
}
export interface FineLease {
  readonly holder: string;
  readonly boot: string;
  readonly until: number;
}
const markKey = (contactId: string, id: string) => `memory-mark:${contactId}:${id}`;
const leaseKey = (contactId: string) => `memory-fine-lease:${contactId}`;
const writerKey = (contactId: string) => `memory-writer:${contactId}`;

export class MemoryMarks {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  /** 加一批标记(必须在调用方事务里);同一联系人下同一身份已存在就跳过,返回实际新增条数 */
  addTx(marks: readonly MemoryMark[]) {
    let added = 0;
    for (const m of marks) {
      if (getDoc(this.db, markKey(m.contactId, m.id))) continue;
      // 新文档落盘后版本必须是 1;不是就说明并发写过,整次事务回滚
      if (putDoc(this.db, markKey(m.contactId, m.id), 0, m) !== 1) throw new HostError("conflict", `标记 ${m.id} 不是新建`);
      added++;
    }
    return added;
  }
  get(contactId: string, id: string): MemoryMark | null {
    return getDoc<MemoryMark>(this.db, markKey(contactId, id))?.value ?? null;
  }
  list(contactId?: string): MemoryMark[] {
    return listDocs<MemoryMark>(this.db, contactId === undefined ? "memory-mark:" : `memory-mark:${contactId}:`).map((d) => d.value);
  }
  /** 还欠着的(含已到重试上限而挡住的):不因上限、条数或缓存换代被清掉 */
  open(contactId: string): MemoryMark[] {
    return this.list(contactId).filter((m) => m.state === "pending");
  }
  /** 现在可以交精筛的 */
  due(contactId: string, now: number): MemoryMark[] {
    return this.open(contactId).filter((m) => !m.blocked && (m.retryAt ?? 0) <= now);
  }
  private set(contactId: string, id: string, change: Partial<MemoryMark>): MemoryMark {
    const d = getDoc<MemoryMark>(this.db, markKey(contactId, id));
    if (!d) throw new HostError("not_found", `没有标记 ${id}`);
    const next = { ...d.value, ...change };
    if (putDoc(this.db, markKey(contactId, id), d.ver, next) !== d.ver + 1) throw new HostError("conflict", `标记 ${id} 版本没有按 CAS 前进`);
    return next;
  }
  /** 精筛给了明确结果(含「没有值得记的」);写入计划已与它在同一事务里落盘 */
  done(contactId: string, id: string, batchId: string): void {
    this.set(contactId, id, { state: "done", doneBy: batchId, error: null, retryAt: null });
  }
  /** 来源编辑、撤回或失权:作废旧原话,只留处置原因;编辑时 next 指向新版工作项 */
  dispose(contactId: string, id: string, reason: string, next: string | null): void {
    this.set(contactId, id, { state: "disposed", evidence: null, disposition: reason, next, retryAt: null });
  }
  /** 精筛失败:按现成重试策略退避;到上限只挡住自动重试,标记仍是欠账 */
  fail(contactId: string, id: string, error: string, heal: HealClass, policy: RetryPolicy, now: number, rand?: () => number, stallJudged = false): MemoryMark {
    const m = this.get(contactId, id);
    if (!m) throw new HostError("not_found", `没有标记 ${id}`);
    const d = decideRetry({ heal, effect: "B0", attempts: m.attempts, stallJudged }, policy, rand);
    return this.set(contactId, id, {
      error: error.slice(0, 4000),
      failureHeal: heal,
      attempts: d.kind === "retry" ? d.attempt : m.attempts,
      retryAt: d.kind === "retry" ? now + d.delayMs : null,
      blocked: d.kind !== "retry",
    });
  }
  askedTarget(contactId: string, id: string): void {
    this.set(contactId, id, { askedTarget: true });
  }
  /** 熔断恢复后放开因鉴权/额度挡住的标记(与 G1 覆盖同一条路径) */
  unblock(contactId: string): void {
    for (const m of this.open(contactId)) if (m.blocked && m.failureHeal === "A2") this.set(contactId, m.id, { blocked: false, retryAt: 0, attempts: 0 });
  }

  /** 单联系人一次一个精筛租约(CAS):没有、已过期、或上一次宿主启动留下的才领得到 */
  claimLease(contactId: string, holder: string, boot: string, now: number, leaseMs: number) {
    const cur = getDoc<FineLease>(this.db, leaseKey(contactId));
    if (cur && cur.value.until > now && cur.value.boot === boot && cur.value.holder !== holder) return false;
    try {
      // CAS 领到才算:版本恰好前进一位
      return putDoc(this.db, leaseKey(contactId), cur?.ver ?? 0, { holder, boot, until: now + leaseMs } satisfies FineLease) === (cur?.ver ?? 0) + 1;
    } catch (e) {
      if (e instanceof HostError && e.code === "conflict") return false;
      throw e;
    }
  }
  releaseLease(contactId: string, holder: string): void {
    const cur = getDoc<FineLease>(this.db, leaseKey(contactId));
    if (cur && cur.value.holder === holder) putDoc(this.db, leaseKey(contactId), cur.ver, { ...cur.value, until: 0 });
  }
  lease(contactId: string): FineLease | null {
    return getDoc<FineLease>(this.db, leaseKey(contactId))?.value ?? null;
  }

  /** S-1:联系人的自动写入器代次;没有记录是第 1 代 */
  generation(contactId: string) {
    return getDoc<{ generation: number }>(this.db, writerKey(contactId))?.value.generation ?? 1;
  }
  /** 切到第 2 代(必须在调用方事务里,和接管 G1 待复查项一起落盘) */
  switchTx(contactId: string, at: number): void {
    const cur = getDoc<{ generation: number; at: number }>(this.db, writerKey(contactId));
    putDoc(this.db, writerKey(contactId), cur?.ver ?? 0, { generation: 2, at });
  }
}
