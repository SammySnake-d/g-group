/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 先机械后语义(AC-11)与固定枚举(AC-12):有 @、↩ #seq、版本号可判定时不调分类器;分类器只能出 E1..E10 或 Uncertain。

export const EVENT_CODES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"] as const;
export type EventCode = (typeof EVENT_CODES)[number];
export type Classification = EventCode | "Uncertain";

export interface InboundEvent {
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly quotes?: readonly number[];
  /** 回复所绑定的版本号(如确认卡的 version),有就能机械判定 */
  readonly version?: number;
}
export type Cue = "mention" | "quote" | "version";
export type Classifier = (event: InboundEvent) => unknown;
export interface ClassifyResult {
  readonly event: Classification;
  readonly via: "mechanical" | "semantic";
  readonly cues: readonly Cue[];
  /** 分类器返回了枚举之外的东西时记下原值,结果按 Uncertain 处理 */
  readonly violation?: string;
}

export function classifyInbound(event: InboundEvent, classifier: Classifier): ClassifyResult {
  throw new Error("未实现");
}
