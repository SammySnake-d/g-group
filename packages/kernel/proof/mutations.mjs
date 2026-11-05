// 行为变异校准(R-05 阳性埋雷):对 kernel 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。注入点必须在源码里恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。
// 用法: node packages/kernel/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["K01 允许重复 id", "plugins.ts", 'if (taken.has(c.id)) return reject("duplicate-id", c.id);', ""],
  ["K02 放行插件声明定时", "plugins.ts", 'if ("schedule" in c || "cron" in c) return reject("schedule-not-allowed", SCHEDULE_REASON);', ""],
  ["K03 放行插件互相依赖", "plugins.ts", 'if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return reject("plugin-dependency-not-allowed", "插件只能依赖宿主接口,不能依赖其他插件");', ""],
  ["K04 Page-in 改成取最近 N 条", "assemble.ts", "return all.find((m) => m.seq === seq);", "return all.slice(-3).find((m) => m.seq === seq);"],
  ["K05 超预算静默截断", "assemble.ts", 'if (need > opts.budgetBytes) return { ok: false, reason: "over-budget", need, budget: opts.budgetBytes };', "while (chunks.length > 0 && chunks.reduce((a, c) => a + c.entry.bytes, 0) > opts.budgetBytes) chunks.shift();"],
  ["K06 窗口内引用重复页入", "assemble.ts", "if (inWindow.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (paged.some((p) => p.seq === seq)) continue;"],
  ["K07a 撤回消息被引用时仍页入", "assemble.ts", 'if (m.retracted) { skipped.push({ seq, reason: "retracted" }); continue; }', ""],
  ["K07b 撤回消息进窗口", "assemble.ts", "const visible = all.filter((m) => !m.retracted);", "const visible = all;"],
  ["K08 带 @ 也调分类器", "classify.ts", "const cues = mechanicalCues(event);", "const cues = mechanicalCues(event);\n  classifier(event);"],
  ["K09 分类器自由文本被放行", "classify.ts", 'if (typeof raw === "string" && ALLOWED.has(raw))', 'if (typeof raw === "string")'],
  ["K10 外部内容不标不可信", "plugins.ts", 'content: String(m.content), trust: "untrusted" };', 'content: String(m.content), trust: (m as { trust?: string }).trust ?? "untrusted" } as ExternalEnvelope;'],
  ["K11 发送不要求 action_id", "plugins.ts", 'if (typeof actionId !== "string" || actionId === "") return { ok: false, reason: "missing-action-id", detail: "外发动作必须带 action_id,宿主按它幂等" };', ""],
  ["K12 同一 action_id 重复真发", "plugins.ts", "if (prior) return { ok: true, receipt: prior, deduplicated: true };", ""],
  ["K13 版本号不算机械线索", "classify.ts", 'if (typeof e.version === "number" && Number.isFinite(e.version)) cues.push("version");', ""],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, encoding: "utf8" });
  const out = r.stdout ?? "";
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
let ok = true;
const clean = run(copy("clean"));
const named = new Set(clean.passed);
console.log(`${clean.code === 0 && clean.failed.length === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0 || clean.failed.length > 0 || clean.passed.length === 0) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const n = count(src, from);
  if (n !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${n} 次,必须恰好 1 次(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  // 只有原样副本里通过的具名测试变红才算杀死;文件级失败(测试名是文件路径或不在名单里)不算
  const kills = r.failed.filter((t) => named.has(t));
  const killed = kills.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${kills[0]}」发现` : ",存活(或只有文件级失败)"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
