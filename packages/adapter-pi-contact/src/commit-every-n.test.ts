// 联系人的 commit 工具能带「每 N 条消息做一次」(U80):发给模型的工具声明里有这个可选项;模型填了 N,这一轮登记成带 everyNMessages 的承诺动作,
// 没填就和原来一样。用进程内的 Anthropic Messages 兼容假端点(SSE)驱动真实的 createPiContactMind,核对实际发出的请求体与这一轮登记下来的动作。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind, renderBlock } from "./mind.ts";

const MODEL = "test-model-1";
interface Block { type: string; text?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface Tool { name: string; input_schema: { properties: Record<string, { type: unknown }>; required: string[] } }
interface Body { model: string; system?: Block[]; tools?: Tool[]; messages: { role: string; content: string | Block[] }[] }
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] };

/** 按脚本回放模型的文本或工具调用,记下每次真实收到的请求体。 */
function fakeAnthropic(turns: readonly Turn[]) {
  const seen: Body[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const n = seen.push(JSON.parse(await new Request(input, init).text()) as Body);
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
const blocks: RoundBlock[] = NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块内容`, cacheBreakpoint: n === 1 }));
const input: RoundInput = { contact: { id: "c-xiaoji", name: "小记", speakingModel: MODEL, persona: "测试人设" }, request: { blocks, basedOnSeq: { g1: 7 } }, fresh: [] };
const OPTS = { provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "sk-test" };
const texts = (c: string | Block[]) => (typeof c === "string" ? [c] : c.map((b) => b.text));
/** 这一轮发出的首个请求就是平常的五块、平常的模型:确认测的是联系人说话的那个入口。 */
function assertOrdinaryRequest(body: Body) {
  assert.deepEqual([body.model, body.system?.map((b) => b.text), texts(body.messages[0]!.content)], [MODEL, ["第1块内容"], blocks.slice(1).map((b) => renderBlock(b))]);
}

test("发给模型的 commit 工具声明里有可选的 everyNMessages,必填项不变;模型填了 N,这一轮登记成带 N 的承诺动作", async () => {
  const fake = fakeAnthropic([{ calls: [{ name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "每 100 条消息总结一次", everyNMessages: 100 } }] }, { text: "完事" }]);
  const out = await createPiContactMind({ ...OPTS, fetch: fake.fetch }).round(input, new AbortController().signal);
  assert.deepEqual(out.actions, [{ kind: "commit", roomId: "g1", sourceSeq: 7, text: "每 100 条消息总结一次", taskId: null, everyNMessages: 100 }]);
  assertOrdinaryRequest(fake.seen[0]!);
  const schema = fake.seen[0]!.tools!.find((t) => t.name === "commit")!.input_schema;
  assert.deepEqual([Object.keys(schema.properties), schema.required, schema.properties.everyNMessages?.type], [["roomId", "sourceSeq", "text", "taskId", "everyNMessages"], ["roomId", "sourceSeq", "text"], ["integer", "null"]]);
});

test("commit 工具的 everyNMessages 省略或给 null 时动作里没有这个字段;不是非负整数的不登记,原因回给模型", async () => {
  const fake = fakeAnthropic([
    {
      calls: [
        { name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "我来" } },
        { name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "我也来", everyNMessages: null } },
        { name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "每很多条总结", everyNMessages: "很多" } },
        { name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "每两条半总结", everyNMessages: 2.5 } },
        { name: "commit", input: { roomId: "g1", sourceSeq: 7, text: "每负三条总结", everyNMessages: -3 } },
      ],
    },
    { text: "完事" },
  ]);
  const out = await createPiContactMind({ ...OPTS, fetch: fake.fetch }).round(input, new AbortController().signal);
  assert.deepEqual(out.actions, [
    { kind: "commit", roomId: "g1", sourceSeq: 7, text: "我来", taskId: null },
    { kind: "commit", roomId: "g1", sourceSeq: 7, text: "我也来", taskId: null },
  ]);
  assertOrdinaryRequest(fake.seen[0]!);
  // 第二次请求里带着五次工具调用各自的结果:前两次登记了;后三次(不是数、不是整数、负数)按工具声明被拒,结果里点名是 everyNMessages 不对
  const results = (fake.seen[1]!.messages.at(-1)!.content as Block[]).filter((b) => b.type === "tool_result");
  assert.deepEqual(results.map((r) => [r.is_error === true, JSON.stringify(r.content).includes("everyNMessages")]), [[false, false], [false, false], [true, true], [true, true], [true, true]]);
});
