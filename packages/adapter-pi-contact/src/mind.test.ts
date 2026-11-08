// pi 联系人适配器的行为测试:用一个进程内的 Anthropic Messages 兼容假端点(SSE 流式)驱动,
// 经 opts.fetch 注入:请求仍由 pi-ai 的 Anthropic 适配(官方 SDK)照常构造,只把网络套接字换成函数,
// 所以门禁沙箱禁网时也能跑。假端点按脚本回放模型的文本或工具调用,并记下每次真实收到的请求体与请求头。
// 核对的是实际发出的请求体(D07 第 4 节第 8 条「核对实际发出的请求体,不只看宿主拼了什么」)。
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind, PiContactMindError, type PiContactMindOptions, RoundAbortedError, renderBlock } from "./mind.ts";
import { PI_CONTACT_TOOL_NAMES } from "./tools.ts";

const KEY = "sk-test-SECRET-7f3a9c";
const MODEL = "test-model-1";
const BASE = "http://fake-anthropic.invalid";

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; cache_control?: unknown }
interface Body { model: string; system?: Block[]; tools?: { name: string; cache_control?: unknown }[]; messages: { role: string; content: string | Block[] }[] }
interface Seen { url: string; headers: Headers; body: Body }
type Turn =
  | { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] }
  | { readonly status: number; readonly error: unknown }
  | { readonly hang: true };

function fakeAnthropic(turns: readonly Turn[]) {
  const seen: Seen[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Body });
    const t = turns[n - 1] ?? { text: "(脚本已用完)" };
    if ("status" in t) return new Response(JSON.stringify(t.error), { status: t.status, headers: { "content-type": "application/json" } });
    const start = sse("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    const end = (stop: string) => [sse("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }), sse("message_stop", {})];
    const signal = init?.signal ?? null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(start);
        if ("hang" in t) {
          // 停在半路等客户端中止;3 秒内没被中止就正常收尾,让「abort 没生效」表现为断言失败而不是测试卡死
          const late = setTimeout(() => { timers.delete(late); for (const x of end("end_turn")) c.enqueue(x); c.close(); }, 3000);
          timers.add(late);
          signal?.addEventListener("abort", () => { clearTimeout(late); timers.delete(late); c.error(signal.reason ?? new DOMException("aborted", "AbortError")); }, { once: true });
          return;
        }
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
        for (const x of end(t.calls?.length ? "tool_use" : "end_turn")) c.enqueue(x);
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return {
    fetch: fetchFn,
    seen,
    async close() {
      for (const x of timers) clearTimeout(x);
    },
  };
}
type Fake = ReturnType<typeof fakeAnthropic>;

const opts = (fake: Fake, extra: Partial<PiContactMindOptions> = {}): PiContactMindOptions => ({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, fetch: fake.fetch, ...extra });
const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
const blocks = (tag: string): RoundBlock[] => NUMS.map((n) => ({ block: n, label: BLOCK_LABELS[n], text: `${tag}-第${n}块内容`, cacheBreakpoint: n === 1 }));
const input = (tag: string, over: { blocks?: RoundBlock[]; speakingModel?: string } = {}): RoundInput => ({
  contact: { id: "c-xiaohou", name: "小后", speakingModel: over.speakingModel ?? MODEL, persona: "测试人设" },
  request: { blocks: over.blocks ?? blocks(tag), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const live = () => new AbortController().signal;
const texts = (c: string | Block[]) => (typeof c === "string" ? [c] : c.map((b) => b.text));
const until = async (cond: () => boolean) => { while (!cond()) await new Promise((r) => setTimeout(r, 5)); };

test("首个请求恰好是五块:第 1 块作 system 且带缓存断点,第 2–5 块按序在一条 user 消息里,工具只有七个具名工具", async () => {
  const fake = fakeAnthropic([{ text: "看过了,不用动作" }]);
  try {
    const out = await createPiContactMind(opts(fake)).round(input("r1"), live());
    assert.deepEqual(out, { actions: [], stateNote: null });
    assert.equal(fake.seen.length, 1);
    const body = fake.seen[0]!.body;
    assert.equal(body.model, MODEL);
    assert.deepEqual(body.system?.map((b) => b.text), ["r1-第1块内容"]);
    assert.deepEqual(body.system?.[0]?.cache_control, { type: "ephemeral" });
    assert.deepEqual(body.messages.map((m) => ({ role: m.role, texts: texts(m.content) })), [
      { role: "user", texts: [2, 3, 4, 5].map((n) => `<block n="${n}" label="${BLOCK_LABELS[n as BlockNo]}">\nr1-第${n}块内容\n</block>`) },
    ]);
    assert.deepEqual(body.tools?.map((t) => t.name), ["reply", "dispatch_compute", "commit", "forward", "deliver", "stop", "update_state_note"]);
    assert.deepEqual([...PI_CONTACT_TOOL_NAMES], body.tools?.map((t) => t.name));
    assert.equal(renderBlock(blocks("r1")[3]!), `<block n="4" label="新消息">\nr1-第4块内容\n</block>`);
  } finally {
    await fake.close();
  }
});

test("同一轮工具往返后的二次请求保留本轮的工具调用和结果,五块原样不重拼", async () => {
  const fake = fakeAnthropic([
    { text: "先回一句", calls: [{ name: "reply", input: { roomId: "g1", text: "收到,马上看", replyToSeq: 7 } }] },
    { text: "完事" },
  ]);
  try {
    const out = await createPiContactMind(opts(fake)).round(input("r1"), live());
    assert.deepEqual(out.actions, [{ kind: "reply", roomId: "g1", text: "收到,马上看", replyToSeq: 7 }]);
    assert.equal(fake.seen.length, 2);
    const [first, second] = fake.seen.map((s) => s.body) as [Body, Body];
    assert.deepEqual(second.system?.map((b) => b.text), first.system?.map((b) => b.text));
    assert.equal(second.messages.length, 3);
    assert.deepEqual(texts(second.messages[0]!.content), texts(first.messages[0]!.content));
    const [, asst, result] = second.messages as [unknown, { role: string; content: Block[] }, { role: string; content: Block[] }];
    assert.equal(asst.role, "assistant");
    assert.deepEqual(asst.content.map((b) => b.type), ["text", "tool_use"]);
    const call = asst.content[1]!;
    assert.deepEqual({ name: call.name, input: call.input }, { name: "reply", input: { roomId: "g1", text: "收到,马上看", replyToSeq: 7 } });
    assert.equal(result.role, "user");
    assert.equal(result.content.length, 1);
    const tr = result.content[0]!;
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, call.id);
    assert.notEqual(tr.is_error, true);
    assert.match(JSON.stringify(tr.content), /已登记/);
  } finally {
    await fake.close();
  }
});

test("七个工具的调用按出现顺序登记成对应的 MindAction 与状态笔记,状态笔记以最后一次为准", async () => {
  const fake = fakeAnthropic([
    {
      calls: [
        { name: "reply", input: { roomId: "dm:u1", text: "好的,我开个 Compute 去写" } },
        { name: "dispatch_compute", input: { roomId: "dm:u1", sourceSeq: 12, title: "写 hello.txt", task: "在 /tmp/x 下写 hello.txt,内容 hi" } },
        { name: "commit", input: { roomId: "dm:u1", sourceSeq: 12, text: "我开个 Compute 去写" } },
        { name: "update_state_note", input: { note: "旧笔记" } },
        { name: "forward", input: { taskId: "t-9", text: "用户补充:用 UTF-8" } },
        { name: "deliver", input: { taskId: "t-8", text: "报告已生成" } },
        { name: "stop", input: { taskId: "t-7" } },
        { name: "update_state_note", input: { note: "在等 t-9;下一步交付" } },
      ],
    },
    { text: "完事" },
  ]);
  try {
    const out = await createPiContactMind(opts(fake)).round(input("r1"), live());
    assert.deepEqual(out, {
      actions: [
        { kind: "reply", roomId: "dm:u1", text: "好的,我开个 Compute 去写", replyToSeq: null },
        { kind: "dispatch", roomId: "dm:u1", sourceSeq: 12, title: "写 hello.txt", task: "在 /tmp/x 下写 hello.txt,内容 hi" },
        { kind: "commit", roomId: "dm:u1", sourceSeq: 12, text: "我开个 Compute 去写", taskId: null },
        { kind: "forward", taskId: "t-9", text: "用户补充:用 UTF-8" },
        { kind: "deliver", taskId: "t-8", text: "报告已生成" },
        { kind: "stop", taskId: "t-7" },
      ],
      stateNote: "在等 t-9;下一步交付",
    });
    assert.ok(Object.isFrozen(out) && Object.isFrozen(out.actions));
    const results = (fake.seen[1]!.body.messages[2]!.content as Block[]);
    assert.equal(results.length, 8);
    assert.deepEqual(results.map((b) => b.is_error === true), Array(8).fill(false));
  } finally {
    await fake.close();
  }
});

test("参数不合形状的工具调用不登记,以错误结果告知模型;同批合格的照常登记", async () => {
  const fake = fakeAnthropic([
    {
      calls: [
        { name: "reply", input: { roomId: "g1" } },
        { name: "dispatch_compute", input: { roomId: "g1", sourceSeq: 3, title: "   ", task: "写文件" } },
        { name: "stop", input: { taskId: "t-1", force: true } },
        { name: "commit", input: { roomId: "g1", sourceSeq: -2, text: "我来" } },
        { name: "forward", input: { taskId: "t-1", text: "继续" } },
      ],
    },
    { text: "改好了" },
  ]);
  try {
    const out = await createPiContactMind(opts(fake)).round(input("r1"), live());
    assert.deepEqual(out.actions, [{ kind: "forward", taskId: "t-1", text: "继续" }]);
    const results = fake.seen[1]!.body.messages[2]!.content as Block[];
    assert.deepEqual(results.map((b) => b.is_error === true), [true, true, true, true, false]);
    const said = results.map((b) => JSON.stringify(b.content));
    assert.match(said[0]!, /text/);
    assert.match(said[1]!, /title 不能为空白/);
    assert.match(said[2]!, /force/);
    assert.match(said[3]!, /sourceSeq/);
    assert.match(said[4]!, /已登记/);
  } finally {
    await fake.close();
  }
});

test("每轮重拼:第二轮的请求里没有第一轮的任何消息,只有第二轮的五块", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "reply", input: { roomId: "g1", text: "第一轮的回复 ALPHA" } }] },
    { text: "第一轮结束" },
    { text: "第二轮看过了" },
  ]);
  try {
    const mind = createPiContactMind(opts(fake));
    const r1 = await mind.round(input("r1"), live());
    const r2 = await mind.round(input("r2"), live());
    assert.equal(r1.actions.length, 1);
    assert.deepEqual(r2, { actions: [], stateNote: null });
    assert.equal(fake.seen.length, 3);
    const third = fake.seen[2]!.body;
    const raw = JSON.stringify({ system: third.system, messages: third.messages });
    assert.doesNotMatch(raw, /r1-|ALPHA|第一轮/);
    assert.deepEqual(third.system?.map((b) => b.text), ["r2-第1块内容"]);
    assert.deepEqual(third.messages.map((m) => texts(m.content)), [[2, 3, 4, 5].map((n) => renderBlock(blocks("r2")[n - 1]!))]);
  } finally {
    await fake.close();
  }
});

test("signal 已中止时不发请求,直接抛 RoundAbortedError", async () => {
  const fake = fakeAnthropic([{ text: "不该被请求" }]);
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(createPiContactMind(opts(fake)).round(input("r1"), ac.signal), (e: unknown) => e instanceof RoundAbortedError && e.name === "AbortError" && e.code === "aborted");
    assert.equal(fake.seen.length, 0);
  } finally {
    await fake.close();
  }
});

test("请求进行中 abort:本轮立即放弃并抛 RoundAbortedError,已登记的动作不返回", async () => {
  const fake = fakeAnthropic([{ calls: [{ name: "reply", input: { roomId: "g1", text: "这条不该被返回" } }] }, { hang: true }]);
  try {
    const ac = new AbortController();
    const p = createPiContactMind(opts(fake)).round(input("r1"), ac.signal);
    await until(() => fake.seen.length === 2);
    const abortedAt = Date.now();
    ac.abort();
    await assert.rejects(p, (e: unknown) => e instanceof RoundAbortedError);
    // 假服务 3 秒后才会自己收尾;1.5 秒内结束说明是中止生效,不是等模型说完再丢结果
    assert.ok(Date.now() - abortedAt < 1500, `中止后 ${Date.now() - abortedAt}ms 才结束`);
    assert.equal(fake.seen.length, 2);
  } finally {
    await fake.close();
  }
});

test("apiKey 只出现在发给端点的请求头里,不出现在返回值、mind 对象和错误里", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "update_state_note", input: { note: "笔记" } }] },
    { text: "好" },
    { status: 401, error: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } } },
  ]);
  try {
    const mind = createPiContactMind(opts(fake));
    const out = await mind.round(input("r1"), live());
    assert.equal(out.stateNote, "笔记");
    assert.equal(fake.seen[0]!.headers.get("x-api-key"), KEY);
    assert.equal(fake.seen[0]!.headers.get("authorization"), null);
    assert.match(fake.seen[0]!.url, /^http:\/\/fake-anthropic\.invalid\/v1\/messages/);
    assert.ok(!JSON.stringify(out).includes(KEY));
    assert.ok(!inspect(mind, { depth: 10, showHidden: true }).includes(KEY));
    assert.ok(!JSON.stringify(mind).includes(KEY));
    const err = await mind.round(input("r2"), live()).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof PiContactMindError);
    assert.equal(err.code, "provider-error");
    assert.match(err.message, /401/);
    assert.match(err.message, /密钥已隐去/);
    assert.ok(!inspect(err, { depth: 10, showHidden: true }).includes(KEY));
    assert.ok(!JSON.stringify(err).includes(KEY));
  } finally {
    await fake.close();
  }
});

test("authHeader 为 bearer 时密钥放进 Authorization: Bearer,不发 x-api-key", async () => {
  const fake = fakeAnthropic([{ text: "好" }]);
  try {
    const out = await createPiContactMind(opts(fake, { authHeader: "bearer" })).round(input("r1"), live());
    assert.deepEqual(out, { actions: [], stateNote: null });
    assert.equal(fake.seen[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(fake.seen[0]!.headers.get("x-api-key"), null);
  } finally {
    await fake.close();
  }
});

test("五块不合格或说话模型对不上:整轮拒绝且不发请求", async () => {
  const fake = fakeAnthropic([{ text: "不该被请求" }]);
  try {
    const mind = createPiContactMind(opts(fake));
    const swapped = blocks("r1");
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof PiContactMindError ? e.code : String(e)));
    assert.equal(await code(mind.round(input("r1", { blocks: swapped }), live())), "invalid-request");
    assert.equal(await code(mind.round(input("r1", { blocks: blocks("r1").slice(0, 4) }), live())), "invalid-request");
    const wrongNo = blocks("r1").map((b) => (b.block === 2 ? { ...b, block: 3 as BlockNo } : b));
    assert.equal(await code(mind.round(input("r1", { blocks: wrongNo }), live())), "invalid-request");
    const badBreak = blocks("r1").map((b) => (b.block === 5 ? { ...b, cacheBreakpoint: true } : b));
    assert.equal(await code(mind.round(input("r1", { blocks: badBreak }), live())), "invalid-request");
    assert.equal(await code(mind.round(input("r1", { speakingModel: "other-model" }), live())), "model-mismatch");
    assert.equal(fake.seen.length, 0);
  } finally {
    await fake.close();
  }
});

test("选项不合格时 createPiContactMind 抛 invalid-options,错误里不带密钥", () => {
  const codeOf = (o: unknown) => {
    try {
      createPiContactMind(o as PiContactMindOptions);
      return "created";
    } catch (e) {
      assert.ok(!String(e).includes(KEY));
      return e instanceof PiContactMindError ? e.code : String(e);
    }
  };
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "http://127.0.0.1:1", apiKey: "" }), "invalid-options");
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "ftp://x", apiKey: KEY }), "invalid-options");
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "http://127.0.0.1:1", apiKey: KEY, api: "openai-completions" }), "invalid-options");
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "http://127.0.0.1:1", apiKey: KEY, shell: true }), "invalid-options");
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "http://127.0.0.1:1", apiKey: KEY, fetch: "http" }), "invalid-options");
  assert.equal(codeOf({ provider: "p", model: MODEL, baseUrl: "http://127.0.0.1:1", apiKey: KEY }), "created");
});

test("一轮请求数到上限模型仍在调工具:整轮以 request-limit 失败,不再发请求", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "reply", input: { roomId: "g1", text: "一" } }] },
    { calls: [{ name: "reply", input: { roomId: "g1", text: "二" } }] },
    { text: "不该被请求" },
  ]);
  try {
    const err = await createPiContactMind(opts(fake, { maxRequestsPerRound: 2 })).round(input("r1"), live()).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof PiContactMindError);
    assert.equal(err.code, "request-limit");
    assert.equal(fake.seen.length, 2);
  } finally {
    await fake.close();
  }
});

test("第 1 块 cacheBreakpoint 为 false 时请求里不设缓存断点", async () => {
  const fake = fakeAnthropic([{ text: "好" }]);
  try {
    const noCache = blocks("r1").map((b) => (b.block === 1 ? { ...b, cacheBreakpoint: false } : b));
    const out = await createPiContactMind(opts(fake)).round(input("r1", { blocks: noCache }), live());
    assert.deepEqual(out, { actions: [], stateNote: null });
    assert.doesNotMatch(JSON.stringify(fake.seen[0]!.body), /cache_control/);
  } finally {
    await fake.close();
  }
});
