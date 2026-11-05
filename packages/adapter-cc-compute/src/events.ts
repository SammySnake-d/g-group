// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export interface AcceptedReport {
  readonly kind: string;
  readonly summary: string;
  readonly stage?: string;
  readonly needs?: string;
  readonly constraintVer?: unknown;
  readonly openQuestions?: unknown;
  readonly doneSideEffects?: unknown;
}

export type StreamSignal =
  | { readonly type: "init"; readonly sessionId: string }
  | { readonly type: "report"; readonly report: AcceptedReport }
  | { readonly type: "result"; readonly success: boolean; readonly text: string };

export function streamParser(): (line: string) => StreamSignal[] {
  throw new Error("未实现");
}

export type Terminal =
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null };

export function terminalFor(exit: { code: number | null; signal: string | null }, result: { success: boolean; text: string } | undefined, stopRequested: boolean, stderrTail: string): Terminal {
  throw new Error("未实现");
}
