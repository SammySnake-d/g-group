// 空壳(红提交):签名保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export type PlainResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string; readonly why: string };

export function plainData(x: unknown, at: string): PlainResult {
  throw new Error("未实现");
}

export function isPlainRecord(x: unknown): x is Readonly<Record<string, unknown>> {
  throw new Error("未实现");
}
