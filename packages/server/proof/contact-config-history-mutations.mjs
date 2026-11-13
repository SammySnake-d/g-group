// 一次一个单点变异；完整套件、精确具名 testCodeFailure/ERR_ASSERTION 才算 kill。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const source = path.resolve(import.meta.dirname, "../../..");
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

// R1 反例追加；上面的原 M01–M15 定义逐字节保留。
const FOLLOWUP = [
  ["M16 历史允许覆盖插入", "CFG13", [edit(C, `  CREATE TRIGGER IF NOT EXISTS gg_contact_config_no_overwrite BEFORE INSERT ON gg_contact_config_versions
    WHEN EXISTS (SELECT 1 FROM gg_contact_config_versions WHERE contact_id = NEW.contact_id AND version = NEW.version)
    BEGIN SELECT RAISE(ABORT, 'contact config history immutable'); END;
`, "")]],
  ["M17 回滚配置与历史不在同一事务", "CFG14", [
    edit(H, '  rollbackContact(input: { contactId: string; version: number; expectedVersion: number; clientActionId: string; confirmAffected?: boolean }) {\n    const changed = tx(this.db, () => {\n      const current = this.activeContactDoc(input.contactId);', '  rollbackContact(input: { contactId: string; version: number; expectedVersion: number; clientActionId: string; confirmAffected?: boolean }) {\n    const changed = (() => {\n      const current = this.activeContactDoc(input.contactId);'),
    edit(H, '      return { result, replay: false };\n    });\n    if (!changed.replay) this.bus.emit({ type: "contact.updated", contact: changed.result.contact });', '      return { result, replay: false };\n    })();\n    if (!changed.replay) this.bus.emit({ type: "contact.updated", contact: changed.result.contact });'),
  ]],
  ["M18 回滚只恢复部分配置字段", "CFG15", [edit(H, '      const next: ContactDoc = { ...current.value, ...historical.config };', '      const next: ContactDoc = { ...current.value, ...historical.config, tools: current.value.tools, computeAssets: current.value.computeAssets, computeSlots: current.value.computeSlots, bio: current.value.bio, avatar: current.value.avatar, speakingModel: current.value.speakingModel, harness: current.value.harness };')]],
  ["M19 配置快照落盘整个联系人文档", "CFG16", [edit(C, 'JSON.stringify(contactConfigOf(value))', 'JSON.stringify(value)')]],
];
export const MUTANTS = [...mutants, ...FOLLOWUP];
const RUNNER = "packages/server/proof/contact-config-history-mutations.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const countFields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const inside = (root, candidate) => { const r = path.relative(root, candidate); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); };

export function parseTap(text) {
  const countMatches = Object.fromEntries(countFields.map((k) => [k, [...text.matchAll(new RegExp(`^# ${k} (\\d+)$`, "gm"))].map((m) => Number(m[1]))]));
  const counts = Object.fromEntries(countFields.map((k) => [k, countMatches[k].length === 1 ? countMatches[k][0] : null]));
  const starts = [...text.matchAll(/^(not ok|ok) (\d+) - (.+)$/gm)];
  const records = starts.map((m) => {
    const end = Math.min(...[text.indexOf("\n# Subtest:", m.index), text.indexOf("\n1..", m.index), text.length].filter((n) => n >= m.index));
    const diagnostic = text.slice(m.index, end);
    const field = (k) => diagnostic.match(new RegExp(`^\\s+${k}: ['\"]([^'\"]+)['\"]\\s*$`, "m"))?.[1] ?? null;
    return { number: Number(m[2]), name: m[3], ok: m[1] === "ok", code: field("code"), failureType: field("failureType"), assertion: field("code") === "ERR_ASSERTION", testCodeFailure: field("failureType") === "testCodeFailure", diagnostic };
  });
  const plans = [...text.matchAll(/^1\.\.(\d+)$/gm)].map((m) => Number(m[1]));
  return { ...counts, total: counts.tests, countMatches, plans, records, passed: records.filter((r) => r.ok).map((r) => r.name), failed: records.filter((r) => !r.ok) };
}

export function assessRun(run, { suiteTests, titles, criterion = null }) {
  const parsed = run.parsed ?? parseTap(run.text ?? "");
  const reasons = [];
  if (run.signal !== null) reasons.push("signal");
  if (run.error !== null) reasons.push("spawn-error");
  if (run.timedOut !== false) reasons.push("timeout-or-unknown");
  if (run.status !== 0 && run.status !== 1) reasons.push("status");
  if (countFields.some((k) => parsed.countMatches[k].length !== 1)) reasons.push("missing-or-duplicate-count");
  if (parsed.tests !== suiteTests || parsed.pass + parsed.fail !== suiteTests) reasons.push("suite-count");
  if (["cancelled", "skipped", "todo"].some((k) => parsed[k] !== 0)) reasons.push("skip-cancel-todo");
  if (parsed.plans.length !== 1 || parsed.plans[0] !== suiteTests) reasons.push("plan");
  if (parsed.records.length !== suiteTests || parsed.passed.length !== parsed.pass || parsed.failed.length !== parsed.fail) reasons.push("record-count");
  if (titles.length !== suiteTests || new Set(titles).size !== suiteTests) reasons.push("title-calibration");
  if (new Set(parsed.records.map((r) => r.name)).size !== suiteTests || parsed.records.some((r) => !titles.includes(r.name))) reasons.push("registered-name-mismatch");
  if (new Set(parsed.records.map((r) => r.number)).size !== suiteTests || parsed.records.some((r) => r.number < 1 || r.number > suiteTests)) reasons.push("numbering");
  if ((run.status === 0 && parsed.fail !== 0) || (run.status === 1 && parsed.fail < 1)) reasons.push("status-count-mismatch");
  const criterionMatches = criterion === null ? [] : titles.filter((name) => name.startsWith(`${criterion} `));
  const expectedName = criterionMatches.length === 1 ? criterionMatches[0] : null;
  const named = expectedName === null ? [] : parsed.failed.filter((r) => r.name === expectedName);
  const completeSuite = reasons.length === 0;
  const killed = criterion !== null && completeSuite && run.status === 1 && criterionMatches.length === 1 && named.length === 1 && named[0].assertion && named[0].testCodeFailure;
  const survived = completeSuite && run.status === 0;
  return { ...parsed, completeSuite, invalidReasons: reasons, criterion, criterionMatches, expectedName, criterionPresent: expectedName !== null, killed, survived, classification: killed ? "killed" : survived ? "survived" : "invalid", other_criteria_failures: parsed.failed.filter((r) => r.name !== expectedName) };
}

// 纯解析器控制：不启动产品/测试进程，不创建变异副本。
export function parserCalibration() {
  const titles = Array.from({ length: 16 }, (_, i) => `CFG${String(i + 1).padStart(2, "0")} parser fixture`);
  function fixture(options = {}) {
    const names = options.names ?? titles; const failAt = options.failAt ?? 13;
    let text = "TAP version 13\n";
    for (let i = 0; i < names.length; i++) {
      const failed = i === failAt;
      text += `# Subtest: ${names[i]}\n${failed ? "not ok" : "ok"} ${i + 1} - ${names[i]}\n`;
      if (failed) text += `  ---\n  failureType: '${options.failureType ?? "testCodeFailure"}'\n  code: '${options.code ?? "ERR_ASSERTION"}'\n  ...\n`;
    }
    const failures = failAt >= 0 && failAt < names.length ? 1 : 0;
    text += `1..${names.length}\n# tests ${names.length}\n# pass ${names.length - failures}\n# fail ${failures}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
    return { status: failures ? 1 : 0, signal: null, error: null, timedOut: false, text };
  }
  const good = fixture();
  const rows = [];
  const check = (name, run, opts, expected) => {
    const got = assessRun(run, { suiteTests: 16, titles, criterion: "CFG14", ...opts });
    const pass = Object.entries(expected).every(([k, v]) => got[k] === v);
    rows.push({ name, pass, expected, observed: { killed: got.killed, survived: got.survived, completeSuite: got.completeSuite, classification: got.classification, invalidReasons: got.invalidReasons, expectedName: got.expectedName } });
  };
  check("complete named assertion", good, {}, { killed: true, completeSuite: true });
  check("green complete suite is survivor", fixture({ failAt: -1 }), {}, { killed: false, survived: true });
  check("signal cannot kill", { ...good, signal: "SIGTERM" }, {}, { killed: false, completeSuite: false });
  check("spawn error cannot kill", { ...good, error: "spawn EIO" }, {}, { killed: false, completeSuite: false });
  check("process timeout cannot kill", { ...good, timedOut: true }, {}, { killed: false, completeSuite: false });
  check("test timeout is not testCodeFailure", fixture({ failureType: "testTimeoutFailure" }), {}, { killed: false });
  check("no counts cannot kill", { ...good, text: good.text.replace(/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+\n/gm, "") }, {}, { killed: false, completeSuite: false });
  check("missing one count cannot kill", { ...good, text: good.text.replace(/^# fail 1\n/m, "") }, {}, { killed: false, completeSuite: false });
  check("duplicate count cannot kill", { ...good, text: `${good.text}# tests 16\n` }, {}, { killed: false, completeSuite: false });
  check("wrong designated criterion cannot kill", good, { criterion: "CFG15" }, { killed: false });
  check("wrong criterion prefix cannot kill", good, { criterion: "CFG1" }, { killed: false });
  check("non assertion cannot kill", fixture({ code: "ERR_TEST_FAILURE" }), {}, { killed: false });
  check("missing failureType cannot kill", { ...good, text: good.text.replace(/^\s+failureType: .+\n/m, "") }, {}, { killed: false });
  for (const k of ["skipped", "cancelled", "todo"]) check(`${k} cannot kill`, { ...good, text: good.text.replace(`# ${k} 0\n`, `# ${k} 1\n`) }, {}, { killed: false, completeSuite: false });
  check("partial suite cannot kill", fixture({ names: titles.slice(0, 15) }), {}, { killed: false, completeSuite: false });
  check("wrong pass/fail sum cannot kill", { ...good, text: good.text.replace("# pass 15\n", "# pass 16\n") }, {}, { killed: false, completeSuite: false });
  const duplicateNames = [...titles]; duplicateNames[14] = duplicateNames[13];
  check("duplicate registered title cannot kill", fixture({ names: duplicateNames }), { titles: duplicateNames }, { killed: false, completeSuite: false });
  const oldTitles = titles.slice(0, 13);
  check("old thirteen green with absent CFG14 is survivor", fixture({ names: oldTitles, failAt: -1 }), { suiteTests: 13, titles: oldTitles }, { killed: false, survived: true, completeSuite: true });
  check("status null cannot kill", { ...good, status: null }, {}, { killed: false, completeSuite: false });
  return { passed: rows.every((r) => r.pass), cases: rows.length, rows, productProcessesStarted: 0, mutationCopiesCreated: 0 };
}

const hashFiles = (root) => Object.fromEntries([H, C, test, RUNNER, "package.json", "package-lock.json", "tsconfig.json"].filter((f) => existsSync(path.join(root, f))).map((f) => [f, sha(readFileSync(path.join(root, f)))]));
const sameHashes = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function checkAnchors(files, selected = MUTANTS) {
  return selected.map(([name, criterion, edits]) => {
    const work = new Map(Object.entries(files));
    const counts = edits.map(({ file, from, to }) => {
      const text = work.get(file); if (typeof text !== "string") throw new Error(`锚点缺文件:${file}`);
      const count = text.split(from).length - 1;
      if (count === 1) work.set(file, text.replace(from, to));
      return { file, count, fromSha256: sha(from), toSha256: sha(to) };
    });
    return { name, criterion, counts, unique: counts.every((c) => c.count === 1) };
  });
}

function execute(tmp) {
  const command = [process.execPath, "--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", test];
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = "", stderr = "", text = "", error = null, timedOut = false;
    const child = spawn(command[0], command.slice(1), { cwd: tmp, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const append = (kind, value) => { const s = value.toString(); text += s; if (kind === "stdout") stdout += s; else stderr += s; if (Buffer.byteLength(text) > 12 * 1024 * 1024) { error = "output exceeds 12MiB"; kill(); } };
    child.stdout.on("data", (v) => append("stdout", v)); child.stderr.on("data", (v) => append("stderr", v));
    child.on("error", (e) => { error = String(e); });
    const timer = setTimeout(() => { timedOut = true; kill(); }, 150_000);
    child.on("close", (status, signal) => { clearTimeout(timer); kill(); resolve({ command, status, signal, error, timedOut, seconds: (Date.now() - started) / 1000, stdout, stderr, text, parsed: parseTap(text) }); });
  });
}

function workspaceLinks(tmp) {
  const links = [];
  for (const name of readdirSync(path.join(tmp, "packages"))) {
    const file = path.join(tmp, "packages", name, "package.json"); if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8")); if (!pkg.name?.startsWith("@g-group/")) continue;
    const expected = realpathSync(path.join(tmp, "packages", name)); const link = path.join(tmp, "node_modules", pkg.name); const actual = realpathSync(link);
    if (actual !== expected || !inside(tmp, actual)) throw new Error(`工作区依赖未指向变异副本:${pkg.name}`);
    links.push({ name: pkg.name, link, actual, expected, insideMutationCopy: true });
  }
  return links;
}

async function main() {
  const { values } = parseArgs({ options: { "suite-tests": { type: "string" }, mutants: { type: "string" }, out: { type: "string" }, "parser-selftest": { type: "boolean" }, "check-anchors": { type: "boolean" } }, strict: true });
  const count = values["suite-tests"] ?? process.env.MUT_SUITE_TESTS ?? "16";
  if (!/^[1-9]\d*$/.test(count)) throw new Error("--suite-tests/MUT_SUITE_TESTS 必须是正整数");
  const suiteTests = Number(count); if (!Number.isSafeInteger(suiteTests)) throw new Error("suite count 不安全");
  const only = values.mutants ?? process.env.MUT_ONLY;
  const requested = only === undefined ? null : only.split(",").map((s) => s.trim());
  const ids = MUTANTS.map(([name]) => name.split(" ")[0]);
  if (requested && (requested.length === 0 || new Set(requested).size !== requested.length || requested.some((id) => !ids.includes(id)))) throw new Error("--mutants/MUT_ONLY 含未知、空白或重复 M 编号");
  const selected = requested === null ? MUTANTS : MUTANTS.filter(([name]) => requested.includes(name.split(" ")[0]));
  const out = path.resolve(values.out ?? process.env.MUT_OUT ?? path.join(os.tmpdir(), `contact-history-mutations-${Date.now()}`));
  if (inside(source, out)) throw new Error("MUT_OUT/--out 必须在源码仓库外，不能改写其他仓库路径");
  mkdirSync(out, { recursive: true });
  if (inside(realpathSync(source), realpathSync(out))) throw new Error("输出真实路径在源码仓库内");
  const calibration = parserCalibration(); writeFileSync(path.join(out, "parser-calibration.json"), `${JSON.stringify(calibration, null, 2)}\n`);
  if (!calibration.passed) throw new Error("严格TAP解析器自校准失败");
  if (values["parser-selftest"]) { console.log(JSON.stringify({ mode: "parser-selftest", ...calibration, out })); return; }
  const anchors = checkAnchors(Object.fromEntries([H, C].map((f) => [f, readFileSync(path.join(source, f), "utf8")])), selected);
  writeFileSync(path.join(out, "anchors.json"), `${JSON.stringify(anchors, null, 2)}\n`);
  if (!anchors.every((a) => a.unique)) throw new Error("变异锚点不是唯一，见 anchors.json；未启动产品测试");
  if (values["check-anchors"]) { console.log(JSON.stringify({ mode: "check-anchors", selected: selected.length, anchors, productProcessesStarted: 0, out })); return; }
  const titles = [...readFileSync(path.join(source, test), "utf8").matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
  if (titles.length !== suiteTests || new Set(titles).size !== suiteTests) throw new Error(`测试名称校准不符:声明 ${titles.length}，期望 ${suiteTests}，或有重名`);
  const sourceHashesBefore = hashFiles(source); let tmp;
  const summary = { node: process.version, source, suiteTests, selected: selected.map(([n]) => n.split(" ")[0]), registeredTitles: titles, parserCalibration: calibration, anchors, sourceHashesBefore, results: [], mutants: selected.length, killed: 0, survived: 0, invalid: 0, survivedOrInvalid: selected.length, complete: false, errors: [] };
  const save = () => writeFileSync(path.join(out, "contact-config-history-mutations.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const writeRun = (id, run, metadata) => {
    writeFileSync(path.join(out, `${id}.tap`), run.text);
    const result = { ...metadata, ...run }; writeFileSync(path.join(out, `${id}.raw-result.json`), `${JSON.stringify(result, null, 2)}\n`);
    return { tap: `${id}.tap`, tapSha256: sha(run.text), rawResult: `${id}.raw-result.json`, rawResultSha256: sha(readFileSync(path.join(out, `${id}.raw-result.json`))) };
  };
  try {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg-config-mut-"))); summary.mutationCopy = tmp;
    for (const dir of ["packages", "third_party"]) if (existsSync(path.join(source, dir))) cpSync(path.join(source, dir), path.join(tmp, dir), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
    for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) if (existsSync(path.join(source, file))) cpSync(path.join(source, file), path.join(tmp, file));
    mkdirSync(path.join(tmp, "node_modules", "@g-group"), { recursive: true });
    for (const name of readdirSync(path.join(source, "node_modules"))) {
      if (name === "@g-group" || name.startsWith(".")) continue;
      symlinkSync(realpathSync(path.join(source, "node_modules", name)), path.join(tmp, "node_modules", name));
    }
    for (const name of readdirSync(path.join(tmp, "packages"))) {
      const file = path.join(tmp, "packages", name, "package.json"); if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")); if (pkg.name?.startsWith("@g-group/")) symlinkSync(path.join(tmp, "packages", name), path.join(tmp, "node_modules", pkg.name));
    }
    summary.workspaceLinks = workspaceLinks(tmp);
    const originals = new Map([H, C].map((f) => [f, readFileSync(path.join(tmp, f), "utf8")]));
    if (!sameHashes(sourceHashesBefore, hashFiles(source))) throw new Error("复制期间源文件变化，未启动 baseline");
    const baselineRun = await execute(tmp); const baseline = assessRun(baselineRun, { suiteTests, titles });
    summary.baseline = { status: baselineRun.status, signal: baselineRun.signal, error: baselineRun.error, timedOut: baselineRun.timedOut, total: baseline.total, pass: baseline.pass, fail: baseline.fail, completeSuite: baseline.completeSuite, invalidReasons: baseline.invalidReasons, ...writeRun("baseline", baselineRun, { sourceHashesBefore, workspaceLinks: summary.workspaceLinks }) };
    save();
    if (!baseline.completeSuite || baselineRun.status !== 0 || baseline.pass !== suiteTests || baseline.fail !== 0) throw new Error(`原样对照不是完整 ${suiteTests}/${suiteTests}，不评变异`);
    for (const [name, criterion, edits] of selected) {
      for (const [file, text] of originals) writeFileSync(path.join(tmp, file), text);
      const injection = [];
      for (const { file, from, to } of edits) {
        const target = path.join(tmp, file); const text = readFileSync(target, "utf8"); const count = text.split(from).length - 1;
        if (count !== 1) throw new Error(`变异锚点不是唯一:${name}:${file}:${count}`);
        writeFileSync(target, text.replace(from, to)); injection.push({ file, count, fromSha256: sha(from), toSha256: sha(to) });
      }
      const links = workspaceLinks(tmp); const copyHashesBefore = hashFiles(tmp);
      if (copyHashesBefore[test] !== sourceHashesBefore[test]) throw new Error(`测试副本被改动:${name}`);
      if (!sameHashes(sourceHashesBefore, hashFiles(source))) throw new Error(`源文件在变异前变化:${name}`);
      const run = await execute(tmp); const assessed = assessRun(run, { suiteTests, titles, criterion }); const copyHashesAfter = hashFiles(tmp);
      const copyUnchanged = sameHashes(copyHashesBefore, copyHashesAfter); const sourceUnchanged = sameHashes(sourceHashesBefore, hashFiles(source));
      const killed = assessed.killed && copyUnchanged && sourceUnchanged;
      const result = { name, criterion, expectedName: assessed.expectedName, criterionMatches: assessed.criterionMatches, criterionPresent: assessed.criterionPresent, killed, classification: !copyUnchanged || !sourceUnchanged ? "invalid" : assessed.classification, status: run.status, signal: run.signal, error: run.error, timedOut: run.timedOut, total: assessed.total, pass: assessed.pass, fail: assessed.fail, cancelled: assessed.cancelled, skipped: assessed.skipped, todo: assessed.todo, completeSuite: assessed.completeSuite, invalidReasons: assessed.invalidReasons, failures: assessed.failed, other_criteria_failures: assessed.other_criteria_failures, injection, copyHashesBefore, copyHashesAfter, copyUnchanged, sourceUnchanged, workspaceLinks: links, ...writeRun(name.split(" ")[0], run, { criterion, expectedName: assessed.expectedName, injection, copyHashesBefore, copyHashesAfter, sourceHashesBefore, sourceUnchanged, workspaceLinks: links }) };
      summary.results.push(result); save(); console.log(JSON.stringify(result));
      if (!copyUnchanged || !sourceUnchanged) throw new Error(`执行期间源码变化:${name}`);
    }
    summary.executedAllSelected = summary.results.length === selected.length;
  } catch (e) { summary.errors.push(String(e?.stack ?? e)); console.error(e); }
  finally {
    summary.sourceHashesAfter = hashFiles(source); summary.sourceUnchanged = sameHashes(sourceHashesBefore, summary.sourceHashesAfter); summary.testUnchanged = sourceHashesBefore[test] === summary.sourceHashesAfter[test];
    summary.killed = summary.results.filter((r) => r.killed).length; summary.survived = summary.results.filter((r) => r.classification === "survived").length; summary.invalid = summary.results.filter((r) => r.classification === "invalid").length; summary.survivedOrInvalid = selected.length - summary.killed;
    summary.complete = summary.executedAllSelected === true && summary.killed === selected.length && summary.errors.length === 0 && summary.sourceUnchanged && summary.testUnchanged;
    if (tmp) { rmSync(tmp, { recursive: true, force: true }); summary.ownedMutationCopyRemoved = true; }
    save(); console.log(JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, invalid: summary.invalid, survivedOrInvalid: summary.survivedOrInvalid, complete: summary.complete, suiteTests, out })); process.exitCode = summary.complete ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { console.error(error); process.exitCode = 1; });
}
