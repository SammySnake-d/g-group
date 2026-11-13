// 动向摘要的输入拼装与输出解析(U80,D21.4 第 2 步)。纯函数,不做 I/O。
// 输入:联系人只读一段固定区间 (from, to] 里当前可见的群聊发言,还是走联系人模型的那个入口(ContactMind.round),五块照旧:
//   第 1 块 固定前缀(只读摘要的规矩 + 联系人人设),第 2 块 引出这次摘要的那条承诺,第 3 块 空,第 4 块 这段消息原文,第 5 块 区间与截断说明。
// 输出:联系人只用 reply 说一次,一行一条要点「- 要点 [#12 #15]」。宿主只认这种带来源的行,来源必须是它这次读到的消息;
//   它提出的其它动作(派活、交付、验收结论、停止、承诺、记忆……)一概不执行——摘要只读(D11、AC-19)。
// —— 红提交的空壳:类型与签名在,不拼输入、不解析输出;实现见下一个提交 ——
import type { ContactProfile, InboundMessage, RoundRequest } from "@g-group/kernel";
import type { ChatLine } from "./chat-range.ts";

/** 一条要点:解读文字 + 它依据的消息 seq(升序去重) */
export interface SummaryItem {
  readonly text: string;
  readonly sourceSeqs: readonly number[];
}
export const SUMMARY_MAX_ITEMS = 30;
export const SUMMARY_MAX_ITEM_CHARS = 500;
export const SUMMARY_MAX_SOURCES = 20;

export const SUMMARY_SYSTEM = "(未实现)";

export interface SummaryRequestInput {
  readonly contact: ContactProfile;
  readonly roomId: string;
  readonly roomTitle: string;
  readonly fromSeqExclusive: number;
  readonly toSeqInclusive: number;
  /** 这次交给模型读的消息(已按预算截好),带发言者名字 */
  readonly lines: readonly (ChatLine & { readonly senderName: string })[];
  /** 区间里当前可见的群聊发言总数;大于 lines.length 就是截断了 */
  readonly messageCount: number;
  /** 引出这次摘要的承诺原文;没有(承诺已不在账本里)为 null */
  readonly commitmentText: string | null;
}

/** 第 4 块里一条消息的写法:编号、发言者、时间一行,原文一行。 */
function renderLine(l: ChatLine & { readonly senderName: string }): string {
  return `#${l.seq} · ${l.senderName}(${l.sender.kind}:${l.sender.id}) · ${l.at}\n${l.text}\n`;
}

export function summaryRequest(_i: SummaryRequestInput): { request: RoundRequest; fresh: InboundMessage[] } {
  return { request: { blocks: [], basedOnSeq: {} }, fresh: [] };
}

export function parseSummary(_texts: readonly string[], _allowed: ReadonlySet<number>): { ok: true; items: SummaryItem[] } | { ok: false; reason: string } {
  return { ok: false, reason: "未实现" };
}

export function fitLines<T extends { readonly text: string }>(_lines: readonly T[], _maxBytes: number): T[] {
  return [];
}
