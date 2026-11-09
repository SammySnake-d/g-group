// 常驻适配器的行为变异校准(R-05 阳性埋雷,AC-51 埋雷 ①–⑥):对 src/resident.ts、src/turn-model.ts 逐个注入单一故障,
// 在隔离副本里只跑 src/resident.test.ts,每个变异都必须让至少一条具名测试失败,且全部测试都执行完;原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。用法: node packages/adapter-cc-compute/proof/resident-mutations.mjs
// 并发默认 1(本机与云电脑都同时有别的会话);RES_MUT_CONCURRENCY 可调,只影响调度。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TEST = path.join("src", "resident.test.ts");

const M = [
  ["R01 ① 只在启动时定模型,之后各轮不传生效模型", "src/resident.ts", "planTurn(current, want,", "planTurn(current, undefined,"],
  ["R02 ② 检测到模型变化就重启(不做会话内切换)", "src/resident.ts", "{ inSessionModelSwitch: cfg.inSessionModelSwitch, inSessionEffort: cfg.inSessionEffort }", "{ inSessionModelSwitch: false, inSessionEffort: cfg.inSessionEffort }"],
  ["R03 ③ 一轮进行中直接切换(不等 result)", "src/resident.ts", "        if (st.turn && !st.turn.finished) await st.turn.done;\n", "\n"],
  ["R04 ④ set_model 被拒后照常发出这一轮", "src/resident.ts", "        if (r.timeout) st.model = null;\n        return switchFailed(", "        if (r.timeout) st.model = null;\n        startTurn(st, text);\n        return { ok: true } as never;\n        void switchFailed("],
  ["R05 ④ 切换超时后仍当作原模型(不记为不明)", "src/resident.ts", "        if (r.timeout) st.model = null;\n", "\n"],
  ["R06 ⑤ 兜底重启不接回同一会话", "src/resident.ts", "        launch(st, true, step.model, step.effort);", "        launch(st, false, step.model, step.effort);"],
  ["R07 ⑤ 切换请求不可用也当成模型被拒(不兜底)", "src/resident.ts", "if (!r.timeout && !r.exited && switchRefusalKind(r.code, r.error) === \"unavailable\") {\n          // 切换请求本身不可用", "if (false) {\n          // 切换请求本身不可用"],
  ["R08 ⑥ 每轮实际模型取会话累计 modelUsage", "src/resident.ts", "pick(result.model_usage_since_last_result) ?? pick(result.modelUsage)", "pick(result.modelUsage)"],
  ["R09 插话不带 priority(另开一轮)", "src/resident.ts", "content: text }, priority: \"now\" }) ? { ok: true }", "content: text } }) ? { ok: true }"],
  ["R10 模型没变也发 set_model", "src/turn-model.ts", "if (modelDiffers) steps.push(", "if (true) steps.push("],
  ["R11 只改 effort 时不切 effort", "src/turn-model.ts", "if (effortDiffers) steps.push(", "if (false) steps.push("],
  ["R12 空闲回收后恢复不带这一轮的生效模型", "src/resident.ts", "launch(st, true, want?.model ?? st.model ?? undefined, want?.effort ?? st.effort);", "launch(st, true, st.model ?? undefined, st.effort);"],
  ["R13 受阻之后仍报 completed", "src/resident.ts", "    else if (turn.blocked) turn.kind = \"blocked\";\n", "\n"],
  ["R14 同一时刻受理多个续接", "src/resident.ts", "if (st.resuming) return refuse(", "if (false) return refuse("],
  ["R15 停止之后仍受理续接", "src/resident.ts", "      if (st.stopped) return refuse(\"这个 Compute 已被停止\");\n      // 同一时刻只受理一个续接", "      // 同一时刻只受理一个续接"],
  ["R16 不核对每轮 init 的会话 id", "src/resident.ts", "if (s.sessionId !== st.sessionId) {", "if (false) {"],
];

const TIMEOUT_MS = 300_000;
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
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", TEST], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmpdir } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reapDir(dir);
      const named = (re) => [...out.matchAll(re)].map((m) => m[1]).filter((n) => !/^\/|\.test\.ts$/.test(n));
      resolve({ code, signal, timedOut, out, failed: named(/^not ok \d+ - (.+)$/gm), passed: named(/^ok \d+ - (.+)$/gm) });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = await run(copy("clean"));
const total = Number(/^1\.\.(\d+)$/m.exec(clean.out ?? "")?.[1] ?? 0);
const cleanOk = clean.code === 0 && !clean.timedOut && clean.failed.length === 0 && total > 0 && clean.passed.length === total;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红,计划 ${total} 条,退出码 ${clean.code}${clean.timedOut ? "(超时)" : ""}`);
if (!cleanOk) ok = false;
const CONCURRENCY = Number(process.env.RES_MUT_CONCURRENCY) > 0 ? Math.floor(Number(process.env.RES_MUT_CONCURRENCY)) : 1;
console.log(`并发 ${CONCURRENCY}`);
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
    if (r.timedOut) verdict = `✗ ${name}:超时被强杀,不计为杀死(已执行 ${ran}/${total})`;
    else if (r.signal) verdict = `✗ ${name}:测试进程被信号 ${r.signal} 结束,不计为杀死(已执行 ${ran}/${total})`;
    else if (ran !== total) verdict = `✗ ${name}:只执行了 ${ran}/${total} 条测试(部分执行),不计为杀死`;
    else if (r.failed.length === 0) verdict = `✗ ${name}:${r.passed.length} 绿 / 0 红,存活`;
    else verdict = `✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」等 ${r.failed.length} 条发现`;
    results[i] = verdict;
    fs.rmSync(d, { recursive: true, force: true });
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const line of results.filter(Boolean)) { console.log(line); if (!line.startsWith("✓")) ok = false; }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
