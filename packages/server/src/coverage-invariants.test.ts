// Q02：独立服务级回归断言；最终不改生产代码。脑子/Compute 是现成的确定性替身，Host/SQLite/service 是真实边界。
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import path from "node:path";
import type { ComputeProgress, ContactView, MessageView, RoomView, TaskView } from "@g-group/api-contract";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { cleanupKit, closeKitHosts, setup } from "./test-kit.ts";

afterEach(() => closeKitHosts());
after(() => cleanupKit());
const value = <T>(r: { ok: boolean; value?: unknown; error?: unknown }): T => { assert.ok(r.ok, JSON.stringify(r)); return r.value as T; };
async function settle(host: Host, compute?: ReturnType<typeof scriptedCompute>) {
  for (let i = 0; i < 200; i++) {
    await host.idle(); await new Promise(r => setTimeout(r, 5));
    if (!host.loop.busy() && (!compute || compute.drained())) { await host.idle(); return; }
  }
  throw new Error("宿主未静止");
}
function mind(script: (i: RoundInput) => MindAction[], seen: RoundInput[] = []): () => ContactMind {
  return () => ({ async round(i) { seen.push(i); return { actions: script(i), stateNote: null }; } });
}
const messages = (h: Host, roomId: string) => h.listMessages(roomId, {}).messages;
const stableMemory = (h: Host, id: string) => h.listMemories(id).map(m => ({ id: m.id, body: m.body, anchors: m.anchors, status: m.status, version: m.version, source: m.source }));
const CATALOG = [
  { id: "claude-opus-5-5", label: "Opus", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "claude-sonnet-5-5", label: "Sonnet", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "gpt-6-astra", label: "Astra", vendor: "openai", harnesses: ["codex" as const] },
];

test("Q02 身份记忆:头像/换harness/重启不换身份，同名新建记忆隔离", async () => {
  const seen: RoundInput[] = [];
  const factory = mind(i => i.fresh.flatMap(f => f.kind === "message" && f.text === "记住核对暗号" ? [{ kind: "remember" as const, roomId: f.roomId, sourceSeq: f.seq, title: "核对暗号", text: "记忆暗号-identity-proof", anchors: [`room:${f.roomId}`], quote: null, relation: null, target: null }] : []), seen);
  const s = setup({ mind: factory }); let h = s.host; let svc = s.svc;
  h.updateSettings({ defaultHarness: "claude-code", defaultSpeakingModel: "claude-sonnet-5-5", defaultComputeModel: "claude-opus-5-5", models: CATALOG });
  const c = value<ContactView>(await svc.handle("contacts.create", { clientActionId: "create", name: "同名联系人", persona: "身份原文-identity-proof" }));
  const dm = value<RoomView>(await svc.handle("rooms.openDm", { contactId: c.id }));
  const send = async (action: string, text: string) => { value<MessageView>(await svc.handle("messages.send", { roomId: dm.id, clientActionId: action, text })); await settle(h); };
  const check = () => {
    const req = seen.filter(i => i.contact.id === c.id).at(-1)!.request;
    assert.ok(req.blocks[0]!.text.includes(`联系人 id ${c.id}`) && req.blocks[0]!.text.includes("身份原文-identity-proof"), req.blocks[0]!.text);
    assert.ok(req.blocks[4]!.text.includes("记忆暗号-identity-proof"), req.blocks[4]!.text);
  };
  await send("remember", "记住核对暗号"); const memory = stableMemory(h, c.id); assert.equal(memory.length, 1);
  await send("recall", "核对暗号是什么"); check();
  const avatar = value<ContactView>(await svc.handle("contacts.update", { contactId: c.id, avatar: "data:image/png;base64,QUJD" }));
  assert.deepEqual([avatar.id, avatar.createdAt], [c.id, c.createdAt]); await send("avatar", "核对暗号仍是什么"); check(); assert.deepEqual(stableMemory(h, c.id), memory);
  const switched = value<ContactView>(await svc.handle("contacts.update", { contactId: c.id, harness: "codex", computeModel: { mode: "explicit", model: "gpt-6-astra" } }));
  assert.deepEqual([switched.id, switched.createdAt, switched.harness], [c.id, c.createdAt, "codex"]); await send("harness", "核对暗号与身份"); check(); assert.deepEqual(stableMemory(h, c.id), memory);
  await h.close(); h = new Host({ file: path.join(s.root, "gg.db"), dataDir: path.join(s.root, "data"), mind: factory, maxDeferMs: 5 }); svc = createService(h);
  try {
    const reopened = value<ContactView>(await svc.handle("contacts.get", { contactId: c.id }));
    assert.deepEqual([reopened.id, reopened.createdAt, reopened.harness, reopened.avatar], [c.id, c.createdAt, "codex", avatar.avatar]);
    await send("restart", "核对暗号重启后"); check(); assert.deepEqual(stableMemory(h, c.id), memory);
    const other = value<ContactView>(await svc.handle("contacts.create", { clientActionId: "same-name", name: c.name }));
    assert.notEqual(other.id, c.id); assert.deepEqual(h.listMemories(other.id), []); assert.deepEqual(stableMemory(h, c.id), memory);
    assert.equal(h.contactDoc(c.id).value.persona, "身份原文-identity-proof");
  } finally { await h.close(); }
});

async function runningKit(blocked = false) {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "q02-run", resumed: false }, ...(blocked ? [{ kind: "blocked" as const, needs: "请告诉我页面图形验证码", summary: "等待人工输入" }] : [])] });
  const seen: RoundInput[] = [];
  let owner = "";
  const s = setup({ mind: mind(i => i.contact.id === owner ? i.fresh.flatMap(f => f.kind === "message" && f.text === "唯一派活请求" ? [{ kind: "dispatch" as const, roomId: f.roomId, sourceSeq: f.seq, title: "Q02真实任务", task: "核对服务边界" }] : []) : [], seen), compute: () => compute.adapter });
  const c = value<ContactView>(await s.svc.handle("contacts.create", { clientActionId: "c", name: "执行者" })); owner = c.id;
  const c2 = value<ContactView>(await s.svc.handle("contacts.create", { clientActionId: "c2", name: "旁听者" }));
  const room = value<RoomView>(await s.svc.handle("rooms.createGroup", { clientActionId: "room", title: "Q02验证", members: [{ kind: "contact", id: c.id }, { kind: "contact", id: c2.id }] }));
  return { ...s, compute, seen, c, c2, room };
}
async function start(s: Awaited<ReturnType<typeof runningKit>>) {
  value<MessageView>(await s.svc.handle("messages.send", { roomId: s.room.id, clientActionId: "task", text: "唯一派活请求", mentions: [{ id: s.c.id, source: "manual" }] }));
  await settle(s.host, s.compute);
  const list = value<{ tasks: TaskView[] }>(await s.svc.handle("tasks.list", { roomId: s.room.id })); assert.equal(list.tasks.length, 1); return list.tasks[0]!;
}

test("Q02 群普通消息:每位联系人收到，但无任务及在途阶段均不直达Compute", async () => {
  const s = await runningKit(); const svc = createService(s.host);
  try {
    const m = value<MessageView>(await svc.handle("messages.send", { roomId: s.room.id, clientActionId: "ordinary-before", text: "普通群讨论-before" })); await settle(s.host, s.compute);
    for (const c of [s.c, s.c2]) assert.ok(s.seen.some(i => i.contact.id === c.id && i.fresh.some(f => f.kind === "message" && f.seq === m.seq)), c.id);
    assert.deepEqual([s.compute.spawned.length, s.compute.resumed.length], [0, 0]);
    await start(s); assert.equal(s.compute.spawned.length, 1);
    const next = value<MessageView>(await svc.handle("messages.send", { roomId: s.room.id, clientActionId: "ordinary-after", text: "普通群讨论-after" })); await settle(s.host, s.compute);
    for (const c of [s.c, s.c2]) assert.ok(s.seen.some(i => i.contact.id === c.id && i.fresh.some(f => f.kind === "message" && f.seq === next.seq)), c.id);
    assert.deepEqual([s.compute.spawned.length, s.compute.resumed.length], [1, 0]);
  } finally { s.compute.close(); }
});

test("Q02 tasks.progress:真实事件同形查询，准确字段/限量顺序/重启与未知任务", async () => {
  const s = await runningKit(); const svc = createService(s.host); const events: ComputeProgress[] = [];
  const off = s.svc.subscribe(e => { if (e.type === "compute.progress") events.push(e.progress); });
  try {
    const task = await start(s); const computeId = s.compute.spawned[0]!.computeId;
    for (const [stage, summary] of [["scan", "唯一进度-扫描"], ["verify", "唯一进度-校验"]]) { s.compute.emit({ computeId, kind: "milestone", stage, summary }); await settle(s.host, s.compute); }
    const all = value<{ progress: ComputeProgress[] }>(await svc.handle("tasks.progress", { taskId: task.id, limit: 100 })).progress;
    assert.deepEqual(all, events); assert.equal(all.length, 3);
    assert.deepEqual(all.map(p => [p.taskId, p.computeId, p.kind, p.stage ?? null, p.summary]), [[task.id, computeId, "started", null, "已开始"], [task.id, computeId, "milestone", "scan", "唯一进度-扫描"], [task.id, computeId, "milestone", "verify", "唯一进度-校验"]]);
    assert.ok(all.every(p => Number.isFinite(Date.parse(p.at))));
    assert.deepEqual(value<{ progress: ComputeProgress[] }>(await svc.handle("tasks.progress", { taskId: task.id, limit: 1 })).progress, [all[2]]);
    const unknown = await svc.handle("tasks.progress", { taskId: "not-a-task" }); assert.equal(!unknown.ok && unknown.error.code, "not_found");
    off(); s.compute.close(); await s.host.close();
    const h = new Host({ file: path.join(s.root, "gg.db"), dataDir: path.join(s.root, "data") });
    try { assert.deepEqual(value<{ progress: ComputeProgress[] }>(await createService(h).handle("tasks.progress", { taskId: task.id, limit: 100 })).progress, all); } finally { await h.close(); }
  } finally { off(); s.compute.close(); }
});

test("Q02 无关插话:保留原T4b问题/版本/卡片与Compute，原问题仍可回答", async () => {
  const s = await runningKit(true); const svc = createService(s.host);
  try {
    const task = await start(s); assert.equal(task.state, "T4b_BlockedOnHuman");
    const card = messages(s.host, s.room.id).find(m => m.card?.kind === "question")!; assert.equal(card.card!.state, "open");
    value<MessageView>(await svc.handle("messages.send", { roomId: s.room.id, clientActionId: "unrelated", text: "周末天气如何，与验证码无关" })); await settle(s.host, s.compute);
    const after = value<TaskView>(await svc.handle("tasks.get", { taskId: task.id }));
    assert.deepEqual([after.state, after.pendingQuestion, after.constraintVersion, after.computeRuns], [task.state, task.pendingQuestion, task.constraintVersion, task.computeRuns]);
    const same = messages(s.host, s.room.id).find(m => m.seq === card.seq)!; assert.deepEqual([same.card!.cardId, same.card!.state], [card.card!.cardId, "open"]);
    assert.deepEqual([s.compute.spawned.length, s.compute.resumed.length], [1, 0]);
    const answered = value<TaskView>(await svc.handle("tasks.answer", { taskId: task.id, qId: task.pendingQuestion!.qId, clientActionId: "answer-original", answer: "7Q2K" }));
    assert.equal(answered.state, "T3_Running"); await settle(s.host, s.compute);
    assert.deepEqual(s.compute.resumed.map(r => r.computeId), [task.computeRuns[0]!.computeId]); assert.match(s.compute.resumed[0]!.text, /7Q2K/);
    assert.deepEqual([s.compute.spawned.length, messages(s.host, s.room.id).find(m => m.seq === card.seq)!.card!.state], [1, "done"]);
  } finally { s.compute.close(); }
});
