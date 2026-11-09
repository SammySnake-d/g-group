// AC-22 worktree 隔离与合流(C-US13、R-Worktree W2–W6、V19-03):每个代码任务独立 worktree + 任务分支;交付钉住候选提交;
// 合入前校验目标分支 head:主线未变直接快进,主线已推进就基于新 head 合并并重验,冲突或重验失败目标分支不动;CAS 被抢就基于最新 head 重来。
// 全部用临时目录里的真实 git 仓库,文件内容是中性标记。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter, ComputeEvent, SpawnResult } from "@g-group/adapter-cc-compute";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { Worktrees } from "./worktree.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "gg-wt-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const NEUTRAL = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const env = (() => {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) e[k] = v;
  return e;
})();
const G = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
let n = 0;
/** 一个裸仓库,main 上有 README.md */
function makeRepo(): string {
  const src = path.join(tmp, `src${++n}`);
  mkdirSync(src);
  G(src, "init", "-q", "-b", "main");
  writeFileSync(path.join(src, "README.md"), `${NEUTRAL}\n`);
  G(src, "add", "-A");
  G(src, "commit", "-q", "-m", "init");
  const bare = path.join(tmp, `repo${n}.git`);
  G(tmp, "clone", "-q", "--bare", src, bare);
  return bare;
}
const head = (repo: string) => G(repo, "rev-parse", "refs/heads/main");
/** 别的任务先合入了:在 main 上加一个提交 */
function advance(repo: string, file: string, content: string): string {
  const d = path.join(tmp, `adv${++n}`);
  G(repo, "worktree", "add", "-q", "--detach", d, "main");
  writeFileSync(path.join(d, file), content);
  G(d, "add", "-A");
  G(d, "commit", "-q", "-m", `advance ${file}`);
  const sha = G(d, "rev-parse", "HEAD");
  G(repo, "update-ref", "refs/heads/main", sha);
  G(repo, "worktree", "remove", "--force", d);
  return sha;
}
/** 重验脚本:记下合并结果的两个父提交和文件列表;第一次运行时可以顺手再推进一次 main(模拟重验期间别的任务合入);按参数退出码退出 */
const VERIFY_SRC = `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [log, exitCode, repo, once, scratch] = process.argv.slice(2);
const g = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
fs.appendFileSync(log, JSON.stringify({ p1: g(process.cwd(), "rev-parse", "HEAD^1"), p2: g(process.cwd(), "rev-parse", "HEAD^2"), files: fs.readdirSync(process.cwd()).filter((f) => f !== ".git").sort() }) + "\\n");
if (once && !fs.existsSync(once)) {
  fs.writeFileSync(once, "x");
  const d = path.join(scratch, "late-" + Date.now());
  g(repo, "worktree", "add", "-q", "--detach", d, "main");
  fs.writeFileSync(path.join(d, "late.md"), "${NEUTRAL} late\\n");
  g(d, "add", "-A");
  g(d, "commit", "-q", "-m", "late");
  g(repo, "update-ref", "refs/heads/main", g(d, "rev-parse", "HEAD"));
  g(repo, "worktree", "remove", "--force", d);
}
process.stdout.write(Number(exitCode) === 0 ? "verify ok" : "NEUTRAL_VERIFY_FAIL");
process.exit(Number(exitCode));
`;
const verifyScript = path.join(tmp, "verify.cjs");
writeFileSync(verifyScript, VERIFY_SRC);
function verifier(opts: { exit?: number; repo?: string; advanceOnce?: boolean } = {}) {
  const log = path.join(tmp, `verify${++n}.log`);
  const args = [verifyScript, log, String(opts.exit ?? 0), opts.repo ?? "", opts.advanceOnce ? path.join(tmp, `once${n}`) : "", tmp];
  return {
    spec: { command: process.execPath, args },
    calls: (): { p1: string; p2: string; files: string[] }[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
const root = () => path.join(tmp, `wt${++n}`);

test("两个任务各开独立 worktree 与任务分支:目录不同,一方的改动另一方看不见,重复申请返回同一个", () => {
  const repo = makeRepo();
  const wt = new Worktrees({ repo, targetBranch: "main" }, root());
  const a = wt.provision("t-a");
  const b = wt.provision("t-b");
  assert.notEqual(a.dir, b.dir);
  assert.equal(a.branch, "gg/task-t-a");
  assert.equal(b.branch, "gg/task-t-b");
  assert.equal(a.baseSha, head(repo));
  assert.equal(a.state, "W2_Active");
  assert.equal(G(a.dir, "rev-parse", "--abbrev-ref", "HEAD"), "gg/task-t-a");
  writeFileSync(path.join(a.dir, "a.md"), `${NEUTRAL} a\n`);
  assert.equal(existsSync(path.join(b.dir, "a.md")), false);
  const pa = wt.pin(a, "a 的改动");
  assert.equal(pa.state, "W3_Pinned");
  assert.equal(pa.candidateSha, G(repo, "rev-parse", "refs/heads/gg/task-t-a"));
  assert.notEqual(pa.candidateSha, a.baseSha);
  assert.equal(G(b.dir, "status", "--porcelain"), "", "b 的工作区不受 a 的提交影响");
  assert.equal(G(b.dir, "rev-parse", "HEAD"), a.baseSha);
  assert.deepEqual(wt.provision("t-a", pa), pa, "同一任务再申请返回已有工作树");
  assert.throws(() => wt.provision("t-a", null), /已被占用/);
});

test("主线未变:钉住的候选直接快进合入,目标分支等于候选 sha,不跑重验,任务工作树清理、分支保留", async () => {
  const repo = makeRepo();
  const v = verifier();
  const wt = new Worktrees({ repo, targetBranch: "main", verify: v.spec }, root());
  const a = wt.provision("t-ff");
  writeFileSync(path.join(a.dir, "doc.md"), `${NEUTRAL} doc\n`);
  const p = wt.pin(a, "写 doc");
  const r = await wt.integrate(p);
  assert.ok(r.ok, r.ok ? "" : r.detail);
  assert.equal(r.mode, "fast-forward");
  assert.equal(head(repo), p.candidateSha);
  assert.equal(r.ws.state, "W6_Merged");
  assert.equal(r.ws.mergedSha, p.candidateSha);
  assert.equal(r.ws.targetHead, a.baseSha);
  assert.equal(r.ws.verifiedOn, null);
  assert.deepEqual(v.calls(), [], "主线未变不重验");
  assert.equal(existsSync(a.dir), false);
  assert.equal(G(repo, "rev-parse", "refs/heads/gg/task-t-ff"), p.candidateSha);
  assert.equal(G(repo, "show", "main:doc.md"), `${NEUTRAL} doc`);
});

test("主线被推进到 H1:基于 H1 合并后重跑验证,验证跑在含 H1 与候选的合并结果上,过了才推进目标分支", async () => {
  const repo = makeRepo();
  const v = verifier();
  const wt = new Worktrees({ repo, targetBranch: "main", verify: v.spec }, root());
  const a = wt.provision("t-h1");
  writeFileSync(path.join(a.dir, "mine.md"), `${NEUTRAL} mine\n`);
  const p = wt.pin(a, "写 mine");
  const h1 = advance(repo, "other.md", `${NEUTRAL} other\n`);
  const r = await wt.integrate(p);
  assert.ok(r.ok, r.ok ? "" : r.detail);
  assert.equal(r.mode, "merged-and-verified");
  assert.equal(r.ws.verifiedOn, h1);
  assert.equal(r.ws.targetHead, h1);
  const calls = v.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.p1, h1, "验证跑在以 H1 为第一父提交的合并结果上");
  assert.equal(calls[0]!.p2, p.candidateSha);
  assert.deepEqual(calls[0]!.files, ["README.md", "mine.md", "other.md"]);
  assert.equal(head(repo), r.ws.mergedSha);
  assert.equal(G(repo, "rev-parse", `${r.ws.mergedSha}^1`), h1);
  assert.equal(G(repo, "rev-parse", `${r.ws.mergedSha}^2`), p.candidateSha);
});

test("主线推进且与候选冲突:进 W5,目标分支 sha 不变,不提交新候选就拒绝再合;修复后钉新候选才能合入", async () => {
  const repo = makeRepo();
  const v = verifier();
  const wt = new Worktrees({ repo, targetBranch: "main", verify: v.spec }, root());
  const a = wt.provision("t-cf");
  writeFileSync(path.join(a.dir, "README.md"), `${NEUTRAL} from task\n`);
  const p = wt.pin(a, "改 README");
  const h1 = advance(repo, "README.md", `${NEUTRAL} from main\n`);
  const r = await wt.integrate(p);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.reason, "merge-conflict");
  assert.equal(r.ws.state, "W5_Conflict");
  assert.equal(r.ws.conflict?.kind, "merge");
  assert.match(r.ws.conflict?.detail ?? "", /README\.md/);
  assert.equal(r.ws.targetHead, h1);
  assert.equal(head(repo), h1, "冲突不污染主线");
  assert.deepEqual(v.calls(), [], "合并都没成功,不跑重验");
  const again = await wt.integrate(r.ws);
  assert.equal(again.ok ? "" : again.reason, "unresolved-conflict");
  assert.equal(head(repo), h1);
  assert.deepEqual(wt.pin(r.ws, "没改"), r.ws, "没有新提交,仍停在 W5");
  // 作者基于最新主线修复(保留自己的版本)后再钉候选
  G(a.dir, "merge", "-q", "-X", "ours", "--no-edit", "main");
  const fixed = wt.pin(r.ws, "修复冲突");
  assert.equal(fixed.state, "W3_Pinned");
  assert.notEqual(fixed.candidateSha, p.candidateSha);
  const done = await wt.integrate(fixed);
  assert.ok(done.ok, done.ok ? "" : done.detail);
  assert.equal(done.mode, "fast-forward");
  assert.equal(head(repo), fixed.candidateSha);
  assert.equal(G(repo, "show", "main:README.md"), `${NEUTRAL} from task`);
});

test("主线推进后重验失败:目标分支不动,记下验证输出,进 W5", async () => {
  const repo = makeRepo();
  const v = verifier({ exit: 3 });
  const wt = new Worktrees({ repo, targetBranch: "main", verify: v.spec }, root());
  const a = wt.provision("t-vf");
  writeFileSync(path.join(a.dir, "mine.md"), `${NEUTRAL} mine\n`);
  const p = wt.pin(a, "写 mine");
  const h1 = advance(repo, "other.md", `${NEUTRAL} other\n`);
  const r = await wt.integrate(p);
  assert.equal(r.ok ? "" : r.reason, "verify-failed");
  assert.equal(r.ws.state, "W5_Conflict");
  assert.equal(r.ws.conflict?.kind, "verify");
  assert.match(r.ws.conflict?.detail ?? "", /NEUTRAL_VERIFY_FAIL/);
  assert.equal(v.calls().length, 1);
  assert.equal(head(repo), h1);
});

test("主线推进但没配重验命令:拒绝合入,不拿旧基线上的验证结果直发", async () => {
  const repo = makeRepo();
  const wt = new Worktrees({ repo, targetBranch: "main" }, root());
  const a = wt.provision("t-nv");
  writeFileSync(path.join(a.dir, "mine.md"), `${NEUTRAL} mine\n`);
  const p = wt.pin(a, "写 mine");
  const h1 = advance(repo, "other.md", `${NEUTRAL} other\n`);
  const r = await wt.integrate(p);
  assert.equal(r.ok ? "" : r.reason, "verify-failed");
  assert.match(r.ok ? "" : r.detail, /没有配置重验命令/);
  assert.equal(head(repo), h1);
});

test("重验期间目标分支又被推进:CAS 失败后基于最新 head 重来,最终合并基于最新 head 重验并包含三方提交", async () => {
  const repo = makeRepo();
  const v = verifier({ repo, advanceOnce: true });
  const wt = new Worktrees({ repo, targetBranch: "main", verify: v.spec }, root());
  const a = wt.provision("t-cas");
  writeFileSync(path.join(a.dir, "mine.md"), `${NEUTRAL} mine\n`);
  const p = wt.pin(a, "写 mine");
  const h1 = advance(repo, "other.md", `${NEUTRAL} other\n`);
  const r = await wt.integrate(p);
  assert.ok(r.ok, r.ok ? "" : r.detail);
  assert.equal(r.attempts, 2);
  const calls = v.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.p1, h1);
  const h2 = G(repo, "rev-parse", `${r.ws.mergedSha}^1`);
  assert.notEqual(h2, h1, "第一次重验期间 main 被推进到 H2");
  assert.equal(calls[1]!.p1, h2, "第二次重验基于最新 head");
  assert.equal(r.ws.verifiedOn, h2);
  assert.equal(head(repo), r.ws.mergedSha);
  assert.deepEqual(calls[1]!.files, ["README.md", "late.md", "mine.md", "other.md"]);
});

test("目标分支检出在非裸工作区:配置时拒绝(update-ref 会让那个工作区与分支不一致)", () => {
  const repo = makeRepo();
  const src = path.join(tmp, `src${n}`);
  assert.equal(G(src, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.throws(() => new Worktrees({ repo: src, targetBranch: "main" }, root()), /检出在工作区/);
  assert.throws(() => new Worktrees({ repo, targetBranch: "nope" }, root()), /目标分支 nope 不存在/);
  assert.ok(new Worktrees({ repo, targetBranch: "main" }, root()).targetHead() === head(repo));
});

// ---------------- 宿主接入 ----------------

/** 按工作目录写文件的 Compute 替身:spawn 和 resume 各跑一轮 step,然后报 completed */
function fileCompute(step: (cwd: string, round: number, task: string) => void) {
  const queue: ComputeEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let k = 0;
  let busy = 0;
  const st = new Map<string, { cwd: string; round: number; task: string }>();
  const spawned: { computeId: string; cwd: string | undefined }[] = [];
  const push = (e: ComputeEvent) => {
    queue.push(e);
    wake?.();
  };
  const go = (id: string) => {
    busy++;
    setTimeout(() => {
      const s = st.get(id)!;
      try {
        // 没给工作目录就当失败:绝不写到测试进程的当前目录里
        if (!s.cwd || !path.isAbsolute(s.cwd)) throw new Error("没有独立工作目录");
        step(s.cwd, s.round, s.task);
        push({ computeId: id, kind: "completed", result: `第 ${s.round + 1} 轮写好了` });
      } catch (e) {
        push({ computeId: id, kind: "failed", reason: String(e), code: 1, signal: null, violations: [] });
      }
      busy--;
    }, 2);
  };
  const adapter: ComputeAdapter = {
    async spawn(brief, o): Promise<SpawnResult> {
      const computeId = `cp-${++k}`;
      spawned.push({ computeId, cwd: o?.cwd });
      st.set(computeId, { cwd: o?.cwd ?? "", round: 0, task: (brief as { task: string }).task });
      push({ computeId, kind: "started", sessionId: `s${k}`, resumed: false });
      go(computeId);
      return { ok: true, computeId, manifest: { computeId, sections: [], allowedTools: [], credentialRefs: [], placement: "local" } };
    },
    async resume(computeId) {
      const s = st.get(computeId)!;
      s.round++;
      push({ computeId, kind: "started", sessionId: "s", resumed: true });
      go(computeId);
      return { ok: true };
    },
    async stop(computeId) {
      push({ computeId, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [] });
      return { ok: true };
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<ComputeEvent>> {
              while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
              wake = null;
              if (closed && !queue.length) return { done: true, value: undefined };
              return { done: false, value: queue.shift()! };
            },
          };
        },
      };
    },
    async settled() {
      return [];
    },
    snapshot: () => ({ ok: false, reason: "not-quiescent" }),
    rejectedReports: () => [],
  };
  return {
    adapter,
    spawned,
    idle: () => busy === 0 && queue.length === 0,
    close() {
      closed = true;
      wake?.();
    },
  };
}
async function settle(host: Host, c: { idle(): boolean }, until: () => boolean) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 10));
    if (c.idle() && !host.loop.busy() && until()) {
      await new Promise((r) => setTimeout(r, 20));
      if (c.idle() && !host.loop.busy() && until()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const word = (task: string) => task.split(/\s+/).at(-1)!;

test("配了代码仓:两个任务的 Compute 各在自己的 worktree 里改、互不可见;交付钉住候选提交,验收后合入目标分支,合入成功才记验收", async () => {
  const repo = makeRepo();
  const data = path.join(tmp, `host${++n}`);
  mkdirSync(data);
  const v = verifier();
  const compute = fileCompute((cwd, _r, task) => writeFileSync(path.join(cwd, `${word(task)}.md`), `${NEUTRAL} ${word(task)}\n`));
  const host = new Host({ file: path.join(data, "gg.db"), dataDir: data, mind: () => scriptedMind(), compute: () => compute.adapter, codeRepo: { repo, targetBranch: "main", verify: v.spec }, maxDeferMs: 5 });
  const svc = createService(host);
  try {
    const c = host.createContact({ name: "小后" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写 alpha" });
    host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我写 beta" });
    await settle(host, compute, () => host.listTasks({ roomId: dm.id }).filter((t) => t.state === "T5_InReview").length === 2);
    const tasks = host.listTasks({ roomId: dm.id });
    const alpha = tasks.find((t) => t.title.endsWith("alpha"))!;
    const beta = tasks.find((t) => t.title.endsWith("beta"))!;
    const wa = alpha.workspace!;
    const wb = beta.workspace!;
    assert.deepEqual(compute.spawned.map((s) => s.cwd).sort(), [wa.dir, wb.dir].sort(), "Compute 的工作目录就是各自的 worktree");
    assert.notEqual(wa.dir, wb.dir);
    assert.ok(wa.dir.startsWith(path.join(data, "worktrees")));
    assert.equal(existsSync(path.join(wb.dir, "alpha.md")), false, "beta 看不见 alpha 的改动");
    assert.equal(wa.state, "W3_Pinned");
    assert.equal(wa.baseSha, wb.baseSha);
    assert.equal(wa.candidateSha, G(repo, "rev-parse", `refs/heads/${wa.branch}`));
    assert.equal(host.taskDoc(alpha.id).value.task.reviewedCommit, `git:${wa.candidateSha}`, "审查钉在候选提交上");

    const acc = await svc.handle("tasks.accept", { taskId: alpha.id, clientActionId: "acc-a" });
    assert.ok(acc.ok, acc.ok ? "" : acc.error.message);
    await settle(host, compute, () => host.workspace(alpha.id)?.value.state === "W6_Merged" && host.taskView(host.taskDoc(alpha.id).value).state === "T8_Accepted");
    const a2 = (await svc.handle("tasks.get", { taskId: alpha.id })) as { ok: true; value: { state: string; reviewGate: string; workspace: { state: string; mergedSha: string; verifiedOn: string | null } } };
    assert.equal(a2.value.state, "T8_Accepted");
    assert.equal(a2.value.reviewGate, "waived-by-user");
    assert.equal(a2.value.workspace.mergedSha, wa.candidateSha, "主线未变,快进到候选");
    assert.equal(a2.value.workspace.verifiedOn, null);
    assert.equal(G(repo, "show", "main:alpha.md"), `${NEUTRAL} alpha`);
    assert.deepEqual(host.listCommitments({ contactId: c.id }).filter((x) => x.taskId === alpha.id).map((x) => x.status), ["done"]);

    // beta 的基线已经落后:合入时基于新 main 合并并重验
    const accB = await svc.handle("tasks.accept", { taskId: beta.id, clientActionId: "acc-b" });
    assert.ok(accB.ok);
    await settle(host, compute, () => host.workspace(beta.id)?.value.state === "W6_Merged");
    const b2 = host.taskView(host.taskDoc(beta.id).value);
    assert.equal(b2.state, "T8_Accepted");
    assert.equal(b2.workspace?.verifiedOn, wa.candidateSha, "基于 alpha 合入后的 main 重验");
    assert.equal(v.calls().length, 1);
    assert.equal(head(repo), b2.workspace?.mergedSha);
    assert.equal(G(repo, "show", "main:beta.md"), `${NEUTRAL} beta`);
    assert.equal(G(repo, "show", "main:alpha.md"), `${NEUTRAL} alpha`);
    const said = host.listMessages(dm.id, {}).messages.filter((m) => m.sender.kind === "contact").map((m) => m.text);
    assert.equal(said.filter((t) => t.includes("已合入 main@")).length, 2, "合入结果回到聊天");
  } finally {
    compute.close();
    await host.close();
  }
});

test("合入冲突:任务停在 T8a 不算验收,冲突没修之前再说通过也被拒;退回后 Compute 在同一 worktree 基于新主线修复,再交付验收后合入", async () => {
  const repo = makeRepo();
  const data = path.join(tmp, `host${++n}`);
  mkdirSync(data);
  const compute = fileCompute((cwd, round, task) => {
    if (round === 0) writeFileSync(path.join(cwd, "README.md"), `${NEUTRAL} ${word(task)}\n`);
    else G(cwd, "merge", "-q", "-X", "ours", "--no-edit", "main");
  });
  const host = new Host({ file: path.join(data, "gg.db"), dataDir: data, mind: () => scriptedMind(), compute: () => compute.adapter, codeRepo: { repo, targetBranch: "main", verify: verifier().spec }, maxDeferMs: 5 });
  const svc = createService(host);
  try {
    const c = host.createContact({ name: "小前" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我改 alpha" });
    host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我改 beta" });
    await settle(host, compute, () => host.listTasks({ roomId: dm.id }).filter((t) => t.state === "T5_InReview").length === 2);
    const tasks = host.listTasks({ roomId: dm.id });
    const alpha = tasks.find((t) => t.title.endsWith("alpha"))!;
    const beta = tasks.find((t) => t.title.endsWith("beta"))!;
    const betaDir = beta.workspace!.dir;
    await svc.handle("tasks.accept", { taskId: alpha.id, clientActionId: "acc-a" });
    await settle(host, compute, () => host.workspace(alpha.id)?.value.state === "W6_Merged");
    const afterAlpha = head(repo);

    const accB = await svc.handle("tasks.accept", { taskId: beta.id, clientActionId: "acc-b" });
    assert.ok(accB.ok);
    await settle(host, compute, () => host.workspace(beta.id)?.value.state === "W5_Conflict");
    const b1 = host.taskView(host.taskDoc(beta.id).value);
    assert.equal(b1.state, "T8a_Delivered", "合入没成功,不记验收");
    assert.equal(b1.workspace?.conflict?.kind, "merge");
    assert.equal(head(repo), afterAlpha, "目标分支未动");
    const said = host.listMessages(dm.id, {}).messages.filter((m) => m.sender.kind === "contact").map((m) => m.text);
    assert.ok(said.some((t) => t.includes("合入失败") && t.includes("README.md")), "冲突如实回到聊天");
    const retry = await svc.handle("tasks.integrate", { taskId: beta.id, clientActionId: "int-b" });
    assert.equal(retry.ok ? "" : retry.error.code, "conflict", "未修复前拒绝再合");
    const acc2 = await svc.handle("tasks.accept", { taskId: beta.id, clientActionId: "acc-b2" });
    assert.equal(acc2.ok ? "" : acc2.error.code, "conflict", "冲突没修之前说通过也不记验收");
    assert.equal(host.taskView(host.taskDoc(beta.id).value).state, "T8a_Delivered");

    const rej = await svc.handle("tasks.reject", { taskId: beta.id, clientActionId: "rej-b", feedback: "基于最新主线修复冲突" });
    assert.ok(rej.ok, rej.ok ? "" : rej.error.message);
    await settle(host, compute, () => host.taskView(host.taskDoc(beta.id).value).state === "T5_InReview");
    const b2 = host.taskView(host.taskDoc(beta.id).value);
    assert.equal(compute.spawned.length, 2, "退回是续改,不新开 Compute");
    assert.equal(b2.workspace?.dir, betaDir, "还在同一个 worktree");
    assert.equal(b2.workspace?.state, "W3_Pinned");
    const acc3 = await svc.handle("tasks.accept", { taskId: beta.id, clientActionId: "acc-b3" });
    assert.ok(acc3.ok, acc3.ok ? "" : acc3.error.message);
    await settle(host, compute, () => host.workspace(beta.id)?.value.state === "W6_Merged");
    const b3 = host.taskView(host.taskDoc(beta.id).value);
    assert.equal(b3.state, "T8_Accepted");
    assert.equal(head(repo), b3.workspace?.mergedSha);
    assert.equal(G(repo, "merge-base", "--is-ancestor", afterAlpha, "main"), "", "alpha 的合入保留在主线里");
    assert.equal(G(repo, "show", "main:README.md"), `${NEUTRAL} beta`);
  } finally {
    compute.close();
    await host.close();
  }
});
