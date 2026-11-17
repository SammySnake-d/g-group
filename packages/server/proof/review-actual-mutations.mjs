// 审查按实际模型判门禁(AC-26)的变异校准:按验收文档 AC-26「坏实现」列逐个注入故障,
// 每个变异必须让指定的具名测试失败(断言失败;加载失败、语法错误不算杀死)。
// 用法(仓库根目录、已装依赖的克隆;就地改文件,每个变异后还原):node packages/server/proof/review-actual-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const HOST = "packages/server/src/host.ts";
const REVIEW = "packages/server/src/review.ts";
const TEST = "packages/server/src/review-actual.test.ts";

const T = {
  same: "AC-26 审查 Compute 回报的实际模型与生产厂商同源 → 不算合规通过,记没做成并交给提出者豁免",
  unknown: "AC-26 实际审查模型里有一个认不出厂商(unknown)→ 同样不放行",
  ok: "AC-26 回报的实际模型合格 → 以实际模型判门禁,审查记录里记实际模型",
  pure: "reviewModelProblem:每个实际模型都要认得出厂商且不在生产厂商里;有问题返回说明,合格返回 null",
};

/** [编号 说明, 文件, 原文, 替换, 应失败的具名测试] */
const mutants = [
  ["A01 忽略回报的实际模型,按下发的模型判", HOST, "const actual = ev.models?.length ? [...ev.models] : [rv.model];", "const actual = [rv.model];", T.same],
  ["A02 只查第一个实际模型", REVIEW, "  for (const m of models) {\n    const v = vendorOf(m);", "  for (const m of models.slice(0, 1)) {\n    const v = vendorOf(m);", T.unknown],
  ["A03 认不出厂商的实际模型放行", REVIEW, "    if (v === \"unknown\") return `实际审查模型 ${m} 认不出研发厂商`;\n", "", T.pure],
  ["A04 实际模型不合格仍推进", HOST, "    if (bad) {\n      end(\"failed\", bad);", "    if (false) {\n      end(\"failed\", bad);", T.same],
  ["A05 审查记录不记实际模型", HOST, "    if (actual[0] !== rv.model) run(this.db, \"UPDATE gg_reviews SET model = ? WHERE compute_id = ?\", actual[0]!, rv.compute_id);\n", "", T.ok],
  ["A06 没回报任何模型算合格", REVIEW, "  if (models.length === 0) return \"没有回报任何实际审查模型\";\n", "", T.pure],
  ["A07 同源判断只看配置的审查模型", REVIEW, "    if (producers.has(v)) return", "    if (false) return", T.same],
];

function runTests(file) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: root, encoding: "utf8", timeout: 600_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, out, failed: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()), passed: [...out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim()) };
}
let success = true;
const b = runTests(TEST);
const baseOk = b.status === 0 && b.failed.length === 0;
console.log(`${baseOk ? "PASS" : "FAIL"} 基线 ${TEST}: 通过 ${b.passed.length} 失败 ${b.failed.length}`);
if (!baseOk) success = false;
for (const [name, rel, from, to, expected] of mutants) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, "utf8");
  if (original.split(from).length !== 2) {
    console.log(`FAIL ${name}: 注入点不是唯一一处`);
    success = false;
    continue;
  }
  fs.writeFileSync(file, original.replace(from, to));
  try {
    const r = runTests(TEST);
    const loadFail = r.failed.some((n) => n.endsWith(".test.ts")) || /SyntaxError|ERR_MODULE_NOT_FOUND|TransformError/.test(r.out);
    const killed = r.status !== 0 && r.failed.includes(expected) && !loadFail;
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? `被「${expected}」杀死;同时失败 ${r.failed.length} 条` : `exit=${r.status} 失败=${JSON.stringify(r.failed)} 加载失败=${loadFail}`}`);
    if (!killed) success = false;
  } finally {
    fs.writeFileSync(file, original);
  }
}
console.log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
