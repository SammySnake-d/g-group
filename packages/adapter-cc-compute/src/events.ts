// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */
// 把一次 CLI 运行的 stream-json 行与进程退出映射成语义事件。
// V-06 约束:milestone 会漏报,不能当进度真值;completed 只看 CLI 的 result 与退出码,不看 report_progress 的 completed。
// 但 Compute 明确汇报了 failed(放弃)时,CLI 的 success 只说明这轮对话正常结束,不能报成任务完成。

/** 通过 report_progress schema 校验的一次汇报 */
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
  /** 形状合规、工具列表是字符串数组、host MCP 已 connected 的 init */
  | { readonly type: "init"; readonly sessionId: string; readonly tools: readonly string[] }
  /** 收到了 init 但无法核验(RR-02):形状不合、工具列表不是字符串数组、host MCP 未连接或缺 report_progress */
  | { readonly type: "bad-init"; readonly reason: string }
  | { readonly type: "report"; readonly report: AcceptedReport }
  /** 服务器回了 tool_result 但内容不合 schema(服务器校验失效时的第二道防线) */
  | { readonly type: "invalid-report"; readonly kind: unknown; readonly errors: readonly string[] }
  /** 服务器或 CLI 拒收(tool_result is_error)的汇报,记录下来;kind 是 Compute 想报的种类 */
  | { readonly type: "rejected-report"; readonly kind: unknown; readonly reason: string }
  | { readonly type: "result"; readonly success: boolean; readonly text: string };


/** 有状态的行解析器:记住 report_progress 的 tool_use,等到对应 tool_result 被服务器接收才算一次汇报;
 *  服务器接收了但不合 schema 的汇报单独报出,不当成有效汇报 */
/** 核验 CLI 的 init 行:不把缺失或畸形的工具列表当成空集 */
export function checkInit(m: Record<string, unknown>): StreamSignal {
  throw new Error("未实现");
}

/** init 之前真实 CLI 会输出的 system 帧(原型与 smoke 的 stream-json 里见过);其它一律不认可(R3-03) */
export const PRE_INIT_SYSTEM_SUBTYPES: readonly string[] = ["hook_started", "hook_response", "ui_invalidate"];

/** init 之前的一行:init 本身交给解析器;认可清单里的 system 帧直接放过;其余(非 JSON、assistant、user、result、
 *  未列出的 system 帧、未知类型)全部拒绝,不进入解析器,init 前的 tool_use 就不会被记住 */
export function preInitFrame(line: string): { readonly kind: "init" } | { readonly kind: "allowed" } | { readonly kind: "rejected"; readonly reason: string } {
  throw new Error("未实现");
}

export function streamParser(): (line: string) => StreamSignal[] {
  throw new Error("未实现");
}

export type Terminal =
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null; readonly violations: readonly string[] }
  | { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null; readonly scope: "main-then-group"; readonly violations: readonly string[] }
  /** 已受理 blocked 后适配器冻结并回收了进程组:这一轮停在受阻,不产出新事件,等宿主 resume 或 stop */
  | { readonly kind: "paused-blocked" };

/** 这一轮里适配器自己看到的情况 */
export interface RoundFacts {
  readonly stopRequested: boolean;
  /** 适配器判定的违规(工具越界、init 无法核验或缺失),按发生顺序 */
  readonly violations: readonly string[];
  /** 已受理 blocked,进程组已被 SIGSTOP 冻结 */
  readonly pausedBlocked: boolean;
  /** Compute 经 report_progress 明确汇报的放弃 */
  readonly reportedFailure?: string;
  /** 被拒收、还没有同种合规重报或宿主解除的 blocked/failed */
  readonly unresolved: readonly string[];
}

/** 决定这一轮的对外终态。优先级(RR-05,对齐 mirasim 后去掉了"后代树未清"一档):
 *  停止 > 违规 > 停在受阻 > 进程/CLI 失败 > 汇报放弃 > 拒收未解决 > 完成。违规保留在 violations 里可审计。 */
export function terminalFor(exit: { code: number | null; signal: string | null }, result: { success: boolean; text: string } | undefined, facts: RoundFacts, stderrTail: string): Terminal {
  throw new Error("未实现");
}
