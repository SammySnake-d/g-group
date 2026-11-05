/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 先机械后语义(AC-11)与固定枚举(AC-12)。
// 机械锚点(@、↩ #seq、确认卡版本号)与意图分开:锚点总是机械提取,只用于路由;
// 只有锚点本身能确定意图时才不调分类器:
//   - 用户对确认卡的结构化回复(卡号 + 版本 + 决定)→ E6;
//   - 纯点名:按结构化 mention 的确切范围去掉 @名字 后正文真为空 → E1。
// 带 @ 或引用但有文字的消息(停止、修改、纠偏……,哪怕和 @ 之间没有空格、只隔中文标点)意图不能机械确定,交给分类器。
// 分类器只能出 E1..E10 或 Uncertain;其它任何值(含无法序列化的)都封闭为 Uncertain 并记违规。

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

export function safeDescribe(x: unknown): string {
  throw new Error("未实现");
}

export function classifyInbound(event: InboundEvent, classifier: Classifier): ClassifyResult {
  throw new Error("未实现");
}
