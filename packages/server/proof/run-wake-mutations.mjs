// F11 休眠宽限接运行台账(T-177 B-F11)的行为变异校准(R-05 阳性埋雷):按审查 docs/plans/t177-backend-resume-review.md §B
// 要求的四个变异加上接线上的其余单点故障,逐个注入单一故障,在隔离副本里跑相关测试文件;每个变异都必须让至少一条
// 原样副本里通过的具名测试失败(文件级加载失败不算),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(内核)测的才是注入后的代码。
// 第 1 轮返修(审查 reviews/feat-run-wake-f11.md)起:W14–W18 覆盖 BF11-R1-01/02;测试文件逐个单独跑(多文件合跑时 TAP 会嵌套、
// 编号重置,Codex 复核时少报过结果),每个文件的具名结果必须和源码里的 test("…") 全集逐条对上、cancelled/skipped/todo 为 0,
// 对不上记「不完整」、不算杀死。逐项结果另写 JSONL(MUT_OUT,默认不写)。
// 用法: node packages/server/proof/run-wake-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/run-wake.test.ts",
  "packages/kernel/src/wake-policy.test.ts",
  "packages/server/src/runs.test.ts",
  "packages/kernel/src/retry-policy.test.ts",
  "packages/kernel/src/run-ledger.test.ts",
  "packages/server/src/run-wake-edges.test.ts",
  "packages/kernel/src/wake-jump.test.ts",
];
const S = "packages/server/src/runs.ts";
const H = "packages/server/src/host.ts";
const RP = "packages/kernel/src/retry-policy.ts";
const RL = "packages/kernel/src/run-ledger.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  ["W01 台账每拍不采样(wakeTick 换成恒返回初始态),休眠永远检不出", [[S, "    this.wake = wakeTick(this.wake, now, this.wakePolicy);\n", "    this.wake = WAKE_INITIAL;\n"]]],
  ["W02 跳变判定恒真,每拍都当刚醒来(宽限变成总开关)", [[RP, "  const jumped = lastTickMs !== null && (nowMs - lastTickMs > c.p.jumpMs || nowMs < lastTickMs);", "  const jumped = true;"]]],
  ["W03 去掉 jumpMs ≥ 2×核对周期的构造守卫", [[S, "  if (c.policy.jumpMs < checkMs * 2) throw new HostError(", "  if (false) throw new HostError("]]],
  ["W04 不把 awakeSince 交给 stallCheck", [[S, "    return { awakeSince: this.wake.awakeSince, graceMs: this.wakePolicy.graceMs };", "    return { awakeSince: null, graceMs: this.wakePolicy.graceMs };"]]],
  ["W05 宽限时长不按参数,写死 3 分钟", [[S, "    return { awakeSince: this.wake.awakeSince, graceMs: this.wakePolicy.graceMs };", "    return { awakeSince: this.wake.awakeSince, graceMs: 180_000 };"]]],
  ["W06 构造时不采样,第一拍不和构造时刻比", [[S, "    this.wake = wakeTick(WAKE_INITIAL, opts.clockMs(), this.wakePolicy);\n", "    this.wake = WAKE_INITIAL;\n"]]],
  ["W07 画板查询(liveCheck)不给宽限,只有核对拍给", [[S, "resolveThresholds(this.opts.thresholds(), u.contactId, u.upstream), this.sleep());", "resolveThresholds(this.opts.thresholds(), u.contactId, u.upstream), { awakeSince: null });"]]],
  ["W08 宿主不把 runWakePolicy 透传给台账", [[H, "      wake: runWake,\n", ""]]],
  ["W09 宿主不在构造早期校验(非法参数要等台账才发现,或被默认值盖掉)", [[H, "    const runWake = checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy);\n", "    const runWake = undefined;\n"]]],
  ["W10 内核参数合同不校验 jumpMs / graceMs", [[RP, '  if (!isPosFinite(v.jumpMs) || !isNat(v.graceMs)) return { ok: false, reason: "jumpMs 必须是正数、graceMs 必须是非负整数" };\n  return { ok: true, policy: Object.freeze(', "  return { ok: true, policy: Object.freeze("]]],
  ["W11 内核参数合同不给的字段不取默认值", [[RP, "  const v = { ...DEFAULT_WAKE_POLICY, ...r.v } as Rec;\n  if (!isPosFinite(v.jumpMs) || !isNat(v.graceMs)) return { ok: false, reason: \"jumpMs 必须是正数、graceMs 必须是非负整数\" };\n  return { ok: true, policy: Object.freeze(", "  const v = { ...r.v } as Rec;\n  if (!isPosFinite(v.jumpMs) || !isNat(v.graceMs)) return { ok: false, reason: \"jumpMs 必须是正数、graceMs 必须是非负整数\" };\n  return { ok: true, policy: Object.freeze("]]],
  ["W12 stallCheck 去掉休眠宽限(坏实现 ⑥ 去掉 awakeSince 宽限门)", [[RL, '  if (awake !== null && now < awake + (sleep.graceMs ?? DEFAULT_SLEEP_GRACE_MS)) return none("sleep_grace");\n', ""]]],
  ["W13 宽限期内确定不会自愈的错误也等宽限", [[H, "      if (ff) void this.stopComputeFor(x.computeId, { failure: ff, verdict: null });", '      if (ff && this.runs.liveCheck(turn).waiting !== "sleep_grace") void this.stopComputeFor(x.computeId, { failure: ff, verdict: null });']]],
  ["W14 宿主休眠门校验放回打开数据库之后(抛对错误,但已建库、留句柄)", [[H, "    const runWake = checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy);\n    this.db = openDb(opts.file);\n", "    this.db = openDb(opts.file);\n    const runWake = checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy);\n"]]],
  ["W15 宿主重试参数校验放回打开数据库之后", [[H, "    const policy = checkRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...(opts.retry ?? {}) });\n    if (!policy.ok) throw new HostError(\"invalid_params\", `重试参数不合格:${policy.reason}`);\n    this.retryPolicy = policy.policy;\n    const runWake = checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy);\n    this.db = openDb(opts.file);\n", "    const runWake = checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy);\n    this.db = openDb(opts.file);\n    const policy = checkRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...(opts.retry ?? {}) });\n    if (!policy.ok) throw new HostError(\"invalid_params\", `重试参数不合格:${policy.reason}`);\n    this.retryPolicy = policy.policy;\n"]]],
  ["W16 跳变判定「超过 jumpMs」改成「不少于」,恰好相隔 jumpMs 的正常核对也当醒来(审查 C01 / hy4 H-BF11-01)", [[RP, "nowMs - lastTickMs > c.p.jumpMs", "nowMs - lastTickMs >= c.p.jumpMs"]]],
  ["W17 台账宽限 0 被当成没给、换成默认 3 分钟(审查 C03)", [[S, "graceMs: this.wakePolicy.graceMs };", "graceMs: this.wakePolicy.graceMs || 180_000 };"]]],
  ["W18 宿主早期校验不按 runCheckMs、用默认核对周期(审查 C02 / hy4 H-BF11-02)", [[H, "checkRunWake(opts.runCheckMs ?? DEFAULT_RUN_CHECK_MS, opts.runWakePolicy)", "checkRunWake(DEFAULT_RUN_CHECK_MS, opts.runWakePolicy)"]]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const OUT = process.env.MUT_OUT ?? null;
/** 源码里顶层 test("…") 的具名全集(TAP 会把名字里的 # 转义成 \#,这里同样转义) */
const declared = (file) => [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`).replaceAll("#", "\\#"));
/** 单独跑一个测试文件,读顶层具名结果 */
function runFile(dir, file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-reporter=tap", file], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const tally = (k) => Number(out.match(new RegExp(`^# ${k} (\\d+)$`, "m"))?.[1] ?? -1);
      resolve({ code, signal, timedOut, failed, passed, cancelled: tally("cancelled"), skipped: tally("skipped"), todo: tally("todo") });
    });
  });
}
/** 逐个文件跑;每个文件的具名结果要和声明全集逐条对上,否则记不完整 */
async function runAll(dir) {
  const files = [];
  for (const file of TESTS) {
    const want = declared(file);
    const r = await runFile(dir, file);
    const seen = [...r.passed, ...r.failed];
    const missing = want.filter((n) => seen.filter((x) => x === n).length !== 1);
    const extra = seen.filter((n) => !want.includes(n));
    const complete = !r.timedOut && r.signal === null && missing.length === 0 && extra.length === 0 && r.cancelled === 0 && r.skipped === 0 && r.todo === 0;
    files.push({ file, declared: want.length, ...r, missing, extra, complete });
  }
  return files;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-wake-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
const record = (o) => OUT && fs.appendFileSync(OUT, `${JSON.stringify(o)}\n`);
const sum = (fs_, k) => fs_.reduce((n, f) => n + f[k].length, 0);

let ok = true;
const total = TESTS.reduce((n, f) => n + declared(f).length, 0);
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个(逐个单独跑),具名测试 ${total} 条`);
const clean = await runAll(copy("clean"));
record({ id: "clean", files: clean.map(({ file, declared: d, passed, failed, missing, extra, complete, code, signal, timedOut }) => ({ file, declared: d, passed: passed.length, failed, missing, extra, complete, code, signal, timedOut })) });
const good = clean.every((f) => f.complete && f.code === 0 && f.failed.length === 0);
console.log(`${good ? "✓" : "✗"} 原样副本:${sum(clean, "passed")} 绿 / ${sum(clean, "failed")} 红${good ? "" : `;${clean.filter((f) => !f.complete || f.failed.length).map((f) => `${f.file} 不完整或有红(缺 ${f.missing.length}、多 ${f.extra.length}、红 ${f.failed.length})`).join(";")}`}`);
if (!good) ok = false;
const named = new Set(clean.flatMap((f) => f.passed));
let killed = 0;
let survived = 0;
for (const [i, [name, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) {
    ok = false;
    survived++;
    record({ id: name.split(" ")[0], verdict: "bad-injection", bad });
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await runAll(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.flatMap((f) => f.failed).filter((t) => named.has(t));
  const incomplete = r.filter((f) => !f.complete).map((f) => `${f.file}(缺 ${f.missing.length}、多 ${f.extra.length}${f.timedOut ? "、超时" : ""}${f.signal ? `、${f.signal}` : ""})`);
  const verdict = kills.length > 0 && incomplete.length === 0 ? "killed" : incomplete.length ? "incomplete" : "survived";
  record({ id: name.split(" ")[0], name, verdict, kills, incomplete, passed: sum(r, "passed"), failed: sum(r, "failed"), seconds: (Date.now() - t0) / 1000 });
  if (verdict === "killed") {
    killed++;
    console.log(`✓ ${tag} ${name}:${sum(r, "passed")} 绿 / ${sum(r, "failed")} 红(全集 ${total} 条逐条报出),用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${verdict === "incomplete" ? `不完整 ${incomplete.join(";")}` : `${sum(r, "passed")} 绿 / ${sum(r, "failed")} 红,存活`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活或不完整 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
