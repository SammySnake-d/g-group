// pi 适配器的用量回报与缓存断点(AC-39 ③⑤、D22 第 3 节第 3、7 条)。
// 进程内 Anthropic Messages 兼容假端点(经 opts.fetch 注入,不连网)按脚本回放模型输出,并在 message_start / message_delta 里带 usage;
// 核对的是实际发出的请求体与交给宿主回执口的内容:每次请求一条、数字取自端点、线路不含网关路径里的令牌段、断点 ≤ 4 且位置正确。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type CompactRequest, type ModelUsage, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiCompactor } from "./compact.ts";
import { createPiContactMind } from "./mind.ts";
import { usageLine } from "./usage.ts";

const KEY = "sk-NEUTRAL_FIXTURE_NO_CREDENTIALS-k3y";
const MODEL = "test-model-1";
// 本机网关的形状:令牌放在 URL 路径里。线路只能留主机名
const TOKEN_SEGMENT = "NEUTRAL_TOKEN_SEGMENT_9f2c";
const BASE = `http://gw.example.invalid:52247/${TOKEN_SEGMENT}/v1`;
const LINE = `fake|gw.example.invalid|${MODEL}`;

interface Block { type: string; text?: string; cache_control?: unknown }
interface Body { model: string; system?: Block[]; tools?: { name: string; cache_control?: unknown }[]; messages: { role: string; content: string | Block[] }[] }
interface Use { input: number; cacheRead: number; cacheWrite: number; output: number }
type Turn = { readonly text?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[]; readonly usage?: Use };

function fakeAnthropic(turns: readonly Turn[]) {
  const seen: Body[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const n = seen.push(JSON.parse(await req.text()) as Body);
    const t = turns[n - 1] ?? { text: "(脚本已用完)" };
    const u = t.usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u.input, output_tokens: 0, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite } } }));
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
        c.enqueue(sse("message_delta", { delta: { stop_reason: t.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: u.output } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetchFn, seen };
}

const NUMS: readonly BlockNo[] = [1, 2, 3, 4, 5];
const input = (tag: string): RoundInput => ({
  contact: { id: "c-xiaohou", name: "小后", speakingModel: MODEL, persona: "测试人设" },
  request: { blocks: NUMS.map((n): RoundBlock => ({ block: n, label: BLOCK_LABELS[n], text: `${tag}-第${n}块内容`, cacheBreakpoint: n === 1 })), basedOnSeq: { g1: 7 } },
  fresh: [],
});
const live = () => new AbortController().signal;
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x), "utf8").digest("hex");
/** 请求体里每个 cache_control 的位置 */
function marks(b: Body): string[] {
  const out: string[] = [];
  for (const [i, t] of (b.tools ?? []).entries()) if ("cache_control" in t) out.push(`tools[${i}]`);
  for (const [i, s] of (b.system ?? []).entries()) if ("cache_control" in s) out.push(`system[${i}]`);
  for (const [i, m] of b.messages.entries()) if (Array.isArray(m.content)) for (const [j, c] of m.content.entries()) if ("cache_control" in c) out.push(`messages[${i}][${j}]`);
  return out;
}
const lastBlockOf = (b: Body) => {
  const i = b.messages.length - 1;
  const c = b.messages[i]!.content;
  return `messages[${i}][${Array.isArray(c) ? c.length - 1 : 0}]`;
};

test("每次请求回报一条用量:四项取自端点回的 usage;工具往返的两次请求序号 1、2,固定前缀哈希相同且等于实际请求体(工具声明 + system)的 sha256", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "update_state_note", input: { note: "在做:测试" } }], usage: { input: 1200, cacheRead: 0, cacheWrite: 5300, output: 40 } },
    { text: "完事", usage: { input: 30, cacheRead: 6500, cacheWrite: 1210, output: 7 } },
  ]);
  const got: ModelUsage[] = [];
  const out = await createPiContactMind({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, fetch: fake.fetch }).round(input("u1"), live(), undefined, (u) => got.push(u));
  assert.equal(out.stateNote, "在做:测试");
  assert.equal(fake.seen.length, 2);
  const [b1, b2] = fake.seen as [Body, Body];
  const prefix = sha({ tools: b1.tools, system: b1.system });
  assert.equal(sha({ tools: b2.tools, system: b2.system }), prefix, "同一轮两次请求的固定前缀逐字节相同");
  assert.deepEqual(got, [
    { line: LINE, request: 1, prefixHash: prefix, breakpoints: marks(b1).length, input: 1200, cacheRead: 0, cacheWrite: 5300, output: 40 },
    { line: LINE, request: 2, prefixHash: prefix, breakpoints: marks(b2).length, input: 30, cacheRead: 6500, cacheWrite: 1210, output: 7 },
  ]);
});

test("线路标识只含服务商、主机名与模型:网关路径里的令牌段、端口、查询串、用户名口令与密钥都不进线路", async () => {
  const fake = fakeAnthropic([{ text: "好", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }]);
  const got: ModelUsage[] = [];
  await createPiContactMind({ provider: "fake", model: MODEL, baseUrl: `${BASE}?k=NEUTRAL_QUERY`, apiKey: KEY, authHeader: "bearer", fetch: fake.fetch }).round(input("u2"), live(), undefined, (u) => got.push(u));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.line, LINE);
  const all = JSON.stringify(got);
  for (const s of [TOKEN_SEGMENT, "52247", "NEUTRAL_QUERY", KEY]) assert.equal(all.includes(s), false, `线路里不该有 ${s}`);
  assert.equal(usageLine("fake", "https://someone:NEUTRAL_PW@gw.example.invalid:8443/a/b", MODEL, KEY), LINE);
  assert.equal(usageLine(`fake-${KEY}`, BASE, MODEL, KEY), `fake-[密钥已隐去]|gw.example.invalid|${MODEL}`);
});

test("实际请求体的 cache_control 不超过 4 个:只在工具声明末尾、第 1 块(system)末尾与最后一条消息末尾;工具往返后的请求同样;回报的断点数等于请求体里实际的个数", async () => {
  const fake = fakeAnthropic([
    { calls: [{ name: "read_memory", input: { id: "m-1" } }], usage: { input: 900, cacheRead: 0, cacheWrite: 4000, output: 12 } },
    { text: "完事", usage: { input: 20, cacheRead: 4900, cacheWrite: 60, output: 3 } },
  ]);
  const got: ModelUsage[] = [];
  const tools = { readMemory: async () => "记忆 m-1 全文" };
  const out = await createPiContactMind({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, fetch: fake.fetch }).round(input("u3"), live(), tools, (u) => got.push(u));
  assert.deepEqual(out, { actions: [], stateNote: null }, "读记忆不是动作");
  assert.equal(fake.seen.length, 2);
  for (const [i, b] of fake.seen.entries()) {
    const m = marks(b);
    assert.ok(m.length <= 4, `第 ${i + 1} 次请求有 ${m.length} 个断点`);
    assert.deepEqual(m, [`tools[${b.tools!.length - 1}]`, `system[${b.system!.length - 1}]`, lastBlockOf(b)], `第 ${i + 1} 次请求的断点位置`);
    assert.equal(got[i]!.breakpoints, m.length);
  }
  assert.equal(fake.seen[1]!.messages.length, 3, "第二次请求带着本轮的工具调用与结果,断点在最新追加的那条末尾");
});

const compactReq = (over: Partial<CompactRequest> = {}): CompactRequest => ({
  contact: { id: "c-1", name: "小克", speakingModel: MODEL, persona: "说话简短" },
  kind: "round-note",
  previous: "旧笔记",
  material: "[本轮新输入(原文)]\n改成按长度排\n",
  maxBytes: 2000,
  ...over,
});

test("压缩(补写、缩写)与检查每次请求各回报一条用量:序号 1、不带缓存断点、线路不含令牌段;四项全 0 不回报;回执口抛错不影响压缩结果", async () => {
  const fake = fakeAnthropic([
    { text: "新笔记", usage: { input: 700, cacheRead: 0, cacheWrite: 0, output: 30 } },
    { text: "短笔记", usage: { input: 300, cacheRead: 0, cacheWrite: 0, output: 9 } },
    { text: '{"note":null,"memories":[],"personaSuggestion":null}', usage: { input: 1500, cacheRead: 0, cacheWrite: 0, output: 20 } },
    { text: "没回用量" },
    { text: "回执口坏了也照常", usage: { input: 50, cacheRead: 0, cacheWrite: 0, output: 4 } },
  ]);
  const got: ModelUsage[] = [];
  const k = createPiCompactor({ provider: "fake", model: MODEL, baseUrl: BASE, apiKey: KEY, authHeader: "bearer", fetch: fake.fetch });
  assert.equal(await k.compact(compactReq(), live(), (u) => got.push(u)), "新笔记");
  assert.equal(await k.compact(compactReq({ kind: "shrink", previous: "很长的笔记", material: "" }), live(), (u) => got.push(u)), "短笔记");
  const r = await k.reflect!({ ...compactReq(), neighbors: [], noteWritten: "模型自己写的" }, live(), (u) => got.push(u));
  assert.deepEqual(r.memories, []);
  assert.equal(await k.compact(compactReq(), live(), (u) => got.push(u)), "没回用量");
  assert.equal(await k.compact(compactReq(), live(), () => { throw new Error("回执口坏了"); }), "回执口坏了也照常");
  assert.equal(fake.seen.length, 5);
  for (const b of fake.seen) assert.deepEqual(marks(b), [], "压缩与检查不设缓存断点");
  assert.deepEqual(
    got.map((u) => [u.line, u.request, u.breakpoints, u.input, u.cacheRead, u.cacheWrite, u.output, u.prefixHash]),
    [
      [LINE, 1, 0, 700, 0, 0, 30, sha({ tools: null, system: fake.seen[0]!.system })],
      [LINE, 1, 0, 300, 0, 0, 9, sha({ tools: null, system: fake.seen[1]!.system })],
      [LINE, 1, 0, 1500, 0, 0, 20, sha({ tools: null, system: fake.seen[2]!.system })],
    ],
    "四项全 0 的那次不回报",
  );
});
