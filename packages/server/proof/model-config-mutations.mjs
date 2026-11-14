// AC-32 行为变异校准(R-05 阳性埋雷):对 domain/model-config.ts、domain/model-ledger.ts、server/host.ts 的本片实现逐个注入单一故障,
// 在当前工作副本里原地改、跑对应具名测试、再 git checkout 还原;每个变异都必须让至少一条具名测试失败,注入点必须恰好出现 1 次。
// 原样代码必须全绿(阴性对照)。只能在专用克隆里跑(会原地改文件)。用法: node packages/server/proof/model-config-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const D = "packages/domain/src/";
const S = "packages/server/src/";
const DOMAIN_TESTS = [`${D}model-config.test.ts`, `${D}model-ledger.test.ts`];
const HOST_TESTS = [`${S}models.test.ts`];

const M = [
  ["MC01 继承时不用全局 Compute 默认", `${D}model-config.ts`, "    model = defaults.computeModel;\n", "    model = contact.speakingModel;\n", DOMAIN_TESTS],
  ["MC02 跟随说话模型时用了全局默认", `${D}model-config.ts`, "    model = contact.speakingModel;\n    modelSource = \"follow-speaking\";", "    model = defaults.computeModel;\n    modelSource = \"follow-speaking\";", DOMAIN_TESTS],
  ["MC03 忽略任务覆盖", `${D}model-config.ts`, "if (override && nonEmpty(override.model)) {", "if (false) {", DOMAIN_TESTS],
  ["MC04 Compute 槽位 effort 不生效", `${D}model-config.ts`, "    effort = slot.effort;\n", "    effort = defaults.effort;\n", DOMAIN_TESTS],
  ["MC05 不兼容时静默退回 Harness 默认模型", `${D}model-config.ts`, "  if (s !== \"unsupported\") return freeze({ ok: true, support: s, resolved });\n", "  if (s !== \"unsupported\") return freeze({ ok: true, support: s, resolved });\n  { const fb = caps.find((c) => c.harnesses.includes(resolved.harness))?.id; if (fb) return freeze({ ok: true, support: \"supported\", resolved: { ...resolved, model: fb } }); }\n", DOMAIN_TESTS],
  ["MC06 未声明的模型当作不支持", `${D}model-config.ts`, "  if (!decl) return \"undeclared\";", "  if (!decl) return \"unsupported\";", DOMAIN_TESTS],
  ["MC07 不给「更换 Harness」这条修复路径", `${D}model-config.ts`, "    { kind: \"change-harness\", candidates: [...harnesses] },\n", "", DOMAIN_TESTS],
  ["MC08 预览漏掉下游继承者", `${D}model-config.ts`, "    if (changed.length === 0 && !explicit) continue;", "    if (!explicit) continue;", DOMAIN_TESTS],
  ["MC09 批量替换误改固定在其他模型上的覆盖值", `${D}model-config.ts`, "const pinned = slot.mode === \"explicit\" && slot.model === change.from;", "const pinned = slot.mode === \"explicit\";", DOMAIN_TESTS],
  ["MC10 批量替换把继承者写成具体模型", `${D}model-config.ts`, "    if (!speaks && !pinned) return { next: c, explicit: false };", "    if (!speaks && !pinned) return { next: { ...c, computeModel: { mode: \"explicit\", model: change.to } }, explicit: false };", DOMAIN_TESTS],
  ["MC11 压缩允许换成别的模型", `${D}model-config.ts`, "  if (requestedModel === want) return { ok: true };", "  return { ok: true };", DOMAIN_TESTS],
  ["MC12 预览改了入参", `${D}model-config.ts`, "  if (change.kind === \"defaults\") return { ...d, ...stripUndefined(change.patch) };", "  if (change.kind === \"defaults\") return Object.assign(d, stripUndefined(change.patch));", DOMAIN_TESTS],
  ["ML01 每次追加都覆写启动快照", `${D}model-ledger.ts`, "const initial = rec.initial ?? {", "const initial = {", DOMAIN_TESTS],
  ["ML02 账本只留最后一条", `${D}model-ledger.ts`, "attempts: [...rec.attempts, entry]", "attempts: [entry]", DOMAIN_TESTS],
  ["ML03 厂商集合只记末次", `${D}model-ledger.ts`, "return Object.freeze([...new Set(rec.attempts.map((a) => a.vendor))]);", "return Object.freeze(rec.attempts.slice(-1).map((a) => a.vendor));", DOMAIN_TESTS],
  ["ML04 守卫不查启动快照", `${D}model-ledger.ts`, "  if (prev.initial && JSON.stringify(prev.initial) !== JSON.stringify(next.initial)) return false;\n", "", DOMAIN_TESTS],
  ["H01 保存时不拦冲突", `${S}host.ts`, "    if (conflicts.length === 0 || confirmed) return;", "    return;", HOST_TESTS],
  ["H02 确认后仍拒绝", `${S}host.ts`, "    if (conflicts.length === 0 || confirmed) return;", "    if (conflicts.length === 0) return;", HOST_TESTS],
  ["H03 启动前不校验", `${S}host.ts`, "      if (!chk.ok) {\n        this.report(\"model-incompatible\"", "      if (false) {\n        this.report(\"model-incompatible\"", HOST_TESTS],
  ["H04 批量替换追溯改写在途任务快照", `${S}host.ts`, "        touched.push(next);\n      }\n", "        touched.push(next);\n      }\n      for (const t of listDocs<TaskDoc>(this.db, \"task:\")) if (t.value.models?.initial) putDoc(this.db, t.key, t.ver, { ...t.value, models: { ...t.value.models, initial: { ...t.value.models.initial, model: to } } });\n", HOST_TESTS],
  ["H05 不带 apply 也落盘", `${S}host.ts`, "    if (o.apply !== true) return { applied: false, preview };\n", "", HOST_TESTS],
  ["H06 启动不写快照与账本", `${S}host.ts`, "requestId: e.requestId }, { models });", "requestId: e.requestId }, {});", HOST_TESTS],
  ["H07 联系人视图支持性写死", `${S}host.ts`, "support: modelConfig.supportOf(this.caps(), resolved.harness, resolved.model) },", "support: \"supported\" as const },", HOST_TESTS],
  ["H08 改全局默认不预检", `${S}host.ts`, "    if (patch.defaultHarness !== undefined || patch.defaultSpeakingModel !== undefined || patch.defaultComputeModel !== undefined || patch.defaultEffort !== undefined || patch.models !== undefined) {", "    if (false) {", HOST_TESTS],
  ["H09 改联系人不预检", `${S}host.ts`, "    if (patch.speakingModel !== undefined || patch.harness !== undefined || patch.computeModel !== undefined) {", "    if (false) {", HOST_TESTS],
  ["H10 新建联系人不预检", `${S}host.ts`, "    this.guardModelChange(modelConfig.previewChange(this.modelDefaults(), [this.contactModels(doc)], this.caps(), { kind: \"contact\", contactId: id, patch: {} }), input.confirmAffected === true);\n", "", HOST_TESTS],
  ["H11 确认标记落进联系人档案", `${S}host.ts`, "    const { confirmAffected, ...patch } = input;\n    const cur = this.contactDoc(id);", "    const { confirmAffected } = input; const patch = input;\n    const cur = this.contactDoc(id);", HOST_TESTS],
  ["H12 记录的 Harness 写死", `${S}host.ts`, "    const harness = resolved?.harness ?? \"claude-code\";", "    const harness = \"codex\";", HOST_TESTS],
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
const base = run([...DOMAIN_TESTS, ...HOST_TESTS]);
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
fs.writeFileSync(path.join(import.meta.dirname, "model-config-mutations.txt"), `${out.join("\n")}\n`);
process.exit(ok ? 0 : 1);
