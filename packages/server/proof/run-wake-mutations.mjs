// F11 休眠宽限接运行台账(T-177 B-F11)的行为变异校准(R-05 阳性埋雷):按审查 docs/plans/t177-backend-resume-review.md §B
// 要求的四个变异加上接线上的其余单点故障,逐个注入单一故障,在隔离副本里跑相关测试文件;每个变异都必须让至少一条
// 原样副本里通过的具名测试失败(文件级加载失败不算),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(内核)测的才是注入后的代码。
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
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
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

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
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
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
