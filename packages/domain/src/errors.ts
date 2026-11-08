// 领域错误:带稳定的 code,调用方按 code 分支,不按文案。
export type DomainErrorCode =
  | "sender-not-allowed"
  | "target-not-found"
  | "target-not-message"
  | "target-retracted"
  | "not-original-sender"
  | "empty-text";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
