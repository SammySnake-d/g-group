// 把一次 CLI 运行的 stream-json 行与进程退出映射成语义事件。
// V-06 约束:milestone 会漏报,不能当进度真值;completed 只看 CLI 的 result 和退出码,不看 report_progress。
import { REPORT_TOOL } from "./cli.ts";

/** 被 report_progress 服务器接收(tool_result 非 is_error)的一次汇报 */
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

type Json = Record<string, unknown>;
const asRecord = (x: unknown): Json | undefined => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Json) : undefined);
const blocks = (m: Json): Json[] => {
  const c = asRecord(m.message)?.content;
  return Array.isArray(c) ? c.map(asRecord).filter((b): b is Json => b !== undefined) : [];
};

/** 有状态的行解析器:记住 report_progress 的 tool_use,等到对应 tool_result 被接收才算一次汇报 */
export function streamParser(): (line: string) => StreamSignal[] {
  const pending = new Map<string, Json>();
  return (line) => {
    let m: Json | undefined;
    try { m = asRecord(JSON.parse(line)); } catch { return []; }
    if (!m) return [];
    const out: StreamSignal[] = [];
    if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") out.push({ type: "init", sessionId: m.session_id });
    if (m.type === "assistant") {
      for (const b of blocks(m)) if (b.type === "tool_use" && b.name === REPORT_TOOL && typeof b.id === "string") pending.set(b.id, asRecord(b.input) ?? {});
    }
    if (m.type === "user") {
      for (const b of blocks(m)) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const input = pending.get(b.tool_use_id);
        if (!input) continue;
        pending.delete(b.tool_use_id);
        if (b.is_error === true) continue;
        if (typeof input.kind !== "string" || typeof input.summary !== "string") continue;
        out.push({ type: "report", report: input as unknown as AcceptedReport });
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

/** 进程已经退出后才调用:决定这一轮的终态 */
export function terminalFor(exit: { code: number | null; signal: string | null }, result: { success: boolean; text: string } | undefined, stopRequested: boolean, stderrTail: string): Terminal {
  if (stopRequested) return { kind: "stopped", code: exit.code, signal: exit.signal };
  if (exit.code === 0 && exit.signal === null && result?.success) return { kind: "completed", result: result.text };
  const why = exit.signal !== null ? `进程被信号 ${exit.signal} 结束` : exit.code !== 0 ? `进程以 ${exit.code} 退出` : result ? "CLI 报告执行出错" : "CLI 没有给出结束结果";
  return { kind: "failed", reason: stderrTail ? `${why}:${stderrTail}` : why, code: exit.code, signal: exit.signal };
}
