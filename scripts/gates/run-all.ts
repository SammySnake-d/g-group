// 门禁入口。
//   node scripts/gates/run-all.ts [--base origin/main] [--branch <name>] [--local]
//   node scripts/gates/run-all.ts --self-test      每个门禁:合规样例必须放行,违规样例必须拦下
//   node scripts/gates/run-all.ts --hash [--branch <name>]   打印审查要钉住的内容 hash
import { execFileSync } from "node:child_process";
import process from "node:process";
import { ALL_GATES, LOCAL_GATES } from "./gates.ts";
import { ctxFromGit, type Problem } from "./lib.ts";
import { selfTest } from "./selftest.ts";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

if (args.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

const branch = opt("--branch", process.env.GITHUB_HEAD_REF || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim())!;
const base = opt("--base", process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main")!;
const ctx = ctxFromGit(root, base, branch);

if (args.includes("--hash")) { console.log(ctx.contentHash()); process.exit(0); }

const gates = args.includes("--local") ? [...ALL_GATES, ...LOCAL_GATES] : ALL_GATES;
console.log(`base=${base} branch=${branch} 改动 ${ctx.changed.length} 个文件 收据=${ctx.receipt ? ctx.receiptPath : "无"}`);
const all: Problem[] = [];
for (const g of gates) {
  let probs: Problem[];
  try { probs = g.run(ctx); } catch (e) { probs = [{ gate: g.id, msg: `门禁自身出错:${(e as Error).message}` }]; }
  console.log(`${probs.length ? "✗" : "✓"} ${g.id}  ${g.rule}`);
  for (const pr of probs) console.log(`    - ${pr.msg}`);
  all.push(...probs);
}
if (!args.includes("--local")) console.log("(G-PROVENANCE 需要本机会话记录,CI 不跑;合并前用 --local 跑)");
process.exit(all.length ? 1 : 0);
