// AC-15 A05–A16:真实隔离 Git + SQLite，内容均为中性夹具。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { openDb, putDoc, tx, getDoc } from "./db.ts";
import { RecoveryStore } from "./recovery.ts";
import { Worktrees, type RecoveryWorkspace, type Workspace } from "./worktree.ts";
const tmp = mkdtempSync(path.join(tmpdir(), "gg-a-recovery-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 20 }));
let num = 0;
const text = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(WorktreeClass: typeof Worktrees, RecoveryClass: typeof RecoveryStore) {
  const dir = path.join(tmp, String(++num)); mkdirSync(dir);
  git(dir, "init", "-q", "-b", "seed");
  writeFileSync(path.join(dir, "中文 空格.txt"), text); writeFileSync(path.join(dir, ".gitignore"), "ignored\n");
  writeFileSync(path.join(dir, "deleted"), text);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base"); git(dir, "branch", "main");
  const wt = new WorktreeClass({ repo: dir, targetBranch: "main" }, path.join(dir, "trees"));
  const ws = wt.provision("A");
  const db = openDb(path.join(dir, "state.db")); after(() => db.close());
  putDoc(db, "ws:A", 0, ws);
  const store = new RecoveryClass(db, wt);
  store.initialize(ws);
  return { dir, wt, ws, db, store };
}
function recovery(ws: Workspace): RecoveryWorkspace { return { ...ws, recovery: { ver: 3, backupRef: "refs/gg/backup/41/3" } }; }
function change(s: ReturnType<typeof fixture>) {
  writeFileSync(path.join(s.ws.dir, "中文 空格.txt"), `${text} changed`);
  writeFileSync(path.join(s.ws.dir, "added"), text);
  rmSync(path.join(s.ws.dir, "deleted"));
  const ws = s.wt.pin(s.ws, "delivery");
  writeFileSync(path.join(ws.dir, "untracked"), `${text} user`);
  writeFileSync(path.join(ws.dir, "ignored"), `${text} ignored`);
  return ws;
}
test("A05 同版本两次交付保留历史且 action 幂等", () => {
  const s = fixture(Worktrees, RecoveryStore);
  for (const deliveryId of ["one", "two", "two"]) s.store.record({ taskId: "A", deliveryId, resultVer: 1, artifact: `git:${s.ws.baseSha}@v1`, candidateSha: s.ws.baseSha });
  assert.deepEqual(s.store.history("A").map(c => [c.deliveryId, c.ordinal]), [["one", 1], ["two", 2]]);
});
test("A06 DB 失败回滚交付历史和工作树文档", () => {
  const s = fixture(Worktrees, RecoveryStore);
  assert.throws(() => tx(s.db, () => { s.store.record({ taskId: "A", deliveryId: "one", resultVer: 1, artifact: "a", candidateSha: s.ws.baseSha }); putDoc(s.db, "ws:A", 1, { ...s.ws, state: "W3_Pinned" }); throw new Error("db-fixture"); }), /db-fixture/);
  assert.deepEqual(s.store.history("A"), []);
  assert.equal(getDoc<Workspace>(s.db, "ws:A")!.value.state, "W2_Active");
});
test("A07 首次回 base 后续取严格前驱且历史对不上拒绝", () => {
  const s = fixture(Worktrees, RecoveryStore);
  s.store.record({ taskId: "A", deliveryId: "first", resultVer: 1, artifact: "a", candidateSha: s.ws.baseSha });
  const ws = change(s);
  s.store.record({ taskId: "A", deliveryId: "second", resultVer: 2, artifact: "b", candidateSha: ws.candidateSha! });
  assert.equal(s.store.target(ws, 1, "a"), ws.baseSha);
  assert.equal(s.store.target(ws, 2, "b"), ws.baseSha);
  writeFileSync(path.join(ws.dir, "third"), text);
  const third = s.wt.pin(ws, "third");
  s.store.record({ taskId: "A", deliveryId: "third", resultVer: 3, artifact: "c", candidateSha: third.candidateSha! });
  assert.equal(s.store.target(third, 3, "c"), ws.candidateSha);
  assert.throws(() => s.store.target(ws, 2, "foreign"), /checkpoint-unavailable/);
  assert.equal(s.store.target({ ...ws, taskId: "legacy" }, 2, "b"), null);
});
test("A08 文件恢复含新增删除中文路径且 HEAD 不动", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); const before = git(ws.dir, "rev-parse", "HEAD");
  s.wt.backup(recovery(ws)); const out = s.wt.restoreTo(recovery(ws), ws.baseSha);
  assert.equal(readFileSync(path.join(ws.dir, "中文 空格.txt"), "utf8"), text);
  assert.equal(existsSync(path.join(ws.dir, "added")), false);
  assert.equal(existsSync(path.join(ws.dir, "untracked")), false);
  assert.equal(git(ws.dir, "rev-parse", "HEAD"), before);
  assert.equal(out.state, "W2_Active");
  assert.equal(readFileSync(path.join(ws.dir, "deleted"), "utf8"), text);
});
test("A09 ignored 目标分支与另一工作树保持原样", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); const other = s.wt.provision("B"); const target = s.wt.targetHead();
  s.wt.backup(recovery(ws)); s.wt.restoreTo(recovery(ws), ws.baseSha);
  assert.equal(readFileSync(path.join(ws.dir, "ignored"), "utf8"), `${text} ignored`);
  assert.equal(readFileSync(path.join(other.dir, "中文 空格.txt"), "utf8"), text);
  assert.equal(s.wt.targetHead(), target);
});
test("A10 backup ref 另开工作树可恢复未跟踪用户字节", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); const b = s.wt.backup(recovery(ws));
  const out = path.join(s.dir, "backup"); git(s.dir, "worktree", "add", "--detach", out, b.backupRef);
  assert.equal(readFileSync(path.join(out, "untracked"), "utf8"), `${text} user`);
  assert.equal(existsSync(path.join(out, "ignored")), false);
});
test("A11 开启签名也能备份且真实 index 不变重复 ref 不覆盖", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s);
  git(s.dir, "config", "commit.gpgsign", "true"); git(s.dir, "config", "gpg.program", "/does-not-exist");
  const index = git(ws.dir, "rev-parse", "--git-path", "index"); const before = readFileSync(index);
  const one = s.wt.backup(recovery(ws)); writeFileSync(path.join(ws.dir, "untracked"), "later");
  const two = s.wt.backup(recovery(ws));
  assert.equal(one.backupSha, two.backupSha); assert.deepEqual(readFileSync(index), before);
});
test("A12 备份后恢复失败重开数据库仍用原 target 和 backup", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); putDoc(s.db, "ws:A", 1, ws);
  s.store.enqueue({ taskId: "A", ver: 3, targetSha: ws.baseSha, actionId: "r" });
  const restore = s.wt.restoreTo.bind(s.wt); s.wt.restoreTo = () => { throw new Error("restore-fixture"); };
  assert.throws(() => s.store.execute("A", () => {}), /restore-fixture/);
  const failed = s.store.current("A")!; assert.equal(failed.phase, "pending");
  const backup = git(s.dir, "rev-parse", failed.backupRef);
  s.wt.restoreTo = restore;
  const db2 = openDb(path.join(s.dir, "state.db"));
  try { new RecoveryStore(db2, s.wt).execute("A", () => {}); } finally { db2.close(); }
  assert.equal(s.store.current("A")!.targetSha, ws.baseSha);
  assert.equal(git(s.dir, "rev-parse", failed.backupRef), backup);
  assert.equal(s.store.current("A")!.phase, "done");
});
test("A13 完成与待重放写入同事务重复消费不重复排队", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); putDoc(s.db, "ws:A", 1, ws);
  s.store.enqueue({ taskId: "A", ver: 3, targetSha: ws.baseSha, actionId: "r" });
  let count = 0; s.store.execute("A", () => { count++; }); s.store.execute("A", () => { count++; });
  assert.equal(count, 1); assert.equal(s.store.current("A")!.phase, "done");
});
test("A14 完成事务失败不完成不丢恢复意图", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = change(s); putDoc(s.db, "ws:A", 1, ws);
  s.store.enqueue({ taskId: "A", ver: 3, targetSha: ws.baseSha, actionId: "r" });
  assert.throws(() => s.store.execute("A", () => { throw new Error("complete-fixture"); }), /complete-fixture/);
  assert.equal(s.store.current("A")!.phase, "pending");
  assert.equal(getDoc<Workspace>(s.db, "ws:A")!.value.state, "W3_Pinned");
});
test("A16 W5 恢复作废候选审查且下一次 pin 沿原分支前进", () => {
  const s = fixture(Worktrees, RecoveryStore); const ws = { ...change(s), state: "W5_Conflict" as const }; const head = git(ws.dir, "rev-parse", "HEAD");
  s.wt.backup(recovery(ws)); const out = s.wt.restoreTo(recovery(ws), ws.baseSha);
  assert.equal(out.candidateSha, null); assert.equal(out.state, "W2_Active");
  const pinned = s.wt.pin(out, "new"); assert.equal(git(ws.dir, "rev-parse", "HEAD^"), head); assert.notEqual(pinned.candidateSha, ws.candidateSha);
});
test("A07L 升级旧工作树的首条新历史不能冒充完整交付历史", () => {
  const s = fixture(Worktrees, RecoveryStore);
  s.db.store.db.prepare("DELETE FROM docs WHERE key = ?").run("delivery-origin:A");
  const ws = change(s);
  s.store.record({ taskId: "A", deliveryId: "after-upgrade", resultVer: 2, artifact: "new", candidateSha: ws.candidateSha! });
  assert.equal(s.store.target(ws, 2, "new"), null, "缺少第一份交付之前的可核验前驱，必须保持宿主未核验");
  assert.equal(s.store.target(ws, 1, "legacy"), null, "升级前的未记录产物不能冒充历史损坏");
  assert.throws(() => s.store.target(ws, 3, "foreign"), /checkpoint-unavailable/);
  writeFileSync(path.join(ws.dir, "newer"), text);
  const newer = s.wt.pin(ws, "newer");
  s.store.record({ taskId: "A", deliveryId: "newer", resultVer: 3, artifact: "newer", candidateSha: newer.candidateSha! });
  assert.equal(s.store.target(newer, 3, "newer"), ws.candidateSha, "后续已有确定前驱的区间仍可核验");
});
