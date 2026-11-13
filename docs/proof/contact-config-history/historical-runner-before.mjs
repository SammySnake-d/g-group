// 一次一个单点变异。原样全绿、具名 AssertionError 才算杀死;超时/加载失败不算。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = process.cwd();
const tmp = mkdtempSync(path.join(os.tmpdir(), "gg-config-mut-"));
const H = "packages/server/src/host.ts";
const C = "packages/server/src/contact-config-history.ts";
const test = "packages/server/src/contact-config-history.test.ts";
const edit = (file, from, to) => ({ file, from, to });
const mutants = [
  ["M01 创建快照漏记", "CFG01", [edit(H, '      recordContactConfig(this.db, id, version, doc, "create", this.now());', '      void version;')]],
  ["M02 回滚不恢复配置", "CFG02", [edit(H, '      const next: ContactDoc = { ...current.value, ...historical.config };', '      const next: ContactDoc = { ...current.value };')]],
  ["M03 回滚跳过 CAS", "CFG03", [edit(H, '      if (input.expectedVersion !== current.ver) throw new HostError("conflict", "联系人配置已更新,请重新读取", { currentVersion: current.ver });', '')]],
  ["M04 更新跳过重复动作回放", "CFG04", [edit(H, '      if (replay) return { view: replay.result, replay: true };', '      void replay;')]],
  ["M05 回滚不存动作结果", "CFG05", [edit(H, '      rememberConfigAction(this.db, input.contactId, input.clientActionId, request, result);', '')]],
  ["M06 回滚不重新预检模型", "CFG06", [edit(H, '      this.guardContactConfig(next, input.confirmAffected === true);', '')]],
  ["M07 更新配置与历史不在同一事务", "CFG07", [edit(H, '    const changed = tx(this.db, () => {\n      const cur = this.activeContactDoc(id);', '    const changed = (() => {\n      const cur = this.activeContactDoc(id);'), edit(H, '    });\n    if (!changed.replay) this.bus.emit({ type: "contact.updated", contact: changed.view });', '    })();\n    if (!changed.replay) this.bus.emit({ type: "contact.updated", contact: changed.view });')]],
  ["M08 批量替换不追加配置历史", "CFG08", [edit(H, '        recordContactConfig(this.db, m.id, version, next, "batch", this.now());', '')]],
  ["M09 分页包含上页最后一条", "CFG09", [edit(C, 'WHERE contact_id = ? AND version < ? ORDER BY version DESC LIMIT ?', 'WHERE contact_id = ? AND version <= ? ORDER BY version DESC LIMIT ?')]],
  ["M10 既有联系人不登记当前基线", "CFG10", [edit(C, '      recordContactConfig(db, row.value.id, row.ver, row.value, "baseline", now);', '')]],
  ["M11 历史允许原位更新", "CFG11", [edit(C, "CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_update BEFORE UPDATE ON gg_contact_config_versions BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;", '')]],
  ["M12 已删除联系人也能回滚", "CFG12", [edit(H, '    if ((current.value as ContactDoc & { removed?: boolean }).removed) throw new HostError("not_found", `没有联系人 ${id}`);', '')]],
  ["M13 历史允许物理删除", "CFG11", [edit(C, "CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_delete BEFORE DELETE ON gg_contact_config_versions BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;", '')]],
  ["M14 同一动作号换参数仍重放", "CFG05", [edit(C, '  if (row.request !== canonical(request)) throw new HostError("conflict", "同一配置动作号已用于不同请求");', '')]],
  ["M15 修改配置不追加历史", "CFG01", [edit(H, '      recordContactConfig(this.db, id, version, next, "update", this.now());', '')]],
];
function execute() {
  const r = spawnSync(process.execPath, ["--test", test], { cwd: tmp, encoding: "utf8", timeout: 60_000, maxBuffer: 12 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = [...text.matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)(?=^# Subtest:|^1\.\.)/gm)].map((m) => ({ name: m[1], assertion: /code: 'ERR_ASSERTION'/.test(m[2]) }));
  return { status: r.status, signal: r.signal, error: r.error?.message ?? null, total: Number(text.match(/^# tests (\d+)$/m)?.[1] ?? 0), pass: Number(text.match(/^# pass (\d+)$/m)?.[1] ?? 0), failed, text };
}
try {
  for (const dir of ["packages", "third_party"]) if (existsSync(path.join(source, dir))) cpSync(path.join(source, dir), path.join(tmp, dir), { recursive: true });
  cpSync(path.join(source, "package.json"), path.join(tmp, "package.json"));
  // 硬链接普通依赖,保留 @g-group 相对链接指向本变异副本。
  const deps = spawnSync("cp", ["-al", path.join(source, "node_modules"), path.join(tmp, "node_modules")], { encoding: "utf8" });
  if (deps.status !== 0) throw new Error(`依赖复制失败:${deps.stderr}`);
  const logDir = path.join(source, "packages/server/proof/contact-config-history-mutation-logs");
  mkdirSync(logDir, { recursive: true });
  const baseline = execute();
  writeFileSync(path.join(logDir, "baseline.tap"), baseline.text);
  console.log(JSON.stringify({ baseline: { status: baseline.status, total: baseline.total, pass: baseline.pass, failed: baseline.failed, error: baseline.error } }));
  if (baseline.status !== 0 || baseline.total !== 12 || baseline.pass !== 12) throw new Error("原样对照不是 12/12,不评变异");
  const originals = new Map([H, C].map((file) => [file, readFileSync(path.join(tmp, file), "utf8")]));
  const results = [];
  for (const [name, criterion, edits] of mutants) {
    for (const [file, text] of originals) writeFileSync(path.join(tmp, file), text);
    for (const { file, from, to } of edits) {
      const p = path.join(tmp, file); const text = readFileSync(p, "utf8");
      if (text.split(from).length !== 2) throw new Error(`变异锚点不是唯一:${name}:${from}`);
      writeFileSync(p, text.replace(from, to));
    }
    const r = execute();
    writeFileSync(path.join(logDir, `${name.split(" ")[0]}.tap`), r.text);
    const killed = r.status === 1 && r.total === 12 && r.error === null && r.failed.some((x) => x.name.startsWith(criterion) && x.assertion);
    const result = { name, criterion, killed, status: r.status, total: r.total, failures: r.failed, other_criteria_failures: r.failed.filter((x) => !x.name.startsWith(criterion)), error: r.error };
    results.push(result); console.log(JSON.stringify(result));
  }
  const summary = { mutants: results.length, killed: results.filter((x) => x.killed).length, survivedOrInvalid: results.filter((x) => !x.killed).length, baseline: { total: 12, pass: 12 }, results };
  writeFileSync(path.join(source, "packages/server/proof/contact-config-history-mutations.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survivedOrInvalid: summary.survivedOrInvalid }));
  process.exitCode = summary.survivedOrInvalid ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
