// 红基线占位(g-group#2538):还没实现"0 条用例判失败",原样转给 node --test。
import { spawnSync } from "node:child_process";
export function countTests(_tap: string): number | undefined { return undefined; }
if (import.meta.main) {
  const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
