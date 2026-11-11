// G6 runner 的建树:每组在临时工作树里从基线按序合入各片(不推送、不改分支),叠上 g6 目录,依赖按链接复用不另装。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gitEnv, gitQuery, linkNodeModules, MergeConflict, prepareTree } from "./run.ts";

// 临时仓库不读本机全局/系统 git 配置(本机全局配置里的 trace2 守护会异步往 .git 里写文件,删目录时撞 ENOTEMPTY);runner 的子进程继承
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "g6-run-")));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
/**
 * 本文件自己的 git:剥掉继承来的全部 GIT_* (在 pre-push 钩子里跑时有 GIT_DIR,不剥就会改到调用方仓库),
 * 也不读本机全局/系统配置(本机全局配置里的 trace2 守护会异步往 .git 里写文件,删目录时撞 ENOTEMPTY)。
 */
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.hooksPath=/dev/null", ...a], { cwd, encoding: "utf8", env: env() }).trim();
const put = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

/** 临时仓库:base 上 a.txt=1(name.txt 区分不同仓库);S1 改 b.txt;S2 把 a.txt 改成 2;S3 把 a.txt 改成 3(与 S2 冲突) */
function repo(name = "repo") {
  const r = path.join(dir, name);
  mkdirSync(r);
  git(r, "init", "-q", "-b", "main");
  put(r, "a.txt", "1\n");
  put(r, "name.txt", `${name}\n`);
  git(r, "add", ".");
  git(r, "commit", "-qm", "base");
  const base = git(r, "rev-parse", "HEAD");
  const branch = (name: string, file: string, text: string) => {
    git(r, "checkout", "-q", "-b", name, base);
    put(r, file, text);
    git(r, "add", ".");
    git(r, "commit", "-qm", name);
    return git(r, "rev-parse", "HEAD");
  };
  const s1 = branch("s1", "b.txt", "S1\n");
  const s2 = branch("s2", "a.txt", "2\n");
  const s3 = branch("s3", "a.txt", "3\n");
  git(r, "checkout", "-q", "main");
  return { r, base, s1, s2, s3 };
}
const state = (base: string, inputs: [string, string][]) => ({ id: "gx", label: "x", state: "可跑" as const, reason: null, base, inputs: inputs.map(([slice, sha]) => ({ slice, branch: slice, ref: sha, sha, receipt: true })) });

test("依赖链接:第三方包链到 runner 的 node_modules,@g-group 链到被测树自己的 packages,file: 依赖链到被测树", () => {
  const runner = path.join(dir, "runner");
  put(runner, "node_modules/foo/index.js", "");
  put(runner, "node_modules/@scope/bar/index.js", "");
  put(runner, "node_modules/@g-group/kernel/index.js", "");
  put(runner, "node_modules/.package-lock.json", "{}");
  const tree = path.join(dir, "tree");
  put(tree, "packages/kernel/package.json", JSON.stringify({ name: "@g-group/kernel", dependencies: { "acp-kernel": "file:../../third_party/acp-kernel" } }));
  put(tree, "third_party/acp-kernel/package.json", "{}");
  const linked = linkNodeModules(runner, tree);
  assert.deepEqual(linked, ["@g-group/kernel", "acp-kernel→third_party/acp-kernel"]);
  assert.equal(readlinkSync(path.join(tree, "node_modules/foo")), path.join(runner, "node_modules/foo"));
  assert.equal(readlinkSync(path.join(tree, "node_modules/@scope/bar")), path.join(runner, "node_modules/@scope/bar"));
  assert.equal(readlinkSync(path.join(tree, "node_modules/@g-group/kernel")), path.join("..", "..", "packages", "kernel"));
  assert.equal(readlinkSync(path.join(tree, "node_modules/acp-kernel")), path.join(tree, "third_party/acp-kernel"));
  assert.equal(existsSync(path.join(tree, "node_modules/.package-lock.json")), false);
});

test("建组工作树:基线上按序合入各片得到新 HEAD,叠上 g6 目录(不含测试);合入冲突报出是哪片、哪些文件", () => {
  const { r, base, s1, s2, s3 } = repo();
  const q = gitQuery(r);
  assert.equal(q.revParse("s2"), s2);
  assert.equal(q.revParse("没有这个分支"), null);
  assert.deepEqual([q.hasFile(s1, "b.txt"), q.hasFile(base, "b.txt")], [true, false]);
  const ok = path.join(dir, "wt-ok");
  const { head } = prepareTree(r, state(base, [["S1", s1], ["S2", s2]]), ok);
  assert.notEqual(head, base);
  assert.deepEqual([readFileSync(path.join(ok, "a.txt"), "utf8"), readFileSync(path.join(ok, "b.txt"), "utf8")], ["2\n", "S1\n"]);
  assert.equal(existsSync(path.join(ok, "packages/server/proof/g6/driver.ts")), true);
  assert.equal(existsSync(path.join(ok, "packages/server/proof/g6/run.test.ts")), false);
  assert.equal(git(r, "rev-parse", "main"), base);
  let err: unknown = null;
  try {
    prepareTree(r, state(base, [["S2", s2], ["S3", s3]]), path.join(dir, "wt-bad"));
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof MergeConflict);
  assert.deepEqual([err.slice, err.files, err.message], ["S3", ["a.txt"], "合入 S3 冲突:a.txt"]);
});

test("调用方环境里带 GIT_DIR / GIT_WORK_TREE(如在 pre-push 钩子里跑)时,runner 的 git 子进程只动目标仓库,不碰调用方仓库", () => {
  const decoy = repo("decoy");
  const target = repo("target");
  const before = git(decoy.r, "for-each-ref", "--format=%(refname) %(objectname)");
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(decoy.r, ".git");
  process.env.GIT_WORK_TREE = decoy.r;
  try {
    assert.equal(gitEnv({ GIT_AUTHOR_NAME: "g6" }).GIT_DIR, undefined);
    assert.equal(gitEnv({ GIT_AUTHOR_NAME: "g6" }).GIT_AUTHOR_NAME, "g6");
    assert.equal(gitQuery(target.r).revParse("s1"), target.s1);
    const { head } = prepareTree(target.r, state(target.base, [["S1", target.s1]]), path.join(dir, "wt-env"));
    assert.equal(readFileSync(path.join(dir, "wt-env", "b.txt"), "utf8"), "S1\n");
    assert.notEqual(head, target.base);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.tree;
  }
  assert.equal(git(decoy.r, "for-each-ref", "--format=%(refname) %(objectname)"), before);
  assert.equal(git(decoy.r, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});
