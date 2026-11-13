// 「群聊发言」的口径(U80 / D21.2–D21.4):按消息数触发的计数与动向摘要读取的区间用同一条规则,只此一处。
// 算群聊发言的:用户、联系人、Helper 在这个会话里说的话,当前仍可见(没撤回、没被私聊 rewind 撤下)。
// 不算的:宿主的 system 通知;宿主替联系人挂出的任务事实卡(接活卡、失败卡等,它们属于任务时间线,不是聊天);
//        撤回的消息(AC-08);rewind 撤下的消息和那条「已回退」说明(AC-48);调用方点名的那位用户在自己这一端删除/清空的消息(U23)。
// 每次都从只追加记录现算,不留内存计数:重启前后、重放前后口径一样。
// —— 红提交的空壳:类型与签名在,不读任何记录;实现见下一个提交 ——
import type { Db } from "./db.ts";

export interface ChatLine {
  readonly seq: number;
  readonly sender: { readonly kind: string; readonly id: string };
  readonly text: string;
  readonly at: string;
}
export interface ChatRangeQuery {
  readonly roomId: string;
  /** 左开:只取 seq 大于它的 */
  readonly afterSeq: number;
  /** 右闭:只取 seq 不大于它的;不给就到当前末尾 */
  readonly uptoSeq?: number;
  /** 某位用户这一端隐藏了哪些 seq(本端删除/清空);不给就不按隐藏过滤 */
  readonly hidden?: (seq: number) => boolean;
}

export const TASK_EVENT_CARDS: ReadonlySet<string> = new Set();

export function chatLines(_db: Db, _q: ChatRangeQuery): ChatLine[] {
  return [];
}

export function lastEventSeq(_db: Db, _roomId: string): number {
  return 0;
}
