// 联系人的 progress_get 工具(需求文档 D26 第 4 节,AC-43 ①④、U91):pi 联系人在同一轮的工具往返里经宿主给的台账查询口查一个单元。
// 工具只校验参数形状;查询口由宿主按会话判可见范围(宿主侧见 packages/server/src/runtime-config.test.ts)。
// 用进程内的 Anthropic Messages 兼容假端点(SSE)驱动,经 opts.fetch 注入,不连网;核对的是真实发出的下一次请求里的工具结果。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind, type PiContactMindOptions } from "./mind.ts";
import { PI_CONTACT_TOOL_NAMES, parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

const MODEL = "test-model-1";
interface Block { type: string; text?: string; content?: unknown; is_error?: boolean; tool_use_id?: string }
interface Body { messages: { role: string; content: string | Block[] }[] }
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] };

/** 假端点:按脚本回放模型的文字或工具调用,记下每次真实收到的请求体 */
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
const opts = (fake: ReturnType<typeof fakeAnthropic>): PiContactMindOptions => ({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "sk-test-NEUTRAL_FIXTURE_NO_CREDENTIALS", fetch: fake.fetch });
const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
const input = (): RoundInput => ({
  contact: { id: "c-xiaohou", name: "小后", speakingModel: MODEL, persona: "测试人设" },
  request: { blocks: NUMS.map((n): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块`, cacheBreakpoint: n === 1 })), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const live = () => new AbortController().signal;

test("progress_get 追加在工具清单末尾:id 与 roomId 都必填、不许多余字段;形状合格登记成只读查询,应失败的输入(缺 roomId、id 为空白、多余字段、id 不是字符串)不登记", () => {
  assert.equal(PI_CONTACT_TOOL_NAMES.at(-1), "progress_get");
  const decl = TOOL_DECLARATIONS.at(-1)!;
  assert.equal(decl.name, "progress_get");
  assert.deepEqual(decl.parameters.required, ["id", "roomId"]);
  assert.equal(decl.parameters.additionalProperties, false);
  assert.match(decl.description, /可见范围由宿主按会话判/);
  assert.deepEqual(parseToolCall("progress_get", { id: "run-1", roomId: "g1" }), { ok: true, value: { kind: "progress-get", id: "run-1", roomId: "g1" } });
  assert.deepEqual(parseToolCall("progress_get", { id: "run-1" }), { ok: false, why: "缺字段 roomId" });
  assert.deepEqual(parseToolCall("progress_get", { id: "  ", roomId: "g1" }), { ok: false, why: "id 不能为空白" });
  assert.deepEqual(parseToolCall("progress_get", { id: "run-1", roomId: "g1", all: true }), { ok: false, why: "多余字段 all" });
  assert.deepEqual(parseToolCall("progress_get", { id: 7, roomId: "g1" }), { ok: false, why: "id 必须是字符串" });
});

test("progress_get 在本轮内经宿主的台账查询口取单元详情,结果作为工具结果进下一次请求、不是动作;看不到的单元和没给查询口时以错误结果告知", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "progress_get", input: { id: "run-1", roomId: "g1" } }, { name: "progress_get", input: { id: "run-x", roomId: "g1" } }, { name: "progress_get", input: { id: "run-1" } }] },
    { text: "看过了" },
    { calls: [{ name: "progress_get", input: { id: "run-1", roomId: "g1" } }] },
    { text: "没查到" },
  ]);
  const asked: [string, string][] = [];
  const tools = {
    readMemory: async () => null,
    progressGet: async (id: string, roomId: string) => {
      asked.push([id, roomId]);
      return id === "run-1" ? JSON.stringify({ unit: { id: "run-1", status: "failed", reasonClass: "stalled" } }) : null;
    },
  };
  const out = await createPiContactMind(opts(fake)).round(input(), live(), tools);
  assert.deepEqual(out.actions, [], "查询不是动作");
  assert.deepEqual(asked, [["run-1", "g1"], ["run-x", "g1"]], "形状不对的那次没有调查询口");
  const results = fake.seen[1]!.messages[2]!.content as Block[];
  assert.match(JSON.stringify(results[0]!.content), /stalled/);
  assert.deepEqual(results.map((b) => b.is_error === true), [false, true, true]);
  assert.match(JSON.stringify(results[1]!.content), /在 g1 看不到单元 run-x/);
  // 宿主没给台账查询口(只给了记忆查询口):错误结果,不当作查到
  await createPiContactMind(opts(fake)).round(input(), live(), { readMemory: async () => null });
  const none = fake.seen[3]!.messages[2]!.content as Block[];
  assert.equal(none[0]!.is_error, true);
  assert.match(JSON.stringify(none[0]!.content), /本轮没有运行台账查询口/);
});
