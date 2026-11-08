// Claude Code 常驻 Compute 适配器(AC-51、需求文档 D27)。红提交:空壳,签名在、返回假值。
import type { AdapterOptions, Brief, ComputeAdapter, ComputeEvent, Refusal } from "./types.ts";

export interface ResidentAdapterOptions extends AdapterOptions {
  readonly inSessionModelSwitch?: boolean;
  readonly inSessionEffort?: boolean;
  readonly switchTimeoutMs?: number;
  readonly idleReclaimMs?: number;
}
export const DEFAULT_SWITCH_TIMEOUT_MS = 60_000;
export function residentArgs(_input: Brief, _mcpConfigPath: string, _launch: { readonly sessionId: string; readonly resume: boolean; readonly model?: string; readonly effort?: string }): readonly string[] {
  return [];
}
export function turnModels(_result: Record<string, unknown>): readonly string[] {
  return [];
}
const no = (): Refusal => ({ ok: false, reason: "未实现" });
export function createResidentComputeAdapter(_options: ResidentAdapterOptions = {}): ComputeAdapter {
  return {
    capabilities: { inSessionModelSwitch: true },
    spawn: async () => no(),
    resume: async () => no(),
    steer: async () => no(),
    stop: async () => no(),
    events: async function* (): AsyncGenerator<ComputeEvent> {},
    settled: async () => [],
    snapshot: () => no(),
    rejectedReports: () => [],
  };
}
