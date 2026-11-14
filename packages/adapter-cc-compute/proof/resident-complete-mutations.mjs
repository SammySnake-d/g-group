// 常驻适配器补齐(feat/resident-complete,AC-29 / AC-43 / AC-23 生产路径)的行为变异校准:
// 对 src/resident.ts、src/stop-confirm.ts 逐个注入单一故障,在隔离副本里跑本片 4 个测试文件
// (适配器 resident-isolation / resident-activity / resident-quiesce,宿主 server/src/resident-host),
// 每个变异都必须让至少一条具名测试按名字失败,且全部测试都执行完(超时、被信号结束、部分执行都不算杀死);原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。副本里 node_modules/@g-group/* 指向副本自己的 packages,宿主测试用的是被变异的适配器。
// 用法: node packages/adapter-cc-compute/proof/resident-complete-mutations.mjs(并发 1,云电脑上用 flock 排队)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/adapter-cc-compute/src/resident-isolation.test.ts",
  "packages/adapter-cc-compute/src/resident-activity.test.ts",
  "packages/adapter-cc-compute/src/resident-quiesce.test.ts",
  "packages/server/src/resident-host.test.ts",
];
const R = "packages/adapter-cc-compute/src/resident.ts";
const S = "packages/adapter-cc-compute/src/stop-confirm.ts";

const M = [
  // AC-29 隔离
  ["C01 能力声明去掉 isolation(宿主照旧拒收勾选能力)", R, "inSessionModelSwitch: cfg.inSessionModelSwitch, isolation: true });", "inSessionModelSwitch: cfg.inSessionModelSwitch });"],
  ["C02 spawn 不收 configDir/pluginDirs/mcpServers", R, '"effort", "configDir", "pluginDirs", "mcpServers"]);', '"effort"]);'],
  ["C03 不设 CLAUDE_CONFIG_DIR", R, "env: cliEnv(st.brief, st.id, cfg.hostEnv, st.iso.configDir)", "env: cliEnv(st.brief, st.id, cfg.hostEnv)"],
  ["C04 不给 --plugin-dir", R, '    ...pluginDirs.flatMap((d) => ["--plugin-dir", d]),\n', ""],
  ["C05 勾选 MCP 不并进 --mcp-config", R, "JSON.stringify(mcpConfigFor(st.iso, cfg.server))", "JSON.stringify(mcpConfigFor(NO_ISOLATION, cfg.server))"],
  ["C06 去掉 --bare(全局 skill 漏入)", R, '    "--bare",\n', ""],
  ["C07 每轮 init 不核对勾选", R, "if (!iso.ok) { violate(st, iso.reason); return; }", "if (false) { violate(st, iso.reason); return; }"],
  ["C08 started 不带实际加载清单", R, ", loaded: iso.loaded });", " });"],
  // AC-43 活动流
  ["A01 activity 不推送", R, "if (proc.sawInit && st.proc === proc && turn && !turn.finished && !turn.halted) {", "if (false) {"],
  ["A02 不带 --include-partial-messages", R, '    "--include-partial-messages",\n', ""],
  ["A03 判违规之后仍推活动", R, "turn && !turn.finished && !turn.halted) {", "turn && !turn.finished) {"],
  // AC-23 停止确认
  ["Q01 quiesce 直接返回确认", R, '      if (typeof computeId !== "string") return { ok: false, reason: "computeId 必须是字符串", remaining: [] };\n      if (typeof timeoutMs', '      return { ok: true, killed: 0 };\n      if (typeof timeoutMs'],
  ["Q02 不等 CLI 主进程退出", R, "const exited = proc.isExited || (await Promise.race(", "const exited = true || (await Promise.race("],
  ["Q03 停止时不记下后代(脱组的找不到)", R, "        if (!IS_WINDOWS && p.pid !== undefined && !p.isExited) p.tree = treeNow(p.pid);\n", ""],
  ["Q04 失败一轮后不结束常驻进程", R, "        if (!proc.expectedExit) {\n          proc.expectedExit = true;\n          reap(proc);\n        }\n", ""],
  ["Q05 停在受阻也做停止确认", R, '(t.kind === "blocked" && !st.stopped)', "false"],
  ["Q06 确认循环不关后代就回报", S, '    signalGroup(root, "SIGKILL");\n', "    return { ok: true, killed: 0 };\n"],
];

const TIMEOUT_MS = 420_000;
function reapDir(dir) {
  const needle = `${dir}${path.sep}`;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) > 1 && Number(m[1]) !== process.pid && m[2].includes(needle)) { try { process.kill(Number(m[1]), "SIGKILL"); } catch {} }
  }
}
function run(dir) {
  return new Promise((resolve) => {
    const tmpdir = path.join(dir, ".tmp");
    fs.mkdirSync(tmpdir, { recursive: true });
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmpdir } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reapDir(tmpdir);
      const named = (re) => [...out.matchAll(re)].map((m) => m[1]).filter((n) => !/^\/|\.test\.ts$/.test(n));
      resolve({ code, signal, timedOut, out, failed: named(/^\s*not ok \d+ - (.+)$/gm), passed: named(/^\s*ok \d+ - (.+)$/gm) });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-rc-mut-"));
/** 隔离副本:packages(不含 proof)+ 根 package.json;node_modules 里第三方包指回仓库,@g-group/* 指向副本自己的 packages */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(d, "package.json"));
  const nm = path.join(d, "node_modules");
  fs.mkdirSync(path.join(nm, "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) if (e !== "@g-group") fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(nm, e));
  for (const p of fs.readdirSync(path.join(d, "packages"))) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(nm, "@g-group", p));
  return d;
};
let ok = true;
const clean = await run(copy("clean"));
const total = [...clean.out.matchAll(/^1\.\.(\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0);
const cleanOk = clean.code === 0 && !clean.timedOut && clean.failed.length === 0 && total > 0 && clean.passed.length === total;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红,计划 ${total} 条,退出码 ${clean.code}${clean.timedOut ? "(超时)" : ""}`);
if (!cleanOk) { ok = false; for (const f of clean.failed) console.log(`  原样副本失败:${f}`); }
console.log("并发 1");
for (const [i, [name, file, from, to]] of M.entries()) {
  const d = copy(`m${i}`);
  const f = path.join(d, file);
  const src = fs.readFileSync(f, "utf8");
  const hits = src.split(from).length - 1;
  let verdict;
  if (hits !== 1) verdict = `✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`;
  else {
    fs.writeFileSync(f, src.replace(from, to));
    const r = await run(d);
    const ran = r.passed.length + r.failed.length;
    if (r.timedOut) verdict = `✗ ${name}:超时被强杀,不计为杀死(已执行 ${ran}/${total})`;
    else if (r.signal) verdict = `✗ ${name}:测试进程被信号 ${r.signal} 结束,不计为杀死(已执行 ${ran}/${total})`;
    else if (ran !== total) verdict = `✗ ${name}:只执行了 ${ran}/${total} 条测试(部分执行),不计为杀死`;
    else if (r.failed.length === 0) verdict = `✗ ${name}:${r.passed.length} 绿 / 0 红,存活`;
    else verdict = `✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」等 ${r.failed.length} 条发现;全部:${r.failed.join(" | ")}`;
  }
  console.log(verdict);
  if (!verdict.startsWith("✓")) ok = false;
  fs.rmSync(d, { recursive: true, force: true });
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
