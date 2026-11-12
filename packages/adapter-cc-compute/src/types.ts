// 旧路径保留转出口;Compute 端口的唯一实现归 @g-group/kernel/compute。
export type { Placement, Brief, HandoffSnapshot, McpServerSpec, SpawnOptions, TurnModel, AdapterCapabilities, LoadedCapabilities, ManifestSection, Manifest, Refusal, SpawnResult, SnapshotResult, ComputeEvent, ComputeEventKind, QuiesceResult, ComputeActivity, ActivitySignal, ComputeAdapter, RejectedReport } from "@g-group/kernel/compute";

/** 启动 CLI 的可执行入口。默认是真实的 `claude`;测试注入一个按 stream-json 输出的假 CLI。 */
export interface ClaudeRunner {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface AdapterOptions {
  readonly runner?: ClaudeRunner;
  /** 宿主自己给 CLI 的运行配置(例如模型网关地址)。不来自 brief,也不继承宿主进程的整份环境。 */
  readonly hostEnv?: Readonly<Record<string, string>>;
  /** 对主进程发 SIGTERM 之后等多久主进程仍未退出就对进程组发 SIGKILL。不给时与 mirasim 一样读环境变量 MIRASIM_REAP_FORCE_MS(有限正数生效),否则 10000;给了就以它为准 */
  readonly reapForceMs?: number;
  /** report_progress MCP 服务器的启动命令;默认是本包 mcp/report-mcp.mjs。测试用它注入起不来的服务器 */
  readonly reportServer?: { readonly command: string; readonly args?: readonly string[] };
}

