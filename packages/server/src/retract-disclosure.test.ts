import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { MindAction } from "@g-group/kernel";
import { all, putDoc, run } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const LEDGER_AT = "2026-11-18T01:00:00.000Z";
const RETRACT_AT = "2026-11-18T02:00:00.000Z";
const resources: { host: Host; dir: string }[] = [];
afterEach(async () => {
  for (const { host, dir } of resources.splice(0)) {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function scene(H: typeof Host, status: "completed" | "failed" | "running" = "completed", deliver = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "b3-retract-"));
  const compute = scriptedCompute({ script: () => {
    const start = { kind: "started", sessionId: "native", resumed: false } as const;
    switch (status) {
      case "running": return [start];
      case "failed": return [start, { kind: "failed", reason: "fixture failed", code: 1, signal: null, violations: [] }];
      case "completed": return [start, { kind: "completed", result: "LEDGER_FACT" }];
    }
  } });
  let now = LEDGER_AT;
  const host = new H({ file: path.join(dir, "sqlite"), now: () => now, compute: () => compute.adapter, maxDeferMs: 1,
    mind: () => ({ async round(input, signal) {
      const out = await scriptedMind().round(input, signal);
      return { stateNote: null, actions: out.actions.flatMap<MindAction>((a) => a.kind !== "deliver" ? [a] : deliver ? [{ ...a, text: "CONTACT_OPINION" }] : []) };
    } }),
  });
  resources.push({ host, dir });
  const contact = host.createContact({ name: "worker" });
  const room = host.openDm(contact.id);
  const send = (key: string, text: string) => host.send({ roomId: room.id, clientActionId: key, text });
  const retract = (seq: number) => { now = RETRACT_AT; return host.retractMessage(room.id, seq); };
  const notices = () => host.listMessages(room.id, {}).messages.filter((m) => m.sender.kind === "system" && m.text.includes("副作用"));
  return { host, room, compute, send, retract, notices };
}
async function settle(s: ReturnType<typeof scene>) {
  for (let i = 0; i < 300; ++i) {
    await s.host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (s.compute.drained() && !s.host.loop.busy()) return;
  }
  throw new Error("retract fixture did not settle");
}
const rows = (host: Host) => all<{ id: number; task_id: string; compute_id: string; kind: string; at: string; summary: string }>(host.db, "SELECT * FROM gg_progress ORDER BY id");
const completed = (s: ReturnType<typeof scene>) => rows(s.host).filter((r) => r.kind === "completed");
const emit = (s: ReturnType<typeof scene>, ev: ComputeEvent) => s.compute.emit(ev);

test("RD01 retract discloses the ledger outcome, not the contact's different delivery", async () => {
  const s = scene(Host, "completed", true);
  const src = s.send("source", "帮我生成报告");
  await settle(s);
  const task = s.host.taskDoc(s.host.listTasks({})[0]!.id).value;
  assert.equal(task.result, "CONTACT_OPINION");
  s.retract(src.seq);
  assert.deepEqual(s.notices().length, 1);
  assert.match(s.notices()[0]!.text, /LEDGER_FACT/);
  assert.doesNotMatch(s.notices()[0]!.text, /CONTACT_OPINION/);
});

test("RD02 completed ledger is disclosed even if the contact never delivers", async () => {
  const s = scene(Host);
  const src = s.send("source", "帮我检查");
  await settle(s);
  const ledger = completed(s)[0]!;
  assert.equal(ledger.summary, "LEDGER_FACT");
  assert.equal(s.host.taskDoc(ledger.task_id).value.result, null);
  s.retract(src.seq);
  assert.deepEqual(s.notices().map((n) => n.text.includes(ledger.compute_id) && n.text.includes(ledger.summary)), [true]);
});

test("RD03 failed Compute reports actual status and time, never completion or undo", async () => {
  const s = scene(Host, "failed");
  const src = s.send("source", "帮我检查");
  await settle(s);
  const task = s.host.listTasks({})[0]!;
  const cp = s.host.taskViewById(task.id).computeRuns[0]!;
  assert.equal(cp.status, "failed");
  s.retract(src.seq);
  const notices = s.notices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0]!.text.includes(cp.computeId));
  assert.ok(notices[0]!.text.includes(cp.endedAt ?? cp.startedAt));
  assert.match(notices[0]!.text, /\bfailed\b/);
  assert.doesNotMatch(notices[0]!.text, /已报告完成|已撤销/);
  assert.match(notices[0]!.text, /不能.*完成.*撤/);
});

test("RD03 stopped Compute reports actual status and time, never completion or undo", async () => {
  const s = scene(Host, "running");
  const src = s.send("source", "帮我检查");
  await settle(s);
  const task = s.host.listTasks({})[0]!;
  s.host.taskDecision(task.id, "cancel", "cancel");
  await settle(s);
  const cp = s.host.taskViewById(task.id).computeRuns[0]!;
  assert.equal(cp.status, "stopped");
  s.retract(src.seq);
  const notices = s.notices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0]!.text.includes(cp.computeId));
  assert.ok(notices[0]!.text.includes(cp.endedAt ?? cp.startedAt));
  assert.match(notices[0]!.text, /\bstopped\b/);
  assert.doesNotMatch(notices[0]!.text, /已报告完成|已撤销/);
  assert.match(notices[0]!.text, /不能.*完成.*撤/);
});

test("RD03 running Compute reports actual status and time, never completion or undo", async () => {
  const s = scene(Host, "running");
  const src = s.send("source", "帮我检查");
  await settle(s);
  const task = s.host.listTasks({})[0]!;
  const cp = s.host.taskViewById(task.id).computeRuns[0]!;
  assert.equal(cp.status, "running");
  s.retract(src.seq);
  const notices = s.notices();
  assert.equal(notices.length, 1);
  assert.ok(notices[0]!.text.includes(cp.computeId));
  assert.ok(notices[0]!.text.includes(cp.endedAt ?? cp.startedAt));
  assert.match(notices[0]!.text, /\brunning\b/);
  assert.doesNotMatch(notices[0]!.text, /已报告完成|已撤销/);
  assert.match(notices[0]!.text, /不能.*完成.*撤/);
});

test("RD04 retracting earlier chat never discloses a later task; only its actual source does", async () => {
  const s = scene(Host);
  const earlier = s.send("earlier", "普通闲谈");
  const src = s.send("source", "帮我检查");
  await settle(s);
  s.retract(earlier.seq);
  assert.deepEqual(s.notices(), []);
  s.retract(src.seq);
  assert.equal(s.notices().length, 1);
  assert.match(s.notices()[0]!.text, new RegExp(`#${src.seq}\\b`));
});

test("RD05 retract discloses completed effects without modifying any progress ledger row", async () => {
  const s = scene(Host);
  const src = s.send("source", "帮我检查");
  await settle(s);
  const before = rows(s.host);
  assert.ok(completed(s).length > 0);
  s.retract(src.seq);
  assert.equal(s.notices().length, 1);
  assert.deepEqual(rows(s.host), before);
});

test("RD06 all tasks with the same message source are disclosed, including a second Compute run", async () => {
  const s = scene(Host);
  const src = s.send("source", "帮我检查甲");
  await settle(s);
  const other = s.send("other", "帮我检查乙");
  await settle(s);
  const tasks = s.host.listTasks({ roomId: s.room.id });
  assert.equal(tasks.length, 2);
  const second = s.host.taskDoc(tasks.find((t) => t.sourceSeq === other.seq)!.id);
  // Reruns retain the original source. Reproduce that persisted topology explicitly.
  putDoc(s.host.db, `task:${second.value.task.id}`, second.ver, { ...second.value, sourceSeq: src.seq });
  s.retract(src.seq);
  const notices = s.notices();
  assert.equal(notices.length, 2);
  for (const row of completed(s)) assert.equal(notices.filter((n) => n.text.includes(row.task_id) && n.text.includes(row.compute_id)).length, 1);
});

test("RD07 each completion report for one task/Compute gets its own ledger-based disclosure", async () => {
  const s = scene(Host);
  const src = s.send("source", "帮我检查");
  await settle(s);
  const first = completed(s)[0]!;
  // A prior turn and its resumed turn may both have durable completion reports.
  run(s.host.db, "INSERT INTO gg_progress (task_id, compute_id, kind, summary, at) VALUES (?, ?, 'completed', ?, ?)", first.task_id, first.compute_id, "SECOND_LEDGER_FACT", LEDGER_AT);
  s.retract(src.seq);
  const notices = s.notices();
  assert.equal(notices.length, 2);
  assert.doesNotMatch(notices[0]!.text, /SECOND_LEDGER_FACT/);
  assert.match(notices[1]!.text, /SECOND_LEDGER_FACT/);
});

test("RD08 disclosure cites the completed ledger time even though its message has the later retract time", async () => {
  const s = scene(Host, "running");
  const src = s.send("source", "帮我检查");
  await settle(s);
  emit(s, { computeId: s.compute.spawned[0]!.computeId, kind: "completed", result: "LEDGER_FACT" });
  await settle(s);
  const ledger = completed(s)[0]!;
  s.retract(src.seq);
  const [notice] = s.notices();
  assert.ok(notice);
  assert.equal(notice.at, RETRACT_AT);
  assert.ok(notice.text.includes(ledger.at));
  assert.ok(!notice.text.includes(RETRACT_AT));
});
