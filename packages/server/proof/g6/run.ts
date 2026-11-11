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
export function planRuns(groups: readonly GroupState[], models: readonly string[], items: readonly string[], reps: number): PlannedRun[] { return undefined as never; }

/** driver 没交回记录(崩溃、超时被杀、输出坏)时补的记录:status=error,留在分母里。 */
export function crashRecord(run: PlannedRun & { commit: string; mode: "standin" | "real"; fingerprint: string; reuseKey: string }, why: string, at: number): RawRecord { return undefined as never; }

/** 只选配置来源、不指仓库位置的变量,留着 */
const KEEP_GIT_VARS: ReadonlySet<string> = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
/**
 * runner 起 git 子进程用的环境:剥掉 GIT_* 变量(与门禁同做法;只留选配置来源的三个)。runner 可能在 pre-push 钩子里被调用,
 * 钩子继承的 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE 会让 `git -C <临时仓库>` 实际改到调用方仓库。extra 里的值(提交身份)再加回去。
 */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> { return undefined as never; }

export function gitQuery(repo: string): GitQuery { return undefined as never; }

/**
 * 续跑:这份记录能不能直接沿用。只认同一组提交、同一配置指纹、同一次序的合法记录;运行出错(driver 崩溃)的不沿用,重跑一次。
 * 超时、配置不足、上游失败的记录照常沿用——它们是测量结果,留在分母里,不靠重跑把失败洗掉。
 */
export function reusable(rec: unknown, want: { readonly commit: string; readonly reuseKey: string; readonly item: string; readonly rep: number }): boolean { return undefined as never; }

/**
 * 网关是不是还在(真实模式每道题前后各查一次,不发模型请求):能收到任何 HTTP 回复就算在(连 404/500 都算在,那是网关在回话);
 * 连试两次都连不上才判不在,停整个 runner 并把那一道的记录丢掉,留给续跑——会话断了网关跟着没了,那不是模型或宿主的失败,不能写进分母。
 */
export async function gatewayUp(baseUrl: string, fetchFn: typeof globalThis.fetch, timeoutMs = 10_000, attempts = 2): Promise<boolean> { return undefined as never; }

export interface ProbeAttempt {
  readonly at: string;
  readonly status: number;
  readonly retryAfter: string | null;
  readonly note: string;
}
/** 探测结果怎么读:HTTP 429 与「HTTP 200 但流里是 error 事件」(上游不可用一类)都算还没准备好,等一段再探;拿到正文就算好。 */
export function classifyProbe(status: number, body: string): { ready: boolean; note: string } { return undefined as never; }
/**
 * 一个模型在报告里的状态:有记录就记「已跑」(探测记录照留);没有记录但有探测结果就照探测结果记(429 到上限 → 未测(上游 429 限流));
 * 两者都没有记「未跑(本次未选或无可跑的组)」。不会把未测盖成一句空话。
 */
export function modelStatesFor(model: string, records: readonly RawRecord[], existing: { state: string; attempts: ProbeAttempt[] } | undefined): { state: string; attempts: ProbeAttempt[] } { return undefined as never; }

/**
 * 跑一个模型之前单发一次极小的探测(max_tokens 8)。429 就等 waitMs 再探,最多 tries 次;仍 429 返回 ok=false,该模型这次不跑。
 * 非 429 的失败不在这里拦(真实运行里照常记进分母)。
 */
export async function probeModel(o: { model: string; env: Readonly<Record<string, string | undefined>>; fetch: typeof globalThis.fetch; tries: number; waitMs: number; sleep: (ms: number) => Promise<void>; now?: () => Date }): Promise<{ ok: boolean; attempts: ProbeAttempt[] }> { return undefined as never; }

/** 被测工作树的依赖:第三方包软链到 runner 的 node_modules;@g-group/* 链到被测树自己的 packages;file: 依赖链到被测树里的目录。 */
export function linkNodeModules(runnerRoot: string, tree: string): string[] { return undefined as never; }

/** 合入冲突的说明:哪片、哪些文件。 */
export function conflictText(slice: string, files: readonly string[]): string { return undefined as never; }
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
export function prepareTree(repo: string, g: GroupState, dir: string): { head: string; linked: string[] } { return undefined as never; }

const sleep = (ms: number) => undefined as never;
const readJson = (f: string): unknown => { return undefined as never; };

async function main() { return undefined as never; }

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main().catch((e) => { return undefined as never; });
