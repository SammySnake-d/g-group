// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export interface AcceptedReport {
  readonly kind: "started" | "milestone" | "blocked" | "completed" | "failed";
  readonly summary: string;
  readonly stage?: string;
  readonly needs?: string;
  readonly constraintVer?: number;
  readonly openQuestions?: readonly string[];
  readonly doneSideEffects?: readonly string[];
}

export type StreamSignal =
  | { readonly type: "init"; readonly sessionId: string; readonly tools: readonly string[] }
  | { readonly type: "bad-init"; readonly reason: string }
  | { readonly type: "report"; readonly report: AcceptedReport }
  | { readonly type: "invalid-report"; readonly kind: unknown; readonly errors: readonly string[] }
  | { readonly type: "rejected-report"; readonly kind: unknown; readonly reason: string }
  | { readonly type: "result"; readonly success: boolean; readonly text: string };

export function checkInit(m: Record<string, unknown>): StreamSignal {
  throw new Error("未实现");
}

export function streamParser(): (line: string) => StreamSignal[] {
  throw new Error("未实现");
}

export type Terminal =
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null; readonly violations: readonly string[] }
  | { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null; readonly scope: "process-group"; readonly violations: readonly string[] }
  | { readonly kind: "paused-blocked" };

export interface RoundFacts {
  readonly stopRequested: boolean;
  readonly violations: readonly string[];
  readonly pausedBlocked: boolean;
  readonly reportedFailure?: string;
  readonly unresolved: readonly string[];
}

export function terminalFor(exit: { code: number | null; signal: string | null }, result: { success: boolean; text: string } | undefined, facts: RoundFacts, stderrTail: string): Terminal {
  throw new Error("未实现");
}
