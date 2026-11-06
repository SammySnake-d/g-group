// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */
import { fileURLToPath } from "node:url";
import type { AdapterOptions, ClaudeRunner, ComputeAdapter } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });
export const DEFAULT_REAP_FORCE_MS = 10_000;

export function resolveReapForceMs(explicit: number | undefined, env: string | undefined): number {
  throw new Error("未实现");
}

export function createComputeAdapter(options: AdapterOptions = {}): ComputeAdapter {
  throw new Error("未实现");
}
