// 联系人动作补齐(feat/contact-actions)的工具层:claim_task 认领已有任务(U14),reply 可带 mentions 结构化 @ 人(缺口 7)。
// 工具只校验形状并登记成动作;任务在不在会话、还开不开着、@ 的是不是成员,都由宿主在本轮结束后核对。
// 假端点同 mind.test.ts:进程内的 Anthropic Messages 兼容 SSE,经 opts.fetch 注入,不连网。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind } from "./mind.ts";
import { PI_CONTACT_TOOL_NAMES, parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

const MODEL = "test-model-1";
type Call = { readonly name: string; readonly input: unknown };
interface Body { tools?: { name: string }[]; messages: { role: string; content: string | { type: string; content?: unknown; is_error?: boolean }[] }[] }

function fakeAnthropic(turns: readonly (readonly Call[])[]) {
  const seen: Body[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push(JSON.parse(await req.text()) as Body);
    const calls = turns[n - 1] ?? [];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `m${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
        if (!calls.length) {
          c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
          c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好了" } }));
          c.enqueue(sse("content_block_stop", { index: 0 }));
        }
        calls.forEach((call, i) => {
          c.enqueue(sse("content_block_start", { index: i, content_block: { type: "tool_use", id: `t${n}_${i}`, name: call.name, input: {} } }));
          c.enqueue(sse("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
          c.enqueue(sse("content_block_stop", { index: i }));
        });
        c.enqueue(sse("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetchFn, seen };
}
const input = (): RoundInput => ({
  contact: { id: "c-xiaoke", name: "小克", speakingModel: MODEL, persona: "测试人设" },
  request: { blocks: ([1, 2, 3, 4, 5] as BlockNo[]).map((n): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块`, cacheBreakpoint: n === 1 })), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const opts = (fake: ReturnType<typeof fakeAnthropic>) => ({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "sk-test-NEUTRAL", fetch: fake.fetch });
const toolResults = (b: Body) =>
  b.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((x) => x.type === "tool_result"))).map((x) => ({ text: JSON.stringify(x.content), isError: x.is_error === true }));

test("claim_task 在工具清单里,声明只有必填的 taskId;登记成 claim 动作", () => {
  assert.ok((PI_CONTACT_TOOL_NAMES as readonly string[]).includes("claim_task"));
  const decl = TOOL_DECLARATIONS.find((d) => (d.name as string) === "claim_task")!;
  assert.deepEqual(decl.parameters, {
    type: "object",
    properties: { taskId: { type: "string", minLength: 1, description: "要认领的任务 id" } },
    required: ["taskId"],
    additionalProperties: false,
  });
  assert.match(decl.description, /第 5 块「可认领的任务」/, "说明里指向第 5 块的可认领清单");
  assert.deepEqual(parseToolCall("claim_task", { taskId: "t-mwbs-3" }), { ok: true, value: { kind: "action", action: { kind: "claim", taskId: "t-mwbs-3" } } });
});

test("claim_task 应失败的输入:缺 taskId、空白、多余字段、不是字符串——都不登记", () => {
  assert.deepEqual(parseToolCall("claim_task", {}), { ok: false, why: "缺字段 taskId" });
  assert.deepEqual(parseToolCall("claim_task", { taskId: "  " }), { ok: false, why: "taskId 不能为空白" });
  assert.deepEqual(parseToolCall("claim_task", { taskId: "t-1", roomId: "g1" }), { ok: false, why: "多余字段 roomId" });
  assert.deepEqual(parseToolCall("claim_task", { taskId: 3 }), { ok: false, why: "taskId 必须是字符串" });
});

test("reply 可带 mentions:登记成去重后的 id 列表;不带 mentions 时动作里没有这个字段;空数组或空白 id 不登记", () => {
  const decl = TOOL_DECLARATIONS.find((d) => d.name === "reply")!.parameters as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(decl.required, ["roomId", "text"], "mentions 可省略");
  assert.deepEqual(Object.keys(decl.properties), ["roomId", "text", "replyToSeq", "mentions", "everyone"]);
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "小研看一下", mentions: ["c-yan", "me", "c-yan"] }), {
    ok: true,
    value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "小研看一下", replyToSeq: null, mentions: ["c-yan", "me"] } },
  });
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到", mentions: null }), { ok: true, value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "收到", replyToSeq: null } } });
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到", mentions: [] }), { ok: false, why: "mentions 必须是非空字符串组成的非空数组" });
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到", mentions: ["c-yan", " "] }), { ok: false, why: "mentions 必须是非空字符串组成的非空数组" });
});

test("pi 联系人一轮里调 claim_task 与带 mentions 的 reply:两件都进本轮动作,工具结果是「已登记」不是错误", async () => {
  const fake = fakeAnthropic([
    [
      { name: "claim_task", input: { taskId: "t-alpha" } },
      { name: "reply", input: { roomId: "g1", text: "我认领 alpha,小研你拿 beta", mentions: ["c-yan"] } },
    ],
    [],
  ]);
  const out = await createPiContactMind(opts(fake)).round(input(), new AbortController().signal);
  assert.deepEqual(out.actions, [
    { kind: "claim", taskId: "t-alpha" },
    { kind: "reply", roomId: "g1", text: "我认领 alpha,小研你拿 beta", replyToSeq: null, mentions: ["c-yan"] },
  ]);
  assert.ok(fake.seen[0]!.tools?.some((t) => t.name === "claim_task"), "第一次请求就把 claim_task 声明给了模型");
  const results = toolResults(fake.seen[1]!);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.isError), [false, false]);
  assert.match(results[0]!.text, /已登记.*claim/);
});
