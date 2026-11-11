// G1-03：复用现有 Messages SSE 夹具形状；结束原因为 max_tokens 时，非空甚至完整 JSON 也不能冒充完成。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiCompactor } from "./compact.ts";
import { PiContactMindError } from "./mind.ts";
const MODEL = "fixture-model";
function endpoint(response: { text: string; stop: "end_turn" | "max_tokens" }) {
  const enc = new TextEncoder();
  const event = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(event("message_start", { message: { id: "neutral", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
    c.enqueue(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    c.enqueue(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: response.text } }));
    c.enqueue(event("content_block_stop", { index: 0 }));
    c.enqueue(event("message_delta", { delta: { stop_reason: response.stop, stop_sequence: null }, usage: { output_tokens: 5 } }));
    c.enqueue(event("message_stop", {})); c.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  return fetch;
}
const request = () => ({ contact: { id: "c", name: "联系人", speakingModel: MODEL, persona: "只记可核验事实" }, kind: "round-note" as const, previous: "有效旧笔记", material: "NEUTRAL_FIXTURE_NO_CREDENTIALS", maxBytes: null });
const incomplete = (e: unknown) => e instanceof PiContactMindError && e.code === "provider-error" && /length|截断/.test(e.message);
test("G1-03a compact 截断不得返回成功笔记", async () => {
  const response = { text: "有效笔记", stop: "end_turn" as "end_turn" | "max_tokens" };
  const c = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "https://fixture.invalid", apiKey: "NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: endpoint(response) });
  assert.equal(await c.compact(request(), new AbortController().signal), "有效笔记");
  response.text = "半截笔记"; response.stop = "max_tokens";
  await assert.rejects(c.compact(request(), new AbortController().signal), incomplete);
});
test("G1-03b reflect 截断JSON不得当成功零结果", async () => {
  const response = { text: JSON.stringify({ note: null, memories: [], personaSuggestion: null }), stop: "end_turn" as "end_turn" | "max_tokens" };
  const c = createPiCompactor({ provider: "fixture", model: MODEL, baseUrl: "https://fixture.invalid", apiKey: "NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: endpoint(response) });
  const input = { ...request(), neighbors: [], noteWritten: null, sources: [] };
  assert.deepEqual(await c.reflect!(input, new AbortController().signal), { note: null, memories: [], personaSuggestion: null });
  response.stop = "max_tokens";
  await assert.rejects(c.reflect!(input, new AbortController().signal), incomplete);
});
