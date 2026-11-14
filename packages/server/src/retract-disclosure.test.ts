// AC-08 host-owned disclosure; deterministic Compute, real durable artifact and service boundary.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

async function quiet(host: Host, compute: { drained(): boolean }): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!host.loop.busy() && compute.drained()) return;
  }
  assert.fail("fixture did not settle");
}

test("RD01 retract disclosure is a durable host fact naming the affected task and completed ledger outcome", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-disclosure-"));
  const file = path.join(dir, "host.db");
  const artifact = path.join(dir, "written.txt");
  let writes = 0;
  const compute = scriptedCompute({ script() {
    writes++;
    writeFileSync(artifact, "NEUTRAL_COMMITTED_BYTES");
    return [{ kind: "started", sessionId: "rd-real-file", resumed: false }, { kind: "completed", result: "已写入文件 written.txt" }];
  } });
  const options = { file, maxDeferMs: 5, mind: () => scriptedMind(), compute: () => compute.adapter };
  let host = new Host(options);
  const contact = host.createContact({ name: "披露归属" });
  const room = host.openDm(contact.id);
  try {
    const source = host.send({ roomId: room.id, clientActionId: "rd-positive", text: "帮我写入验收工件" });
    await quiet(host, compute);
    const tasks = host.listTasks({ roomId: room.id });
    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    const completed = task.recentProgress.find((event) => event.kind === "completed");
    assert.ok(completed, "the real Host has a durable completed record before retract");
    const emitted: string[] = [];
    const off = host.bus.subscribe((event) => {
      if (event.type === "message.appended" && event.message.sender.kind === "system") emitted.push(event.message.text);
    });
    const result = await createService(host).handle("messages.retract", { roomId: room.id, seq: source.seq });
    assert.equal(result.ok, true);
    const notices = host.listMessages(room.id, {}).messages.filter((message) => message.sender.kind === "system");
    assert.equal(notices.length, 1, "the host, not a lucky contact reply, owns the disclosure");
    const notice = notices[0]!;
    assert.ok(notice.text.includes(task.id), "the notice names the exact task");
    assert.ok(notice.text.includes(completed.computeId), "the notice names the real completed Compute");
    assert.ok(notice.text.includes(completed.summary), "the outcome comes from the persisted ledger");
    assert.match(notice.text, /已发生[^。\n]{0,80}无法撤回/);
    assert.deepEqual(emitted, [notice.text], "the same persisted notice is delivered to live subscribers");
    off();
    await quiet(host, compute);
    assert.equal(host.taskViewById(task.id).state, task.state, "disclosure does not alter T5 or undo a task");
    assert.equal(readFileSync(artifact, "utf8"), "NEUTRAL_COMMITTED_BYTES");
    assert.equal(writes, 1);
    await host.close();
    host = new Host(options);
    const persisted = host.listMessages(room.id, {}).messages.filter((message) => message.sender.kind === "system");
    assert.deepEqual(persisted.map((message) => [message.seq, message.text]), [[notice.seq, notice.text]], "notice survives a real SQLite reopen");
    const repeated = await createService(host).handle("messages.retract", { roomId: room.id, seq: source.seq });
    assert.equal(repeated.ok, false, "existing duplicate-retract conflict stays unchanged");
    assert.equal(host.listMessages(room.id, {}).messages.filter((message) => message.sender.kind === "system").length, 1);
    assert.equal(readFileSync(artifact, "utf8"), "NEUTRAL_COMMITTED_BYTES");
    assert.equal(writes, 1);
  } finally { compute.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("RD02 retracting effect-free chat emits no irreversible-effect warning even when another task in the room completed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-no-effects-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "rd-unrelated", resumed: false }, { kind: "completed", result: "OTHER_TASK_ONLY" }] });
  const host = new Host({ file: path.join(dir, "host.db"), maxDeferMs: 5, mind: () => scriptedMind(), compute: () => compute.adapter });
  const contact = host.createContact({ name: "无副作用阴性" });
  const room = host.openDm(contact.id);
  try {
    host.send({ roomId: room.id, clientActionId: "rd-other-task", text: "帮我做另一件独立任务" });
    await quiet(host, compute);
    assert.ok(host.listTasks({ roomId: room.id }).some((task) => task.recentProgress.some((event) => event.kind === "completed")));
    const source = host.send({ roomId: room.id, clientActionId: "rd-no-effects", text: "NEUTRAL_EFFECT_FREE_CHAT" });
    await quiet(host, compute);
    assert.ok(!host.listTasks({ roomId: room.id }).some((task) => task.sourceSeq === source.seq), "the source is genuinely task-free");
    const result = await createService(host).handle("messages.retract", { roomId: room.id, seq: source.seq });
    assert.equal(result.ok, true);
    await quiet(host, compute);
    assert.deepEqual(host.listMessages(room.id, {}).messages.filter((message) => message.sender.kind === "system"), [], "do not fabricate effects from an unrelated completed task");
    assert.equal(host.listMessages(room.id, {}).messages.find((message) => message.seq === source.seq)?.retracted, true);
  } finally { compute.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("RD03 equal sequence in another room is not provenance, and disclosure never copies withdrawn source text", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-provenance-"));
  const sourceText = "帮我完成NEUTRAL_WITHDRAWN_SOURCE_WITH_PRIVATE_DETAIL";
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "rd-origin", resumed: false }, { kind: "completed", result: `输出 ready.txt; 原要求:${sourceText}` }] });
  const host = new Host({ file: path.join(dir, "host.db"), maxDeferMs: 5, mind: () => scriptedMind(), compute: () => compute.adapter });
  const owner = host.createContact({ name: "真实来源" });
  const other = host.createContact({ name: "同序号别屋" });
  const originRoom = host.openDm(owner.id);
  const otherRoom = host.openDm(other.id);
  try {
    const origin = host.send({ roomId: originRoom.id, clientActionId: "rd-origin", text: sourceText });
    await quiet(host, compute);
    const task = host.listTasks({ roomId: originRoom.id })[0]!;
    assert.ok(task.recentProgress.some((event) => event.kind === "completed"));
    const unrelated = host.send({ roomId: otherRoom.id, clientActionId: "rd-other-room", text: "NEUTRAL_UNRELATED_CHAT" });
    await quiet(host, compute);
    assert.equal(origin.seq, unrelated.seq, "room plus sequence, not sequence alone, identifies a source");
    assert.equal((await createService(host).handle("messages.retract", { roomId: otherRoom.id, seq: unrelated.seq })).ok, true);
    assert.deepEqual(host.listMessages(otherRoom.id, {}).messages.filter((message) => message.sender.kind === "system"), []);
    assert.equal((await createService(host).handle("messages.retract", { roomId: originRoom.id, seq: origin.seq })).ok, true);
    const notices = host.listMessages(originRoom.id, {}).messages.filter((message) => message.sender.kind === "system");
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.text.includes(task.id));
    assert.ok(notices[0]!.text.includes("ready.txt"));
    assert.ok(!notices[0]!.text.includes(sourceText), "host disclosure cannot reintroduce the retracted original");
  } finally { compute.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("RD04 failed durable notice append rolls back the retract itself and emits no phantom live notice", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-retract-atomic-"));
  const file = path.join(dir, "host.db");
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "rd-atomic", resumed: false }, { kind: "completed", result: "ATOMIC_COMPLETED_OUTCOME" }] });
  const host = new Host({ file, maxDeferMs: 5, mind: () => scriptedMind(), compute: () => compute.adapter });
  const contact = host.createContact({ name: "原子披露" });
  const room = host.openDm(contact.id);
  const observer = new DatabaseSync(file);
  try {
    const source = host.send({ roomId: room.id, clientActionId: "rd-atomic", text: "帮我完成原子性验收" });
    await quiet(host, compute);
    assert.ok(host.listTasks({ roomId: room.id })[0]!.recentProgress.some((event) => event.kind === "completed"));
    const before = host.listMessages(room.id, {}).messages;
    const emitted: string[] = [];
    const off = host.bus.subscribe((event) => { if (event.type === "message.appended" && event.message.sender.kind === "system") emitted.push(event.message.text); });
    // Test-only fault injection, not a production trigger or alternate write path.
    observer.exec("CREATE TRIGGER rd_fail_notice BEFORE INSERT ON events WHEN NEW.sender_kind = 'system' BEGIN SELECT RAISE(ABORT, 'NEUTRAL_NOTICE_FAILURE'); END;");
    const failed = await createService(host).handle("messages.retract", { roomId: room.id, seq: source.seq });
    assert.equal(failed.ok, false, "do not return success after a failed disclosure append");
    assert.deepEqual(host.listMessages(room.id, {}).messages, before, "neither the retract nor its index/view half-commits");
    assert.deepEqual(emitted, [], "no event is published from an aborted transaction");
    observer.exec("DROP TRIGGER rd_fail_notice");
    const retried = await createService(host).handle("messages.retract", { roomId: room.id, seq: source.seq });
    assert.equal(retried.ok, true);
    assert.equal(host.listMessages(room.id, {}).messages.filter((message) => message.sender.kind === "system").length, 1);
    assert.equal(emitted.length, 1);
    off();
  } finally { observer.close(); compute.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});
