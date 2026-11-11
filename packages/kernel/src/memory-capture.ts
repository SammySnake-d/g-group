// G1 的来源与消息版本规则，纯函数；I/O 与覆盖台账归宿主。
import type { CompactMemory, ReflectSource, ReflectResult } from "./runtime-ports.ts";
export type RevisionEvent = { readonly seq: number; readonly body: { readonly kind: string; readonly target?: number } };
export function messageRevision(_events: readonly RevisionEvent[], _seq: number): number { throw new Error("G1 待实现消息版本"); }
export function statedIn(_said: string, _evidence: string): boolean { throw new Error("G1 待实现原话判定"); }
export type CaptureCheck = { ok: true; source: ReflectSource; anchors: readonly string[] } | { ok: false; reason: string };
export function validateCapture(_candidate: CompactMemory, _delivered: readonly ReflectSource[], _current: readonly ReflectSource[]): CaptureCheck { throw new Error("G1 待实现逐条来源"); }

export function decodeReflect(_input: unknown): { ok: true; value: ReflectResult } | { ok: false; reason: string } { throw new Error("G1 待实现结果合同"); }
