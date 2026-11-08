// 状态笔记压缩器的 pi 实现(D06 第 2 小节第 3 块、D25 第 8 节;AC-32 ③「压缩复用该联系人的说话模型发起独立无状态调用」)。
// 用进程内 Anthropic Messages 兼容假端点(经 opts.fetch 注入),核对实际发出的请求体:单次请求、不带工具、不带联系人五块,
// 模型与联系人说话模型一致才发;端点报错如实抛出,不换模型重试。
import assert from "node:assert/strict";
import test from "node:test";
import { type CompactRequest, STATE_NOTE_GUIDE } from "@g-group/kernel";
import { createPiCompactor } from "./compact.ts";
import { PiContactMindError } from "./mind.ts";

const KEY = "sk-test-SECRET-c0mp4ct";
const MODEL = "test-model-1";
interface Body { model: string; system?: { type: string; text: string }[]; tools?: unknown[]; messages: { role: string; content: string | { type: string; text?: string }[] }[]; max_tokens: number }

function fake(reply: { text: string } | { status: number; error: unknown }) {
  const seen: { body: Body; headers: Headers }[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push({ body: JSON.parse(await req.text()) as Body, headers: req.headers });
    if ("status" in reply) return new Response(JSON.stringify(reply.error), { status: reply.status, headers: { "content-type": "application/json" } });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text } }));
        c.enqueue(sse("content_block_stop", { index: 0 }));
        c.enqueue(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetchFn, seen };
}
const req = (over: Partial<CompactRequest> = {}): CompactRequest => ({
  contact: { id: "c-1", name: "小克", speakingModel: MODEL, persona: "说话简短" },
  kind: "round-note",
  previous: "旧笔记:在做排序",
  material: "[本轮新输入(原文)]\n#3 · dm-1 · 我(user:me) · t\n改成按长度排\n[联系人本轮动作]\n- reply → dm-1 ↩#3:fig, kiwi, banana\n",
  maxBytes: 2000,
  ...over,
});
const textOf = (c: Body["messages"][number]["content"]) => (typeof c === "string" ? c : c.map((x) => x.text ?? "").join("\n"));

test("压缩器用联系人的说话模型发一次独立请求:不带工具,系统提示是笔记写法,用户消息只有旧笔记、本轮材料和上限;返回模型写的新笔记", async () => {
  const f = fake({ text: "1 在做什么:按长度排 kiwi, banana, fig(#3 改了 #1)" });
  const c = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, authHeader: "bearer", fetch: f.fetch });
  const out = await c.compact(req(), new AbortController().signal);
  assert.equal(out, "1 在做什么:按长度排 kiwi, banana, fig(#3 改了 #1)");
  assert.equal(f.seen.length, 1, "只发一次");
  const { body, headers } = f.seen[0]!;
  assert.equal(body.model, MODEL);
  assert.equal(body.tools, undefined, "不带工具");
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
  const sys = (body.system ?? []).map((s) => s.text).join("\n");
  assert.ok(sys.includes(STATE_NOTE_GUIDE), "系统提示含笔记写法");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]!.role, "user");
  const u = textOf(body.messages[0]!.content);
  assert.match(u, /旧笔记:在做排序/);
  assert.match(u, /改成按长度排/);
  assert.match(u, /fig, kiwi, banana/);
  assert.match(u, /不超过 2000 字节/);
  assert.doesNotMatch(u + sys, /说话简短/, "不带联系人人设与五块,是独立调用");
  const shrink = fake({ text: "缩写后的笔记" });
  const c2 = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: shrink.fetch });
  assert.equal(await c2.compact(req({ kind: "shrink", material: "", previous: "很长的旧笔记", maxBytes: null }), new AbortController().signal), "缩写后的笔记");
  const u2 = textOf(shrink.seen[0]!.body.messages[0]!.content);
  assert.match(u2, /很长的旧笔记/);
  assert.match(u2, /缩写/);
  assert.doesNotMatch(u2, /字节/, "不设上限时不写上限");
});

test("压缩器只用联系人的说话模型:请求里的说话模型与压缩器绑定的模型不一致时拒绝,一次请求都不发;端点报错如实抛出并隐去密钥", async () => {
  const f = fake({ text: "不该用到" });
  const c = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: f.fetch });
  await assert.rejects(c.compact(req({ contact: { id: "c-1", name: "小克", speakingModel: "other-model", persona: "" } }), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && e.code === "model-mismatch" && /other-model/.test(e.message));
  assert.equal(f.seen.length, 0);
  const bad = fake({ status: 500, error: { type: "error", error: { type: "api_error", message: `上游炸了 ${KEY}` } } });
  const c2 = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: bad.fetch });
  await assert.rejects(c2.compact(req(), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && e.code === "provider-error" && !e.message.includes(KEY));
  assert.equal(bad.seen.length >= 1, true);
  assert.equal(bad.seen.every((s) => s.body.model === MODEL), true, "失败不换模型");
  const empty = fake({ text: "   " });
  const c3 = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: "http://fake.invalid", apiKey: KEY, fetch: empty.fetch });
  await assert.rejects(c3.compact(req(), new AbortController().signal), (e: unknown) => e instanceof PiContactMindError && e.code === "provider-error" && /空/.test(e.message));
});
