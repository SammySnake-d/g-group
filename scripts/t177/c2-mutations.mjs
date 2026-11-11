// C2 的定点变异:串行改一处、只跑指定前缀的具名测试判死、finally 恢复源码;加载/语法失败不算判死,没有具名测试失败一律算存活。
// 用法:node scripts/t177/c2-mutations.mjs [输出目录]。前后各跑一次原样对照,必须全绿。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const out = process.argv[2] ?? 'receipts/evidence/t177-c2/mutations';
mkdirSync(out, { recursive: true });
const O = 'packages/server/src/plugin-outbox.ts', P = 'packages/server/src/plugins.ts', R = 'packages/server/src/plugin-runtime.ts';
const T = 'packages/server/src/plugin-late-receipt.test.ts';
const cases = [
 ['L01-no-raw-handoff', R, '              this.capture?.(raw);\n', '', 'L01 '],
 ['L01-no-record', P, '          this.outbox.recordLate(c, cause, reply);', '          void reply;', 'L01 '],
 ['L01-receipt-not-verbatim', O, '      typeof r?.receiptId === "string" ? r.receiptId : null,', '      null,', 'L01 '],
 ['L01-action-matches', O, '      r?.action_id === c.actionId ? 1 : 0,', '      0,', 'L01 '],
 ['L01-digest-wrong', O, '    const print = printOf(text);', '    const print = printOf(c.actionId);', 'L01 '],
 ['L01-stores-full-reply', O, '      cur?.endpoint ?? null,', '      text,', 'L01 '],
 ['L02-late-confirms-row', P, '          this.outbox.recordLate(c, cause, reply);', '          this.outbox.recordLate(c, cause, reply);\n          (this.outbox as unknown as { db: { store: { db: { exec(s: string): void } } } }).db.store.db.exec("UPDATE gg_plugin_outbox SET state = \'confirmed\', reason = NULL, receipt_id = \'late\'");', 'L02 '],
 ['L03-restart-not-recorded', P, ' : !r.ok && r.reason === "host-restarted" ? "host-restarted" : null;', ' : null;', 'L03 '],
 ['L04-records-everything', P, '      const cause = !kernel.ok && kernel.state === "delivery-unknown" && kernel.reason === "timeout" ? "timeout"', '      const cause = kernel !== null ? "timeout"', 'L04 '],
 ['L05-uninstall-drops-late', P, '    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);', '    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);\n    run(this.d.db, "DELETE FROM gg_plugin_late_receipts WHERE plugin_id = ?", id);', 'L05 '],
 ['L05-overwrites-prior', O, '    const print = printOf(text);', '    const print = printOf(text);\n    run(this.db, "DELETE FROM gg_plugin_late_receipts WHERE plugin_id = ? AND action_id = ?", c.pluginId, c.actionId);', 'L05 '],
];
const base = ['--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', '--test-reporter=tap'];
function run(args, name) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(path.join(out, `${name}.tap`), log);
  return { r, log };
}
const control = run([...base, T], 'control');
if (control.r.status !== 0) throw new Error('原样对照不绿,禁止判变异');
const results = [];
for (const [id, file, before, after, prefix] of cases) {
  const original = readFileSync(file, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`${id}: 变异位置不唯一`);
  try {
    writeFileSync(file, original.replace(before, after));
    const { r, log } = run([...base, `--test-name-pattern=^${prefix}`, T], id);
    const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const loadError = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError:/.test(log);
    const killed = r.status !== 0 && !loadError && failed.some((n) => n.startsWith(prefix));
    results.push({ id, file, designated: prefix.trim(), status: killed ? 'killed' : 'survived', exit: r.status, failed });
    writeFileSync(path.join(out, 'results.json'), JSON.stringify({ control: { exit: control.r.status }, results }, null, 2) + '\n');
    console.log(`${id} ${killed ? 'killed' : 'survived'}`);
  } finally {
    writeFileSync(file, original);
  }
}
const after = run([...base, T], 'after-control');
const summary = { mutations: results.length, killed: results.filter((r) => r.status === 'killed').length, control: control.r.status, afterControl: after.r.status };
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ control: { exit: control.r.status }, afterControl: { exit: after.r.status }, summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary));
process.exit(results.every((r) => r.status === 'killed') && after.r.status === 0 ? 0 : 1);
