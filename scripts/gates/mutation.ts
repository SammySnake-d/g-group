// 门禁变异校验(R-18 规则自身可信,针对 F-08):
// 把 scripts/gates 复制到临时目录,逐个注入"跳过门禁/放水"的变异,对副本跑它自己的自检(真实命令行入口)。
// 每个变异都必须让自检失败;原样副本必须通过。任何一个变异存活 → 退出 1。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");

interface Mutation { name: string; file: string; from: string | RegExp; to: string }
const GATE_NAMES = ["trace", "review", "red", "stub", "tautology", "workflow"]; // layers 是末项,单独一条
export const MUTATIONS: Mutation[] = [
  { name: "CI 模式不跑任何门禁", file: "run-all.ts", from: ": ALL_GATES;", to: ": [];" },
  { name: "本机模式不跑来源核对", file: "run-all.ts", from: "[...ALL_GATES, ...LOCAL_GATES]", to: "ALL_GATES" },
  { name: "有问题也退出 0", file: "run-all.ts", from: "results.some((r) => r.problems.length) ? 1 : 0", to: "0" },
  { name: "执行器吞掉问题", file: "lib.ts", from: "return { gate, problems: gate.run(ctx) };", to: "gate.run(ctx); return { gate, problems: [] };" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里就是要匹配源码里的模板字符串原文
  { name: "执行器把门禁出错当放行", file: "lib.ts", from: "catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }", to: "catch { return { gate, problems: [] }; }" },
  { name: "workflow/依赖清单不算受管", file: "lib.ts", from: "export const isGoverned = (f: string) => !UNGOVERNED.some((re) => re.test(f));", to: "export const isGoverned = (f: string) => f.startsWith(\"packages/\");" },
  { name: "来源核对不比对 hash", file: "gates.ts", from: "str(c.result).trim() === rv.reviewed_hash", to: "true" },
  { name: "来源核对看全会话模型", file: "gates.ts", from: "const vs = new Set(hits.map((t) => vendorOf(t.model)));", to: "const vs = new Set([vendorOf(rv.model)]);" },
  { name: "豁免不看批准原文", file: "gates.ts", from: "!/批准豁免/.test(msg.text ?? \"\") || /不批准|拒绝|不同意/.test(msg.text ?? \"\")", to: "false" },
  { name: "红提交只要求点名一条", file: "gates.ts", from: "for (const t of tests) if (!failedThen.has(key(t)))", to: "for (const t of tests.slice(0, 1)) if (!failedThen.has(key(t)))" },
  { name: "空桩只看仍通过的", file: "gates.ts", from: "if (!failed.has(key(t)))", to: "if (stubbed.passed.some((x) => key(x) === key(t)))" },
  { name: "断言不要求判源码结果", file: "testlint.ts", from: "else if (t.srcAsserts === 0)", to: "else if (false)" },
  { name: "测试只认字面 test", file: "testlint.ts", from: "if (TEST_FNS.has(orig)) testNames.set(e.name.text, \"test\");", to: "if (TEST_FNS.has(orig) && e.name.text === orig) testNames.set(e.name.text, \"test\");" },
  ...GATE_NAMES.map((g) => ({ name: `从 ALL_GATES 删掉 ${g}`, file: "gates.ts", from: new RegExp(`(ALL_GATES: Gate\\[\\] = \\[[^\\]]*?)\\b${g}, ?`), to: "$1" })),
  { name: "从 ALL_GATES 删掉 layers(末项)", file: "gates.ts", from: /, layers\];/, to: "];" },
];

function copyGates(dst: string) {
  fs.mkdirSync(path.join(dst, "scripts/gates"), { recursive: true });
  for (const f of fs.readdirSync(HERE)) if (f.endsWith(".ts")) fs.copyFileSync(path.join(HERE, f), path.join(dst, "scripts/gates", f));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dst, "node_modules"));
  fs.writeFileSync(path.join(dst, "package.json"), JSON.stringify({ type: "module" }));
}

function runSelftestAsync(dir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { env: { ...process.env, GATE_SELFTEST_FAILFAST: "1" } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
}

function runSelftest(dir: string) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { encoding: "utf8", env: { ...process.env, GATE_SELFTEST_FAILFAST: "1" }, timeout: 900_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export async function mutationTest(): Promise<boolean> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mutation-"));
  let ok = true;
  try {
    const clean = path.join(tmp, "clean");
    copyGates(clean);
    const c = runSelftest(clean);
    const cleanOk = c.code === 0 && c.out.includes("自检通过");
    console.log(`${cleanOk ? "✓" : "✗"} 原样副本自检通过`);
    if (!cleanOk) { console.log(c.out); return false; }
    const jobs = MUTATIONS.map((m, i) => () => {
      const d = path.join(tmp, `m${i}`);
      copyGates(d);
      const f = path.join(d, "scripts/gates", m.file);
      const src = fs.readFileSync(f, "utf8");
      const mutated = src.replace(m.from, m.to);
      if (mutated === src) return Promise.resolve(`✗ 变异「${m.name}」没能注入(代码已变,更新 MUTATIONS)`);
      fs.writeFileSync(f, mutated);
      return runSelftestAsync(d).then((r) => {
        const killed = r.code !== 0;
        const firstFail = r.out.split("\n").find((l) => l.startsWith("✗")) ?? "(进程失败)";
        return `${killed ? "✓" : "✗"} 变异「${m.name}」${killed ? `被自检发现:${firstFail.slice(0, 80)}` : "存活:自检仍然通过"}`;
      });
    });
    const width = Math.max(1, Math.min(Number(process.env.GATE_MUTATION_JOBS ?? 4), jobs.length));
    const lines: string[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) { const i = next++; lines[i] = await jobs[i]!(); }
    }));
    for (const l of lines) { console.log(l); if (l.startsWith("✗")) ok = false; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(ok ? "变异校验通过" : "变异校验失败");
  return ok;
}

if (import.meta.main) process.exit((await mutationTest()) ? 0 : 1);
