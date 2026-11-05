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
  /** stop 发出 SIGTERM 后等多久升级为 SIGKILL */
  readonly stopGraceMs?: number;
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
  | { readonly computeId: string; readonly kind: "failed"; readonly reason: string; readonly code: number | null; readonly signal: string | null }
  | { readonly computeId: string; readonly kind: "stopped"; readonly code: number | null; readonly signal: string | null };

export type ComputeEventKind = ComputeEvent["kind"];

export interface ComputeAdapter {
  spawn(brief: unknown, opts?: SpawnOptions): Promise<SpawnResult>;
  resume(computeId: string, text: string): Promise<{ readonly ok: true } | Refusal>;
  stop(computeId: string): Promise<{ readonly ok: true } | Refusal>;
  /** 所有 Compute 的语义事件,从适配器创建起按发生顺序 */
  events(): AsyncIterable<ComputeEvent>;
  /** 当前这一轮进程结束(并已产出终态事件)后,返回这一轮的事件 */
  settled(computeId: string): Promise<readonly ComputeEvent[]>;
  snapshot(computeId: string): SnapshotResult;
  /** 被拒收(服务器 isError,或回执合规但内容不合 schema)的汇报记录,按发生顺序;它们不产出语义事件 */
  rejectedReports(computeId: string): readonly RejectedReport[];
}

export interface RejectedReport {
  readonly kind: unknown;
  readonly reason: string;
}
