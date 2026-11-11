// 运行时配置的宿主侧规则(需求文档 D07.4 规则 2、D26 第 3 / 8.6 节、D27 第 4 节第 4 条;AC-43 ②⑦⑧⑯、AC-51 ⑦):空壳,签名在、返回假值。
import type { HARNESSES } from "@g-group/api-contract";
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import { DEFAULT_STALL_THRESHOLDS, type RunFailure, type ThresholdConfig, classifyFailure, runFailure } from "@g-group/kernel";

export type Harness = (typeof HARNESSES)[number];
export type ComputeFactory = (model: string) => ComputeAdapter;
export type ComputeFactories = Readonly<Partial<Record<Harness, ComputeFactory>>>;

export function computeFactories(c: ComputeFactory | ComputeFactories | undefined): ComputeFactories {
  return typeof c === "function" ? { "claude-code": c } : {};
}
export function connectedHarnesses(_f: ComputeFactories): Harness[] {
  return [];
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
export function harnessWarning(_harness: Harness, _connected: readonly Harness[]): HarnessWarning | undefined {
  return undefined;
}
export function harnessBlockReason(_harness: string, _connected: readonly Harness[]): string | null {
  return null;
}
export function configFailure(raw: string): RunFailure {
  return runFailure(classifyFailure({ text: raw }));
}
export interface StallInput {
  readonly noProgressMs?: number;
  readonly firstByteMs?: number;
}
export interface UpstreamStall extends StallInput {
  readonly upstream: string;
}
export interface StoredRunThresholds {
  readonly defaults?: StallInput;
  readonly byUpstream?: readonly UpstreamStall[];
}
export const STALL_MS_MIN = 1000;
export const STALL_MS_MAX = 86_400_000;
export function checkStall(_x: unknown, _where: string): StallInput {
  return {};
}
export function checkRunThresholds(_x: unknown): StoredRunThresholds {
  return {};
}
export function composeThresholds(base: ThresholdConfig, _stored: StoredRunThresholds | undefined, _contacts: Iterable<readonly [string, StallInput | null | undefined]>): ThresholdConfig {
  return base;
}
export function runThresholdsView(_base: ThresholdConfig, _stored: StoredRunThresholds | undefined): { defaults: { noProgressMs: number; firstByteMs: number }; byUpstream: UpstreamStall[] } {
  return { defaults: { noProgressMs: DEFAULT_STALL_THRESHOLDS.stallMs, firstByteMs: DEFAULT_STALL_THRESHOLDS.firstByteMs }, byUpstream: [] };
}
export function cliRunThresholds(_v: { readonly noProgressMs?: string | undefined; readonly firstByteMs?: string | undefined }): ThresholdConfig | undefined {
  return undefined;
}
export function pidAlive(_pid: number): boolean {
  return false;
}
