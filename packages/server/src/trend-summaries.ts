// 群聊动向摘要(U80,D21.2–D21.4):联系人按承诺每 N 条消息读一段固定区间 (from, to],写一份带来源的解读。
// - 只读桥:到点由宿主把这段当前可见的群聊发言交给联系人模型的现有入口(ContactMind.round,模型就是它的说话模型),
//   只收它的要点;它提出的任何动作都不执行。摘要只写 gg_summaries 自己的记录:不发消息、不动任务/授权/卡片/草稿/已读与处理游标。
// - 区间固定:from、to 在冻结窗口时就定了,宿主把整段读全(没有 200 条快照那种上限);超过输入字节上限只给前一部分,如实记 truncated。
//   区间里没有可总结的发言(全是通知/任务卡,或全被撤回、被提出人在自己这端删了)记 empty,不调模型。
// - 失效(AC-08):区间里有消息被撤回,这段的摘要对所有人标 stale(原因、是哪条 seq),正文当场清掉——和撤回在同一个事务里落盘,
//   不靠内存事件;生成途中撤回的,模型回来落库前在同一个事务里复核这段区间,有新撤回就直接落成 stale、正文不存。
//   本端删除(只隐藏用户自己这一端)不改摘要记录,只在给那位用户的视图里去掉他已经删掉来源的要点。
//   过期或失败的可以重做:同一区间出新版本,指回旧版本。
// - 一个窗口宿主只自动调一次模型;失败、重启打断都记 failed,不在后台反复重试,要再来由用户重做。
// —— 红提交的空壳:表、类型与方法签名在,方法体不做事(不调模型、不落记录、不失效);实现见下一个提交 ——
import type { TrendSummaryView } from "@g-group/api-contract";
import type { ContactMind, ContactProfile } from "@g-group/kernel";
import type { CountWindow } from "./count-triggers.ts";
import { type Db, HostError } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gg_summaries (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, contact_id TEXT NOT NULL, requester_id TEXT NOT NULL, commitment_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, version INTEGER NOT NULL, supersedes TEXT,
  status TEXT NOT NULL, items TEXT NOT NULL, message_count INTEGER NOT NULL, covered_count INTEGER NOT NULL, covered_to_seq INTEGER, truncated INTEGER NOT NULL,
  model TEXT NOT NULL, generated_at TEXT, stale_reason TEXT, stale_by_seq INTEGER, stale_at TEXT, error TEXT, created_at TEXT NOT NULL,
  UNIQUE (room_id, contact_id, from_seq, to_seq, version)
);
CREATE INDEX IF NOT EXISTS gg_summaries_room ON gg_summaries (room_id, to_seq);
`;

/** 视图就是合同里的 TrendSummaryView(字段说明在那里)。 */
export type TrendSummary = TrendSummaryView;
export type SummaryStatus = TrendSummaryView["status"];
/** 交给模型的消息原文的 UTF-8 字节上限(默认值;宿主可用 summaryInputMaxBytes 改)。超了只给前一部分并标 truncated。 */
export const SUMMARY_INPUT_MAX_BYTES = 300_000;
/** 一次摘要等模型多久(毫秒,默认值;宿主可用 summaryTimeoutMs 改)。到时中止,记 failed。 */
export const SUMMARY_TIMEOUT_MS = 300_000;

export interface TrendSummaryDeps {
  readonly db: Db;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** 这位联系人现在的档案与脑子;已删除返回 null。脑子必须就是它平时说话用的那个入口,不另配模型或密钥。 */
  readonly contact: (contactId: string) => { profile: ContactProfile; mind: ContactMind } | null;
  /** 它现在还能不能在这个会话里做摘要(不在群里、正在移出、群已解散给出原因)。 */
  readonly blockedWhy: (contactId: string, roomId: string) => string | null;
  readonly roomTitle: (roomId: string) => string;
  readonly nameOf: (sender: { kind: string; id: string }) => string;
  readonly hidden: (roomId: string, viewerId: string) => (seq: number) => boolean;
  /** 承诺原文(给模型看是哪条承诺引出的);查不到为 null。 */
  readonly commitmentText: (commitmentId: string, contactId: string, roomId: string) => string | null;
  /** 窗口还在等处理吗。 */
  readonly windowPending: (triggerId: string, toSeqInclusive: number) => boolean;
  /** 窗口处理完(在摘要落盘的同一事务里调用)。 */
  readonly settleWindowTx: (triggerId: string, toSeqInclusive: number, status: "done" | "failed") => void;
  /** 提交之后:某份摘要新建或状态变了。 */
  readonly changed: (summaryId: string) => void;
  readonly report: (what: string, detail: unknown) => void;
  readonly inputMaxBytes?: number;
  readonly timeoutMs?: number;
}

export const summaryLedgerNote = (_everyN: number) => "未实现";

export class TrendSummaries {
  constructor(deps: TrendSummaryDeps) {
    deps.db.store.db.exec(SCHEMA);
  }
  view(id: string, _viewerId: string): TrendSummary {
    throw new HostError("not_found", `没有摘要 ${id}`);
  }
  list(_q: { roomId: string; viewerId: string; beforeToSeq?: number; includeSuperseded?: boolean; limit?: number }): { summaries: TrendSummary[]; hasMore: boolean } {
    return { summaries: [], hasMore: false };
  }
  enqueue(_w: CountWindow): void {}
  busy(): boolean {
    return false;
  }
  async idle(): Promise<void> {}
  invalidateTx(_roomId: string, _seq: number): string[] {
    return [];
  }
  announce(): void {}
  regenerate(input: { summaryId: string; clientActionId: string; viewerId: string }): TrendSummary {
    return this.view(input.summaryId, input.viewerId);
  }
  recoverTx(): void {}
  async stop(): Promise<void> {}
}
