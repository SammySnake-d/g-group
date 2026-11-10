// AC-15 宿主入口：真实派活、转交、交付、改挂与 SQLite/Git；Compute 是确定性替身。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { Host } from "./host.ts";
import { scriptedCompute } from "./fakes.ts";
import { all, getDoc, putDoc, run } from "./db.ts";
import type { DeliveryCheckpoint } from "./recovery.ts";
const root = mkdtempSync(path.join(tmpdir(), "gg-a-host-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20 }));
let n = 0;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function settle(host: Host, compute: ReturnType<typeof scriptedCompute>) {
  for (let i = 0; i < 200; i++) {
    await host.idle(); await new Promise(r => setTimeout(r, 5));
    if (!host.loop.busy() && compute.drained()) { await new Promise(r => setTimeout(r, 10)); if (!host.loop.busy() && compute.drained()) return; }
  }
  throw new Error("宿主未收敛");
}
async function scene(code = true) {
  const data = path.join(root, String(++n)); mkdirSync(data);
  const repo = path.join(data, "repo"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "seed"); writeFileSync(path.join(repo, "base"), "NEUTRAL_FIXTURE_NO_CREDENTIALS"); writeFileSync(path.join(repo, "other"), "NEUTRAL_FIXTURE_NO_CREDENTIALS other"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base"); git(repo, "branch", "main");
  let ready = false;
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "初版" }], resumeScript: () => [{ kind: "started", sessionId: "s", resumed: true }, { kind: "completed", result: "补充版" }] });
  const mind: ContactMind = { async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind === "message" && f.sender.kind === "user") {
        if (f.text === "A" || f.text === "B") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: f.text, task: f.text });
        if (f.text.startsWith("补")) { const t = host.listTasks({}).find(t => t.title === "A"); if (t) actions.push({ kind: "forward", taskId: t.id, sourceSeq: f.seq, text: f.text }); }
      }
      if (ready && f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: "交付" });
    }
    return { actions, stateNote: null };
  } };
  const host = new Host({ file: path.join(data, "gg.db"), dataDir: data, mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, ...(code ? { codeRepo: { repo, targetBranch: "main" } } : {}) });
  after(async () => { await host.close(); compute.close(); });
  const c = host.createContact({ name: "开发" }); const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "a", text: "A" }); host.send({ roomId: dm.id, clientActionId: "b", text: "B" }); await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "first", text: "补一" }); await settle(host, compute);
  const m = host.send({ roomId: dm.id, clientActionId: "second", text: "补二" }); await settle(host, compute);
  const A = host.listTasks({}).find(t => t.title === "A")!; const B = host.listTasks({}).find(t => t.title === "B")!;
  if (code) { writeFileSync(path.join(A.workspace!.dir, "base"), "NEUTRAL_FIXTURE_NO_CREDENTIALS changed"); writeFileSync(path.join(A.workspace!.dir, "other"), "changed other"); }
  ready = true;
  compute.emit({ kind: "completed", computeId: A.computeRuns[0]!.computeId, result: "完成" }); await settle(host, compute);
  ready = false;
  const rebind = () => host.rebindFollowUp({ roomId: dm.id, seq: m.seq, fromTaskId: A.id, toTaskId: B.id, expectedBindingVersion: 0, clientActionId: "move" });
  return { host, compute, repo, A: host.taskViewById(A.id), B, rebind, data };
}
test("A05H 真实交付把候选与 appliedVer 同事务登记历史", async () => {
  const s = await scene();
  const h = getDoc<DeliveryCheckpoint[]>(s.host.db, `delivery-history:${s.A.id}`)?.value;
  assert.equal(h?.length, 1);
  assert.equal(h![0]!.artifact, s.A.followUps![0]!.appliedIn);
  assert.equal(h![0]!.candidateSha, s.A.workspace!.candidateSha);
});
test("A01H 宿主恢复后不再要求 Compute 自己撤改且列出重做清单", async () => {
  const s = await scene(); s.rebind(); await settle(s.host, s.compute);
  const text = s.compute.resumed.filter(r => r.computeId === s.A.computeRuns[0]!.computeId).at(-1)!.text;
  assert.match(text, /宿主已把工作区/); assert.doesNotMatch(text, /撤掉为/);
  assert.match(text, /仍在工作区里的/); assert.match(text, /要重做的/); assert.match(text, /refs\/gg\/backup\//);
  assert.equal(readFileSync(path.join(s.A.workspace!.dir, "base"), "utf8"), "NEUTRAL_FIXTURE_NO_CREDENTIALS");
  assert.equal(s.host.taskViewById(s.A.id).followUps![0]!.state, "Received");
});
test("A15 恢复失败时禁止改挂合入和新的 Compute 写入", async () => {
  const s = await scene(); s.host.worktrees!.backup = () => { throw new Error("backup-fixture"); };
  s.rebind(); await settle(s.host, s.compute);
  const before = s.compute.resumed.length;
  assert.throws(() => s.host.rebindFollowUp({ roomId: s.A.roomId, seq: s.A.followUps![0]!.seq, fromTaskId: s.A.id, toTaskId: s.B.id, expectedBindingVersion: 1, clientActionId: "again" }), /恢复/);
  await assert.rejects(s.host.integrateTask(s.A.id), /恢复/);
  assert.equal(s.compute.resumed.length, before);
  assert.match(s.host.taskViewById(s.A.id).waitingFor ?? "", /backup-fixture/);
});
test("A17 W4 拒绝改挂两边版本和关联边均不变", async () => {
  const s = await scene(); const ws = s.host.workspace(s.A.id)!; putDoc(s.host.db, `ws:${s.A.id}`, ws.ver, { ...ws.value, state: "W4_Integrating" });
  assert.throws(s.rebind, /合入/);
  assert.equal(s.host.taskViewById(s.A.id).constraintVersion, s.A.constraintVersion);
  assert.equal(s.host.taskViewById(s.B.id).constraintVersion, s.B.constraintVersion);
});
test("A18H W6 不恢复不重放源任务并告知撤回另开任务", async () => {
  const s = await scene(); const ws = s.host.workspace(s.A.id)!; putDoc(s.host.db, `ws:${s.A.id}`, ws.ver, { ...ws.value, state: "W6_Merged" });
  const before = s.compute.resumed.filter(r => r.computeId === s.A.computeRuns[0]!.computeId).length;
  s.rebind(); await settle(s.host, s.compute);
  assert.equal(s.compute.resumed.filter(r => r.computeId === s.A.computeRuns[0]!.computeId).length, before);
  assert.match(s.host.taskViewById(s.A.id).waitingFor ?? "", /已合入.*另开任务/);
});
test("A19H 无代码仓文字和任务卡片均写宿主未核验", async () => {
  const s = await scene(false); s.rebind(); await settle(s.host, s.compute);
  const text = s.compute.resumed.filter(r => r.computeId === s.A.computeRuns[0]!.computeId).at(-1)!.text;
  assert.match(text, /宿主未核验/);
  assert.match(s.host.taskViewById(s.A.id).waitingFor ?? "", /宿主未核验/);
  assert.ok(all<{ body: string }>(s.host.db, "SELECT body FROM gg_cards WHERE task_id = ?", s.A.id).some(c => /宿主未核验/.test(c.body)));
});
test("A19L 升级缺历史正常改挂但标宿主未核验不猜 base", async () => {
  const s = await scene(); run(s.host.db, "DELETE FROM docs WHERE key = ?", `delivery-history:${s.A.id}`);
  s.rebind(); await settle(s.host, s.compute);
  assert.match(s.host.taskViewById(s.A.id).waitingFor ?? "", /宿主未核验/);
  assert.equal(readFileSync(path.join(s.A.workspace!.dir, "base"), "utf8"), "NEUTRAL_FIXTURE_NO_CREDENTIALS changed");
});

async function crashAndRestart(stage: string) {
  const s = await scene();
  s.host.worktrees!.backup = () => { throw new Error("pause-before-backup"); };
  s.rebind(); await settle(s.host, s.compute);
  const intent = s.host.recovery!.current(s.A.id);
  assert.ok(intent, "必须已有落盘恢复意图才允许模拟宿主退出");
  await s.host.close(); s.compute.close();
  const script = `
import { Host } from './packages/server/src/host.ts';
import { Worktrees } from './packages/server/src/worktree.ts';
import { RecoveryStore } from './packages/server/src/recovery.ts';
import { scriptedCompute } from './packages/server/src/fakes.ts';
import { execFileSync } from 'node:child_process';
const [data, repo, taskId, stage] = process.argv.slice(1);
const backup = Worktrees.prototype.backup;
const restore = Worktrees.prototype.restoreTo;
const execute = RecoveryStore.prototype.execute;
if (stage === 'intent') RecoveryStore.prototype.execute = function(...args) { process.exit(71); };
if (stage === 'backup') Worktrees.prototype.backup = function(ws) { backup.call(this, ws); process.exit(72); };
if (stage === 'partial') Worktrees.prototype.restoreTo = function(ws, sha) { execFileSync('git', ['restore', '--source=' + sha, '--staged', '--worktree', '--', 'base'], { cwd: ws.dir }); process.exit(73); };
if (stage === 'restored') Worktrees.prototype.restoreTo = function(ws, sha) { restore.call(this, ws, sha); process.exit(74); };
const c = scriptedCompute({ resumeScript: () => [] });
const h = new Host({ file: data + '/gg.db', dataDir: data, codeRepo: { repo, targetBranch: 'main' }, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }), compute: () => c.adapter, maxDeferMs: 1 });
await new Promise(r => setTimeout(r, 50)); await h.idle();
console.log(JSON.stringify({ intent: h.recovery.current(taskId), resumed: c.resumed.length }));
await h.close(); c.close();
`;
  let exit: number | null = null;
  try { execFileSync(process.execPath, ["--input-type=module", "-e", script, s.data, s.repo, s.A.id, stage], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }); }
  catch (e) { exit = (e as { status: number }).status; }
  const refBefore = (() => { try { return git(s.repo, "rev-parse", "--verify", intent.backupRef); } catch { return null; } })();
  const finish = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, s.data, s.repo, s.A.id, "finish"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim()) as { intent: { phase: string; targetSha: string; backupSha: string }; resumed: number };
  const repeated = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, s.data, s.repo, s.A.id, "finish"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim()) as { resumed: number };
  return { exit, phase: finish.intent.phase, sameTarget: finish.intent.targetSha === intent.targetSha, sameBackup: refBefore === null || finish.intent.backupSha === refBefore, resumes: finish.resumed, repeated: repeated.resumed, bytes: readFileSync(path.join(s.A.workspace!.dir, "base"), "utf8"), remainingBytes: readFileSync(path.join(s.A.workspace!.dir, "other"), "utf8") };
}
test("A12I 意图提交后宿主退出重启完成恢复", async () => {
  const r = await crashAndRestart("intent");
  assert.deepEqual(r, { exit: 71, phase: "done", sameTarget: true, sameBackup: true, resumes: 1, repeated: 0, bytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS", remainingBytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS other" });
});
test("A12B 备份后宿主退出重启复用同一备份", async () => {
  const r = await crashAndRestart("backup");
  assert.deepEqual(r, { exit: 72, phase: "done", sameTarget: true, sameBackup: true, resumes: 1, repeated: 0, bytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS", remainingBytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS other" });
});
test("A12P 恢复中宿主退出重启幂等恢复同一目标", async () => {
  const r = await crashAndRestart("partial");
  assert.deepEqual(r, { exit: 73, phase: "done", sameTarget: true, sameBackup: true, resumes: 1, repeated: 0, bytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS", remainingBytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS other" });
});
test("A12D 文件已恢复而完成未提交时重启不重新备份", async () => {
  const r = await crashAndRestart("restored");
  assert.deepEqual(r, { exit: 74, phase: "done", sameTarget: true, sameBackup: true, resumes: 1, repeated: 0, bytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS", remainingBytes: "NEUTRAL_FIXTURE_NO_CREDENTIALS other" });
});
