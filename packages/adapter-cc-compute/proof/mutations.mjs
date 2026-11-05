// 行为变异校准(R-05 阳性埋雷):对 adapter-cc-compute 的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。路径相对本包根目录。
// 用法: node packages/adapter-cc-compute/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["M01 brief 放行 memory 等额外字段", "src/brief.ts", "if (extra.length) return refuse(`brief", "if (false) return refuse(`brief"],
  ["M02 brief 放行明文凭据", "src/brief.ts", "if (credentialRefs.some((c) => !CREDENTIAL_REF.test(c)))", "if (false)"],
  ["M03 --allowedTools 不按 brief.tools", "src/cli.ts", '"--allowedTools", allowedTools(brief).join(","),', '"--allowedTools", ["Read", "Write", "Edit", "Bash", REPORT_TOOL].join(","),'],
  ["M04 没有 milestone 就不报 completed", "src/adapter.ts", "if (!st.blockedOpen) emit(", 'if (!st.blockedOpen && round.events.some((e) => e.kind === "milestone")) emit('],
  ["M05 非零退出也报 completed", "src/events.ts", "if (exit.code === 0 && exit.signal === null && result?.success) {", "if (result?.success) {"],
  ["M06 stop 未等进程结束就报 stopped", "src/adapter.ts", "round.stopRequested = true;", 'round.stopRequested = true;\n      emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null });'],
  ["M07 快照缺 constraintVer 放行", "src/brief.ts", "if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse(", "if (false) return refuse("],
  ["M08 handoff 不写进首个提示", "src/cli.ts", "parts.push(`[交接快照]", "void (`[交接快照]"],
  ["M09 env 继承宿主进程环境(带明文)", "src/cli.ts", "    ...hostEnv,", "    ...process.env,\n    ...hostEnv,"],
  ["M10 --tools 不按 brief.tools", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", "default",'],
  ["M11 blocked 未解除也报 completed", "src/adapter.ts", "if (!st.blockedOpen) emit(", "emit("],
  ["M12 被拒收的汇报也产出事件", "src/events.ts", "        if (b.is_error === true) {", "        if (false) {"],
  ["M13 stop 不升级 SIGKILL", "src/adapter.ts", 'signalGroup(pgid, "SIGKILL"); killed = true;', "killed = true;"],
  ["M14 handoff 不列进装配清单", "src/cli.ts", 'sections.push({ name: "handoff",', 'void ({ name: "handoff",'],
  ["M15 resume 不带 CLI 会话号", "src/cli.ts", '...(resumeSession ? ["--resume", resumeSession] : []),', ""],
  // 以下对应 Codex 首轮 reviews/feat-cc-compute.md F-01–F-04
  ["M16 F-01 brief.tools 放行 default 等非内置名", "src/brief.ts", "if (unknown.length) return refuse(", "if (false) return refuse("],
  ["M17 F-01 空集时 --tools 给 default(Codex 存活变异 M33-empty-default)", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", brief.tools.length ? brief.tools.join(",") : "default",'],
  ["M18 F-01 不核对 CLI init 的实际挂载清单", "src/adapter.ts", "if (over.length && round.fault === undefined) {", "if (false) {"],
  ["M19 F-02 忽略 Compute 汇报的 failed", "src/events.ts", "if (facts.reportedFailure !== undefined) return fail(", "if (false) return fail("],
  ["M20 F-02 result 行不看 is_error", "src/events.ts", 'success: m.subtype === "success" && m.is_error !== true,', 'success: m.subtype === "success",'],
  ["M21 F-02 被拒收的 blocked 不阻止 completed", "src/adapter.ts", 'if (s.kind === "blocked" || s.kind === "failed") round.rejectedStop = reason;', ""],
  ["M22 F-03 CLI 不自成进程组", "src/adapter.ts", "detached: true", "detached: false"],
  ["M23 F-03 收尾不回收进程组", "src/adapter.ts", "const empty = await reapGroup(round.pgid, grace);", "const empty = true;"],
  ["M24 F-03 stop 只对直接子进程发 SIGTERM", "src/adapter.ts", "      await reapGroup(round.pgid, grace);\n      await round.done;", '      round.child.kill("SIGTERM");\n      await round.done;'],
  ["M25 F-04 MCP 服务器不校验 schema", "mcp/report-mcp.mjs", "const errs = reportErrors(a);", "const errs = [];"],
  ["M26 F-04 适配器不做第二道 schema 校验", "src/events.ts", "const errors = reportErrors(input);", "const errors: string[] = [];"],
  ["M27 F-04 needs 只查真假不查类型", "src/report-schema.ts", "if (a.needs !== undefined && !nonEmpty(a.needs))", "if (a.needs !== undefined && !a.needs)"],
  ["M28 F-04 stage 只查真假不查类型", "src/report-schema.ts", "if (a.stage !== undefined && !nonEmpty(a.stage))", "if (a.stage !== undefined && !a.stage)"],
  ["M29 F-04 constraintVer 不校验", "src/report-schema.ts", "if (a.constraintVer !== undefined && !(Number.isInteger(a.constraintVer)", "if (false && !(Number.isInteger(a.constraintVer)"],
  ["M30 F-04 kind 不查枚举", "src/report-schema.ts", 'if (typeof a.kind !== "string" || !REPORT_KINDS.includes(a.kind)) errs.push("kind 非法");', ""],
  ["M31 F-04 放行未知字段", "src/report-schema.ts", "if (extra.length) errs.push(", "if (false) errs.push("],
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
  const f = path.join(d, file);
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
