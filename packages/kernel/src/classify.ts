// 先机械后语义(AC-11)与固定枚举(AC-12)。
// 机械锚点(@、↩ #seq、确认卡版本号)与意图分开:锚点总是机械提取,只用于路由;
// 只有锚点本身能确定意图时才不调分类器:
//   - 用户对确认卡的结构化回复(卡号 + 版本 + 决定)→ E6;
//   - 纯点名:按结构化 mention 的确切范围去掉 @名字 后正文真为空 → E1。
// 带 @ 或引用但有文字的消息(停止、修改、纠偏……,哪怕和 @ 之间没有空格、只隔中文标点)意图不能机械确定,交给分类器。
// 分类器只能出 E1..E10 或 Uncertain;其它任何值(含无法序列化的)都封闭为 Uncertain 并记违规。
// 入站事件先过统一的普通数据对象判定(plain.ts),不合规就封闭为 Uncertain,getter 永不调用;分类器拿到的是冻结副本。
import { describeThrown, plainData, safeDescribe } from "./plain.ts";

export const EVENT_CODES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"] as const;
export type EventCode = (typeof EVENT_CODES)[number];
export type Classification = EventCode | "Uncertain";

export type CardDecision = "approve" | "reject";
/** 用户点确认卡产生的结构化回复 */
export interface CardReply { readonly cardId: string; readonly version: number; readonly decision: CardDecision }
/** 输入框给出的结构化点名:text.slice(start, end) 必须正好是 "@" + name */
export interface MentionSpan { readonly id: string; readonly name: string; readonly start: number; readonly end: number }
export interface InboundEvent {
  readonly sender: { readonly kind: string; readonly id: string };
  readonly text: string;
  readonly mentions?: readonly MentionSpan[];
  readonly quotes?: readonly number[];
  readonly card?: CardReply;
}
export interface Anchors { readonly mentions: readonly MentionSpan[]; readonly quotes: readonly number[]; readonly card?: CardReply }
export type Classifier = (event: InboundEvent) => unknown;
export interface ClassifyResult {
  readonly anchors: Anchors;
  readonly intent: Classification;
  readonly via: "mechanical" | "semantic";
  /** E6 的目标:哪张卡、哪个版本、什么决定 */
  readonly target?: CardReply;
  /** 输入或分类器给了契约之外的东西:记下可读原因,意图按 Uncertain 处理 */
  readonly violation?: string;
}

const ALLOWED: ReadonlySet<string> = new Set<string>([...EVENT_CODES, "Uncertain"]);
const DECISIONS: ReadonlySet<string> = new Set<CardDecision>(["approve", "reject"]);
/** 名字里不能有空白或标点:否则一个范围就能把后面的正文冒充成名字 */
const NAME_FORBIDDEN = /[\s\p{P}\p{S}]/u;


/** 只收范围与正文对得上的点名;对不上的不当锚点,也就不能让消息走纯点名。 */
function validSpan(text: string, m: unknown): m is MentionSpan {
  if (typeof m !== "object" || m === null) return false;
  const { id, name, start, end } = m as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "" || NAME_FORBIDDEN.test(name)) return false;
  if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) > text.length) return false;
  return text.slice(start as number, end as number) === `@${name}`;
}

function anchorsOf(e: InboundEvent): Anchors & { readonly invalidMentions: number } {
  const raw: unknown[] = Array.isArray(e.mentions) ? e.mentions : [];
  const mentions = raw.filter((m): m is MentionSpan => validSpan(e.text, m)).map((m) => Object.freeze({ id: m.id, name: m.name, start: m.start, end: m.end }));
  const quotes = Array.isArray(e.quotes) ? e.quotes.filter((q) => Number.isInteger(q) && q > 0) : [];
  const base = { mentions, quotes, invalidMentions: raw.length - mentions.length };
  return e.card === undefined ? base : { ...base, card: e.card };
}

/** 确认卡回复的合同:发起人必须是用户本人,卡号非空,版本是正整数,决定在枚举内。 */
function cardViolation(e: InboundEvent, c: CardReply): string | undefined {
  if (e.sender?.kind !== "user") return `确认卡只能由用户回复,来者是 ${safeDescribe(e.sender?.kind)}`;
  if (typeof c.cardId !== "string" || c.cardId === "") return "确认卡回复缺卡号";
  if (!Number.isInteger(c.version) || c.version < 1) return `确认卡版本必须是正整数,收到 ${safeDescribe(c.version)}`;
  if (typeof c.decision !== "string" || !DECISIONS.has(c.decision)) return `确认卡决定必须是 approve | reject,收到 ${safeDescribe(c.decision)}`;
  return undefined;
}

/** 按点名范围挖掉 @名字 后正文真为空(只剩空白):纯点名。有任何无效点名、引用或卡片都不算。 */
function mentionOnly(e: InboundEvent, a: ReturnType<typeof anchorsOf>): boolean {
  if (a.mentions.length === 0 || a.quotes.length > 0 || a.invalidMentions > 0) return false;
  const spans = [...a.mentions].sort((x, y) => x.start - y.start);
  let rest = "", cursor = 0;
  for (const m of spans) {
    if (m.start < cursor) return false; // 范围重叠,说不清哪段是名字
    rest += e.text.slice(cursor, m.start);
    cursor = m.end;
  }
  rest += e.text.slice(cursor);
  return rest.trim() === "";
}


export function classifyInbound(input: InboundEvent, classifier: Classifier): ClassifyResult {
  const plain = plainData(input, "入站事件");
  if (!plain.ok) return { anchors: { mentions: [], quotes: [] }, intent: "Uncertain", via: "mechanical", violation: `入站事件只接受普通数据对象:${plain.path} ${plain.why}` };
  const event = plain.value as InboundEvent;
  if (typeof event.text !== "string") return { anchors: { mentions: [], quotes: [] }, intent: "Uncertain", via: "mechanical", violation: "入站事件 text 必须是字符串" };
  const { invalidMentions, ...anchors } = anchorsOf(event);
  if (anchors.card !== undefined) {
    const bad = cardViolation(event, anchors.card);
    if (bad) return { anchors, intent: "Uncertain", via: "mechanical", violation: bad };
    const { cardId, version, decision } = anchors.card;
    return { anchors, intent: "E6", via: "mechanical", target: { cardId, version, decision } };
  }
  if (mentionOnly(event, { ...anchors, invalidMentions })) return { anchors, intent: "E1", via: "mechanical" };
  let raw: unknown;
  try { raw = classifier(event); } catch (err) {
    return { anchors, intent: "Uncertain", via: "semantic", violation: `classifier-threw: ${describeThrown(err)}` };
  }
  if (typeof raw === "string" && ALLOWED.has(raw)) return { anchors, intent: raw as Classification, via: "semantic" };
  // 非枚举结果来自外部回调:对象先过统一判定,不合规只报路径与原因;合规的纯数据副本再描述。全程不调 getter、toJSON
  if (typeof raw === "object" && raw !== null) {
    const p = plainData(raw, "分类结果");
    return { anchors, intent: "Uncertain", via: "semantic", violation: p.ok ? safeDescribe(p.value) : `分类结果只接受普通数据对象:${p.path} ${p.why}` };
  }
  return { anchors, intent: "Uncertain", via: "semantic", violation: safeDescribe(raw) };
}
