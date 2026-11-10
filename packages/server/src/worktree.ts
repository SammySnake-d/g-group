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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

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

const IDENTITY = ["-c", "user.name=g-group", "-c", "user.email=compute@g-group.local", "-c", "commit.gpgsign=false"];

/** 子进程环境:去掉 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等,免得在钩子里运行时指到别的仓库 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(cwd: string, args: readonly string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
const errText = (e: unknown) => {
  const x = e as { stderr?: string | Buffer; message?: string };
  return (x.stderr ? String(x.stderr) : (x.message ?? String(e))).trim().slice(-2000);
};

export type RecoveryWorkspace = Workspace & { readonly recovery: { readonly ver: number; readonly backupRef: string } };

export class Worktrees {
  readonly cfg: CodeRepoConfig;
  readonly root: string;
  private readonly maxAttempts: number;
  /** 受控单通道:同一宿主内的合入一个接一个跑 */
  private lane: Promise<unknown> = Promise.resolve();

  constructor(cfg: CodeRepoConfig, root: string, opts: { maxAttempts?: number } = {}) {
    this.cfg = { ...cfg, repo: path.resolve(cfg.repo) };
    this.root = path.resolve(root);
    this.maxAttempts = opts.maxAttempts ?? 5;
    if (!/^[A-Za-z0-9._/-]+$/.test(cfg.targetBranch) || cfg.targetBranch.includes("..")) throw new Error(`目标分支名不合法:${cfg.targetBranch}`);
    try {
      git(this.cfg.repo, ["rev-parse", "--git-dir"]);
    } catch (e) {
      throw new Error(`${this.cfg.repo} 不是 git 仓库:${errText(e)}`);
    }
    this.targetHead();
    const ref = `refs/heads/${cfg.targetBranch}`;
    let wtPath = "";
    let bare = false;
    for (const line of git(this.cfg.repo, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
        bare = false;
      } else if (line === "bare") bare = true;
      else if (line === `branch ${ref}` && !bare) throw new Error(`目标分支 ${cfg.targetBranch} 检出在工作区 ${wtPath}:合入用 update-ref 推进,会让那个工作区的文件与分支不一致。请用裸仓库,或另设一个集成分支`);
    }
    mkdirSync(this.root, { recursive: true });
  }

  /** AC-15:只建无分支备份提交，真实 index / HEAD 均不动。 */
  backup(ws: RecoveryWorkspace): { backupRef: string; backupSha: string } {
    this.validateRecovery(ws, ws.baseSha);
    const expected = `refs/gg/backup/${Buffer.from(ws.taskId).toString("hex")}/${ws.recovery.ver}`;
    if (ws.recovery.backupRef !== expected || !Number.isSafeInteger(ws.recovery.ver) || ws.recovery.ver < 0) throw new Error("backup-ref 归属不符");
    git(ws.dir, ["check-ref-format", expected]);
    const message = `gg recovery ${ws.taskId} v${ws.recovery.ver} base ${ws.baseSha}`;
    const existing = () => {
      const sha = git(ws.dir, ["rev-parse", "--verify", `${expected}^{commit}`]);
      if (git(ws.dir, ["show", "-s", "--format=%B", sha]) !== message) throw new Error("backup-ref 归属不符");
      return { backupRef: expected, backupSha: sha };
    };
    if (gitOk(ws.dir, ["show-ref", "--verify", "--quiet", expected])) return existing();
    const gd = git(ws.dir, ["rev-parse", "--absolute-git-dir"]);
    const tmp = mkdtempSync(path.join(gd, "gg-backup-"));
    try {
      const env = { ...cleanEnv(), GIT_INDEX_FILE: path.join(tmp, "index") };
      const g = (args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: ws.dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      g(["read-tree", "HEAD"]);
      g(["add", "-A", "--", "."]);
      const tree = g(["write-tree"]);
      const sha = g(["commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", message]);
      try { g(["update-ref", expected, sha, "0".repeat(sha.length)]); }
      catch { return existing(); }
      return { backupRef: expected, backupSha: sha };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  /** 只恢复 index/文件，不 reset、不移动分支；忽略路径从不清理。 */
  restoreTo(ws: RecoveryWorkspace, sha: string): Workspace {
    this.validateRecovery(ws, sha);
    // 没有可追溯备份绝不动文件；复用已有 ref，不覆盖恢复前字节。
    this.backup(ws);
    git(ws.dir, ["restore", `--source=${sha}`, "--staged", "--worktree", "--", "."]);
    const untracked = execFileSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: ws.dir, env: cleanEnv(), encoding: "utf8" });
    for (const rel of untracked.split("\0").filter(Boolean)) {
      const file = path.resolve(ws.dir, rel);
      if (!file.startsWith(path.resolve(ws.dir) + path.sep)) throw new Error("恢复清理路径越界");
      // ls-files 不遍历符号链接；unlink/rm 删除链接本身，不跟随它。
      rmSync(file, { recursive: true, force: true });
    }
    return { ...ws, state: "W2_Active", candidateSha: null, conflict: null, targetHead: null, verifiedOn: null, mergedSha: null };
  }

  validateRecovery(ws: Workspace, sha: string): void {
    if (!["W2_Active", "W3_Pinned", "W5_Conflict"].includes(ws.state)) throw new Error(`工作树 ${ws.state} 不可恢复`);
    const expectedDir = path.join(this.root, ws.taskId.replace(/[^A-Za-z0-9._-]/g, "-"));
    if (path.resolve(ws.dir) !== expectedDir || realpathSync(ws.dir) !== realpathSync(expectedDir)) throw new Error("工作树路径不匹配");
    if (git(ws.dir, ["symbolic-ref", "--short", "HEAD"]) !== ws.branch || ws.branch !== this.branchOf(ws.taskId)) throw new Error("工作树分支不匹配");
    const common = git(ws.dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const owner = git(this.cfg.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (realpathSync(common) !== realpathSync(owner)) throw new Error("工作树仓库不匹配");
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !gitOk(ws.dir, ["cat-file", "-e", `${sha}^{commit}`]) || !gitOk(ws.dir, ["merge-base", "--is-ancestor", ws.baseSha, sha]) || !gitOk(ws.dir, ["merge-base", "--is-ancestor", sha, "HEAD"])) throw new Error("checkpoint-unavailable: 目标提交不可达");
  }

  targetHead(): string {
    try {
      return git(this.cfg.repo, ["rev-parse", "--verify", `refs/heads/${this.cfg.targetBranch}^{commit}`]);
    } catch (e) {
      throw new Error(`目标分支 ${this.cfg.targetBranch} 不存在:${errText(e)}`);
    }
  }
  branchOf(taskId: string): string {
    return `gg/task-${taskId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  }

  /** W0 → W2:开独立工作树。同一任务重复申请返回已有的那个(W1 幂等);目录或分支已被占用就报冲突并清掉半成品。 */
  provision(taskId: string, existing?: Workspace | null): Workspace {
    if (existing && existing.state !== "W6_Merged" && existsSync(existing.dir)) return existing;
    const dir = path.join(this.root, taskId.replace(/[^A-Za-z0-9._-]/g, "-"));
    const branch = this.branchOf(taskId);
    if (existsSync(dir)) throw new Error(`工作树目录 ${dir} 已被占用`);
    if (gitOk(this.cfg.repo, ["rev-parse", "--verify", `refs/heads/${branch}`])) throw new Error(`任务分支 ${branch} 已存在`);
    const base = this.targetHead();
    try {
      git(this.cfg.repo, ["worktree", "add", "-q", "-b", branch, dir, base]);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      gitOk(this.cfg.repo, ["worktree", "prune"]);
      throw new Error(`创建工作树失败:${errText(e)}`);
    }
    return { taskId, dir, branch, targetBranch: this.cfg.targetBranch, baseSha: base, candidateSha: null, state: "W2_Active", targetHead: null, verifiedOn: null, mergedSha: null, conflict: null };
  }

  /** W2/W5 → W3:把工作区改动提交成候选提交并钉住。没有新改动就钉当前 HEAD。 */
  pin(ws: Workspace, message: string): Workspace {
    if (ws.state === "W6_Merged") throw new Error("工作树已合入并清理,不能再提交候选");
    if (ws.state === "W4_Integrating") throw new Error("正在合入,不能换候选");
    git(ws.dir, ["add", "-A"]);
    if (!gitOk(ws.dir, ["diff", "--cached", "--quiet"])) git(ws.dir, ["commit", "-q", "-m", message]);
    const sha = git(ws.dir, ["rev-parse", "HEAD"]);
    // 冲突后没有新提交:候选不变,仍停在 W5,不能再合
    if (ws.state === "W5_Conflict" && sha === ws.candidateSha) return ws;
    return { ...ws, candidateSha: sha, state: "W3_Pinned", conflict: null };
  }

  /** 候选提交里相对 base 新增或改过的文件(仓库内相对路径) */
  changedFiles(ws: Workspace): string[] {
    if (!ws.candidateSha) return [];
    return git(this.cfg.repo, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", ws.baseSha, ws.candidateSha]).split("\n").filter(Boolean);
  }
  /** 读某个提交里文件的原始字节(不读工作区:卡片钉在提交上) */
  readAt(sha: string, file: string): Buffer {
    return execFileSync("git", ["cat-file", "blob", `${sha}:${file}`], { cwd: this.cfg.repo, env: cleanEnv(), maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  }

  /** W3 → W4 → W6 或 W5。串行执行;返回的 ws 是合入后的状态,调用方负责落盘。 */
  integrate(ws: Workspace): Promise<IntegrateOutcome> {
    const run = this.lane.then(() => this.integrateNow(ws));
    this.lane = run.catch(() => {});
    return run;
  }

  private async integrateNow(ws: Workspace): Promise<IntegrateOutcome> {
    if (ws.state === "W5_Conflict") return { ok: false, ws, reason: "unresolved-conflict", detail: "上次合入冲突或重验失败,还没提交新的候选提交,拒绝再合" };
    if (ws.state !== "W3_Pinned" || !ws.candidateSha) return { ok: false, ws, reason: "not-pinned", detail: `工作树在 ${ws.state},没有钉住的候选提交` };
    const cand = ws.candidateSha;
    const ref = `refs/heads/${this.cfg.targetBranch}`;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const head = this.targetHead();
      // 候选已经在目标分支里:不用合
      if (gitOk(this.cfg.repo, ["merge-base", "--is-ancestor", cand, head])) return { ok: true, ws: this.merged(ws, head, head, null), mode: "no-change", attempts: attempt };
      // 主线未变(目标 head 是候选的祖先):快进
      if (gitOk(this.cfg.repo, ["merge-base", "--is-ancestor", head, cand])) {
        if (gitOk(this.cfg.repo, ["update-ref", ref, cand, head])) return { ok: true, ws: this.merged(ws, head, cand, null), mode: "fast-forward", attempts: attempt };
        continue;
      }
      // 主线已推进到 H1:基于 H1 合并、重验
      const idir = path.join(this.root, ".integrate", `${path.basename(ws.dir)}-${attempt}`);
      rmSync(idir, { recursive: true, force: true });
      mkdirSync(path.dirname(idir), { recursive: true });
      git(this.cfg.repo, ["worktree", "add", "-q", "--detach", idir, head]);
      try {
        try {
          git(idir, ["merge", "--no-ff", "--no-edit", "-m", `合入 ${ws.branch} → ${this.cfg.targetBranch}`, cand]);
        } catch (e) {
          let files = "";
          try {
            files = git(idir, ["diff", "--name-only", "--diff-filter=U"]);
          } catch {
            /* 读不到冲突文件就只报原文 */
          }
          gitOk(idir, ["merge", "--abort"]);
          const detail = `基于 ${this.cfg.targetBranch}@${head.slice(0, 12)} 合并冲突${files ? `:${files.split("\n").join("、")}` : ""}(${errText(e).split("\n")[0]})`;
          return { ok: false, ws: { ...ws, state: "W5_Conflict", targetHead: head, conflict: { kind: "merge", detail } }, reason: "merge-conflict", detail };
        }
        const merged = git(idir, ["rev-parse", "HEAD"]);
        if (!this.cfg.verify) {
          const detail = `${this.cfg.targetBranch} 已推进到 ${head.slice(0, 12)},但没有配置重验命令:不能把旧基线上的验证结果当成新基线的结果合入`;
          return { ok: false, ws: { ...ws, state: "W5_Conflict", targetHead: head, conflict: { kind: "verify", detail } }, reason: "verify-failed", detail };
        }
        const v = await runVerify(this.cfg.verify, idir);
        if (!v.ok) {
          const detail = `基于 ${this.cfg.targetBranch}@${head.slice(0, 12)} 重验失败:${v.output}`;
          return { ok: false, ws: { ...ws, state: "W5_Conflict", targetHead: head, conflict: { kind: "verify", detail } }, reason: "verify-failed", detail };
        }
        if (gitOk(this.cfg.repo, ["update-ref", ref, merged, head])) return { ok: true, ws: this.merged(ws, head, merged, head), mode: "merged-and-verified", attempts: attempt };
        // 重验期间目标分支又被推进:CAS 失败,基于最新 head 重来
      } finally {
        gitOk(this.cfg.repo, ["worktree", "remove", "--force", idir]);
        rmSync(idir, { recursive: true, force: true });
      }
    }
    return { ok: false, ws, reason: "target-busy", detail: `目标分支在合入期间连续被推进 ${this.maxAttempts} 次,这次没合入,候选仍钉住,可以再试` };
  }

  /** W6:记下合入结果,清掉任务工作树目录(任务分支保留) */
  private merged(ws: Workspace, head: string, mergedSha: string, verifiedOn: string | null): Workspace {
    gitOk(this.cfg.repo, ["worktree", "remove", "--force", ws.dir]);
    rmSync(ws.dir, { recursive: true, force: true });
    gitOk(this.cfg.repo, ["worktree", "prune"]);
    return { ...ws, state: "W6_Merged", targetHead: head, mergedSha, verifiedOn, conflict: null };
  }
}

function runVerify(v: VerifySpec, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(v.command, [...(v.args ?? [])], { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const keep = (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      out += `\n重验超时(${v.timeoutMs ?? 600_000}ms),已停止`;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, v.timeoutMs ?? 600_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `重验命令起不来:${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().slice(-2000) || `退出码 ${code}` });
    });
  });
}
