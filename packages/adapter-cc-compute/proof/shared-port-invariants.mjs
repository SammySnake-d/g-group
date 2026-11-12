// Pure extraction proof. Mutants only touch disposable copies, never the observed source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "g-group-shared-port-proof"));
fs.mkdirSync(out, { recursive: true });
const base = "272b1b5d77bd95f34467a5aa04d0bf5891355887";
const cc = "packages/adapter-cc-compute";
const kernel = "packages/kernel";
const testFile = `${cc}/proof/shared-port-legacy.test.mjs`;
const expectedTest = "S-PORT-01: kernel Compute port preserves CC aliases and keeps tool policies distinct";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const git = (...args) => {
  const p = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout;
};
const old = (file) => git("show", `${base}:${file}`);
const parse = (source) => ts.createSourceFile("proof.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const printer = ts.createPrinter({ removeComments: true });
const print = (statement) => printer.printNode(ts.EmitHint.Unspecified, statement, parse(""));
const declarations = (source) => parse(source).statements.filter((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
const adapterOnly = new Set(["ClaudeRunner", "AdapterOptions"]);
const oldTypes = declarations(old(`${cc}/src/types.ts`));
assert.deepEqual(declarations(read(`${kernel}/src/compute/ports.ts`)).map(print), oldTypes.filter((s) => !adapterOnly.has(s.name.text)).map(print), "all moved public type declarations remain identical");
assert.deepEqual(declarations(read(`${cc}/src/types.ts`)).map(print), oldTypes.filter((s) => adapterOnly.has(s.name.text)).map(print), "runner options remain unchanged in CC");
assert.equal(read(`${kernel}/src/compute/plain.ts`), old(`${cc}/src/plain.ts`), "pure data implementation is an exact byte copy, not kernel root's different contract");
assert.equal(read(`${cc}/src/procgroup.ts`), old(`${cc}/src/procgroup.ts`), "OS process effects stay in adapter");
for (const file of ["adapter.ts", "resident.ts", "cli.ts", "events.ts", "report-schema.ts", "turn-model.ts"]) {
  assert.equal(read(`${cc}/src/${file}`), old(`${cc}/src/${file}`), `CC lifecycle and CLI behavior unchanged: ${file}`);
}
const originalTests = git("ls-tree", "-r", "--name-only", base, cc).trim().split("\n").filter((f) => f.endsWith(".test.ts"));
assert.equal(originalTests.length, 7);
for (const file of originalTests) assert.equal(read(file), old(file), `original CC test unchanged: ${file}`);
const oldBrief = parse(old(`${cc}/src/brief.ts`));
const neutral = parse(read(`${kernel}/src/compute/validate.ts`));
const functionBody = (sf, name) => {
  const f = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(f?.body, name);
  return print(f.body);
};
assert.equal(functionBody(neutral, "checkSnapshot"), functionBody(oldBrief, "checkSnapshot"));
assert.equal(functionBody(neutral, "checkComputeBrief").replaceAll("supportedTools", "CC_BUILTIN_TOOLS"), functionBody(oldBrief, "checkBrief"), "shared brief validator only parameterizes the harness-owned tool policy");
const oldPolicy = oldBrief.statements.find((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(oldBrief) === "CC_BUILTIN_TOOLS"));
const legacyBrief = parse(read(`${cc}/src/brief.ts`));
const legacyPolicy = legacyBrief.statements.find((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(legacyBrief) === "CC_BUILTIN_TOOLS"));
assert.ok(oldPolicy && legacyPolicy);
assert.equal(print(oldPolicy), print(legacyPolicy), "CC tool policy stays unchanged in CC");

const mutations = [
  { id: "legacy-alias-wrapper", file: `${cc}/src/plain.ts`, from: 'export { freezeDeep, isPlainRecord, plainData, type PlainResult } from "@g-group/kernel/compute";', to: 'import { plainData as raw } from "@g-group/kernel/compute";\nexport const plainData = (...args: Parameters<typeof raw>) => raw(...args);\nexport { freezeDeep, isPlainRecord, type PlainResult } from "@g-group/kernel/compute";' },
  { id: "drop-undefined-field", file: `${kernel}/src/compute/plain.ts`, from: '(out as Record<string, unknown>)[k] = undefined;', to: '/* wrong: drops a declared undefined field */' },
  { id: "invoke-getter", file: `${kernel}/src/compute/plain.ts`, from: 'if (isAccessor(d)) return bad(path, "不允许 getter/setter");', to: 'if (isAccessor(d)) { d.get?.call(x); return bad(path, "不允许 getter/setter"); }' },
  { id: "hardcode-cc-tool-policy", file: `${kernel}/src/compute/validate.ts`, from: '!supportedTools.includes(t)', to: '!["Bash"].includes(t)' },
  { id: "accept-missing-snapshot-version", file: `${kernel}/src/compute/validate.ts`, from: 'if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse("交接快照缺约束版本 constraintVer(非负整数),不能只有流畅文字");', to: '/* wrong: missing/negative versions accepted */' },
  { id: "accept-plaintext-credential", file: `${kernel}/src/compute/validate.ts`, from: 'typeof x === "string" && CREDENTIAL_REF.test(x)', to: 'typeof x === "string"' },
  { id: "unfreeze-brief-tools", file: `${kernel}/src/compute/validate.ts`, from: 'tools: Object.freeze([...tools])', to: 'tools: [...tools]' },
  { id: "broaden-cc-tool-policy", file: `${cc}/src/brief.ts`, from: '["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]', to: '["native_exec", "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]' },
].map((m) => ({ ...m, expectedTest }));
fs.writeFileSync(path.join(out, "mutation-bindings.json"), JSON.stringify(mutations, null, 2) + "\n");
const assertionKill = (status, log) => status === 1 && log.includes(`not ok 1 - ${expectedTest}`) && /code: 'ERR_ASSERTION'/.test(log) && /^1\.\.1$/m.test(log) && /^# tests 1$/m.test(log) && /^# fail 1$/m.test(log) && /^# cancelled 0$/m.test(log) && /^# skipped 0$/m.test(log) && /^# todo 0$/m.test(log);
const files = [testFile, `${cc}/package.json`, `${cc}/src/brief.ts`, `${cc}/src/plain.ts`, `${cc}/src/types.ts`, `${kernel}/package.json`, ...fs.readdirSync(path.join(root, kernel, "src/compute")).filter((f) => f.endsWith(".ts")).map((f) => `${kernel}/src/compute/${f}`)];
const seal = Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]));
const command = ["--test", "--test-concurrency=1", "--test-reporter=tap", testFile];
const green = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8", timeout: 30000 });
const greenLog = green.stdout + green.stderr;
fs.writeFileSync(path.join(out, "positive.txt"), greenLog);
assert.equal(green.status, 0, greenLog);
assert.equal(assertionKill(green.status, greenLog), false);
const results = [];
for (const m of mutations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gg-port-${m.id}-`));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(tmp, file)); }
    fs.mkdirSync(path.join(tmp, "node_modules/@g-group"), { recursive: true });
    fs.symlinkSync(path.join(tmp, kernel), path.join(tmp, "node_modules/@g-group/kernel"));
    const target = path.join(tmp, m.file);
    const before = fs.readFileSync(target, "utf8");
    assert.equal(before.split(m.from).length, 2, `${m.id}: exactly one mutation site`);
    fs.writeFileSync(target, before.replace(m.from, m.to.replaceAll("\\n", "\n")));
    const run = spawnSync(process.execPath, command, { cwd: tmp, encoding: "utf8", timeout: 30000 });
    const log = run.stdout + run.stderr;
    fs.writeFileSync(path.join(out, `${m.id}.txt`), log);
    const killed = assertionKill(run.status, log);
    results.push({ id: m.id, expectedTest, exit: run.status, signal: run.signal, killed, logSha256: sha(log) });
    assert.ok(killed, `${m.id}: not killed by designated assertion (setup/timeouts do not count): ${log}`);
    assert.equal(assertionKill(run.status, log.replaceAll("ERR_ASSERTION", "TypeError")), false, "parser negative: setup exception is not a kill");
    assert.equal(assertionKill(run.status, log.replace("# cancelled 0", "# cancelled 1")), false, "parser negative: cancelled run is not a kill");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
for (const [file, hash] of Object.entries(seal)) assert.equal(sha(fs.readFileSync(path.join(root, file))), hash, `source unchanged: ${file}`);
const result = { base, node: process.version, complete: true, originalCCTestFilesUnchanged: originalTests.length, portTypeDeclarationsIdentical: true, pureDataByteIdentical: true, cliAndLifecycleFilesUnchanged: true, processEffectsUnmoved: true, owningKernelRedCommit: "f62f661887222487cc3205d072a5adbb13bba0ac", legacyAliasRedHistory: "37c697d52aabf3882e6797154c09fb09a1aff025", legacyProofAssertionsPreserved: true, positiveTests: 1, killed: results.length, survived: 0, parserPositiveAndNegative: true, sourceBeforeAndAfter: seal, mutations: results };
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
