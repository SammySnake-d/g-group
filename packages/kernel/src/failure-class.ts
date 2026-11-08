// 失败原因分类器(需求文档 D26 第 8.4 节,AC-43 ⑧/⑬/⑭;retry_class 沿用 AC-36)。空壳:签名在,返回假值。

export const FAILURE_RULES_VERSION: string = "";

export type ReasonClass =
  | "upstream_unavailable"
  | "rate_limited"
  | "no_response"
  | "stream_dropped"
  | "stalled"
  | "context_overflow"
  | "auth_or_quota"
  | "invalid_request"
  | "harness_crashed"
  | "session_lost"
  | "platform_refused"
  | "user_stopped"
  | "unknown";
export type RetryClass = "Transient" | "Permanent" | "MidTurn" | "UnknownEffect";
export type AutoRerun = "allowed" | "backoff" | "not_same_upstream" | "new_session_only" | "never";

export interface ReasonInfo {
  readonly label: string;
  readonly fix: string;
  readonly retryClass: RetryClass;
  readonly autoRerun: AutoRerun;
  readonly sameUpstreamStop: boolean;
  readonly failFast: boolean;
  readonly autoRerunCap: number | null;
}
export interface FailureRule {
  readonly reasonClass: ReasonClass;
  readonly patterns: readonly RegExp[];
}

export const REASON_CLASSES: readonly ReasonClass[] = [];
export const REASON_TABLE = {} as Readonly<Record<ReasonClass, ReasonInfo>>;
export const FAILURE_RULES: readonly FailureRule[] = [];

export interface FailureInput {
  readonly text: string;
  readonly httpStatus?: number | null;
  readonly kind?: string | null;
  readonly userStopped?: boolean;
  readonly stall?: "no_response" | "stalled" | "stream_dropped" | null;
}
export interface FailureClass {
  readonly reasonClass: ReasonClass;
  readonly retryClass: RetryClass;
  readonly autoRerun: AutoRerun;
  readonly label: string;
  readonly raw: string;
  readonly rulesVersion: string;
  readonly fix: string;
  readonly sameUpstreamStop: boolean;
  readonly failFast: boolean;
  readonly autoRerunCap: number | null;
  readonly via: "userStopped" | "stall" | "httpStatus" | "kind" | "text" | "none";
  readonly pattern: string | null;
}

export function classifyFailure(_input: FailureInput): FailureClass {
  return { reasonClass: "unknown", retryClass: "Transient", autoRerun: "allowed", label: "", raw: "", rulesVersion: "", fix: "", sameUpstreamStop: false, failFast: false, autoRerunCap: null, via: "none", pattern: null };
}
