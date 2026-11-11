// G6 driver:在被测提交的工作树里跑一道题,产出一份原始记录(RawRecord)。G6 是本项目的验证工具(开发纪律),不进产品功能,
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 不给产品加开关或界面(需求文档 §2.0 v3.28)。runner 把整个 proof/g6/ 目录叠到被测工作树的同一位置再执行它,
// 所以下面的 ../../src/start.ts 解析到的是被测提交自己的装配入口——
// 联系人脑子与后台压缩器由被测提交按各自联系人的同模配置建(start.ts),driver 不另建、不改它们的参数。
// 模型流量只经 globalThis.fetch:规则替身模式下由进程内替身应答(不联网);真实模式转发到环境变量里的网关,只录请求体与响应。
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../src/start.ts";
import { recordingFetch } from "./capture.ts";
import { stepTexts } from "./fixture.ts";
import { createStandin } from "./standin.ts";
import type { FixtureItem, FixtureSet, HostPatch, MemoryRecord, MessageOp, RawRecord, ReplyRecord, RunStatus, SentMessage, StepRecord } from "./types.ts";

export interface DriveOptions {
  readonly set: FixtureSet;
  readonly item: FixtureItem;
  readonly group: string;
  readonly commit: string;
  readonly rep: number;
  readonly mode: "standin" | "real";
  readonly model: string;
  /** 真实模式的网关环境(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY);替身模式忽略。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  readonly fingerprint: string;
  readonly reuseKey: string;
  readonly stepTimeoutMs: number;
  readonly callTimeoutMs: number;
  /** 宿主空闲后再等多久确认真的安静(真实模型 400ms 左右,替身可更短) */
  readonly quietMs: number;
  /** 全部步骤做完后留给后台工作(补查、精筛)的时间 */
  readonly settleMs: number;
  /** 本组的宿主选项覆盖(start.ts 不暴露的宿主已有选项,如 G4 预取开关、G5 精筛安静期);null 不改 */
  readonly hostPatch?: HostPatch | null;
  /** 一次只放一个模型调用到上游 */
  readonly serial?: boolean;
}

const RUNNING = new Set(["T1_Open", "T2_Claimed", "T3_Running"]);
const sleep = (ms: number) => undefined as never;

/** 替身模式给宿主的网关环境:中性占位,不含任何凭据。 */
export const STANDIN_ENV: Readonly<Record<string, string>> = Object.freeze({ ANTHROPIC_BASE_URL: "http://g6-standin.invalid", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" });

/** 把一次调用归到题里的联系人:先认人设 marker;补写笔记的请求不带人设,题里只有一位联系人时就是它,否则记不明(null)。 */
export function contactOf(item: FixtureItem, text: string): string | null { return undefined as never; }

/**
 * 组级宿主选项覆盖:被测提交的 start.ts 不暴露这些选项,runner 在宿主建好、还没有任何一轮之前并进宿主的选项对象与 G5 精筛参数。
 * 返回实际落到的字段与被测提交里不存在的字段(不存在就不改、如实记下)。
 */
export function applyHostPatch(host: object, patch: HostPatch | null | undefined): { applied: string[]; missing: string[] } { return undefined as never; }

/** 宿主要的网关环境;缺项返回 null(记 config_insufficient,不跑)。 */
export function gatewayEnv(o: Pick<DriveOptions, "mode" | "model" | "env">): Record<string, string> | null { return undefined as never; }

export async function driveItem(o: DriveOptions): Promise<RawRecord> { return undefined as never; }

/** 命令行:node driver.ts <job.json> <out.json>。job 里不放凭据;真实模式的网关从本进程环境变量取。 */
async function main(argv: readonly string[]) { return undefined as never; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    () => undefined as never,
    (e) => { return undefined as never; },
  );
}
