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

/** 空壳(先红),实现见下一个提交 */
export class QuotaTable {
  constructor(_cfg: QuotaConfig) {}
  acquire(_r: AcquireRequest): AcquireResult {
    return { queued: "" };
  }
  markStopping(_taskId: string): void {}
  release(_leaseId: string): { readonly released: boolean; readonly granted: readonly Lease[] } {
    return { released: false, granted: [] };
  }
  cancelWait(_taskId: string): boolean {
    return false;
  }
  leaseOf(_taskId: string): Lease | undefined {
    return undefined;
  }
  waitingReason(_taskId: string): string | null {
    return null;
  }
  view(): { readonly leases: readonly Lease[]; readonly waiting: readonly Waiter[] } {
    return { leases: [], waiting: [] };
  }
}
