// Brief 与 domain 里 contact.briefFor 的输出形状一致;本包不 import contact(避免依赖尚未合入的 PR #4),自己声明。

export type Placement = "local" | "byom_daemon" | "cloud_sandbox";

/** 派给 Compute 的任务说明。只有这五个字段:不带联系人记忆、SOUL.md 或明文凭据(AC-33 ④)。 */
export interface Brief {
  readonly task: string;
  readonly rules: readonly string[];
  readonly tools: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly placement: Placement;
}

/** 交接快照(AC-07):卸载或转交前写下,新 Compute 读到的必须和它一致。 */
export interface HandoffSnapshot {
  readonly constraintVer: number;
  readonly openQuestions: readonly string[];
  readonly doneSideEffects: readonly string[];
}

export interface ClaudeRunner {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface AdapterOptions {
  readonly runner?: ClaudeRunner;
  /** 宿主自己给 CLI 的运行配置(例如模型网关地址)。不来自 brief,也不继承宿主进程的整份环境。 */
  readonly hostEnv?: Readonly<Record<string, string>>;
  readonly reapForceMs?: number;
  readonly reportServer?: { readonly command: string; readonly args?: readonly string[] };
}

/** 联系人勾选的 MCP 服务器怎么启动(AC-29)。command 是可执行文件,args/env 原样交给 CLI 的 --mcp-config */
export interface McpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnOptions {
  readonly handoff?: unknown;
  readonly cwd?: string;
  /** 首轮用的生效模型(AC-51 ①);常驻适配器按它启动,一次性适配器忽略 */
  readonly model?: string;
  readonly effort?: string;
  /**
   * 联系人专属配置目录(AC-29,绝对路径):作为 CLAUDE_CONFIG_DIR 交给 CLI,设置与会话记录都落在这里,不读写本机 ~/.claude。
   * 盖过 hostEnv 里的同名变量。
   */
  readonly configDir?: string;
  readonly pluginDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerSpec>>;
}

/** 这一轮的生效模型(AC-51、D27 第 4 节第 1 条):宿主每轮现场解析后交给适配器,适配器在轮边界与会话当前模型比对 */
export interface TurnModel {
  readonly model: string;
  readonly effort?: string;
}

/** 适配器能力声明(D27 第 4 节第 5 条):inSessionModelSwitch=false 时换模型走兜底重启并接回同一会话 */
export interface AdapterCapabilities {
  readonly inSessionModelSwitch: boolean;
  /** 收专属配置目录与勾选的 skill/MCP(SpawnOptions 的 configDir/pluginDirs/mcpServers,AC-29);不声明为不收 */
  readonly isolation?: boolean;
}

/** CLI init 自报的实际加载清单(AC-29 观测点) */
export interface LoadedCapabilities {
  readonly skills: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface ManifestSection {
  readonly name: "task" | "rules" | "handoff" | "credentialRefs" | "skills";
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Manifest {
  readonly computeId: string;
  readonly sections: readonly ManifestSection[];
  readonly allowedTools: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly placement: Placement;
  /** 交给 CLI 的勾选 MCP 服务器名(不含 host);本适配器总是给出,可选只为兼容旧替身 */
  readonly mcpServers?: readonly string[];
  readonly pluginDirs?: readonly string[];
  readonly configDir?: string | null;
}

export type Refusal = {
  readonly ok: false;
  readonly reason: string;
  /** model-switch-failed:轮边界换模型被 harness 拒绝或超时,这一轮输入没有发出、没有退回旧模型继续跑(AC-51 ④) */
  readonly code?: "model-switch-failed";
  /** 给用户的修复路径(D07.4 规则 2):单独指定兼容模型 / 更换 harness */
  readonly fixes?: readonly ("explicit-compatible-model" | "change-harness")[];
};
export type SpawnResult = { readonly ok: true; readonly computeId: string; readonly manifest: Manifest } | Refusal;
export type SnapshotResult = { readonly ok: true; readonly snapshot: HandoffSnapshot } | Refusal;

export type ComputeEvent =
  | {
      readonly computeId: string;
      readonly kind: "started";
      readonly sessionId: string;
      readonly resumed: boolean;
      /** harness 自报的会话当前模型(常驻适配器给出) */
      readonly model?: string;
      readonly pid?: number;
      /** init 自报实际加载的 skill 与 MCP 服务器(AC-29);旧替身可以不带 */
      readonly loaded?: LoadedCapabilities;
    }
  | { readonly computeId: string; readonly kind: "milestone"; readonly stage: string; readonly summary: string }
  | { readonly computeId: string; readonly kind: "blocked"; readonly needs: string; readonly summary: string;                                 readonly attachments?: readonly string[] }
  | {
      readonly computeId: string;
      readonly kind: "completed";
      readonly result: string;
      /** 这一轮开始时会话的当前模型(harness 自报,常驻适配器给出) */
      readonly model?: string;
      /** 这一轮 harness 回报实际用过的模型(result.model_usage_since_last_result 的键),供宿主记 attempt_model_ledger(AC-51 ⑥) */
      readonly models?: readonly string[];
    }
  | {
      readonly computeId: string;
      readonly kind: "failed";
      readonly reason: string;
      readonly code: number | null;
      readonly signal: string | null;
      readonly violations: readonly string[];
      readonly model?: string;
      readonly models?: readonly string[];
    }
  | {
      readonly computeId: string;
      readonly kind: "stopped";
      readonly code: number | null;
      readonly signal: string | null;
      /**
       * 对照 mirasim 0.0.774 server-main.cjs 的 z2(child,{graceMs:0,group:true}) POSIX 路径(g-group#2309):
       * stop 立即产出 stopped,不等进程退出;初始 SIGTERM 只发给 CLI 主进程,不发给进程组;
       * reapForceMs(默认 10000,MIRASIM_REAP_FORCE_MS)后主进程仍未退出才对进程组 SIGKILL;主进程先退出就取消这次组 SIGKILL。
       * 所以主进程按时退出时,同进程组的其它进程(MCP 服务器、Bash 起的子进程)收不到任何信号,可能继续运行;
       * 脱离进程组的后代(setsid、双 fork 守护进程)任何情况下都不覆盖。
       * 内核不得把 stopped 当作执行树已静止,更不是容器级静止;完全隔离归 placement=cloud_sandbox / 容器,不在本适配器。
       */
      readonly scope: "main-then-group" | "turn-interrupt";
      readonly violations: readonly string[];
    };

export type ComputeEventKind = ComputeEvent["kind"];

/** 停止确认的结果(AC-23):ok 表示 CLI 主进程已退出,它启动的、按父子链与进程组找得到的进程也都已退出 */
export type QuiesceResult =
  | { readonly ok: true; readonly killed: number }
  | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };

/**
 * harness 流里的一件事(需求文档 D26 第 8.3 节整轮卡死检测用;不是语义事件,不进联系人上下文):
 *   model_call:模型调用已发出(CLI 的 system/status requesting),开始首字节窗口;
 *   progress:有真实输出(流式增量、文本、思考、子代理的消息);
 *   tool_start / tool_end:工具调用开始与结束(工具在跑是合法等待);background 是 Bash 后台命令,subagent 是 Task/Agent 子代理;
 *   retry:harness 宣布在重试(system/api_retry),不算进展。
 */
export type ComputeActivity =
  | { readonly computeId: string; readonly kind: "model_call" }
  | { readonly computeId: string; readonly kind: "progress"; readonly what: "text" | "thinking" | "subagent" | "output" }
  | { readonly computeId: string; readonly kind: "tool_start"; readonly toolId: string; readonly name: string; readonly background: boolean; readonly subagent: boolean }
  | { readonly computeId: string; readonly kind: "tool_end"; readonly toolId: string; readonly isError: boolean }
  | { readonly computeId: string; readonly kind: "retry"; readonly error: string; readonly httpStatus: number | null };
type WithoutComputeId<T> = T extends unknown ? Omit<T, "computeId"> : never;
export type ActivitySignal = WithoutComputeId<ComputeActivity>;

export interface ComputeAdapter {
  spawn(brief: unknown, opts?: SpawnOptions): Promise<SpawnResult>;
  /**
   * turn 是这一轮的生效模型(AC-51);常驻适配器在轮边界与会话当前模型比对,不同就在会话内换;一次性适配器忽略。
   * opts.tools:续接这一轮改用的内置工具清单(宿主按授权放宽或收紧,AC-17;不给就沿用原 brief)。不合 brief 合同就拒绝,不起进程
   */
  resume(computeId: string, text: string, turn?: TurnModel, opts?: { readonly tools?: readonly string[] }): Promise<{ readonly ok: true } | Refusal>;
  /** 插话进当前这一轮(D27 第 4 节第 3 条):用当前模型,不触发换模型 */
  steer?(computeId: string, text: string): Promise<{ readonly ok: true } | Refusal>;
  readonly capabilities?: AdapterCapabilities;
  stop(computeId: string): Promise<{ readonly ok: true } | Refusal>;
  /** 所有 Compute 的语义事件,从适配器创建起按发生顺序 */
  events(): AsyncIterable<ComputeEvent>;
  /** 可选:harness 流里的活动(卡死检测用),从开始迭代起按发生顺序;不回放迭代之前的活动 */
  activity?(): AsyncIterable<ComputeActivity>;
  settled(computeId: string): Promise<readonly ComputeEvent[]>;
  snapshot(computeId: string): SnapshotResult;
  /** 被拒收(服务器 isError,或回执合规但内容不合 schema)的汇报记录,按发生顺序;它们不产出语义事件 */
  rejectedReports(computeId: string): readonly RejectedReport[];
  /**
   * 停止确认(AC-23,需求 §8.1 第 16 条):这一轮终态(stopped/failed/completed)之后调用。等 CLI 主进程退出,
   * 再把停止时与此刻按父子链、进程组找到的还活着的进程 SIGKILL,轮询到都退出或 timeoutMs(默认 5000)到期。
   * 父子链在停止前就断了的(双 fork 守护进程、交给系统托管)找不到,不在保证范围。可选:旧替身没有时宿主退回 settled。
   */
  quiesce?(computeId: string, timeoutMs?: number): Promise<QuiesceResult>;
}

export interface RejectedReport {
  readonly kind: unknown;
  readonly reason: string;
}

/** Shared host-facing execution port; both native harness adapters implement this contract. */
export type ComputePort = ComputeAdapter;
