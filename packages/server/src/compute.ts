// 真实 Claude Code Compute 的接线(AC-51):给宿主一个按 Harness 复用的适配器工厂。
// 用常驻适配器:同一会话、同一进程跨轮,宿主每一轮把生效模型交给它,它在轮边界会话内换模型(D27 第 4 节)。
// 进程环境只带网关地址与令牌;模型不写进环境(写进去就成了「启动时定模型」,F05 的反例)。
// 空闲会话按时回收,下一轮用同一会话 id 带这一轮的生效模型恢复(D27 第 4 节第 7 条:是否常驻、何时回收是宿主的资源策略)。
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import { createResidentComputeAdapter } from "@g-group/adapter-cc-compute/resident";

const PASS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
/** 常驻会话空闲多久回收进程(毫秒);下一轮用同一会话 id 恢复。阈值是资源策略参数,可调。 */
export const CLAUDE_IDLE_RECLAIM_MS = 600_000;

/** 一条外部命令:可执行文件 + 参数。 */
export interface ComputeCommand {
  readonly command: string;
  readonly args?: readonly string[];
}
/**
 * 启动方给定的命令(打包后的桌面应用用):runner = 起 Compute 的 claude 命令;reportServer = 汇报工具 report_progress 的 MCP 服务器。
 * 不给就用适配器默认值(PATH 里的 claude;本包 mcp/report-mcp.mjs 由当前 node 执行)。
 */
export interface ComputeCommands {
  readonly runner?: ComputeCommand;
  readonly reportServer?: ComputeCommand;
}

/** 常驻适配器的选项:进程环境只挑网关地址与令牌(其余包括 ANTHROPIC_MODEL 一律不带),加空闲回收时长;启动方给了命令就带上。 */
export function claudeAdapterOptions(
  env: Readonly<Record<string, string | undefined>>,
  idleReclaimMs: number = CLAUDE_IDLE_RECLAIM_MS,
  commands: ComputeCommands = {},
): { hostEnv: Record<string, string>; idleReclaimMs: number; runner?: ComputeCommand; reportServer?: ComputeCommand } {
  const hostEnv: Record<string, string> = {};
  for (const k of PASS) {
    const v = env[k];
    if (v) hostEnv[k] = v;
  }
  return {
    hostEnv,
    idleReclaimMs,
    ...(commands.runner ? { runner: { command: commands.runner.command, ...(commands.runner.args ? { args: [...commands.runner.args] } : {}) } } : {}),
    ...(commands.reportServer ? { reportServer: { command: commands.reportServer.command, ...(commands.reportServer.args ? { args: [...commands.reportServer.args] } : {}) } } : {}),
  };
}

/** 适配器工厂:宿主按 Harness 只调一次;收到的模型参数不固定进实例,每一轮的模型随输入给。
 * extraEnv 是宿主定的进程级策略变量(如 AC-36 F3 的 CLAUDE_CODE_MAX_RETRIES),不得含模型;commands 见 ComputeCommands。 */
export function claudeCompute(env: Readonly<Record<string, string | undefined>>, extraEnv: Readonly<Record<string, string>> = {}, commands: ComputeCommands = {}): (model: string) => ComputeAdapter {
  const base = claudeAdapterOptions(env, CLAUDE_IDLE_RECLAIM_MS, commands);
  const opts = { ...base, hostEnv: { ...base.hostEnv, ...extraEnv } };
  return () => createResidentComputeAdapter(opts);
}
