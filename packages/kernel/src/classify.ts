/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
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

/** 任何值都能得到一段诊断文字,自己绝不抛错(循环对象、BigInt、toJSON 抛错、Symbol……)。 */
export function safeDescribe(x: unknown): string {
  throw new Error("未实现");
}

export function classifyInbound(event: InboundEvent, classifier: Classifier): ClassifyResult {
  throw new Error("未实现");
}
