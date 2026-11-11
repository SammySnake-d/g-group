// 片 CA2(feat/contact-call-check)的工具层:pi 运行时在工具执行时先调宿主给的只读当场校验口 checkAction。
// 校验说不行的动作**不登记**(不进本轮动作),拒绝原因作为工具结果立刻回到模型,模型同一轮就能改口或改动作;
// 说可以、或宿主没给校验口(退回轮末校验)时照常登记。reply 的 @everyone 只在这里声明(第 1 块预算没有余量,见 PR)。
// 假端点同 mind.test.ts:进程内的 Anthropic Messages 兼容 SSE,经 opts.fetch 注入,不连网。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type MindAction, type RoundBlock, type RoundInput, type RoundTools } from "@g-group/kernel";
import { createPiContactMind } from "./mind.ts";
import { parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

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

test("reply 的 everyone:声明里有这个字段,登记成 everyone=true;不给就不带这个字段,给了非布尔值不登记", () => {
  const decl = TOOL_DECLARATIONS.find((d) => d.name === "reply")!.parameters as { required: string[]; properties: Record<string, { type?: unknown }> };
  assert.deepEqual(decl.required, ["roomId", "text"], "everyone 可省略");
  assert.deepEqual(Object.keys(decl.properties), ["roomId", "text", "replyToSeq", "mentions", "everyone"]);
  assert.equal(decl.properties.everyone!.type, "boolean");
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "大家一起看", everyone: true }), {
    ok: true,
    value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "大家一起看", replyToSeq: null, everyone: true } },
  });
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到", everyone: false }), { ok: true, value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "收到", replyToSeq: null } } }, "false 就是不带这个字段");
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到" }), { ok: true, value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "收到", replyToSeq: null } } });
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "小研也一起", mentions: ["c-yan"], everyone: true }), {
    ok: true,
    value: { kind: "action", action: { kind: "reply", roomId: "g1", text: "小研也一起", replyToSeq: null, mentions: ["c-yan"], everyone: true } },
  }, "与逐个 mentions 可以并用,并集由宿主取");
  assert.deepEqual(parseToolCall("reply", { roomId: "g1", text: "收到", everyone: "yes" }), { ok: false, why: "everyone 必须是布尔值" });
});

test("工具执行时先调当场校验口:说不行的动作不登记、原因立刻回到模型,同轮其余动作照常登记", async () => {
  const fake = fakeAnthropic([
    [
      { name: "claim_task", input: { taskId: "t-9" } },
      { name: "reply", input: { roomId: "g1", text: "我认领了 t-9" } },
    ],
    [],
    [{ name: "claim_task", input: { taskId: "t-9" } }, { name: "reply", input: { roomId: "g1", text: "我认领了 t-9" } }],
    [],
  ]);
  const tools: RoundTools = {
    readMemory: async () => null,
    checkAction: (a: MindAction) => (a.kind === "claim" ? { ok: false, reason: "任务 t-9 已由联系人 c-yan 认领(T3_Running)" } : { ok: true }),
  };
  const mind = createPiContactMind(opts(fake));
  const out = await mind.round(input(), new AbortController().signal, tools);
  assert.deepEqual(out.actions, [{ kind: "reply", roomId: "g1", text: "我认领了 t-9", replyToSeq: null }], "被拒的 claim 不进本轮动作");
  assert.deepEqual(out.inRoundRefusals, [{ action: { kind: "claim", taskId: "t-9" }, reason: "任务 t-9 已由联系人 c-yan 认领(T3_Running)" }], "被拒的动作与原因记进本轮,宿主轮末据此拦宣称它已完成的 reply");
  const results = toolResults(fake.seen[1]!);
  assert.deepEqual(results.map((r) => r.isError), [true, false], "被拒的以错误结果立刻告知模型,同轮其余照常");
  assert.match(results[0]!.text, /任务 t-9 已由联系人 c-yan 认领\(T3_Running\)/, "原因原样回到模型");
  // 宿主没给校验口(退回轮末校验):照旧全部登记,本轮也不带被拒动作字段
  const plain = await mind.round(input(), new AbortController().signal, { readMemory: async () => null });
  assert.deepEqual(plain.actions, [
    { kind: "claim", taskId: "t-9" },
    { kind: "reply", roomId: "g1", text: "我认领了 t-9", replyToSeq: null },
  ], "没有校验口就照旧全部登记,由宿主轮末校验");
  assert.equal(Object.hasOwn(plain, "inRoundRefusals"), false, "没有当场被拒的动作就不给这个字段");
  assert.deepEqual(toolResults(fake.seen[3]!).map((r) => r.isError), [false, false]);
});
