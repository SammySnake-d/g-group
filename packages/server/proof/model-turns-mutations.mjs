// AC-51 宿主侧行为变异校准(R-05 阳性埋雷):对 server/host.ts 里每轮生效模型、按 Harness 复用适配器、切换失败与账本的实现逐个注入单一故障,
// 在当前工作副本里原地改、跑对应具名测试、再 git checkout 还原;每个变异都必须让至少一条具名测试失败,注入点必须恰好出现 1 次。
// 原样代码必须全绿(阴性对照)。只能在专用克隆里跑(会原地改文件)。用法: node packages/server/proof/model-turns-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const D = "packages/domain/src/";
const S = "packages/server/src/";
const DOMAIN_TESTS = [`${D}model-config.test.ts`, `${D}model-ledger.test.ts`];
const HOST_TESTS = [`${S}model-turns.test.ts`];

const M = [
  ["T01 续接不带这一轮的模型", `${S}host.ts`, "(e.computeId, e.text, turn);", "(e.computeId, e.text);", HOST_TESTS],
  ["T02 续接带会话启动时的模型", `${S}host.ts`, "resolved ? { model: resolved.model, effort: resolved.effort } : undefined;", "resolved ? { model: row.model, effort: resolved.effort } : undefined;", HOST_TESTS],
  ["T03 适配器按模型另建实例", `${S}host.ts`, "this.adapters.set(isModelAware(a) ? harness : `${harness}:${model}`, a);", "this.adapters.set(`${harness}:${model}`, a);", HOST_TESTS],
  ["T13 旧适配器模型变了仍送进旧进程", `${S}host.ts`, "      if (!isModelAware(a) && resolved.model !== row.model) {", "      if (false) {", HOST_TESTS],
  ["T14 旧适配器也按 Harness 复用(新模型落进旧进程环境)", `${S}host.ts`, "this.adapters.set(isModelAware(a) ? harness : `${harness}:${model}`, a);", "this.adapters.set(harness, a);", HOST_TESTS],
  ["T04 首轮不带生效模型", `${S}host.ts`, "...(modelAware ? { model,", "...(false ? { model,", HOST_TESTS],
  ["T05 切换失败静默吞掉", `${S}host.ts`, "if (r.code === \"model-switch-failed\") return this.turnRefused(", "if (r.code === \"model-switch-failed\") return; void this.turnRefused(", HOST_TESTS],
  ["T06 切换失败后退回旧模型重发", `${S}host.ts`, "if (r.code === \"model-switch-failed\") return this.turnRefused(", "if (r.code === \"model-switch-failed\") { await (a.resume as (id: string, text: string, turn?: TurnModel) => Promise<unknown>)(e.computeId, e.text, { model: row.model }); return; } void this.turnRefused(", HOST_TESTS],
  ["T07 每轮不记账本", `${S}host.ts`, "      tx(this.db, () => this.recordTurnTx(e.taskId, e.computeId, row.harness, resolved.model, resolved.effort, reason));\n", "", HOST_TESTS],
  ["T08 续接前不校验兼容", `${S}host.ts`, "      if (!chk.ok) return this.turnRefused(e.taskId, e.computeId, row, chk.reason);\n", "", HOST_TESTS],
  ["T09 harness 回报的实际模型不进账本", `${S}host.ts`, "          this.recordTurnTx(row.task_id, ev.computeId, row.harness, m, last?.effort ?? this.settings().defaultEffort, \"observed\");\n", "", HOST_TESTS],
  ["T10 状态机生产模型集合不同步", `${S}host.ts`, "      if (o.ok) task = o.task;\n", "      if (o.ok) void o;\n", HOST_TESTS],
  ["T11 没送进去的一轮不告诉联系人", `${S}host.ts`, "      run(this.db, \"INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)\", row.contact_id, row.room_id, JSON.stringify(payload), at);\n    });\n    this.bus.emit({ type: \"compute.progress\", progress: { computeId, taskId, kind: \"blocked\"", "    });\n    this.bus.emit({ type: \"compute.progress\", progress: { computeId, taskId, kind: \"blocked\"", HOST_TESTS],
  ["T12 先记账本再送(被拒的一轮也进账本)", `${S}host.ts`, "    const r = await (a.resume as", "    if (resolved) tx(this.db, () => this.recordTurnTx(e.taskId, e.computeId, row.harness, resolved.model, resolved.effort, reason));\n    const r = await (a.resume as", HOST_TESTS],
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
fs.writeFileSync(path.join(import.meta.dirname, "model-turns-mutations.txt"), `${out.join("\n")}\n`);
process.exit(ok ? 0 : 1);
