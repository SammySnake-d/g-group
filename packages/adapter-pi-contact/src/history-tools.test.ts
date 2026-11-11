// 找旧消息的 pi 内置只读查询工具 query_history(T-177 G4;需求 D06 §3「精筛内置」:一个宿主注册的查询工具,检索与分页回读两种用法,
// 不是 MCP、不依赖 CLI;AC-33 封闭工具清单):随联系人的工具声明一起发给模型;调用时只校验参数形状,经宿主给的本轮查询口取结果作为工具结果,
// 不登记成动作;没给查询口、宿主拒绝(不在本轮会话)或查询口出错,都以错误结果告知模型,出错不说成「没找到」。
// 假端点同 mind.test.ts:进程内的 Anthropic Messages 兼容 SSE,经 opts.fetch 注入,请求仍由 pi-ai 的 Anthropic 适配构造。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_LABELS, type BlockNo, type HistoryQuery, type RoundInput, type RoundTools } from "@g-group/kernel";
import { createPiContactMind } from "./mind.ts";
import { parseToolCall } from "./tools.ts";

const MODEL = "test-model-1";
interface Block { type: string; text?: string; content?: unknown; is_error?: boolean }
interface Body { tools?: { name: string; input_schema?: unknown }[]; messages: { role: string; content: string | Block[] }[] }
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] };

function fakeAnthropic(turns: readonly Turn[]) {
  const seen: Body[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push(JSON.parse(await req.text()) as Body);
    const t = turns[n - 1] ?? { text: "(脚本已用完)" };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
        let i = 0;
        if (t.text) {
          c.enqueue(sse("content_block_start", { index: i, content_block: { type: "text", text: "" } }));
          c.enqueue(sse("content_block_delta", { index: i, delta: { type: "text_delta", text: t.text } }));
          c.enqueue(sse("content_block_stop", { index: i }));
          i++;
        }
        for (const call of t.calls ?? []) {
          c.enqueue(sse("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${n}_${i}`, name: call.name, input: {} } }));
          c.enqueue(sse("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
          c.enqueue(sse("content_block_stop", { index: i }));
          i++;
        }
        c.enqueue(sse("message_delta", { delta: { stop_reason: t.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetchFn, seen };
}
const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
const input = (): RoundInput => ({
  contact: { id: "c-xiaohou", name: "小后", speakingModel: MODEL, persona: "测试人设" },
  request: { blocks: NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块`, cacheBreakpoint: n === 1 })), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const results = (body: Body | undefined) => (body?.messages.at(-1)?.content ?? []) as Block[];
const textOf = (b: Block | undefined) => JSON.stringify(b?.content ?? "");

test("query_history 是声明给模型的一个内置只读查询工具:检索与分页回读两种用法经宿主本轮查询口取结果作为工具结果,不登记动作;参数形状不对不调用", async () => {
  const fake = fakeAnthropic([
    {
      calls: [
        { name: "query_history", input: { query: "部署端口" } },
        { name: "query_history", input: { query: "部署端口", roomId: "g1", limit: 2 } },
        { name: "query_history", input: { roomId: "g1", seq: 7, before: 1 } },
        { name: "query_history", input: { query: "部署端口", limit: 99 } },
        { name: "query_history", input: { roomId: "g1" } },
        { name: "query_history", input: { query: "部署端口", roomId: "g1", seq: 7 } },
        { name: "query_history", input: { seq: 7 } },
      ],
    },
    { text: "看过了" },
  ]);
  const asked: HistoryQuery[] = [];
  const tools: RoundTools = {
    readMemory: async () => null,
    queryHistory: async (q) => {
      asked.push(q);
      return q.kind === "search" ? "找到 1 条旧消息:〔g1 #7〕我 · 时间 · 版本 7:部署端口是 9090" : "〔g1 #6〕我 · 时间 · 版本 6\n前一句\n〔g1 #7〕我 · 时间 · 版本 7\n部署端口是 9090";
    },
  };
  const out = await createPiContactMind({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "k", fetch: fake.fetch }).round(input(), new AbortController().signal, tools);
  assert.deepEqual(out, { actions: [], stateNote: null }, "找旧消息不是动作");
  assert.deepEqual(asked, [
    { kind: "search", query: "部署端口", roomId: null, limit: null },
    { kind: "search", query: "部署端口", roomId: "g1", limit: 2 },
    { kind: "read", roomId: "g1", seq: 7, before: 1, after: null },
  ]);
  const names = fake.seen[0]?.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(names.filter((n) => /history/.test(n)), ["query_history"], "找旧消息只有一个工具");
  const r = results(fake.seen[1]);
  assert.deepEqual(r.map((x) => x.is_error === true), [false, false, false, true, true, true, true]);
  assert.match(textOf(r[0]), /部署端口是 9090/);
  assert.match(textOf(r[2]), /前一句/);
  assert.match(textOf(r[5]), /query 与 seq 二选一/);
  assert.deepEqual(parseToolCall("query_history", { roomId: "g1", seq: 7, after: 2 }), { ok: true, value: { kind: "query-history", query: { kind: "read", roomId: "g1", seq: 7, before: null, after: 2 } } });
  assert.equal(parseToolCall("query_history", { query: "x", limit: 51 }).ok, false);
  assert.equal(parseToolCall("query_history", { query: "x", before: 1 }).ok, false, "检索不收 before/after");
  assert.equal(parseToolCall("query_history", { roomId: "g1", seq: 7, limit: 2 }).ok, false, "回读不收 limit");
});

test("找旧消息:没给查询口、宿主拒绝或查询口出错都以错误结果告知模型,出错不说成没找到", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "query_history", input: { query: "预算" } }, { name: "query_history", input: { roomId: "dm-x", seq: 3 } }, { name: "query_history", input: { query: "坏" } }] },
    { text: "好" },
    { calls: [{ name: "query_history", input: { query: "预算" } }] },
    { text: "好" },
  ]);
  const tools: RoundTools = {
    readMemory: async () => null,
    queryHistory: async (q) => {
      if (q.kind === "search" && q.query === "坏") throw new Error("检索接缝坏了");
      return null;
    },
  };
  const mind = createPiContactMind({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "k", fetch: fake.fetch });
  const out = await mind.round(input(), new AbortController().signal, tools);
  assert.deepEqual(out.actions, []);
  const r = results(fake.seen[1]);
  assert.deepEqual(r.map((x) => x.is_error === true), [true, true, true]);
  assert.match(textOf(r[0]), /本轮不在本轮可查的会话里/);
  assert.match(textOf(r[1]), /读不到 dm-x #3/);
  assert.match(textOf(r[2]), /找旧消息出错\(不代表没说过\):检索接缝坏了"$/);
  await mind.round(input(), new AbortController().signal);
  const none = results(fake.seen[3]);
  assert.equal(none[0]?.is_error, true);
  assert.match(textOf(none[0]), /本轮没有找旧消息的查询口/);
});
