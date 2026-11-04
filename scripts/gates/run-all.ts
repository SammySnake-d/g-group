// 门禁入口。
//   node scripts/gates/run-all.ts [--base origin/main] [--branch <name>] [--local]
//   node scripts/gates/run-all.ts --self-test      每个门禁:合规样例必须放行,违规样例必须拦下
//   node scripts/gates/run-all.ts --hash [--branch <name>]   打印审查要钉住的内容 hash
import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { ALL_GATES, LOCAL_GATES } from "./gates.ts";
import { ctxFromGit, runGates } from "./lib.ts";
import { selfTest } from "./selftest.ts";

const { values: a } = parseArgs({
  options: {
    base: { type: "string" }, branch: { type: "string" },
    local: { type: "boolean" }, "self-test": { type: "boolean" }, hash: { type: "boolean" },
  },
  strict: true,
});
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

if (a["self-test"]) process.exit(selfTest() ? 0 : 1);

const branch = a.branch ?? (process.env.GITHUB_HEAD_REF || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
const base = a.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
const ctx = ctxFromGit(root, base, branch);

if (a.hash) { console.log(ctx.contentHash()); process.exit(0); }

const gates = a.local ? [...ALL_GATES, ...LOCAL_GATES] : ALL_GATES;
console.log(`base=${base} branch=${branch} HEAD=${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()} 改动 ${ctx.changed.length} 个文件 收据=${ctx.receipt ? ctx.receiptPath : "无"}`);
const results = runGates(ctx, gates);
for (const r of results) {
  console.log(`${r.problems.length ? "✗" : "✓"} ${r.gate.id}  ${r.gate.rule}`);
  for (const pr of r.problems) console.log(`    - ${pr.msg}`);
}
if (!a.local) console.log("(G-PROVENANCE 需要本机会话与群聊记录,CI 不跑;合并只走 scripts/merge.sh,它带 --local)");
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
