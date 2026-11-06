// 变异判定(R4-01):一个变异算"被发现",必须是某条自检用例在正常执行下、因为目标门禁的结论变了而失败。
// 自检对每条用例输出一行结构化结果(CASE_MARK + JSON);用例自身出错、超时、没给结果、命令行崩溃都单独分类,不算发现。
// 本文件只做解析与判定,不依赖 selftest.ts / mutation.ts。

/** ok=通过;verdict=正常执行但门禁结论与预期不符;side=副作用检查失败;其余是执行故障,不算发现 */
export type Kind = "ok" | "verdict" | "side" | "error" | "timeout" | "no-result" | "crash";
export interface CaseResult {
  name: string;
  pass: boolean;
  kind: Kind;
  /** 直接判定的用例(不建夹具仓库、不跑门禁命令行) */
  direct: boolean;
  expect: string | null;
  /** 门禁命令行退出码;直接判定的用例为 null */
  exit: number | null;
  /** 每个门禁的结论 */
  gates: Record<string, "✓" | "✗">;
  /** ✗ 的问题里出现了预期原因文字的门禁 */
  expectHit: string[];
  /** ✗ 的问题是"门禁自身出错"的门禁 */
  gateErrors: string[];
  why?: string;
}
export const CASE_MARK = "__GATE_CASE__";
/** 目标:门禁 id(G-RED 等);RUNNER = 执行器/命令行本身;DIRECT = 直接判定的用例(测试入口、判定函数) */
export const RUNNER = "RUNNER";
export const DIRECT = "DIRECT";

/** 从 run-all.ts 的输出读每个门禁的结论,以及哪些门禁的问题里出现了预期原因 */
export function parseGateOutput(out: string, expect: string | null): { gates: Record<string, "✓" | "✗">; expectHit: string[]; header: boolean } {
  const gates: Record<string, "✓" | "✗"> = {};
  const hit: string[] = [];
  let cur: string | undefined;
  for (const line of out.split("\n")) {
    const m = /^(✓|✗) (G-[A-Z]+) /.exec(line);
    if (m) { cur = m[2]!; gates[cur] = m[1] as "✓" | "✗"; continue; }
    if (cur && expect && gates[cur] === "✗" && line.startsWith("    - ") && line.includes(expect) && !hit.includes(cur)) hit.push(cur);
  }
  return { gates, expectHit: hit, header: /受检文件 \d+ 个.* 门禁 \d+ 个/.test(out) };
}

export function parseCases(out: string): CaseResult[] {
  const res: CaseResult[] = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf(CASE_MARK);
    if (i < 0) continue;
    try { res.push(JSON.parse(line.slice(i + CASE_MARK.length)) as CaseResult); } catch { /* 残缺行不算 */ }
  }
  return res;
}

/** 这条用例结果能不能作为"目标被发现"的证据;能就返回判因,不能返回 undefined */
export function evidence(_target: string[], _base: CaseResult | undefined, mut: CaseResult): string | undefined {
  // 红基线占位:任何失败都算发现(即 R4-01 指出的旧口径)
  return mut.pass ? undefined : `用例「${mut.name}」失败`;
}

export function killedBy(target: string[], base: Map<string, CaseResult>, results: CaseResult[]): { case: string; ev: string } | undefined {
  for (const r of results) {
    const ev = evidence(target, base.get(r.name), r);
    if (ev) return { case: r.name, ev };
  }
  return undefined;
}
