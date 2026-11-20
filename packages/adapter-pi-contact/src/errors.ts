export type PiContactMindErrorCode = "invalid-options" | "invalid-request" | "model-mismatch" | "provider-error" | "request-limit" | "internal";
export class PiContactMindError extends Error {
  readonly code: PiContactMindErrorCode;
  readonly committed: boolean;
  readonly retryableTruncation: boolean;
  constructor(code: PiContactMindErrorCode, message: string, committed = false, retryableTruncation = false) {
    super(message);
    this.name = "PiContactMindError";
    this.code = code;
    this.committed = committed;
    this.retryableTruncation = retryableTruncation;
  }
}
export class RoundAbortedError extends Error {
  readonly code = "aborted" as const;
  constructor() {
    super("本轮已被宿主中止");
    this.name = "AbortError";
  }
}
export const isRoundAborted = (e: unknown): e is RoundAbortedError => e instanceof RoundAbortedError;
