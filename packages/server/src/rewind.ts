// 私聊 rewind(AC-48 / U26 / D05):选一个回退点,之后的聊天不再作为当前有效上下文。
// 记录本身只追加、不改:撤下的范围记在 gg_rewinds(回退点, 当时末尾),送达、换入、账本按范围排除。
// 本文件只放只读的规划与查询;落盘(取消任务、作废承诺、记回退说明)在 Host.rewind 里同一事务完成。
// 已发生的外部副作用(起过的 Compute、已产出的结果)只如实列出,任何文案都不声称已撤销。
// 不回退的:长期记忆与资产(附件、插件、联系人设置);编辑与撤回(撤回是隐私边界,AC-08,不因回退把原文放回上下文)。
import type { CommitmentView, RewindPreview, TaskView } from "@g-group/api-contract";
import type { ProjectedMessage } from "@g-group/domain";
import { type Db, HostError, all } from "./db.ts";

export type RewindPlan = RewindPreview;
/** 一段撤下的范围:(toSeq, uptoSeq]。 */
export type RewindRange = readonly [toSeq: number, uptoSeq: number];

const TERMINAL: ReadonlySet<string> = new Set(["T8_Accepted", "T10_Cancelled", "T11_Failed"]);
/** 已在停止中的任务不再重复取消。 */
const NOT_CANCELLABLE: ReadonlySet<string> = new Set([...TERMINAL, "T9_StopRequested"]);
type ComputeStatus = RewindPlan["sideEffects"][number]["status"];

/** 这个会话已执行过的全部回退范围。 */
export function rewindRanges(db: Db, roomId: string): RewindRange[] {
  return all<{ to_seq: number; upto_seq: number }>(db, "SELECT to_seq, upto_seq FROM gg_rewinds WHERE room_id = ? ORDER BY to_seq", roomId).map((r) => [r.to_seq, r.upto_seq] as const);
}
export function inRanges(ranges: readonly RewindRange[], seq: number): boolean {
  return ranges.some(([to, upto]) => seq > to && seq <= upto);
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
export function planRewind(src: RewindSource, toSeq: number): RewindPlan {
  if (src.room.kind !== "dm") throw new HostError("forbidden", "rewind 只在私聊里可用");
  const point = src.messages.find((m) => m.seq === toSeq);
  if (!point) throw new HostError("invalid_params", `回退点 #${toSeq} 不是这个会话里的消息`);
  if (inRanges(src.ranges, toSeq)) throw new HostError("invalid_params", `#${toSeq} 已在更早的回退里撤下,不能作为回退点`);
  const after = src.messages.filter((m) => m.seq > toSeq && !inRanges(src.ranges, m.seq));
  if (!after.length) throw new HostError("invalid_params", `#${toSeq} 之后没有可回退的消息`);
  const fresh = (seq: number) => seq > toSeq && !inRanges(src.ranges, seq);
  const affected = src.tasks.filter((t) => fresh(t.sourceSeq)).sort((a, b) => a.sourceSeq - b.sourceSeq || (a.id < b.id ? -1 : 1));
  return {
    roomId: src.room.id,
    toSeq,
    messages: after.map((m) => ({ seq: m.seq, sender: { kind: m.sender.kind, id: m.sender.id }, excerpt: m.retracted ? "" : m.text.slice(0, 200) })),
    tasks: affected.filter((t) => !NOT_CANCELLABLE.has(t.state)).map((t) => ({ taskId: t.id, title: t.title, sourceSeq: t.sourceSeq, state: t.state })),
    commitments: src.activeCommitments
      .filter((k) => k.roomId === src.room.id && k.status === "active" && fresh(k.sourceSeq))
      .sort((a, b) => a.sourceSeq - b.sourceSeq || (a.id < b.id ? -1 : 1))
      .map((k) => ({ commitmentId: k.id, contactId: k.contactId, sourceSeq: k.sourceSeq, taskId: k.taskId, text: k.text })),
    sideEffects: affected.flatMap((t) =>
      src.computeRuns(t.id).map((r) => ({
        kind: "compute",
        taskId: t.id,
        taskTitle: t.title,
        computeId: r.compute_id,
        status: r.status as ComputeStatus,
        result: r.result,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
    ),
  };
}

/** 替用户记进会话的回退说明:讲清撤下了什么、取消了什么、哪些已经发生不会撤销。不复述撤下消息的原文。 */
export function rewindNotice(plan: RewindPlan): string {
  const seqs = plan.messages.map((m) => m.seq);
  const range = seqs.length === 1 ? `#${seqs[0]}` : `#${seqs[0]}–#${seqs.at(-1)}`;
  const parts = [`回退到 #${plan.toSeq}:之后的 ${seqs.length} 条消息(${range})作废,不再作为当前上下文,不要再按它们执行。`];
  if (plan.tasks.length) parts.push(`取消来源于这些消息的在途任务 ${plan.tasks.length} 个(${plan.tasks.map((t) => `${t.taskId}「${t.title}」`).join("、")}),已请求停止,以 Compute 确认停下为准。`);
  if (plan.commitments.length) parts.push(`作废来源于这些消息的承诺 ${plan.commitments.length} 条。`);
  if (plan.sideEffects.length) parts.push(`有 ${plan.sideEffects.length} 项已经发生的外部操作(已运行过的 Compute 及其产出)不会被撤销。`);
  parts.push("请据此更新状态笔记。");
  return parts.join("");
}
