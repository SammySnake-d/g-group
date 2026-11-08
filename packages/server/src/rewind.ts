// 私聊 rewind(AC-48 / U26 / D05):选一个回退点,之后的聊天不再作为当前有效上下文。
// 记录本身只追加、不改:撤下的范围记在 gg_rewinds(回退点, 当时末尾),送达、换入、账本按范围排除。
// 本文件只放只读的规划与查询;落盘(取消任务、作废承诺、记回退说明)在 Host.rewind 里同一事务完成。
// 已发生的外部副作用(起过的 Compute、已产出的结果)只如实列出,任何文案都不声称已撤销。
import type { CommitmentView, RewindPreview, TaskView } from "@g-group/api-contract";
import type { ProjectedMessage } from "@g-group/domain";
import type { Db } from "./db.ts";

export type RewindPlan = RewindPreview;
/** 一段撤下的范围:(toSeq, uptoSeq]。 */
export type RewindRange = readonly [toSeq: number, uptoSeq: number];

/** 这个会话已执行过的全部回退范围。 */
export function rewindRanges(_db: Db, _roomId: string): RewindRange[] {
  throw new Error("未实现");
}
export function inRanges(_ranges: readonly RewindRange[], _seq: number): boolean {
  throw new Error("未实现");
}
export function isRewound(db: Db, roomId: string, seq: number): boolean {
  return inRanges(rewindRanges(db, roomId), seq);
}

export interface RewindSource {
  readonly room: { readonly id: string; readonly kind: "dm" | "group" };
  readonly messages: readonly ProjectedMessage[];
  readonly ranges: readonly RewindRange[];
  /** 本会话的全部任务(含已结束的)。 */
  readonly tasks: readonly TaskView[];
  /** 本会话所有联系人的未了结承诺。 */
  readonly activeCommitments: readonly CommitmentView[];
  readonly computeRuns: (taskId: string) => readonly { compute_id: string; status: string; result: string | null; started_at: string; ended_at: string | null }[];
}

/** 只读算出回退会影响到的东西;不合法的回退点直接拒绝。 */
export function planRewind(_src: RewindSource, _toSeq: number): RewindPlan {
  throw new Error("未实现");
}

/** 替用户记进会话的回退说明:讲清撤下了什么、取消了什么、哪些已经发生不会撤销。 */
export function rewindNotice(_plan: RewindPlan): string {
  throw new Error("未实现");
}
