// 仅供变异校准使用:严格判读 Node 的扁平 TAP,不是产品运行时接口。
export interface TapRun {
  out: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}
export interface FailureTarget { name: string; code: string; errorName?: string }
export interface TapResult {
  valid: boolean;
  killed: boolean;
  passed: string[];
  failed: string[];
  names: string[];
  problems: string[];
}
// Node --test 的本包是扁平具名测试;不支持的 TAP 形态显式拒收,不猜通过。
export function assessTap(run: TapRun, expected?: readonly string[], target?: FailureTarget): TapResult {
  const problems: string[] = [];
  const rows = [...run.out.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm)];
  const plans = [...run.out.matchAll(/^1\.\.(\d+)$/gm)];
  const summary = (key: string) => {
    const matches = [...run.out.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
    return matches.length === 1 ? Number(matches[0]![1]) : -1;
  };
  const total = plans.length === 1 ? Number(plans[0]![1]) : -1;
  const names = rows.map((m) => m[3]!.replace(/\s#\s*(?:SKIP|TODO)\b.*$/i, ""));
  const passed = rows.filter((m) => m[1] === "ok").map((m) => m[3]!);
  const failed = rows.filter((m) => m[1] === "not ok").map((m) => m[3]!);
  if (total <= 0 || rows.length !== total || summary("tests") !== total || summary("suites") !== 0) problems.push("计划/测试总数/扁平结构不符");
  if (summary("pass") !== passed.length || summary("fail") !== failed.length) problems.push("通过/失败汇总不符");
  if (summary("skipped") !== 0 || summary("todo") !== 0 || summary("cancelled") !== 0) problems.push("跳过/待办/取消非零或缺失");
  if (rows.some((m) => /\s#\s*(?:SKIP|TODO)\b/i.test(m[3]!))) problems.push("结果行含跳过/待办指令");
  if (names.some((name) => /^\/|\.test\.[cm]?[jt]s$/.test(name))) problems.push("文件级失败");
  if (rows.some((m, i) => Number(m[2]) !== i + 1) || new Set(names).size !== names.length) problems.push("序号或具名唯一性不符");
  if (expected && (names.length !== expected.length || names.some((name, i) => name !== expected[i]))) problems.push("具名测试与基线不一致");
  if (run.timedOut || run.signal !== null || run.code !== (failed.length ? 1 : 0)) problems.push("超时/信号/退出码不符");
  let matched = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row[1] !== "not ok") continue;
    const start = row.index! + row[0].length;
    const rest = run.out.slice(start, rows[i + 1]?.index ?? run.out.length);
    const detail = rest.split(/^# Subtest:|^1\.\./m)[0]!;
    const value = (key: string) => new RegExp(`^  ${key}: ['"]([^'"\\n]+)['"]$`, "m").exec(detail)?.[1];
    if (value("failureType") !== "testCodeFailure") problems.push(`非测试代码失败:${row[3]}`);
    if (row[3] === target?.name && value("code") === target.code && (!target.errorName || value("name") === target.errorName)) matched = true;
  }
  if (/^Bail out!/m.test(run.out)) problems.push("TAP 提前结束");
  const valid = problems.length === 0;
  return { valid, killed: valid && matched, passed, failed, names, problems };
}
