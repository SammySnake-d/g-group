// Compute 槽位租约(AC-23,需求 D10 两级配额与 C-US24、第四台 R-Quota):纯数据结构,不起进程、不碰数据库。
// - 每个运行中的 Compute 占一个槽位:先占联系人自己的个人槽位;个人满了,群里的任务可以借**本群**的临时槽位;
//   绝不借别的群的临时槽位(群临时 Compute 严禁串群,P0 隔离底线)。都满就排队,写明在等什么。
// - 释放只在「确认已停止」之后(进程主体与它启动的子进程都退出),停止请求本身不释放(取消请求与实际停止分开);
//   释放后按先来先到把空出来的槽位给排队的下一个。
// - 同一任务不重复授予(已持有就返回原租约);重复释放、迟到的旧租约号释放一律幂等忽略。
// 槽位数:个人 personal(contactId),群临时 group(roomId);返回 Infinity 表示不限。私聊没有群临时槽位。

export type ScopeKey = `personal:${string}` | `group:${string}`;
export interface Lease {
  readonly leaseId: string;
  readonly scope: ScopeKey;
  readonly taskId: string;
  readonly contactId: string;
  readonly roomId: string;
  /** 已请求停止、还没确认停下:仍占着槽位 */
  readonly stopping: boolean;
}
export interface Waiter {
  readonly taskId: string;
  readonly contactId: string;
  readonly roomId: string;
  readonly isGroup: boolean;
  readonly reason: string;
}
export interface QuotaConfig {
  readonly personal: (contactId: string) => number;
  readonly group: (roomId: string) => number;
  readonly newId: () => string;
}
export interface AcquireRequest {
  readonly taskId: string;
  readonly contactId: string;
  readonly roomId: string;
  /** 群聊才有群临时槽位 */
  readonly isGroup: boolean;
}
export type AcquireResult = { readonly granted: Lease; readonly reused: boolean } | { readonly queued: string };

export class QuotaTable {
  private readonly cfg: QuotaConfig;
  private leases: Lease[] = [];
  private waiters: Waiter[] = [];
  constructor(cfg: QuotaConfig) {
    this.cfg = cfg;
  }
  private used(scope: ScopeKey): number {
    return this.leases.filter((l) => l.scope === scope).length;
  }
  /** 能放进哪个槽位;排在前面、等同一个槽位的人(ahead)优先,不插队 */
  private fit(r: AcquireRequest, ahead: readonly Waiter[]): ScopeKey | null {
    const personal: ScopeKey = `personal:${r.contactId}`;
    if (!ahead.some((w) => w.contactId === r.contactId) && this.used(personal) < this.cfg.personal(r.contactId)) return personal;
    if (r.isGroup) {
      const group: ScopeKey = `group:${r.roomId}`;
      if (!ahead.some((w) => w.isGroup && w.roomId === r.roomId) && this.used(group) < this.cfg.group(r.roomId)) return group;
    }
    return null;
  }
  private grant(r: AcquireRequest, scope: ScopeKey): Lease {
    const l: Lease = Object.freeze({ leaseId: `lease-${this.cfg.newId()}`, scope, taskId: r.taskId, contactId: r.contactId, roomId: r.roomId, stopping: false });
    this.leases.push(l);
    return l;
  }
  private why(r: AcquireRequest): string {
    const elsewhere = this.leases.filter((l) => l.contactId === r.contactId && l.scope === `personal:${r.contactId}`).map((l) => l.roomId);
    const where = elsewhere.length ? `个人算力正被 ${[...new Set(elsewhere)].join("、")} 里的任务占用` : "个人算力已满";
    return r.isGroup ? `${where},本群临时 Compute 也满了;排队等,或转交别人` : `${where};排队等,或转交别人`;
  }
  /** 申请槽位。已持有就原样返回(不重复授予);排队中再申请不重复排 */
  acquire(r: AcquireRequest): AcquireResult {
    const held = this.leases.find((l) => l.taskId === r.taskId);
    if (held) return { granted: held, reused: true };
    const waiting = this.waiters.find((w) => w.taskId === r.taskId);
    if (waiting) return { queued: waiting.reason };
    const scope = this.fit(r, this.waiters);
    if (scope) return { granted: this.grant(r, scope), reused: false };
    const reason = this.why(r);
    this.waiters.push(Object.freeze({ ...r, reason }));
    return { queued: reason };
  }
  /** 停止请求已发出:标记,但仍占着槽位 */
  markStopping(taskId: string): void {
    this.leases = this.leases.map((l) => (l.taskId === taskId && !l.stopping ? Object.freeze({ ...l, stopping: true }) : l));
  }
  /** 确认已停止后释放。leaseId 不在(重复释放、迟到的旧租约号)就什么都不做。返回这次释放后新授予的排队者 */
  release(leaseId: string): { readonly released: boolean; readonly granted: readonly Lease[] } {
    const i = this.leases.findIndex((l) => l.leaseId === leaseId);
    if (i < 0) return { released: false, granted: [] };
    this.leases.splice(i, 1);
    const granted: Lease[] = [];
    const still: Waiter[] = [];
    for (const w of this.waiters) {
      // 排在前面、同样等这个槽位的人还在等,后面的就不越过它
      const scope = this.fit(w, still);
      if (scope) granted.push(this.grant(w, scope));
      else still.push(w);
    }
    this.waiters = still;
    return { released: true, granted };
  }
  /** 不再排队(任务取消) */
  cancelWait(taskId: string): boolean {
    const n = this.waiters.length;
    this.waiters = this.waiters.filter((w) => w.taskId !== taskId);
    return this.waiters.length !== n;
  }
  leaseOf(taskId: string): Lease | undefined {
    return this.leases.find((l) => l.taskId === taskId);
  }
  waitingReason(taskId: string): string | null {
    return this.waiters.find((w) => w.taskId === taskId)?.reason ?? null;
  }
  view(): { readonly leases: readonly Lease[]; readonly waiting: readonly Waiter[] } {
    return { leases: [...this.leases], waiting: [...this.waiters] };
  }
}
