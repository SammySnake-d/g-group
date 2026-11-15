// 「群聊发言」的口径(U80 / D21.2–D21.4):按消息数触发的计数与动向摘要读取的区间用同一条规则,只此一处。
// 算群聊发言的:用户、联系人、Helper 在这个会话里说的话,当前仍可见(没撤回、没被私聊 rewind 撤下)。
// 不算的:宿主的 system 通知;宿主替联系人挂出的任务事实卡(接活卡、失败卡等,它们属于任务时间线,不是聊天);
//        撤回的消息(AC-08);rewind 撤下的消息和那条「已回退」说明(AC-48);调用方点名的那位用户在自己这一端删除/清空的消息(U23)。
// 每次都从只追加记录现算,不留内存计数:重启前后、重放前后口径一样。
import { loadLog } from "@g-group/adapter-sqlite";
import { project } from "@g-group/domain";
import { type Db, all } from "./db.ts";
import { inRanges, rewindRanges } from "./rewind.ts";

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

/** 这些卡片是任务事实,不是聊天:接活/重跑卡、失败卡、定时触发卡、插件结果卡。交付说明与提问是联系人对人说的话,照算。 */
export const TASK_EVENT_CARDS: ReadonlySet<string> = new Set(["task-status", "failure", "schedule-fired", "plugin-result"]);

/** (afterSeq, uptoSeq] 里当前算群聊发言的消息,按 seq 升序。 */
export function chatLines(db: Db, q: ChatRangeQuery): ChatLine[] {
  const { log } = loadLog(db.store, `room:${q.roomId}`);
  const rewound = rewindRanges(db, q.roomId);
  const cards = new Map(
    all<{ seq: number; kind: string }>(db, "SELECT m.seq AS seq, c.kind AS kind FROM gg_msg m JOIN gg_cards c ON c.card_id = m.card_id WHERE m.room_id = ?", q.roomId).map((r) => [r.seq, r.kind]),
  );
  // 回退说明是宿主记的一条带 rewind 命令的消息,不是谁说的话
  const notices = new Set(all<{ seq: number }>(db, "SELECT seq FROM gg_msg WHERE room_id = ? AND json_extract(command, '$.name') = 'rewind'", q.roomId).map((r) => r.seq));
  const at = new Map(log.events.map((e) => [e.seq, e.at]));
  const out: ChatLine[] = [];
  for (const m of project(log)) {
    if (m.seq <= q.afterSeq) continue;
    if (q.uptoSeq !== undefined && m.seq > q.uptoSeq) continue;
    if (m.retracted || m.sender.kind === "system") continue;
    if (inRanges(rewound, m.seq) || notices.has(m.seq)) continue;
    if (TASK_EVENT_CARDS.has(cards.get(m.seq) ?? "")) continue;
    if (q.hidden?.(m.seq)) continue;
    out.push({ seq: m.seq, sender: { kind: m.sender.kind, id: m.sender.id }, text: m.text, at: at.get(m.seq) ?? "" });
  }
  return out;
}

/** 这个会话只追加记录的末尾 seq(含编辑、撤回事件);空会话为 0。 */
export function lastEventSeq(db: Db, roomId: string): number {
  return all<{ s: number | null }>(db, "SELECT max(seq) AS s FROM events WHERE session = ?", `room:${roomId}`)[0]?.s ?? 0;
}
