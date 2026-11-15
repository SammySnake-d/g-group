import fs from 'node:fs';
import cp from 'node:child_process';
import { createRequire } from 'node:module';

const [repo, base, output] = process.argv.slice(2);
if (!repo?.startsWith('/') || !base || !output?.startsWith('/')) throw new Error('使用：绝对repo路径 baseHEAD 绝对输出路径');
const ts = createRequire(repo + '/package.json')('typescript');
const files = ['packages/domain/src/task.test.ts', 'packages/kernel/src/attention-retry.test.ts', 'packages/server/src/delivery-t8a.test.ts', 'packages/server/src/desk-fake.test.ts', 'packages/server/src/start.test.ts'];
const proofPrefix = 'packages/server/proof/pr75-gate-witnesses-20261116/';
const git = (...args) => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function inventory(code, file) {
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const out = new Map();
  const walk = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'assert') {
      const text = printer.printNode(ts.EmitHint.Unspecified, node, src);
      out.set(text, (out.get(text) ?? 0) + 1);
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return out;
}

const records = files.map((file) => {
  const before = inventory(git('show', base + ':' + file), file);
  const after = inventory(fs.readFileSync(repo + '/' + file, 'utf8'), file);
  const missing = [...before].filter(([text, count]) => (after.get(text) ?? 0) < count).map(([text, count]) => ({ assertion: text, before: count, after: after.get(text) ?? 0 }));
  return { file, before_assert_calls: [...before.values()].reduce((a, b) => a + b, 0), after_assert_calls: [...after.values()].reduce((a, b) => a + b, 0), missing };
});
const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
const result = {
  source_head: git('rev-parse', 'HEAD'), base,
  merge_parents: git('show', '-s', '--format=%P', 'HEAD').split(' '),
  changed_files: changed,
  production_and_gates_unchanged: changed.every((file) => files.includes(file) || file.startsWith(proofPrefix)),
  all_original_assertions_preserved: records.every((file) => !file.missing.length), files: records,
};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.all_original_assertions_preserved || !result.production_and_gates_unchanged) process.exitCode = 1;
