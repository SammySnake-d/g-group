// C 的定点变异:串行改一处、只跑指定前缀的具名测试判死、finally 恢复源码;加载/语法失败不算判死,没有具名测试失败一律算存活。
// 用法:node scripts/t177/c-mutations.mjs [输出目录]。前后各跑一次原样对照,必须全绿。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const out = process.argv[2] ?? 'receipts/evidence/t177-c/mutations';
mkdirSync(out, { recursive: true });
const O = 'packages/server/src/plugin-outbox.ts', P = 'packages/server/src/plugins.ts', R = 'packages/server/src/plugin-runtime.ts';
const T = 'packages/server/src/plugin-outbox.test.ts';
const cases = [
 ['C01-bytes', O, '      print.bytes,\n', '      0,\n', 'C01 '],
 ['C01-receipt', O, "AND state = 'in_flight' AND attempt = ?\",\n        r.receipt.receiptId,", "AND state = 'in_flight' AND attempt = ?\",\n        null,", 'C01 '],
 ['C02-send-before-record', R, '    const stop = gate?.({ endpoint: l.desc.endpoint, idempotency: l.desc.idempotency, windowMs: l.desc.idempotencyWindowMs });\n    if (stop) return stop;\n    return this.registries.get(t.id)!.reg.send(t.id, { action_id: actionId, payload });', '    const sent = this.registries.get(t.id)!.reg.send(t.id, { action_id: actionId, payload });\n    const stop = gate?.({ endpoint: l.desc.endpoint, idempotency: l.desc.idempotency, windowMs: l.desc.idempotencyWindowMs });\n    if (stop) return stop;\n    return sent;', 'C02 '],
 ['C02-swallow-write-error', P, '          throw new HostError("unavailable", `外发记录写不进数据库,没有外发:${(e as Error).message}`);', '          void e;\n          return null;', 'C02 '],
 ['C03-unknown-reason', O, "AND state = 'in_flight' AND attempt = ?\",\n        r.reason,", "AND state = 'in_flight' AND attempt = ?\",\n        null,", 'C03 '],
 ['C04-no-restart-sweep', O, "    run(db, \"UPDATE gg_plugin_outbox SET state = 'delivery_unknown', reason = 'host-restarted'", "    if (Number.isNaN(0)) run(db, \"UPDATE gg_plugin_outbox SET state = 'delivery_unknown', reason = 'host-restarted'", 'C04 '],
 ['C04-late-overwrites', O, "SET state = 'confirmed', reason = NULL, receipt_id = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND state = 'in_flight' AND attempt = ?", "SET state = 'confirmed', reason = NULL, receipt_id = ?, updated_at = ? WHERE plugin_id = ? AND action_id = ? AND attempt = ?", 'C04 '],
 ['C05-b1-across-restart', O, '    if (r.boot !== this.boot) return', '    if (Number.isNaN(0)) return', 'C05 '],
 ['C05-same-boot-reclaim', O, '    return n === 1 ? { pluginId, actionId, token, fresh: false, priorReason: prior.reason } : null;', '    return n === 1 ? null : null;', 'C05 '],
 ['C06-payload-mismatch', O, '    if (r.payload_sha256 !== print.sha256) return', '    if (Number.isNaN(0)) return', 'C06 '],
 ['C06-confirmed-reuse', O, '    if (r.state === "confirmed") return', '    if (Number.isNaN(0)) return', 'C06 '],
 ['C07-install-id-reused', P, '      this.d.now(),\n      randomUUID(),\n    );', '      this.d.now(),\n      "fixed-install",\n    );', 'C07 '],
 ['C08-uninstall-drops-outbox', P, '    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);', '    run(this.d.db, "DELETE FROM gg_plugins WHERE id = ?", id);\n    run(this.d.db, "DELETE FROM gg_plugin_outbox WHERE plugin_id = ?", id);', 'C08 '],
 ['C08-install-binding', O, '    if (r.install_id !== install.installId || r.version !== install.version)', '    if (r.version !== install.version)', 'C08 '],
 ['C09-version-binding', O, '    if (r.install_id !== install.installId || r.version !== install.version)', '    if (r.install_id !== install.installId)', 'C09 '],
 ['C10-in-flight', O, '    if (r.state === "in_flight") return', '    if (Number.isNaN(0)) return', 'C10 '],
 ['C11-release-fresh', O, '    if (c.fresh) run(this.db, "DELETE FROM gg_plugin_outbox', '    if (Number.isNaN(0)) run(this.db, "DELETE FROM gg_plugin_outbox', 'C11 '],
 ['C12-durability', O, '    return { journalMode: String(j?.journal_mode ?? ""), synchronous: Number(s?.synchronous ?? -1) };', '    return { journalMode: String(j?.journal_mode ?? ""), synchronous: 0 };', 'C12 '],
 ['C13-claim-conflict', O, 'ON CONFLICT (plugin_id, action_id) DO NOTHING`', 'ON CONFLICT (plugin_id, action_id) DO UPDATE SET attempt = excluded.attempt, boot = excluded.boot`', 'C13 '],
 // 等价变异(登记,不计入判据):同一次启动里接收端变了,宿主不拦也会由内核按 channel-changed 拒发,对外结果相同
 ['EQ-endpoint-same-boot', O, '    if (ch && (ch.endpoint !== r.endpoint', '    if (Number.isNaN(0) && ch && (ch.endpoint !== r.endpoint', 'C0', true],
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
for (const [id, file, before, after, prefix, equivalent] of cases) {
  const original = readFileSync(file, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`${id}: 变异位置不唯一`);
  try {
    writeFileSync(file, original.replace(before, after));
    const args = equivalent ? [...base, T] : [...base, `--test-name-pattern=^${prefix}`, T];
    const { r, log } = run(args, id);
    const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const loadError = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError:/.test(log);
    const killed = r.status !== 0 && !loadError && failed.some((n) => n.startsWith(prefix));
    results.push({ id, file, designated: equivalent ? '(等价,全文件)' : prefix.trim(), equivalent: !!equivalent, status: killed ? 'killed' : 'survived', exit: r.status, failed });
    writeFileSync(path.join(out, 'results.json'), JSON.stringify({ control: { exit: control.r.status }, results }, null, 2) + '\n');
    console.log(`${id} ${killed ? 'killed' : 'survived'}${equivalent ? ' (等价变异)' : ''}`);
  } finally {
    writeFileSync(file, original);
  }
}
const after = run([...base, T], 'after-control');
const named = results.filter((r) => !r.equivalent);
const summary = { mutations: named.length, killed: named.filter((r) => r.status === 'killed').length, equivalent: results.filter((r) => r.equivalent).map((r) => `${r.id}:${r.status}`), control: control.r.status, afterControl: after.r.status };
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ control: { exit: control.r.status }, afterControl: { exit: after.r.status }, summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary));
process.exit(named.every((r) => r.status === 'killed') && after.r.status === 0 ? 0 : 1);
