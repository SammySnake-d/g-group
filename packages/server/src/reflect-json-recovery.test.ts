// D23.3 / D25.12:真实 pi 压缩适配器接宿主;仅用进程内假流,验证格式失败与原文保留。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPiCompactor } from "@g-group/adapter-pi-contact";
import type { RoundInput } from "@g-group/kernel";
import { Host } from "./host.ts";

const MODEL = "fixture-fengshao-model";
const KEY = "fixture-key";
type Seen = { model: string; system?: { type: string; text: string }[]; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
function provider(responses: string[]) {
  const seen: Seen[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push(JSON.parse(await req.text()) as Seen);
    const text = responses[seen.length - 1];
    if (text === undefined) throw new Error(`意外的额外模型调用 ${seen.length}`);
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg-${seen.length}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
        c.enqueue(sse("content_block_stop", { index: 0 }));
        c.enqueue(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
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
function setup(responses: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-reflect-json-"));
  const fake = provider(responses);
  const reports: [string, unknown][] = [];
  const requests: RoundInput["request"][] = [];
  const compactor = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: fake.fetch });
  const host = new Host({
    file: path.join(dir, "gg.db"), dataDir: dir, maxDeferMs: 5,
    onReport: (what, detail) => reports.push([what, detail]),
    mind: () => ({ async round(i: RoundInput) { requests.push(i.request); return { actions: [], stateNote: null }; } }),
    compactor: () => compactor,
  });
  const c = host.createContact({ name: "联系人", speakingModel: MODEL });
  const dm = host.openDm(c.id);
  return { dir, fake, reports, requests, host, c, dm };
}
const valid = JSON.stringify({ note: "第二轮检查笔记", memories: [], personaSuggestion: null });

test("reflect 返回不可解析 JSON 后宿主告警、同模型普通压缩兜底,下一轮反思能恢复", async () => {
  const x = setup(["不是 JSON 对象", "首轮压缩保留方向", valid]);
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
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});

test("反思 JSON 持续无效且补压缩也失败时下一轮保留上轮未经压缩的原文", async () => {
  const x = setup(["不是 JSON 对象", " ", "依然不是 JSON", " "]);
  try {
    x.host.send({ roomId: x.dm.id, clientActionId: "1", text: "持久原文标记:安全发布之前必须先做审查" });
    await settle(x.host);
    assert.ok(x.reports.some(([w]) => w === "reflect-failed"));
    assert.ok(x.reports.some(([w]) => w === "compact-failed"));
    x.host.send({ roomId: x.dm.id, clientActionId: "2", text: "第二轮请继续" });
    await settle(x.host);
    assert.equal(x.fake.seen.length, 4);
    assert.equal(x.reports.filter(([w]) => w === "reflect-failed").length, 2);
    assert.equal(x.reports.filter(([w]) => w === "compact-failed").length, 2);
    assert.ok(x.fake.seen.every((r) => r.model === MODEL));
    const next = x.requests[1]!.blocks.map((b) => b.text).join("\n");
    assert.match(next, /持久原文标记:安全发布之前必须先做审查/, "未生成可用笔记时,下一轮仍须带上未经压缩原文");
  } finally { await x.host.close(); rmSync(x.dir, { recursive: true, force: true }); }
});
