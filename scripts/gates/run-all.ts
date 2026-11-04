// 门禁命令行入口。
//   node scripts/gates/run-all.ts [--repo DIR] [--base REF] [--branch NAME] [--local]
//   node scripts/gates/run-all.ts --hash [--repo DIR] [--branch NAME]     打印审查要钉住的内容 hash
//   node scripts/gates/run-all.ts --self-test                              对真实命令行入口跑双侧样例
// CI 里由 trusted-gates.yml 用 main 上的这份代码检查 PR(--repo 指向 PR 检出目录)。
import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { ALL_GATES, LOCAL_GATES } from "./gates.ts";
import { ctxFromGit, runGates } from "./lib.ts";

const { values: a } = parseArgs({
  options: {
    repo: { type: "string" }, base: { type: "string" }, branch: { type: "string" },
    local: { type: "boolean" }, "self-test": { type: "boolean" }, hash: { type: "boolean" },
  },
  strict: true,
});

if (a["self-test"]) {
  const { selfTest } = await import("./selftest.ts");
  process.exit(selfTest() ? 0 : 1);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: a.repo ?? process.cwd(), encoding: "utf8" }).trim();
const branch = a.branch ?? (process.env.GITHUB_HEAD_REF || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
const base = a.base ?? "origin/main";
const ctx = ctxFromGit(root, base, branch);

if (a.hash) {
  console.log(ctx.contentHash());
  process.exit(0);
}

const gates = a.local ? [...ALL_GATES, ...LOCAL_GATES] : ALL_GATES;
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
console.log(`base=${base} branch=${branch} HEAD=${head} 受检文件 ${ctx.changed.length} 个 收据=${ctx.receipt ? ctx.receiptPath : "无"} 门禁 ${gates.length} 个`);
const results = runGates(ctx, gates);
for (const r of results) {
  console.log(`${r.problems.length ? "✗" : "✓"} ${r.gate.id}  ${r.gate.rule}`);
  for (const pr of r.problems) console.log(`    - ${pr.msg}`);
}
if (results.length !== gates.length) {
  console.log("✗ 执行器跑的门禁数与注册数不一致");
  process.exit(1);
}
console.log(`CONTENT_HASH=${ctx.contentHash()}`);
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
