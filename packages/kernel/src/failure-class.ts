// 失败原因分类器(需求文档 D26 第 8.4 节,AC-43 ⑧/⑬/⑭;retry_class 沿用 AC-36 的 Transient / Permanent / MidTurn / UnknownEffect)。
// 归类由代码按带版本号的规则表做,不让模型判:
//   1. 宿主自己的结构化事实最先:用户点了停止(userStopped)、宿主卡死判定给出的情形(stall);
//   2. 其次 harness / 网关给的结构化字段:HTTP 状态、错误 kind(只认表里列出的 kind,harness 自报的 unknown 等不算依据);
//   3. 再次原文规则(按表的顺序,先命中的算);
//   例外:结构化字段只给出笼统类(400/404/invalid_request、401/403 等)时,原文命中更具体的「上下文超长 / 平台拒绝 / 会话丢失」改用具体类——
//   mirasim 把「Prompt is too long · automatic compaction failed」记成 apiError{kind: invalid_request},照抄 kind 就分不出该开新会话(D26 第 8.2 节)。
// 认不出记 unknown 并原样保留原文,不硬塞进别的类。reasonClass 给人看、定修法;retryClass 给重试策略用,两者分开(v3.13,#2747)。
// user_stopped 是人停的,不是失败的一类,只为让台账有统一出口;画板文字与失败不同、永不自动重跑。
// 纯函数,不做 I/O;导出的表与常量全部冻结。

export const FAILURE_RULES_VERSION: string = "2026-11-09.1";

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
/** D26 第 8.4 节最后一列:allowed 可自动重跑(第 5 节上限内);backoff 带退避;not_same_upstream 同上游不自动;new_session_only 不在原会话重跑;never 不自动 */
export type AutoRerun = "allowed" | "backoff" | "not_same_upstream" | "new_session_only" | "never";

export interface ReasonInfo {
  /** 画板上写的人话 */
  readonly label: string;
  /** 修法 */
  readonly fix: string;
  readonly retryClass: RetryClass;
  readonly autoRerun: AutoRerun;
  /** 同一上游连续失败就不再自动重跑到同一上游,报到画板等用户换上游(第 8.3 节) */
  readonly sameUpstreamStop: boolean;
  /** 确定不会自愈:harness 一报就判失败,不等卡死阈值(第 8.3 节) */
  readonly failFast: boolean;
  /** 这一类自己的自动重跑上限(unknown 按 AC-36 低上限 1 次);null 表示用调用方给的上限 */
  readonly autoRerunCap: number | null;
}
export interface FailureRule {
  readonly reasonClass: ReasonClass;
  readonly patterns: readonly RegExp[];
}

function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !(x instanceof RegExp)) {
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return Object.freeze(x);
}

const info = (label: string, fix: string, retryClass: RetryClass, autoRerun: AutoRerun, o: { same?: boolean; fast?: boolean; cap?: number } = {}): ReasonInfo => ({
  label,
  fix,
  retryClass,
  autoRerun,
  sameUpstreamStop: o.same ?? false,
  failFast: o.fast ?? false,
  autoRerunCap: o.cap ?? null,
});

export const REASON_TABLE: Readonly<Record<ReasonClass, ReasonInfo>> = deepFreeze({
  upstream_unavailable: info("上游不可用", "换上游或稍后", "Transient", "allowed", { same: true }),
  rate_limited: info("被限流", "等一会或换上游", "Transient", "backoff"),
  no_response: info("上游没回应", "换上游", "Transient", "not_same_upstream", { same: true }),
  stream_dropped: info("上游一直断流", "重跑;反复出现就换上游", "Transient", "allowed", { same: true }),
  stalled: info("卡住无进展", "重跑或打开会话看", "MidTurn", "allowed"),
  context_overflow: info("上下文超长,压缩失败", "开新会话带交接笔记,或先手动压缩", "Permanent", "new_session_only", { fast: true }),
  auth_or_quota: info("鉴权或额度问题", "人先修配置", "Permanent", "never", { fast: true }),
  invalid_request: info("请求被拒", "改模型配置", "Permanent", "never", { fast: true }),
  harness_crashed: info("执行器崩溃", "重跑", "MidTurn", "allowed"),
  session_lost: info("原会话找不到", "开新会话带交接笔记", "Permanent", "new_session_only", { fast: true }),
  platform_refused: info("平台拒绝", "换新会话", "Permanent", "new_session_only", { fast: true }),
  user_stopped: info("已停止", "—", "Permanent", "never"),
  unknown: info("未识别的失败", "打开会话看原文", "UnknownEffect", "backoff", { cap: 1 }),
});
export const REASON_CLASSES: readonly ReasonClass[] = Object.freeze(Object.keys(REASON_TABLE) as ReasonClass[]);

const rule = (reasonClass: ReasonClass, ...patterns: RegExp[]): FailureRule => ({ reasonClass, patterns });
/**
 * 原文规则,按顺序先命中的算。顺序有讲究:
 *   - 人停、上下文超长、平台拒绝、会话丢失这几类最具体,排最前;
 *   - 限流排在鉴权额度前(「共享额度暂时用尽」是限流,「额度用尽」是额度);
 *   - 断流排在上游不可用前(「stream disconnected … EOF (502 …)」按断流记,结构化给了 502 时按上游不可用记,两者都是瞬态);
 *   - 执行器崩溃排最后:适配器的失败说明是「进程以 N 退出:<stderr 尾巴>」,尾巴里有上游原因的按上游原因记。
 */
export const FAILURE_RULES: readonly FailureRule[] = deepFreeze([
  rule("user_stopped", /interrupted by user/i, /aborted by user/i, /用户(主动)?(停止|中断)/),
  rule(
    "context_overflow",
    /prompt is too long/i,
    /automatic compaction failed/i,
    /context[_ ](length|window)[_ ](exceeded|overflow)/i,
    /maximum context length/i,
    /exceeds? the (model'?s )?context (window|limit)/i,
    /上下文(超长|超出|溢出)|压缩失败/,
  ),
  rule("platform_refused", /cyber_policy/i, /safeguards? (have )?flagged/i, /content_policy_violation/i, /平台拒绝/),
  rule("session_lost", /no conversation found/i, /no message found/i, /conversation not found/i, /(原)?会话(找不到|不存在|丢失)/),
  rule("rate_limited", /\b429\b/, /rate[ _-]?limit/i, /too many requests/i, /限流/, /额度暂时用尽/),
  rule(
    "auth_or_quota",
    /\b40[123]\b/,
    /unauthori[sz]ed/i,
    /not authori[sz]ed/i,
    /authentication[_ ](error|failed)/i,
    /permission[_ ]error/i,
    /invalid[ _-](api[ _-]?key|x-api-key|token|bearer)/i,
    /insufficient[ _-](user[ _-])?(quota|balance|credit)/i,
    /quota[ _-](exceeded|exhausted)/i,
    /credit balance is too low/i,
    /token (has been |was )?revoked/i,
    /account (has been )?(suspended|disabled|deactivated)/i,
    /鉴权|未授权|额度(不足|用尽)|余额不足|账号(停用|被封)/,
  ),
  rule("stream_dropped", /stream disconnected/i, /stream (closed|ended|terminated) (before|prematurely|unexpectedly)/i, /premature close/i, /socket hang up/i, /ECONNRESET/, /\bEOF\b/, /断流/),
  rule(
    "upstream_unavailable",
    /\b(500|502|503|504|529)\b/,
    /overloaded/i,
    /service unavailable/i,
    /bad gateway/i,
    /gateway time-?out/i,
    /internal server error/i,
    /no (available )?upstream/i,
    /upstream (unavailable|connect error)/i,
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/,
    /平台繁忙|无可用上游|上游不可用|服务不可用/,
  ),
  rule(
    "invalid_request",
    /invalid[_ ]request/i,
    /\b400\b/,
    /bad request/i,
    /model[^\n]{0,40}(not found|does not exist|is not supported|not supported)/i,
    /unsupported model|unknown model/i,
    /not_found_error/i,
    /模型(不存在|不支持)|请求无效/,
  ),
  rule(
    "harness_crashed",
    /error_during_execution/i,
    /进程以 -?\d+ 退出/,
    /进程被信号 \w+ 结束/,
    /CLI (没有给出结束结果|报告执行出错)/,
    /exited with code -?\d+/i,
    /SIGSEGV|SIGABRT|segmentation fault/i,
    /执行器(异常退出|崩溃)/,
  ),
]);

/** harness / 网关结构化错误 kind 中能直接定类的(只认这些;unknown 与没列出的 kind 不算依据) */
const KIND: Readonly<Record<string, ReasonClass>> = deepFreeze({
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  rate_limit_error: "rate_limited",
  overloaded: "upstream_unavailable",
  overloaded_error: "upstream_unavailable",
  api_error: "upstream_unavailable",
  server_error: "upstream_unavailable",
  upstream_unavailable: "upstream_unavailable",
  authentication_error: "auth_or_quota",
  permission_error: "auth_or_quota",
  billing_error: "auth_or_quota",
  auth: "auth_or_quota",
  quota: "auth_or_quota",
  invalid_request: "invalid_request",
  invalid_request_error: "invalid_request",
  not_found_error: "invalid_request",
  context_overflow: "context_overflow",
  prompt_too_long: "context_overflow",
  stream_dropped: "stream_dropped",
  stream_disconnected: "stream_dropped",
  session_lost: "session_lost",
  platform_refused: "platform_refused",
});
const byStatus = (s: number): ReasonClass | null => {
  if (s === 429) return "rate_limited";
  if (s === 401 || s === 402 || s === 403) return "auth_or_quota";
  if (s === 400 || s === 404 || s === 409 || s === 413 || s === 422) return "invalid_request";
  if (s === 408 || (s >= 500 && s <= 599)) return "upstream_unavailable";
  return null;
};
/** 结构化字段只给出笼统类时,原文命中这几类就改用具体类 */
const REFINABLE: ReadonlySet<ReasonClass> = new Set<ReasonClass>(["invalid_request", "auth_or_quota"]);
const SPECIFIC: ReadonlySet<ReasonClass> = new Set<ReasonClass>(["context_overflow", "platform_refused", "session_lost"]);
/** 只按原文开头这么长匹配(原文照样整段保留) */
const MATCH_CHARS = 8000;

function byText(text: string, only?: ReadonlySet<ReasonClass>): { reasonClass: ReasonClass; pattern: string } | null {
  const head = text.slice(0, MATCH_CHARS);
  for (const r of FAILURE_RULES) {
    if (only && !only.has(r.reasonClass)) continue;
    const hit = r.patterns.find((p) => p.test(head));
    if (hit) return { reasonClass: r.reasonClass, pattern: hit.source };
  }
  return null;
}

export interface FailureInput {
  /** 原始错误文本(harness 报错、退出说明、stderr 尾巴);认不出时原样保留 */
  readonly text: string;
  readonly httpStatus?: number | null;
  /** harness / 网关给的结构化错误 kind */
  readonly kind?: string | null;
  /** 用户点了停止(宿主自己的事实) */
  readonly userStopped?: boolean;
  /** 宿主卡死判定给出的情形(第 8.3 节) */
  readonly stall?: "no_response" | "stalled" | "stream_dropped" | null;
}
export interface FailureClass {
  readonly reasonClass: ReasonClass;
  readonly retryClass: RetryClass;
  readonly autoRerun: AutoRerun;
  /** 画板上写的人话 */
  readonly label: string;
  /** 原文,认不出也保留 */
  readonly raw: string;
  readonly rulesVersion: string;
  readonly fix: string;
  readonly sameUpstreamStop: boolean;
  readonly failFast: boolean;
  readonly autoRerunCap: number | null;
  /** 按哪一层判的(写进判定日志) */
  readonly via: "userStopped" | "stall" | "httpStatus" | "kind" | "text" | "none";
  /** 原文规则命中的那条(via=text 或细化时) */
  readonly pattern: string | null;
}

export function classifyFailure(input: FailureInput): FailureClass {
  const x = (typeof input === "object" && input !== null ? input : {}) as Partial<FailureInput>;
  const raw = typeof x.text === "string" ? x.text : "";
  let reasonClass: ReasonClass = "unknown";
  let via: FailureClass["via"] = "none";
  let pattern: string | null = null;
  const status = typeof x.httpStatus === "number" && Number.isInteger(x.httpStatus) ? byStatus(x.httpStatus) : null;
  const kind = typeof x.kind === "string" && Object.hasOwn(KIND, x.kind) ? (KIND[x.kind] ?? null) : null;
  if (x.userStopped === true) {
    reasonClass = "user_stopped";
    via = "userStopped";
  } else if (x.stall === "no_response" || x.stall === "stalled" || x.stall === "stream_dropped") {
    reasonClass = x.stall;
    via = "stall";
  } else if (status || kind) {
    reasonClass = (status ?? kind)!;
    via = status ? "httpStatus" : "kind";
    if (REFINABLE.has(reasonClass)) {
      const t = byText(raw, SPECIFIC);
      if (t) {
        reasonClass = t.reasonClass;
        pattern = t.pattern;
      }
    }
  } else {
    const t = byText(raw);
    if (t) {
      reasonClass = t.reasonClass;
      via = "text";
      pattern = t.pattern;
    }
  }
  const i = REASON_TABLE[reasonClass];
  return Object.freeze({
    reasonClass,
    retryClass: i.retryClass,
    autoRerun: i.autoRerun,
    label: i.label,
    raw,
    rulesVersion: FAILURE_RULES_VERSION,
    fix: i.fix,
    sameUpstreamStop: i.sameUpstreamStop,
    failFast: i.failFast,
    autoRerunCap: i.autoRerunCap,
    via,
    pattern,
  });
}
