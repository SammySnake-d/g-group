// 输入框草稿 ClientInputDraft[roomId](AC-24、AC-37 ①②;需求文档 D11.5、C-US28、U59):
// 客户端会话级的未发送缓冲。它不是消息:不产生任何会话事件,不进联系人注意循环,和联系人的 P1 Agent Draft 无关。
// 渲染进程用本文件的纯函数改草稿(每次改动 draftVer + 1),主进程用 drafts.save 按 draftVer 做 CAS 落盘,
// 切窗口、重启客户端都原样还在;发送时带上 draftVer,成功回执按 settleDraft 只清已发送的那一版,不误删等待回执期间新打的字。
// 回复 = @原作者 + 引用:reply 把目标放进 quotedSeqs(保序去重)并自动 @ 作者(source=auto);切换主回复或删掉主回复的引用块时,
// 只移除那一条 auto @,用户手打的同一个人的 @(source=manual)保留。
// 纯函数:不改入参,改了返回新对象,没改返回原对象(draftVer 不变);入参不合格抛 TypeError / RangeError。
import { arr, id, int, isoTime, nullable, obj, oneOf, seq, str, type Infer } from "./schema.ts";

export const DRAFT_MAX_QUOTES = 50;
export const DRAFT_MAX_MENTIONS = 100;
export const DRAFT_MAX_TEXT = 100000;

export const DraftMention = obj({ id: id(), source: oneOf(["auto", "manual"] as const) });
export type DraftMention = Infer<typeof DraftMention>;
/** 草稿内容(不含会话号与时间),drafts.save 的 draft 参数就是这个形状。 */
export const DraftBody = obj({
  text: str({ max: DRAFT_MAX_TEXT }),
  /** 主回复对象;为 null 时没有主回复。必须同时出现在 quotedSeqs 里。 */
  replyToSeq: nullable(seq()),
  /** 主回复对象的作者(联系人 id);回复时自动 @ 的就是它。没有主回复或作者不是联系人时为 null。 */
  replyAuthorId: nullable(id()),
  /** 一次连续引用的多条消息,按点击顺序、去重。 */
  quotedSeqs: arr(seq(), { max: DRAFT_MAX_QUOTES }),
  mentions: arr(DraftMention, { max: DRAFT_MAX_MENTIONS }),
  /** 草稿版本:每次改动 + 1;落盘 CAS 与发送回执清理都按它判。 */
  draftVer: int({ min: 0 }),
});
export type DraftBody = Infer<typeof DraftBody>;
/** 服务端存的一份草稿(drafts.get / drafts.save 的结果,draft.updated 事件负载)。 */
export const DraftView = obj({ roomId: id(), ...DraftBody.shape, updatedAt: nullable(isoTime()) });
export type DraftView = Infer<typeof DraftView>;

export interface ClientInputDraft {
  readonly roomId: string;
  readonly text: string;
  readonly replyToSeq: number | null;
  readonly replyAuthorId: string | null;
  readonly quotedSeqs: readonly number[];
  readonly mentions: readonly DraftMention[];
  readonly draftVer: number;
}
/** 引用目标的作者:只有联系人会被自动 @(回复自己的消息、宿主卡片不 @ 任何人)。 */
export interface DraftAuthor {
  readonly kind: "user" | "contact" | "helper" | "system";
  readonly id: string;
}
export type DraftOp =
  | { readonly op: "setText"; readonly text: string }
  /** 点某条消息的「回复」:设主回复、放进引用、自动 @ 作者;已有主回复则切换(旧的降为普通引用)。 */
  | { readonly op: "reply"; readonly seq: number; readonly author: DraftAuthor }
  /** 点「引用」:追加在末尾,已引用的不重复。 */
  | { readonly op: "quote"; readonly seq: number }
  /** 点引用块的 [×]:只移除这一条;是主回复就同时清主回复并移除它的 auto @。 */
  | { readonly op: "removeQuote"; readonly seq: number }
  /** 用户在输入框里手打 @(source=manual)。 */
  | { readonly op: "mention"; readonly id: string }
  /** 删掉一个 @ 标签:按 id + source 精确删,auto 与 manual 互不影响。 */
  | { readonly op: "unmention"; readonly id: string; readonly source: DraftMention["source"] }
  | { readonly op: "clear" };
/** 发送回执:submittedVer 是发送时带的 draftVer,submitted 是那一刻发出去的内容。 */
export interface DraftReceipt {
  readonly roomId: string;
  readonly submittedVer: number;
  readonly submitted: {
    readonly text: string;
    readonly replyToSeq: number | null;
    readonly quotedSeqs: readonly number[];
    readonly mentions: readonly DraftMention[];
  };
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isSeq = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200 && ![...x].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const sameMention = (a: DraftMention, b: DraftMention) => a.id === b.id && a.source === b.source;

/** 草稿的不变量问题清单;空数组 = 合格。服务端落盘前用它拒绝不合格草稿。 */
export function draftIssues(d: unknown): string[] {
  if (!isRec(d)) return ["草稿必须是对象"];
  const out: string[] = [];
  if (!isId(d.roomId)) out.push("roomId 必须是非空标识符");
  if (typeof d.text !== "string" || d.text.length > DRAFT_MAX_TEXT) out.push(`text 必须是至多 ${DRAFT_MAX_TEXT} 字的字符串`);
  if (!isSeq(d.draftVer)) out.push("draftVer 必须是非负整数");
  const quoted = d.quotedSeqs;
  if (!Array.isArray(quoted) || !quoted.every(isSeq)) out.push("quotedSeqs 必须是消息序号数组");
  else {
    if (quoted.length > DRAFT_MAX_QUOTES) out.push(`一次至多引用 ${DRAFT_MAX_QUOTES} 条`);
    if (new Set(quoted).size !== quoted.length) out.push("quotedSeqs 有重复");
  }
  if (d.replyToSeq !== null && !isSeq(d.replyToSeq)) out.push("replyToSeq 必须是消息序号或 null");
  else if (d.replyToSeq !== null && Array.isArray(quoted) && !quoted.includes(d.replyToSeq)) out.push(`主回复 #${String(d.replyToSeq)} 必须在 quotedSeqs 里`);
  if (d.replyAuthorId !== null && !isId(d.replyAuthorId)) out.push("replyAuthorId 必须是标识符或 null");
  else if (d.replyAuthorId !== null && d.replyToSeq === null) out.push("没有主回复时 replyAuthorId 必须为 null");
  const ms = d.mentions;
  if (!Array.isArray(ms) || !ms.every((m) => isRec(m) && isId(m.id) && (m.source === "auto" || m.source === "manual"))) out.push("mentions 必须是 {id, source: auto|manual} 数组");
  else {
    if (ms.length > DRAFT_MAX_MENTIONS) out.push(`@ 至多 ${DRAFT_MAX_MENTIONS} 个`);
    const keys = ms.map((m: DraftMention) => `${m.source}:${m.id}`);
    if (new Set(keys).size !== keys.length) out.push("mentions 有重复");
  }
  return out;
}

function assertDraft(d: unknown): asserts d is ClientInputDraft {
  const bad = draftIssues(d);
  if (bad.length) throw new TypeError(`草稿不合格:${bad.join(";")}`);
}

/** 某会话的空草稿(版本 0)。 */
export function emptyDraft(roomId: string): ClientInputDraft {
  if (!isId(roomId)) throw new TypeError("roomId 必须是非空标识符");
  return Object.freeze({ roomId, text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: Object.freeze([]), mentions: Object.freeze([]), draftVer: 0 });
}

const freeze = (d: Omit<ClientInputDraft, "draftVer">, ver: number): ClientInputDraft =>
  Object.freeze({ ...d, quotedSeqs: Object.freeze([...d.quotedSeqs]), mentions: Object.freeze(d.mentions.map((m) => Object.freeze({ id: m.id, source: m.source }))), draftVer: ver });
const changed = (a: ClientInputDraft, b: Omit<ClientInputDraft, "draftVer">) =>
  a.text !== b.text ||
  a.replyToSeq !== b.replyToSeq ||
  a.replyAuthorId !== b.replyAuthorId ||
  a.quotedSeqs.length !== b.quotedSeqs.length ||
  a.quotedSeqs.some((s, i) => s !== b.quotedSeqs[i]) ||
  a.mentions.length !== b.mentions.length ||
  a.mentions.some((m, i) => !sameMention(m, b.mentions[i]!));
const withoutAuto = (ms: readonly DraftMention[], who: string | null) => (who === null ? [...ms] : ms.filter((m) => !(m.source === "auto" && m.id === who)));

/** 按一次用户操作改草稿。没改动返回原对象,改了返回 draftVer + 1 的新对象。 */
export function applyDraft(d: ClientInputDraft, op: DraftOp): ClientInputDraft {
  assertDraft(d);
  if (!isRec(op)) throw new TypeError("操作必须是对象");
  let next: Omit<ClientInputDraft, "draftVer">;
  switch (op.op) {
    case "setText":
      if (typeof op.text !== "string" || op.text.length > DRAFT_MAX_TEXT) throw new TypeError(`text 必须是至多 ${DRAFT_MAX_TEXT} 字的字符串`);
      next = { ...d, text: op.text };
      break;
    case "reply": {
      if (!isSeq(op.seq)) throw new TypeError("seq 必须是消息序号");
      if (!isRec(op.author) || !isId(op.author.id) || !["user", "contact", "helper", "system"].includes(op.author.kind)) throw new TypeError("author 必须是 {kind, id}");
      if (d.replyToSeq === op.seq) return d;
      const authorId = op.author.kind === "contact" ? op.author.id : null;
      const mentions = withoutAuto(d.mentions, d.replyAuthorId);
      if (authorId !== null && !mentions.some((m) => m.source === "auto" && m.id === authorId)) mentions.push({ id: authorId, source: "auto" });
      const quotedSeqs = d.quotedSeqs.includes(op.seq) ? [...d.quotedSeqs] : [...d.quotedSeqs, op.seq];
      if (quotedSeqs.length > DRAFT_MAX_QUOTES) throw new RangeError(`一次至多引用 ${DRAFT_MAX_QUOTES} 条`);
      next = { ...d, replyToSeq: op.seq, replyAuthorId: authorId, quotedSeqs, mentions };
      break;
    }
    case "quote": {
      if (!isSeq(op.seq)) throw new TypeError("seq 必须是消息序号");
      if (d.quotedSeqs.includes(op.seq)) return d;
      if (d.quotedSeqs.length >= DRAFT_MAX_QUOTES) throw new RangeError(`一次至多引用 ${DRAFT_MAX_QUOTES} 条`);
      next = { ...d, quotedSeqs: [...d.quotedSeqs, op.seq] };
      break;
    }
    case "removeQuote": {
      if (!isSeq(op.seq)) throw new TypeError("seq 必须是消息序号");
      if (!d.quotedSeqs.includes(op.seq)) return d;
      const quotedSeqs = d.quotedSeqs.filter((s) => s !== op.seq);
      next = d.replyToSeq === op.seq ? { ...d, quotedSeqs, replyToSeq: null, replyAuthorId: null, mentions: withoutAuto(d.mentions, d.replyAuthorId) } : { ...d, quotedSeqs };
      break;
    }
    case "mention": {
      if (!isId(op.id)) throw new TypeError("id 必须是非空标识符");
      if (d.mentions.some((m) => m.source === "manual" && m.id === op.id)) return d;
      if (d.mentions.length >= DRAFT_MAX_MENTIONS) throw new RangeError(`@ 至多 ${DRAFT_MAX_MENTIONS} 个`);
      next = { ...d, mentions: [...d.mentions, { id: op.id, source: "manual" }] };
      break;
    }
    case "unmention": {
      if (!isId(op.id) || (op.source !== "auto" && op.source !== "manual")) throw new TypeError("unmention 要 id 与 source(auto|manual)");
      const target = { id: op.id, source: op.source };
      if (!d.mentions.some((m) => sameMention(m, target))) return d;
      const mentions = d.mentions.filter((m) => !sameMention(m, target));
      // 用户自己删掉了主回复的 auto @:主回复保留,之后切换主回复时不再替它删别的 @
      next = { ...d, mentions, replyAuthorId: op.source === "auto" && d.replyAuthorId === op.id ? null : d.replyAuthorId };
      break;
    }
    case "clear":
      next = { ...d, text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [] };
      break;
    default:
      throw new TypeError(`未知草稿操作 ${String((op as { op?: unknown }).op)}`);
  }
  return changed(d, next) ? freeze(next, d.draftVer + 1) : d;
}

/**
 * 发送成功回执到达时清理草稿(S24-B,候选细化):
 *   - 回执不是这个会话的:不动;
 *   - 草稿版本 ≤ 发送时的版本:草稿里的东西都已经随那一版发出去了,整份清空;
 *   - 草稿版本更新(等回执期间用户又改过):只去掉已发出的部分——正文以已发正文开头才去掉这段前缀,
 *     已发的引用、主回复(连同它的 auto @)与已发的 @ 去掉;之后新打的字、新加的引用原样保留。
 * 没改动返回原对象,改了返回 draftVer + 1 的新对象。
 */
export function settleDraft(d: ClientInputDraft, r: DraftReceipt): ClientInputDraft {
  assertDraft(d);
  if (!isRec(r) || !isId(r.roomId) || !isSeq(r.submittedVer) || !isRec(r.submitted)) throw new TypeError("回执必须是 {roomId, submittedVer, submitted}");
  const s = r.submitted;
  if (typeof s.text !== "string" || !Array.isArray(s.quotedSeqs) || !s.quotedSeqs.every(isSeq) || !(s.replyToSeq === null || isSeq(s.replyToSeq)) || !Array.isArray(s.mentions)) {
    throw new TypeError("submitted 必须是 {text, replyToSeq, quotedSeqs, mentions}");
  }
  if (r.roomId !== d.roomId) return d;
  if (d.draftVer <= r.submittedVer) {
    const empty: Omit<ClientInputDraft, "draftVer"> = { roomId: d.roomId, text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [] };
    return changed(d, empty) ? freeze(empty, Math.max(d.draftVer, r.submittedVer) + 1) : d;
  }
  const text = s.text !== "" && d.text.startsWith(s.text) ? d.text.slice(s.text.length).replace(/^\s+/, "") : d.text;
  const quotedSeqs = d.quotedSeqs.filter((q) => !s.quotedSeqs.includes(q));
  const replyGone = d.replyToSeq !== null && (d.replyToSeq === s.replyToSeq || !quotedSeqs.includes(d.replyToSeq));
  const sent = s.mentions.filter((m): m is DraftMention => isRec(m) && isId(m.id) && (m.source === "auto" || m.source === "manual"));
  let mentions = d.mentions.filter((m) => !sent.some((x) => sameMention(x, m)));
  if (replyGone) mentions = withoutAuto(mentions, d.replyAuthorId);
  else if (d.replyAuthorId !== null && d.mentions.some((m) => m.source === "auto" && m.id === d.replyAuthorId) && !mentions.some((m) => m.source === "auto" && m.id === d.replyAuthorId)) {
    // 主回复还在(新选的),它的 auto @ 不因同名已发 @ 被一并去掉
    mentions = [...mentions, { id: d.replyAuthorId, source: "auto" }];
  }
  const next: Omit<ClientInputDraft, "draftVer"> = {
    roomId: d.roomId,
    text,
    replyToSeq: replyGone ? null : d.replyToSeq,
    replyAuthorId: replyGone ? null : d.replyAuthorId,
    quotedSeqs,
    mentions,
  };
  return changed(d, next) ? freeze(next, d.draftVer + 1) : d;
}

/** 草稿里有没有要发的东西(空白正文不算)。 */
export function isDraftEmpty(d: ClientInputDraft): boolean {
  assertDraft(d);
  return d.text.trim() === "" && d.quotedSeqs.length === 0 && d.replyToSeq === null && d.mentions.length === 0;
}

/** 会话列表上的「[草稿] …」提示;空草稿为 null。正文取第一行前 60 字,没有正文时写引用条数。 */
export function draftPreview(d: ClientInputDraft): string | null {
  if (isDraftEmpty(d)) return null;
  const line = d.text.trim().split("\n")[0]!.trim();
  if (line) return `[草稿] ${line.length > 60 ? `${line.slice(0, 60)}…` : line}`;
  return d.quotedSeqs.length ? `[草稿] 引用 ${d.quotedSeqs.length} 条` : "[草稿] @";
}

/** 从草稿取 messages.send 要带的字段(含 draftVer,回执据此清理)。 */
export function draftToSend(d: ClientInputDraft): { text: string; replyToSeq: number | null; quotedSeqs: number[]; mentions: DraftMention[]; draftVer: number } {
  assertDraft(d);
  return { text: d.text, replyToSeq: d.replyToSeq, quotedSeqs: [...d.quotedSeqs], mentions: d.mentions.map((m) => ({ id: m.id, source: m.source })), draftVer: d.draftVer };
}
