// G5 pi 适配器:粗筛标记并进原来那一次检查(不新增调用),精筛只用联系人说话模型、结果必须指回来源、截断不算完成。复用 Messages SSE 夹具形状。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiCompactor } from "./compact.ts";
import { PiContactMindError } from "./mind.ts";

const MODEL = "fixture-model";
function endpoint(response: { text: string; stop: "end_turn" | "max_tokens" }, bodies: string[]) {
  const enc = new TextEncoder();
  const event = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(event("message_start", { message: { id: "neutral", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
      c.enqueue(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      c.enqueue(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: response.text } }));
      c.enqueue(event("content_block_stop", { index: 0 }));
      c.enqueue(event("message_delta", { delta: { stop_reason: response.stop, stop_sequence: null }, usage: { output_tokens: 5 } }));
      c.enqueue(event("message_stop", {}));
      c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  return fetch;
}
const source = { roomId: "r1", seq: 2, revision: 2, senderKind: "user" as const, senderId: "u", text: "缓存方案定为 Redis", verifiedOutcome: false };
const refineRequest = (speakingModel = MODEL) => ({ contact: { id: "c", name: "联系人", speakingModel, persona: "只记可核验事实" }, items: [{ markId: "m1", kind: "decision" as const, evidence: "缓存方案定为 Redis", source, context: "#1 我:NEUTRAL_FIXTURE_NO_CREDENTIALS" }], neighbors: [], hint: null });
const memory = { title: "缓存", text: "缓存方案定为 Redis", anchors: ["room:r1"], relation: null, target: null, roomId: "r1", sourceSeq: 2, evidence: "缓存方案定为 Redis", kind: "decision" };

test("G5-AD1 精筛只用说话模型 结果必须指回来源 截断不算完成", async () => {
  const bodies: string[] = [];
  const response = { text: JSON.stringify({ memories: [memory] }), stop: "end_turn" as "end_turn" | "max_tokens" };
  const c = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "https://fixture.invalid", apiKey: "NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: endpoint(response, bodies) });
  const ok = await c.refine!(refineRequest(), new AbortController().signal);
  assert.deepEqual(ok.memories.map((m) => [m.roomId, m.sourceSeq, m.evidence]), [["r1", 2, "缓存方案定为 Redis"]]);
  assert.match(bodies[0]!, /缓存方案定为 Redis/);
  await assert.rejects(c.refine!(refineRequest("other-model"), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && e.code === "model-mismatch");
  assert.equal(bodies.length, 1, "模型不一致一次都不发");
  response.text = JSON.stringify({ memories: [{ ...memory, sourceSeq: undefined }] });
  await assert.rejects(c.refine!(refineRequest(), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && /指回|sourceSeq|roomId/.test(e.message));
  response.text = JSON.stringify({ memories: [memory] });
  response.stop = "max_tokens";
  await assert.rejects(c.refine!(refineRequest(), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && /length/.test(e.message));
});

test("G5-AD2 粗筛标记并进原来那一次检查 不另增调用", async () => {
  const bodies: string[] = [];
  const marks = [{ roomId: "r1", seq: 2, kind: "decision", evidence: "缓存方案定为 Redis" }, { roomId: "r1", seq: 2, kind: "unsure", evidence: "可能周五发" }];
  const c = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "https://fixture.invalid", apiKey: "NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: endpoint({ text: JSON.stringify({ note: null, memories: [], personaSuggestion: null, marks }), stop: "end_turn" }, bodies) });
  const input = { contact: { id: "c", name: "联系人", speakingModel: MODEL, persona: "" }, kind: "round-note" as const, previous: null, material: "NEUTRAL_FIXTURE_NO_CREDENTIALS", maxBytes: null, neighbors: [], noteWritten: "已写", sources: [source] };
  const r = await c.reflect!(input, new AbortController().signal);
  assert.deepEqual(r.marks?.map((m) => m.evidence), ["缓存方案定为 Redis", "可能周五发"], "一条消息两项都留着");
  assert.equal(bodies.length, 1, "粗筛不新增调用");
  assert.match(bodies[0]!, /marks/, "检查提示要求同一次给出待精筛标记");
});
