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
  /** 对进程组发 SIGTERM 之后等多久仍未退出就发 SIGKILL;默认 10000,对应 mirasim 的 MIRASIM_REAP_FORCE_MS */
  readonly reapForceMs?: number;
  /** report_progress MCP 服务器的启动命令;默认是本包 mcp/report-mcp.mjs。测试用它注入起不来的服务器 */
  readonly reportServer?: { readonly command: string; readonly args?: readonly string[] };
}

export interface SpawnOptions {
  readonly handoff?: unknown;
  readonly cwd?: string;
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

export type Refusal = { readonly ok: false; readonly reason: string };
export type SpawnResult = { readonly ok: true; readonly computeId: string; readonly manifest: Manifest } | Refusal;
export type SnapshotResult = { readonly ok: true; readonly snapshot: HandoffSnapshot } | Refusal;

export type ComputeEvent =
  | { readonly computeId: string; readonly kind: "started"; readonly sessionId: string; readonly resumed: boolean }
  | { readonly computeId: string; readonly kind: "milestone"; readonly stage: string; readonly summary: string }
  | { readonly computeId: string; readonly kind: "blocked"; readonly needs: string; readonly summary: string }
  | { readonly computeId: string; readonly kind: "completed"; readonly result: string }
  | { readonly computeId: string; readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null; readonly violations: readonly string[] }
  | {
      readonly computeId: string;
      readonly kind: "stopped";
      /** stop 时立即产出,进程还没退出,所以是 null */
      readonly code: number | null;
      readonly signal: string | null;
      /**
       * 与 mirasim 0.0.774 一致(g-group#2309):stop 对 CLI 的进程组发 SIGTERM 后立即产出 stopped,不等进程退出确认;
       * reapForceMs 后进程组仍有进程就发 SIGKILL。只覆盖留在 CLI 进程组里的进程:脱离进程组的后代(setsid、
       * 双 fork 守护进程、launchd/systemd 托管)不覆盖。内核不得把 stopped 当作执行树已静止,更不是容器级静止;
       * 完全隔离归 placement=cloud_sandbox / 容器,不在本适配器。
       */
      readonly scope: "process-group";
      /** 停止之前适配器判定过的违规(工具越界、init 无法核验等),停止优先于违规但违规保留可审计 */
      readonly violations: readonly string[];
    };

export type ComputeEventKind = ComputeEvent["kind"];

export interface ComputeAdapter {
  spawn(brief: unknown, opts?: SpawnOptions): Promise<SpawnResult>;
  resume(computeId: string, text: string): Promise<{ readonly ok: true } | Refusal>;
  stop(computeId: string): Promise<{ readonly ok: true } | Refusal>;
  /** 所有 Compute 的语义事件,从适配器创建起按发生顺序 */
  events(): AsyncIterable<ComputeEvent>;
  /** 这一轮产出终态(或停在受阻)且 CLI 主进程已退出后,返回这一轮的事件 */
  settled(computeId: string): Promise<readonly ComputeEvent[]>;
  /** 只在终态(stopped/completed/failed)且 CLI 主进程已退出之后成功;否则 {ok:false, reason:"not-quiescent"}。
   *  不检查脱离进程组的后代,见 stopped.scope */
  snapshot(computeId: string): SnapshotResult;
  /** 被拒收(服务器 isError,或回执合规但内容不合 schema)的汇报记录,按发生顺序;它们不产出语义事件 */
  rejectedReports(computeId: string): readonly RejectedReport[];
}

export interface RejectedReport {
  readonly kind: unknown;
  readonly reason: string;
}
