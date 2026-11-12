// Q05 v2: real Host/service/SQLite regressions for actual origin identity.
// Scripted Mind/Compute control who acts; this is not real-model or CLI acceptance.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskTimelineEvent, TaskView } from "@g-group/api-contract";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-task-timeline-origin-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;
type Svc = ReturnType<typeof createService>;
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const result = await svc.handle(method, params);
  assert.equal(result.ok, true, result.ok ? method : `${method}: ${result.error.code} ${result.error.message}`);
  if (!result.ok) throw new Error("unreachable service failure");
  return result.value as T;
}
const timeline = async (svc: Svc, taskId: string) => (await call<{ events: TaskTimelineEvent[] }>(svc, "tasks.timeline", { taskId })).events;
async function settle(host: Host, compute: ReturnType<typeof scriptedCompute>) {
  for (let i = 0; i < 250; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 4));
    if (!host.loop.busy() && compute.drained()) {
      await new Promise((r) => setTimeout(r, 8));
      if (!host.loop.busy() && compute.drained()) return;
    }
  }
  throw new Error("origin scene did not settle");
}
function scene(compute: ReturnType<typeof scriptedCompute>, mind: (host: () => Host) => ContactMind = () => scriptedMind()) {
  const userId = `origin-user-${++serial}`;
  const host: Host = new Host({ file: path.join(dir, `${serial}.db`), userId, mind: () => mind(() => host), compute: () => compute.adapter, maxDeferMs: 1 });
  const contact = host.createContact({ name: "origin owner" });
  const room = host.openDm(contact.id);
  return { host, contact, room, svc: createService(host), userId };
}

test("TT12 contact-owned stop records the actual contact actor while user cancellation stays user", async () => {
  let taskId: string | null = null;
  const issued: { contactId: string; action: MindAction }[] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "stop-native", resumed: false }] });
  const s = scene(compute, () => ({ async round(input) {
    const actions: MindAction[] = [];
    if (taskId && input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "停止这一项")) {
      const action: MindAction = { kind: "stop", taskId };
      actions.push(action);
      issued.push({ contactId: input.contact.id, action });
    }
    return { actions, stateNote: null };
  } }));
  try {
    const task = await call<TaskView>(s.svc, "tasks.create", { roomId: s.room.id, clientActionId: "contact-stop-create", title: "contact stop", ownerContactId: s.contact.id });
    taskId = task.id;
    await settle(s.host, compute);
    assert.equal(s.host.taskDoc(taskId).value.task.state, "T3_Running");
    s.host.send({ roomId: s.room.id, clientActionId: "contact-stop-source", text: "停止这一项" });
    await settle(s.host, compute);
    assert.deepEqual(issued, [{ contactId: s.contact.id, action: { kind: "stop", taskId } }]);
    const stopped = await timeline(s.svc, taskId);
    assert.deepEqual(stopped.find((e) => e.cause === "Cancel")?.actor, { kind: "contact", id: s.contact.id }, "contact stop must not invent a user with the contact ID");
    assert.equal(s.host.taskDoc(taskId).value.task.state, "T10_Cancelled");

    const manual = await call<TaskView>(s.svc, "tasks.create", { roomId: s.room.id, clientActionId: "user-stop-create", title: "user stop", ownerContactId: s.contact.id });
    await settle(s.host, compute);
    await call<TaskView>(s.svc, "tasks.cancel", { taskId: manual.id, clientActionId: "user-stop-action" });
    await settle(s.host, compute);
    assert.deepEqual((await timeline(s.svc, manual.id)).find((e) => e.cause === "Cancel")?.actor, { kind: "user", id: s.userId }, "the explicit user route retains its different typed actor");
  } finally { await s.host.close(); }
});

test("TT13 autonomous rerun reuses the real contact initiator and manual rerun remains user", async () => {
  for (const mode of ["automatic", "manual"] as const) {
    let spawns = 0;
    let retried = false;
    const issued: { contactId: string; action: MindAction }[] = [];
    const compute = scriptedCompute({ script: () => ++spawns === 1
      ? [{ kind: "started", sessionId: "first", resumed: false }, { kind: "failed", reason: "process failed", code: 1, signal: null, violations: [] }]
      : [{ kind: "started", sessionId: "retry", resumed: false }] });
    const s = scene(compute, (get) => ({ async round(input) {
      const actions: MindAction[] = [];
      if (mode === "automatic" && !retried && input.fresh.some((f) => f.kind === "compute" && f.signal === "failed")) {
        const run = get().listRuns({}).runs.find((r) => r.layer === "compute-session" && r.status === "failed");
        assert.ok(run, "the failed run is visible at the real contact decision");
        retried = true;
        const action: MindAction = { kind: "rerun", roomId: run.roomId, runId: run.id, basisSeq: null };
        actions.push(action);
        issued.push({ contactId: input.contact.id, action });
      }
      return { actions, stateNote: null };
    } }));
    try {
      const original = await call<TaskView>(s.svc, "tasks.create", { roomId: s.room.id, clientActionId: "rerun-create", title: "rerun origin", ownerContactId: s.contact.id });
      await settle(s.host, compute);
      if (mode === "manual") {
        const failed = s.host.listRuns({}).runs.find((r) => r.layer === "compute-session" && r.status === "failed");
        assert.ok(failed);
        await call(s.svc, "runs.rerun", { runId: failed.id, clientActionId: "manual-rerun" });
        await settle(s.host, compute);
      }
      const rerun = s.host.listTasks({ roomId: s.room.id }).find((t) => t.id !== original.id);
      assert.ok(rerun, "the accepted ordinary rerun route creates a real second task");
      const rows = all<{ detail: string }>(s.host.db, "SELECT detail FROM gg_run_events WHERE kind = 'rerun'");
      assert.equal(rows.length, 1);
      const ledger = JSON.parse(rows[0]!.detail) as { initiator: { kind: string; id: string }; actor: { kind: string; id: string }; trigger: string; basisSeq: number | null };
      const actual = mode === "automatic" ? { kind: "contact", id: s.contact.id } : { kind: "user", id: s.userId };
      assert.deepEqual(ledger.initiator, actual);
      assert.deepEqual(ledger.actor, actual);
      assert.equal(ledger.trigger, mode === "automatic" ? "auto" : "explicit");
      if (mode === "automatic") { assert.equal(ledger.basisSeq, null); assert.equal(issued.length, 1); assert.equal(issued[0]!.contactId, s.contact.id); }
      else assert.deepEqual(issued, []);
      const events = await timeline(s.svc, rerun.id);
      assert.deepEqual(events.find((e) => e.cause === "RerunCreate")?.actor, actual, "rerun creation must match the actual already-recorded initiator, not the ambient user");
      assert.deepEqual(events.find((e) => e.cause === "RerunClaim")?.actor, actual, "rerun assignment keeps the same actual initiating actor");
    } finally { await s.host.close(); }
  }
});
