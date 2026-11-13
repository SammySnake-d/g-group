// 按消息数触发(U80,D21.3 第 14 项、D21.4 第 1 步):「每 N 条消息」是联系人承诺的一种触发方式,和定时同一条线,不放进插件。
// 一条触发 = 一条联系人承诺(commitmentId)+ 会话 + 每 N 条 + 上次覆盖到的 seq(coveredSeq)。
// 到点 = coveredSeq 之后算群聊发言的消息(口径见 chat-range.ts)攒够 N 条:冻结一个窗口 (from, to],to 是第 N 条的 seq,
// coveredSeq 前进到 to。窗口与 coveredSeq 同一事务落盘,主键 (trigger, to) 加唯一 (trigger, from):重放、重启都不会多冻一次。
// 计数不留在内存里,每次从只追加记录现算;宿主启动时 reconcile 补上「消息已落盘、还没来得及计数」的那一拍。
// 本模块只管触发与窗口,不调模型:窗口交给消费方(动向摘要),它做完后 settle。承诺撤销、联系人不在群里、群已解散 → 触发关闭,
// 还没处理的窗口一并取消:没人开就不花模型调用,撤销后也不再花。
// —— 红提交的空壳:表、类型与方法签名在,方法体不做事;实现见下一个提交 ——
import type { Db } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_count_triggers (
  id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL UNIQUE, contact_id TEXT NOT NULL, room_id TEXT NOT NULL, requester_id TEXT NOT NULL,
  every_n INTEGER NOT NULL, source_seq INTEGER NOT NULL, covered_seq INTEGER NOT NULL, status TEXT NOT NULL, closed_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gg_count_triggers_room ON gg_count_triggers (room_id, status);
CREATE TABLE IF NOT EXISTS gg_count_windows (
  trigger_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, status TEXT NOT NULL, frozen_at TEXT NOT NULL, settled_at TEXT,
  PRIMARY KEY (trigger_id, to_seq), UNIQUE (trigger_id, from_seq)
);
`;

/** 每 N 条的 N 的取值范围。下限 1 就是每条都触发;上限只防离谱的数,不是产品阈值。 */
export const EVERY_N_MIN = 1;
export const EVERY_N_MAX = 10_000;

export interface CountTrigger {
  readonly id: string;
  readonly commitmentId: string;
  readonly contactId: string;
  readonly roomId: string;
  /** 提出这条承诺的用户:计数与读取区间时,他在自己这一端删掉的消息不算 */
  readonly requesterId: string;
  readonly everyN: number;
  readonly sourceSeq: number;
  /** 上次覆盖到的 seq:下一个窗口从它之后开始数 */
  readonly coveredSeq: number;
  readonly status: "active" | "closed";
  readonly closedReason: string | null;
}
export type WindowStatus = "pending" | "done" | "failed" | "cancelled";
export interface CountWindow {
  readonly triggerId: string;
  readonly commitmentId: string;
  readonly contactId: string;
  readonly roomId: string;
  readonly requesterId: string;
  readonly fromSeqExclusive: number;
  readonly toSeqInclusive: number;
  readonly status: WindowStatus;
}
/** 承诺视图里的触发信息(CommitmentView.trigger)。 */
export interface CountTriggerView {
  readonly kind: "message-count";
  readonly everyN: number;
  readonly coveredSeq: number;
  /** coveredSeq 之后已经攒了几条 */
  readonly count: number;
  readonly active: boolean;
  /** 已冻结过的窗口数 */
  readonly windows: number;
}
export interface CountTriggerDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 这条触发现在还该不该数;不该就给出关闭原因(承诺已不是 active、联系人不在这个会话、会话已解散)。 */
  readonly closedWhy: (t: CountTrigger) => string | null;
  /** 某位用户在某个会话这一端隐藏了哪些 seq。 */
  readonly hidden: (roomId: string, viewerId: string) => (seq: number) => boolean;
  /** 提交之后:某条承诺的触发状态变了(冻结了窗口、关闭)。 */
  readonly changed: (commitmentId: string) => void;
  /** 提交之后:有新窗口等消费方处理(每个窗口在一次宿主运行里只通知一次;重启后还没处理完的会再通知)。 */
  readonly fired: (w: CountWindow) => void;
}

export function everyNProblem(_n: unknown): string | null {
  return null;
}

export class CountTriggers {
  constructor(deps: CountTriggerDeps) {
    deps.db.store.db.exec(SCHEMA);
  }
  createTx(_input: { commitmentId: string; contactId: string; roomId: string; requesterId: string; everyN: number; sourceSeq: number; coveredSeq: number }): CountTrigger {
    return undefined as never;
  }
  byCommitment(_commitmentId: string): CountTrigger | null {
    return null;
  }
  get(_triggerId: string): CountTrigger | null {
    return null;
  }
  viewOf(_commitmentId: string): CountTriggerView | null {
    return null;
  }
  onAppendTx(_roomId: string): void {}
  closeTx(_commitmentId: string, _reason: string): void {}
  settleWindowTx(_triggerId: string, _toSeqInclusive: number, _status: "done" | "failed"): boolean {
    return false;
  }
  windows(_triggerId: string): CountWindow[] {
    return [];
  }
  window(_triggerId: string, _toSeqInclusive: number): CountWindow | null {
    return null;
  }
  announce(): void {}
  reconcileTx(): void {}
}
