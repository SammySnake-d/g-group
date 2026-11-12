// AC-08 host-owned disclosure; deterministic Compute, real durable artifact and service boundary.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
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
