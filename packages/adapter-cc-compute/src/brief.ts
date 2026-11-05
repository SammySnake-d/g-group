// 空壳(红提交):签名与类型保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */
import type { Brief, HandoffSnapshot, Refusal } from "./types.ts";

export const CREDENTIAL_REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/;

export function checkBrief(x: unknown): { readonly ok: true; readonly brief: Brief } | Refusal {
  throw new Error("未实现");
}

export function checkSnapshot(x: unknown): { readonly ok: true; readonly snapshot: HandoffSnapshot } | Refusal {
  throw new Error("未实现");
}
