// 运行时配置的宿主侧规则(需求文档 D07.4 规则 2、D26 第 3 / 8.6 节、D27 第 4 节第 4 条;AC-43 ②⑦⑧⑯、AC-51 ⑦):
//   - Compute 工厂按 Harness 取:没有对应适配器的 Harness 在启动前拦下,不静默换成别的 Harness 代跑;配置里选了它照常保存,只带 warning;
//   - 卡死阈值三层:宿主构造参数(start.ts / cli.ts 透传)← 用户设置里的默认与按上游 ← 联系人自己的覆盖;每次判定现读,不缓存;
//   - 执行进程存活:按 pid 探测(进程已不在才算不在,没有权限探测的算在);
//   - 换模型被拒、Harness 没接入都是配置问题,台账原因类别记 invalid_request,原文照留。
// 纯函数与常量,不做 I/O(pidAlive 只发 0 号信号探测)。
import { HARNESSES } from "@g-group/api-contract";
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import { DEFAULT_STALL_THRESHOLDS, type RunFailure, type StallThresholds, type ThresholdConfig, classifyFailure, runFailure } from "@g-group/kernel";
import { HostError } from "./db.ts";

export type Harness = (typeof HARNESSES)[number];
/** 按模型取一个 Compute 适配器(按 Harness 复用的适配器只在第一次调用时建) */
export type ComputeFactory = (model: string) => ComputeAdapter;
/** 每个 Harness 一个工厂;没有的 Harness 就是没接入 */
export type ComputeFactories = Readonly<Partial<Record<Harness, ComputeFactory>>>;

/** 界面上的 Harness 名 */
const HARNESS_LABEL: Readonly<Record<Harness, string>> = Object.freeze({ "claude-code": "claude-code", codex: "Codex" });

/**
 * HostOptions.compute 归一成按 Harness 的工厂表。单个函数就是 Claude Code 的工厂(现有接线 start.ts / cli.ts / 测试替身都是它);
 * 表里只收已知 Harness 且值是函数的项。不给就是一个都没接入。
 */
export function computeFactories(c: ComputeFactory | ComputeFactories | undefined): ComputeFactories {
  if (typeof c === "function") return Object.freeze({ "claude-code": c });
  const out: Partial<Record<Harness, ComputeFactory>> = {};
  if (c && typeof c === "object") for (const h of HARNESSES) if (Object.hasOwn(c, h) && typeof c[h] === "function") out[h] = c[h];
  return Object.freeze(out);
}
/** 已接入的 Harness,按 HARNESSES 的顺序 */
export function connectedHarnesses(f: ComputeFactories): Harness[] {
  return HARNESSES.filter((h) => typeof f[h] === "function");
}

export interface HarnessFix {
  readonly kind: "use-connected-harness" | "wait-for-harness";
  readonly harness: Harness;
  readonly label: string;
}
export interface HarnessWarning {
  readonly code: "harness-not-connected";
  readonly harness: Harness;
  readonly message: string;
  readonly fixes: HarnessFix[];
}
const labelOf = (h: string): string => (Object.hasOwn(HARNESS_LABEL, h) ? HARNESS_LABEL[h as Harness] : h);
/** 两条修复路径:改用已接入的 Harness(每个一条)/ 等这个 Harness 接入 */
function fixesFor(harness: Harness, connected: readonly Harness[]): HarnessFix[] {
  return [
    ...connected.filter((h) => h !== harness).map((h) => ({ kind: "use-connected-harness" as const, harness: h, label: `改用 ${labelOf(h)}` })),
    { kind: "wait-for-harness", harness, label: `等 ${labelOf(harness)} 接入` },
  ];
}
/**
 * 选了没接入的 Harness 时给配置视图的 warning(不拒绝保存)。宿主一个 Compute 都没接时不给:那是另一种情况,派活时已明确失败。
 */
export function harnessWarning(harness: Harness, connected: readonly Harness[]): HarnessWarning | undefined {
  if (connected.length === 0 || connected.includes(harness)) return undefined;
  const fixes = fixesFor(harness, connected);
  return {
    code: "harness-not-connected",
    harness,
    message: `宿主还没有接入 ${labelOf(harness)} 的 Compute 适配器:配置照常保存,但派活会在启动前被拦下,不会改用别的 Harness 代跑。修复路径:${fixes.map((f) => f.label).join(";或")}。`,
    fixes,
  };
}
/**
 * 启动前拦截的原因(进任务失败与台账原文,联系人据此在聊天里给用户两条修复路径);接入了返回 null。
 * 宿主一个 Compute 都没接时也返回 null,由「宿主没有配置 Compute 适配器」那条路失败。
 */
export function harnessBlockReason(harness: string, connected: readonly Harness[]): string | null {
  if (connected.length === 0 || (connected as readonly string[]).includes(harness)) return null;
  const fixes = fixesFor(harness as Harness, connected);
  return `这位联系人的 Compute 选的是 ${labelOf(harness)},宿主还没有接入它的适配器,这次没有启动(不改用别的 Harness 代跑)。修复路径:${fixes.map((f, i) => `${"①②③④"[i] ?? `${i + 1}.`} ${f.label}`).join(" ")},改好后重跑这个任务`;
}

/** 配置问题(Harness 没接入、换模型被拒):原因类别 invalid_request「改模型配置」,原文照留 */
export function configFailure(raw: string): RunFailure {
  return runFailure(classifyFailure({ text: raw, kind: "invalid_request" }));
}

// ---------------- 卡死阈值(#2827:默认 15 分钟 / 120 秒,可按联系人或按上游单独设) ----------------
/** 一层阈值:一轮多久没有进展判失败 / 模型调用发出后等首字节多久算没回应;不填的用上一层 */
export interface StallInput {
  readonly noProgressMs?: number;
  readonly firstByteMs?: number;
}
export interface UpstreamStall extends StallInput {
  readonly upstream: string;
}
/** 用户设置里存的阈值 */
export interface StoredRunThresholds {
  readonly defaults?: StallInput;
  readonly byUpstream?: readonly UpstreamStall[];
}
/** 阈值的取值范围(毫秒):1 秒到 1 天 */
export const STALL_MS_MIN = 1000;
export const STALL_MS_MAX = 86_400_000;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const bad = (why: string): never => {
  throw new HostError("invalid_params", why);
};
/** 校验一层阈值:只收 noProgressMs / firstByteMs,值是 1 秒到 1 天的整数毫秒 */
export function checkStall(x: unknown, where: string): StallInput {
  if (!isRecord(x)) return bad(`${where} 应为对象`);
  const out: { noProgressMs?: number; firstByteMs?: number } = {};
  for (const k of Object.keys(x)) {
    if (k !== "noProgressMs" && k !== "firstByteMs") return bad(`${where} 不认识字段 ${k}`);
    const v = x[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < STALL_MS_MIN || v > STALL_MS_MAX) return bad(`${where}.${k} 应为 ${STALL_MS_MIN}–${STALL_MS_MAX} 的整数毫秒`);
    out[k] = v;
  }
  return Object.freeze(out);
}
/** 校验设置里的阈值(整份替换):默认层一份,按上游每个上游至多一条 */
export function checkRunThresholds(x: unknown): StoredRunThresholds {
  if (!isRecord(x)) return bad("runThresholds 应为对象");
  for (const k of Object.keys(x)) if (k !== "defaults" && k !== "byUpstream") bad(`runThresholds 不认识字段 ${k}`);
  const defaults = x.defaults === undefined ? {} : checkStall(x.defaults, "runThresholds.defaults");
  const list = x.byUpstream === undefined ? [] : x.byUpstream;
  if (!Array.isArray(list)) return bad("runThresholds.byUpstream 应为数组");
  const seen = new Set<string>();
  const byUpstream = list.map((e, i) => {
    if (!isRecord(e)) return bad(`runThresholds.byUpstream[${i}] 应为对象`);
    const { upstream, ...rest } = e;
    if (typeof upstream !== "string" || upstream.trim() === "") return bad(`runThresholds.byUpstream[${i}].upstream 不能为空`);
    if (seen.has(upstream)) return bad(`runThresholds.byUpstream 里上游 ${upstream} 出现了不止一次`);
    seen.add(upstream);
    return Object.freeze({ upstream, ...checkStall(rest, `runThresholds.byUpstream[${i}]`) });
  });
  return Object.freeze({ defaults, byUpstream: Object.freeze(byUpstream) });
}

const toKernel = (s: StallInput | undefined): Partial<StallThresholds> => ({
  ...(s?.noProgressMs !== undefined ? { stallMs: s.noProgressMs } : {}),
  ...(s?.firstByteMs !== undefined ? { firstByteMs: s.firstByteMs } : {}),
});
/**
 * 此刻生效的阈值配置(交给内核 resolveThresholds):默认层 = 构造参数 ← 用户设置;按上游 = 构造参数 ← 用户设置;按联系人 = 构造参数 ← 联系人自己的覆盖。
 * 每次判定都调用,读的是调用这一刻的设置与联系人,不缓存。
 */
export function composeThresholds(base: ThresholdConfig, stored: StoredRunThresholds | undefined, contacts: Iterable<readonly [string, StallInput | null | undefined]>): ThresholdConfig {
  const byUpstream: Record<string, Partial<StallThresholds>> = { ...(base.byUpstream ?? {}) };
  for (const e of stored?.byUpstream ?? []) byUpstream[e.upstream] = { ...(byUpstream[e.upstream] ?? {}), ...toKernel(e) };
  const byContact: Record<string, Partial<StallThresholds>> = { ...(base.byContact ?? {}) };
  for (const [id, s] of contacts) if (s) byContact[id] = { ...(byContact[id] ?? {}), ...toKernel(s) };
  return { defaults: { ...(base.defaults ?? {}), ...toKernel(stored?.defaults) }, byUpstream, byContact };
}
/** 设置视图里的阈值:默认层填上生效值(没设的显示 15 分钟 / 120 秒或构造参数给的值),按上游原样 */
export function runThresholdsView(base: ThresholdConfig, stored: StoredRunThresholds | undefined): { defaults: { noProgressMs: number; firstByteMs: number }; byUpstream: UpstreamStall[] } {
  const pos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const noProgressMs = stored?.defaults?.noProgressMs ?? (pos(base.defaults?.stallMs) ? base.defaults.stallMs : DEFAULT_STALL_THRESHOLDS.stallMs);
  const firstByteMs = stored?.defaults?.firstByteMs ?? (pos(base.defaults?.firstByteMs) ? base.defaults.firstByteMs : DEFAULT_STALL_THRESHOLDS.firstByteMs);
  return { defaults: { noProgressMs, firstByteMs }, byUpstream: (stored?.byUpstream ?? []).map((e) => ({ ...e })) };
}
/** cli.ts 的 --no-progress-ms / --first-byte-ms:都没给返回 undefined;给了不合格的抛错 */
export function cliRunThresholds(v: { readonly noProgressMs?: string | undefined; readonly firstByteMs?: string | undefined }): ThresholdConfig | undefined {
  const num = (s: string | undefined, flag: string): number | undefined => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!/^\d+$/.test(s.trim()) || !Number.isSafeInteger(n) || n < STALL_MS_MIN || n > STALL_MS_MAX) throw new Error(`${flag} 应为 ${STALL_MS_MIN}–${STALL_MS_MAX} 的整数毫秒,收到 ${s}`);
    return n;
  };
  const stallMs = num(v.noProgressMs, "--no-progress-ms");
  const firstByteMs = num(v.firstByteMs, "--first-byte-ms");
  if (stallMs === undefined && firstByteMs === undefined) return undefined;
  return { defaults: { ...(stallMs !== undefined ? { stallMs } : {}), ...(firstByteMs !== undefined ? { firstByteMs } : {}) } };
}

// ---------------- 执行进程存活(D26 第 3 节「按 pid、宿主启动号核对所有 running」) ----------------
/** pid 对应的进程还在不在:0 号信号探测;ESRCH 才算不在,没有权限(EPERM)说明进程在 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown }).code === "EPERM";
  }
}
