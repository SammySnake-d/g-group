// D23.3 / D25.12:真实 pi 压缩适配器接宿主;仅用进程内假流,验证格式失败与原文保留。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPiCompactor } from "@g-group/adapter-pi-contact";
import type { Inbound, RoundInput } from "@g-group/kernel";
import { getDoc } from "./db.ts";
import { Host } from "./host.ts";

const MODEL = "fixture-fengshao-model";
const KEY = "fixture-key";
type Seen = { model: string; system?: { type: string; text: string }[]; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
type FakeResponse = string | { text: string; stopReason: "end_turn" | "max_tokens" };
function provider(responses: FakeResponse[], gate?: (index: number) => Promise<void>) {
  const seen: Seen[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push(JSON.parse(await req.text()) as Seen);
    await gate?.(seen.length);
    const response = responses[seen.length - 1];
    if (response === undefined) throw new Error(`意外的额外模型调用 ${seen.length}`);
    const text = typeof response === "string" ? response : response.text;
    const stopReason = typeof response === "string" ? "end_turn" : response.stopReason;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg-${seen.length}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
        c.enqueue(sse("content_block_stop", { index: 0 }));
        c.enqueue(sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, seen };
}
const sys = (seen: Seen) => (seen.system ?? []).map((s) => s.text).join("\n");
const text = (seen: Seen) => seen.messages.map((m) => typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n")).join("\n");
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) { await new Promise((r) => setTimeout(r, 5)); if (!host.loop.busy()) return; }
  }
  throw new Error("宿主没有安静下来");
}
function setup(HostCtor: typeof Host, responses: FakeResponse[], reply = false, gate?: (i: RoundInput) => Promise<void>, providerGate?: (index: number) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-reflect-json-"));
  const fake = provider(responses, providerGate);
  const reports: [string, unknown][] = [];
  const requests: RoundInput["request"][] = [];
  const compactor = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: fake.fetch });
  const makeHost = () => new HostCtor({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    onReport: (what, detail) => reports.push([what, detail]),
    mind: () => ({ async round(i: RoundInput) {
      requests.push(i.request);
      await gate?.(i);
      const m = i.fresh.find((f) => f.kind === "message");
      const actions = reply && m?.kind === "message" ? [{ kind: "reply" as const, roomId: m.roomId, replyToSeq: m.seq, text: `回应:${m.text}` }] : [];
      return { actions, stateNote: null };
    } }),
    compactor: () => compactor,
  });
  const host = makeHost();
  const c = host.createContact({ name: "联系人", speakingModel: MODEL });
  const dm = host.openDm(c.id);
  return { dir, fake, reports, requests, host, c, dm, makeHost };
}
const valid = JSON.stringify({ note: "第二轮检查笔记", memories: [], personaSuggestion: null });
const validMemory = JSON.stringify({ note: "第二轮检查笔记", memories: [{ title: "发布要求", text: "发布前必须审查", anchors: ["global"], relation: null, target: null }], personaSuggestion: null });

test("reflect 返回不可解析 JSON 后宿主告警、同模型普通压缩兜底,下一轮反思能恢复", async () => {
  const x = setup(Host, ["不是 JSON 对象", "首轮压缩保留方向", valid, { text: valid.replace("第二轮检查笔记", "不完整笔记"), stopReason: "max_tokens" }, " "]);
  try {
    x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "第一轮:采用安全发布" });
    await settle(x.host);
    assert.equal(x.host.stateNote(x.c.id), "首轮压缩保留方向");
    assert.ok(x.reports.some(([w, d]) => w === "reflect-failed" && /找不到 JSON 对象/.test(JSON.stringify(d))));
    assert.equal(x.fake.seen.length, 2);
    assert.match(sys(x.fake.seen[0]!), /只输出一个 JSON 对象/);
    assert.match(sys(x.fake.seen[1]!), /只输出新的状态笔记正文/);
    assert.ok(x.fake.seen.every((r) => r.model === MODEL));
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "第二轮:确认" });
    await settle(x.host);
    assert.equal(x.fake.seen.length, 3);
    assert.match(sys(x.fake.seen[2]!), /只输出一个 JSON 对象/);
    assert.match(text(x.fake.seen[2]!), /首轮压缩保留方向/);
    assert.equal(x.host.stateNote(x.c.id), "第二轮检查笔记");
    x.host.send({ roomId: x.dm.id, clientActionId: "3", text: "截断反思时仍须保留的新输入" });
    await settle(x.host);
    assert.equal(x.host.stateNote(x.c.id), "第二轮检查笔记");
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /截断反思时仍须保留的新输入/);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("退出后重入同一群之前未触发其他轮次,旧待压缩消息不能复活", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", valid]);
  try {
    const group = x.host.createGroup("实验群", [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: group.id, clientActionId: "1", text: "群内原文-退出前", mentions: [{ id: x.c.id, source: "manual" }] });
    await settle(x.host);
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /群内原文-退出前/);
    x.host.removeMember(group.id, { kind: "contact", id: x.c.id });
    x.host.addMembers(group.id, [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "私聊继续" });
    await settle(x.host);
    assert.doesNotMatch(x.requests[1]!.blocks.map((b) => b.text).join("\n"), /群内原文-退出前/);
    assert.doesNotMatch(text(x.fake.seen[2]!), /群内原文-退出前/);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

const saved = (host: Host, contactId: string) => getDoc<{ inputs: Inbound[] }>(host.db, `note-pending:${contactId}`)?.value.inputs ?? [];

function holdSecond() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const finish = new Promise<void>((r) => { release = r; });
  let n = 0;
  return { started, release, gate: async (_i: RoundInput) => { if (++n === 2) { entered(); await finish; } } };
}

function holdFirst() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const finish = new Promise<void>((r) => { release = r; });
  let n = 0;
  return { started, release, gate: async (_i: RoundInput) => { if (++n === 1) { entered(); await finish; } } };
}

test("本轮主模型运行时撤回本轮新消息,反思不得继续接收其原文", { timeout: 10_000 }, async () => {
  const hold = holdFirst();
  const x = setup(Host, [valid, valid], false, hold.gate);
  try {
    const first = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "本轮撤回的新原文" });
    await hold.started;
    x.host.retractMessage(x.dm.id, first.seq);
    hold.release();
    await settle(x.host);
    assert.ok(x.fake.seen.length >= 1);
    for (const seen of x.fake.seen) assert.doesNotMatch(text(seen), /本轮撤回的新原文/);
  } finally { hold.release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("本轮反思运行时撤回本轮新消息,结果不落盘或进入下一轮", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const finish = new Promise<void>((r) => { release = r; });
  const poisoned = JSON.stringify({ note: "本轮撤回后不应落盘的结果", memories: [], personaSuggestion: null });
  const x = setup(Host, [poisoned, valid, valid], false, undefined, async (index) => { if (index === 1) { entered(); await finish; } });
  try {
    const first = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "本轮反思期间撤回" });
    await started;
    x.host.retractMessage(x.dm.id, first.seq);
    release();
    await settle(x.host);
    assert.doesNotMatch(x.host.stateNote(x.c.id) ?? "", /本轮撤回后不应落盘的结果/);
    for (const req of x.requests.slice(1)) assert.doesNotMatch(req.blocks.map((b) => b.text).join("\n"), /本轮撤回后不应落盘的结果/);
  } finally { release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("本轮主模型运行中被移出源群,不得把源群新消息送去后续反思", async () => {
  const hold = holdFirst();
  const x = setup(Host, [valid], true, hold.gate);
  try {
    const group = x.host.createGroup("实验群", [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: group.id, clientActionId: "1", text: "同轮移出群的原文", mentions: [{ id: x.c.id, source: "manual" }] });
    await hold.started;
    x.host.removeMember(group.id, { kind: "contact", id: x.c.id });
    hold.release();
    await settle(x.host);
    for (const seen of x.fake.seen) assert.doesNotMatch(text(seen), /同轮移出群的原文/);
    assert.equal(x.host.listMessages(group.id, {}).messages.filter((m) => m.sender.kind === "contact").length, 0);
  } finally { hold.release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("下一轮模型运行中撤回待压缩消息,反思与落盘不得再使用撤回原文", { timeout: 10_000 }, async () => {
  const hold = holdSecond();
  const x = setup(Host, ["不是 JSON 对象", " ", valid, valid], false, hold.gate);
  try {
    const first = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "运行中撤回原文标记" });
    await settle(x.host);
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /运行中撤回原文标记/);
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "让第二轮运行" });
    await hold.started;
    x.host.retractMessage(x.dm.id, first.seq);
    hold.release();
    await settle(x.host);
    assert.doesNotMatch(text(x.fake.seen[2]!), /运行中撤回原文标记/);
    assert.doesNotMatch(x.host.stateNote(x.c.id) ?? "", /运行中撤回原文标记/);
  } finally { hold.release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("反思调用进行中原文被撤回,丢弃旧反思结果且旧动作不重复提交", { timeout: 10_000 }, async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const finish = new Promise<void>((r) => { release = r; });
  const poisoned = JSON.stringify({ note: "撤回中旧反思结果标记", memories: [], personaSuggestion: null });
  const x = setup(Host, ["不是 JSON 对象", " ", poisoned, valid, valid], true, undefined, async (index) => { if (index === 3) { entered(); await finish; } });
  try {
    const first = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "反思期间撤回原文" });
    await settle(x.host);
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "第二轮" });
    await started;
    x.host.retractMessage(x.dm.id, first.seq);
    release();
    await settle(x.host);
    assert.doesNotMatch(x.host.stateNote(x.c.id) ?? "", /撤回中旧反思结果标记/);
    assert.equal(x.host.listMessages(x.dm.id, {}).messages.filter((m) => m.sender.kind === "contact" && m.text === "回应:第二轮").length, 1);
    assert.ok(x.reports.some(([w, d]) => w === "stale-round" && /检查期间/.test(JSON.stringify(d))));
  } finally { release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("下一轮模型运行中移出群,反思不得使用失权群的待压缩原文", { timeout: 10_000 }, async () => {
  const hold = holdSecond();
  const x = setup(Host, ["不是 JSON 对象", " ", valid], false, hold.gate);
  try {
    const group = x.host.createGroup("实验群", [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: group.id, clientActionId: "1", text: "运行中失权原文标记", mentions: [{ id: x.c.id, source: "manual" }] });
    await settle(x.host);
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /运行中失权原文标记/);
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "让第二轮运行" });
    await hold.started;
    x.host.removeMember(group.id, { kind: "contact", id: x.c.id });
    hold.release();
    await settle(x.host);
    assert.doesNotMatch(text(x.fake.seen[2]!), /运行中失权原文标记/);
    assert.doesNotMatch(x.host.stateNote(x.c.id) ?? "", /运行中失权原文标记/);
  } finally { hold.release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("同一批消息和撤回只送达撤回事件,不向联系人或反思传原文", { timeout: 10_000 }, async () => {
  const hold = holdSecond();
  const x = setup(Host, [valid, "不是 JSON", " "], false, hold.gate);
  try {
    x.host.send({ roomId: x.dm.id, clientActionId: "0", text: "启动占位轮" });
    await settle(x.host);
    x.host.send({ roomId: x.dm.id, clientActionId: "hold", text: "等待同批" });
    await hold.started;
    const first = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "同批撤回原文标记" });
    x.host.retractMessage(x.dm.id, first.seq);
    hold.release();
    await settle(x.host);
    assert.ok(x.requests.length >= 3);
    for (const req of x.requests.slice(2)) assert.doesNotMatch(req.blocks.map((b) => b.text).join("\n"), /同批撤回原文标记/);
    for (const seen of x.fake.seen.slice(1)) assert.doesNotMatch(text(seen), /同批撤回原文标记/);
    const pending = saved(x.host, x.c.id);
    assert.ok(pending.some((entry) => entry.kind === "message" && entry.replyToSeq === first.seq && /撤回了/.test(entry.text)));
    assert.doesNotMatch(JSON.stringify(pending), /同批撤回原文标记/);
  } finally { hold.release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("Compute 和定时输入失败后保留各自一次,不重置已消费事件或重复回复", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", valid], true);
  try {
    const at = new Date().toISOString();
    const inputs: Inbound[] = [
      { kind: "compute", roomId: x.dm.id, taskId: "task-fixture", computeId: "compute-fixture", signal: "completed", summary: "计算输入原文标记", at },
      { kind: "schedule", roomId: x.dm.id, scheduleId: "schedule-fixture", prompt: "定时输入原文标记", at },
    ];
    for (const i of inputs) x.host.db.store.db.prepare("INSERT INTO gg_inbox (contact_id, room_id, payload, at) VALUES (?, ?, ?, ?)").run(x.c.id, x.dm.id, JSON.stringify(i), at);
    await x.host.runRound(x.c.id, new AbortController().signal);
    const rows = x.host.db.store.db.prepare("SELECT consumed FROM gg_inbox WHERE contact_id = ? ORDER BY id").all(x.c.id) as { consumed: number }[];
    assert.deepEqual(rows.map((r) => r.consumed), [1, 1]);
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "下一轮" });
    await settle(x.host);
    const next = x.requests.at(-1)!.blocks.map((b) => b.text).join("\n");
    for (const marker of ["计算输入原文标记", "定时输入原文标记"]) assert.equal(next.split(marker).length - 1, 1, marker);
    assert.equal(x.host.listMessages(x.dm.id, {}).messages.filter((m) => m.sender.kind === "contact").length, 1);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("反思 JSON 持续无效且补压缩也失败时下一轮保留上轮未经压缩的原文", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", "依然不是 JSON", " ", valid, valid], true);
  try {
    x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "持久原文标记:安全发布之前必须先做审查" });
    await settle(x.host);
    assert.ok(x.reports.some(([w]) => w === "reflect-failed"));
    assert.ok(x.reports.some(([w]) => w === "compact-failed"));
    assert.equal(x.host.listMessages(x.dm.id, {}).messages.filter((m) => m.sender.kind === "contact").length, 1, "本轮动作只落盘一次");
    await x.host.close();
    x.host = x.makeHost();
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "第二轮请继续" });
    await settle(x.host);
    assert.equal(x.fake.seen.length, 4);
    assert.equal(x.reports.filter(([w]) => w === "reflect-failed").length, 2);
    assert.equal(x.reports.filter(([w]) => w === "compact-failed").length, 2);
    assert.ok(x.fake.seen.every((r) => r.model === MODEL));
    assert.equal(x.host.listMessages(x.dm.id, {}).messages.filter((m) => m.sender.kind === "contact").length, 2, "重启后旧输入没有重复执行动作");
    const next = x.requests[1]!.blocks.map((b) => b.text).join("\n");
    assert.match(next, /持久原文标记:安全发布之前必须先做审查/, "未生成可用笔记时,下一轮仍须带上未经压缩原文");
    assert.match(next, /回应:持久原文标记:安全发布之前必须先做审查/, "还须保留实际已发送的联系人回复,不能只留用户输入");
    x.host.send({ roomId: x.dm.id, clientActionId: "3", text: "第三轮恢复" });
    await settle(x.host);
    assert.match(text(x.fake.seen[4]!), /持久原文标记:安全发布之前必须先做审查/);
    assert.match(text(x.fake.seen[4]!), /第二轮请继续/);
    assert.equal(x.host.stateNote(x.c.id), "第二轮检查笔记");
    x.host.send({ roomId: x.dm.id, clientActionId: "4", text: "第四轮" });
    await settle(x.host);
    assert.doesNotMatch(x.requests[3]!.blocks.map((b) => b.text).join("\n"), /持久原文标记:安全发布之前必须先做审查/, "成功替换后不反复回送原文");
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("反思无效且补压缩被截断时,宿主不覆盖旧笔记并保留本轮原文给下一轮", async () => {
  const firstNote = JSON.stringify({ note: "已有完整旧笔记", memories: [], personaSuggestion: null });
  const x = setup(Host, [firstNote, "不是 JSON", { text: "误当完整的半份新笔记", stopReason: "max_tokens" }, valid]);
  try {
    x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "第一轮建立笔记" });
    await settle(x.host);
    assert.equal(x.host.stateNote(x.c.id), "已有完整旧笔记");
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "截断压缩必须保留的原文" });
    await settle(x.host);
    assert.equal(x.host.stateNote(x.c.id), "已有完整旧笔记", "不能以不完整结果覆盖旧笔记");
    assert.ok(x.reports.some(([w, d]) => w === "compact-failed" && /截断|length|max_tokens/.test(JSON.stringify(d))));
    x.host.send({ roomId: x.dm.id, clientActionId: "3", text: "第三轮" });
    await settle(x.host);
    const next = x.requests[2]!.blocks.map((b) => b.text).join("\n");
    assert.match(next, /已有完整旧笔记/);
    assert.match(next, /截断压缩必须保留的原文/);
    assert.ok(x.fake.seen.every((r) => r.model === MODEL));
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("未经压缩原文在撤回后不随回退上下文重新发给联系人", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", valid]);
  try {
    const m = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "删" });
    await settle(x.host);
    assert.ok(saved(x.host, x.c.id).some((input) => input.kind === "message" && input.seq === m.seq && input.text === "删"));
    x.host.retractMessage(x.dm.id, m.seq);
    await settle(x.host);
    const next = x.requests[1]!.blocks.map((b) => b.text).join("\n");
    assert.doesNotMatch(next, /\n删\n/, "即使很短,撤回原文也不能再次发出");
    assert.doesNotMatch(text(x.fake.seen[2]!), /\n删\n/);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("联系人移出群之后,该群待压缩原文不进入其私聊上下文", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", valid]);
  try {
    const group = x.host.createGroup("实验群", [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: group.id, clientActionId: "1", text: "群内专属原文标记", mentions: [{ id: x.c.id, source: "manual" }] });
    await settle(x.host);
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /群内专属原文标记/);
    x.host.removeMember(group.id, { kind: "contact", id: x.c.id });
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "私聊继续" });
    await settle(x.host);
    assert.doesNotMatch(x.requests[1]!.blocks.map((b) => b.text).join("\n"), /群内专属原文标记/);
    assert.doesNotMatch(text(x.fake.seen[2]!), /群内专属原文标记/);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("失权群的待压缩原文不能经私聊反思再产生全局记忆", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", validMemory]);
  try {
    const group = x.host.createGroup("实验群", [{ kind: "contact", id: x.c.id }]);
    x.host.send({ roomId: group.id, clientActionId: "1", text: "群内专属原文标记", mentions: [{ id: x.c.id, source: "manual" }] });
    await settle(x.host);
    assert.match(JSON.stringify(saved(x.host, x.c.id)), /群内专属原文标记/);
    x.host.removeMember(group.id, { kind: "contact", id: x.c.id });
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "私聊继续" });
    await settle(x.host);
    assert.doesNotMatch(text(x.fake.seen[2]!), /群内专属原文标记/);
    assert.doesNotMatch(x.host.stateNote(x.c.id) ?? "", /群内专属原文标记/);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("撤回后待压缩队列自身不持久保留撤回原文", async () => {
  const x = setup(Host, ["不是 JSON 对象", " ", "不是 JSON 对象", " "]);
  try {
    const m = x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "撤回后不得残留的原文标记" });
    await settle(x.host);
    x.host.retractMessage(x.dm.id, m.seq);
    await settle(x.host);
    const pending = x.host.db.store.db.prepare("SELECT value FROM docs WHERE key = ?").get(`note-pending:${x.c.id}`) as { value: string } | undefined;
    assert.ok(pending);
    assert.doesNotMatch(pending.value, /撤回后不得残留的原文标记/);
    const files = path.join(x.dir, "memory", x.c.id);
    if (existsSync(files)) assert.equal(readdirSync(files).length, 0);
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});


test("授权在失败反思期间撤回:不能将旧快照发给下一次普通压缩", { timeout: 10_000 }, async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const x = setup(Host, ["不是 JSON", valid, valid], true, undefined, async (index) => {
    if (index === 1) { entered(); await finish; }
  });
  try {
    const sent = x.host.send({ roomId: x.dm.id, clientActionId: "revoke-at-fallback", text: "失效后不可给普通压缩的文本" });
    await started;
    assert.equal(x.host.listMessages(x.dm.id, {}).messages.some((m) => m.text === "回应:失效后不可给普通压缩的文本"), true);
    x.host.retractMessage(x.dm.id, sent.seq);
    release();
    await settle(x.host);
    assert.equal(x.host.stateNote(x.c.id), "第二轮检查笔记");
    for (const seen of x.fake.seen.slice(1)) assert.doesNotMatch(text(seen), /失效后不可给普通压缩的文本/);
  } finally { release(); await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("大段失败上下文在主轮次退到带来源的有界摘录,原文仍持久化", async () => {
  const x = setup(Host, ["不是 JSON", " ", valid]);
  try {
    const source = `新纠正 ${"🙂".repeat(2200)} 结尾条件`;
    x.host.send({ roomId: x.dm.id, clientActionId: "big", text: source });
    await settle(x.host);
    assert.ok(saved(x.host, x.c.id).some((entry) => entry.kind === "message" && entry.text === source));
    x.host.send({ roomId: x.dm.id, clientActionId: "next", text: "继续按纠正执行" });
    await settle(x.host);
    const note = x.requests[1]!.blocks[2]!.text;
    assert.match(note, /Historical excerpts in chronological order/);
    assert.match(note, /新纠正[\s\S]*结尾条件/);
    assert.ok(Buffer.byteLength(note) < 6_200);
    assert.doesNotMatch(note, /\uFFFD/);
    assert.ok(text(x.fake.seen[2]!).includes(source), "同一说话模型的独立压缩仍收到完整材料");
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});
