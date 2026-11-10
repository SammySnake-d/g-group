// A 的定点变异：串行改一处、按指定测试名判死、finally 恢复源码；不把加载失败当判死。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const out = process.argv[2] ?? 'receipts/evidence/t177-a/mutations';
mkdirSync(out, { recursive: true });
const D = 'packages/domain/src/followups.ts', W = 'packages/server/src/worktree.ts', R = 'packages/server/src/recovery.ts', H = 'packages/server/src/host.ts';
const dt = 'packages/domain/src/recovery.test.ts', wt = 'packages/server/src/recovery.test.ts', ht = 'packages/server/src/recovery-host.test.ts';
const cases = [
 ['A04H-quiesce', H, 'const q = await a.quiesce(computeId);', 'const q = { ok: true as const };', ht, 'A04H '],
 ['A15Q-quota', H, 'if (e.kind === "resume") await this.resumeCompute(e);\n      else await this.spawn(e);', 'if (e.kind === "resume") await this.computeTurn(e);\n      else await this.spawn(e);', ht, 'A15Q '],
 ['A01-order', D, 'l.appliedVer! >= m.appliedVer!', 'j > i', dt, 'A01 '],
 ['A02-later', D, 'l.appliedVer! >= m.appliedVer!', 'l.appliedVer === m.appliedVer', dt, 'A02 '],
 ['A03-artifact', D, 'fromArtifact: m.appliedIn, requirements', 'fromArtifact: null, requirements', dt, 'A03 '],
 ['A04-identity', D, 'fromArtifact: rb.fromArtifact, requirements', 'fromArtifact: null, requirements', dt, 'A04 '],
 ['A18-domain', D, 'if (newVer === null || recoveryMode === "merged")', 'if (newVer === null)', dt, 'A18 '],
 ['A19-domain', D, 'recoveryMode !== "merged" && wasApplied', 'recoveryMode === "host" && wasApplied', dt, 'A19 '],
 ['A05-duplicate', R, 'if (prior) {', 'if (false && prior) {', wt, 'A05 '],
 ['A06-atomic', R, 'putDoc(this.db, key, cur?.ver ?? 0, [...entries, { ...checkpoint, ordinal: (entries.at(-1)?.ordinal ?? 0) + 1 }]);', 'this.db.store.db.exec("COMMIT; BEGIN"); putDoc(this.db, key, cur?.ver ?? 0, [...entries, { ...checkpoint, ordinal: (entries.at(-1)?.ordinal ?? 0) + 1 }]); this.db.store.db.exec("COMMIT; BEGIN");', wt, 'A06 '],
 ['A07-artifact', R, '!entries.some(c => c.taskId === ws.taskId && c.resultVer === ver && c.artifact === artifact)', 'false', wt, 'A07 '],
 ['A08-source', W, '`--source=${sha}`', '`--source=HEAD`', wt, 'A08 '],
 ['A09-ignored', W, '"--exclude-standard", "-z"', '"-z"', wt, 'A09 '],
 ['A10-untracked', W, 'g(["add", "-A", "--", "."]);', 'g(["add", "-u", "--", "."]);', wt, 'A10 '],
 ['A11-force-signature', W, 'g(["commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", message])', 'g(["commit-tree", "-S", tree, "-p", "HEAD", "-m", message])', wt, 'A11 '],
 ['A12-error', R, '{ ...cur.value, error: String(error) }', '{ ...cur.value, phase: "done", error: String(error) }', wt, 'A12 '],
 ['A13-once', R, 'if (!intent || intent.phase === "done") return;', 'if (!intent) return;', wt, 'A13 '],
 ['A14-atomic', R, 'done(completed, restored);', 'this.db.store.db.exec("COMMIT; BEGIN"); done(completed, restored);', wt, 'A14 '],
 ['A16-candidate', W, 'state: "W2_Active", candidateSha: null, conflict: null, targetHead:', 'state: "W2_Active", candidateSha: ws.candidateSha, conflict: null, targetHead:', wt, 'A16 '],
 ['A05H-history', H, 'this.recovery!.record({ taskId:', 'false && this.recovery!.record({ taskId:', ht, 'A05H '],
 ['A01H-double-revert', H, '宿主已把工作区回到 v${plan.fromAppliedVer}', '请撤掉为原补充做的改动。宿主已把工作区回到 v${plan.fromAppliedVer}', ht, 'A01H '],
 ['A15-fence', H, 'if (this.recovery?.current(taskId)?.phase === "pending") return true;', 'if (false) return true;', ht, 'A15 '],
 ['A17-merge', H, 'if (ws?.state === "W4_Integrating") throw', 'if (false) throw', ht, 'A17 '],
 ['A18H-mode', H, 'const merged = ws?.state === "W6_Merged";', 'const merged = false;', ht, 'A18H '],
 ['A19H-text', H, 'return `宿主未核验。工作区要回到', 'return `工作区要回到', ht, 'A19H '],
 ['A19L-missing', R, 'if (!entries.length) return null;', 'if (!entries.length) throw new Error("checkpoint-unavailable");', ht, 'A19L '],
 ['A12I-startup', H, 'void this.executeRecovery(taskId);', 'void taskId;', ht, 'A12I '],
 ['A12B-backup', W, 'return { backupRef: expected, backupSha: sha };\n    };', 'return { backupRef: expected, backupSha: git(ws.dir, ["rev-parse", "HEAD"]) };\n    };', ht, 'A12B '],
 ['A12P-repeat', W, 'git(ws.dir, ["restore", `--source=${sha}`, "--staged", "--worktree", "--", "."]);', 'if (git(ws.dir, ["diff", "--cached", "--name-only"]) === "") git(ws.dir, ["restore", `--source=${sha}`, "--staged", "--worktree", "--", "."]);', ht, 'A12P '],
 ['A12D-completion', R, 'putDoc(this.db, key, cur.ver, completed);', 'putDoc(this.db, key, cur.ver, { ...completed, phase: "pending" });', ht, 'A12D '],
];
const command = files => [process.execPath, '--test', '--test-concurrency=1', '--test-reporter=tap', ...files];
function run(args, name) {
  const r = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  const log = (r.stdout ?? '') + (r.stderr ?? ''); writeFileSync(path.join(out, `${name}.tap`), log);
  return { r, log };
}
const control = run(command([dt, wt, ht]), 'control');
if (control.r.status !== 0) throw new Error('原样对照不绿，禁止判变异');
const results = [];
for (const [id, file, before, after, testFile, prefix] of cases) {
  const original = readFileSync(file, 'utf8');
  if (original.split(before).length !== 2) throw new Error(`${id}: 变异位置不唯一`);
  try {
    writeFileSync(file, original.replace(before, after));
    const { r, log } = run([process.execPath, '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-name-pattern=^${prefix}`, testFile], id);
    const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
    const killed = r.status !== 0 && failed.some(n => n.startsWith(prefix)) && !/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError:/.test(log);
    results.push({ id, file, designated: prefix, status: killed ? 'killed' : 'survived', exit: r.status, failed });
    writeFileSync(path.join(out, 'results.json'), JSON.stringify({ control: { exit: control.r.status }, results }, null, 2) + '\n');
    console.log(`${id} ${killed ? 'killed' : 'survived'}`);
  } finally { writeFileSync(file, original); }
}
const after = run(command([dt, wt, ht]), 'after-control');
console.log(JSON.stringify({ mutations: results.length, killed: results.filter(r => r.status === 'killed').length, afterControl: after.r.status }));
process.exit(results.every(r => r.status === 'killed') && after.r.status === 0 ? 0 : 1);
