// 轮边界换模型的计划(AC-51、需求文档 D27 第 4 节)。红提交:空壳,签名在、返回假值。
import type { TurnModel } from "./types.ts";

export type TurnStep =
  | { readonly kind: "set-model"; readonly model: string }
  | { readonly kind: "set-effort"; readonly effort: string }
  | { readonly kind: "restart"; readonly model: string; readonly effort?: string }
  | { readonly kind: "send"; readonly model: string; readonly effort?: string };
export interface SwitchCapabilities {
  readonly inSessionModelSwitch: boolean;
  readonly inSessionEffort: boolean;
}
export interface SessionModel {
  readonly model: string | null;
  readonly effort?: string;
}
export function checkTurnModel(_x: unknown): TurnModel | undefined {
  return undefined;
}
export function planTurn(_current: SessionModel, _desired: TurnModel | undefined, _caps: SwitchCapabilities): readonly TurnStep[] {
  return [];
}
export function switchRefusalKind(_errorCode: unknown, _errorText: unknown): "model-rejected" | "unavailable" {
  return "model-rejected";
}
