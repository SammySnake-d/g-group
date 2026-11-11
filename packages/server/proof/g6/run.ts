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
import { configFingerprint, modelConfig, reuseKey, runnerDigest, sourceFreeze } from "./manifest.ts";
import { renderReport, type ResultRow, type Summary } from "./report.ts";
import { scoreRecords } from "./score.ts";
import type { FixtureSet, HostPatch, RawRecord } from "./types.ts";

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
export function crashRecord(run: PlannedRun & { commit: string; mode: "standin" | "real"; fingerprint: string; reuseKey: string }, why: string, at: number): RawRecord {
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
    reuseKey: run.reuseKey,
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
    hostPatch: null,
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
    isAncestor(a, b) {
      try {
        git("merge-base", "--is-ancestor", a, b);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 续跑:这份记录能不能直接沿用。只认同一组提交、同一配置指纹、同一次序的合法记录;运行出错(driver 崩溃)的不沿用,重跑一次。
 * 超时、配置不足、上游失败的记录照常沿用——它们是测量结果,留在分母里,不靠重跑把失败洗掉。
 */
export function reusable(rec: unknown, want: { readonly commit: string; readonly reuseKey: string; readonly item: string; readonly rep: number }): boolean {
  if (rec === null || typeof rec !== "object") return false;
  const r = rec as Partial<RawRecord>;
  return r.schema === "g6-raw/v1" && r.commit === want.commit && r.reuseKey === want.reuseKey && r.item === want.item && r.rep === want.rep && r.status !== "error" && Array.isArray(r.calls);
}

/**
 * 网关是不是还在(真实模式每道题之前查一次,不发模型请求):能收到任何 HTTP 回复就算在;连不上就停整个 runner,不记录这一道,
 * 留给续跑——会话断了网关跟着没了,那不是模型或宿主的失败,不能写进分母。
 */
export async function gatewayUp(baseUrl: string, fetchFn: typeof globalThis.fetch, timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetchFn(baseUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export interface ProbeAttempt {
  readonly at: string;
  readonly status: number;
  readonly retryAfter: string | null;
  readonly note: string;
}
/**
 * 一个模型在报告里的状态:有记录就记「已跑」(探测记录照留);没有记录但有探测结果就照探测结果记(429 到上限 → 未测(上游 429 限流));
 * 两者都没有记「未跑(本次未选或无可跑的组)」。不会把未测盖成一句空话。
 */
export function modelStatesFor(model: string, records: readonly RawRecord[], existing: { state: string; attempts: ProbeAttempt[] } | undefined): { state: string; attempts: ProbeAttempt[] } {
  const attempts = existing?.attempts ?? [];
  if (records.some((r) => r.model === model)) return { state: "已跑", attempts };
  if (existing && existing.state !== "可跑") return { state: existing.state, attempts };
  return { state: "未跑(本次未选或无可跑的组)", attempts };
}

/**
 * 跑一个模型之前单发一次极小的探测(max_tokens 8)。429 就等 waitMs 再探,最多 tries 次;仍 429 返回 ok=false,该模型这次不跑。
 * 非 429 的失败不在这里拦(真实运行里照常记进分母)。
 */
export async function probeModel(o: { model: string; env: Readonly<Record<string, string | undefined>>; fetch: typeof globalThis.fetch; tries: number; waitMs: number; sleep: (ms: number) => Promise<void>; now?: () => Date }): Promise<{ ok: boolean; attempts: ProbeAttempt[] }> {
  const now = o.now ?? (() => new Date());
  const attempts: ProbeAttempt[] = [];
  const base = (o.env.ANTHROPIC_BASE_URL ?? "").replace(/\/$/, "");
  const token = o.env.ANTHROPIC_AUTH_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(token ? { authorization: `Bearer ${token}` } : o.env.ANTHROPIC_API_KEY ? { "x-api-key": o.env.ANTHROPIC_API_KEY } : {}) };
  for (let i = 0; i < o.tries; i++) {
    if (i > 0) await o.sleep(o.waitMs);
    let status = 0;
    let retryAfter: string | null = null;
    let note = "";
    try {
      const r = await o.fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: o.model, max_tokens: 8, messages: [{ role: "user", content: "回一个字:好" }] }) });
      status = r.status;
      retryAfter = r.headers.get("retry-after");
      const t = await r.text();
      note = status === 200 ? "ok" : (t.match(/"type"\s*:\s*"([a-z_]+_error)"/)?.[1] ?? `HTTP ${status}`);
    } catch (e) {
      note = `网络错误:${e instanceof Error ? e.message : String(e)}`;
    }
    attempts.push({ at: now().toISOString(), status, retryAfter, note });
    if (status !== 429) return { ok: true, attempts };
  }
  return { ok: false, attempts };
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

/**
 * 建一组的工作树:有现成组提交(只供 G6 的合并提交)就直接 detach 到它;否则基线 detach,按序合入各片(不推送、不改任何分支)。
 * 都叠上本目录(不含测试)。合并冲突抛 MergeConflict。
 */
export function prepareTree(repo: string, g: GroupState, dir: string): { head: string; linked: string[] } {
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, g.groupCommit ?? g.base!], { stdio: "ignore", env: gitEnv() });
  const env = gitEnv({ GIT_AUTHOR_NAME: "g6-runner", GIT_AUTHOR_EMAIL: "g6@local.invalid", GIT_COMMITTER_NAME: "g6-runner", GIT_COMMITTER_EMAIL: "g6@local.invalid" });
  for (const i of g.groupCommit ? [] : g.inputs) {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const readJson = (f: string): unknown => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

async function main() {
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
      "group-ref": { type: "string", multiple: true, default: [] },
      fixture: { type: "string", default: path.join(HERE, "fixtures/set-v1.json") },
      "step-timeout": { type: "string" },
      "call-timeout": { type: "string", default: "300000" },
      quiet: { type: "string" },
      settle: { type: "string", default: "0" },
      probe: { type: "boolean", default: false },
      "probe-tries": { type: "string", default: "3" },
      "probe-wait": { type: "string", default: "1200000" },
      "report-only": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });
  const mode = values.mode === "real" ? "real" : "standin";
  // 真实模式一次只放一个模型调用(低并发);替身不连网,不排队
  const serial = mode === "real";
  if (!values.out) throw new Error("缺 --out 目录");
  const out = path.resolve(values.out);
  const repo = path.resolve(HERE, "../../../..");
  const set: FixtureSet = loadFixtureSet(values.fixture);
  const items = values.items === "all" ? set.items.map((i) => i.id) : values.items.split(",");
  const models = (values.models ?? (mode === "standin" ? STANDIN_MODEL : "")).split(",").filter(Boolean);
  if (!models.length) throw new Error("真实模式要 --models");
  const pairs = (xs: readonly string[]) => Object.fromEntries(xs.map((r) => r.split("=") as [string, string]));
  const overrides = pairs(values.ref);
  const groupRefs = pairs(values["group-ref"]);
  const git = gitQuery(repo);
  const wanted = values.groups.split(",");
  const defs = GROUPS.filter((g) => wanted.includes(g.id));
  const groups = defs.map((g) => resolveGroup(g, git, { ...(values.base ? { base: values.base } : {}), overrides, groupRefs }));
  const runnerCommit = git.revParse("HEAD") ?? "?";
  const patchOf = (groupId: string): HostPatch | null => defs.find((d) => d.id === groupId)?.hostPatch ?? null;
  const settleOf = (groupId: string): number => defs.find((d) => d.id === groupId)?.settleMs ?? Number(values.settle);
  // 驱动代码与题集一改,旧记录就不续用
  const digest = runnerDigest([...["driver.ts", "capture.ts", "standin.ts", "fixture.ts", "types.ts"].map((name) => ({ name, text: readFileSync(path.join(HERE, name), "utf8") })), { name: "fixture", text: readFileSync(values.fixture, "utf8") }]);
  const cfgFor = (groupId: string, model: string) => {
    const patch = patchOf(groupId);
    const settings = patch ? { ...patch, settleMs: settleOf(groupId) } : null;
    const c = modelConfig(mode, model, process.env, settings, serial);
    return { ...c, fingerprint: configFingerprint(c, digest), reuseKey: reuseKey(c, digest) };
  };
  mkdirSync(out, { recursive: true });
  // 各模型状态:真实模式加 --probe 时,跑之前单发探测;429 重探到上限仍 429 就不跑这个模型
  const modelStates: Record<string, { state: string; attempts: ProbeAttempt[] }> = {};
  const probesFile = path.join(out, "probes.json");
  Object.assign(modelStates, (readJson(probesFile) as typeof modelStates | null) ?? {});
  const records: RawRecord[] = [];
  const heads: Record<string, string> = {};
  const notes: string[] = [];
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "g6-trees-")));
  let stopped: string | null = null;
  try {
    outer: for (const g of groups) {
      if (g.state !== "可跑") continue;
      const dir = path.join(work, g.id);
      let prepared: { head: string; linked: string[] };
      try {
        prepared = prepareTree(repo, g, dir);
      } catch (e) {
        (g as { state: string }).state = e instanceof MergeConflict ? "未测(合入冲突)" : "未测(分支未就绪)";
        (g as { reason: string | null }).reason = e instanceof MergeConflict ? `${e.message}(需各片先 rebase 成一条链,或用 --group-ref 指定只供 G6 的合并提交)` : `建工作树失败:${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
        continue;
      }
      heads[g.id] = prepared.head;
      notes.push(`${g.label} 工作树 HEAD \`${prepared.head}\`(${g.groupCommit ? "只供 G6 的合并提交" : `基线 ${g.base?.slice(0, 12)} 按序合入 ${g.inputs.map((i) => `${i.slice}@${i.sha?.slice(0, 12)}`).join("、") || "无"}`};未推送到任何 PR 分支);依赖链接:${prepared.linked.join("、")}`);
      for (const run of planRuns([g], models, items, Number(values.reps))) {
        const cfg = cfgFor(g.id, run.model);
        const tag = `${run.group}__${run.model.replace(/[^A-Za-z0-9.-]/g, "_")}`;
        const outFile = path.join(out, "raw", tag, `${run.item}-r${run.rep}.json`);
        const old = readJson(outFile);
        if (reusable(old, { commit: prepared.head, reuseKey: cfg.reuseKey, item: run.item, rep: run.rep })) {
          records.push(old as RawRecord);
          continue;
        }
        if (values["report-only"]) continue;
        if (mode === "real" && values.probe && !modelStates[run.model]) {
          const p = await probeModel({ model: run.model, env: process.env, fetch: globalThis.fetch, tries: Number(values["probe-tries"]), waitMs: Number(values["probe-wait"]), sleep });
          modelStates[run.model] = { state: p.ok ? "可跑" : "未测(上游 429 限流)", attempts: p.attempts };
          writeFileSync(probesFile, `${JSON.stringify(modelStates, null, 1)}\n`);
          console.log(`探测 ${run.model}:${modelStates[run.model]!.state}(${p.attempts.map((a) => `${a.at} ${a.status}`).join(";")})`);
        }
        if (modelStates[run.model] && modelStates[run.model]!.state !== "可跑") continue;
        if (mode === "real" && !(await gatewayUp(process.env.ANTHROPIC_BASE_URL ?? "", globalThis.fetch))) {
          stopped = `网关连不上(${new Date().toISOString()}),runner 停在 ${run.group} ${run.model} ${run.item}#${run.rep} 之前;已跑的都已落盘,换网关后续跑`;
          console.error(stopped);
          break outer;
        }
        const jobFile = path.join(work, `${tag}-${run.item}-${run.rep}.job.json`);
        const job = { fixtureFile: path.join(dir, "packages/server/proof/g6/fixtures", path.basename(values.fixture)), itemId: run.item, group: run.group, commit: prepared.head, rep: run.rep, mode, model: run.model, dataDir: path.join(work, "data", tag, `${run.item}-${run.rep}`), fingerprint: cfg.fingerprint, reuseKey: cfg.reuseKey, stepTimeoutMs: Number(values["step-timeout"] ?? (mode === "real" ? 300_000 : 30_000)), callTimeoutMs: Number(values["call-timeout"]), quietMs: Number(values.quiet ?? (mode === "real" ? 400 : 60)), settleMs: settleOf(g.id), hostPatch: patchOf(g.id), serial };
        if (!existsSync(job.fixtureFile)) cpSync(values.fixture, job.fixtureFile);
        writeFileSync(jobFile, JSON.stringify(job));
        const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir() };
        if (mode === "real") for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) env[k] = process.env[k]!;
        const t0 = Date.now();
        const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(dir, "packages/server/proof/g6/driver.ts"), jobFile, outFile], { env, encoding: "utf8", timeout: job.stepTimeoutMs * 40, cwd: dir });
        // 这一道跑的时候网关没了(会话断了):这份记录不算测量结果,删掉,停下留给续跑
        if (mode === "real" && !(await gatewayUp(process.env.ANTHROPIC_BASE_URL ?? "", globalThis.fetch))) {
          rmSync(outFile, { force: true });
          stopped = `网关在 ${run.group} ${run.model} ${run.item}#${run.rep} 运行期间断开(${new Date().toISOString()}),这一道的记录已丢弃,runner 停下;换网关后续跑`;
          console.error(stopped);
          break outer;
        }
        let rec: RawRecord;
        const got = readJson(outFile);
        if (got && (got as RawRecord).schema === "g6-raw/v1" && (got as RawRecord).startedAt >= t0) rec = got as RawRecord;
        else {
          rec = crashRecord({ ...run, commit: prepared.head, mode, fingerprint: cfg.fingerprint, reuseKey: cfg.reuseKey }, `driver 没交回记录(退出码 ${r.status},信号 ${r.signal ?? "无"}):${(r.stderr ?? "").slice(-400)}`, t0);
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
      results.push({ group: g.id, label: g.label, model, mode, fingerprint: [...new Set(recs.map((r) => r.fingerprint))].join("、"), metrics: scoreRecords(set, recs), contracts: mergeContracts(recs.map((r) => ({ runId: r.runId, results: checkRecord(set.items.find((i) => i.id === r.item)!, r) }))) });
    }
  }
  for (const m of models) modelStates[m] = modelStatesFor(m, records, modelStates[m]);
  if (stopped) notes.push(stopped);
  notes.push(`runner 驱动代码与题集摘要 ${digest};续跑只沿用同一组提交、同一续跑身份(模型/方式/认证引用/组级选项/一次一个调用/驱动摘要)、同一次序的记录;运行出错的记录不沿用`);
  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    runner: { commit: runnerCommit, node: process.version, platform: `${process.platform}-${process.arch}` },
    fixture: { id: set.id, digest: fixtureDigest(set), items },
    reps: Number(values.reps),
    groups,
    models: groups.flatMap((g) => models.map((m) => ({ ...cfgFor(g.id, m), group: g.id }))),
    modelStates: Object.fromEntries(models.map((m) => [m, modelStates[m]!])),
    results,
    notes,
  };
  const freeze = records.map((r) => ({ runId: r.runId, commit: r.commit, ...sourceFreeze(set.items.find((i) => i.id === r.item)!, r) }));
  writeFileSync(path.join(out, "summary.json"), `${JSON.stringify({ ...summary, heads, freeze }, null, 1)}\n`);
  writeFileSync(path.join(out, "report.md"), renderReport(summary));
  console.log(`报告:${path.join(out, "report.md")}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
