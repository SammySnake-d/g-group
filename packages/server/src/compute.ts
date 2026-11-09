// 真实 Claude Code Compute 的接线(AC-51):给宿主一个按 Harness 复用的适配器工厂。
import type { ComputeAdapter } from "@g-group/adapter-cc-compute";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";

/** 空壳(红):签名在,返回假值。 */
export const CLAUDE_IDLE_RECLAIM_MS = 0;
export function claudeAdapterOptions(_env: Readonly<Record<string, string | undefined>>, _idleReclaimMs: number = CLAUDE_IDLE_RECLAIM_MS): { hostEnv: Record<string, string>; idleReclaimMs: number } {
  return { hostEnv: {}, idleReclaimMs: 0 };
}
export function claudeCompute(_env: Readonly<Record<string, string | undefined>>): (model: string) => ComputeAdapter {
  return () => createComputeAdapter({});
}
