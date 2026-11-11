// 四种模型协议的行为测试(需求文档 U33、D07 §2「pi-ai 是四协议统一 LLM 通信层」):
// 同一套中性工具清单(TOOL_DECLARATIONS)与同一套五块装配,换成四种协议的适配器之后,
// 实际发出的请求体(工具声明摆在哪儿、工具结果怎么回填、密钥放哪个头)与响应里的工具调用都按各自协议核对。
// 假端点按 opts.fetch 注入:请求仍由 pi-ai 的对应适配器照常构造,只把网络套接字换成函数(门禁沙箱禁网时也能跑)。
// google-generative-ai 例外:pi-ai 的该适配器明确拒绝自定义 fetch(抛「Custom fetch is not supported by the Google
// Generative AI adapter」),所以这一条改成在测试期间替换 globalThis.fetch——请求构造还是适配器自己的,不改协议形状。
// 核对的是实际发出的请求体(D07 第 4 节第 8 条),不是宿主拼了什么。
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { BLOCK_LABELS, type BlockNo, type CompactRequest, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiCompactor } from "./compact.ts";
import { createPiContactMind, PiContactMindError } from "./mind.ts";
import { apiForModel, baseUrlForApi, type PiProtocol } from "./protocols.ts";
import { PI_CONTACT_TOOL_NAMES } from "./tools.ts";

const KEY = "sk-four-protocols-SECRET-91c2";
const MODEL = "test-model-1";
const PROTOCOLS4: readonly PiProtocol[] = ["anthropic-messages", "openai-chat", "openai-responses", "google-generative-ai"];
/** 各协议预期的密钥头(不给 authHeader 时用协议默认)。 */
const EXPECTED_AUTH: Readonly<Record<PiProtocol, string>> = {
  "anthropic-messages": "x-api-key",
  "openai-chat": "bearer",
  "openai-responses": "bearer",
  "google-generative-ai": "x-goog-api-key",
};

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: Record<string, unknown> }[] } | { readonly status: number; readonly error: unknown };
const isError = (t: Turn): t is { readonly status: number; readonly error: unknown } => "status" in t;

/** 按协议回放 SSE:文本、或一批工具调用(形状与真实端点一致)。 */
function streamOf(protocol: PiProtocol, turn: { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: Record<string, unknown> }[] }, n: number): Response {
  const enc = new TextEncoder();
  const ev = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const chat = (delta: object, finish: string | null = null) => enc.encode(`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = (parts: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const calls = turn.calls ?? [];
  if (protocol === "anthropic-messages") {
    const parts = [ev("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })];
    let i = 0;
    if (turn.text !== undefined) {
      parts.push(ev("content_block_start", { index: i, content_block: { type: "text", text: "" } }), ev("content_block_delta", { index: i, delta: { type: "text_delta", text: turn.text } }), ev("content_block_stop", { index: i }));
      i++;
    }
    for (const call of calls) {
      parts.push(ev("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_${n}_${i}`, name: call.name, input: {} } }), ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }), ev("content_block_stop", { index: i }));
      i++;
    }
    parts.push(ev("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }), ev("message_stop", {}));
    return done(parts);
  }
  if (protocol === "openai-chat") {
    const parts = [chat({ role: "assistant", content: turn.text ?? "" })];
    calls.forEach((call, i) => {
      parts.push(chat({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }));
    });
    parts.push(chat({}, calls.length ? "tool_calls" : "stop"), enc.encode("data: [DONE]\n\n"));
    return done(parts);
  }
  if (protocol === "openai-responses") {
    const parts = [ev("response.created", { response: { id: `r${n}`, model: MODEL, status: "in_progress", output: [] } })];
    calls.forEach((call, i) => {
      const item = { type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, name: call.name, arguments: JSON.stringify(call.input) };
      parts.push(ev("response.output_item.added", { output_index: i, item: { ...item, arguments: "" } }), ev("response.function_call_arguments.delta", { item_id: item.id, output_index: i, delta: item.arguments }), ev("response.output_item.done", { output_index: i, item }));
    });
    if (turn.text !== undefined) {
      parts.push(ev("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] } }), ev("response.output_text.delta", { item_id: `msg_${n}`, output_index: 0, content_index: 0, delta: turn.text }), ev("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.text, annotations: [] }] } }));
    }
    parts.push(ev("response.completed", { response: { id: `r${n}`, status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }));
    return done(parts);
  }
  const googleParts = calls.length ? calls.map((call) => ({ functionCall: { name: call.name, args: call.input } })) : [{ text: turn.text ?? "" }];
  return done([enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: googleParts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } })}\n\n`)]);
}

/**
 * 进程内假端点:记下每次真实收到的请求体与请求头,按脚本回放响应。
 * transport 是交给 createPiContactMind/PiCompactor 的传输选项;google 那一条走替换 globalThis.fetch,所以为 undefined。
 */
function fakeEndpoint(protocol: PiProtocol, turns: readonly Turn[]) {
  const seen: Seen[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Record<string, unknown> });
    const t = turns[n - 1] ?? { text: "(脚本已用完)" };
    if (isError(t)) return new Response(JSON.stringify(t.error), { status: t.status, headers: { "content-type": "application/json" } });
    return streamOf(protocol, t, n);
  };
  const usesGlobal = protocol === "google-generative-ai";
  const real = globalThis.fetch;
  if (usesGlobal) globalThis.fetch = fetchFn;
  return {
    seen,
    host: `http://fake-${protocol}.invalid`,
    transport: (usesGlobal ? {} : { fetch: fetchFn }) as { fetch?: typeof globalThis.fetch },
    restore: () => { if (usesGlobal) globalThis.fetch = real; },
  };
}
type Endpoint = ReturnType<typeof fakeEndpoint>;

const mindOf = (protocol: PiProtocol, ep: Endpoint, extra: Record<string, unknown> = {}) =>
  createPiContactMind({ provider: "fake", model: MODEL, api: protocol, baseUrl: ep.host, apiKey: KEY, ...ep.transport, ...extra } as never);

const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
const blocks = (tag: string): RoundBlock[] => NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `${tag}-第${n}块内容`, cacheBreakpoint: n === 1 }));
const input = (tag: string, over: { speakingModel?: string } = {}): RoundInput => ({
  contact: { id: "c-xiaohou", name: "小后", speakingModel: over.speakingModel ?? MODEL, persona: "测试人设" },
  request: { blocks: blocks(tag), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const live = () => new AbortController().signal;
const call = (name: string, args: Record<string, unknown>) => ({ name, input: args });
const toolNames = (tools: unknown): string[] => (tools as { name?: string; function?: { name?: string } }[]).map((t) => t.function?.name ?? t.name!);
const roundText = (body: unknown) => JSON.stringify(body);
const as = <T,>(x: unknown) => x as T;

test("anthropic-messages:工具声明进 system.tools、工具结果回填成 tool_result、密钥进 x-api-key,响应里的工具调用登记成动作", async () => {
  const ep = fakeEndpoint("anthropic-messages", [{ calls: [call("reply", { roomId: "g1", text: "收到,马上看" })] }, { text: "完事" }]);
  try {
    assert.equal(EXPECTED_AUTH["anthropic-messages"], "x-api-key");
    const out = await mindOf("anthropic-messages", ep).round(input("r1"), live());
    assert.deepEqual(out, { actions: [{ kind: "reply", roomId: "g1", text: "收到,马上看", replyToSeq: null }], stateNote: null });
    assert.equal(ep.seen.length, 2);
    const [first, second] = ep.seen as [Seen, Seen];
    assert.equal(first.body.model, MODEL);
    assert.match(first.url, new RegExp(`^${ep.host.replace(/[.:]/g, "\\$&")}/v1/messages(\\?|$)`));
    assert.equal(first.headers.get("x-api-key"), KEY);
    assert.equal(first.headers.get("authorization"), null);
    assert.deepEqual(toolNames(first.body.tools), [...PI_CONTACT_TOOL_NAMES]);
    assert.deepEqual(as<{ text: string }[]>(first.body.system).map((b) => b.text), ["r1-第1块内容"]);
    assert.equal(as<{ type: string }[]>(second.body.messages).length, 3);
    const msgs = as<{ role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[]>(second.body.messages);
    assert.equal(msgs[1]!.role, "assistant");
    assert.equal(msgs[1]!.content[0]!.type, "tool_use");
    assert.equal(msgs[2]!.role, "user");
    assert.equal(msgs[2]!.content[0]!.type, "tool_result");
    assert.equal(msgs[2]!.content[0]!.tool_use_id, msgs[1]!.content[0]!.id);
  } finally {
    ep.restore();
  }
});

test("openai-chat:工具声明进 tools[].function、工具结果回填成 role:tool、密钥进 Authorization: Bearer", async () => {
  const ep = fakeEndpoint("openai-chat", [{ calls: [call("dispatch_compute", { roomId: "g1", sourceSeq: 3, title: "写文件", task: "写 hello.txt" })] }, { text: "完事" }]);
  try {
    const out = await mindOf("openai-chat", ep).round(input("r1"), live());
    assert.deepEqual(out.actions, [{ kind: "dispatch", roomId: "g1", sourceSeq: 3, title: "写文件", task: "写 hello.txt" }]);
    assert.equal(ep.seen.length, 2);
    const [first, second] = ep.seen as [Seen, Seen];
    assert.equal(first.body.model, MODEL);
    assert.equal(first.url, `${ep.host}/v1/chat/completions`);
    assert.equal(first.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(first.headers.get("x-api-key"), null);
    assert.deepEqual(toolNames(first.body.tools), [...PI_CONTACT_TOOL_NAMES]);
    const msgs = as<{ role: string; content?: string | unknown[]; tool_call_id?: string; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] }[]>(second.body.messages);
    assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(msgs[2]!.tool_calls![0]!.type, "function");
    assert.equal(msgs[2]!.tool_calls![0]!.function.name, "dispatch_compute");
    assert.deepEqual(JSON.parse(msgs[2]!.tool_calls![0]!.function.arguments), { roomId: "g1", sourceSeq: 3, title: "写文件", task: "写 hello.txt" });
    assert.equal(msgs[3]!.tool_call_id, msgs[2]!.tool_calls![0]!.id);
    assert.match(String(msgs[3]!.content), /已登记/);
  } finally {
    ep.restore();
  }
});

test("openai-responses:工具声明是顶层 function、工具结果回填成 function_call_output、密钥进 Authorization: Bearer", async () => {
  const ep = fakeEndpoint("openai-responses", [{ calls: [call("reply", { roomId: "g1", text: "好" })] }, { text: "完事" }]);
  try {
    const out = await mindOf("openai-responses", ep).round(input("r1"), live());
    assert.deepEqual(out.actions, [{ kind: "reply", roomId: "g1", text: "好", replyToSeq: null }]);
    assert.equal(ep.seen.length, 2);
    const [first, second] = ep.seen as [Seen, Seen];
    assert.equal(first.url, `${ep.host}/v1/responses`);
    assert.equal(first.headers.get("authorization"), `Bearer ${KEY}`);
    const tools = as<{ type: string; name: string; parameters: Record<string, unknown> }[]>(first.body.tools);
    assert.deepEqual(tools.map((t) => t.name), [...PI_CONTACT_TOOL_NAMES]);
    assert.equal(tools.every((t) => t.type === "function" && typeof t.parameters === "object" && !("function" in t)), true);
    const items = as<{ type: string; name?: string; call_id?: string; output?: string }[]>(second.body.input);
    const called = items.find((i) => i.type === "function_call")!;
    const back = items.find((i) => i.type === "function_call_output")!;
    assert.equal(called.name, "reply");
    assert.equal(back.call_id, called.call_id);
    assert.match(String(back.output), /已登记/);
  } finally {
    ep.restore();
  }
});

test("google-generative-ai:工具声明进 tools[].functionDeclarations、工具结果回填成 functionResponse、密钥进 x-goog-api-key", async () => {
  const ep = fakeEndpoint("google-generative-ai", [{ calls: [call("reply", { roomId: "g1", text: "好" })] }, { text: "完事" }]);
  try {
    const out = await mindOf("google-generative-ai", ep).round(input("r1"), live());
    assert.deepEqual(out.actions, [{ kind: "reply", roomId: "g1", text: "好", replyToSeq: null }]);
    assert.equal(ep.seen.length, 2);
    const [first, second] = ep.seen as [Seen, Seen];
    assert.match(first.url, new RegExp(`^${ep.host.replace(/[.:]/g, "\\$&")}/models/${MODEL}:streamGenerateContent`));
    assert.equal(first.headers.get("x-goog-api-key"), KEY);
    assert.equal(first.headers.get("authorization"), null);
    const tools = as<{ functionDeclarations: { name: string; parametersJsonSchema: Record<string, unknown> }[] }[]>(first.body.tools);
    assert.deepEqual(tools[0]!.functionDeclarations.map((d) => d.name), [...PI_CONTACT_TOOL_NAMES]);
    assert.equal(typeof tools[0]!.functionDeclarations[0]!.parametersJsonSchema, "object");
    const contents = as<{ role: string; parts: { functionCall?: { name: string }; functionResponse?: { name: string; response: { output?: string } } }[] }[]>(second.body.contents);
    const called = contents.find((c) => c.parts.some((p) => p.functionCall))!;
    const back = contents.find((c) => c.parts.some((p) => p.functionResponse))!;
    assert.equal(called.parts[0]!.functionCall!.name, "reply");
    assert.equal(back.parts[0]!.functionResponse!.name, "reply");
    assert.match(String(back.parts[0]!.functionResponse!.response.output), /已登记/);
    assert.equal(back.role, "user");
  } finally {
    ep.restore();
  }
});

test("cache_control 只在 anthropic-messages 下加:anthropic 的断点不超过 4 个;其它三种协议不带缓存字段也不报错", async () => {
  for (const protocol of PROTOCOLS4) {
    const ep = fakeEndpoint(protocol, [{ text: "好" }]);
    try {
      const mind = createPiContactMind({ provider: "fake", model: MODEL, api: protocol, baseUrl: ep.host, apiKey: KEY, cacheRetention: "long", ...ep.transport } as never);
      const out = await mind.round(input("r1"), live());
      assert.deepEqual(out, { actions: [], stateNote: null }, protocol);
      assert.equal(ep.seen.length, 1, protocol);
      const raw = roundText(ep.seen[0]!.body);
      const breaks = (raw.match(/cache_control/g) ?? []).length;
      if (protocol === "anthropic-messages") assert.ok(breaks >= 1 && breaks <= 4, `anthropic 的 cache_control 断点 ${breaks} 个`);
      else {
        assert.equal(breaks, 0, `${protocol} 不该带 cache_control`);
        assert.equal(raw.includes("prompt_cache_retention"), false, `${protocol} 不该带缓存保留时长`);
        assert.equal(raw.includes("prompt_cache_key"), false, `${protocol} 不该带缓存键`);
      }
    } finally {
      ep.restore();
    }
  }
});

test("四种协议下说话模型对不上都整轮拒绝:错误是 model-mismatch,一次请求都不发", async () => {
  for (const protocol of PROTOCOLS4) {
    const ep = fakeEndpoint(protocol, [{ text: "不该被请求" }]);
    try {
      const mind = mindOf(protocol, ep);
      const err = await mind.round(input("r1", { speakingModel: "other-model" }), live()).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof PiContactMindError, protocol);
      assert.equal(err.code, "model-mismatch", protocol);
      assert.match(err.message, /other-model/, protocol);
      assert.equal(ep.seen.length, 0, `${protocol} 不该发请求`);
    } finally {
      ep.restore();
    }
  }
});

test("四种协议下密钥不出现在返回值、mind 对象与错误信息里(含上游 4xx/5xx 的错误体)", async () => {
  for (const protocol of ["openai-chat", "google-generative-ai"] as const) {
    const ep = fakeEndpoint(protocol, [{ status: 401, error: { error: { type: "invalid_request_error", message: `invalid key ${KEY}` } } }]);
    try {
      const mind = mindOf(protocol, ep);
      const err = await mind.round(input("r1"), live()).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof PiContactMindError, protocol);
      assert.equal(err.code, "provider-error", protocol);
      assert.equal(err.message.includes(KEY), false, `${protocol} 的错误信息里带了密钥`);
      assert.match(err.message, /密钥已隐去/, `${protocol} 的错误体里本来就带着密钥,该被隐去`);
      assert.equal(inspect(err, { depth: 10, showHidden: true }).includes(KEY), false, protocol);
      assert.equal(inspect(mind, { depth: 10, showHidden: true }).includes(KEY), false, protocol);
      assert.equal(JSON.stringify(mind).includes(KEY), false, protocol);
      assert.equal(ep.seen.length, 1, protocol);
    } finally {
      ep.restore();
    }
  }
});

test("密钥头按协议收窄:给该协议不认的头判选项不合格,给认的头照发;协议默认不给也算对", async () => {
  const wrong: readonly [PiProtocol, string][] = [["anthropic-messages", "x-goog-api-key"], ["openai-chat", "x-api-key"], ["google-generative-ai", "bearer"]];
  for (const [protocol, authHeader] of wrong) {
    const ep = fakeEndpoint(protocol, [{ text: "不该被请求" }]);
    try {
      const err = await Promise.resolve()
        .then(() => mindOf(protocol, ep, { authHeader }))
        .then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof PiContactMindError, `${protocol} + ${authHeader}`);
      assert.equal(err.code, "invalid-options", `${protocol} + ${authHeader}`);
      assert.match(err.message, /authHeader/, `${protocol} + ${authHeader} 的错误该说清是 authHeader 不合格`);
      assert.equal(ep.seen.length, 0);
      const ok = await mindOf(protocol, ep, { authHeader: EXPECTED_AUTH[protocol] }).round(input("r1"), live());
      assert.deepEqual(ok, { actions: [], stateNote: null }, `${protocol} 给协议认的头该照跑`);
      assert.equal(ep.seen.length, 1);
    } finally {
      ep.restore();
    }
  }
});

test("模型名 → 协议:google/gemini、openai/gpt 前缀认得出,认不出的用 anthropic-messages 默认", () => {
  assert.equal(apiForModel("gemini-2.5-flash"), "google-generative-ai");
  assert.equal(apiForModel("google/gemini-3-pro"), "google-generative-ai");
  assert.equal(apiForModel("openai/gpt-5"), "openai-chat");
  assert.equal(apiForModel("gpt-6-astra"), "openai-chat");
  assert.equal(apiForModel("o3-mini"), "openai-chat");
  assert.equal(apiForModel("claude-opus-5-5"), "anthropic-messages");
  assert.equal(apiForModel("workbuddy-ai/hy4free"), "anthropic-messages");
  assert.equal(apiForModel(""), "anthropic-messages");
});

test("端点根地址:openai 兼容口没带路径补 /v1、已带路径不重复加;anthropic 与 google 原样用", () => {
  assert.equal(baseUrlForApi("openai-chat", "http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1");
  assert.equal(baseUrlForApi("openai-chat", "http://127.0.0.1:3425/"), "http://127.0.0.1:3425/v1");
  assert.equal(baseUrlForApi("openai-chat", "http://127.0.0.1:3425/v1"), "http://127.0.0.1:3425/v1");
  assert.equal(baseUrlForApi("openai-responses", "https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.equal(baseUrlForApi("anthropic-messages", "http://127.0.0.1:3425"), "http://127.0.0.1:3425");
  assert.equal(baseUrlForApi("google-generative-ai", "http://127.0.0.1:3425"), "http://127.0.0.1:3425");
  const ep = fakeEndpoint("openai-chat", [{ text: "好" }]);
  try {
    assert.match(ep.host, /^http:\/\/fake-openai-chat\.invalid$/);
    assert.equal(ep.transport.fetch !== undefined, true);
  } finally {
    ep.restore();
  }
});

test("压缩器也按协议:openai-chat 下压缩请求打到 /v1/chat/completions、不带工具、密钥进 Bearer、返回新笔记", async () => {
  const ep = fakeEndpoint("openai-chat", [{ text: "1 在做什么:按长度排(#3)" }]);
  try {
    const c = createPiCompactor({ provider: "fake", model: MODEL, api: "openai-chat", baseUrl: ep.host, apiKey: KEY, ...ep.transport } as never);
    const req: CompactRequest = { contact: { id: "c-1", name: "小克", speakingModel: MODEL, persona: "说话简短" }, kind: "round-note", previous: "旧笔记", material: "改成按长度排", maxBytes: 2000 };
    assert.equal(await c.compact(req, live()), "1 在做什么:按长度排(#3)");
    assert.equal(ep.seen.length, 1);
    const { url, headers, body } = ep.seen[0]!;
    assert.equal(url, `${ep.host}/v1/chat/completions`);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(body.tools, undefined, "压缩不带工具");
    assert.equal(body.max_completion_tokens, 4096);
    assert.match(JSON.stringify(body.messages), /改成按长度排/);
    const wrong = await Promise.resolve().then(() => createPiCompactor({ provider: "fake", model: MODEL, api: "openai-chat", baseUrl: ep.host, apiKey: KEY, ...ep.transport } as never).compact({ ...req, contact: { ...req.contact, speakingModel: "other" } }, live())).then(() => undefined, (e: unknown) => e);
    assert.ok(wrong instanceof PiContactMindError);
    assert.equal(wrong.code, "model-mismatch");
  } finally {
    ep.restore();
  }
});
