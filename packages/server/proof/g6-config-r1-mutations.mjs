// PR #96 R1 审查故障复验：只在本脚本创建的隔离 worktree 中逐个注入单点故障，逐次恢复原字节。
// 用法：node packages/server/proof/g6-config-r1-mutations.mjs <证据目录>
// 证据目录不能在工作树中；脚本记录每条 TAP、前后对照、精确源码哈希及测试退出码。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const output = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || output === root || output.startsWith(`${root}${path.sep}`)) throw new Error("须指定工作树外的证据目录");
mkdirSync(output, { recursive: true });
const cases = [
  ["C96-01", "packages/server/proof/g6/run.ts", "if (mode === \"real\") {", "if (mode === \"real\" && source.ANTHROPIC_AUTH_TOKEN) {", "C96-R1-01", "API_KEY-only 配置不传入"],
  ["C96-02", "packages/server/proof/g6/driver.ts", "...speakingEnv(o.env)", "...(o.env.GG_SPEAKING_MAX_OUTPUT_TOKENS === undefined ? {} : speakingEnv(o.env))", "C96-R1-02", "只有 context 时丢失"],
  ["C96-03", "packages/server/proof/g6/manifest.ts", "[[k, env[k]!]]", "[[k, k === \"GG_SPEAKING_MAX_OUTPUT_TOKENS\" && Number(env[k]) > 16384 ? \"16384\" : env[k]!]]", "C96-R1-03", "大预算被截断"],
  ["C96-04", "packages/server/proof/g6/manifest.ts", "settings, serial, speaking: {}", "settings, serial, speaking: speakingEnv(env)", "C96-R1-04", "替身身份受无效真实预算影响"],
  ["C96-05", "packages/server/proof/g6/run.ts", "const env = driverProcessEnv(mode, process.env);", "const env = driverProcessEnv(mode, { ...process.env, GG_SPEAKING_MAX_OUTPUT_TOKENS: undefined, GG_SPEAKING_CONTEXT_WINDOW: undefined });", "C96-R1-05", "CLI 实际调用点剥去预算"],
];
const test = "packages/server/proof/g6/runtime-config-r1.test.ts";
const tests = ["packages/server/proof/g6/runtime-config.test.ts", test];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const call = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
const git = (args, cwd = root) => { const r = call("git", args, cwd); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.error}`); return r.stdout.trim(); };
const head = git(["rev-parse", "HEAD"]);
if (!existsSync(path.join(root, "node_modules"))) throw new Error("缺少本地测试依赖 node_modules");
const temp = mkdtempSync(path.join(tmpdir(), "gg96-mutations-"));
const tree = path.join(temp, "tree");
let added = false;
const results = [];
const run = (name, args) => {
  const r = call(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", ...args], tree);
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(path.join(output, `${name}.tap`), text);
  return { exit: r.status, signal: r.signal, error: r.error?.message ?? null, text };
};
const control = (name) => {
  const r = run(name, tests);
  const ok = r.exit === 0 && r.signal === null && !r.error && /^# tests 9$/m.test(r.text) && /^# pass 9$/m.test(r.text) && /^# fail 0$/m.test(r.text) && /^# skipped 0$/m.test(r.text);
  if (!ok) throw new Error(`${name} 对照不合格；详见 TAP`);
  return { exit: r.exit, tests: 9, pass: 9, fail: 0, skipped: 0 };
};
try {
  git(["worktree", "add", "--detach", tree, head]);
  added = true;
  cpSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  const before = control("before-control");
  for (const [id, rel, from, to, witness, why] of cases) {
    const file = path.join(tree, rel);
    const original = readFileSync(file);
    const source = original.toString("utf8");
    if (source.split(from).length !== 2) throw new Error(`${id} 注入点不是恰好一处`);
    let r;
    try {
      writeFileSync(file, source.replace(from, to));
      r = run(id, [`--test-name-pattern=^${witness}`, test]);
    } finally {
      writeFileSync(file, original);
    }
    const restored = sha(readFileSync(file)) === sha(original);
    const killed = r.exit === 1 && r.signal === null && !r.error && r.text.includes(`not ok 1 - ${witness}`) && r.text.includes("failureType: 'testCodeFailure'") && r.text.includes("ERR_ASSERTION") && !r.text.includes("ERR_MODULE_NOT_FOUND");
    results.push({ id, why, file: rel, witness, exit: r.exit, signal: r.signal, killed, restored, sourceSha256: sha(original), tap: `${id}.tap` });
    console.log(`${id}: ${killed ? "按名杀死" : "未杀死"}，原字节${restored ? "已还原" : "未还原"}`);
    if (!killed || !restored) throw new Error(`${id} 未达到具名业务断言及还原要求`);
  }
  const after = control("after-control");
  if (git(["status", "--porcelain"], tree)) throw new Error("变异后隔离 worktree 不干净");
  writeFileSync(path.join(output, "results.json"), `${JSON.stringify({ head, node: process.version, before, results, after, sourceRestored: true }, null, 2)}\n`);
  console.log(`完成：${results.length}/${cases.length} 个单点故障按名杀死，前后对照均 9/9`);
} finally {
  if (added) git(["worktree", "remove", "--force", tree]);
  rmSync(temp, { recursive: true, force: true });
}
