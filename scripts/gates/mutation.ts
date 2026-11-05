// 门禁变异校验(R-18 规则自身可信,针对 F-08):
// 把 scripts/gates 复制到临时目录,逐个注入"跳过门禁/放水"的变异,对副本跑它自己的自检(真实命令行入口)。
// 每个变异都必须让自检失败;原样副本必须通过。任何一个变异存活 → 退出 1。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "./lib.ts";
import { CASES } from "./selftest.ts";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");

/**
 * kill:最可能发现这个变异的自检用例名。变异副本的自检先跑它,其余用例按原顺序随后照跑(FAILFAST 下第一个失败即停),
 * 判定口径不变,只是不必等到排在后面的那条用例。名字必须是现存用例,否则本次变异校验失败。
 */
interface Mutation { name: string; kill?: string; file: string; from: string | RegExp; to: string }
const GATE_KILL: Record<string, string> = {"trace": "改了代码没收据", "review": "作者自审", "red": "收据没写红提交", "stub": "F-07 测试只读顶层常量", "tautology": "恒真断言", "workflow": "PR 的 workflow 冒充受保护检查名"};
const GATE_NAMES = ["trace", "review", "red", "stub", "tautology", "workflow"]; // layers 是末项,单独一条
export const MUTATIONS: Mutation[] = [
  { name: "CI 模式不跑任何门禁", kill: "合规(CI 模式,不跑来源核对)", file: "run-all.ts", from: ": ALL_GATES;", to: ": [];" },
  { name: "本机模式不跑来源核对", kill: "合规:先红后绿、跨厂商审查、来源核对通过", file: "run-all.ts", from: "[...LOCAL_GATES, ...ALL_GATES]", to: "ALL_GATES" },
  { name: "有问题也退出 0", kill: "CI 模式下违规同样拦下", file: "run-all.ts", from: "results.some((r) => r.problems.length) ? 1 : 0", to: "0" },
  { name: "执行器吞掉问题", kill: "CI 模式下违规同样拦下", file: "lib.ts", from: "return { gate, problems: gate.run(ctx) };", to: "gate.run(ctx); return { gate, problems: [] };" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里就是要匹配源码里的模板字符串原文
  { name: "执行器把门禁出错当放行", kill: "RR-02 没有沙箱就停", file: "lib.ts", from: "catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }", to: "catch { return { gate, problems: [] }; }" },
  { name: "workflow/依赖清单不算受管", kill: "F-02 只改 workflow 没收据", file: "lib.ts", from: "export const isGoverned = (f: string) => !UNGOVERNED.some((re) => re.test(f));", to: "export const isGoverned = (f: string) => f.startsWith(\"packages/\");" },
  { name: "来源核对不比对 hash", kill: "审查会话算出的是别的 hash", file: "gates.ts", from: "str(c.result).trim() === rv.reviewed_hash", to: "true" },
  { name: "来源核对看全会话模型", kill: "F-04 历史出现过别家模型,算 hash 那一轮是同厂商", file: "gates.ts", from: "const vs = new Set(hits.map((t) => vendorOf(t.model)));", to: "const vs = new Set([vendorOf(rv.model)]);" },
  { name: "豁免认消息里任意一行指令", kill: "RR-13 指令前另有说明文字", file: "gates.ts", from: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim());", to: "const dm = (msg.text ?? \"\").split(\"\\n\").map((l) => DIRECTIVE.exec(l.trim())).find(Boolean) ?? null;" },
  { name: "红提交只要求点名一条", kill: "红提交上第二条测试本来就绿", file: "gates.ts", from: "for (const t of tests) if (then.get(key(t)) !== 1)", to: "for (const t of tests.slice(0, 1)) if (then.get(key(t)) !== 1)" },
  { name: "空桩失败不按名字计数", kill: "F-07 测试只读顶层常量", file: "gates.ts", from: "if ((stubbed.get(k) ?? 0) !== n)", to: "if (false)" },
  { name: "断言不要求判源码结果", kill: "F-07 断言只判复制的逻辑", file: "testlint.ts", from: "else if (t.srcAsserts === 0)", to: "else if (false)" },
  { name: "测试只认字面 test", kill: "合规:node:test 别名 + 断言", file: "testlint.ts", from: "if (TEST_FNS.has(orig)) testNames.set(e.name.text, \"test\");", to: "if (TEST_FNS.has(orig) && e.name.text === orig) testNames.set(e.name.text, \"test\");" },
  { name: "去掉审查人白名单检查", kill: "审查人 grok 被拦", file: "gates.ts", from: "if (!POLICY.allowedReviewers.includes(rv.agent))", to: "if (false)" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配源码里的模板字符串原文
  { name: "来源核对不查审查会话 harness", kill: "argon 审查会话必须是 claude 会话", file: "gates.ts", from: "if (!rv.session.startsWith(`${harnessOf(rv.agent)}:`))", to: "if (false)" },
  { name: "审查会话 harness 不按审查人区分", kill: "审查人 argon 放行(g-group#2404 临时审查人,claude 会话)", file: "gates.ts", from: "export const harnessOf = (agent: string) => POLICY.reviewerHarnessOf[agent] ?? POLICY.reviewerHarness;", to: "export const harnessOf = (_agent: string) => POLICY.reviewerHarness;" },
  { name: "argon 不受跨厂商约束", kill: "argon 审查照样要跨研发厂商:作者也用 Google 模型", file: "gates.ts", from: "if (va !== \"unknown\" && va === vr && !waiver)", to: "if (va !== \"unknown\" && va === vr && !waiver && rv.agent !== \"argon\")" },
  { name: "不核对派活卡片", kill: "派活卡片显示会话属于别的助手", file: "gates.ts", from: "if (wrong.length) out.push(", to: "if (false) out.push(" },
  { name: "session 不做 realpath 包含检查", kill: "RR-01 会话文件软链到 PR 里的伪造记录", file: "gates.ts", from: "if (!inside(real)) return", to: "if (false) return" },
  { name: "session harness 不查白名单", kill: "RR-01 harness 不在白名单", file: "gates.ts", from: "if (!HARNESSES.has(m[1]!)) return", to: "if (false) return" },
  { name: "没有沙箱时回退宿主", kill: "RR-02 没有沙箱就停", file: "lib.ts", from: "throw new Error(\"没有可用沙箱(GATE_SIMULATE_NO_SANDBOX),拒绝在宿主上执行 PR 代码\");", to: "return \"seatbelt\";" },
  { name: "workflow 不查写权限", kill: "RR-03 带引号的写权限", file: "gates.ts", from: "if (val !== \"read\" && val !== \"none\")", to: "if (false)" },
  { name: "workflow 不拒绝表达式名字", kill: "RR-03 job 名用表达式拼出受保护名", file: "gates.ts", from: "if (/\\$\\{\\{/.test(n))", to: "if (false)" },
  { name: "不拦自比较断言", kill: "RR-04 自比较断言", file: "testlint.ts", from: "if (PAIR.test(callee) && args.length >= 2 && norm(args[0]!) === norm(args[1]!))", to: "if (false)" },
  { name: "不拦不可达断言", kill: "RR-04 不可达断言", file: "testlint.ts", from: "if (!reachable) unreachableAsserts.push(text);", to: "if (false) unreachableAsserts.push(text);" },
  { name: "不做返回值变异校准", kill: "RR-04 断言没检查返回值(返回值变异存活)", file: "gates.ts", from: "if (mutable > 0) {", to: "if (false) {" },
  { name: "相对路径写操作不算产出", kill: "RR-05 相对路径的写操作算进产出厂商", file: "gates.ts", from: "if (writes && (cands.length === 0 ? !cwd : resolved.some((r) => r === undefined))) return true;", to: "" },
  { name: "测试身份按集合比较(计数去重)", kill: "RR-06 同名间接测试零断言", file: "gates.ts", from: "m.set(key(t), (m.get(key(t)) ?? 0) + 1);", to: "m.set(key(t), 1);" },
  { name: "不核对红提交测试体", kill: "RR-07 红提交上是另一份假断言", file: "gates.ts", from: "else if (redBodies.get(t.name) !== normBody(t.body))", to: "else if (false)" },
  { name: "豁免不核对 uid", kill: "RR-08 冒用所有者名字的另一个 uid", file: "gates.ts", from: "if (msg.by !== own.uid || msg.name !== own.name)", to: "if (false)" },
  { name: "豁免认引用里的文字", kill: "RR-13 整条消息是引用块里的指令", file: "gates.ts", from: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim());", to: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim().replace(/^>\\s*/, \"\"));" },
  { name: "git 子进程继承 GIT_*", kill: "隔离:hook 环境的 GIT_DIR 指向别的仓库,门禁不碰它", file: "lib.ts", from: "if (!k.startsWith(\"GIT_\") && v !== undefined) env[k] = v;", to: "if (v !== undefined) env[k] = v;" },
  { name: "self-check 白名单放给所有文件", kill: "RR-03 别的 workflow 冒充 self-check", file: "gates.ts", from: "if (c === \"self-check\" && f === \".github/workflows/self-check.yml\" && id === \"self-check\") continue;", to: "if (c === \"self-check\") continue;" },
  { name: "不检查 self-check 必需步骤", kill: "RR-09 self-check.yml 只 echo", file: "gates.ts", from: "if (f === SELF_CHECK_WF) for (const m of selfCheckProblems(doc))", to: "if (false) for (const m of selfCheckProblems(doc))" },
  { name: "不检查 self-check 步骤的 if", kill: "RR-09 门禁自检步骤加 if: false", file: "gates.ts", from: "if (s.if !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "不检查 self-check job 的 if", kill: "RR-09 job 加 if", file: "gates.ts", from: "if (job.if !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "不检查 self-check continue-on-error", kill: "RR-09 job 加 continue-on-error", file: "gates.ts", from: "if (job[\"continue-on-error\"] !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "变异命令允许任意后缀", kill: "RR-09 变异命令后接 || true", file: "gates.ts", from: "npm run gates:mutation$/", to: "npm run gates:mutation/" },
  { name: "不检查 package.json 门禁脚本", kill: "RR-09 package.json 把 gates:mutation 改成 true", file: "gates.ts", from: "if (ctx.files.includes(SELF_CHECK_WF)) for (const m of selfCheckScriptProblems(", to: "if (false) for (const m of selfCheckScriptProblems(" },
  { name: "不检查 self-check 的 shell/working-directory", kill: "RR-09 必需步骤换 shell", file: "gates.ts", from: "for (const k of [\"shell\", \"working-directory\"]) if (s[k] !== undefined)", to: "for (const k of [\"shell\", \"working-directory\"]) if (false)" },
  { name: "不检查 self-check 的 defaults", kill: "RR-09 job 用 defaults 换 shell", file: "gates.ts", from: "if (job.defaults !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "红重放不覆盖测试依赖", kill: "RR-11 helper 在红提交上给了错期望值", file: "gates.ts", from: "for (const d of testDeps(ctx, files)) {", to: "for (const d of [] as string[]) {" },
  { name: "测试依赖只认非源码文件", kill: "RR-11 helper 在红提交上给了错期望值", file: "gates.ts", from: "if (!isSrc(dep) || data) { out.push(dep); queue.push(dep); }", to: "if (!isSrc(dep)) { out.push(dep); queue.push(dep); }" },
  { name: "返回值变异退回按文件判定", kill: "RR-12 一条强测试 + 一条只断言 typeof", file: "gates.ts", from: "for (const k of base.keys()) if (hit.has(k) && (killed.get(k) ?? 0) === 0) out.push(", to: "for (const k of base.keys()) if (false) out.push(" },
  { name: "hash 调用认任意含 run-all --hash 的命令", kill: "RR-14 printf 打印 hash、run-all 只在注释里", file: "gates.ts", from: "(c) => isHashCall(c.input) && str(c.result).trim() === rv.reviewed_hash", to: "(c) => /run-all\\.ts/.test(str(c.input)) && /--hash/.test(str(c.input)) && str(c.result).trim() === rv.reviewed_hash" },
  { name: "hash 调用不拒 shell 元字符", kill: "RR-14 真实 hash 输出被丢弃、再 echo hash", file: "gates.ts", from: "(/[#;&|<>`$()\\\\'\"\\n\\r{}*?!]/.test(cmd) ? undefined : cmd.trim().split(/\\s+/))", to: "cmd.trim().split(/\\s+/)" },
  { name: "hash 调用不要求 node 后紧跟 run-all", kill: "RR-14 node 先跑别的脚本、run-all 只是它的参数", file: "gates.ts", from: "if (!/^(?:\\S*\\/)?scripts\\/gates\\/run-all\\.ts$/.test(argv[1]!)) return false;", to: "if (!argv.some((a) => /run-all\\.ts$/.test(a))) return false;" },
  { name: "产出厂商不认同仓库的另一个 clone", kill: "RR-15 后续轮次写进同仓库的另一个 clone", file: "gates.ts", from: " || clone(abs);", to: " || (clone, false);" },
  { name: "0 用例判通过", kill: "g-group#2538 测试入口 0 条用例判失败", file: "test-runner.ts", from: "if (n === 0) {", to: "if (false) {" },
  { name: "读不到汇总行判通过", kill: "g-group#2538 测试入口 0 条用例判失败", file: "test-runner.ts", from: "const m = /^# tests (\\d+)\\s*$/.exec(line);", to: "const m = /^# tests ([1-9]\\d*)\\s*$/.exec(line);" },
  { name: "不要求 test 脚本为规范值", kill: "g-group#2538 test 脚本改回裸 node --test(0 用例也判通过)", file: "gates.ts", from: "  test: 'node scripts/gates/test-runner.ts", to: "  _test: 'node scripts/gates/test-runner.ts" },
  { name: "self-check 不要求 npm test 步骤", kill: "g-group#2538 self-check 缺 npm test 步骤", file: "gates.ts", from: "  { label: \"npm test\", ok: (r) => r === \"npm test\" },\n", to: "" },
  ...GATE_NAMES.map((g) => ({ name: `从 ALL_GATES 删掉 ${g}`, kill: GATE_KILL[g]!, file: "gates.ts", from: new RegExp(`(ALL_GATES: Gate\\[\\] = \\[[^\\]]*?)\\b${g}, ?`), to: "$1" })),
  { name: "从 ALL_GATES 删掉 layers(末项)", kill: "领域层反向依赖内核", file: "gates.ts", from: /, layers\];/, to: "];" },
];

function copyGates(dst: string) {
  fs.mkdirSync(path.join(dst, "scripts/gates"), { recursive: true });
  for (const f of fs.readdirSync(HERE)) if (f.endsWith(".ts") || f.endsWith(".json")) fs.copyFileSync(path.join(HERE, f), path.join(dst, "scripts/gates", f));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dst, "node_modules"));
  fs.writeFileSync(path.join(dst, "package.json"), JSON.stringify({ type: "module" }));
}

/** 变异并发 × 每个变异自检的并发 ≈ CPU 数,不超订(GATE_SELFTEST_JOBS 显式给了就用它) */
const WIDTH = Math.max(1, Number(process.env.GATE_MUTATION_JOBS ?? 4));
const CHILD_JOBS = Number(process.env.GATE_SELFTEST_JOBS ?? Math.max(1, Math.floor(os.availableParallelism() / WIDTH)));
/** 单个变异的自检上限。超时算"没被发现"(✗):没跑完的自检证明不了门禁拦得住这个变异。 */
const MUTANT_TIMEOUT_MS = Number(process.env.GATE_MUTANT_TIMEOUT_MS ?? 900_000);
function runSelftestAsync(dir: string, first?: string): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { env: gitEnv({ GATE_SELFTEST_FAILFAST: "1", GATE_SELFTEST_JOBS: String(CHILD_JOBS), ...(first ? { GATE_SELFTEST_FIRST: first } : {}) }), detached: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-c.pid!, "SIGKILL"); } catch { c.kill("SIGKILL"); } }, MUTANT_TIMEOUT_MS);
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}

/** 原样对照的上限(GATE_CLEAN_TIMEOUT_MS,默认 30 分钟)。超时单独报出,不和"原样自检失败"混在一起。 */
const CLEAN_TIMEOUT_MS = Number(process.env.GATE_CLEAN_TIMEOUT_MS ?? 1_800_000);
function runSelftest(dir: string) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { encoding: "utf8", env: gitEnv({ GATE_SELFTEST_FAILFAST: "1" }), timeout: CLEAN_TIMEOUT_MS, killSignal: "SIGKILL" });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), timedOut };
}

export async function mutationTest(): Promise<boolean> {
  // kill 提示写错时,副本自检会因"用例不存在"失败,变异就会被误算成被发现:先核对,有错整次失败
  const names = new Set(CASES.map((c) => c.name));
  const badHints = MUTATIONS.filter((m) => m.kill === undefined || !names.has(m.kill));
  if (badHints.length) {
    for (const m of badHints) console.log(`✗ 变异「${m.name}」的 kill 提示「${m.kill ?? "(缺)"}」不是现存自检用例`);
    console.log("变异校验失败");
    return false;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mutation-"));
  let ok = true;
  try {
    const clean = path.join(tmp, "clean");
    copyGates(clean);
    const tc = Date.now();
    const c = runSelftest(clean);
    console.log(`原样副本自检耗时 ${Math.round((Date.now() - tc) / 1000)}s`);
    const cleanOk = c.code === 0 && c.out.includes("自检通过");
    if (c.timedOut) { console.log(`✗ 原样对照超时:原样副本自检 ${CLEAN_TIMEOUT_MS / 1000}s 内没跑完(GATE_CLEAN_TIMEOUT_MS 可调),变异没有开始,不是变异存活`); console.log(c.out); return false; }
    console.log(`${cleanOk ? "✓" : "✗"} 原样副本自检通过`);
    if (!cleanOk) { console.log(c.out); return false; }
    // 本机诊断用:GATE_MUTATION_ONLY=<正则> 只跑名字匹配的变异(CI 不设,跑全部)
    const only = process.env.GATE_MUTATION_ONLY ? new RegExp(process.env.GATE_MUTATION_ONLY) : undefined;
    const picked = MUTATIONS.filter((m) => !only || only.test(m.name));
    const jobs = picked.map((m, i) => () => {
      const d = path.join(tmp, `m${i}`);
      copyGates(d);
      const f = path.join(d, "scripts/gates", m.file);
      const src = fs.readFileSync(f, "utf8");
      const mutated = src.replace(m.from, m.to);
      if (mutated === src) return Promise.resolve(`✗ 变异「${m.name}」没能注入(代码已变,更新 MUTATIONS)`);
      fs.writeFileSync(f, mutated);
      const t0 = Date.now();
      return runSelftestAsync(d, m.kill).then((r) => {
        const secs = Math.round((Date.now() - t0) / 1000);
        if (r.timedOut) return `✗ 变异「${m.name}」自检超时(${secs}s),不算被发现`;
        const killed = r.code !== 0;
        const firstFail = r.out.split("\n").find((l) => l.startsWith("✗")) ?? "(进程失败)";
        return `${killed ? "✓" : "✗"} 变异「${m.name}」(${secs}s)${killed ? `被自检发现:${firstFail.slice(0, 80)}` : "存活:自检仍然通过"}`;
      });
    });
    const width = Math.max(1, Math.min(WIDTH, jobs.length));
    console.log(`变异 ${jobs.length} 个,并发 ${width},每个变异的自检并发 ${CHILD_JOBS},CPU ${os.availableParallelism()},node ${process.version}`);
    const t0 = Date.now();
    const lines: string[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) { const i = next++; lines[i] = await jobs[i]!(); console.log(`[${lines.filter(Boolean).length}/${jobs.length}] ${lines[i]}`); }
    }));
    console.log(`—— 汇总(总耗时 ${Math.round((Date.now() - t0) / 1000)}s)——`);
    for (const l of lines) { console.log(l); if (l.startsWith("✗")) ok = false; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(ok ? "变异校验通过" : "变异校验失败");
  return ok;
}

if (import.meta.main) process.exit((await mutationTest()) ? 0 : 1);
