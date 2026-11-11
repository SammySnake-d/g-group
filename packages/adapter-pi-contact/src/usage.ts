// 用量回报与缓存断点(AC-39 ③⑤⑥)——红提交的空壳:签名在,返回假值。
import type { ModelUsage, UsageSink } from "@g-group/kernel";

export function usageLine(_provider: string, _baseUrl: string, _model: string, _secret: string): string {
  return "";
}
export function countBreakpoints(_payload: unknown): number {
  return 0;
}
export function placeBreakpoints(payload: unknown): unknown {
  return payload;
}
export interface RequestProbe {
  readonly prefixHash: string;
  readonly breakpoints: number;
}
export function probeRequest(_payload: unknown): RequestProbe {
  return { prefixHash: "", breakpoints: 0 };
}
export function usageOf(_line: string, _request: number, _probe: RequestProbe | null, _u: unknown): ModelUsage | null {
  return null;
}
export function report(_sink: UsageSink | undefined, _u: ModelUsage | null): void {}
