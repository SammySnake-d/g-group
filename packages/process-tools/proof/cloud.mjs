// Run only in the assigned cloud lane, under its shared flock. No credentials/model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readTap = (text) => {
  const counts = { tests: -1, pass: -1, fail: -1, cancelled: -1, skipped: -1, todo: -1 };
  for (const m of text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[m[1]] = Number(m[2]);
  return counts;
};
const checkTap = (counts) => {
  assert.ok(counts.tests > 0);
  assert.equal(counts.pass, counts.tests);
  for (const k of ["fail", "cancelled", "skipped", "todo"]) assert.equal(counts[k], 0, `TAP ${k}`);
};
if (process.argv[2] === "--parser-self-test") {
  const valid = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.deepEqual(readTap(valid), { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  checkTap(readTap(valid));
  for (const invalid of ["", valid.replace("# skipped 0", "# skipped 1"), valid.replace("# cancelled 0", "# cancelled 1"), valid.replace("# pass 2", "# pass 1")]) assert.throws(() => checkTap(readTap(invalid)));
  console.log("cloud runner parser controls only: positive and negative passed; no cloud work started");
  process.exit(0);
}

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const [outArg, baselineArg, expectedHead] = process.argv.slice(2);
assert.ok(outArg && baselineArg && expectedHead, "required: output-directory baseline-checkout expected-candidate-HEAD");
assert.match(expectedHead, /^[a-f0-9]{40}$/);
const out = path.resolve(outArg);
const baseline = path.resolve(baselineArg);
assert.ok(!out.startsWith(`${root}${path.sep}`), "outputs must not mutate frozen source");
assert.notEqual(root, baseline);
fs.mkdirSync(out, { recursive: true });
const base = "3216bb1eeff5d1f0229b610cd37cb90e92db48c5";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const git = (cwd, ...args) => {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
};
assert.equal(git(root, "rev-parse", "HEAD"), expectedHead);
assert.equal(git(baseline, "rev-parse", "HEAD"), base);
assert.equal(git(root, "status", "--porcelain"), "");
assert.equal(git(baseline, "status", "--porcelain"), "");
for (const repo of [root, baseline]) {
  for (const name of ["kernel", "domain", "adapter-cc-compute"]) {
    assert.equal(fs.realpathSync(path.join(repo, "node_modules/@g-group", name)), fs.realpathSync(path.join(repo, "packages", name)), "workspace links must resolve to that checkout, not the other source");
  }
}
assert.equal(fs.realpathSync(path.join(root, "node_modules/@g-group/process-tools")), fs.realpathSync(path.join(root, "packages/process-tools")));
const tests = git(baseline, "ls-files", "packages/adapter-cc-compute/**/*.test.ts").split("\n");
assert.equal(tests.length, 7);
for (const f of tests) assert.deepEqual(fs.readFileSync(path.join(root, f)), fs.readFileSync(path.join(baseline, f)), `original CC test bytes unchanged: ${f}`);
const tracked = git(root, "ls-files").split("\n");
const seal = Object.fromEntries(tracked.map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]));
const record = { base, head: expectedHead, node: process.version, complete: false, baselineCCTests: tests, results: [], sourceSeal: seal, sourceUnchanged: null };
const persist = () => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(record, null, 2) + "\n");
const run = (name, cwd, command, tap) => {
  const started = Date.now();
  const p = spawnSync(command[0], command.slice(1), { cwd, encoding: "buffer", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = p.stdout ?? Buffer.alloc(0), stderr = p.stderr ?? Buffer.alloc(0);
  fs.writeFileSync(path.join(out, `${name}.stdout.txt`), stdout);
  fs.writeFileSync(path.join(out, `${name}.stderr.txt`), stderr);
  const entry = { name, cwd, command, exit: p.status, signal: p.signal, executorError: p.error?.message ?? null, seconds: (Date.now() - started) / 1000, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) };
  if (tap) entry.tap = readTap(stdout.toString("utf8"));
  record.results.push(entry); persist();
  assert.equal(p.status, 0, `${name}: nonzero exit; original logs preserved`);
  if (tap) checkTap(entry.tap);
};
const nodeTests = [process.execPath, "--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap"];
try {
  run("baseline-cc-original", baseline, [...nodeTests, ...tests], true);
  run("candidate-cc-original", root, [...nodeTests, ...tests], true);
  run("candidate-shared-cleanup", root, [...nodeTests, "packages/process-tools/src/cleanup.test.ts", "packages/process-tools/src/procgroup.test.ts", "scripts/gates/process-layer.test.ts"], true);
  run("legacy-resident-bridge", root, [...nodeTests, "packages/adapter-cc-compute/proof/shared-process-bridge.test.mjs"], true);
  run("cleanup-layer-mutants", root, [process.execPath, "packages/process-tools/proof/mutations.mjs", path.join(out, "mutations")], false);
  run("layer-cli-selftest", root, ["env", "GATE_SELFTEST_ONLY=Q08", "GATE_SELFTEST_JOBS=1", process.execPath, "scripts/gates/run-all.ts", "--self-test"], false);
  run("typecheck", root, ["npm", "run", "typecheck"], false);
  run("lint", root, ["npm", "run", "lint"], false);
  run("full", root, ["npm", "test", "--silent"], true);
  record.complete = true;
} catch (error) {
  record.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  record.sourceUnchanged = Object.entries(seal).every(([f, h]) => sha(fs.readFileSync(path.join(root, f))) === h);
  record.complete = record.complete && record.sourceUnchanged;
  persist();
  assert.ok(record.sourceUnchanged, "source changed while observed");
}
console.log(JSON.stringify(record, null, 2));
