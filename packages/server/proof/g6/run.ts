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
export function planRuns(groups: readonly GroupState[], models: readonly string[], items: readonly string[], reps: number): PlannedRun[] { return undefined as never; }

/** driver 没交回记录(崩溃、超时被杀、输出坏)时补的记录:status=error,留在分母里。 */
export function crashRecord(run: PlannedRun & { commit: string; mode: "standin" | "real"; fingerprint: string }, why: string, at: number): RawRecord { return undefined as never; }

/** 只选配置来源、不指仓库位置的变量,留着 */
const KEEP_GIT_VARS: ReadonlySet<string> = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
/**
 * runner 起 git 子进程用的环境:剥掉 GIT_* 变量(与门禁同做法;只留选配置来源的三个)。runner 可能在 pre-push 钩子里被调用,
 * 钩子继承的 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE 会让 `git -C <临时仓库>` 实际改到调用方仓库。extra 里的值(提交身份)再加回去。
 */
export function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> { return undefined as never; }

export function gitQuery(repo: string): GitQuery { return undefined as never; }

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

/** 建一组的工作树:基线 detach,按序合入各片(不推送、不改任何分支),叠上本目录(不含测试)。合并冲突抛 MergeConflict。 */
export function prepareTree(repo: string, g: GroupState, dir: string): { head: string; linked: string[] } { return undefined as never; }

function main() { return undefined as never; }

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
