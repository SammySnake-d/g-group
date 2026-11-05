// 空壳(红提交):签名保留,实现见绿提交。
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳 */

export const IS_WINDOWS = process.platform === "win32";

export function signalGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  throw new Error("未实现");
}

export function groupAlive(pid: number | undefined): boolean {
  throw new Error("未实现");
}
