// 先机械后语义(AC-11)与固定枚举(AC-12)。
// 机械锚点(@、↩ #seq、确认卡版本号)与意图分开:锚点总是机械提取,只用于路由;
// 只有锚点本身能确定意图时才不调分类器:
//   - 用户对确认卡的结构化回复(卡号 + 版本 + 决定)→ E6;
//   - 只有 @、没有别的文字的点名 → E1。
// 带 @ 或引用但有文字的消息(停止、修改、纠偏……)意图不能机械确定,交给分类器。
// 分类器只能出 E1..E10 或 Uncertain;其它任何值(含无法序列化的)都封闭为 Uncertain 并记违规。

export const EVENT_CODES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"] as const;
export type EventCode = (typeof EVENT_CODES)[number];
export type Classification = EventCode | "Uncertain";

export type CardDecision = "approve" | "reject";
/** 用户点确认卡产生的结构化回复 */
export interface CardReply { readonly cardId: string; readonly version: number; readonly decision: CardDecision }
export interface InboundEvent {
  readonly sender: { readonly kind: string; readonly id: string };
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly quotes?: readonly number[];
  readonly card?: CardReply;
}
export interface Anchors { readonly mentions: readonly string[]; readonly quotes: readonly number[]; readonly card?: CardReply }
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

/** 任何值都能得到一段诊断文字,自己绝不抛错(循环对象、BigInt、toJSON 抛错、Symbol……)。 */
export function safeDescribe(x: unknown): string {
  try {
    if (typeof x === "string") return x;
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "symbol" || typeof x === "function" || x === undefined) return String(x);
    const seen = new WeakSet<object>();
    const s = JSON.stringify(x, (_k, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "object" && v !== null) { if (seen.has(v)) return "[循环]"; seen.add(v); }
      return v;
    });
    return s ?? String(x);
  } catch (err) {
    let tag = "unknown";
    try { tag = Object.prototype.toString.call(x); } catch { /* 保持 unknown */ }
    let why = "";
    try { why = err instanceof Error ? err.message : String(err); } catch { /* 异常本身也不可读 */ }
    return `<无法序列化 ${tag}${why ? `: ${why}` : ""}>`;
  }
}

function anchorsOf(e: InboundEvent): Anchors {
  const mentions = Array.isArray(e.mentions) ? e.mentions.filter((m) => typeof m === "string" && m !== "") : [];
  const quotes = Array.isArray(e.quotes) ? e.quotes.filter((q) => Number.isInteger(q) && q > 0) : [];
  return e.card === undefined ? { mentions, quotes } : { mentions, quotes, card: e.card };
}

/** 确认卡回复的合同:发起人必须是用户本人,卡号非空,版本是正整数,决定在枚举内。 */
function cardViolation(e: InboundEvent, c: CardReply): string | undefined {
  if (e.sender?.kind !== "user") return `确认卡只能由用户回复,来者是 ${safeDescribe(e.sender?.kind)}`;
  if (typeof c.cardId !== "string" || c.cardId === "") return "确认卡回复缺卡号";
  if (!Number.isInteger(c.version) || c.version < 1) return `确认卡版本必须是正整数,收到 ${safeDescribe(c.version)}`;
  if (typeof c.decision !== "string" || !DECISIONS.has(c.decision)) return `确认卡决定必须是 approve | reject,收到 ${safeDescribe(c.decision)}`;
  return undefined;
}

/** 去掉 @名字 后没有别的文字:纯点名 */
function mentionOnly(e: InboundEvent, a: Anchors): boolean {
  return a.mentions.length > 0 && a.quotes.length === 0 && e.text.replace(/@\S+/g, "").trim() === "";
}

export function classifyInbound(event: InboundEvent, classifier: Classifier): ClassifyResult {
  const anchors = anchorsOf(event);
  if (anchors.card !== undefined) {
    const bad = cardViolation(event, anchors.card);
    if (bad) return { anchors, intent: "Uncertain", via: "mechanical", violation: bad };
    const { cardId, version, decision } = anchors.card;
    return { anchors, intent: "E6", via: "mechanical", target: { cardId, version, decision } };
  }
  if (mentionOnly(event, anchors)) return { anchors, intent: "E1", via: "mechanical" };
  let raw: unknown;
  try { raw = classifier(event); } catch (err) {
    return { anchors, intent: "Uncertain", via: "semantic", violation: `classifier-threw: ${safeDescribe(err instanceof Error ? err.message : err)}` };
  }
  if (typeof raw === "string" && ALLOWED.has(raw)) return { anchors, intent: raw as Classification, via: "semantic" };
  return { anchors, intent: "Uncertain", via: "semantic", violation: safeDescribe(raw) };
}
