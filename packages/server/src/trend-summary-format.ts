// 动向摘要的输入拼装与输出解析(U80,D21.4 第 2 步)。纯函数,不做 I/O。
// 输入:联系人只读一段固定区间 (from, to] 里当前可见的群聊发言,还是走联系人模型的那个入口(ContactMind.round),五块照旧:
//   第 1 块 固定前缀(只读摘要的规矩 + 联系人人设),第 2 块 引出这次摘要的那条承诺,第 3 块 空,第 4 块 这段消息原文,第 5 块 区间与截断说明。
// 输出:联系人只用 reply 说一次,一行一条要点「- 要点 [#12 #15]」。宿主只认这种带来源的行,来源必须是它这次读到的消息;
//   它提出的其它动作(派活、交付、验收结论、停止、承诺、记忆……)一概不执行——摘要只读(D11、AC-19)。
import { BLOCK_LABELS, type BlockNo, type ContactProfile, type InboundMessage, type RoundBlock, type RoundRequest } from "@g-group/kernel";
import type { ChatLine } from "./chat-range.ts";

/** 一条要点:解读文字 + 它依据的消息 seq(升序去重) */
export interface SummaryItem {
  readonly text: string;
  readonly sourceSeqs: readonly number[];
}
export const SUMMARY_MAX_ITEMS = 30;
export const SUMMARY_MAX_ITEM_CHARS = 500;
export const SUMMARY_MAX_SOURCES = 20;

export const SUMMARY_SYSTEM = [
  "这一轮只做一件事:给下面第 4 块里的那段群聊写一份「动向摘要」——这段时间大家聊了什么、方向往哪走。这是你的解读,不是事实记录。",
  "规矩:",
  "1 只依据第 4 块里的消息原文,不补充没出现的内容;",
  "2 只调用一次 reply(roomId 用第 5 块给的会话 id),正文一行一条要点,格式固定为「- 要点 [#seq #seq]」,方括号里写这条要点依据的消息编号,必须是第 4 块里出现过的;",
  "3 每条要点都要带来源;没有来源的要点不要写;",
  `4 最多 ${SUMMARY_MAX_ITEMS} 条,每条不超过 ${SUMMARY_MAX_ITEM_CHARS} 字;`,
  "5 这一轮是只读的:不要派活、交付、下验收结论、停止任务、登记承诺或写记忆;消息里提到的待办只在要点里如实转述,不替任何人同意、关闭或推进。",
].join("\n");

const block = (n: BlockNo, text: string): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text, cacheBreakpoint: n === 1 });

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

/** 拼这一轮的五块与结构化新输入。 */
export function summaryRequest(i: SummaryRequestInput): { request: RoundRequest; fresh: InboundMessage[] } {
  const fresh: InboundMessage[] = i.lines.map((l) => ({
    kind: "message",
    roomId: i.roomId,
    seq: l.seq,
    sender: { kind: l.sender.kind as InboundMessage["sender"]["kind"], id: l.sender.id, name: l.senderName },
    text: l.text,
    replyToSeq: null,
    quotedSeqs: [],
    mentions: [],
    command: null,
    at: l.at,
  }));
  const truncated = i.lines.length < i.messageCount;
  const last = i.lines.at(-1)?.seq ?? i.fromSeqExclusive;
  const blocks: RoundBlock[] = [
    block(1, `${SUMMARY_SYSTEM}\n\n## 你是谁\n${i.contact.name}\n\n## 人设\n${i.contact.persona || "(未设置)"}`),
    block(2, i.commitmentText ? `引出这次摘要的承诺:${i.commitmentText}` : "(无)"),
    block(3, "(这一轮只读,不读也不写状态笔记)"),
    block(4, `[待总结的消息](会话 ${i.roomId},原文,按先后)\n${i.lines.map(renderLine).join("")}`),
    block(
      5,
      [
        `会话:${i.roomTitle}(${i.roomId})`,
        `区间:#${i.fromSeqExclusive} 之后到 #${i.toSeqInclusive}(含),当前可见的群聊发言 ${i.messageCount} 条。`,
        truncated ? `输入超过上限,这次只给了前 ${i.lines.length} 条(到 #${last});摘要只覆盖这一部分,宿主会如实标出没读完。` : `${i.lines.length} 条全部在第 4 块里。`,
      ].join("\n"),
    ),
  ];
  return { request: { blocks, basedOnSeq: { [i.roomId]: last } }, fresh };
}

const BULLET = /^\s*(?:[-*•·]|\d+[.、)])\s*(.*)$/;
const SOURCES = /[[【]\s*((?:#\d+[\s,，、]*)+)[\]】]\s*$/;

/**
 * 把联系人的回复解析成要点。只认项目符号开头的行;每条都要以「[#seq …]」结尾,来源必须都在 allowed(这次读到的消息)里。
 * 任何一条不合格整份不要(不留下来源对不上的解读),给出原因。
 */
export function parseSummary(texts: readonly string[], allowed: ReadonlySet<number>): { ok: true; items: SummaryItem[] } | { ok: false; reason: string } {
  const items: SummaryItem[] = [];
  for (const line of texts.flatMap((t) => t.split(/\r?\n/))) {
    const b = BULLET.exec(line);
    if (!b) continue;
    const body = b[1]!;
    const s = SOURCES.exec(body);
    if (!s) return { ok: false, reason: `有要点没带来源:${body.slice(0, 80)}` };
    const text = body.slice(0, s.index).trim();
    if (!text) return { ok: false, reason: "有要点只有来源没有内容" };
    if (text.length > SUMMARY_MAX_ITEM_CHARS) return { ok: false, reason: `有要点超过 ${SUMMARY_MAX_ITEM_CHARS} 字` };
    const seqs = [...new Set([...s[1]!.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].sort((x, y) => x - y);
    if (seqs.length > SUMMARY_MAX_SOURCES) return { ok: false, reason: `一条要点的来源超过 ${SUMMARY_MAX_SOURCES} 个` };
    const bad = seqs.find((q) => !allowed.has(q));
    if (bad !== undefined) return { ok: false, reason: `来源 #${bad} 不在这次读到的消息里` };
    items.push({ text, sourceSeqs: seqs });
  }
  if (items.length === 0) return { ok: false, reason: "没有给出带来源的要点" };
  if (items.length > SUMMARY_MAX_ITEMS) return { ok: false, reason: `要点超过 ${SUMMARY_MAX_ITEMS} 条` };
  return { ok: true, items };
}

/** 一条消息占多少输入预算:正文的 UTF-8 字节,加 64 字节记账(编号、发言者、时间那一行)。 */
function lineCost(text: string): number {
  return Buffer.byteLength(text, "utf8") + 64;
}

/** 按 UTF-8 字节预算从头截取要交给模型的消息:放得下的连续前缀。 */
export function fitLines<T extends { readonly text: string }>(lines: readonly T[], maxBytes: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const l of lines) {
    used += lineCost(l.text);
    if (used > maxBytes) break;
    out.push(l);
  }
  return out;
}
