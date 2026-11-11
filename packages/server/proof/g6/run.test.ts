// G6 runner 的建树:每组在临时工作树里从基线按序合入各片(不推送、不改分支),叠上 g6 目录,依赖按链接复用不另装。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { classifyProbe, gatewayUp, gitEnv, gitQuery, linkNodeModules, MergeConflict, modelStatesFor, prepareTree, probeModel, reusable } from "./run.ts";
import { mkRecord } from "./fixtures/build.ts";

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
const state = (base: string, inputs: [string, string][], groupCommit: string | null = null) => ({ id: "gx", label: "x", state: "可跑" as const, reason: null, base, groupCommit, inputs: inputs.map(([slice, sha]) => ({ slice, branch: slice, ref: sha, sha, receipt: true })) });

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

test("有只供 G6 的组提交就直接 detach 到它,不再按序合入;isAncestor 认祖先关系", () => {
  const { r, base, s1, s2 } = repo("grp");
  git(r, "checkout", "-q", "-b", "m12", s1);
  git(r, "merge", "--no-ff", "--no-edit", "-q", s2);
  const m12 = git(r, "rev-parse", "HEAD");
  git(r, "checkout", "-q", "main");
  const q = gitQuery(r);
  assert.deepEqual([q.isAncestor(s1, m12), q.isAncestor(s2, m12), q.isAncestor(m12, s1), q.isAncestor(base, base)], [true, true, false, true]);
  const wt = path.join(dir, "wt-grp");
  const { head } = prepareTree(r, state(base, [["S3", "不会被合入"]], m12), wt);
  assert.equal(head, m12);
  assert.deepEqual([readFileSync(path.join(wt, "a.txt"), "utf8"), readFileSync(path.join(wt, "b.txt"), "utf8")], ["2\n", "S1\n"]);
});

test("续跑只沿用同一组提交、同一续跑身份、同一题同一次的合法记录;运行出错的重跑,超时与上游失败照常沿用", () => {
  const want = { commit: "c", reuseKey: "rk", item: "T", rep: 1 };
  assert.equal(reusable(mkRecord(), want), true);
  assert.equal(reusable(mkRecord({ status: "timeout" }), want), true);
  assert.equal(reusable(mkRecord({ status: "config_insufficient" }), want), true);
  assert.equal(reusable(mkRecord({ status: "error" }), want), false);
  assert.equal(reusable(mkRecord({ commit: "d" }), want), false);
  assert.equal(reusable(mkRecord({ reuseKey: "other" }), want), false);
  assert.equal(reusable(mkRecord({ rep: 2 }), want), false);
  assert.equal(reusable(null, want), false);
  assert.equal(reusable({ ...mkRecord(), schema: "x" }, want), false);
});

test("探测:没准备好(429 或上游错误)就等一段再探,到上限判不跑;拿到正文就放行;记下每次时刻、状态与 retry-after", async () => {
  const waits: number[] = [];
  const OK_STREAM = 'event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"好"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}';
  const seq = (statuses: number[]) => {
    let i = 0;
    return (async () => {
      const st = statuses[Math.min(i++, statuses.length - 1)]!;
      return new Response(st === 200 ? OK_STREAM : JSON.stringify({ error: { type: "rate_limit_error" } }), { status: st, headers: st === 429 ? { "retry-after": "819" } : {} });
    }) as typeof fetch;
  };
  const env = { ANTHROPIC_BASE_URL: "http://gw.invalid/", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" };
  const no = await probeModel({ model: "hy", env, fetch: seq([429]), tries: 3, waitMs: 1500, sleep: async (ms) => void waits.push(ms), now: () => new Date(0) });
  assert.deepEqual([no.ok, no.attempts.length, no.attempts[0], waits], [false, 3, { at: "1970-01-01T00:00:00.000Z", status: 429, retryAfter: "819", note: "HTTP 429" }, [1500, 1500]]);
  const later = await probeModel({ model: "hy", env, fetch: seq([429, 200]), tries: 3, waitMs: 10, sleep: async () => {} });
  assert.deepEqual([later.ok, later.attempts.map((a) => a.status)], [true, [429, 200]]);
  const other = await probeModel({ model: "hy", env, fetch: seq([500]), tries: 3, waitMs: 10, sleep: async () => {} });
  assert.deepEqual([other.ok, other.attempts.length], [false, 3]);
  const recovered = await probeModel({ model: "hy", env, fetch: seq([500, 200]), tries: 3, waitMs: 10, sleep: async () => {} });
  assert.deepEqual([recovered.ok, recovered.attempts.map((a) => a.status)], [true, [500, 200]]);
});

test("网关在不在:收到任何 HTTP 回复算在,连不上算不在", async () => {
  assert.equal(await gatewayUp("http://gw.invalid/", (async () => new Response("x", { status: 404 })) as typeof fetch), true);
  assert.equal(await gatewayUp("http://gw.invalid/", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch), false);
});

test("模型状态:跑过的记已跑(探测记录照留),没跑过但有 429 探测记录记未测,两者都没有记未跑", () => {
  const rec = mkRecord({ model: "hy" });
  const probe = { state: "未测(上游 429 限流)", attempts: [{ at: "t", status: 429, retryAfter: "819", note: "rate_limit_error" }] };
  assert.deepEqual(modelStatesFor("hy", [rec], probe), { state: "已跑", attempts: probe.attempts });
  assert.deepEqual(modelStatesFor("hy", [], probe), probe);
  assert.deepEqual(modelStatesFor("hy", [], { state: "可跑", attempts: [] }), { state: "未跑(本次未选或无可跑的组)", attempts: [] });
  assert.deepEqual(modelStatesFor("hy", [], undefined), { state: "未跑(本次未选或无可跑的组)", attempts: [] });
  assert.deepEqual(modelStatesFor("other", [rec], undefined), { state: "未跑(本次未选或无可跑的组)", attempts: [] });
});

test("探测结果怎么读:429 与「200 但流里是 error 事件」都算没准备好并带上游原话,拿到正文才算好", () => {
  assert.deepEqual(classifyProbe(200, 'event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"好"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}'), { ready: true, note: "ok" });
  const bad = classifyProbe(200, 'event: message_start\ndata: {}\n\nevent: error\ndata: {"error":{"message":"fnqtz: No available accounts (503: you can retry your request)","type":"api_error"},"type":"error"}\n\n');
  assert.deepEqual([bad.ready, bad.note], [false, "fnqtz: No available accounts (503: you can retry your request)"]);
  assert.deepEqual(classifyProbe(429, "{}"), { ready: false, note: "HTTP 429" });
  const empty = classifyProbe(200, "event: message_start\ndata: {}");
  assert.deepEqual([empty.ready, empty.note.startsWith("HTTP 200 但没有正文")], [false, true]);
  assert.deepEqual([classifyProbe(200, 'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"想"}}').ready], [true]);
});
