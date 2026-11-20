// 四种模型协议的行为测试(需求文档 U33、D07 §2「pi-ai 是四协议统一 LLM 通信层」):
// 同一套中性工具清单(TOOL_DECLARATIONS)与同一套五块装配,换成四种协议的适配器之后,
// 实际发出的请求体(工具声明摆在哪儿、工具结果怎么回填、密钥放哪个头)与响应里的工具调用都按各自协议核对。
// Generative AI adapter」),所以这一条改成在测试期间替换 globalThis.fetch——请求构造还是适配器自己的,不改协议形状。
// 核对的是实际发出的请求体(D07 第 4 节第 8 条),不是宿主拼了什么。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { BLOCK_LABELS, type BlockNo, type CompactRequest, type ModelUsage, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiCompactor } from "./compact.ts";
import { createPiContactMind, PiContactMindError } from "./mind.ts";
import { apiForModel, baseUrlForApi, modelForProtocol, ProtocolHealthCache, type PiProtocol } from "./protocols.ts";
import { discoverMagpieGateway, probeModelConnection } from "./magpie.ts";
import { PI_CONTACT_TOOL_NAMES } from "./tools.ts";

const KEY = "NEUTRAL_FIXTURE_B4_NOT_A_CREDENTIAL";
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
    const out = await mindOf("anthropic-messages", ep).round(input("r1"), live());
    assert.deepEqual(out, { actions: [{ kind: "reply", roomId: "g1", text: "收到,马上看", replyToSeq: null }], stateNote: null });
    assert.equal(ep.seen.length, 2);
    const [first, second] = ep.seen as [Seen, Seen];
    assert.equal(first.body.model, MODEL);
    assert.match(first.url, new RegExp(`^${ep.host.replace(/[.:]/g, "\\$&")}/v1/messages(\\?|$)`));
    assert.equal(first.headers.get("x-api-key"), KEY);
    assert.match(first.headers.get("x-session-affinity") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(second.headers.get("x-session-affinity"), first.headers.get("x-session-affinity"));
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
      const usage: ModelUsage[] = [];
      const out = await mind.round(input("r1"), live(), undefined, (row) => usage.push(row));
      assert.equal(usage.length, protocol === "openai-chat" ? 0 : 1);
      if (usage[0]) assert.equal(usage[0].explicitBreakpoints !== false, protocol === "anthropic-messages");
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

const config = { model: MODEL, provider: "fixture", baseUrl: "http://fixture.invalid", contextWindow: 200000, maxTokens: 4096 };
const multi = ["openai-chat", "openai-responses"] as const;
const opts = { ...config, apiKey: KEY, protocols: multi };

function routedFetch(first: () => Response, second = () => streamOf("openai-responses", { text: "ok" }, 2)) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const req = new Request(resource, init);
    seen.push({ url: req.url, headers: req.headers, body: await req.json() as Record<string, unknown> });
    return new URL(req.url).pathname === "/v1/chat/completions" ? first() : second();
  };
  return { seen, fetch };
}

const refusal = () => Response.json({ error: { message: `fixture rejection ${KEY}` } }, { status: 400 });
const paths = (seen: Seen[]) => seen.map((s) => new URL(s.url).pathname);
const failedChat = (delta: object, usage?: object) => new Response(
  `data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta, finish_reason: null }], ...(usage ? { usage } : {}) })}\n\ndata: ${JSON.stringify({ error: { message: "stream failed" } })}\n\n`,
  { headers: { "content-type": "text/event-stream" } },
);

test("B4 affinity compat is typed per codec and the OpenAI wire retains one contact-scoped session without retention fields", async () => {
  assert.deepEqual(modelForProtocol("anthropic-messages", config).compat, { sendSessionAffinityHeaders: true });
  assert.deepEqual(modelForProtocol("openai-chat", config).compat, { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" });
  assert.deepEqual(modelForProtocol("openai-responses", config).compat, { sessionAffinityFormat: "openai" });
  assert.equal(modelForProtocol("google-generative-ai", config).compat, undefined);
  const gw = routedFetch(() => streamOf("openai-chat", { text: "ok" }, 1));
  const a = createPiContactMind({ ...opts, api: "openai-chat", protocols: ["openai-chat"], fetch: gw.fetch });
  const b = createPiContactMind({ ...opts, api: "openai-responses", protocols: ["openai-responses"], fetch: gw.fetch });
  await a.round(input("one"), live());
  await b.round(input("two"), live());
  const other = input("three");
  await b.round({ ...other, contact: { ...other.contact, id: "another" } }, live());
  const session = gw.seen[0]?.headers.get("session_id");
  assert.match(session ?? "", /^[0-9a-f]{64}$/);
  assert.equal(gw.seen[1]?.headers.get("session_id"), session);
  assert.notEqual(gw.seen[2]?.headers.get("session_id"), session);
  assert.equal(gw.seen[1]?.body.prompt_cache_retention, undefined);
});

test("B4 clean failure fails over on the exact same model then a shared cooldown also routes the compactor", async () => {
  const gw = routedFetch(refusal, () => streamOf("openai-responses", { text: "new note" }, 2));
  const healthCache = new ProtocolHealthCache({ now: () => 1 });
  const mind = createPiContactMind({ ...opts, fetch: gw.fetch, healthCache });
  await mind.round(input("one"), live());
  const c = createPiCompactor({ ...opts, fetch: gw.fetch, healthCache });
  const req: CompactRequest = { contact: input("one").contact, kind: "round-note", previous: "old", material: "new", maxBytes: null };
  assert.equal(await c.compact(req, live()), "new note");
  assert.deepEqual(paths(gw.seen), ["/v1/chat/completions", "/v1/responses", "/v1/responses"]);
  assert.deepEqual(gw.seen.map((s) => s.body.model), [MODEL, MODEL, MODEL]);
});

test("B4 cache cooldowns are 1m, 2m, 5m, 10m, 10m; all-cooling probes earliest expiry and success resets", () => {
  let now = 0;
  const h = new ProtocolHealthCache({ now: () => now });
  for (const ttl of [60_000, 120_000, 300_000, 600_000, 600_000]) {
    h.failure(config.baseUrl, MODEL, "openai-chat");
    assert.deepEqual(h.candidates(config.baseUrl, MODEL, multi), ["openai-responses"]);
    assert.deepEqual(h.candidates(`${config.baseUrl}/another`, MODEL, multi), ["openai-responses"], "health scoped to the origin");
    assert.deepEqual(h.candidates(config.baseUrl, "other model", multi), multi);
    now += ttl - 1;
    assert.deepEqual(h.candidates(config.baseUrl, MODEL, multi), ["openai-responses"]);
    now++;
    assert.deepEqual(h.candidates(config.baseUrl, MODEL, multi), multi);
  }
  h.failure(config.baseUrl, MODEL, "openai-chat");
  h.failure(config.baseUrl, MODEL, "openai-responses");
  assert.deepEqual(h.candidates(config.baseUrl, MODEL, multi), ["openai-responses"]);
  h.success(config.baseUrl, MODEL, "openai-chat");
  h.failure(config.baseUrl, MODEL, "openai-chat");
  now += 60_000;
  assert.deepEqual(h.candidates(config.baseUrl, MODEL, multi), multi);
});

test("B4 text, thinking and tool deltas independently bar failover after an SSE error", async () => {
  for (const delta of [{ content: "partial" }, { reasoning_content: "partial thinking" }, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "reply", arguments: "{" } }] }]) {
    const gw = routedFetch(() => failedChat(delta));
    const mind = createPiContactMind({ ...opts, fetch: gw.fetch });
    await assert.rejects(mind.round(input("partial"), live()), (e: unknown) => e instanceof PiContactMindError && e.code === "provider-error" && /stream failed/.test(e.message));
    assert.deepEqual(paths(gw.seen), ["/v1/chat/completions"], JSON.stringify(delta));
  }
});

test("B4 a committed usage receipt bars failover even with no text or tool deltas", async () => {
  const gw = routedFetch(() => failedChat({}, { prompt_tokens: 15, completion_tokens: 1, total_tokens: 16 }));
  const mind = createPiContactMind({ ...opts, fetch: gw.fetch });
  const recorded: number[] = [];
  await assert.rejects(mind.round(input("usage only"), live(), undefined, (row) => recorded.push(row.input)), /stream failed/);
  assert.deepEqual(recorded, [15]);
  assert.deepEqual(paths(gw.seen), ["/v1/chat/completions"]);
});

test("B4 second tool step never changes codec, and provisional actions are not returned on failure", async () => {
  let step = 0;
  const gw = routedFetch(() => ++step === 1 ? streamOf("openai-chat", { calls: [call("reply", { roomId: "g1", text: "provisional" })] }, 1) : refusal());
  const mind = createPiContactMind({ ...opts, fetch: gw.fetch });
  await assert.rejects(mind.round(input("tool then failure"), live()), /fixture rejection/);
  assert.deepEqual(paths(gw.seen), ["/v1/chat/completions", "/v1/chat/completions"]);
});

test("B4 compaction after visible deltas never falls through to the next codec", async () => {
  const gw = routedFetch(() => failedChat({ content: "partial note" }));
  const c = createPiCompactor({ ...opts, fetch: gw.fetch });
  const req: CompactRequest = { contact: input("note").contact, kind: "round-note", previous: null, material: "fixture", maxBytes: null };
  await assert.rejects(c.compact(req, live()), /stream failed/);
  assert.deepEqual(paths(gw.seen), ["/v1/chat/completions"]);
});

test("B4 probe requests exactly one tool, at least 8192 tokens and decodes the tool call via fallback", async () => {
  const gw = routedFetch(refusal, () => streamOf("openai-responses", { calls: [call("connection_check", { ok: true })] }, 2));
  const r = await probeModelConnection({ ...opts, maxTokens: 16, fetch: gw.fetch });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.model, r.protocol, r.usage?.input], [MODEL, "openai-responses", 3]);
  assert.deepEqual(paths(gw.seen), ["/v1/chat/completions", "/v1/responses"]);
  assert.deepEqual(gw.seen.map((s) => [s.body.model, toolNames(s.body.tools), s.body.stream]), [[MODEL, ["connection_check"], true], [MODEL, ["connection_check"], true]]);
  assert.ok(Number(gw.seen[0]?.body.max_completion_tokens) >= 8192);
  assert.ok(Number(gw.seen[1]?.body.max_output_tokens) >= 8192);
});

test("B4 probe rejects text-only replies and redacts every failed attempt", async () => {
  const gw = routedFetch(refusal);
  const r = await probeModelConnection({ ...opts, fetch: gw.fetch });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.attempts.map((a) => a.protocol), multi);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(KEY));
    assert.match(r.error, /connection_check/);
  }
});

test("B4 read-only Magpie discovery uses gateway.json and capability endpoints, not a guessed model name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-b4-gateway-"));
  const gatewayFile = path.join(dir, "gateway.json");
  const contents = '{"addr":"127.0.0.1:34321"}\n';
  writeFileSync(gatewayFile, contents);
  const before = statSync(gatewayFile);
  const seen: [string, string, string | null][] = [];
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const req = new Request(resource, init);
    seen.push([req.url, req.method, req.headers.get("authorization")]);
    return new URL(req.url).pathname === "/api/hello" ? Response.json({ name: "magpie" }) : Response.json({ data: [
      { id: MODEL, native_endpoints: ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1beta/models"], reasoning: true, tool_call: true, supported_parameters: ["tools"] },
      { id: "gpt-unknown", native_endpoints: ["/unknown"] },
    ] });
  };
  try {
    const g = await discoverMagpieGateway({ gatewayFile, env: {}, fetch });
    assert.equal(g.baseUrl, "http://127.0.0.1:34321");
    assert.deepEqual(g.models[0]?.protocols, ["openai-responses", "openai-chat", "anthropic-messages", "google-generative-ai"]);
    assert.deepEqual([g.models[0]?.id, g.models[0]?.reasoning, g.models[0]?.toolCall, g.models[0]?.supportedParameters], [MODEL, true, true, ["tools"]]);
    assert.deepEqual(g.models[1]?.protocols, []);
    assert.deepEqual(seen, [[`${g.baseUrl}/api/hello`, "GET", null], [`${g.baseUrl}/v1/models`, "GET", "Bearer magpie-g-group"]]);
    assert.equal(readFileSync(gatewayFile, "utf8"), contents);
    assert.deepEqual([statSync(gatewayFile).mtimeMs, statSync(gatewayFile).ctimeMs], [before.mtimeMs, before.ctimeMs]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("B4 discovery will not send credentials if the greeting does not identify Magpie", async () => {
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const req = new Request(resource, init);
    seen.push(new URL(req.url).pathname);
    return Response.json({ name: "not-magpie" });
  };
  await assert.rejects(discoverMagpieGateway({ baseUrl: config.baseUrl, apiKey: KEY, env: {}, fetch }), /api\/hello.*magpie/i);
  assert.deepEqual(seen, ["/api/hello"]);
});
