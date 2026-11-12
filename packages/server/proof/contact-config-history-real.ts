// 无模型的真实服务/SQLite路径:配置只作用于下一轮,回滚不回退消息/任务/记忆,动作回放跨重启。
// node packages/server/proof/contact-config-history-real.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContactView, ContactConfigVersion, TaskView } from "@g-group/api-contract";
import type { MindAction, RoundInput } from "@g-group/kernel";
import { all } from "../src/db.ts";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "gg-config-real-"));
const file = path.join(root, "gg.db");
const requests: RoundInput[] = [];
let started!: () => void;
let release!: () => void;
const began = new Promise<void>((r) => { started = r; });
const barrier = new Promise<void>((r) => { release = r; });
const mind = () => ({
  async round(input: RoundInput) {
    requests.push(input);
    const msg = [...input.fresh].reverse().find((x) => x.kind === "message");
    if (msg?.kind === "message" && msg.text === "hold-old-round") { started(); await barrier; }
    const actions: MindAction[] = msg?.kind === "message" && msg.text === "remember-marker" ? [{ kind: "remember", roomId: msg.roomId, sourceSeq: msg.seq, title: "持久记忆", text: "KEEP_REAL_MEMORY", anchors: [`room:${msg.roomId}`], quote: null, relation: null, target: null }] : [];
    return { actions, stateNote: null };
  },
});
let host = new Host({ file, dataDir: root, mind, maxDeferMs: 1 });
async function settle() {
  for (let n = 0; n < 200; n++) {
    await host.idle();
    await new Promise<void>((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主未在界限内空闲");
}
try {
  let svc = createService(host);
  const created = await svc.handle("contacts.create", { clientActionId: "create", name: "配置历史验收", persona: "PERSONA_OLD" });
  assert.ok(created.ok); const c = created.value as ContactView;
  const room = host.createGroup("配置回滚实跑", [{ kind: "contact", id: c.id }]);
  const send = async (text: string) => {
    const result = await svc.handle("messages.send", { roomId: room.id, clientActionId: text, text, mentions: [{ id: c.id, source: "manual" }] });
    assert.ok(result.ok);
  };
  await send("remember-marker"); await settle();
  assert.equal(host.listMemories(c.id).at(-1)?.body, "KEEP_REAL_MEMORY");
  await send("hold-old-round"); await began;
  const inFlight = requests.at(-1)!;
  assert.equal(inFlight.contact.persona, "PERSONA_OLD");
  const updated = await svc.handle("contacts.update", { contactId: c.id, expectedVersion: 1, clientActionId: "change", persona: "PERSONA_NEW" });
  assert.ok(updated.ok);
  assert.equal(inFlight.contact.persona, "PERSONA_OLD", "在途轮次保留冻结配置");
  release(); await settle();
  await send("after-change"); await settle();
  assert.equal(requests.at(-1)!.contact.persona, "PERSONA_NEW");
  const task = await svc.handle("tasks.create", { roomId: room.id, clientActionId: "real-task", title: "不得被回滚的真实任务" });
  assert.ok(task.ok); const taskId = (task.value as TaskView).id; await settle();
  const memDir = path.join(root, "memory", c.id);
  const memoryBytes = () => readdirSync(memDir).sort().map((n) => [n, readFileSync(path.join(memDir, n), "utf8")]);
  const before = { task: host.taskDoc(taskId), memories: host.listMemories(c.id), memoryFiles: memoryBytes(), events: all(host.db, "SELECT * FROM events"), cursors: all(host.db, "SELECT * FROM gg_cursor") };
  const rollback = { contactId: c.id, version: 1, expectedVersion: 2, clientActionId: "rollback" };
  const restored = await svc.handle("contacts.rollback", rollback); assert.ok(restored.ok);
  assert.deepEqual(restored.value, { contact: host.contactView(host.contactDoc(c.id).value), version: 3 });
  assert.equal(host.contactDoc(c.id).value.persona, "PERSONA_OLD");
  assert.deepEqual({ task: host.taskDoc(taskId), memories: host.listMemories(c.id), memoryFiles: memoryBytes(), events: all(host.db, "SELECT * FROM events"), cursors: all(host.db, "SELECT * FROM gg_cursor") }, before);
  const history = await svc.handle("contacts.history", { contactId: c.id }); assert.ok(history.ok);
  const versions = (history.value as { versions: ContactConfigVersion[] }).versions;
  assert.deepEqual(versions.map((v) => [v.version, v.kind, v.restoredFrom]), [[3, "rollback", 1], [2, "update", null], [1, "create", null]]);
  assert.ok(versions.every((v) => !("id" in v.config) && !("memory" in v.config) && !("createdAt" in v.config)));
  await host.close(); host = new Host({ file, dataDir: root, mind, maxDeferMs: 1 }); svc = createService(host);
  const replay = await svc.handle("contacts.rollback", rollback); assert.deepEqual(replay, restored);
  assert.equal(host.contactDoc(c.id).ver, 3); assert.deepEqual(memoryBytes(), before.memoryFiles);
  const stale = await svc.handle("contacts.rollback", { ...rollback, clientActionId: "stale" });
  assert.equal(!stale.ok && stale.error.code, "conflict");
  await send("after-rollback"); await settle();
  assert.equal(requests.at(-1)!.contact.persona, "PERSONA_OLD");
  console.log(JSON.stringify({ contactId: c.id, versions: versions.map((v) => [v.version, v.kind, v.restoredFrom]), inFlight: "PERSONA_OLD", nextRoundAfterUpdate: "PERSONA_NEW", nextRoundAfterRollback: "PERSONA_OLD", realTaskPreserved: taskId, memoryMdAndIndex: "unchanged", messageLogAndCursorOnRollback: "unchanged", restartReplay: "same result/version", stale: "conflict" }, null, 2));
} finally { release(); await host.close(); rmSync(root, { recursive: true, force: true }); }
console.log("PASS:真实Host/SQLite/service,scripted脑子仅用于确定性配置时序与记忆写入;未调用真实模型,未测桌面用户操作。");
