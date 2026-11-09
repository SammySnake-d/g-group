// 隔离的两项真实测试验证运行器入口;负例的 skip/todo 不进入正式测试套件。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const pkg = path.resolve(import.meta.dirname, "..");
const root = path.resolve(pkg, "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-runner-controls-"));
const evidence = process.env.CC_CONTROL_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const target = JSON.parse(fs.readFileSync(new URL("./mutation-targets.json", import.meta.url), "utf8")).M01.name;
try {
  for (const mode of ["full", "skip", "todo"]) {
    const repo = path.join(temp, mode);
    const copy = path.join(repo, "packages/adapter-cc-compute");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.cpSync(pkg, copy, { recursive: true });
    fs.copyFileSync(path.join(root, "tsconfig.json"), path.join(repo, "tsconfig.json"));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"));
    for (const file of fs.readdirSync(path.join(copy, "src"))) if (file.endsWith(".test.ts")) fs.unlinkSync(path.join(copy, "src", file));
    fs.writeFileSync(path.join(copy, "src/runner.test.ts"), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import {checkBrief} from './brief.ts';\ntest(${JSON.stringify(target)},()=>assert.equal(checkBrief({task:'中性',rules:[],tools:[],credentialRefs:[],placement:'local',memory:'中性'}).ok,false));\ntest('完整性对照',${mode === "full" ? "{}" : `{${mode}:true}`},()=>assert.equal(checkBrief({task:'中性',rules:[],tools:[],credentialRefs:[],placement:'local'}).ok,true));\n`);
    const env = { ...process.env, CC_MUT_ONLY: "M01", CC_MUT_CONCURRENCY: "1" };
    delete env.NODE_TEST_CONTEXT;
    delete env.CC_MUT_PROGRESS;
    delete env.CC_MUT_EVIDENCE;
    if (evidence) env.CC_MUT_EVIDENCE = path.join(evidence, mode);
    const run = spawnSync(process.execPath, [path.join(copy, "proof/mutations.mjs")], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
    const text = run.stdout + run.stderr;
    if (evidence) fs.writeFileSync(path.join(evidence, `${mode}.log`), text);
    assert.equal(run.error, undefined, text);
    assert.equal(run.status, mode === "full" ? 0 : 1, text);
    assert.match(text, mode === "full" ? /变异校准通过/ : /无效基线,停止校准/);
    if (mode !== "full") assert.doesNotMatch(text, /被「/);
    console.log(`${mode}: exit=${run.status}, ${mode === "full" ? "真实完整基线及 M01 获认可" : "无效基线被拒且未派发变异"}`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
