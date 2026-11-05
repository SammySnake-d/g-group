// 空壳(红提交):签名保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export const REPORT_KINDS: readonly string[] = ["started", "milestone", "blocked", "completed", "failed"];

export function reportErrors(input: unknown): string[] {
  throw new Error("未实现");
}
