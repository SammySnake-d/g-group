// 门禁变异校验(R-18 规则自身可信,针对 F-08):
// 把 scripts/gates 复制到临时目录,逐个注入"跳过门禁/放水"的变异,对副本跑它自己的自检(真实命令行入口)。
// 每个变异都必须让自检失败;原样副本必须通过。任何一个变异存活 → 退出 1。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "./lib.ts";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");

interface Mutation { name: string; file: string; from: string | RegExp; to: string }
const GATE_NAMES = ["trace", "review", "red", "stub", "tautology", "workflow"]; // layers 是末项,单独一条
export const MUTATIONS: Mutation[] = [
  // 第十七轮:复制链在沙箱前不得把链接解引用成普通文件。
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 注入点须匹配源码中的模板字符串。
  { name: "copyTree 不查链接与仓库外路径", file: "lib.ts", from: 'if (!fs.lstatSync(from).isFile() || !(resolved === root || resolved.startsWith(`${root}${path.sep}`)))', to: "if (false)" },
  { name: "CI 模式不跑任何门禁", file: "run-all.ts", from: ": ALL_GATES;", to: ": [];" },
  { name: "本机模式不跑来源核对", file: "run-all.ts", from: "[...LOCAL_GATES, ...ALL_GATES]", to: "ALL_GATES" },
  { name: "有问题也退出 0", file: "run-all.ts", from: "results.some((r) => r.problems.length) ? 1 : 0", to: "0" },
  { name: "执行器吞掉问题", file: "lib.ts", from: "return { gate, problems: gate.run(ctx) };", to: "gate.run(ctx); return { gate, problems: [] };" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里就是要匹配源码里的模板字符串原文
  { name: "执行器把门禁出错当放行", file: "lib.ts", from: "catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }", to: "catch { return { gate, problems: [] }; }" },
  { name: "workflow/依赖清单不算受管", file: "lib.ts", from: "export const isGoverned = (f: string) => !UNGOVERNED.some((re) => re.test(f));", to: "export const isGoverned = (f: string) => f.startsWith(\"packages/\");" },
  { name: "来源核对不比对 hash", file: "gates.ts", from: "str(c.result).trim() === rv.reviewed_hash", to: "true" },
  { name: "来源核对看全会话模型", file: "gates.ts", from: "const vs = new Set(hits.map((t) => vendorOf(t.model)));", to: "const vs = new Set([vendorOf(rv.model)]);" },
  { name: "豁免不看批准原文", file: "gates.ts", from: "if (directive.length !== 1 || text.split(\"批准豁免\").length !== 2)", to: "if (false)" },
  { name: "红提交只要求点名一条", file: "gates.ts", from: "for (const t of tests) if (then.get(key(t)) !== 1)", to: "for (const t of tests.slice(0, 1)) if (then.get(key(t)) !== 1)" },
  { name: "空桩失败不按名字计数", file: "gates.ts", from: "if ((stubbed.get(k) ?? 0) !== n)", to: "if (false)" },
  { name: "断言不要求判源码结果", file: "testlint.ts", from: "else if (t.srcAsserts === 0)", to: "else if (false)" },
  { name: "测试只认字面 test", file: "testlint.ts", from: "if (TEST_FNS.has(orig)) testNames.set(e.name.text, \"test\");", to: "if (TEST_FNS.has(orig) && e.name.text === orig) testNames.set(e.name.text, \"test\");" },
  { name: "去掉审查人白名单检查", file: "gates.ts", from: "if (!POLICY.allowedReviewers.includes(rv.agent))", to: "if (false)" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配源码里的模板字符串原文
  { name: "来源核对不查审查会话 harness", file: "gates.ts", from: "if (!rv.session.startsWith(`${POLICY.reviewerHarness}:`))", to: "if (false)" },
  { name: "不核对派活卡片", file: "gates.ts", from: "if (wrong.length) out.push(", to: "if (false) out.push(" },
  { name: "session 不做 realpath 包含检查", file: "gates.ts", from: "if (!inside(real)) return", to: "if (false) return" },
  { name: "session harness 不查白名单", file: "gates.ts", from: "if (!HARNESSES.has(m[1]!)) return", to: "if (false) return" },
  { name: "没有沙箱时回退宿主", file: "lib.ts", from: "throw new Error(\"没有可用沙箱(GATE_SIMULATE_NO_SANDBOX),拒绝在宿主上执行 PR 代码\");", to: "return \"seatbelt\";" },
  { name: "workflow 不查写权限", file: "gates.ts", from: "if (val !== \"read\" && val !== \"none\")", to: "if (false)" },
  { name: "workflow 不拒绝表达式名字", file: "gates.ts", from: "if (/\\$\\{\\{/.test(n))", to: "if (false)" },
  { name: "不拦自比较断言", file: "testlint.ts", from: "if (PAIR.test(callee) && args.length >= 2 && norm(args[0]!) === norm(args[1]!))", to: "if (false)" },
  { name: "不拦不可达断言", file: "testlint.ts", from: "if (!reachable) unreachableAsserts.push(text);", to: "if (false) unreachableAsserts.push(text);" },
  { name: "不做返回值变异校准", file: "gates.ts", from: "if (mutable > 0) {", to: "if (false) {" },
  { name: "相对路径写操作不算产出", file: "gates.ts", from: "if (writes && (cands.length === 0 ? !cwd : resolved.some((r) => r === undefined))) return true;", to: "" },
  { name: "测试身份按集合比较(计数去重)", file: "gates.ts", from: "m.set(key(t), (m.get(key(t)) ?? 0) + 1);", to: "m.set(key(t), 1);" },
  { name: "不核对红提交测试体", file: "gates.ts", from: "else if (redBodies.get(t.name) !== normBody(t.body))", to: "else if (false)" },
  { name: "豁免不核对 uid", file: "gates.ts", from: "if (msg.by !== own.uid || msg.name !== own.name)", to: "if (false)" },
  { name: "豁免认引用里的文字", file: "gates.ts", from: "if (!fence && !l.startsWith(\">\")) lines.push(l);", to: "lines.push(l.replace(/^[>「]+|」$/g, \"\"));" },
  { name: "git 子进程继承 GIT_*", file: "lib.ts", from: "if (!k.startsWith(\"GIT_\") && v !== undefined) env[k] = v;", to: "if (v !== undefined) env[k] = v;" },
  { name: "self-check 白名单放给所有文件", file: "gates.ts", from: "if (c === \"self-check\" && f === \".github/workflows/self-check.yml\" && id === \"self-check\") continue;", to: "if (c === \"self-check\") continue;" },
  // 第十五轮 R15-03/04/05
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配源码里的模板字符串原文
  { name: "依赖目录可写挂载(去掉 :ro)", file: "lib.ts", from: "`${m}:${m}:ro`", to: "`${m}:${m}`" },
  { name: "副本不重建工作区链接(依赖一律指回宿主)", file: "lib.ts", from: "fs.symlinkSync(dest, to);", to: "void dest; fs.symlinkSync(target, to);" },
  { name: "G-STUB 不查基线文件加载失败", file: "gates.ts", from: "for (const t of baseline.failed) out.push(", to: "for (const t of [] as NamedTest[]) out.push(" },
  { name: "G-STUB 不查应执行测试缺失", file: "gates.ts", from: "for (const k of want) if (!base.has(k))", to: "for (const k of want) if (false && !base.has(k))" },
  ...GATE_NAMES.map((g) => ({ name: `从 ALL_GATES 删掉 ${g}`, file: "gates.ts", from: new RegExp(`(ALL_GATES: Gate\\[\\] = \\[[^\\]]*?)\\b${g}, ?`), to: "$1" })),
  { name: "从 ALL_GATES 删掉 layers(末项)", file: "gates.ts", from: /, layers\];/, to: "];" },
];

function copyGates(dst: string) {
  fs.mkdirSync(path.join(dst, "scripts/gates"), { recursive: true });
  for (const f of fs.readdirSync(HERE)) if (f.endsWith(".ts") || f.endsWith(".json")) fs.copyFileSync(path.join(HERE, f), path.join(dst, "scripts/gates", f));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dst, "node_modules"));
  fs.writeFileSync(path.join(dst, "package.json"), JSON.stringify({ type: "module" }));
}

function runSelftestAsync(dir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { env: gitEnv({ GATE_SELFTEST_FAILFAST: "1" }) });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
}

function runSelftest(dir: string) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { encoding: "utf8", env: gitEnv({ GATE_SELFTEST_FAILFAST: "1" }), timeout: 900_000 });
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
