// G5 两段式记忆的纯规则(BC 定稿 v0.2 §7;G1→G5 写入切换规则与审查条件 S-2)。红提交:只有签名与假返回值。
// 术语:这里的「粗筛 / 精筛」指记忆的「粗筛打标(同一次 reflect 顺带)/ 精筛提炼(批处理)」,和需求文档 D06 找旧消息的「粗筛自动、精筛内置」(宿主预取 + 内置查询工具,归 G4)不是一回事。
import type { CaptureCheck } from "./memory-capture.ts";
import type { CompactMemory, MarkKind } from "./runtime-ports.ts";

export interface FineScreenPolicy {
  readonly maxMarks: number;
  readonly maxBytes: number;
  readonly quietMs: number;
  readonly maxPending: number;
  readonly maxAgeMs: number;
  readonly leaseMs: number;
  readonly neighborRadius: number;
}
export const DEFAULT_FINE_SCREEN: Readonly<FineScreenPolicy> = Object.freeze({ maxMarks: 8, maxBytes: 24 * 1024, quietMs: 5 * 60_000, maxPending: 20, maxAgeMs: 60 * 60_000, leaseMs: 20 * 60_000, neighborRadius: 3 });

export function markCandidateKey(_roomId: string, _seq: number, _revision: number, _kind: MarkKind, _evidence: string) {
  return "";
}
export function takeoverMarkId(_coverageId: string, _candidateKey: string, _revision: number) {
  return "";
}
export type CaptureRoute = "direct" | "mark" | "debt";
export function routeCapture(_m: CompactMemory, _check: CaptureCheck): CaptureRoute {
  return "debt";
}
export interface FineCandidate {
  readonly id: string;
  readonly bytes: number;
  readonly createdAt: number;
}
export function selectFineBatch(_items: readonly FineCandidate[], _policy: Pick<FineScreenPolicy, "maxMarks" | "maxBytes">): { take: string[]; oversize: string[] } {
  return { take: [], oversize: [] };
}
export type FineTrigger = "explicit" | "backlog" | "age" | "quiet";
export function fineTrigger(_s: { readonly pending: number; readonly oldestAt: number | null; readonly quietSince: number; readonly now: number; readonly explicit: boolean }, _policy: Pick<FineScreenPolicy, "maxPending" | "maxAgeMs" | "quietMs">): FineTrigger | null {
  return null;
}
