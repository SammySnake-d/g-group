// AC-51 接线行为变异校准(R-05 阳性埋雷):对 server/compute.ts 与 host.ts 关闭逻辑逐个注入单一故障,
// 在当前工作副本里原地改、跑对应具名测试、再 git checkout 还原;每个变异都必须让至少一条具名测试失败,注入点必须恰好出现 1 次。
// 原样代码必须全绿(阴性对照)。只能在专用克隆里跑(会原地改文件)。用法: node packages/server/proof/model-hotswap-wire-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const D = "packages/domain/src/";
const S = "packages/server/src/";
const DOMAIN_TESTS = [`${D}model-config.test.ts`, `${D}model-ledger.test.ts`];
const HOST_TESTS = [`${S}compute.test.ts`];

const M = [
  ["W01 模型写进进程环境", `${S}compute.ts`, "    if (v) hostEnv[k] = v;\n  }\n", "    if (v) hostEnv[k] = v;\n  }\n  if (env.ANTHROPIC_MODEL) hostEnv.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL;\n", HOST_TESTS],
  ["W02 整份环境透传", `${S}compute.ts`, "  const hostEnv: Record<string, string> = {};", "  const hostEnv: Record<string, string> = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === \"string\"));", HOST_TESTS],
  ["W03 不设空闲回收", `${S}compute.ts`, "  return { hostEnv, idleReclaimMs };", "  return { hostEnv, idleReclaimMs: 0 };", HOST_TESTS],
  ["W04 回到一次性适配器", `${S}compute.ts`, "  return () => createResidentComputeAdapter(opts);", "  return () => { const a = createResidentComputeAdapter(opts); return { ...a, capabilities: undefined, steer: undefined } as unknown as ComputeAdapter; };", HOST_TESTS],
  ["W05 关闭时只停在跑的", `${S}host.ts`, "const statuses = isModelAware(a) ? \"('starting','running','blocked','completed')\" : \"('starting','running')\";", "const statuses = \"('starting','running')\";", HOST_TESTS],
  ["W06 回收阈值改小", `${S}compute.ts`, "export const CLAUDE_IDLE_RECLAIM_MS = 600_000;", "export const CLAUDE_IDLE_RECLAIM_MS = 60_000;", HOST_TESTS],
];

function run(files) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}
const restore = (f) => spawnSync("git", ["checkout", "--", f], { cwd: ROOT });

const out = [];
const log = (s) => { out.push(s); console.log(s); };
let ok = true;
const base = run(HOST_TESTS);
log(`基线(原样代码):通过 ${base.passed.length},失败 ${base.failed.length}`);
if (base.failed.length || base.code !== 0) { ok = false; log(`  基线不绿:${base.failed.join(" | ")}`); }
let killed = 0;
for (const [name, file, from, to, tests] of M) {
  const abs = path.join(ROOT, file);
  const src = fs.readFileSync(abs, "utf8");
  const n = src.split(from).length - 1;
  if (n !== 1) { ok = false; log(`✗ ${name}:注入点出现 ${n} 次(应恰好 1 次)`); continue; }
  fs.writeFileSync(abs, src.replace(from, to));
  try {
    const r = run(tests);
    if (r.failed.length > 0) { killed++; log(`✓ ${name} 被杀死:${r.failed.join(" | ")}`); }
    else { ok = false; log(`✗ ${name} 存活(退出码 ${r.code},通过 ${r.passed.length})`); }
  } finally { restore(file); }
}
log(`变异 ${M.length} 个,杀死 ${killed},存活 ${M.length - killed}`);
fs.writeFileSync(path.join(import.meta.dirname, "model-hotswap-wire-mutations.txt"), `${out.join("\n")}\n`);
process.exit(ok ? 0 : 1);
