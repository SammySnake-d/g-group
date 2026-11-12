// U33 pi 联系人四协议的行为变异校准(R-05 阳性埋雷):按 D07 §2「pi-ai 是四协议统一通信层」与 U33 的验收要点,
// 逐个注入单一故障,在隔离副本里只跑 src/protocols.test.ts;每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死),
// 注入点必须恰好出现 1 次。原样副本必须全绿(阴性对照)。并发 1。
// 用法: node packages/adapter-pi-contact/proof/pi-protocols-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TESTS = ["src/protocols.test.ts"];
const MIND = "src/mind.ts";
const PROTOS = "src/protocols.ts";
const COMPACT = "src/compact.ts";

const M = [
  ["P01 协议判断去掉:一律走 anthropic-messages 的适配器(其它协议发不出请求)", MIND, "  const api = PROTOCOLS[cfg.protocol].load();", '  const api = PROTOCOLS["anthropic-messages"].load();'],
  ["P02 工具声明不进请求(转换结果被丢掉,模型看不到任何工具)", MIND, "toolsAdded: declarations,", "toolsAdded: [],"],
  ["P03 工具结果不回填(同一轮第二次请求里没有 tool_result / role:tool / function_call_output)", MIND, '      else if (m.role === "toolResult") exchange.push(m);', '      else if (m.role === "__none__") exchange.push(m);'],
  ["P04 缓存断点不看协议(非 anthropic 也按 cacheRetention 发缓存字段)", MIND, 'cacheRetention: cfg.protocol === "anthropic-messages" && b1.cacheBreakpoint ? cfg.cacheRetention : "none",', 'cacheRetention: b1.cacheBreakpoint ? cfg.cacheRetention : "none",'],
  ["P05 上游错误体不隐去密钥(错误信息里带明文密钥)", MIND, 'throw new PiContactMindError("provider-error", redact(`模型请求失败(${end.stopReason}):${end.errorMessage ?? "无错误信息"}`));', 'throw new PiContactMindError("provider-error", `模型请求失败(${end.stopReason}):${end.errorMessage ?? "无错误信息"}`);'],
  ["P06 密钥的兜底分支用错:不发 apiKey、改发 Authorization(google 拿不到 x-goog-api-key)", PROTOS, "  return { apiKey };\n}", "  return { headers: { authorization: `Bearer ${apiKey}` } };\n}"],
  ["P07 密钥头不按协议收窄(给 google 配 bearer、给 anthropic 配 x-goog-api-key 都放行)", PROTOS, 'if (typeof value !== "string" || !(spec.authHeaders as readonly string[]).includes(value))', 'if (typeof value !== "string")'],
  ["P08 openai 兼容口的端点根不补 /v1(请求打到 /chat/completions)", PROTOS, 'if (protocol === "anthropic-messages" || protocol === "google-generative-ai") return baseUrl;', 'if (protocol !== "openai-responses") return baseUrl;'],
  ["P09 模型名里的 gemini 前缀认不出(落到 anthropic-messages 默认)", PROTOS, 'if (head === "google" || head === "gemini" || head.startsWith("gemini-")) return "google-generative-ai";', 'if (head === "google") return "google-generative-ai";'],
  ["P10 压缩器不按协议(压缩请求也打到 anthropic-messages 的端点)", COMPACT, "  const api = PROTOCOLS[cfg.protocol].load();", '  const api = PROTOCOLS["anthropic-messages"].load();'],
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-protocols-mut-"));
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
for (const [i, [name, file, from, to]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  const f = path.join(d, file);
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
