// 行为变异校准(R-05 阳性埋雷):对 adapter-cc-compute 的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。
// 用法: node packages/adapter-cc-compute/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["M01 brief 放行 memory 等额外字段", "brief.ts", "if (extra.length) return refuse(`brief", "if (false) return refuse(`brief"],
  ["M02 brief 放行明文凭据", "brief.ts", "if (credentialRefs.some((c) => !CREDENTIAL_REF.test(c)))", "if (false)"],
  ["M03 --allowedTools 不按 brief.tools", "cli.ts", '"--allowedTools", allowedTools(brief).join(","),', '"--allowedTools", ["Read", "Write", "Edit", "Bash", REPORT_TOOL].join(","),'],
  ["M04 没有 milestone 就不报 completed", "adapter.ts", "if (!st.blockedOpen) emit(", 'if (!st.blockedOpen && round.events.some((e) => e.kind === "milestone")) emit('],
  ["M05 非零退出也报 completed", "events.ts", "if (exit.code === 0 && exit.signal === null && result?.success)", "if (result?.success)"],
  ["M06 stop 未等进程结束就报 stopped", "adapter.ts", "round.stopRequested = true;", 'round.stopRequested = true;\n      emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null });'],
  ["M07 快照缺 constraintVer 放行", "brief.ts", "if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse(", "if (false) return refuse("],
  ["M08 handoff 不写进首个提示", "cli.ts", "parts.push(`[交接快照]", "void (`[交接快照]"],
  ["M09 env 继承宿主进程环境(带明文)", "cli.ts", "    ...hostEnv,", "    ...process.env,\n    ...hostEnv,"],
  ["M10 --tools 不按 brief.tools", "cli.ts", '"--tools", brief.tools.join(","),', '"--tools", "default",'],
  ["M11 blocked 未解除也报 completed", "adapter.ts", "if (!st.blockedOpen) emit(", "emit("],
  ["M12 被拒收的汇报也产出事件", "events.ts", "if (b.is_error === true) continue;", ""],
  ["M13 stop 不升级 SIGKILL", "adapter.ts", 'if (round.child) child.kill("SIGKILL");', ""],
  ["M14 handoff 不列进装配清单", "cli.ts", 'sections.push({ name: "handoff",', 'void ({ name: "handoff",'],
  ["M15 resume 不带 CLI 会话号", "cli.ts", '...(resumeSession ? ["--resume", resumeSession] : []),', ""],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=20000", ...files], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  const named = (re) => [...(r.stdout ?? "").matchAll(re)].map((m) => m[1]).filter((n) => !/^\/|\.test\.ts$/.test(n));
  return { code: r.status, failed: named(/^not ok \d+ - (.+)$/gm), passed: named(/^ok \d+ - (.+)$/gm) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compute-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = run(copy("clean"));
console.log(`${clean.code === 0 && clean.failed.length === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0 || clean.failed.length) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const hits = src.split(from).length - 1;
  if (hits !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
