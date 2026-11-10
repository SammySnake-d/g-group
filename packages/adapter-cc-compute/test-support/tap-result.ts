// 仅供变异校准使用:判读 Node 的扁平 TAP,不是产品运行时接口。
export interface TapRun {
  out: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}
export interface FailureTarget { name: string; code: string }
export interface TapResult {
  valid: boolean;
  killed: boolean;
  passed: string[];
  failed: string[];
  names: string[];
  problems: string[];
}
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */
export function assessTap(run: TapRun, expected?: readonly string[], target?: FailureTarget): TapResult {
  throw new Error("R10-01 尚未实现严格 TAP 判决");
}
