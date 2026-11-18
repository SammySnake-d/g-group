// Round 2: persistent stop evidence, reviewer routing and room visibility. No live model or process is required.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newTask, type Task } from "@g-group/domain";
import type { ContactMind } from "@g-group/kernel";
import { one, putDoc, run } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import type { ComputeFactories } from "./runtime-config.ts";

const root = mkdtempSync(join(tmpdir(), "gg-b1-r2-"));
after(() => rmSync(root, { recursive: true, force: true }));
let next = 0;
const file = () => join(root, `${++next}.db`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const create = (db: string, opts: Partial<HostOptions> = {}) => new Host({ file: db, mind: () => scriptedMind(), maxDeferMs: 5, personalComputeSlots: 2, ...opts });
const started = { kind: "started" as const, sessionId: "session", resumed: false };
const quietMind: ContactMind = { async round() { return { actions: [], stateNote: null }; } };
const status = (h: Host, id: string) => one<{ status: string }>(h.db, "SELECT status FROM gg_compute WHERE compute_id = ?", id)?.status;
const hasDurableLeases = (h: Host) => !!one(h.db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'gg_compute_leases'");

async function observe(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await tick();
}

async function failedCard(reason = "API Error: 502 Bad Gateway") {
  const db = file();
  const old = scriptedCompute({ script: () => [started, { kind: "failed", reason, code: 1, signal: null, violations: [] }], quiesce: async () => ({ ok: true, killed: 0 }) });
  const before = create(db, { compute: () => old.adapter, retry: { maxAutoRetries: 0 } });
  try {
    const owner = before.createContact({ name: "执行者", speakingModel: "claude-haiku-4-5" });
    const member = { kind: "contact" as const, id: owner.id };
    const room = before.createGroup("续跑", [{ kind: "user", id: before.userId }, member]).id;
    before.updateRoom(room, { tempComputeSlots: 1 });
    before.send({ roomId: room, clientActionId: "fail", text: "帮我写报告", mentions: [{ id: owner.id, source: "manual" }] });
    const failure = () => before.listMessages(room, {}).messages.find((m) => m.card?.kind === "failure");
    await observe(() => !!failure() && before.quota.view().leases.length === 0);
    const task = before.listTasks({ roomId: room })[0]!;
    const message = failure()!;
    assert.equal(task.state, "T3_Running", "已出失败卡且尚未收口");
    assert.equal(one<{ status: string }>(before.db, "SELECT status FROM gg_failures WHERE scope = 'task' AND subject = ?", task.id)?.status, reason.startsWith("403") ? "paused" : "card");
    assert.equal(status(before, task.computeRuns[0]!.computeId), "failed");
    assert.equal(before.quota.leaseOf(task.id), undefined, "退出核验已归还租约");
    const session = before.listRuns({ roomId: room }).runs.find((r) => r.layer === "compute-session" && r.taskId === task.id)!;
    return { db, member, room, task, session, card: { roomId: room, seq: message.seq, cardId: message.card!.cardId } };
  } finally {
    old.close();
    await before.close();
  }
}

test("B1 R2 AC-23: failure-card restart leaves personal and group capacity free and dispatches a new task", async () => {
  // The 403 pauses Compute on its own upstream, not the contact’s distinct speaking model.
  const f = await failedCard("403 Insufficient user quota");
  const compute = scriptedCompute({ idPrefix: "new", script: () => [started] });
  const h = create(f.db, { compute: () => compute.adapter });
  try {
    assert.equal(h.listTasks({ roomId: f.room })[0]!.waitingFor, null);
    for (const taskId of ["personal-1", "personal-2"]) {
      const got = h.quota.acquire({ taskId, contactId: f.member.id, roomId: f.room, isGroup: true });
      assert.ok("granted" in got);
      assert.equal(got.granted.scope, `personal:${f.member.id}`);
    }
    h.send({ roomId: f.room, clientActionId: "next", text: "帮我写新报告", mentions: [{ id: f.member.id, source: "manual" }] });
    await observe(() => compute.spawned.length === 1);
    assert.equal(compute.spawned.length, 1);
    const successor = h.listTasks({ roomId: f.room }).find((x) => x.id !== f.task.id)!;
    assert.equal(h.quota.leaseOf(successor.id)?.scope, `group:${f.room}`);
    assert.ok(hasDurableLeases(h), "持久槽位账本必须记录新任务借用的群槽");
    assert.equal(one<{ scope: string }>(h.db, "SELECT scope FROM gg_compute_leases WHERE task_id = ?", successor.id)?.scope, `group:${f.room}`);
  } finally { compute.close(); await h.close(); }
});

test("B1 R2 AC-36: retry on a quiesced failure card after restart reaches the original session adapter", async () => {
  const f = await failedCard();
  const compute = scriptedCompute({ resumeScript: () => [{ kind: "completed", result: "重试成功" }] });
  const h = create(f.db, { compute: () => compute.adapter });
  try {
    h.cardAct({ ...f.card, actionId: "retry", clientActionId: "retry" });
    await observe(() => h.taskDoc(f.task.id).value.task.state === "T8a_Delivered");
    assert.deepEqual(compute.resumed.map((r) => r.computeId), [f.task.computeRuns[0]!.computeId]);
    assert.equal(compute.spawned.length, 0);
    assert.equal(h.taskDoc(f.task.id).value.task.state, "T8a_Delivered");
    assert.equal(h.quota.leaseOf(f.task.id), undefined, "续接后完成也会归还重获的槽位");
    assert.ok(hasDurableLeases(h), "重获和归还都必须用 B1 持久租约账本");
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ?", f.task.id), undefined);
  } finally { compute.close(); await h.close(); }
});

test("B1 R2 AC-36: rerunRun after restart retires the quiesced failure card and starts a fresh task", async () => {
  const f = await failedCard();
  const compute = scriptedCompute({ idPrefix: "rerun", script: () => [started] });
  const h = create(f.db, { compute: () => compute.adapter });
  try {
    let rerun: ReturnType<Host["rerunRun"]> | undefined;
    assert.doesNotThrow(() => { rerun = h.rerunRun(f.session.id, "rerun"); });
    assert.ok(rerun?.taskId && rerun.taskId !== f.task.id);
    assert.equal(h.taskDoc(f.task.id).value.task.state, "T11_Failed");
    await observe(() => compute.spawned.length === 1);
    assert.equal(compute.spawned.length, 1);
    assert.equal(h.listMessages(f.room, {}).messages.find((m) => m.card?.cardId === f.card.cardId)?.card?.state, "expired");
    assert.ok(hasDurableLeases(h), "fresh execution must be recorded in the durable lease ledger");
    assert.ok(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ? AND stopping = 0", rerun.taskId));
  } finally { compute.close(); await h.close(); }
});

test("B1 R2 AC-23: give-up confirms the quiesced failed Compute after restart without an adapter", async () => {
  const f = await failedCard();
  const h = create(f.db);
  try {
    h.cardAct({ ...f.card, actionId: "give-up", clientActionId: "give-up" });
    assert.equal(h.taskDoc(f.task.id).value.task.state, "T11_Failed");
    assert.equal(h.quota.leaseOf(f.task.id), undefined);
    assert.ok(hasDurableLeases(h), "重启后确认停止依赖持久租约账本,不是内存为空");
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ?", f.task.id), undefined);
  } finally { await h.close(); }
});

test("B1 R2 AC-23: stopTask confirms an already-quiesced failure-card Compute after restart", async () => {
  const f = await failedCard();
  const h = create(f.db);
  try {
    h.stopTask(f.task.id, h.userId);
    assert.equal(h.taskDoc(f.task.id).value.task.state, "T10_Cancelled");
    assert.equal(h.quota.leaseOf(f.task.id), undefined);
    assert.ok(hasDurableLeases(h), "重启后确认停止依赖持久租约账本,不是内存为空");
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ?", f.task.id), undefined);
  } finally { await h.close(); }
});

test("B1 R2 AC-23: restart retires a queued-only T9 whose launch never held a lease", async () => {
  const f = await failedCard();
  const before = create(f.db);
  try {
    const doc = before.taskDoc(f.task.id);
    putDoc(before.db, `task:${f.task.id}`, doc.ver, { ...doc.value, task: { ...doc.value.task, state: "T9_StopRequested", stopReason: "cancel", computeId: null, launch: { requestId: "queued", constraintVer: doc.value.task.constraintVer }, orphans: [] } });
    run(before.db, "DELETE FROM gg_compute WHERE task_id = ?", f.task.id);
  } finally { await before.close(); }
  const h = create(f.db);
  try {
    assert.equal(h.taskDoc(f.task.id).value.task.state, "T10_Cancelled");
    assert.equal(h.listTasks({ roomId: f.room })[0]!.waitingFor, null);
    assert.equal(h.quota.leaseOf(f.task.id), undefined);
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ?", f.task.id), undefined);
  } finally { await h.close(); }
});

test("B1 R2 AC-36: completion released before deliver stays out of quarantine on restart", async () => {
  const db = file();
  const compute = scriptedCompute();
  const mind = scriptedMind();
  const before = create(db, { compute: () => compute.adapter, mind: () => ({ async round(input, signal) {
    const out = await mind.round(input, signal);
    return { ...out, actions: out.actions.filter((a) => a.kind !== "deliver") };
  } }) });
  let taskId: string;
  try {
    const c = before.createContact({ name: "未交付" });
    const room = before.openDm(c.id).id;
    before.send({ roomId: room, clientActionId: "done", text: "帮我写报告" });
    await observe(() => before.listTasks({ roomId: room })[0]?.recentProgress.some((p) => p.kind === "completed") === true && before.quota.view().leases.length === 0);
    const task = before.listTasks({ roomId: room })[0]!;
    taskId = task.id;
    assert.equal(task.state, "T3_Running");
    assert.equal(status(before, task.computeRuns[0]!.computeId), "completed");
    assert.equal(before.quota.leaseOf(taskId), undefined);
  } finally { compute.close(); await before.close(); }
  const h = create(db, { mind: () => quietMind });
  try {
    assert.equal(h.taskView(h.taskDoc(taskId).value).waitingFor, null);
    h.stopTask(taskId, h.userId);
    assert.equal(h.taskDoc(taskId).value.task.state, "T10_Cancelled");
    assert.ok(hasDurableLeases(h), "完成后归还应反映在 B1 持久租约账本");
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_leases WHERE task_id = ?", taskId), undefined);
  } finally { await h.close(); }
});

async function legacyDb() {
  const db = file();
  const h = create(db);
  try {
    const at = new Date().toISOString();
    const c = h.createContact({ name: "旧执行者" });
    const room = h.createGroup("旧任务", [{ kind: "user", id: h.userId }, { kind: "contact", id: c.id }]).id;
    h.updateRoom(room, { tempComputeSlots: 1 });
    for (const [id, state, computeId, s] of [
      ["running", "T3_Running", "cp-live", "running"], ["blocked", "T4b_BlockedOnHuman", "cp-held", "blocked"],
      ["stopping", "T9_StopRequested", "cp-end", "failed"], ["completed", "T3_Running", "cp-done", "completed"],
      ["queued", "T9_StopRequested", null, null],
    ] as const) {
      const task: Task = { ...newTask(id, h.userId), owner: c.id, state, computeId, stopReason: "cancel", launch: computeId ? null : { requestId: "legacy-queue", constraintVer: 0 } };
      putDoc(h.db, `task:${id}`, 0, { task, roomId: room, title: id, sourceSeq: 1, brief: id, createdAt: at, updatedAt: at, result: null });
      if (computeId) run(h.db, "INSERT INTO gg_compute (compute_id, task_id, contact_id, room_id, harness, model, status, started_at) VALUES (?,?,?,?,?,?,?,?)", computeId, id, c.id, room, "claude-code", "claude-sonnet-4-6", s, at);
    }
    h.db.store.db.exec("DROP TABLE IF EXISTS gg_compute_leases");
    return { db, room, owner: c.id };
  } finally { await h.close(); }
}

test("B1 R2 AC-23: pre-B1 migration excludes completed Compute and a launch with no process", async () => {
  const { db } = await legacyDb();
  const h = create(db, { mind: () => quietMind });
  try {
    assert.equal(h.taskView(h.taskDoc("completed").value).waitingFor, null);
    assert.equal(h.taskView(h.taskDoc("queued").value).waitingFor, null);
    for (const id of ["running", "blocked", "stopping"]) assert.match(h.quota.waitingReason(id) ?? "", /槽位未知/);
    assert.equal(one(h.db, "SELECT 1 FROM gg_compute_legacy_holds WHERE task_id IN ('completed','queued')"), undefined);
  } finally { await h.close(); }
});

test("B1 R2 AC-23: migrated T3/T4b/T9 holds survive a second boot and still protect both scopes", async () => {
  const { db, room, owner } = await legacyDb();
  const first = create(db, { mind: () => quietMind });
  await first.close();
  const h = create(db, { mind: () => quietMind });
  try {
    assert.ok(one(h.db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gg_compute_legacy_holds'"), "持久账本不依赖每次扫描 task 文档");
    assert.equal(one<{ n: number }>(h.db, "SELECT count(*) AS n FROM gg_compute_legacy_holds")?.n, 3);
    for (const id of ["running", "blocked", "stopping"]) assert.match(h.quota.waitingReason(id) ?? "", /槽位未知/);
    h.stopTask("stopping", h.userId);
    assert.equal(h.taskDoc("stopping").value.task.state, "T9_StopRequested");
    assert.ok("queued" in h.quota.acquire({ taskId: "new-personal", contactId: owner, roomId: room, isGroup: false }));
    const other = h.createContact({ name: "没有个人槽位" });
    h.updateContact(other.id, { computeSlots: 0 });
    assert.ok("queued" in h.quota.acquire({ taskId: "new-group", contactId: other.id, roomId: room, isGroup: true }));
    const separate = h.createContact({ name: "不受影响" });
    assert.ok("granted" in h.quota.acquire({ taskId: "independent", contactId: separate.id, roomId: room, isGroup: false }));
  } finally { await h.close(); }
});

const GPT = "gpt-5.4";
const CLAUDE = "claude-sonnet-4-6";
function reviewCase(mode: "unconnected" | "incompatible" | "approve" | "pending", db = file()) {
  const cc = scriptedCompute({ idPrefix: "cc" });
  const codex = scriptedCompute({ idPrefix: "cx", script: () => mode === "approve" ? [started, { kind: "completed", result: "APPROVE\n已核验" }] : [started] });
  const factories: ComputeFactories = { "claude-code": () => cc.adapter, ...(mode !== "unconnected" ? { codex: () => codex.adapter } : {}) };
  // The R1 Red stub declares only the legacy factory signature. Replay the same map, without converting it.
  const h = create(db, { compute: factories as unknown as NonNullable<HostOptions["compute"]> });
  h.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE, defaultEffort: "high" });
  const owner = h.createContact({ name: "作者" });
  const reviewer = h.createContact({ name: "独立审查", harness: "codex", computeModel: { mode: "explicit", model: GPT } });
  if (mode === "incompatible") h.updateSettings({ models: [{ id: GPT, label: GPT, vendor: "openai", harnesses: ["claude-code"] }], confirmAffected: true });
  const room = h.createGroup("交付", [{ kind: "user", id: h.userId }, { kind: "contact", id: owner.id }, { kind: "contact", id: reviewer.id }]).id;
  h.send({ roomId: room, clientActionId: "review", text: "帮我写报告", mentions: [{ id: owner.id, source: "manual" }] });
  return { h, room, cc, codex, done: async () => { cc.close(); codex.close(); await h.close(); } };
}

test("B1 R2 R-17: disconnected Codex reviewer does not spawn on Claude Code and gives an explicit reason", async () => {
  const w = reviewCase("unconnected");
  try {
    await observe(() => w.h.listTasks({ roomId: w.room })[0]?.state === "T8a_Delivered");
    assert.deepEqual(w.cc.spawned.map((x) => x.model), [CLAUDE]);
    const task = w.h.listTasks({ roomId: w.room })[0]!;
    assert.equal(task.state, "T8a_Delivered");
    assert.equal(task.reviewGate, "none");
    assert.equal(one(w.h.db, "SELECT 1 FROM gg_reviews WHERE task_id = ?", task.id), undefined);
    assert.ok(w.h.listMessages(w.room, {}).messages.some((m) => /Codex.*没有接入/.test(m.text)));
  } finally { await w.done(); }
});

test("B1 R2 R-17: connected but incompatible Codex reviewer is not spawned on any adapter", async () => {
  const w = reviewCase("incompatible");
  try {
    await observe(() => w.h.listTasks({ roomId: w.room })[0]?.state === "T8a_Delivered");
    assert.deepEqual(w.cc.spawned.map((x) => x.model), [CLAUDE]);
    assert.equal(w.codex.spawned.length, 0);
    const task = w.h.listTasks({ roomId: w.room })[0]!;
    assert.equal(task.reviewGate, "none");
    assert.equal(one(w.h.db, "SELECT 1 FROM gg_reviews WHERE task_id = ?", task.id), undefined);
    assert.ok(w.h.listMessages(w.room, {}).messages.some((m) => /codex 不支持模型 gpt-5\.4/.test(m.text)));
  } finally { await w.done(); }
});

test("B1 R2 R-17: migrated gg_reviews records Codex and consumes the connected review adapter verdict", async () => {
  const db = file();
  const old = create(db);
  try {
    if (one(old.db, "SELECT 1 FROM pragma_table_info('gg_reviews') WHERE name = 'harness'")) old.db.store.db.exec("ALTER TABLE gg_reviews DROP COLUMN harness");
    run(old.db, "INSERT INTO gg_reviews (compute_id, task_id, reviewer_id, owner_id, room_id, model, round, commit_ref, constraint_ver, status, started_at) VALUES ('old','old-task','old-reviewer','old-owner','old-room',?,1,'commit',1,'approved','2026-11-18')", GPT);
  } finally { await old.close(); }
  const w = reviewCase("approve", db);
  try {
    await observe(() => w.h.listTasks({ roomId: w.room })[0]?.state === "T8a_Delivered");
    assert.deepEqual(w.codex.spawned.map((x) => [x.model, x.effort]), [[GPT, "high"]]);
    assert.deepEqual(w.cc.spawned.map((x) => x.model), [CLAUDE]);
    const task = w.h.listTasks({ roomId: w.room })[0]!;
    assert.equal(task.reviewGate, "compliant");
    assert.equal(task.reviews?.[0]?.status, "approved");
    assert.deepEqual({ ...one<{ harness: string; model: string }>(w.h.db, "SELECT harness, model FROM gg_reviews WHERE compute_id = ?", "cx-1") }, { harness: "codex", model: GPT });
    assert.deepEqual({ ...one<{ status: string; model: string }>(w.h.db, "SELECT status, model FROM gg_reviews WHERE compute_id = 'old'") }, { status: "approved", model: GPT });
  } finally { await w.done(); }
});

test("B1 R2 R-17: cancelling T5 stops the review on the persisted Codex adapter", async () => {
  const w = reviewCase("pending");
  try {
    await observe(() => !!one(w.h.db, "SELECT 1 FROM gg_reviews WHERE status = 'running'"));
    const task = w.h.listTasks({ roomId: w.room })[0]!;
    assert.equal(task.state, "T5_InReview");
    const reviewId = one<{ compute_id: string }>(w.h.db, "SELECT compute_id FROM gg_reviews WHERE task_id = ?", task.id)!.compute_id;
    w.h.stopTask(task.id, w.h.userId);
    assert.deepEqual(w.codex.stopped, [reviewId]);
    assert.ok(!w.cc.stopped.includes(reviewId));
    assert.equal(w.h.taskView(w.h.taskDoc(task.id).value).reviews?.[0]?.status, "stopped");
  } finally { await w.done(); }
});

test("B1 R2 AC-43: progress_get hides a leaving room while membership is still present", async () => {
  const answers: (string | null)[] = [];
  const queries: { id: string; room: string }[] = [];
  const h = create(file(), { mind: () => ({ async round(_input, _signal, tools) {
    for (const q of queries) answers.push(await tools!.progressGet!(q.id, q.room));
    return { actions: [], stateNote: null };
  } }) });
  try {
    const c = h.createContact({ name: "移出中的成员" });
    const member = { kind: "contact" as const, id: c.id };
    const leaving = h.createGroup("移出中", [{ kind: "user", id: h.userId }, member]).id;
    const dm = h.openDm(c.id).id;
    for (const room of [leaving, dm]) {
      const unit = h.runs.start({ layer: "compute-session", parentId: null, roomId: room, sourceSeq: 1, contactId: c.id, taskId: null, computeId: null, upstream: "m" });
      queries.push({ id: unit.id, room });
    }
    // Member removal keeps its row until active tasks stop. Seed that durable intermediate state.
    run(h.db, "INSERT INTO gg_member_exits (room_id, contact_id, started_at) VALUES (?,?,?)", leaving, c.id, new Date().toISOString());
    assert.ok(one(h.db, "SELECT 1 FROM gg_members WHERE room_id = ? AND member_id = ?", leaving, c.id));
    h.send({ roomId: dm, clientActionId: "query", text: "查进度" });
    await observe(() => answers.length >= 2);
    assert.equal(answers.length, 2);
    assert.equal(answers[0], null);
    assert.equal((JSON.parse(answers[1]!) as { unit: { id: string } }).unit.id, queries[1]!.id);
  } finally { await h.close(); }
});
