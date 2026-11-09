// Claude Code Compute 适配器的对外类型。
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

export interface SpawnOptions {
  readonly handoff?: unknown;
  readonly cwd?: string;
  /** 首轮用的生效模型(AC-51 ①);常驻适配器按它启动,一次性适配器忽略 */
  readonly model?: string;
  /** 首轮用的推理强度;常驻适配器按它启动 */
  readonly effort?: string;
}

/** 这一轮的生效模型(AC-51、D27 第 4 节第 1 条):宿主每轮现场解析后交给适配器,适配器在轮边界与会话当前模型比对 */
export interface TurnModel {
  readonly model: string;
  readonly effort?: string;
}

/** 适配器能力声明(D27 第 4 节第 5 条):inSessionModelSwitch=false 时换模型走兜底重启并接回同一会话 */
export interface AdapterCapabilities {
  readonly inSessionModelSwitch: boolean;
}

export interface ManifestSection {
  readonly name: "task" | "rules" | "handoff" | "credentialRefs";
  readonly detail: Readonly<Record<string, unknown>>;
}

/** 新会话首个装配清单:首个提示由哪些段组成、挂了哪些工具与凭据引用 */
export interface Manifest {
  readonly computeId: string;
  readonly sections: readonly ManifestSection[];
  readonly allowedTools: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly placement: Placement;
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
      /** CLI 主进程 pid(常驻适配器给出;跨轮不变即同一进程) */
      readonly pid?: number;
    }
  | { readonly computeId: string; readonly kind: "milestone"; readonly stage: string; readonly summary: string }
  | { readonly computeId: string; readonly kind: "blocked"; readonly needs: string; readonly summary: string; /** 工作目录内文件的相对路径(截图等),原样转交宿主 */ readonly attachments?: readonly string[] }
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
      /** stop 时立即产出,进程还没退出,所以是 null */
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
      readonly scope: "main-then-group";
      /** 停止之前适配器判定过的违规(工具越界、init 无法核验等),停止优先于违规但违规保留可审计 */
      readonly violations: readonly string[];
    };

export type ComputeEventKind = ComputeEvent["kind"];

export interface ComputeAdapter {
  spawn(brief: unknown, opts?: SpawnOptions): Promise<SpawnResult>;
  /** turn 是这一轮的生效模型(AC-51);常驻适配器在轮边界与会话当前模型比对,不同就在会话内换;一次性适配器忽略 */
  resume(computeId: string, text: string, turn?: TurnModel): Promise<{ readonly ok: true } | Refusal>;
  /** 插话进当前这一轮(D27 第 4 节第 3 条):用当前模型,不触发换模型 */
  steer?(computeId: string, text: string): Promise<{ readonly ok: true } | Refusal>;
  readonly capabilities?: AdapterCapabilities;
  stop(computeId: string): Promise<{ readonly ok: true } | Refusal>;
  /** 所有 Compute 的语义事件,从适配器创建起按发生顺序 */
  events(): AsyncIterable<ComputeEvent>;
  /** 这一轮产出终态(或停在受阻)且 CLI 主进程已退出后,返回这一轮的事件 */
  settled(computeId: string): Promise<readonly ComputeEvent[]>;
  /** 只在终态(stopped/completed/failed)且 CLI 主进程已退出之后成功;否则 {ok:false, reason:"not-quiescent"}。
   *  不检查同组或脱组的其它进程,见 stopped.scope */
  snapshot(computeId: string): SnapshotResult;
  /** 被拒收(服务器 isError,或回执合规但内容不合 schema)的汇报记录,按发生顺序;它们不产出语义事件 */
  rejectedReports(computeId: string): readonly RejectedReport[];
}

export interface RejectedReport {
  readonly kind: unknown;
  readonly reason: string;
}
