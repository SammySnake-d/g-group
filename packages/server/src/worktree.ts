// R-Worktree 隔离工作树与受控合流(需求文档 D20.3 第四台 4C、C-US13、V19-03;验收 AC-22)。
//   W2 ActiveWorktree:每个代码任务一个独立 git worktree + 任务分支 gg/task-<id>,从目标分支当时的 head(H0)拉出;
//   W3 PinnedInReview:交付时把工作区改动提交成候选提交并钉住 sha,审查只看这个固定提交;
//   W4 Integrating:审查通过后进受控单通道(同一宿主内串行):
//     · 目标分支 head 是候选的祖先(主线未变)→ 快进;
//     · 目标分支已被推进到 H1 → 在独立集成工作树里基于 H1 合并,跑重验命令,过了才推进;没配重验命令就拒绝(不拿旧验证结果直发);
//     · 推进一律用 update-ref <新> <旧>(CAS),期间又被推进就基于最新 head 重来;
//   W5 IntegrationConflict:合并冲突或重验失败,目标分支不动;不提交新候选就拒绝再合;
//   W6 Merged:目标分支已推进,任务工作树目录清掉、任务分支保留。
// 目标分支不能检出在某个非裸工作区里(update-ref 不会改那个工作区的文件,会让它与分支不一致),配置时就拒绝。

export interface VerifySpec {
  readonly command: string;
  readonly args?: readonly string[];
  /** 默认 10 分钟 */
  readonly timeoutMs?: number;
}
export interface CodeRepoConfig {
  /** 仓库目录:裸仓库,或目标分支没有检出的普通仓库 */
  readonly repo: string;
  /** 合入的目标分支名,如 main */
  readonly targetBranch: string;
  /** 目标分支被推进后,在合并结果上重跑的验证命令(如 npm test);退出码 0 算通过 */
  readonly verify?: VerifySpec | null;
}

export const WORKSPACE_STATES = ["W2_Active", "W3_Pinned", "W4_Integrating", "W5_Conflict", "W6_Merged"] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export interface Workspace {
  readonly taskId: string;
  readonly dir: string;
  readonly branch: string;
  readonly targetBranch: string;
  /** 创建时目标分支的 head(H0) */
  readonly baseSha: string;
  /** 钉住的候选提交;W2 时为 null */
  readonly candidateSha: string | null;
  readonly state: WorkspaceState;
  /** 最近一次合入时看到的目标分支 head */
  readonly targetHead: string | null;
  /** 基于哪个目标 head 重跑过验证(快进合入为 null) */
  readonly verifiedOn: string | null;
  /** 合入后目标分支的 head */
  readonly mergedSha: string | null;
  readonly conflict: { readonly kind: "merge" | "verify"; readonly detail: string } | null;
}

export type IntegrateOutcome =
  | { readonly ok: true; readonly ws: Workspace; readonly mode: "fast-forward" | "merged-and-verified" | "no-change"; readonly attempts: number }
  | { readonly ok: false; readonly ws: Workspace; readonly reason: "not-pinned" | "unresolved-conflict" | "merge-conflict" | "verify-failed" | "target-busy"; readonly detail: string };

export class Worktrees {
  readonly cfg: CodeRepoConfig;
  readonly root: string;
  constructor(cfg: CodeRepoConfig, root: string, _opts: { maxAttempts?: number } = {}) {
    this.cfg = cfg;
    this.root = root;
  }
  targetHead(): string {
    throw new Error("未实现");
  }
  branchOf(_taskId: string): string {
    throw new Error("未实现");
  }
  provision(_taskId: string, _existing?: Workspace | null): Workspace {
    throw new Error("未实现");
  }
  pin(_ws: Workspace, _message: string): Workspace {
    throw new Error("未实现");
  }
  integrate(_ws: Workspace): Promise<IntegrateOutcome> {
    return Promise.reject(new Error("未实现"));
  }
}
