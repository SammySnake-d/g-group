// 拼装 claude CLI 的启动参数、环境与首个提示。全部是纯函数,适配器只负责把它们交给子进程。
import os from "node:os";
import type { Brief, HandoffSnapshot, ManifestSection } from "./types.ts";

export const REPORT_TOOL = "mcp__host__report_progress";

export const SYSTEM_PROMPT =
  "你是宿主派出的 Compute。宿主只通过 report_progress 工具了解你的进展:开始时报 started,每完成一个阶段报 milestone(带 stage)," +
  "无法继续需要用户时报 blocked(带 needs)然后立即停止,全部完成报 completed。知道当前约束版本、未决问题或已完成的副作用时," +
  "随汇报带上 constraintVer/openQuestions/doneSideEffects。凭据只有引用句柄,需要时向宿主申请,不要猜测明文。不要只用文字汇报。";

export function firstPrompt(brief: Brief, handoff?: HandoffSnapshot): { readonly prompt: string; readonly sections: readonly ManifestSection[] } {
  const parts: string[] = [`[任务]\n${brief.task}`];
  const sections: ManifestSection[] = [{ name: "task", detail: { text: brief.task } }];
  parts.push(`[生效群规与硬约束]\n${brief.rules.length ? brief.rules.map((r) => `- ${r}`).join("\n") : "(无)"}`);
  sections.push({ name: "rules", detail: { items: [...brief.rules] } });
  if (handoff) {
    const list = (xs: readonly string[]) => (xs.length ? xs.map((s) => `- ${s}`).join("\n") : "(无)");
    parts.push(`[交接快照]\n约束版本: ${handoff.constraintVer}\n未决问题:\n${list(handoff.openQuestions)}\n已完成副作用(不要重做):\n${list(handoff.doneSideEffects)}`);
    sections.push({ name: "handoff", detail: { constraintVer: handoff.constraintVer, openQuestions: [...handoff.openQuestions], doneSideEffects: [...handoff.doneSideEffects] } });
  }
  if (brief.credentialRefs.length) {
    parts.push(`[凭据引用]\n${brief.credentialRefs.map((c) => `- ${c}(句柄,不是明文)`).join("\n")}`);
    sections.push({ name: "credentialRefs", detail: { refs: [...brief.credentialRefs] } });
  }
  return { prompt: parts.join("\n\n"), sections };
}

export function allowedTools(brief: Brief): readonly string[] {
  return [...brief.tools, REPORT_TOOL];
}

/** CLI init 里实际挂上的工具超出 brief 授权的部分(空数组表示没有越界) */
export function toolOverreach(brief: Brief, initTools: readonly string[]): readonly string[] {
  const allowed = new Set(allowedTools(brief));
  return initTools.filter((t) => !allowed.has(t));
}

export function cliArgs(brief: Brief, prompt: string, mcpConfigPath: string, resumeSession?: string): readonly string[] {
  return [
    "-p", prompt,
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "--output-format", "stream-json", "--verbose",
    // --bare:不读 CLAUDE.md、auto-memory、hooks 与插件,Compute 不带宿主一侧的记忆
    "--bare",
    "--mcp-config", mcpConfigPath, "--strict-mcp-config",
    // --tools 限定可见的内置工具,--allowedTools + dontAsk 让清单外的调用一律被拒
    "--tools", brief.tools.join(","),
    "--allowedTools", allowedTools(brief).join(","),
    "--permission-mode", "dontAsk",
    "--append-system-prompt", SYSTEM_PROMPT,
  ];
}

/** 子进程环境:不继承宿主进程的整份 env;凭据只以引用句柄出现 */
export function cliEnv(brief: Brief, computeId: string, hostEnv: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: os.tmpdir(),
    ...hostEnv,
    G_GROUP_COMPUTE_ID: computeId,
    G_GROUP_CREDENTIAL_REFS: JSON.stringify(brief.credentialRefs),
  };
}
