// npm test 的入口(g-group#2538):跑 node --test,并要求真的跑了用例。
// node --test 的 glob 一个文件都没匹配到时退出码也是 0,输出 "# tests 0";glob 写错或测试没被发现,CI 照样绿。
// 这里用 TAP 顶层汇总行判(R4-02:"# tests N" 把 skip/todo 也算进去,不能证明有用例真的执行):
//   node --test 自己失败 → 失败;读不到 "# tests" 或 "# pass" → 失败;实际执行通过的数量(# pass)为 0 → 失败;
//   有任何 skip / todo / cancelled → 失败(它们不能顶替实际执行的用例,也不该提交;G-TAUTO 也拒 skip/only)。
// 只核对数量,不推导产品行为覆盖。
//   node scripts/gates/test-runner.ts "packages/**/*.test.ts" "scripts/gates/*.test.ts"
import { spawnSync } from "node:child_process";

/** TAP 顶层汇总行 "# <key> N"(不缩进);子测试的汇总有缩进,不算。读不到给 undefined。 */
export function summary(tap: string, key: string): number | undefined {
  let n: number | undefined;
  const re = new RegExp(`^# ${key} (\\d+)\\s*$`);
  for (const line of tap.split("\n")) {
    const m = re.exec(line);
    if (m) n = Number(m[1]);
  }
  return n;
}
export const countTests = (tap: string) => summary(tap, "tests");
/** 判定:返回 undefined = 通过,否则返回不通过的原因 */
export function verdict(tap: string): string | undefined {
  const tests = countTests(tap), pass = summary(tap, "pass");
  if (tests === undefined || pass === undefined) return "输出里没有 \"# tests N\" / \"# pass N\" 汇总行,不算通过";
  if (tests === 0) return "跑了 0 条用例,不算通过";
  const notRun = (["skipped", "todo", "cancelled"] as const).map((k) => [k, summary(tap, k) ?? 0] as const).filter(([, n]) => n > 0);
  if (pass === 0 || notRun.length) return `没有实际执行足够的用例:通过 ${pass} 条${notRun.map(([k, n]) => `,${k} ${n} 条`).join("")};skip/todo/cancelled 不能顶替实际执行,不算通过`;
  return undefined;
}

if (import.meta.main) {
  const globs = process.argv.slice(2);
  if (globs.length === 0) { console.error("test-runner:没有给测试文件 glob"); process.exit(2); }
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...globs], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.error) { console.error(`test-runner:node --test 没能运行:${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
  const why = verdict(r.stdout ?? "");
  if (why) { console.error(`test-runner:${why}(glob:${globs.join(" ")})`); process.exit(1); }
  console.error(`test-runner:实际执行并通过 ${summary(r.stdout ?? "", "pass")} 条用例`);
}
