// pi Helper 脑子(AC-52,U04/U05;D07.0 Helper 专属 MCP)的行为测试:进程内的 Anthropic Messages 兼容假端点(SSE)经 opts.fetch 注入,
// 请求体仍由 pi-ai 的 Anthropic 适配照常构造;工具清单与调用走内核的 Helper MCP 服务(内存传输)。
// 核对的是实际发出的请求体与实际收到的 MCP 请求:工具声明来自 tools/list、工具结果回填后继续、请求上限、密钥不外泄。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, createHelperMcpServer, HELPER_OPS, type HelperMindInput, type HelperToolResult, type McpClient, memoryMcpClient, renderHelperPrompt, toolDescription } from "@g-group/kernel";
import { createPiHelperMind, type PiHelperMindOptions } from "./helper-mind.ts";
import { createPiContactMind, PiContactMindError } from "./mind.ts";
import { TOOL_DECLARATIONS } from "./tools.ts";

const KEY = "sk-test-SECRET-helper-5b1e";
const MODEL = "helper-model-1";
const BASE = "http://fake-anthropic.invalid";

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface Body { model: string; system?: Block[]; tools?: { name: string; description?: string; input_schema?: unknown }[]; messages: { role: string; content: string | Block[] }[] }
interface Seen { headers: Headers; body: Body }
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] } | { readonly status: number; readonly error: unknown };

function fakeAnthropic(turns: readonly Turn[]) {
  const seen: Seen[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push({ headers: req.headers, body: JSON.parse(await req.text()) as Body });
    const t = turns[n - 1] ?? { text: "(脚本已用完)" };
    if ("status" in t) return new Response(JSON.stringify(t.error), { status: t.status, headers: { "content-type": "application/json" } });
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
type Fake = ReturnType<typeof fakeAnthropic>;
const opts = (fake: Fake, extra: Partial<PiHelperMindOptions> = {}): PiHelperMindOptions => ({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, fetch: fake.fetch, ...extra });
const SKILL = "# Helper 操作软件\n不可逆操作先问用户。NEUTRAL_FIXTURE_NO_CREDENTIALS";
const input = (over: Partial<HelperMindInput> = {}): HelperMindInput => ({
  model: MODEL,
  route: { entry: "sidebar", contextRoomId: "g1", replyToSeq: null },
  text: "帮我建个群叫 发布群,拉小克进来",
  context: "会话 g1「项目群」(group),成员:小克(c1)、用户(me)\n#3 用户:今天发布",
  history: [],
  skill: SKILL,
  ...over,
});
const live = () => new AbortController().signal;
/** Helper MCP(内核协议层)接一个按名字回结果的执行口;记下每个 MCP 请求与每次工具执行。 */
function mcp(answer: (name: string, args: unknown) => HelperToolResult) {
  const requests: string[] = [];
  const executed: { name: string; args: unknown }[] = [];
  const inner = memoryMcpClient(
    createHelperMcpServer({
      tools: HELPER_OPS,
      call: async (name, args) => {
        executed.push({ name, args });
        return answer(name, args);
      },
    }),
  );
  const client: McpClient = {
    request(method, params) {
      requests.push(method);
      return inner.request(method, params);
    },
  };
  return { client, requests, executed };
}
const texts = (c: string | Block[]) => (typeof c === "string" ? [c] : c.map((b) => b.text));

test("请求体:工具声明来自 Helper MCP 的 tools/list(名字、顺序、说明与清单一致,不可逆类标【先问用户】),system 含入口说明与 skill 原文,user 是当前聊天与这句话;文字回复即收尾", async () => {
  const fake = fakeAnthropic([{ text: "好的,我这就去办" }]);
  const m = mcp(() => ({ ok: true, text: "{}" }));
  const out = await createPiHelperMind(opts(fake)).run(input(), live(), m.client);
  assert.deepEqual(out, { reply: "好的,我这就去办", calls: [] });
  assert.deepEqual(m.requests, ["initialize", "tools/list"], "先 initialize 再 tools/list,没调工具");
  assert.equal(fake.seen.length, 1);
  const body = fake.seen[0]!.body;
  const prompt = renderHelperPrompt(input());
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.system?.map((b) => b.text), [prompt.system]);
  assert.ok(prompt.system.endsWith(SKILL), "skill 原文在系统提示里");
  assert.deepEqual(body.messages.map((x) => ({ role: x.role, texts: texts(x.content) })), [{ role: "user", texts: [prompt.user] }]);
  assert.deepEqual(body.tools?.map((t) => t.name), HELPER_OPS.map((o) => o.name));
  assert.deepEqual(body.tools?.map((t) => t.description), HELPER_OPS.map((o) => toolDescription(o)));
  assert.equal(body.tools?.find((t) => t.name === "contacts_remove")?.description, "【先问用户】删除一位联系人(不可恢复)。 不可逆或授权类:调用前先跟用户说清要做什么,等用户本人明确同意再调。");
  const rr = HELPER_OPS.find((o) => o.name === "read_room")!.params as { properties: unknown; required: unknown };
  const sent = body.tools?.find((t) => t.name === "read_room")?.input_schema as { type: string; properties: unknown; required: unknown };
  assert.deepEqual([sent.type, sent.properties, sent.required], ["object", rr.properties, rr.required], "参数 schema 照清单发出");
  assert.equal(fake.seen[0]!.headers.get("x-api-key"), KEY);
  assert.deepEqual(m.executed, []);
});

test("工具真执行:模型调的工具经 MCP tools/call 执行,结果回填(失败标 is_error)后继续请求,直到给出文字回复;调用记录按顺序", async () => {
  const members = [{ kind: "contact", id: "c1" }];
  const fake = fakeAnthropic([
    { text: "先查人", calls: [{ name: "contacts_list", input: {} }] },
    { calls: [{ name: "rooms_createGroup", input: { title: "发布群", members } }, { name: "plugins_uninstall", input: { pluginId: "p9" } }] },
    { text: "建好了发布群;卸插件没成" },
  ]);
  const m = mcp((name) => (name === "contacts_list" ? { ok: true, text: '{"contacts":[{"id":"c1","name":"小克"}]}' } : name === "rooms_createGroup" ? { ok: true, text: '{"id":"g9"}' } : { ok: false, text: "卸载插件失败(not_found)" }));
  const out = await createPiHelperMind(opts(fake)).run(input(), live(), m.client);
  assert.deepEqual(m.requests, ["initialize", "tools/list", "tools/call", "tools/call", "tools/call"]);
  assert.deepEqual(m.executed, [
    { name: "contacts_list", args: {} },
    { name: "rooms_createGroup", args: { title: "发布群", members } },
    { name: "plugins_uninstall", args: { pluginId: "p9" } },
  ]);
  assert.deepEqual(out, {
    reply: "建好了发布群;卸插件没成",
    calls: [
      { name: "contacts_list", args: {}, ok: true, text: '{"contacts":[{"id":"c1","name":"小克"}]}' },
      { name: "rooms_createGroup", args: { title: "发布群", members }, ok: true, text: '{"id":"g9"}' },
      { name: "plugins_uninstall", args: { pluginId: "p9" }, ok: false, text: "卸载插件失败(not_found)" },
    ],
  });
  assert.equal(fake.seen.length, 3);
  const second = fake.seen[1]!.body;
  assert.equal(second.messages.length, 3, "第二次请求 = 原 user + 本次的工具调用与结果");
  const r1 = second.messages[2]!.content as Block[];
  assert.deepEqual(r1.map((b) => [b.type, JSON.stringify(b.content).includes("小克"), b.is_error === true]), [["tool_result", true, false]]);
  const r2 = fake.seen[2]!.body.messages[4]!.content as Block[];
  assert.deepEqual(r2.map((b) => [b.type, b.is_error === true]), [["tool_result", false], ["tool_result", true]]);
  assert.match(JSON.stringify(r2[1]!.content), /卸载插件失败\(not_found\)/);
  assert.deepEqual(fake.seen[2]!.body.system?.map((b) => b.text), second.system?.map((b) => b.text), "system 不变");
});

test("到请求上限模型仍在调工具整次失败(request-limit);模型不一致一次都不发、也不碰 MCP(model-mismatch);端点报错 provider-error 且密钥不出现在错误信息里;bearer 认证", async () => {
  const loop = fakeAnthropic([{ calls: [{ name: "contacts_list", input: {} }] }, { calls: [{ name: "contacts_list", input: {} }] }, { calls: [{ name: "contacts_list", input: {} }] }]);
  const m = mcp(() => ({ ok: true, text: "[]" }));
  await assert.rejects(createPiHelperMind(opts(loop, { maxRequestsPerRound: 2 })).run(input(), live(), m.client), (e: unknown) => e instanceof PiContactMindError && e.code === "request-limit" && e.message === "这次已发 2 次请求,模型仍在调工具;上限 2");
  assert.equal(loop.seen.length, 2);

  const quiet = fakeAnthropic([{ text: "不该发出" }]);
  const q = mcp(() => ({ ok: true, text: "" }));
  await assert.rejects(createPiHelperMind(opts(quiet)).run(input({ model: "other-model" }), live(), q.client), (e: unknown) => e instanceof PiContactMindError && e.code === "model-mismatch");
  assert.deepEqual([quiet.seen.length, q.requests.length], [0, 0], "模型不一致一次都不发");

  const boom = fakeAnthropic([{ status: 401, error: { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } } }]);
  await assert.rejects(createPiHelperMind(opts(boom)).run(input(), live(), m.client), (e: unknown) => {
    assert.ok(e instanceof PiContactMindError);
    assert.equal(e.code, "provider-error");
    assert.equal(e.message.includes(KEY), false, "密钥不出现在错误信息里");
    assert.match(e.message, /\[密钥已隐去\]/);
    return true;
  });
  assert.throws(() => createPiHelperMind({ ...opts(boom), apiKey: "" }), (e: unknown) => e instanceof PiContactMindError && e.code === "invalid-options" && e.message === "createPiHelperMind 选项不合格:apiKey 必须是非空字符串");

  const bearer = fakeAnthropic([{ text: "好" }]);
  await createPiHelperMind(opts(bearer, { authHeader: "bearer" })).run(input(), live(), m.client);
  assert.deepEqual([bearer.seen[0]!.headers.get("authorization"), bearer.seen[0]!.headers.get("x-api-key")], [`Bearer ${KEY}`, null]);
});

test("U05:软件操作工具只在 Helper 身上——Helper 请求体带全清单,普通联系人的工具清单与它不相交(工具名与对应方法都不重叠),联系人实际请求体里没有任何 Helper 工具和 skill", async () => {
  const helperFake = fakeAnthropic([{ text: "好" }]);
  await createPiHelperMind(opts(helperFake)).run(input(), live(), mcp(() => ({ ok: true, text: "{}" })).client);
  const helperSent = helperFake.seen[0]!.body.tools?.map((t) => t.name) ?? [];
  assert.ok(helperSent.length >= 60, `Helper 请求体只有 ${helperSent.length} 个工具`);
  assert.deepEqual(helperSent, HELPER_OPS.map((o) => o.name));
  const helperNames = new Set(HELPER_OPS.flatMap((o) => [o.name, o.method, o.method.replace(".", "_")]));
  const contactNames = TOOL_DECLARATIONS.map((d) => d.name);
  assert.deepEqual(contactNames.filter((n) => helperNames.has(n)), []);
  const fake = fakeAnthropic([{ text: "看过了" }]);
  const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
  await createPiContactMind({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, fetch: fake.fetch }).round(
    { contact: { id: "c1", name: "小克", speakingModel: MODEL, persona: "人设" }, request: { blocks: NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `第${n}块`, cacheBreakpoint: n === 1 })), basedOnSeq: {} }, fresh: [] },
    live(),
  );
  const body = fake.seen[0]!.body;
  const sent = body.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(sent, contactNames);
  assert.deepEqual(sent.filter((n) => helperNames.has(n)), [], "联系人请求体里出现了 Helper 工具");
  assert.equal(JSON.stringify(body).includes("Helper 操作软件"), false, "联系人请求体里没有 Helper 的 skill");
});
