import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ComputeProgress, MessageView, ReceiptView, SearchHit } from "@g-group/api-contract";
import { putDoc, run } from "./db.ts";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });
const AT0 = "2026-11-18T01:00:00.000Z";
const AT1 = "2026-11-18T02:00:00.000Z";
const AT2 = "2026-11-18T03:00:00.000Z";
function scene(H: typeof Host, replies = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "b3-polish-"));
  let time = AT0;
  const host = new H({ file: path.join(dir, "sqlite"), now: () => time, maxDeferMs: 1, mind: () => replies ? scriptedMind() : { async round() { return { actions: [], stateNote: null }; } } });
  cleanup.push(async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); });
  const contact = host.createContact({ name: "contact" });
  const dm = host.openDm(contact.id);
  return { host, contact, dm, at: (t: string) => { time = t; } };
}
async function call<T>(svc: ReturnType<typeof createService>, method: string, input: unknown): Promise<T> {
  const r = await svc.handle(method, input);
  assert.ok(r.ok, r.ok ? method : `${method}: ${r.error.message}`);
  return r.value as T;
}
const progress = (h: Host, taskId: string, summary: string, at: string) => run(h.db, "INSERT INTO gg_progress (task_id, compute_id, kind, summary, at) VALUES (?, 'cp-fixture', 'completed', ?, ?)", taskId, summary, at);

test("B301 tasks.progress filters strictly after afterAt before applying the requested limit", async () => {
  const { host, dm } = scene(Host);
  const svc = createService(host);
  const task = host.createTask({ roomId: dm.id, title: "fixture", clientActionId: "task" });
  progress(host, task.id, "equal", AT1);
  progress(host, task.id, "new", AT2);
  progress(host, task.id, "older inserted last", AT0);
  const all = await call<{ progress: ComputeProgress[] }>(svc, "tasks.progress", { taskId: task.id });
  assert.deepEqual(all.progress.map((p) => p.summary), ["equal", "new", "older inserted last"]);
  const filtered = await call<{ progress: ComputeProgress[] }>(svc, "tasks.progress", { taskId: task.id, afterAt: AT1, limit: 2 });
  assert.deepEqual(filtered.progress.map((p) => [p.at, p.summary]), [[AT2, "new"]]);
  const noMore = await call<{ progress: ComputeProgress[] }>(svc, "tasks.progress", { taskId: task.id, afterAt: AT2 });
  assert.deepEqual(noMore.progress, []);
});

test("B302 committed visible contact reply emits thinking then replying in its room then idle", async () => {
  const { host, dm, contact } = scene(Host, true);
  const activity: unknown[] = [];
  const off = host.bus.subscribe((e) => { if (e.type === "contact.activity" && e.contactId === contact.id) activity.push([e.activity, e.roomId]); });
  try {
    host.send({ roomId: dm.id, clientActionId: "chat", text: "你好" });
    for (let i = 0; i < 200 && activity.length < 3; ++i) {
      await host.idle();
      if (host.listMessages(dm.id, {}).messages.some((m) => m.sender.id === contact.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(host.listMessages(dm.id, {}).messages.some((m) => m.sender.id === contact.id && m.text.includes("你好")));
    assert.deepEqual(activity, [["thinking", dm.id], ["replying", dm.id], ["idle", null]]);
  } finally { off(); }
});

test("B303 search indexes honest system disclosures but not the withdrawn original or echoed private text", async () => {
  const { host, dm } = scene(Host);
  const svc = createService(host);
  const source = host.send({ roomId: dm.id, clientActionId: "source", text: "WITHDRAWN_ORIGINAL" });
  const t = host.createTask({ roomId: dm.id, title: "fixture", clientActionId: "task" });
  const doc = host.taskDoc(t.id);
  putDoc(host.db, `task:${t.id}`, doc.ver, { ...doc.value, sourceSeq: source.seq });
  progress(host, t.id, "SAFE_LEDGER_FACT", AT0);
  progress(host, t.id, "echo: WITHDRAWN_ORIGINAL", AT0);
  assert.deepEqual((await call<{ hits: SearchHit[] }>(svc, "search.messages", { roomId: dm.id, query: "WITHDRAWN_ORIGINAL" })).hits.map((x) => x.seq), [source.seq]);
  await call(svc, "messages.retract", { roomId: dm.id, seq: source.seq });
  assert.deepEqual((await call<{ hits: SearchHit[] }>(svc, "search.messages", { roomId: dm.id, query: "WITHDRAWN_ORIGINAL" })).hits, []);
  const messages = host.listMessages(dm.id, {}).messages;
  const hit = (await call<{ hits: SearchHit[] }>(svc, "search.messages", { roomId: dm.id, query: "SAFE_LEDGER_FACT" })).hits;
  assert.equal(hit.length, 1);
  assert.equal(messages.find((m) => m.seq === hit[0]!.seq)?.sender.kind, "system");
  assert.equal(messages.filter((m) => m.sender.kind === "system" && m.text.includes("副作用")).length, 2);
  assert.doesNotMatch(JSON.stringify(messages), /WITHDRAWN_ORIGINAL/);
});

test("B304 forward and disclosure receipts use destination audience; rooms.markRead updates the user once", async () => {
  const { host, dm, contact, at } = scene(Host);
  const svc = createService(host);
  const dest = host.createGroup("destination", [{ kind: "contact", id: contact.id }]);
  const src = host.send({ roomId: dm.id, clientActionId: "source", text: "source" });
  const copy = await call<MessageView>(svc, "messages.forward", { fromRoomId: dm.id, toRoomId: dest.id, seqs: [src.seq], clientActionId: "copy" });
  const receipt = (roomId: string, seq: number) => call<ReceiptView>(svc, "messages.receipts", { roomId, seq });
  assert.deepEqual((await receipt(dest.id, copy.seq)).unread, [{ member: { kind: "contact", id: contact.id }, mentioned: false }]);
  const t = host.createTask({ roomId: dest.id, title: "fixture", clientActionId: "task" });
  const doc = host.taskDoc(t.id);
  putDoc(host.db, `task:${t.id}`, doc.ver, { ...doc.value, sourceSeq: copy.seq });
  progress(host, t.id, "receipt ledger outcome", AT0);
  await call(svc, "messages.retract", { roomId: dest.id, seq: copy.seq });
  const notice = host.listMessages(dest.id, {}).messages.find((m) => m.sender.kind === "system" && m.text.includes("receipt ledger outcome"));
  assert.ok(notice);
  const before = await receipt(dest.id, notice.seq);
  assert.ok(before.unread.some((r) => r.member.id === host.userId && !r.mentioned));
  at(AT1);
  await call(svc, "rooms.markRead", { roomId: dest.id, seq: notice.seq });
  at(AT2);
  await call(svc, "rooms.markRead", { roomId: dest.id, seq: notice.seq });
  const after = await receipt(dest.id, notice.seq);
  assert.deepEqual(after.read.filter((r) => r.member.kind === "user"), [{ at: AT1, member: { kind: "user", id: host.userId }, mentioned: false }]);
  assert.ok(!after.unread.some((r) => r.member.kind === "user"));
  assert.ok([...(await receipt(dest.id, copy.seq)).read, ...(await receipt(dest.id, copy.seq)).unread].every((r) => r.member.kind !== "user"));
});
