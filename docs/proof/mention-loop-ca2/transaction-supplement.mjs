// R-05：串行隔离副本；每个单点故障必须由指定具名断言击中，不把加载失败或超时算杀死。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(process.env.PROOF_REPO ?? path.join(import.meta.dirname, '../../..'));
if (!process.env.PROOF_REPO) throw new Error('PROOF_REPO required for supplemental fixture');
const G = 'packages/server/src/loop-guard.ts';
const H = 'packages/server/src/host.ts';
const testFile = 'packages/server/src/loop-guard.test.ts';
const names = [...fs.readFileSync(path.join(root, testFile), 'utf8').matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
const mutants = [["事务内提前提交使失败消息泄漏额度", "packages/server/src/loop-guard.ts", "return this.db.store.db.isTransaction ? apply() : tx(this.db, apply);", "return this.db.store.db.isTransaction ? (() => { const earlyCommit=true; const value=apply(); if (earlyCommit) this.db.store.db.exec(\"COMMIT; BEGIN\"); return value; })() : tx(this.db, apply);", 5]];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-loop-mut-'));
const copy = (name) => {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(root, 'packages'), path.join(dir, 'packages'), { recursive: true, filter: (s) => !s.includes('/proof') && !s.includes('/node_modules') });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'node_modules', '@g-group'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(root, 'node_modules'))) {
    if (entry === '@g-group' || entry.startsWith('.')) continue;
    fs.symlinkSync(path.join(root, 'node_modules', entry), path.join(dir, 'node_modules', entry));
  }
  for (const pkg of fs.readdirSync(path.join(root, 'packages'))) fs.symlinkSync(path.join('../../packages', pkg), path.join(dir, 'node_modules/@g-group', pkg));
  return dir;
};
// EOF 用 (?![\s\S])，不能在 m 模式下用会匹配每个行尾的 $ 截断 diagnostic。
const parseTap = (stdout) => {
  const blocks = [...stdout.matchAll(/^not ok \d+ - (.+)\r?\n([\s\S]*?)(?=^# Subtest:|^1\.\.|(?![\s\S]))/gm)];
  const passed = [...stdout.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const failed = blocks.map((m) => ({ name: m[1], assertion: /^\s+code: ['"]ERR_ASSERTION['"]\s*$/m.test(m[2]), detail: m[2].slice(0, 1500) }));
  return { passed, failed };
};
const outDir = process.env.MUT_OUT;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const execute = (dir, tag, file = testFile, timeout = 30000) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', file], { cwd: dir, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL', detached: true });
  if (r.error) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* 自有组已结束 */ } }
  const stdout = r.stdout ?? '';
  if (outDir) { fs.writeFileSync(path.join(outDir, `${tag}.tap`), stdout); fs.writeFileSync(path.join(outDir, `${tag}.stderr`), r.stderr ?? ''); }
  return { exit: r.status, timedOut: !!r.error, executionError: r.error?.code ?? null, ...parseTap(stdout), stderr: r.stderr };
};
const calibration = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-loop-tap-cal-'));
  try {
    const fixtures = [
      ['assertion', `import {test} from 'node:test';import assert from 'node:assert/strict';test('calibration assertion',()=>assert.equal(1,2));`, true, 30000],
      ['load-error', `import './missing-calibration-module.mjs';`, false, 30000],
      ['runtime-error', `import {test} from 'node:test';test('calibration nonassertion',()=>{throw new Error('ERR_ASSERTION marker alone is not an assertion');});`, false, 30000],
      ['timeout', `import {test} from 'node:test';test('calibration timeout',async()=>await new Promise(()=>{setInterval(()=>{},1000);}));`, false, 300],
    ];
    const rows = fixtures.map(([tag, source, expectedAssertion, timeout]) => {
      const file = path.join(dir, `${tag}.test.mjs`); fs.writeFileSync(file, source);
      const result = execute(dir, `calibration-${tag}`, file, timeout);
      const detected = result.exit === 1 && !result.timedOut && result.failed.some((f) => f.assertion);
      if (detected !== expectedAssertion || (tag === 'timeout' && !result.timedOut)) throw new Error(`TAP校准不符:${tag}`);
      return { tag, expectedAssertion, detected, ...result };
    });
    if (outDir) fs.writeFileSync(path.join(outDir, 'parser-calibration.json'), JSON.stringify(rows, null, 2) + '\n');
    console.log(JSON.stringify({ kind: 'parser-calibration', rows }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const rows = [];
try {
  calibration();
  if (process.argv.includes('--calibrate-only')) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }
  const cleanDir = copy('clean');
  const clean = execute(cleanDir, 'baseline');
  console.log(JSON.stringify({ kind: 'control', ...clean }));
  fs.rmSync(cleanDir, { recursive: true });
  if (names.length !== 10 || clean.exit !== 0 || clean.passed.length !== names.length || clean.failed.length) throw new Error('原样对照不全绿');
  for (const [index, [label, file, from, to, target]] of mutants.entries()) {
    const dir = copy(`m${index}`);
    const source = path.join(dir, file);
    const text = fs.readFileSync(source, 'utf8');
    if (text.split(from).length !== 2) throw new Error(`注入点不唯一:${label}`);
    fs.writeFileSync(source, text.replace(from, to));
    const result = execute(dir, `M${String(index + 1).padStart(2, '0')}`);
    const hit = result.failed.find((f) => f.name === names[target] && f.assertion);
    const complete = result.passed.length+result.failed.length===names.length && /# tests 10(?:\r?\n|$)/m.test(fs.readFileSync(path.join(outDir, `M${String(index + 1).padStart(2, '0')}.tap`),'utf8'));
    const killed = result.exit === 1 && !result.timedOut && complete && !!hit;
    const negativeDir=copy(`negative${index}`);
    const negativeFile=path.join(negativeDir,file);
    fs.writeFileSync(negativeFile,fs.readFileSync(negativeFile,'utf8').replace(from,to.replace('earlyCommit=true','earlyCommit=false')));
    const negative=execute(negativeDir,`negative${index}`);
    if(negative.exit!==0||negative.timedOut||negative.failed.length||negative.passed.length!==names.length) throw new Error('单开关阴性未完整绿');
    fs.rmSync(negativeDir,{recursive:true});
    const row = { label, target: names[target], killed, complete, injection_switch:"earlyCommit=true", negative_switch:"earlyCommit=false", negative, ...result };
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.rmSync(dir, { recursive: true });
  }
  const killed = rows.filter((r) => r.killed).length;
  const summary = { total: mutants.length, killed, survived: mutants.length - killed };
  if (outDir) fs.writeFileSync(path.join(outDir, 'mutations.json'), JSON.stringify({ node: process.version, baseline: clean, rows, summary }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  process.exitCode = killed === mutants.length ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
