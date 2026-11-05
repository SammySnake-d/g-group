// 把一次 CLI 运行的 stream-json 行与进程退出映射成语义事件。
// V-06 约束:milestone 会漏报,不能当进度真值;completed 只看 CLI 的 result 与退出码,不看 report_progress 的 completed。
// 但 Compute 明确汇报了 failed(放弃)时,CLI 的 success 只说明这轮对话正常结束,不能报成任务完成。
import { REPORT_TOOL } from "./cli.ts";
import { reportErrors } from "./report-schema.ts";

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
  | { readonly type: "init"; readonly sessionId: string; readonly tools: readonly string[] }
  | { readonly type: "report"; readonly report: AcceptedReport }
  /** 服务器回了 tool_result 但内容不合 schema(服务器校验失效时的第二道防线) */
  | { readonly type: "invalid-report"; readonly kind: unknown; readonly errors: readonly string[] }
  /** 服务器或 CLI 拒收(tool_result is_error)的汇报,记录下来;kind 是 Compute 想报的种类 */
  | { readonly type: "rejected-report"; readonly kind: unknown; readonly reason: string }
  | { readonly type: "result"; readonly success: boolean; readonly text: string };

type Json = Record<string, unknown>;
const asRecord = (x: unknown): Json | undefined => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Json) : undefined);
const blocks = (m: Json): Json[] => {
  const c = asRecord(m.message)?.content;
  return Array.isArray(c) ? c.map(asRecord).filter((b): b is Json => b !== undefined) : [];
};

/** 有状态的行解析器:记住 report_progress 的 tool_use,等到对应 tool_result 被服务器接收才算一次汇报;
 *  服务器接收了但不合 schema 的汇报单独报出,不当成有效汇报 */
export function streamParser(): (line: string) => StreamSignal[] {
  const pending = new Map<string, unknown>();
  return (line) => {
    let m: Json | undefined;
    try { m = asRecord(JSON.parse(line)); } catch { return []; }
    if (!m) return [];
    const out: StreamSignal[] = [];
    if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
      const tools = Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === "string") : [];
      out.push({ type: "init", sessionId: m.session_id, tools });
    }
    if (m.type === "assistant") {
      for (const b of blocks(m)) if (b.type === "tool_use" && b.name === REPORT_TOOL && typeof b.id === "string") pending.set(b.id, b.input);
    }
    if (m.type === "user") {
      for (const b of blocks(m)) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string" || !pending.has(b.tool_use_id)) continue;
        const input = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        if (b.is_error === true) {
          const c = b.content;
          const reason = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (asRecord(x)?.text as string | undefined) ?? "").join("") : "";
          out.push({ type: "rejected-report", kind: asRecord(input)?.kind, reason });
          continue;
        }
        const errors = reportErrors(input);
        out.push(errors.length ? { type: "invalid-report", kind: asRecord(input)?.kind, errors } : { type: "report", report: input as AcceptedReport });
      }
    }
    if (m.type === "result") out.push({ type: "result", success: m.subtype === "success" && m.is_error !== true, text: typeof m.result === "string" ? m.result : "" });
    return out;
  };
}

export type Terminal =
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null };

/** 这一轮里适配器自己看到的情况 */
export interface RoundFacts {
  readonly stopRequested: boolean;
  /** 适配器判定的违规(工具清单越界、汇报不合 schema、进程组没退空) */
  readonly fault?: string;
  /** Compute 经 report_progress 明确汇报的放弃 */
  readonly reportedFailure?: string;
}

/** 进程(及其进程组)已经退出后才调用:决定这一轮的终态。优先级:停止 > 适配器违规 > 进程/CLI 失败 > 汇报放弃 > 完成 */
export function terminalFor(exit: { code: number | null; signal: string | null }, result: { success: boolean; text: string } | undefined, facts: RoundFacts, stderrTail: string): Terminal {
  const fail = (reason: string): Terminal => ({ kind: "failed", reason, code: exit.code, signal: exit.signal });
  if (facts.stopRequested && facts.fault === undefined) return { kind: "stopped", code: exit.code, signal: exit.signal };
  if (facts.fault !== undefined) return fail(facts.fault);
  if (exit.code === 0 && exit.signal === null && result?.success) {
    if (facts.reportedFailure !== undefined) return fail(`Compute 汇报放弃:${facts.reportedFailure}`);
    return { kind: "completed", result: result.text };
  }
  const why = exit.signal !== null ? `进程被信号 ${exit.signal} 结束` : exit.code !== 0 ? `进程以 ${exit.code} 退出` : result ? "CLI 报告执行出错" : "CLI 没有给出结束结果";
  return fail(stderrTail ? `${why}:${stderrTail}` : why);
}
