import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeAdapter, ComputeEvent, SpawnResult } from "@g-group/adapter-cc-compute";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { CONTACT_SYSTEM, CONTACT_TOOLS } from "./assemble.ts";
import { all, putDoc, run } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { contactProfile } from "./views.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-direct-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
let seqNo = 0;
const dbFile = () => path.join(dir, `d${++seqNo}.db`);
const CLAUDE = "claude-sonnet-4-6";
const GPT = "gpt-5";
const NEUTRAL = "NEUTRAL_FIXTURE_NO_CREDENTIALS";

async function settle(host: Host, ...adapters: { drained?: () => boolean; idle?: () => boolean }[]) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    const ready = adapters.every((a) => (a.drained ? a.drained() : true) && (a.idle ? a.idle() : true));
    if (ready && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      const stillReady = adapters.every((a) => (a.drained ? a.drained() : true) && (a.idle ? a.idle() : true));
      if (stillReady && !host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}

function makeBareRepo(): string {
  const src = path.join(dir, `src${++seqNo}`);
  mkdirSync(src);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.local", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  g(src, "init", "-q", "-b", "main");
  writeFileSync(path.join(src, "README.md"), `${NEUTRAL}\n`);
  g(src, "add", "-A");
  g(src, "commit", "-q", "-m", "init");
  const bare = path.join(dir, `repo${seqNo}.git`);
  g(dir, "clone", "-q", "--bare", src, bare);
  return bare;
}

function fileCompute(edit: (cwd: string, task: string) => void) {
  const q: ComputeEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let n = 0;
  let inflight = 0;
  const push = (e: ComputeEvent) => {
    q.push(e);
    wake?.();
  };
  const adapter: ComputeAdapter = {
    async spawn(brief, o): Promise<SpawnResult> {
      const computeId = `fc-${++n}`;
      inflight++;
      setTimeout(() => {
        try {
          if (o?.cwd) edit(o.cwd, (brief as { task: string }).task);
          push({ computeId, kind: "started", sessionId: computeId, resumed: false });
          push({ computeId, kind: "completed", result: `完成:${(brief as { task: string }).task}` });
        } finally {
          inflight--;
        }
      }, 5);
      return { ok: true, computeId, manifest: { computeId, sections: [], allowedTools: [], credentialRefs: [], placement: "local" } };
    },
    async resume(computeId, text) {
      inflight++;
      setTimeout(() => {
        try {
          push({ computeId, kind: "completed", result: `续改:${text}` });
        } finally {
          inflight--;
        }
      }, 5);
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
              while (!q.length && !closed) await new Promise<void>((r) => (wake = r));
              wake = null;
              if (closed && !q.length) return { done: true, value: undefined };
              return { done: false, value: q.shift()! };
            },
          };
        },
      };
    },
    async settled() {
      return Object.freeze([]);
    },
    async quiesce() {
      return { ok: true as const, killed: 0 };
    },
    snapshot() {
      return { ok: false as const, reason: "n/a" };
    },
    rejectedReports() {
      return [];
    },
    async *activity() {},
  };
  return {
    adapter,
    idle: () => inflight === 0,
    close() {
      closed = true;
      wake?.();
    },
  };
}

test("非代码仓交付即自完成: 立即了结承诺、关闭 task-status 卡片、pendingForUser 归零、进入 doneTasks 并使用非催促交付文案", async () => {
  const plainCompute = scriptedCompute();
  const plainHost = new Host({ file: dbFile(), mind: () => scriptedMind(), compute: () => plainCompute.adapter, maxDeferMs: 5 });
  const cPlain = plainHost.createContact({ name: "小克" });
  const dmPlain = plainHost.openDm(cPlain.id);
  plainHost.send({ roomId: dmPlain.id, clientActionId: "p1", text: "帮我整理周报" });
  await settle(plainHost, plainCompute);

  const [tPlain] = plainHost.listTasks({ roomId: dmPlain.id });
  assert.ok(tPlain);
  assert.equal(tPlain.state, "T8a_Delivered");
  assert.equal(plainHost.roomView(dmPlain.id).pendingForUser, 0);
  assert.deepEqual(plainHost.listCommitments({ contactId: cPlain.id }).map((k) => [k.text, k.status]), [["整理周报", "done"]]);
  assert.equal(plainHost.listMessages(dmPlain.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "done");
  const pPlain = contactProfile(plainHost, cPlain.id);
  assert.deepEqual(pPlain.duties.tasks, []);
  assert.deepEqual(pPlain.duties.commitments, []);
  assert.deepEqual(pPlain.duties.doneTasks?.map((t) => t.id), [tPlain.id]);
  plainCompute.close();
  await plainHost.close();

  const execOk = scriptedCompute({ modelAware: false });
  const revOk = scriptedCompute({ modelAware: false, idPrefix: "rvok", script: () => [{ kind: "started", sessionId: "rv", resumed: false }, { kind: "completed", result: "APPROVE\n产物核对通过" }] });
  const okHost = new Host({ file: dbFile(), mind: () => scriptedMind(), compute: (m) => (m === CLAUDE ? execOk.adapter : revOk.adapter), maxDeferMs: 5 });
  okHost.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const okOwner = okHost.createContact({ name: "小克" });
  okHost.createContact({ name: "小审", computeModel: { mode: "explicit", model: GPT } });
  const dmOk = okHost.openDm(okOwner.id);
  okHost.send({ roomId: dmOk.id, clientActionId: "ok1", text: "帮我写交付说明" });
  await settle(okHost, execOk, revOk);

  const [tOk] = okHost.listTasks({ roomId: dmOk.id });
  assert.equal(tOk?.state, "T8a_Delivered");
  assert.equal(tOk?.reviewGate, "compliant");
  assert.equal(okHost.roomView(dmOk.id).pendingForUser, 0);
  assert.deepEqual(okHost.listCommitments({ contactId: okOwner.id }).map((k) => k.status), ["done"]);
  assert.equal(okHost.listMessages(dmOk.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "done");
  const okProfile = contactProfile(okHost, okOwner.id);
  assert.deepEqual(okProfile.duties.tasks, []);
  assert.deepEqual(okProfile.duties.doneTasks?.map((t) => t.id), [tOk!.id]);
  const okLast = okHost.listMessages(dmOk.id, {}).messages.at(-1)!.text;
  assert.match(okLast, /如需调整直接说。/);
  assert.doesNotMatch(okLast, /确认没问题就回复通过/);
  execOk.close();
  revOk.close();
  await okHost.close();

  const execFb = scriptedCompute({ modelAware: false });
  const revFb = scriptedCompute({ modelAware: false, idPrefix: "rvfb", script: () => [{ kind: "started", sessionId: "rv", resumed: false }, { kind: "failed", reason: "上游 502" }] });
  const fbHost = new Host({ file: dbFile(), mind: () => scriptedMind(), compute: (m) => (m === CLAUDE ? execFb.adapter : revFb.adapter), maxDeferMs: 5 });
  fbHost.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const fbOwner = fbHost.createContact({ name: "小克" });
  fbHost.createContact({ name: "小审", computeModel: { mode: "explicit", model: GPT } });
  const dmFb = fbHost.openDm(fbOwner.id);
  fbHost.send({ roomId: dmFb.id, clientActionId: "fb1", text: "帮我检查接口" });
  await settle(fbHost, execFb, revFb);

  const [tFb] = fbHost.listTasks({ roomId: dmFb.id });
  assert.equal(tFb?.state, "T8a_Delivered");
  assert.equal(tFb?.reviewGate, "none");
  assert.equal(fbHost.roomView(dmFb.id).pendingForUser, 0);
  assert.deepEqual(fbHost.listCommitments({ contactId: fbOwner.id }).map((k) => k.status), ["done"]);
  assert.equal(fbHost.listMessages(dmFb.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "done");
  const fbLast = fbHost.listMessages(dmFb.id, {}).messages.at(-1)!.text;
  assert.match(fbLast, /已按当前结果交付;如需修改直接说。/);
  assert.doesNotMatch(fbLast, /交付在等你确认/);
  execFb.close();
  revFb.close();
  await fbHost.close();
});

test("交付后与验收后对话追问都可重开修订: verdict(revise) 与 tasks.reject 将 T8a_Delivered 和 T8_Accepted 退回 T3_Running 并干净再交付,轮次装配最多带最近 10 条 T8_Accepted", async () => {
  assert.match(CONTACT_SYSTEM, /deliver 即完成,无需等通过/);
  assert.match(CONTACT_TOOLS, /交付即完成/);

  const seenBlock5: string[] = [];
  const baseMind = scriptedMind();
  const chatReopenMind: ContactMind = {
    async round(input: RoundInput, signal) {
      const b5 = input.request.blocks.find((b) => b.block === 5)?.text ?? "";
      seenBlock5.push(b5);
      const out = await baseMind.round(input, signal);
      const actions: MindAction[] = [...out.actions];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("修改:")) {
          const match = /(t-[\w-]+)\s+\[(?:T8a_Delivered|T8_Accepted)\]/.exec(b5);
          if (match) return { actions: [{ kind: "verdict", taskId: match[1]!, sourceSeq: f.seq, verdict: "revise", feedback: f.text }], stateNote: null };
        }
      }
      return { actions, stateNote: out.stateNote };
    },
  };

  const compute = scriptedCompute({
    resumeScript: (_id, _turn, text) => [{ kind: "completed", result: `修订完成:${text}` }],
  });
  const host = new Host({ file: dbFile(), mind: () => chatReopenMind, compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);

  const states: string[] = [];
  host.bus.subscribe((e) => {
    if (e.type === "task.updated") states.push(e.task.state);
  });

  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写初稿" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  assert.ok(t);
  assert.equal(t.state, "T8a_Delivered");
  assert.equal(host.roomView(dm.id).pendingForUser, 0);

  host.send({ roomId: dm.id, clientActionId: "u2", text: "修改:补充示例" });
  await settle(host, compute);
  assert.ok(states.includes("T3_Running"), "T8a_Delivered 经对话 verdict(revise) 重开进入 T3_Running");
  const afterV1 = host.taskView(host.taskDoc(t.id).value);
  assert.equal(afterV1.state, "T8a_Delivered");
  assert.equal(afterV1.constraintVersion, 1);
  assert.equal(host.roomView(dm.id).pendingForUser, 0);
  assert.equal(host.listMessages(dm.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "done");

  const accRes = await svc.handle("tasks.accept", { taskId: t.id, clientActionId: "acc1" });
  assert.ok(accRes.ok, JSON.stringify(accRes));
  assert.equal((accRes.value as { state: string }).state, "T8_Accepted");

  const olderIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const old = host.createTask({ roomId: dm.id, clientActionId: `old-${i}`, title: `old-accepted-${i}` });
    const od = host.taskDoc(old.id);
    const ts = new Date(Date.UTC(2026, 10, 20, 0, i)).toISOString();
    putDoc(host.db, `task:${old.id}`, od.ver, {
      ...od.value,
      task: { ...od.value.task, owner: c.id, state: "T8_Accepted", delivery: { round: 1, commit: "c" }, deliverySeq: 1 },
      deliveredSeq: 1,
      updatedAt: ts,
    });
    run(host.db, "UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status'", old.id);
    olderIds.push(old.id);
  }
  const latestDoc = host.taskDoc(t.id);
  putDoc(host.db, `task:${t.id}`, latestDoc.ver, { ...latestDoc.value, updatedAt: new Date(Date.UTC(2026, 10, 21, 12, 0)).toISOString() });
  await settle(host, compute);

  states.length = 0;
  seenBlock5.length = 0;
  host.send({ roomId: dm.id, clientActionId: "u3", text: "修改:改成双语版本" });
  await settle(host, compute);

  const followRoundBlock5 = seenBlock5.find((b) => b.includes(t.id)) ?? "";
  assert.ok(followRoundBlock5.includes(`${t.id} [T8_Accepted]`), "联系人轮次装配包含最近完成的 T8_Accepted 任务");
  assert.equal(followRoundBlock5.includes(olderIds[0]!), false, "轮次装配最多只包含最近 10 条 T8_Accepted 任务");
  assert.equal(followRoundBlock5.includes(olderIds[9]!), true);
  assert.ok(states.includes("T3_Running"), "T8_Accepted 经对话 verdict(revise) 重开进入 T3_Running");

  const afterV2 = host.taskView(host.taskDoc(t.id).value);
  assert.equal(afterV2.state, "T8a_Delivered");
  assert.equal(afterV2.constraintVersion, 2);
  assert.equal(host.roomView(dm.id).pendingForUser, 0);

  const acc2 = await svc.handle("tasks.accept", { taskId: t.id, clientActionId: "acc2" });
  assert.ok(acc2.ok);
  assert.equal((acc2.value as { state: string }).state, "T8_Accepted");

  states.length = 0;
  const rejRes = await svc.handle("tasks.reject", { taskId: t.id, clientActionId: "rej-t8", feedback: "再精简一段" });
  assert.ok(rejRes.ok, JSON.stringify(rejRes));
  assert.equal((rejRes.value as { state: string }).state, "T3_Running", "tasks.reject 直接将 T8_Accepted 退回 T3_Running");
  await settle(host, compute);
  const afterV3 = host.taskView(host.taskDoc(t.id).value);
  assert.equal(afterV3.state, "T8a_Delivered");
  assert.equal(afterV3.constraintVersion, 3);
  assert.equal(host.roomView(dm.id).pendingForUser, 0);
  assert.deepEqual(all<{ error: string }>(host.db, "SELECT error FROM gg_effects WHERE status = 'rejected'"), []);

  compute.close();
  await host.close();
});

test("配了 codeRepo 时工作树交付仍需人工确认与合入,未配工作树则直接自完成", async () => {
  const repo = makeBareRepo();
  const data = path.join(dir, `wt-host-${++seqNo}`);
  mkdirSync(data);
  const wtCompute = fileCompute((cwd) => writeFileSync(path.join(cwd, "alpha.md"), `${NEUTRAL} alpha\n`));
  const wtHost = new Host({
    file: path.join(data, "gg.db"),
    dataDir: data,
    mind: () => scriptedMind(),
    compute: () => wtCompute.adapter,
    codeRepo: { repo, targetBranch: "main" },
    maxDeferMs: 5,
  });
  const wtSvc = createService(wtHost);
  const wtOwner = wtHost.createContact({ name: "小前" });
  const wtDm = wtHost.openDm(wtOwner.id);
  wtHost.send({ roomId: wtDm.id, clientActionId: "w1", text: "帮我写 alpha.md" });
  await settle(wtHost, wtCompute);

  const [wtTask] = wtHost.listTasks({ roomId: wtDm.id });
  assert.ok(wtTask);
  assert.equal(wtTask.state, "T8a_Delivered");
  assert.equal(wtTask.workspace?.state, "W3_Pinned");
  assert.equal(wtHost.roomView(wtDm.id).pendingForUser, 2, "codeRepo 未合入任务仍保留待确认计数");
  assert.deepEqual(wtHost.listCommitments({ contactId: wtOwner.id }).map((k) => k.status), ["active"]);
  assert.equal(wtHost.listMessages(wtDm.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "open");
  assert.deepEqual(contactProfile(wtHost, wtOwner.id).duties.tasks.map((t) => t.id), [wtTask.id]);
  assert.deepEqual(contactProfile(wtHost, wtOwner.id).duties.doneTasks, []);

  const acc = await wtSvc.handle("tasks.accept", { taskId: wtTask.id, clientActionId: "wt-acc" });
  assert.ok(acc.ok, JSON.stringify(acc));
  await settle(wtHost, wtCompute);
  const merged = wtHost.taskView(wtHost.taskDoc(wtTask.id).value);
  assert.equal(merged.state, "T8_Accepted");
  assert.equal(merged.workspace?.state, "W6_Merged");
  assert.equal(wtHost.roomView(wtDm.id).pendingForUser, 0);
  assert.deepEqual(wtHost.listCommitments({ contactId: wtOwner.id }).map((k) => k.status), ["done"]);
  assert.deepEqual(contactProfile(wtHost, wtOwner.id).duties.doneTasks?.map((t) => t.id), [wtTask.id]);
  wtCompute.close();
  await wtHost.close();

  const plainCompute = scriptedCompute();
  const plainHost = new Host({ file: dbFile(), mind: () => scriptedMind(), compute: () => plainCompute.adapter, maxDeferMs: 5 });
  const pOwner = plainHost.createContact({ name: "小克" });
  const pDm = plainHost.openDm(pOwner.id);
  plainHost.send({ roomId: pDm.id, clientActionId: "np1", text: "帮我总结进度" });
  await settle(plainHost, plainCompute);
  const [pTask] = plainHost.listTasks({ roomId: pDm.id });
  assert.equal(pTask?.state, "T8a_Delivered");
  assert.equal(plainHost.roomView(pDm.id).pendingForUser, 0);
  assert.deepEqual(plainHost.listCommitments({ contactId: pOwner.id }).map((k) => k.status), ["done"]);
  assert.equal(plainHost.listMessages(pDm.id, {}).messages.find((m) => m.card?.kind === "task-status")?.card?.state, "done");
  assert.deepEqual(contactProfile(plainHost, pOwner.id).duties.doneTasks?.map((t) => t.id), [pTask!.id]);
  plainCompute.close();
  await plainHost.close();
});
