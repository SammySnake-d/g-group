// G6 录制层:每次调用都记一条(含用量、停止原因、工具),按题集注入故障且不发上游,不记请求头,单次超时按 timeout 记。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutputParses, classifyCall, faultResponse, inboundLines, judgeCall, parseReply, parseRequest, recordingFetch, sseMessage } from "./capture.ts";
import { line } from "./fixtures/build.ts";

const URL_ = "http://gw.invalid/v1/messages?beta=true";
const body = (o: Record<string, unknown>) => JSON.stringify({ model: "m1", max_tokens: 4096, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }], ...o });
const ok = (text: string) => new Response(sseMessage({ model: "m1", blocks: [{ type: "text", text }], stopReason: "end_turn", usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } }), { status: 200, headers: { "content-type": "text/event-stream" } });

test("流式回复解析出用量、停止原因、文字与工具调用", () => {
  const sse = sseMessage({ model: "m1", blocks: [{ type: "text", text: "先说一句" }, { type: "tool_use", name: "reply", input: { roomId: "dm-1", text: "好" } }], stopReason: "tool_use", usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 5 } });
  const r = parseReply(sse);
  assert.deepEqual(r, { stopReason: "tool_use", usage: { input: 120, output: 30, cacheRead: 50, cacheWrite: 5 }, error: null, text: "先说一句", tools: [{ name: "reply", input: { roomId: "dm-1", text: "好" } }] });
  const once = parseReply(JSON.stringify({ type: "message", content: [{ type: "text", text: "整段" }], stop_reason: "max_tokens", usage: { input_tokens: 9, output_tokens: 4 } }));
  assert.deepEqual([once.text, once.stopReason, once.usage.input, once.usage.output], ["整段", "max_tokens", 9, 4]);
  assert.equal(parseReply(JSON.stringify({ type: "error", error: { message: "额度不足" } })).error, "额度不足");
});

test("请求体解析:system 数组、工具结果都进文字,带工具才算一轮", () => {
  const r = parseRequest(body({ system: [{ type: "text", text: "前缀" }], tools: [{ name: "reply" }], messages: [{ role: "user", content: [{ type: "text", text: "块" }] }, { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "已登记" }] }] }] }));
  assert.deepEqual(r, { model: "m1", maxTokens: 4096, hasTools: true, system: "前缀", request: "块\n已登记" });
  assert.equal(classifyCall(r), "round");
  assert.equal(classifyCall({ hasTools: false, system: '只输出 {"note", "memories": []}' }), "check");
  assert.equal(classifyCall({ hasTools: false, system: "你替一位联系人整理它的状态笔记" }), "compact");
  assert.equal(classifyCall({ hasTools: false, system: "精筛" }), "background");
  assert.equal(classifyCall({ hasTools: false, system: '你替一位联系人做记忆精筛:…只输出 {"memories": []}' }), "refine");
});

test("runner 自己判调用结果:检查要带 memories 的 JSON,截断与空输出都不算成功", () => {
  const pr = (text: string, stopReason = "end_turn") => ({ stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: null, text, tools: [] });
  assert.equal(judgeCall("check", 200, pr('{"note": null, "memories": []}')), "ok");
  assert.equal(judgeCall("check", 200, pr("好的,没有问题")), "parse_failure");
  assert.equal(judgeCall("check", 200, pr('{"memories": [')), "parse_failure");
  assert.equal(judgeCall("check", 200, pr("")), "empty");
  assert.equal(judgeCall("compact", 200, pr("半份笔记", "max_tokens")), "truncated");
  assert.equal(judgeCall("round", 529, pr("")), "http_error");
  assert.equal(judgeCall("round", 504, pr("")), "timeout");
  assert.equal(checkOutputParses('前言 {"memories": [{"title": "x"}]} 后记'), true);
  assert.equal(checkOutputParses('{"memories": "不是数组"}'), false);
});

test("宿主呈现格式的消息逐条读出,多行原文保留,段落标题处截断", () => {
  const text = `[本轮新输入(原文)]\n${line(3, "第一行\n第二行")}${line(4, "另一条", "g-2")}[联系人本轮动作]\n- reply`;
  assert.deepEqual(inboundLines(text), [
    { roomId: "dm-1", seq: 3, kind: "user", text: "第一行\n第二行" },
    { roomId: "g-2", seq: 4, kind: "user", text: "另一条" },
  ]);
  const debt = "dm-1 #3 rev=3 (user:me)\n以后周报都发到 weekly@corp.example\n\ng-2 #7 rev=9 (user:me)\n第二条\n两行\n\n收尾的一句不属于任何消息";
  assert.deepEqual(inboundLines(debt), [
    { roomId: "dm-1", seq: 3, kind: "user", text: "以后周报都发到 weekly@corp.example" },
    { roomId: "g-2", seq: 7, kind: "user", text: "第二条\n两行" },
  ]);
});

test("录制层逐次记账,按联系人与次序注入故障,注入的那次不发上游", async () => {
  let upstream = 0;
  const rec = recordingFetch({
    upstream: (async () => {
      upstream++;
      return ok('{"note": null, "memories": []}');
    }) as typeof fetch,
    contactOf: (t) => (t.includes("小甲") ? "A" : null),
    faults: [{ contact: "A", cls: "check", nth: 2, fault: "malformed" }],
  });
  const check = body({ system: '你是小甲的检查,只输出 {"memories": []}' });
  for (let i = 0; i < 3; i++) await (await rec.fetch(URL_, { method: "POST", body: check })).text();
  await rec.flush();
  assert.equal(upstream, 2);
  assert.deepEqual(rec.calls.map((c) => [c.n, c.contact, c.cls, c.outcome, c.fault]), [
    [1, "A", "check", "ok", null],
    [2, "A", "check", "parse_failure", "malformed"],
    [3, "A", "check", "ok", null],
  ]);
  assert.deepEqual(rec.calls[0]!.usage, { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 });
  assert.equal(rec.calls[1]!.usage.input, 0);
});

test("录制层不记请求头,网关令牌不进记录;非 messages 请求原样转发不记", async () => {
  const SECRET = "NEUTRAL_FIXTURE_NO_CREDENTIALS-令牌值";
  const seen: string[] = [];
  const rec = recordingFetch({
    upstream: (async (u: string | URL | Request) => {
      seen.push(String(u));
      return ok("好");
    }) as typeof fetch,
    contactOf: () => "A",
    faults: [],
  });
  await (await rec.fetch(URL_, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "x-api-key": SECRET }, body: body({ tools: [{ name: "reply" }] }) })).text();
  await (await rec.fetch("http://gw.invalid/v1/models", {})).text();
  await rec.flush();
  assert.equal(rec.calls.length, 1);
  assert.equal(JSON.stringify(rec.calls).includes(SECRET), false);
  assert.deepEqual(seen, [URL_, "http://gw.invalid/v1/models"]);
});

test("单次调用到 runner 上限按 timeout 记并把错误交还调用方", async () => {
  const rec = recordingFetch({
    upstream: ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch,
    contactOf: () => "A",
    faults: [],
    timeoutMs: 20,
  });
  await assert.rejects(rec.fetch(URL_, { method: "POST", body: body({}) }), /aborted/);
  await rec.flush();
  assert.deepEqual(rec.calls.map((c) => [c.status, c.outcome]), [[0, "timeout"]]);
});

test("注入的故障回复:400/529 不让 SDK 重试,截断按类区分文字,network 直接抛错", async () => {
  const e400 = faultResponse("http-400", "m", "check");
  assert.deepEqual([e400.status, e400.headers.get("x-should-retry")], [400, "false"]);
  assert.equal(faultResponse("http-529", "m", "round").status, 529);
  const cutCheck = parseReply(await faultResponse("truncated", "m", "check").text());
  const cutNote = parseReply(await faultResponse("truncated", "m", "compact").text());
  assert.deepEqual([cutCheck.stopReason, cutNote.stopReason], ["max_tokens", "max_tokens"]);
  assert.notEqual(cutCheck.text, cutNote.text);
  assert.equal(parseReply(await faultResponse("empty", "m", "check").text()).text, "");
  assert.throws(() => faultResponse("network", "m", "round"), /g6 注入的故障 network/);
});

test("一次一个调用:第二个调用等第一个读完正文才发出,排队时间记下;注入的故障不排队", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  const rec = recordingFetch({
    upstream: (async () => {
      const me = ++n;
      order.push(`start${me}`);
      if (me === 1) await gate;
      order.push(`end${me}`);
      return ok("好");
    }) as typeof fetch,
    contactOf: () => "A",
    faults: [{ contact: "A", cls: "round", nth: 3, fault: "http-400" }],
    serial: true,
  });
  const b = body({ tools: [{ name: "reply" }] });
  const p1 = rec.fetch(URL_, { method: "POST", body: b }).then((r) => r.text());
  const p2 = rec.fetch(URL_, { method: "POST", body: b }).then((r) => r.text());
  const p3 = rec.fetch(URL_, { method: "POST", body: b }).then((r) => r.status);
  assert.equal(await p3, 400);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ["start1"]);
  release();
  await Promise.all([p1, p2]);
  await rec.flush();
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
  const second = rec.calls.find((c) => c.n === 2)!;
  assert.ok(second.queuedMs >= 25, `排队 ${second.queuedMs}ms`);
  assert.equal(rec.calls.find((c) => c.n === 3)!.queuedMs, 0);
});
