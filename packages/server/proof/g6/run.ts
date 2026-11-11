#!/usr/bin/env node
// G6 runner:按组(基线 + 按序合入的片)建临时工作树,把本目录叠上去,逐题、逐模型、逐次跑 driver,冻结原始记录,评分、判合同、出报告。
// 本项目的验证工具,放 proof/,不进产品(需求文档 §2.0 v3.28)。
//   node packages/server/proof/g6/run.ts --mode standin --groups g1 --out /tmp/g6-out
//   node packages/server/proof/g6/run.ts --mode real --models "$ANTHROPIC_DEFAULT_SONNET_MODEL,workbuddy-ai/hy4free" --groups g1 --reps 1 --out …
// 真实模式的网关只从本进程环境变量取(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY),原样传给 driver 子进程,不落盘。
// 一次只跑一个 driver(低并发);driver 崩溃、超时也生成一份 status=error 的记录,留在分母里。
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkRecord, mergeContracts } from "./contracts.ts";
import { fixtureDigest, loadFixtureSet } from "./fixture.ts";
import { GROUPS, type GitQuery, type GroupState, resolveGroup } from "./groups.ts";
import { configFingerprint, modelConfig, sourceFreeze } from "./manifest.ts";
import { renderReport, type ResultRow, type Summary } from "./report.ts";
import { scoreRecords } from "./score.ts";
import type { FixtureSet, RawRecord } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STANDIN_MODEL = "standin/rules-v1";

export interface PlannedRun {
  readonly group: string;
  readonly model: string;
  readonly item: string;
  readonly rep: number;
}
/** 只给「可跑」的组排运行;顺序:组 → 模型 → 题 → 次。 */
export function planRuns(groups: readonly GroupState[], models: readonly string[], items: readonly string[], reps: number): PlannedRun[] {
  const out: PlannedRun[] = [];
  for (const g of groups) {
    if (g.state !== "可跑") continue;
    for (const model of models) for (const item of items) for (let rep = 1; rep <= reps; rep++) out.push({ group: g.id, model, item, rep });
  }
  return out;
}

/** driver 没交回记录(崩溃、超时被杀、输出坏)时补的记录:status=error,留在分母里。 */
export function crashRecord(run: PlannedRun & { commit: string; mode: "standin" | "real"; fingerprint: string }, why: string, at: number): RawRecord {
  return {
    schema: "g6-raw/v1",
    runId: `${run.group}/${run.model}/${run.item}/${run.rep}`,
    group: run.group,
    commit: run.commit,
    mode: run.mode,
    model: run.model,
    item: run.item,
    rep: run.rep,
    fingerprint: run.fingerprint,
    startedAt: at,
    endedAt: at,
    status: "error",
    error: why,
    roomIds: {},
    contactIds: {},
    steps: [],
    sent: [],
    ops: [],
    replies: [],
    memories: {},
    notes: {},
    reports: [],
    hostDebt: null,
    calls: [],
  };
}

/** 只选配置来源、不指仓库位置的变量,留着 */
const KEEP_GIT_VARS: ReadonlySet<string> = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
/**
 * runner 起 git 子进程用的环境:剥掉 GIT_* 变量(与门禁同做法;只留选配置来源的三个)。runner 可能在 pre-push 钩子里被调用,
 * 钩子继承的 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE 会让 `git -C <临时仓库>` 实际改到调用方仓库。extra 里的值(提交身份)再加回去。
 */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (!k.startsWith("GIT_") || KEEP_GIT_VARS.has(k))) out[k] = v;
  return { ...out, ...extra };
}

export function gitQuery(repo: string): GitQuery {
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim();
  return {
    revParse(ref) {
      try {
        return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`) || null;
      } catch {
        return null;
      }
    },
    hasFile(commit, file) {
      try {
        git("cat-file", "-e", `${commit}:${file}`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 被测工作树的依赖:第三方包软链到 runner 的 node_modules;@g-group/* 链到被测树自己的 packages;file: 依赖链到被测树里的目录。 */
export function linkNodeModules(runnerRoot: string, tree: string): string[] {
  const src = path.join(runnerRoot, "node_modules");
  const dst = path.join(tree, "node_modules");
  mkdirSync(path.join(dst, "@g-group"), { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === "@g-group" || name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      mkdirSync(path.join(dst, name), { recursive: true });
      for (const sub of readdirSync(path.join(src, name))) symlinkSync(path.join(src, name, sub), path.join(dst, name, sub));
    } else symlinkSync(path.join(src, name), path.join(dst, name));
  }
  const linked: string[] = [];
  const pkgs = existsSync(path.join(tree, "packages")) ? readdirSync(path.join(tree, "packages")) : [];
  for (const p of pkgs) {
    const file = path.join(tree, "packages", p, "package.json");
    if (!existsSync(file)) continue;
    const j = JSON.parse(readFileSync(file, "utf8")) as { name?: string; dependencies?: Record<string, string> };
    if (j.name?.startsWith("@g-group/")) {
      symlinkSync(path.join("..", "..", "packages", p), path.join(dst, j.name));
      linked.push(j.name);
    }
    for (const [dep, spec] of Object.entries(j.dependencies ?? {})) {
      if (!spec.startsWith("file:")) continue;
      const target = path.resolve(path.join(tree, "packages", p), spec.slice(5));
      const at = path.join(dst, dep);
      if (existsSync(at)) rmSync(at, { recursive: true, force: true });
      mkdirSync(path.dirname(at), { recursive: true });
      symlinkSync(target, at);
      linked.push(`${dep}→${path.relative(tree, target)}`);
    }
  }
  return linked;
}

/** 合入冲突的说明:哪片、哪些文件。 */
export function conflictText(slice: string, files: readonly string[]): string {
  return `合入 ${slice} 冲突:${files.join("、") || "(git 未列出文件)"}`;
}
export class MergeConflict extends Error {
  readonly slice: string;
  readonly files: readonly string[];
  constructor(slice: string, files: readonly string[]) {
    super(conflictText(slice, files));
    this.slice = slice;
    this.files = files;
  }
}

/** 建一组的工作树:基线 detach,按序合入各片(不推送、不改任何分支),叠上本目录(不含测试)。合并冲突抛 MergeConflict。 */
export function prepareTree(repo: string, g: GroupState, dir: string): { head: string; linked: string[] } {
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, g.base!], { stdio: "ignore", env: gitEnv() });
  const env = gitEnv({ GIT_AUTHOR_NAME: "g6-runner", GIT_AUTHOR_EMAIL: "g6@local.invalid", GIT_COMMITTER_NAME: "g6-runner", GIT_COMMITTER_EMAIL: "g6@local.invalid" });
  for (const i of g.inputs) {
    try {
      execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "merge", "--no-ff", "--no-edit", "-m", `g6: 合入 ${i.slice} ${i.sha}`, i.sha!], { stdio: "ignore", env });
    } catch {
      const files = execFileSync("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8", env: gitEnv() }).trim().split("\n").filter(Boolean);
      throw new MergeConflict(i.slice, files);
    }
  }
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv() }).trim();
  const linked = linkNodeModules(path.resolve(HERE, "../../../.."), dir);
  cpSync(HERE, path.join(dir, "packages/server/proof/g6"), { recursive: true, filter: (f) => !f.endsWith(".test.ts") });
  return { head, linked };
}

function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "standin" },
      groups: { type: "string", default: GROUPS.map((g) => g.id).join(",") },
      models: { type: "string" },
      items: { type: "string", default: "all" },
      reps: { type: "string", default: "1" },
      out: { type: "string" },
      base: { type: "string" },
      ref: { type: "string", multiple: true, default: [] },
      fixture: { type: "string", default: path.join(HERE, "fixtures/set-v1.json") },
      "step-timeout": { type: "string" },
      "call-timeout": { type: "string", default: "300000" },
      quiet: { type: "string" },
      settle: { type: "string", default: "0" },
      keep: { type: "boolean", default: false },
    },
  });
  const mode = values.mode === "real" ? "real" : "standin";
  if (!values.out) throw new Error("缺 --out 目录");
  const out = path.resolve(values.out);
  const repo = path.resolve(HERE, "../../../..");
  const set: FixtureSet = loadFixtureSet(values.fixture);
  const items = values.items === "all" ? set.items.map((i) => i.id) : values.items.split(",");
  const models = (values.models ?? (mode === "standin" ? STANDIN_MODEL : "")).split(",").filter(Boolean);
  if (!models.length) throw new Error("真实模式要 --models");
  const overrides = Object.fromEntries(values.ref.map((r) => r.split("=") as [string, string]));
  const git = gitQuery(repo);
  const wanted = values.groups.split(",");
  const defs = GROUPS.filter((g) => wanted.includes(g.id));
  const groups = defs.map((g) => resolveGroup(g, git, { ...(values.base ? { base: values.base } : {}), overrides }));
  const runnerCommit = git.revParse("HEAD") ?? "?";
  const cfgFor = (groupId: string, model: string) => {
    const c = modelConfig(mode, model, process.env, defs.find((d) => d.id === groupId)?.settings ?? null);
    return { ...c, fingerprint: configFingerprint(c) };
  };
  const records: RawRecord[] = [];
  const heads: Record<string, string> = {};
  const notes: string[] = [];
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "g6-trees-")));
  try {
    for (const g of groups) {
      if (g.state !== "可跑") continue;
      const dir = path.join(work, g.id);
      let prepared: { head: string; linked: string[] };
      try {
        prepared = prepareTree(repo, g, dir);
      } catch (e) {
        (g as { state: string }).state = e instanceof MergeConflict ? "未测(合入冲突)" : "未测(分支未就绪)";
        (g as { reason: string | null }).reason = e instanceof MergeConflict ? `${e.message}(需各片先 rebase 成一条链,或用 --ref 指定已合好的提交)` : `建工作树失败:${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
        continue;
      }
      heads[g.id] = prepared.head;
      notes.push(`${g.label} 工作树 HEAD \`${prepared.head}\`(基线 ${g.base?.slice(0, 12)} 按序合入 ${g.inputs.map((i) => `${i.slice}@${i.sha?.slice(0, 12)}`).join("、") || "无"};未推送);依赖链接:${prepared.linked.join("、")}`);
      for (const run of planRuns([g], models, items, Number(values.reps))) {
        const cfg = cfgFor(g.id, run.model);
        const tag = `${run.group}__${run.model.replace(/[^A-Za-z0-9.-]/g, "_")}`;
        const outFile = path.join(out, "raw", tag, `${run.item}-r${run.rep}.json`);
        const jobFile = path.join(work, `${tag}-${run.item}-${run.rep}.job.json`);
        const job = { fixtureFile: path.join(dir, "packages/server/proof/g6/fixtures", path.basename(values.fixture)), itemId: run.item, group: run.group, commit: prepared.head, rep: run.rep, mode, model: run.model, dataDir: path.join(work, "data", tag, `${run.item}-${run.rep}`), fingerprint: cfg.fingerprint, stepTimeoutMs: Number(values["step-timeout"] ?? (mode === "real" ? 300_000 : 30_000)), callTimeoutMs: Number(values["call-timeout"]), quietMs: Number(values.quiet ?? (mode === "real" ? 400 : 60)), settleMs: Number(values.settle), settings: cfg.settings };
        if (!existsSync(job.fixtureFile)) cpSync(values.fixture, job.fixtureFile);
        writeFileSync(jobFile, JSON.stringify(job));
        const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir() };
        if (mode === "real") for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) env[k] = process.env[k]!;
        const t0 = Date.now();
        const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(dir, "packages/server/proof/g6/driver.ts"), jobFile, outFile], { env, encoding: "utf8", timeout: job.stepTimeoutMs * 40, cwd: dir });
        let rec: RawRecord;
        try {
          rec = JSON.parse(readFileSync(outFile, "utf8")) as RawRecord;
        } catch {
          rec = crashRecord({ ...run, commit: prepared.head, mode, fingerprint: cfg.fingerprint }, `driver 没交回记录(退出码 ${r.status},信号 ${r.signal ?? "无"}):${(r.stderr ?? "").slice(-400)}`, t0);
          mkdirSync(path.dirname(outFile), { recursive: true });
          writeFileSync(outFile, JSON.stringify(rec));
        }
        records.push(rec);
        console.log(`${run.group} ${run.model} ${run.item}#${run.rep}: ${rec.status} 调用 ${rec.calls.length} 次 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  } finally {
    if (!values.keep) {
      for (const g of groups) if (existsSync(path.join(work, g.id))) spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path.join(work, g.id)], { stdio: "ignore", env: gitEnv() });
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else notes.push(`工作树保留在 ${work}`);
  }
  const results: ResultRow[] = [];
  for (const g of groups) {
    for (const model of models) {
      const recs = records.filter((r) => r.group === g.id && r.model === model);
      if (!recs.length) continue;
      results.push({ group: g.id, label: g.label, model, mode, fingerprint: cfgFor(g.id, model).fingerprint, metrics: scoreRecords(set, recs), contracts: mergeContracts(recs.map((r) => ({ runId: r.runId, results: checkRecord(set.items.find((i) => i.id === r.item)!, r) }))) });
    }
  }
  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    runner: { commit: runnerCommit, node: process.version, platform: `${process.platform}-${process.arch}` },
    fixture: { id: set.id, digest: fixtureDigest(set), items },
    reps: Number(values.reps),
    groups,
    models: models.map((m) => cfgFor("g1", m)),
    results,
    notes,
  };
  mkdirSync(out, { recursive: true });
  const freeze = records.map((r) => ({ runId: r.runId, commit: r.commit, ...sourceFreeze(set.items.find((i) => i.id === r.item)!, r) }));
  writeFileSync(path.join(out, "summary.json"), `${JSON.stringify({ ...summary, heads, freeze }, null, 1)}\n`);
  writeFileSync(path.join(out, "report.md"), renderReport(summary));
  console.log(`报告:${path.join(out, "report.md")}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
