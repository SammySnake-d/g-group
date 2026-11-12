// read_linked(U24 显式关联,静态,候选;feat/forward-link):联系人读用户关联到本会话的别的会话,只读、按需,不每轮注入。
// 工具只校验形状、经宿主给的本轮查询口取结果;读不到或本轮没有查询口时作为工具错误回给模型,不登记成动作。
// 用进程内的 Anthropic Messages 兼容假端点(SSE)驱动,经 opts.fetch 注入,门禁沙箱禁网也能跑。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type LinkedQuery, type RoundInput } from "@g-group/kernel";
import { createPiContactMind } from "./mind.ts";
import { parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

const MODEL = "test-model-1";
interface Block { type: string; content?: unknown; is_error?: boolean }
interface Body { messages: { role: string; content: string | Block[] }[] }
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
  contact: { id: "c-xiaoyan", name: "小研", speakingModel: MODEL, persona: "测试人设" },
  request: { blocks: NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块`, cacheBreakpoint: n === 1 })), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const mindWith = (fake: ReturnType<typeof fakeAnthropic>) => createPiContactMind({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: fake.fetch });
const toolResults = (b: Body) => b.messages[2]!.content as Block[];

test("read_linked 登记成关联查询:只有 roomId 必填,linkedRoomId/query/beforeSeq/limit 可省;多余字段、负数、缺 roomId 不登记", () => {
  assert.deepEqual(parseToolCall("read_linked", { roomId: "g1", linkedRoomId: "dm-c1", query: "日期", beforeSeq: 9, limit: 5 }), {
    ok: true,
    value: { kind: "read-linked", query: { roomId: "g1", linkedRoomId: "dm-c1", query: "日期", beforeSeq: 9, limit: 5 } },
  });
  assert.deepEqual(parseToolCall("read_linked", { roomId: "g1" }), { ok: true, value: { kind: "read-linked", query: { roomId: "g1", linkedRoomId: null, query: null, beforeSeq: null, limit: null } } });
  assert.equal(parseToolCall("read_linked", { roomId: "g1", extra: 1 }).ok, false);
  assert.equal(parseToolCall("read_linked", { roomId: "g1", beforeSeq: -1 }).ok, false);
  assert.equal(parseToolCall("read_linked", { linkedRoomId: "dm-c1" }).ok, false);
  const decl = TOOL_DECLARATIONS.find((d) => d.name === "read_linked");
  assert.ok(decl, "工具清单里有 read_linked");
  assert.deepEqual(decl.parameters.required, ["roomId"]);
  assert.match(decl.description, /关联/);
});

test("read_linked 经宿主的本轮查询口读关联记录,结果作为工具结果;读不到时报错给模型,不登记成动作", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "read_linked", input: { roomId: "g1", linkedRoomId: "dm-c1", query: "日期" } }, { name: "read_linked", input: { roomId: "g9", linkedRoomId: "dm-c1" } }] },
    { text: "好" },
  ]);
  const asked: LinkedQuery[] = [];
  const tools = {
    readMemory: async () => null,
    readLinked: async (q: LinkedQuery) => {
      asked.push(q);
      return q.roomId === "g1" ? "关联记录 · 私聊「小克」\n#1 · 我 · t\n我们约定 12 月 3 日交付" : null;
    },
  };
  const out = await mindWith(fake).round(input(), new AbortController().signal, tools);
  assert.deepEqual(out.actions, [], "只读查询不是动作");
  assert.deepEqual(asked, [
    { roomId: "g1", linkedRoomId: "dm-c1", query: "日期", beforeSeq: null, limit: null },
    { roomId: "g9", linkedRoomId: "dm-c1", query: null, beforeSeq: null, limit: null },
  ]);
  const results = toolResults(fake.seen[1]!);
  assert.match(JSON.stringify(results[0]!.content), /12 月 3 日交付/);
  assert.deepEqual(results.map((b) => b.is_error === true), [false, true]);
  assert.match(JSON.stringify(results[1]!.content), /读不到/);
  // 工具登记出来的查询与宿主查询口收到的逐字一致(登记口到查询口没有走形)
  assert.deepEqual(parseToolCall("read_linked", { roomId: "g1", linkedRoomId: "dm-c1", query: "日期" }), { ok: true, value: { kind: "read-linked", query: asked[0] } });
});

test("read_linked 在本轮没有关联查询口时报错给模型,不调别的口", async () => {
  const fake = fakeAnthropic([{ calls: [{ name: "read_linked", input: { roomId: "g1", linkedRoomId: "dm-c1" } }] }, { text: "好" }]);
  const out = await mindWith(fake).round(input(), new AbortController().signal, { readMemory: async () => "不该被调用" });
  assert.deepEqual(out.actions, []);
  assert.ok(TOOL_DECLARATIONS.some((d) => d.name === "read_linked"), "工具声明里有 read_linked,模型才可能调到它");
  const results = toolResults(fake.seen[1]!);
  assert.equal(results[0]!.is_error, true);
  assert.match(JSON.stringify(results[0]!.content), /没有关联查询口/);
});
