// G6 报告:冻结清单、各组状态(已跑/未测及原因)、开关表、确定性合同、分开列的各项指标、失败与分母、成本延迟积压。
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 只写测量值:不预设阈值,不写验收结论;规则替身的结果标明只验证 runner。
import { GROUPS, type GroupState, switchTable } from "./groups.ts";
import type { ModelConfig } from "./manifest.ts";
import type { ContractResult, Metrics, Ratio } from "./types.ts";

export interface ResultRow {
  readonly group: string;
  readonly label: string;
  readonly model: string;
  readonly mode: "standin" | "real";
  readonly fingerprint: string;
  readonly metrics: Metrics;
  readonly contracts: readonly ContractResult[];
}
export interface Summary {
  readonly generatedAt: string;
  readonly runner: { readonly commit: string; readonly node: string; readonly platform: string };
  readonly fixture: { readonly id: string; readonly digest: string; readonly items: readonly string[] };
  readonly reps: number;
  readonly groups: readonly GroupState[];
  readonly models: readonly (ModelConfig & { readonly fingerprint: string })[];
  readonly results: readonly ResultRow[];
  readonly notes: readonly string[];
}

/** 比率写成「分子/分母(百分比)」;分母为 0 写不适用。 */
export function fmtRatio(r: Ratio): string { return undefined as never; }
const ms = (x: number | null) => undefined as never;
const who = (r: Pick<ResultRow, "label" | "model" | "mode">) => undefined as never;
const VERDICT: Readonly<Record<string, string>> = { pass: "守住", fail: "**未守住**", "n/a": "不适用" };

export function renderReport(s: Summary): string { return undefined as never; }
