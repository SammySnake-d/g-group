// 行为变异校准(R-05 阳性埋雷):对 adapter-cc-compute 的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败,且全部测试都执行完(文件级失败、超时、强杀、部分执行都不算杀死)。原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。路径相对本包根目录。
// 用法: node packages/adapter-cc-compute/proof/mutations.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["M01 brief 放行 memory 等额外字段", "src/brief.ts", "if (extra.length) return refuse(`brief", "if (false) return refuse(`brief"],
  ["M02 brief 放行明文凭据", "src/brief.ts", "if (credentialRefs.some((c) => !CREDENTIAL_REF.test(c)))", "if (false)"],
  ["M03 --allowedTools 不按 brief.tools", "src/cli.ts", '"--allowedTools", allowedTools(brief).join(","),', '"--allowedTools", ["Read", "Write", "Edit", "Bash", REPORT_TOOL].join(","),'],
  ["M04 没有 milestone 就不报 completed", "src/adapter.ts", 'if (terminal.kind !== "paused-blocked") emit(', 'if (terminal.kind !== "paused-blocked" && (terminal.kind !== "completed" || round.events.some((e) => e.kind === "milestone"))) emit('],
  ["M05 非零退出也报 completed", "src/events.ts", "if (!(exit.code === 0 && exit.signal === null && result?.success)) {", "if (!result?.success) {"],
  ["M06 stop 等主进程退出后才报 stopped(不是 mirasim 的立即报)", "src/adapter.ts", '      round.terminal = "stopped";\n      round.finished = true;', '      await round.done;\n      round.terminal = "stopped";\n      round.finished = true;'],
  ["M07 快照缺 constraintVer 放行", "src/brief.ts", "if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse(", "if (false) return refuse("],
  ["M08 handoff 不写进首个提示", "src/cli.ts", "parts.push(`[交接快照]", "void (`[交接快照]"],
  ["M09 env 继承宿主进程环境(带明文)", "src/cli.ts", "    ...hostEnv,", "    ...process.env,\n    ...hostEnv,"],
  ["M10 --tools 不按 brief.tools", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", "default",'],
  ["M11 已受理 blocked 不停在受阻", "src/events.ts", 'if (facts.pausedBlocked) return { kind: "paused-blocked" };', ""],
  ["M12 被拒收的汇报也产出事件", "src/events.ts", "        if (b.is_error === true) {", "        if (false) {"],
  ["M13 到期不对进程组发 SIGKILL", "src/adapter.ts", 'const timer = setTimeout(() => signalGroup(round.pid, "SIGKILL"), reapForceMs);', "const timer = setTimeout(() => {}, reapForceMs);"],
  ["M14 handoff 不列进装配清单", "src/cli.ts", 'sections.push({ name: "handoff",', 'void ({ name: "handoff",'],
  ["M15 resume 不带 CLI 会话号", "src/cli.ts", '...(resumeSession ? ["--resume", resumeSession] : []),', ""],
  ["M16 F-01 brief.tools 放行 default 等非内置名", "src/brief.ts", "if (unknown.length) return refuse(", "if (false) return refuse("],
  ["M17 F-01 空集时 --tools 给 default", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", brief.tools.length ? brief.tools.join(",") : "default",'],
  ["M18 F-01 不核对 CLI init 的实际挂载清单", "src/adapter.ts", "if (over.length) { violate(", "if (false) { violate("],
  ["M19 F-02 忽略 Compute 汇报的 failed", "src/events.ts", "if (facts.reportedFailure !== undefined) return fail(", "if (false) return fail("],
  ["M20 F-02 result 行不看 is_error", "src/events.ts", 'success: m.subtype === "success" && m.is_error !== true,', 'success: m.subtype === "success",'],
  ["M21 F-02 被拒收的 blocked 不记为未解决", "src/adapter.ts", 'if (s.kind === "blocked" || s.kind === "failed") st.unresolved = [...st.unresolved, rec];', ""],
  ["M22 CLI 不自成进程组", "src/adapter.ts", "detached: !IS_WINDOWS", "detached: false"],
  ["M23 CLI 正常结束后仍对进程组发 SIGTERM(mirasim 不发)", "src/adapter.ts", "      round.child = null;\n", '      round.child = null;\n      signalGroup(round.pid, "SIGTERM");\n'],
  ["M24 初始 SIGTERM 发给进程组而不是只发主进程", "src/adapter.ts", 'try { p.kill("SIGTERM"); } catch { /* 已退出 */ }', 'signalGroup(round.pid, "SIGTERM");'],
  ["M25 F-04 MCP 服务器不校验 schema", "mcp/report-mcp.mjs", "const errs = reportErrors(a);", "const errs = [];"],
  ["M26 F-04 适配器不做第二道 schema 校验", "src/events.ts", "const errors = reportErrors(input);", "const errors: string[] = [];"],
  ["M27 F-04 needs 只查真假不查类型", "src/report-schema.ts", "if (a.needs !== undefined && !nonEmpty(a.needs))", "if (a.needs !== undefined && !a.needs)"],
  ["M28 F-04 stage 只查真假不查类型", "src/report-schema.ts", "if (a.stage !== undefined && !nonEmpty(a.stage))", "if (a.stage !== undefined && !a.stage)"],
  ["M29 F-04 constraintVer 不校验", "src/report-schema.ts", "if (a.constraintVer !== undefined && !(Number.isInteger(a.constraintVer)", "if (false && !(Number.isInteger(a.constraintVer)"],
  ["M30 F-04 kind 不查枚举", "src/report-schema.ts", 'if (typeof a.kind !== "string" || !REPORT_KINDS.includes(a.kind)) errs.push("kind 非法");', ""],
  ["M31 F-04 放行未知字段", "src/report-schema.ts", "if (extra.length) errs.push(", "if (false) errs.push("],
  // 以下对应 Codex 第二轮 RR-01–RR-05;M06/M13/M22–M24/M34/M39–M42/M44 按 g-group#2309 对齐 mirasim 改写;M13/M23/M24/M40 第三轮按 z2 实际做法再改
  ["M32 RR-01 合规 started 清掉被拒收的 blocked(审查存活变异)", "src/adapter.ts", 'if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);', 'if (r.kind === "blocked" || r.kind === "failed" || r.kind === "started") st.unresolved = [];'],
  ["M33 RR-01 合规 completed 清掉被拒收的 blocked", "src/adapter.ts", 'if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);', 'if (r.kind === "blocked" || r.kind === "failed" || r.kind === "completed") st.unresolved = [];'],
  ["M34 RR-01 受理 blocked 后不对进程组 SIGSTOP", "src/adapter.ts", '      signalGroup(round.pid, "SIGSTOP");', ""],
  ["M35 RR-01 resume 不解除被拒收的受阻", "src/adapter.ts", "      st.unresolved = [];", ""],
  ["M36 RR-02 不要求 host MCP connected", "src/events.ts", 'if (host?.status !== "connected") return', "if (false) return"],
  ["M37 RR-02 不要求工具清单里有 report_progress", "src/events.ts", "if (!m.tools.includes(REPORT_TOOL)) return", "if (false) return"],
  ["M38 RR-02 tools 元素不查类型", "src/events.ts", 'if (!m.tools.every((t) => typeof t === "string")) return', "if (false) return"],
  ["M39 信号只发给进程本身、不发给进程组", "src/procgroup.ts", "process.kill(-pid, sig);", "process.kill(pid, sig);"],
  ["M40 stopped 不带 main-then-group 范围", "src/adapter.ts", 'scope: "main-then-group", violations: [...round.violations] });', 'scope: "process-group" as "main-then-group", violations: [...round.violations] });'],
  ["M41 RR-04 运行中也给快照", "src/adapter.ts", 'if (!r?.exited || !terminal) return refuse("not-quiescent");', ""],
  ["M42 RR-04 快照不等主进程退出(只看终态)", "src/adapter.ts", 'if (!r?.exited || !terminal) return refuse(', "if (!terminal) return refuse("],
  ["M43 RR-05 违规压过停止", "src/events.ts", "if (facts.stopRequested) return {", "if (facts.stopRequested && violations.length === 0) return {"],
  ["M44 升级间隔不按配置(写死 10 秒)", "src/adapter.ts", "const reapForceMs = options.reapForceMs ?? DEFAULT_REAP_FORCE_MS;", "const reapForceMs = DEFAULT_REAP_FORCE_MS;"],
  ["M45 RR-05 违规不留痕", "src/adapter.ts", "    round.violations.push(msg);", ""],
  // 以下对应第三轮:停止语义更正为 mirasim z2 的实际做法、R3-01–R3-03
  ["M46 主进程先退出也不取消组 SIGKILL", "src/adapter.ts", '    p.once("exit", () => clearTimeout(timer));', ""],
  ["M47 R3-01 stop 后不封存这一轮", "src/adapter.ts", "      round.halted = true;\n      // 冻结的进程组", "      // 冻结的进程组"],
  ["M48 R3-02 空白续接先杀掉冻结的进程组再报错", "src/adapter.ts", '      if (!text.trim()) return refuse("续接的内容不能为空");', '      if (!text.trim()) { if (st.round && !st.round.exited) signalGroup(st.round.pid, "SIGKILL"); return refuse("续接的内容不能为空"); }'],
  ["M49 R3-03 init 前未认可的输出放行", "src/adapter.ts", 'if (pre.kind === "rejected") { violate(', "if (false) { violate("],
  ["M50 R3-03 init 前任何 system 帧都放行", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return", "true) return"],
];

// 不用 --test-timeout:在 node --test <file> 下它限制的是整个文件,文件超过上限会被整体取消(部分执行)。
// 单条测试由测试文件自己的 within() 限时,整个文件由测试文件内 240 秒的看门狗限时,这里再加 TIMEOUT_MS 外层上限。
// RR-06:每个变异在自己的进程组里跑,有界超时;超时、被信号结束、或没有跑完全部测试都不算按名杀死。
// 只清理本变异副本目录下起的进程(命令行里带副本路径),不碰其它会话。
const TIMEOUT_MS = 360_000;
function reapDir(dir) {
  // 带上路径分隔符:否则 .../m4 会匹配到 .../m40 等别的变异副本,误杀它们的测试进程
  const needle = `${dir}${path.sep}`;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) > 1 && Number(m[1]) !== process.pid && m[2].includes(needle)) { try { process.kill(Number(m[1]), "SIGKILL"); } catch {} }
  }
}
function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, TIMEOUT_MS);
    // close 而非 exit:exit 可能先于 stdout 读完触发,TAP 输出会被截断
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reapDir(dir);
      const named = (re) => [...out.matchAll(re)].map((m) => m[1]).filter((n) => !/^\/|\.test\.ts$/.test(n));
      resolve({ code, signal, timedOut, out, failed: named(/^not ok \d+ - (.+)$/gm), passed: named(/^ok \d+ - (.+)$/gm) });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compute-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = await run(copy("clean"));
// 应有的测试条数取自 TAP 计划行 "1..N",不取原样副本自己的通过数,以免原样副本也被截断时基准跟着变小
const plan = Number(/^1\.\.(\d+)$/m.exec(clean.out ?? "")?.[1] ?? 0);
const total = plan;
const cleanOk = clean.code === 0 && !clean.timedOut && clean.failed.length === 0 && total > 0 && clean.passed.length === total;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红,计划 ${total} 条,退出码 ${clean.code}${clean.timedOut ? "(超时)" : ""}`);
if (!cleanOk) ok = false;
const CONCURRENCY = 4;
const results = new Array(M.length);
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= M.length) return;
    const [name, file, from, to] = M[i];
    const d = copy(`m${i}`);
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const hits = src.split(from).length - 1;
    if (hits !== 1) { results[i] = `✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`; continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const r = await run(d);
    const ran = r.passed.length + r.failed.length;
    let verdict;
    if (r.timedOut) verdict = `✗ ${name}:超时 ${TIMEOUT_MS}ms 被强杀,不计为杀死(已执行 ${ran}/${total})`;
    else if (r.signal) verdict = `✗ ${name}:测试进程被信号 ${r.signal} 结束,不计为杀死(已执行 ${ran}/${total})`;
    else if (ran !== total) verdict = `✗ ${name}:只执行了 ${ran}/${total} 条测试(部分执行),不计为杀死`;
    else if (r.failed.length === 0) verdict = `✗ ${name}:${r.passed.length} 绿 / 0 红,存活`;
    else verdict = `✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`;
    results[i] = verdict;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const line of results.filter(Boolean)) { console.log(line); if (!line.startsWith("✓")) ok = false; }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
