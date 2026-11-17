// 失败原因分类器的行为变异校准(R-05 阳性埋雷):按验收文档 AC-43「坏实现」列与 D26 第 8.4 节逐个注入单一故障,
// 在隔离副本里只跑 failure-class.test.ts;每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死),注入点必须恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。并发 1。主会话的子代理 α 所写。
// 用法: node packages/kernel/proof/failure-class-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const FILE = "failure-class.ts";
const TESTS = ["src/failure-class.test.ts"];

const M = [
  ["F01 断流与用户停止记成同一原因(坏实现 ②)", 'rule("stream_dropped", /stream disconnected/i,', 'rule("user_stopped", /stream disconnected/i,'],
  ["F02 认不出硬归到别的类(坏实现 ⑬)", 'let reasonClass: ReasonClass = "unknown";', 'let reasonClass: ReasonClass = "harness_crashed";'],
  ["F03 丢原文(坏实现 ⑬)", "    raw,\n", "    raw: raw.slice(0, 200),\n"],
  ["F04 失败没有 reason_class(坏实现 ⑬)", "    reasonClass,\n    retryClass:", "    reasonClass: undefined as unknown as ReasonClass,\n    retryClass:"],
  ["F05 上下文超长认不出(坏实现 ⑭,记成 unknown)", "    /prompt is too long/i,\n", ""],
  ["F06 照抄 harness 的 invalid_request(坏实现 ⑭)", 'const REFINABLE: ReadonlySet<ReasonClass> = new Set<ReasonClass>(["invalid_request", "auth_or_quota"]);', "const REFINABLE: ReadonlySet<ReasonClass> = new Set<ReasonClass>([]);"],
  ["F07 上下文超长在原会话自动继续(坏实现 ⑭)", '"Permanent", "new_session_only", { fast: true }),\n  auth_or_quota', '"Permanent", "allowed", { fast: true }),\n  auth_or_quota'],
  ["F08 平台拒绝可在原会话重跑(坏实现 ⑤)", 'platform_refused: info("平台拒绝", "换新会话", "Permanent", "new_session_only"', 'platform_refused: info("平台拒绝", "换新会话", "Permanent", "allowed"'],
  ["F09 人停的也自动重跑(坏实现 ⑥)", 'user_stopped: info("已停止", "—", "Permanent", "never")', 'user_stopped: info("已停止", "—", "Permanent", "allowed")'],
  ["F10 鉴权额度自动重跑(⑧)", 'auth_or_quota: info("鉴权或额度问题", "人先修配置", "Permanent", "never"', 'auth_or_quota: info("鉴权或额度问题", "人先修配置", "Permanent", "backoff"'],
  ["F11 用户停止不认(⑮ 人停与失败同字)", "if (x.userStopped === true) {", "if (false) {"],
  ["F12 卡死判定不认(⑦⑩ 原因写成别的)", '} else if (x.stall === "no_response" || x.stall === "stalled" || x.stall === "stream_dropped") {', "} else if (false) {"],
  ["F13 结构化字段不优先(原文先判)", "} else if (status || kind) {", "} else if (false) {"],
  ["F14 reason 与 retry 混成一个字段", "    retryClass: i.retryClass,\n", '    retryClass: (i.autoRerun === "never" ? "Permanent" : "Transient") as RetryClass,\n'],
  ["F15 不带规则表版本号", "    rulesVersion: FAILURE_RULES_VERSION,\n", '    rulesVersion: "",\n'],
  ["F16 表不冻结", "  return Object.freeze(x);\n}", "  return x;\n}"],
  ["F17 403 额度不足不认", "/insufficient[ _-](user[ _-])?(quota|balance|credit)/i,", "/insufficient[ _-]credit/i,"],
  ["F18 cyber_policy 不认", 'rule("platform_refused", /cyber_policy/i,', 'rule("platform_refused",'],
  ["F19 429 HTTP 状态不认", "if (s === 429) return \"rate_limited\";", ""],
  ["F20 共享额度暂时用尽归成额度问题", "/限流/, /额度暂时用尽/),", "/限流/),"],
  ["F21 unknown 不设低上限", 'unknown: info("未识别的失败", "打开会话看原文", "UnknownEffect", "backoff", { cap: 1 }),', 'unknown: info("未识别的失败", "打开会话看原文", "UnknownEffect", "backoff"),'],
  ["F22 不会自愈的几类不标 failFast", 'session_lost: info("原会话找不到", "开新会话带交接笔记", "Permanent", "new_session_only", { fast: true }),', 'session_lost: info("原会话找不到", "开新会话带交接笔记", "Permanent", "new_session_only"),'],
  ["F23 同上游连续失败不停", 'no_response: info("上游没回应", "换上游", "Transient", "not_same_upstream", { same: true }),', 'no_response: info("上游没回应", "换上游", "Transient", "not_same_upstream"),'],
  ["F24 执行器崩溃排在上游原因前", '  rule("user_stopped", /interrupted by user/i,', '  rule("harness_crashed", /进程以 -?\\d+ 退出/),\n  rule("user_stopped", /interrupted by user/i,'],
  ["F25 只看原文前几个字", "const MATCH_CHARS = 8000;", "const MATCH_CHARS = 8;"],
  ["F26 harness 自报 kind 一律照抄", "Object.hasOwn(KIND, x.kind) ? (KIND[x.kind] ?? null) : null", 'Object.hasOwn(KIND, x.kind) ? (KIND[x.kind] ?? null) : "stalled"'],
  ["F27 归类结果不冻结", "  return Object.freeze({\n    reasonClass,", "  return ({\n    reasonClass,"],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 120_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "failure-class-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,只跑 ${TESTS.join(" ")}`);
const clean = await run(copy("clean"));
const named = new Set(clean.passed);
const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (!cleanOk) ok = false;
let killed = 0, survived = 0;
for (const [i, [name, from, to]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  const f = path.join(d, "src", FILE);
  const src = fs.readFileSync(f, "utf8");
  const n = count(src, from);
  if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次`); continue; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${kills[0]}」发现${kills.length > 1 ? `(另 ${kills.length - 1} 条)` : ""}`);
  } else {
    ok = false; survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
