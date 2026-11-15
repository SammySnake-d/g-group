import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = '/private/tmp/gg-pr75-gate-witnesses-dyugzcdc';
const repo = path.join(root, 'repo');
const evidence = path.join(root, 'evidence');
const changed = [
  'packages/domain/src/task.test.ts',
  'packages/kernel/src/attention-retry.test.ts',
  'packages/server/src/delivery-t8a.test.ts',
  'packages/server/src/desk-fake.test.ts',
  'packages/server/src/start.test.ts',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const [mode, phase] = process.argv.slice(2);
if (!['prepare', 'static'].includes(mode) || !['baseline', 'strengthened'].includes(phase)) throw new Error('使用: witness-tools.mjs prepare|static baseline|strengthened');
const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const read = (file) => fs.readFileSync(path.join(repo, file));
const testlint = await import(pathToFileURL(path.join(repo, 'scripts/gates/testlint.ts')).href);
if (mode === 'static') {
  const files = changed.map((file) => {
    const code = read(file).toString('utf8');
    return { file, sha256: digest(code), problems: testlint.lintTestFile(code, file), tests: testlint.analyzeTestFile(code, file).tests.map((test) => ({ name: test.name, asserts: test.asserts, srcAsserts: test.srcAsserts, modifiers: test.modifiers })) };
  });
  const result = { source_head: head, kind: '静态testlint局部判据，不是完整G-TAUTO', files, problem_count: files.reduce((count, file) => count + file.problems.length, 0) };
  fs.writeFileSync(path.join(evidence, `${phase}-static.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ source_head: head, problem_count: result.problem_count, files: files.map((file) => ({ file: file.file, problems: file.problems })) }, null, 2));
  process.exitCode = result.problem_count ? 1 : 0;
} else {
  const { mutateReturns, ARM_FLAG, MUT_HIT, MUT_MARK } = await import(pathToFileURL(path.join(repo, 'scripts/gates/gates.ts')).href);
  const dir = path.join(evidence, `${phase}-mutation`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const copied = [];
  for (const folder of ['packages/domain/src', 'packages/kernel/src']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    for (const name of fs.readdirSync(path.join(repo, folder))) {
      if (!name.endsWith('.ts') || !fs.statSync(path.join(repo, folder, name)).isFile()) continue;
      const file = path.posix.join(folder, name);
      if (folder.includes('/kernel/') && !['attention.ts', 'attention-retry.test.ts'].includes(name)) continue;
      fs.copyFileSync(path.join(repo, file), path.join(dir, file));
      copied.push(file);
    }
  }
  const transforms = [];
  for (const file of copied.filter((file) => !file.endsWith('.test.ts'))) {
    const original = read(file).toString('utf8');
    const transformed = mutateReturns(original, file);
    fs.writeFileSync(path.join(dir, file), transformed.code);
    transforms.push({ file, before_sha256: digest(original), after_sha256: digest(transformed.code), return_mutations: transformed.count });
  }
  const arm = `import { beforeEach, afterEach } from "node:test";\nbeforeEach(() => { globalThis.${MUT_HIT} = false; globalThis.${ARM_FLAG} = true; });\nafterEach((t) => { globalThis.${ARM_FLAG} = false; if (globalThis.${MUT_HIT}) console.log("${MUT_MARK}" + JSON.stringify(t.name)); });\n`;
  fs.writeFileSync(path.join(dir, '__gate_arm.mjs'), arm);
  const result = { source_head: head, kind: '原mutateReturns算法的纯定向后验校准，不调用正式门禁', transforms, tests: changed.filter((file) => copied.includes(file)).map((file) => ({ file, sha256: digest(read(file)) })), arm_sha256: digest(arm), mutation_scope: 'domain纯源码及kernel/attention.ts，无OS信号', copied };
  fs.writeFileSync(path.join(evidence, `${phase}-mutation.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
