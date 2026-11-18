export type PiContactMindErrorCode = "invalid-options" | "invalid-request" | "model-mismatch" | "provider-error" | "request-limit" | "internal";
/** 可辨认的失败。message 已隐去密钥。 */
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
/** 宿主中止本轮(signal abort)。name 为 AbortError,便于按惯例识别。 */
export class RoundAbortedError extends Error {
  readonly code = "aborted" as const;
  constructor() {
    super("本轮已被宿主中止");
    this.name = "AbortError";
  }
}
export const isRoundAborted = (e: unknown): e is RoundAbortedError => e instanceof RoundAbortedError;
