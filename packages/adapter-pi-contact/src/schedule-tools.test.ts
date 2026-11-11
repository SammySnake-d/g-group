// 联系人自设定时的四个工具(U20、AC-35①;D02 窄接口形态是候选):schedule_set / schedule_pause / schedule_remove 只登记动作,
// schedule_list 经宿主给的本轮查询口只读。工具只校验形状;会话、来源是不是用户本人、是不是自己的定时都由宿主核对。
// 假端点同 mind.test.ts:进程内的 Anthropic Messages 兼容 SSE,经 opts.fetch 注入,不连网。
import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_LABELS, type BlockNo, type RoundBlock, type RoundInput } from "@g-group/kernel";
import { createPiContactMind } from "./mind.ts";
import { PI_CONTACT_TOOL_NAMES, parseToolCall, TOOL_DECLARATIONS } from "./tools.ts";

const MODEL = "test-model-1";
type Call = { readonly name: string; readonly input: unknown };
interface Body { messages: { role: string; content: string | { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] }[] }

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
        let i = 0;
        if (!calls.length) {
          c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
          c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好了" } }));
          c.enqueue(sse("content_block_stop", { index: 0 }));
        }
        for (const call of calls) {
          c.enqueue(sse("content_block_start", { index: i, content_block: { type: "tool_use", id: `t${n}_${i}`, name: call.name, input: {} } }));
          c.enqueue(sse("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
          c.enqueue(sse("content_block_stop", { index: i }));
          i++;
        }
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

test("定时四件工具接在清单末尾:schedule_set、schedule_pause、schedule_remove、schedule_list;schedule_set 必填会话、来源 seq、做什么,其余可省", () => {
  assert.deepEqual(PI_CONTACT_TOOL_NAMES.slice(-4), ["schedule_set", "schedule_pause", "schedule_remove", "schedule_list"]);
  assert.deepEqual(TOOL_DECLARATIONS.slice(-4).map((d) => d.name), ["schedule_set", "schedule_pause", "schedule_remove", "schedule_list"]);
  const set = TOOL_DECLARATIONS.find((d) => (d.name as string) === "schedule_set")!.parameters as { required: string[]; properties: Record<string, { type: unknown; minimum?: number }>; additionalProperties: boolean };
  assert.deepEqual(set.required, ["roomId", "sourceSeq", "text"]);
  assert.deepEqual(Object.keys(set.properties).sort(), ["cron", "everyN", "roomId", "scheduleId", "sourceSeq", "text", "tz"]);
  assert.equal(set.additionalProperties, false);
  assert.deepEqual(set.properties.everyN, { ...set.properties.everyN, type: ["integer", "null"], minimum: 1 });
  const pause = TOOL_DECLARATIONS.find((d) => (d.name as string) === "schedule_pause")!.parameters as { required: string[] };
  assert.deepEqual(pause.required, ["roomId", "sourceSeq", "scheduleId"]);
  const list = TOOL_DECLARATIONS.find((d) => (d.name as string) === "schedule_list")!.parameters as { required: string[] };
  assert.deepEqual(list.required, ["roomId"]);
  // 清单里的四件都能按只给必填字段的最小参数登记(schedule_set 另需 cron 与 everyN 之一)
  const minimal: Record<string, unknown> = { schedule_set: { roomId: "g1", sourceSeq: 1, text: "x", everyN: 3 }, schedule_pause: { roomId: "g1", sourceSeq: 1, scheduleId: "s" }, schedule_remove: { roomId: "g1", sourceSeq: 1, scheduleId: "s" }, schedule_list: { roomId: "g1" } };
  assert.deepEqual(PI_CONTACT_TOOL_NAMES.slice(-4).map((name) => parseToolCall(name, minimal[name]).ok), [true, true, true, true]);
});

test("schedule_set 登记成 schedule-set 动作:cron 带时区或不带(null 交宿主补成用户设置的时区)、每 N 条消息、带 scheduleId 是改已有的", () => {
  assert.deepEqual(parseToolCall("schedule_set", { roomId: "g1", sourceSeq: 7, text: "总结昨天的讨论", cron: "0 8 * * *", tz: "Asia/Shanghai" }), {
    ok: true,
    value: { kind: "action", action: { kind: "schedule-set", roomId: "g1", sourceSeq: 7, text: "总结昨天的讨论", trigger: { kind: "cron", cron: "0 8 * * *", tz: "Asia/Shanghai" }, scheduleId: null } },
  });
  assert.deepEqual(parseToolCall("schedule_set", { roomId: "g1", sourceSeq: 7, text: "总结", cron: "0 9 * * *", scheduleId: "sch-1" }), {
    ok: true,
    value: { kind: "action", action: { kind: "schedule-set", roomId: "g1", sourceSeq: 7, text: "总结", trigger: { kind: "cron", cron: "0 9 * * *", tz: null }, scheduleId: "sch-1" } },
  });
  assert.deepEqual(parseToolCall("schedule_set", { roomId: "g1", sourceSeq: 3, text: "总结这一段", everyN: 100 }), {
    ok: true,
    value: { kind: "action", action: { kind: "schedule-set", roomId: "g1", sourceSeq: 3, text: "总结这一段", trigger: { kind: "every_n_messages", n: 100 }, scheduleId: null } },
  });
});

test("schedule_set 形状不对不登记:cron 与 everyN 必须且只能给一个、tz 只配 cron、everyN 是正整数、来源 seq 必填", () => {
  const bad = (args: unknown) => {
    const r = parseToolCall("schedule_set", args);
    assert.equal(r.ok, false, JSON.stringify(args));
    return r.ok ? "" : r.why;
  };
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", cron: "0 8 * * *", everyN: 5 }), /cron 与 everyN/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x" }), /cron 与 everyN/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", everyN: 5, tz: "UTC" }), /tz 只配 cron/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", everyN: 0 }), /everyN/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", everyN: 2.5 }), /everyN/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", everyN: "3" }), /everyN/);
  assert.match(bad({ roomId: "g1", text: "x", cron: "0 8 * * *" }), /缺字段 sourceSeq/);
  assert.match(bad({ roomId: "g1", sourceSeq: 7, text: "x", cron: "0 8 * * *", owner: "c-2" }), /多余字段 owner/);
  // 对照:同样的参数去掉毛病就能登记
  assert.equal(parseToolCall("schedule_set", { roomId: "g1", sourceSeq: 7, text: "x", everyN: 5 }).ok, true);
});

test("schedule_pause / schedule_remove 登记成动作,必须给来源 seq 与 scheduleId;schedule_list 只读,登记成查询", () => {
  assert.deepEqual(parseToolCall("schedule_pause", { roomId: "g1", sourceSeq: 9, scheduleId: "sch-1" }), { ok: true, value: { kind: "action", action: { kind: "schedule-pause", roomId: "g1", sourceSeq: 9, scheduleId: "sch-1" } } });
  assert.deepEqual(parseToolCall("schedule_remove", { roomId: "g1", sourceSeq: 10, scheduleId: "trg-2" }), { ok: true, value: { kind: "action", action: { kind: "schedule-remove", roomId: "g1", sourceSeq: 10, scheduleId: "trg-2" } } });
  assert.equal(parseToolCall("schedule_pause", { roomId: "g1", scheduleId: "sch-1" }).ok, false);
  assert.equal(parseToolCall("schedule_remove", { roomId: "g1", sourceSeq: 10 }).ok, false);
  assert.deepEqual(parseToolCall("schedule_list", { roomId: "g1" }), { ok: true, value: { kind: "read-schedules", roomId: "g1" } });
});

test("一轮里先 schedule_list 再 schedule_set:列表经宿主查询口原样作工具结果返回(不是动作),schedule_set 进本轮动作", async () => {
  const fake = fakeAnthropic([
    [{ name: "schedule_list", input: { roomId: "g1" } }],
    [{ name: "schedule_set", input: { roomId: "g1", sourceSeq: 8, text: "总结", cron: "0 9 * * *", scheduleId: "sch-1" } }],
    [],
  ]);
  const asked: string[] = [];
  const out = await createPiContactMind(opts(fake)).round(input(), new AbortController().signal, {
    readMemory: async () => null,
    listSchedules: async (roomId) => {
      asked.push(roomId);
      return "sch-1 每天 08:00(Asia/Shanghai) 启用:总结昨天的讨论";
    },
  });
  assert.deepEqual(asked, ["g1"]);
  assert.deepEqual(out.actions, [{ kind: "schedule-set", roomId: "g1", sourceSeq: 8, text: "总结", trigger: { kind: "cron", cron: "0 9 * * *", tz: null }, scheduleId: "sch-1" }]);
  const r = toolResults(fake.seen[1]!);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.isError, false);
  assert.match(r[0]!.text, /sch-1 每天 08:00\(Asia\/Shanghai\) 启用/);
});

test("schedule_list 查不到(不在这个会话)或宿主没给查询口:工具结果标错误,不当成空列表", async () => {
  const fake = fakeAnthropic([[{ name: "schedule_list", input: { roomId: "g9" } }], [{ name: "schedule_list", input: { roomId: "g1" } }], []]);
  const out = await createPiContactMind(opts(fake)).round(input(), new AbortController().signal, { readMemory: async () => null, listSchedules: async (roomId) => (roomId === "g1" ? "(本会话没有你的定时)" : null) });
  assert.deepEqual(out.actions, []);
  const [denied, empty] = [toolResults(fake.seen[1]!)[0]!, toolResults(fake.seen[2]!).at(-1)!];
  assert.equal(denied.isError, true);
  assert.match(denied.text, /g9/);
  assert.equal(empty.isError, false);
  assert.match(empty.text, /本会话没有你的定时/);
  const fake2 = fakeAnthropic([[{ name: "schedule_list", input: { roomId: "g1" } }], []]);
  await createPiContactMind(opts(fake2)).round(input(), new AbortController().signal);
  const none = toolResults(fake2.seen[1]!)[0]!;
  assert.equal(none.isError, true);
  assert.match(none.text, /没有定时查询口/);
});
