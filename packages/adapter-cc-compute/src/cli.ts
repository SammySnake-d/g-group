// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */
import type { Brief, HandoffSnapshot, ManifestSection } from "./types.ts";

export const REPORT_TOOL = "mcp__host__report_progress";
export const SYSTEM_PROMPT = "";

export function firstPrompt(brief: Brief, handoff?: HandoffSnapshot): { readonly prompt: string; readonly sections: readonly ManifestSection[] } {
  throw new Error("未实现");
}

export function allowedTools(brief: Brief): readonly string[] {
  throw new Error("未实现");
}

export function toolOverreach(brief: Brief, initTools: readonly string[]): readonly string[] {
  throw new Error("未实现");
}

export function cliArgs(brief: Brief, prompt: string, mcpConfigPath: string, resumeSession?: string): readonly string[] {
  throw new Error("未实现");
}

export function cliEnv(brief: Brief, computeId: string, hostEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  throw new Error("未实现");
}
