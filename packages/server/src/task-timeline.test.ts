// U80/D21: public service + real SQLite; deterministic mind/Compute are not real-model proof.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskTimelineEvent, TaskView } from "@g-group/api-contract";
import { newTask } from "@g-group/domain";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { all, putDoc, tx } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-task-timeline-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;
const NOW = "2026-11-12T17:00:00.000Z";
type Svc = ReturnType<typeof createService>;
type Page = { events: TaskTimelineEvent[]; nextCursor: string | null };
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const result = await svc.handle(method, params);
  assert.equal(result.ok, true, result.ok ? method : `${method}: ${result.error.code} ${result.error.message}`);
  if (!result.ok) throw new Error("unreachable service failure");
  return result.value as T;
}
async function page(svc: Svc, taskId: string, q: { cursor?: string; limit?: number } = {}) {
  return call<Page>(svc, "tasks.timeline", { taskId, ...q });
}
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 3));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 3));
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  throw new Error("timeline fixture did not settle");
}
function scene(options: { mind?: (host: () => Host) => ContactMind; compute?: ReturnType<typeof scriptedCompute>; file?: string; userId?: string } = {}) {
  const compute = options.compute ?? scriptedCompute({ script: () => [{ kind: "started", sessionId: "native-session", resumed: false }] });
  const file = options.file ?? path.join(dir, `${++serial}.db`);
  const host: Host = new Host({ file, ...(options.userId ? { userId: options.userId } : {}), now: () => NOW, mind: () => options.mind?.(() => host) ?? scriptedMind(), compute: () => compute.adapter, maxDeferMs: 1 });
  const c = host.createContact({ name: "timeline contact" });
  const room = host.openDm(c.id);
  const svc = createService(host);
  return { host, compute, file, c, room, svc };
}
function forwarding(get: () => Host): ContactMind {
  return { async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("给A:")) {
        const task = get().listTasks({ roomId: f.roomId }).find((t) => t.title === "A")!;
        actions.push({ kind: "forward", taskId: task.id, text: f.text.slice(3), sourceSeq: f.seq });
      }
      if (f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `完成:${f.summary}` });
    }
    return { actions, stateNote: null };
  } };
}
const create = (s: ReturnType<typeof scene>, id: string, title = "A", owner = false) => call<TaskView>(s.svc, "tasks.create", { roomId: s.room.id, clientActionId: id, title, ...(owner ? { ownerContactId: s.c.id } : {}) });
const detail = (e: TaskTimelineEvent) => e.data as Record<string, unknown>;
const rows = (h: Host, taskId: string) => all<{ id: number; payload: string }>(h.db, "SELECT id, payload FROM gg_task_events WHERE task_id = ? ORDER BY id", taskId);

test("TT01 manual creation, user assignment and real model-attempt facts are append-only and action-idempotent", async () => {
  const s = scene();
  try {
    const t = await create(s, "create");
    let history = (await page(s.svc, t.id)).events;
    assert.equal(history.length, 1, "manual creation has exactly one actual creation fact");
    assert.deepEqual([history[0]!.kind, history[0]!.cause, history[0]!.actor, history[0]!.before, history[0]!.after.state], ["created", "ManualCreate", { kind: "user", id: "me" }, null, "T1_Open"]);
    assert.equal(detail(history[0]!).requester, "me");
    const original = rows(s.host, t.id);
    await call(s.svc, "tasks.assign", { taskId: t.id, contactId: s.c.id, clientActionId: "assign" });
    await settle(s.host, s.compute);
    history = (await page(s.svc, t.id)).events;
    const claim = history.find((e) => e.cause === "ManualAssign")!;
    assert.deepEqual([claim.actor, claim.before!.owner, claim.after.owner, claim.after.state], [{ kind: "user", id: "me" }, null, s.c.id, "T2_Claimed"]);
    assert.ok(history.some((e) => e.cause === "Dispatch" && e.after.state === "T3_Running" && e.after.computeId === "cp-1"));
    assert.ok(history.some((e) => e.kind === "model-attempt" && detail(e).computeId === "cp-1"));
    const frozen = rows(s.host, t.id);
    assert.deepEqual(frozen.slice(0, original.length), original, "old rows keep their original bytes");
    await create(s, "create");
    await call(s.svc, "tasks.assign", { taskId: t.id, contactId: s.c.id, clientActionId: "assign" });
    await settle(s.host, s.compute);
    assert.deepEqual(rows(s.host, t.id), frozen, "replayed actions do not fabricate new facts");
  } finally { await s.host.close(); }
});

test("TT02 contact dispatch and explicit rerun both record their actual creator and original source", async () => {
  let attempt = 0;
  const compute = scriptedCompute({ script: () => ++attempt === 1 ? [{ kind: "started", sessionId: "s", resumed: false }, { kind: "failed", reason: "process failed", code: 1, signal: null, violations: [] }] : [{ kind: "started", sessionId: "s2", resumed: false }] });
  const s = scene({ compute });
  try {
    const source = s.host.send({ roomId: s.room.id, clientActionId: "source", text: "帮我核对文档" });
    await settle(s.host, compute);
    const t = s.host.listTasks({ roomId: s.room.id })[0]!;
    const first = (await page(s.svc, t.id)).events;
    assert.equal(first[0]?.cause, "ContactDispatch");
    assert.deepEqual(first[0]!.actor, { kind: "contact", id: s.c.id });
    assert.equal(first[0]!.sourceSeq, source.seq);
    const unit = s.host.listRuns({}).runs.find((r) => r.layer === "compute-session" && r.status === "failed")!;
    assert.ok(unit);
    const rerun = await call<{ taskId: string }>(s.svc, "runs.rerun", { runId: unit.id, clientActionId: "retry" });
    await settle(s.host, compute);
    const second = (await page(s.svc, rerun.taskId)).events;
    assert.deepEqual([second[0]!.cause, second[0]!.actor, second[0]!.sourceSeq, detail(second[0]!).rerunOfTask], ["RerunCreate", { kind: "user", id: "me" }, source.seq, t.id]);
    assert.ok(second.some((e) => e.cause === "RerunClaim" && e.after.owner === s.c.id));
    assert.deepEqual((await page(s.svc, t.id)).events, first, "new task history does not rewrite original history");
  } finally { await s.host.close(); }
});

test("TT03 task transitions preserve pre/post state and do not turn duplicate or rejected actions into history", async () => {
  const s = scene();
  try {
    const t = await create(s, "start", "A", true);
    await settle(s.host, s.compute);
    assert.ok((await page(s.svc, t.id)).events.some((e) => e.cause === "Dispatch"));
    await call(s.svc, "tasks.cancel", { taskId: t.id, clientActionId: "cancel" });
    await settle(s.host, s.compute);
    const events = (await page(s.svc, t.id)).events;
    const stop = events.find((e) => e.cause === "Cancel")!;
    const confirmed = events.find((e) => e.cause === "StoppedConfirmed")!;
    assert.deepEqual([stop.before!.state, stop.after.state, confirmed.before!.state, confirmed.after.state], ["T3_Running", "T9_StopRequested", "T9_StopRequested", "T10_Cancelled"]);
    assert.ok(stop.id < confirmed.id, "stop request is not stop confirmation");
    const old = rows(s.host, t.id);
    await call(s.svc, "tasks.cancel", { taskId: t.id, clientActionId: "cancel" });
    const invalid = await s.svc.handle("tasks.assign", { taskId: t.id, contactId: s.c.id, clientActionId: "bad" });
    assert.equal(invalid.ok, false);
    assert.deepEqual(rows(s.host, t.id), old);
  } finally { await s.host.close(); }
});

test("TT04 follow-up receipt, accepted resume and artifact application are distinct persisted facts without source text", async () => {
  const s = scene({ mind: forwarding });
  try {
    const t = await create(s, "A", "A", true);
    await settle(s.host, s.compute);
    assert.ok((await page(s.svc, t.id)).events.length > 0);
    const msg = s.host.send({ roomId: s.room.id, clientActionId: "new-constraint", text: "给A:PRIVATE-FOLLOW-UP-PLAINTEXT" });
    await settle(s.host, s.compute);
    let events = (await page(s.svc, t.id)).events;
    const received = events.find((e) => e.cause === "FollowUpReceived")!;
    const resumed = events.find((e) => e.cause === "ResumeAccepted")!;
    assert.ok(received && resumed && received.id < resumed.id);
    assert.ok(JSON.stringify(detail(received)).includes(`\"seq\":${msg.seq}`));
    assert.equal(received.after.constraintVer, 1);
    assert.equal(s.compute.resumed.length, 1);
    s.compute.emit({ computeId: "cp-1", kind: "completed", result: "v0-result" });
    await settle(s.host, s.compute);
    s.compute.emit({ computeId: "cp-1", kind: "completed", result: "v1-result" });
    await settle(s.host, s.compute);
    events = (await page(s.svc, t.id)).events;
    assert.ok(events.some((e) => e.cause === "RoundCompleted" && detail(e).resultVer === 1));
    assert.ok(events.some((e) => e.cause === "FollowUpApplied" && JSON.stringify(detail(e)).includes('"state":"Applied"')));
    assert.ok(!JSON.stringify(events).includes("PRIVATE-FOLLOW-UP-PLAINTEXT"), "timeline does not duplicate retractable message bodies");
  } finally { await s.host.close(); }
});

test("TT05 rebind appends both sides' real linkage versions atomically and replay does not duplicate them", async () => {
  const s = scene({ mind: forwarding });
  try {
    const a = await create(s, "A", "A", true); const b = await create(s, "B", "B", true);
    await settle(s.host, s.compute);
    assert.ok((await page(s.svc, a.id)).events.length > 0);
    const m = s.host.send({ roomId: s.room.id, clientActionId: "follow", text: "给A:改挂要求" });
    await settle(s.host, s.compute);
    const params = { roomId: s.room.id, seq: m.seq, fromTaskId: a.id, toTaskId: b.id, expectedBindingVersion: 0, clientActionId: "rebind" };
    await call(s.svc, "tasks.rebindFollowUp", params);
    await settle(s.host, s.compute);
    const ea = (await page(s.svc, a.id)).events; const eb = (await page(s.svc, b.id)).events;
    assert.ok(ea.some((e) => e.cause === "FollowUpReboundOut" && JSON.stringify(detail(e)).includes(b.id)));
    assert.ok(eb.some((e) => e.cause === "FollowUpReboundIn" && JSON.stringify(detail(e)).includes(`\"seq\":${m.seq}`)));
    const before = [rows(s.host, a.id), rows(s.host, b.id)];
    await call(s.svc, "tasks.rebindFollowUp", params);
    await settle(s.host, s.compute);
    assert.deepEqual([rows(s.host, a.id), rows(s.host, b.id)], before);
  } finally { await s.host.close(); }
});

test("TT06 same-timestamp keyset pages are task-bound, stable under append and strictly validate cursors and limits", async () => {
  const s = scene();
  try {
    const t = await create(s, "A", "A", true); await settle(s.host, s.compute);
    const first = await page(s.svc, t.id, { limit: 1 });
    assert.equal(first.events.length, 1); assert.ok(first.nextCursor);
    await call(s.svc, "tasks.cancel", { taskId: t.id, clientActionId: "cancel" }); await settle(s.host, s.compute);
    const combined = [...first.events]; let cursor: string | null = first.nextCursor;
    while (cursor) { const p = await page(s.svc, t.id, { limit: 1, cursor }); combined.push(...p.events); cursor = p.nextCursor; }
    const allEvents = (await page(s.svc, t.id)).events;
    assert.deepEqual(combined, allEvents);
    assert.equal(new Set(combined.map((e) => e.id)).size, combined.length);
    assert.ok(combined.every((e) => e.at === NOW));
    const other = await create(s, "other", "B");
    for (const q of [{ cursor: first.nextCursor, taskId: other.id }, { cursor: "%%%" }, { cursor: Buffer.from(JSON.stringify([t.id, -1])).toString("base64url") }, { limit: 0 }, { limit: 201 }]) {
      const r = await s.svc.handle("tasks.timeline", { taskId: t.id, ...q });
      assert.ok(!r.ok && r.error.code === "invalid_params");
    }
    const frozen = rows(s.host, t.id); await page(s.svc, t.id);
    assert.deepEqual(rows(s.host, t.id), frozen, "timeline API is read-only");
  } finally { await s.host.close(); }
});

test("TT07 task timeline enforces current room membership before returning any events or cursor", async () => {
  const s = scene();
  try {
    const t = await create(s, "A");
    assert.equal((await page(s.svc, t.id)).events.length, 1);
    s.host.db.store.db.prepare("DELETE FROM gg_members WHERE room_id = ? AND kind = 'user'").run(s.room.id);
    for (const q of [{}, { cursor: "invalid" }]) {
      const r = await s.svc.handle("tasks.timeline", { taskId: t.id, ...q });
      assert.ok(!r.ok && r.error.code === "forbidden");
    }
    const missing = await s.svc.handle("tasks.timeline", { taskId: "absent" });
    assert.ok(!missing.ok && missing.error.code === "not_found");
  } finally { await s.host.close(); }
});

test("TT08 timeline insert failure rolls back creation and task transition with no durable or live ghost", async () => {
  const s = scene();
  try {
    const control = await create(s, "control");
    assert.equal((await page(s.svc, control.id)).events.length, 1);
    const before = [s.host.listMessages(s.room.id, {}).messages, s.host.listTasks({}), rows(s.host, control.id)];
    const seen: unknown[] = []; const unsubscribe = s.host.bus.subscribe((e) => seen.push(e));
    // Fault injection only: no production triggers are used to record timeline facts.
    s.host.db.store.db.exec("CREATE TEMP TRIGGER fail_timeline BEFORE INSERT ON gg_task_events BEGIN SELECT RAISE(ABORT, 'timeline fault'); END");
    const badCreate = await s.svc.handle("tasks.create", { roomId: s.room.id, clientActionId: "retryable-create", title: "new" });
    const badCancel = await s.svc.handle("tasks.cancel", { taskId: control.id, clientActionId: "retryable-cancel" });
    assert.ok(!badCreate.ok && !badCancel.ok);
    assert.deepEqual([s.host.listMessages(s.room.id, {}).messages, s.host.listTasks({}), rows(s.host, control.id)], before);
    assert.equal(seen.length, 0); unsubscribe();
    s.host.db.store.db.exec("DROP TRIGGER fail_timeline");
    const retried = await create(s, "retryable-create", "new");
    assert.equal((await page(s.svc, retried.id)).events.length, 1);
    await call(s.svc, "tasks.cancel", { taskId: control.id, clientActionId: "retryable-cancel" });
    assert.equal((await page(s.svc, control.id)).events.at(-1)!.after.state, "T10_Cancelled");
  } finally { await s.host.close(); }
});

test("TT09 real SQLite reopen preserves event bytes and continuation cursor but does not invent legacy task history", async () => {
  const s = scene(); let closed = false;
  try {
    const t = await create(s, "A", "A", true); await settle(s.host, s.compute);
    const first = await page(s.svc, t.id, { limit: 1 });
    assert.equal(first.events.length, 1); assert.ok(first.nextCursor);
    const original = rows(s.host, t.id);
    tx(s.host.db, () => putDoc(s.host.db, "task:legacy", 0, { task: newTask("legacy", "me"), title: "pre-timeline task", roomId: s.room.id, sourceSeq: 1, brief: "old", createdAt: NOW, updatedAt: NOW, result: null }));
    await s.host.close(); closed = true;
    const h = new Host({ file: s.file, now: () => NOW, mind: () => scriptedMind() });
    try {
      const svc = createService(h);
      assert.deepEqual(rows(h, t.id), original);
      const rest = await page(svc, t.id, { cursor: first.nextCursor });
      assert.deepEqual([...first.events, ...rest.events].map((e) => e.id), original.map((e) => e.id));
      assert.deepEqual(await page(svc, "legacy"), { events: [], nextCursor: null });
      await call(svc, "tasks.cancel", { taskId: "legacy", clientActionId: "legacy-change" });
      const history = (await page(svc, "legacy")).events;
      assert.deepEqual(history.map((e) => e.cause), ["Cancel"], "only a new real event, no invented Created record");
    } finally { await h.close(); }
  } finally { if (!closed) await s.host.close(); }
});
