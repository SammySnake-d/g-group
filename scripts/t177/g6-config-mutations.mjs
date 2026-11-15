// G6 explicit-budget propagation and resume identity mutants; same serial named-test harness as G35.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const T = "packages/server/proof/g6/runtime-config.test.ts";
const cases = [
  [
    "G6CFG-M01",
    "packages/server/proof/g6/driver.ts",
    "...speakingEnv(o.env)",
    "...Object.fromEntries(Object.entries(speakingEnv(o.env)).filter(([k]) => k !== \"GG_SPEAKING_MAX_OUTPUT_TOKENS\"))",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-01 ",
    "driver drops GG_SPEAKING_MAX_OUTPUT_TOKENS"
  ],
  [
    "G6CFG-M02",
    "packages/server/proof/g6/driver.ts",
    "...speakingEnv(o.env)",
    "...Object.fromEntries(Object.entries(speakingEnv(o.env)).filter(([k]) => k !== \"GG_SPEAKING_CONTEXT_WINDOW\"))",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-01 ",
    "driver drops GG_SPEAKING_CONTEXT_WINDOW"
  ],
  [
    "G6CFG-M03",
    "packages/server/proof/g6/run.ts",
    "Object.assign(env, speakingEnv(source));",
    "Object.assign(env, Object.fromEntries(Object.entries(speakingEnv(source)).filter(([k]) => k !== \"GG_SPEAKING_MAX_OUTPUT_TOKENS\")));",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-02 ",
    "runner child drops GG_SPEAKING_MAX_OUTPUT_TOKENS"
  ],
  [
    "G6CFG-M04",
    "packages/server/proof/g6/run.ts",
    "Object.assign(env, speakingEnv(source));",
    "Object.assign(env, Object.fromEntries(Object.entries(speakingEnv(source)).filter(([k]) => k !== \"GG_SPEAKING_CONTEXT_WINDOW\")));",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-02 ",
    "runner child drops GG_SPEAKING_CONTEXT_WINDOW"
  ],
  [
    "G6CFG-M05",
    "packages/server/proof/g6/manifest.ts",
    "speaking: speakingEnv(env) }",
    "speaking: Object.fromEntries(Object.entries(speakingEnv(env)).filter(([k]) => k !== \"GG_SPEAKING_MAX_OUTPUT_TOKENS\")) }",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-03 ",
    "resume identity ignores GG_SPEAKING_MAX_OUTPUT_TOKENS"
  ],
  [
    "G6CFG-M06",
    "packages/server/proof/g6/manifest.ts",
    "speaking: speakingEnv(env) }",
    "speaking: Object.fromEntries(Object.entries(speakingEnv(env)).filter(([k]) => k !== \"GG_SPEAKING_CONTEXT_WINDOW\")) }",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-03 ",
    "resume identity ignores GG_SPEAKING_CONTEXT_WINDOW"
  ],
  [
    "G6CFG-M07",
    "packages/server/proof/g6/run.ts",
    "Object.assign(env, speakingEnv(source));",
    "Object.assign(env, source);",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-02 ",
    "copy unrelated host state into driver environment"
  ],
  [
    "G6CFG-M08",
    "packages/server/proof/g6/manifest.ts",
    "speaking: speakingEnv(env) }",
    "speaking: { ...speakingEnv(env), token: env.ANTHROPIC_AUTH_TOKEN ?? \"\" } }",
    "packages/server/proof/g6/runtime-config.test.ts",
    "G6CFG-03 ",
    "credential value enters manifest and resume identity"
  ]
];

const out = process.argv[2] ?? "receipts/evidence/t177-g6-config/mutations";
mkdirSync(out, { recursive: true });
const LOAD_FAIL = /SyntaxError:|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module|does not provide an export/;
function run(files, name, pattern) {
  const args = ["--test", "--test-concurrency=1", "--test-timeout=60000", "--test-force-exit", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern}`] : []), ...files];
  const r = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const log = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(path.join(out, `${name}.tap`), log);
  const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { status: r.status, signal: r.signal, log, failed, passed };
}
const control = run([T], "control");
console.log(`原样对照:通过 ${control.passed.length},失败 ${control.failed.length},退出 ${control.status}`);
if (control.status !== 0 || control.failed.length || control.passed.length !== 4) { console.log("原样对照不全绿,不判变异"); process.exit(1); }
const results = [];
for (const [id, file, before, after, testFile, prefix, why] of cases) {
  const source = readFileSync(file, "utf8");
  const n = source.split(before).length - 1;
  if (n !== 1) { results.push({ id, file, why, status: "invalid", reason: `注入点出现 ${n} 次` }); console.log(`${id} 注入点出现 ${n} 次,作废`); continue; }
  try {
    writeFileSync(file, source.replace(before, after));
    const r = run([testFile], id, prefix);
    const named = r.failed.filter((t) => t.startsWith(prefix));
    const loadFail = LOAD_FAIL.test(r.log);
    const killed = r.status !== 0 && named.length > 0 && !loadFail && r.signal === null;
    results.push({ id, file, why, designated: `${testFile} › ${prefix.trim()}…`, status: killed ? "killed" : "survived", exit: r.status, signal: r.signal, loadFail, failed: r.failed });
    console.log(`${id} ${killed ? "杀死" : "存活"}:${why}${killed ? `(被「${named[0]}」发现)` : ""}`);
  } finally { writeFileSync(file, source); }
}
const after = run([T], "after-control");
const summary = { node: process.version, mutations: results.length, killed: results.filter((r) => r.status === "killed").length, survived: results.filter((r) => r.status !== "killed").length, control: { passed: control.passed.length, failed: control.failed.length }, afterControl: { passed: after.passed.length, failed: after.failed.length, exit: after.status } };
writeFileSync(path.join(out, "results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary));
process.exit(summary.survived === 0 && after.status === 0 && after.passed.length === 4 ? 0 : 1);
