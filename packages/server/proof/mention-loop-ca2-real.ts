// 真实 service/Host/SQLite/注意循环入口；脑子为有限scripted夹具，不是模型质量/UI/正式产品参数验收。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";
const dir = mkdtempSync(path.join(os.tmpdir(), "gg-loop-ca2-service-"));
const file = path.join(dir, "gg.db");
let calls = 0;
const mind = (): ContactMind => ({ async round(input) {
  const fresh = input.fresh.filter((f) => f.kind === "message" && f.sender.kind !== "system").at(-1);
  const actions: MindAction[] = [];
  if (fresh?.kind === "message" && ++calls <= 40) actions.push({ kind: "reply", roomId: fresh.roomId, text: `service自动讨论 ${calls}`, replyToSeq: null, everyone: true });
  return { actions, stateNote: null };
} });
const options = { file, dataDir: dir, mind, maxDeferMs: 2, loopGuard: { maxHops: 2 } };
let host = new Host(options);
let service = createService(host);
async function settle() {
  for (let n = 0; n < 300; n++) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 10))]);
    if (!host.loop.busy()) return;
  }
  assert.fail("service 自动讨论未在有限窗口停止");
}
try {
  const a = await service.handle("contacts.create", { clientActionId: "service-contact-a", name: "service甲" });
  const b = await service.handle("contacts.create", { clientActionId: "service-contact-b", name: "service乙" });
  assert.ok(a.ok && b.ok);
  const aid = (a.value as { id: string }).id; const bid = (b.value as { id: string }).id;
  const made = await service.handle("rooms.createGroup", { clientActionId: "service-group", title: "service防回环", members: [{ kind: "contact", id: aid }, { kind: "contact", id: bid }] });
  assert.ok(made.ok); const roomId = (made.value as { id: string }).id;
  const first = await service.handle("messages.send", { roomId, clientActionId: "service-start", text: "用户开始", mentions: [{ id: aid, source: "manual" }] });
  assert.ok(first.ok); await settle();
  const before = calls; const pending = host.loopGuard.pending();
  assert.ok(before >= 2 && before <= 4); assert.ok(pending.length > 0);
  const view = await service.handle("messages.list", { roomId });
  assert.ok(view.ok);
  const messages = (view.value as { messages: { sender: { kind: string; id: string }; mentions: { id: string }[]; text: string }[] }).messages;
  assert.equal(messages.filter((m) => m.sender.kind === "system").length, 1);
  for (const m of messages.filter((m) => m.sender.kind === "contact")) assert.deepEqual(m.mentions.map((x) => x.id).sort(), [host.userId, m.sender.id === aid ? bid : aid].sort());
  await host.close(); host = new Host(options); service = createService(host); await settle();
  assert.equal(calls, before); assert.deepEqual(host.loopGuard.pending(), pending);
  const resumed = await service.handle("messages.send", { roomId, clientActionId: "service-resume", text: "用户继续" });
  assert.ok(resumed.ok); await settle();
  assert.ok(calls > before && calls <= before + 4);
  assert.equal(host.listMessages(roomId, {}).messages.filter((m) => m.sender.kind === "system").length, 2);
  console.log(JSON.stringify({ actual_service: true, scripted_mind_not_real_model: true, configured_hops: 2, default_hops_4_candidate_only: true, initial_rounds: before, rounds_after_user_continue: calls, pending_before_restart: pending.length, restart_extra_rounds: 0, everyone_preserved: true, stop_notice_per_root: 1, passed: true }));
} finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
