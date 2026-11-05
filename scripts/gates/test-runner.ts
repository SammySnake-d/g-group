// npm test 的入口(g-group#2538):跑 node --test,并要求真的跑了用例。
// node --test 的 glob 一个文件都没匹配到时退出码也是 0,输出 "# tests 0";glob 写错或测试没被发现,CI 照样绿。
// 这里用 TAP 汇总行判:node --test 自己失败 → 失败;读不到汇总行或用例数为 0 → 失败。
//   node scripts/gates/test-runner.ts "packages/**/*.test.ts" "scripts/gates/*.test.ts"
import { spawnSync } from "node:child_process";

/** TAP 顶层汇总行 "# tests N"(不缩进);子测试的汇总有缩进,不算。读不到给 undefined。 */
export function countTests(tap: string): number | undefined {
  let n: number | undefined;
  for (const line of tap.split("\n")) {
    const m = /^# tests (\d+)\s*$/.exec(line);
    if (m) n = Number(m[1]);
  }
  return n;
}

if (import.meta.main) {
  const globs = process.argv.slice(2);
  if (globs.length === 0) { console.error("test-runner:没有给测试文件 glob"); process.exit(2); }
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...globs], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.error) { console.error(`test-runner:node --test 没能运行:${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
  const n = countTests(r.stdout ?? "");
  if (n === undefined) { console.error("test-runner:输出里没有 \"# tests N\" 汇总行,不算通过"); process.exit(1); }
  if (n === 0) { console.error(`test-runner:跑了 0 条用例,不算通过(glob:${globs.join(" ")})`); process.exit(1); }
  console.error(`test-runner:跑了 ${n} 条用例`);
}
