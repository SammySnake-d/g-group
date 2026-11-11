// 联系人动作补齐(feat/contact-actions)——红提交空壳:签名在,返回假值;实现见下一个提交。
import type { MindAction } from "@g-group/kernel";
import type { Db } from "./db.ts";

export function describeAction(_a: MindAction): string {
  return "";
}

export interface RejectionNote {
  readonly actionId: string;
  readonly tool: string;
  readonly action: string;
  readonly reason: string;
}

export class RejectionFeed {
  constructor(_db: Db) {}
  recordTx(_contactId: string, _roundId: string, _rejected: readonly { readonly action: MindAction; readonly reason: string }[], _at: string) {}
  pending(_contactId: string): RejectionNote[] {
    return [];
  }
  markShownTx(_contactId: string, _actionIds: readonly string[], _roundId: string) {}
}

export function rejectionPointers(_notes: readonly RejectionNote[]): { ref: string; text: string }[] {
  return [];
}

export interface ClaimableTask {
  readonly id: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly title: string;
  readonly state: string;
  readonly owner: string | null;
}
export function claimablePointers(_tasks: readonly ClaimableTask[], _roomIds: ReadonlySet<string>): { ref: string; text: string }[] {
  return [];
}

export function claimRefusal(_taskId: string, _t: ClaimableTask | undefined, _rooms: ReadonlySet<string>, _leaving: ReadonlySet<string>): string | null {
  return "未实现";
}

export function mentionRefusal(_roomId: string, _ids: readonly string[], _members: readonly { readonly id: string }[]): string | null {
  return null;
}
export function toMentions(_ids: readonly string[]): { id: string; source: "manual" }[] {
  return [];
}

export class ReworkOnce {
  has(_taskId: string, _roomId: string, _seq: number): boolean {
    return false;
  }
  mark(_taskId: string, _roomId: string, _seq: number) {}
}

export function mergeIntoRework<E extends { readonly kind: string; readonly taskId: string }>(_effects: E[], _taskId: string, _text: string): boolean {
  return false;
}
