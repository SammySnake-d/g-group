// AC-04 工件回传(U45):交付时可读工件按内容 sha256 快照进宿主数据目录,卡片引用 hash;卡片点开(artifacts.get)读出的内容 hash 与卡片相同;
// 工作区文件之后再改,卡片仍指向交付时的快照(不指向新版本);同一工件重发不生成第二个文件。临时目录 + 中性内容。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter, ComputeEvent, SpawnResult } from "@g-group/adapter-cc-compute";
import type { MessageView } from "@g-group/api-contract";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "gg-art-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const NEUTRAL = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const env = (() => {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) e[k] = v;
  return e;
})();
const G = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let n = 0;
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

/** 按工作目录写文件的 Compute 替身:spawn 与 resume 各跑一轮 step,然后报 completed;没给绝对工作目录就报失败,绝不写进测试进程的当前目录 */
function fileCompute(step: (cwd: string, round: number) => void) {
  const queue: ComputeEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let k = 0;
  let busy = 0;
  const st = new Map<string, { cwd: string; round: number }>();
  const push = (e: ComputeEvent) => {
    queue.push(e);
    wake?.();
  };
  const go = (id: string) => {
    busy++;
    setTimeout(() => {
      const s = st.get(id)!;
      try {
        if (!s.cwd || !path.isAbsolute(s.cwd)) throw new Error("没有独立工作目录");
        step(s.cwd, s.round);
        push({ computeId: id, kind: "completed", result: `第 ${s.round + 1} 轮写好了` });
      } catch (e) {
        push({ computeId: id, kind: "failed", reason: String(e), code: 1, signal: null, violations: [] });
      }
      busy--;
    }, 5);
  };
  const adapter: ComputeAdapter = {
    async spawn(_brief, o): Promise<SpawnResult> {
      const computeId = `cp-${++k}`;
      st.set(computeId, { cwd: o?.cwd ?? "", round: 0 });
      push({ computeId, kind: "started", sessionId: `s${k}`, resumed: false });
      go(computeId);
      return { ok: true, computeId, manifest: { computeId, sections: [], allowedTools: [], credentialRefs: [], placement: "local" } };
    },
    async resume(computeId) {
      st.get(computeId)!.round++;
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
/** 交付消息(AC-56 交付是普通消息):带工件的联系人消息,按时间顺序 */
const deliveries = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.filter((m): m is MessageView & { artifacts: NonNullable<MessageView["artifacts"]> } => m.sender.kind === "contact" && !!m.artifacts);
const storeFiles = (data: string) => readdirSync(path.join(data, "artifacts")).sort();
/** 测试环境:数据目录、Compute 替身与宿主选项;宿主在各条测试里用这份选项现建 */
function env0(opts: { repo?: string; step: (cwd: string, round: number) => void; prepare?: (cwd: string) => void }) {
  const data = path.join(tmp, `host${++n}`);
  mkdirSync(data);
  const work = path.join(data, "work");
  const compute = fileCompute(opts.step);
  const hostOpts: ConstructorParameters<typeof Host>[0] = {
    file: path.join(data, "gg.db"),
    dataDir: data,
    mind: () => scriptedMind(),
    compute: () => compute.adapter,
    ...(opts.repo
      ? { codeRepo: { repo: opts.repo, targetBranch: "main" } }
      : {
          computeCwd: (t: string) => {
            mkdirSync(path.join(work, t), { recursive: true });
            opts.prepare?.(path.join(work, t));
            return path.join(work, t);
          },
        }),
    maxDeferMs: 5,
  };
  return { data, work, compute, hostOpts };
}

test("代码任务交付:候选提交里改过的 .md 快照进内容寻址库,卡片引用的 sha256 与快照文件、提交里的文件一致,artifacts.get 读出同一份;代码文件不进卡片", async () => {
  const repo = makeRepo();
  const e = env0({
    repo,
    step: (cwd) => {
      mkdirSync(path.join(cwd, "notes"), { recursive: true });
      writeFileSync(path.join(cwd, "notes", "report.md"), `# ${NEUTRAL} report\n`);
      mkdirSync(path.join(cwd, "src"), { recursive: true });
      writeFileSync(path.join(cwd, "src", "main.ts"), "export const x = 1;\n");
    },
  });
  const host = new Host(e.hostOpts);
  const svc = createService(host);
  const dm = host.openDm(host.createContact({ name: "小文" }).id);
  try {
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写报告" });
    await settle(host, e.compute, () => host.listTasks({}).some((t) => t.state === "T5_InReview"));
    const [task] = host.listTasks({});
    const card = deliveries(host, dm.id).at(-1)!;
    assert.equal(card.seq, host.taskDoc(task!.id).value.deliveredSeq, "工件挂在这次交付的那条消息上");
    assert.equal(card.artifacts.length, 1, "只带可读工件,src/main.ts 不进卡片");
    const art = card.artifacts[0]!;
    assert.equal(art.name, "notes/report.md");
    const inCommit = execFileSync("git", ["cat-file", "blob", `${task!.workspace!.candidateSha}:notes/report.md`], { cwd: repo, env });
    assert.equal(art.sha256, sha(inCommit), "卡片钉住的是候选提交里的内容");
    assert.equal(art.bytes, inCommit.length);
    assert.equal(art.mime, "text/markdown");
    const got = await svc.handle("artifacts.get", { ref: art.ref });
    assert.ok(got.ok, got.ok ? "" : got.error.message);
    const v = got.value as unknown as { sha256: string; path: string; text: string | null; name: string };
    assert.equal(v.sha256, art.sha256);
    assert.equal(sha(readFileSync(v.path)), art.sha256, "点开的文件与卡片 hash 相同");
    assert.equal(v.text, `# ${NEUTRAL} report\n`);
    assert.ok(v.path.startsWith(path.join(e.data, "artifacts")));
    assert.deepEqual(storeFiles(e.data), [`${art.sha256}.md`]);
    const tv = await svc.handle("tasks.get", { taskId: task!.id });
    assert.ok(tv.ok);
    const files = (tv.value as { artifacts: { ref: string; kind: string; sha256?: string }[] }).artifacts.filter((a) => a.kind === "file");
    assert.deepEqual(files.map((a) => [a.ref, a.sha256]), [[art.ref, art.sha256]]);
  } finally {
    e.compute.close();
    await host.close();
  }
});

test("交付后工作区文件再改:旧卡片仍指向交付时的快照;退回重做后新卡片指向新内容,两张卡各自的 hash 与各自内容一致", async () => {
  const repo = makeRepo();
  const e = env0({ repo, step: (cwd, round) => writeFileSync(path.join(cwd, "plan.md"), `${NEUTRAL} v${round + 1}\n`) });
  const host = new Host(e.hostOpts);
  const svc = createService(host);
  const dm = host.openDm(host.createContact({ name: "小文" }).id);
  try {
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写计划" });
    await settle(host, e.compute, () => host.listTasks({}).some((t) => t.state === "T5_InReview"));
    const [task] = host.listTasks({});
    const first = deliveries(host, dm.id).at(-1)!.artifacts[0]!;
    assert.equal(first.sha256, sha(`${NEUTRAL} v1\n`));
    writeFileSync(path.join(task!.workspace!.dir, "plan.md"), `${NEUTRAL} edited after delivery\n`);
    const stillOld = await svc.handle("artifacts.get", { ref: first.ref });
    assert.equal((stillOld as { ok: true; value: { text: string } }).value.text, `${NEUTRAL} v1\n`, "卡片不跟着工作区变");
    assert.equal(deliveries(host, dm.id).at(-1)!.artifacts[0]!.sha256, first.sha256);

    const rej = await svc.handle("tasks.reject", { taskId: task!.id, clientActionId: "r1", feedback: "再改一版" });
    assert.ok(rej.ok, rej.ok ? "" : rej.error.message);
    await settle(host, e.compute, () => deliveries(host, dm.id).length === 2 && host.listTasks({})[0]!.state === "T5_InReview");
    const cards = deliveries(host, dm.id);
    const second = cards[1]!.artifacts[0]!;
    assert.equal(second.sha256, sha(`${NEUTRAL} v2\n`));
    assert.notEqual(second.ref, first.ref);
    assert.equal(cards[0]!.artifacts[0]!.sha256, first.sha256, "旧卡片仍是旧快照");
    const a1 = (await svc.handle("artifacts.get", { ref: first.ref })) as unknown as { ok: true; value: { path: string; text: string } };
    const a2 = (await svc.handle("artifacts.get", { ref: second.ref })) as unknown as { ok: true; value: { path: string; text: string } };
    assert.equal(sha(readFileSync(a1.value.path)), first.sha256);
    assert.equal(sha(readFileSync(a2.value.path)), second.sha256);
    assert.equal(a2.value.text, `${NEUTRAL} v2\n`);
    assert.deepEqual(storeFiles(e.data), [`${first.sha256}.md`, `${second.sha256}.md`].sort());
  } finally {
    e.compute.close();
    await host.close();
  }
});

test("同一工件重发不生成第二个文件:退回后 Compute 写出相同内容,再交付的卡片引用同一 ref,库里只有一个文件、一条登记", async () => {
  const e = env0({ step: (cwd) => writeFileSync(path.join(cwd, "summary.md"), `${NEUTRAL} same\n`) });
  const host = new Host(e.hostOpts);
  const svc = createService(host);
  const dm = host.openDm(host.createContact({ name: "小文" }).id);
  try {
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写总结" });
    await settle(host, e.compute, () => host.listTasks({}).some((t) => t.state === "T5_InReview"));
    const [task] = host.listTasks({});
    const first = deliveries(host, dm.id).at(-1)!.artifacts[0]!;
    const row = () => host.db.store.db.prepare("SELECT ref, name, added_at, path FROM gg_artifacts").all();
    const before = row();
    await new Promise((r) => setTimeout(r, 5));
    const rej = await svc.handle("tasks.reject", { taskId: task!.id, clientActionId: "r1", feedback: "重发一次" });
    assert.ok(rej.ok);
    await settle(host, e.compute, () => deliveries(host, dm.id).length === 2 && host.listTasks({})[0]!.state === "T5_InReview");
    const second = deliveries(host, dm.id)[1]!.artifacts[0]!;
    assert.deepEqual(second, first);
    assert.deepEqual(storeFiles(e.data), [`${first.sha256}.md`]);
    assert.deepEqual(row(), before, "重发不改已登记的那条记录(登记时间、名字、路径都不变)");
  } finally {
    e.compute.close();
    await host.close();
  }
});

test("没有代码仓时按 Compute 启动后改过的可读文件收集:启动前就有的旧文件、隐藏目录、代码文件都不收", async () => {
  const e = env0({
    // Compute 启动前工作目录里就有一个旧文件:修改时间在一小时前
    prepare: (cwd) => {
      const old = path.join(cwd, "old.md");
      writeFileSync(old, `${NEUTRAL} old\n`);
      const hourAgo = new Date(Date.now() - 3600_000);
      utimesSync(old, hourAgo, hourAgo);
    },
    step: (cwd) => {
      writeFileSync(path.join(cwd, "new.md"), `${NEUTRAL} new\n`);
      mkdirSync(path.join(cwd, ".hidden"), { recursive: true });
      writeFileSync(path.join(cwd, ".hidden", "x.md"), `${NEUTRAL} hidden\n`);
      writeFileSync(path.join(cwd, "main.ts"), "export {};\n");
      mkdirSync(path.join(cwd, "sub"), { recursive: true });
      writeFileSync(path.join(cwd, "sub", "deep.txt"), `${NEUTRAL} deep\n`);
    },
  });
  const host = new Host(e.hostOpts);
  const dm = host.openDm(host.createContact({ name: "小文" }).id);
  try {
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理笔记" });
    await settle(host, e.compute, () => host.listTasks({}).some((t) => t.state === "T5_InReview"));
    const tid = host.listTasks({})[0]!.id;
    assert.equal(readFileSync(path.join(e.work, tid, "old.md"), "utf8"), `${NEUTRAL} old\n`, "旧文件在交付时就在工作目录里");
    const card = deliveries(host, dm.id).at(-1)!;
    assert.deepEqual(card.artifacts.map((a) => a.name).sort(), ["new.md", "sub/deep.txt"]);
    assert.equal(card.artifacts.find((a) => a.name === "sub/deep.txt")!.mime, "text/plain");
    for (const a of card.artifacts) assert.equal(a.sha256, sha(readFileSync(path.join(e.work, tid, a.name))));
  } finally {
    e.compute.close();
    await host.close();
  }
});

test("快照被改过就拒绝读出:不把别的版本当成这张卡片的内容", async () => {
  const e = env0({ step: (cwd) => writeFileSync(path.join(cwd, "r.md"), `${NEUTRAL} r\n`) });
  const host = new Host(e.hostOpts);
  const svc = createService(host);
  const dm = host.openDm(host.createContact({ name: "小文" }).id);
  try {
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写 r" });
    await settle(host, e.compute, () => host.listTasks({}).some((t) => t.state === "T5_InReview"));
    const art = deliveries(host, dm.id).at(-1)!.artifacts[0]!;
    writeFileSync(path.join(e.data, "artifacts", `${art.sha256}.md`), `${NEUTRAL} tampered\n`);
    const r = await svc.handle("artifacts.get", { ref: art.ref });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error.message, /sha256 不一致/);
    const missing = await svc.handle("artifacts.get", { ref: "art-none.md" });
    assert.equal(missing.ok ? "" : missing.error.code, "not_found");
  } finally {
    e.compute.close();
    await host.close();
  }
});
