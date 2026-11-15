// A5: 用真实 pi 联系人适配器与宿主,经进程内 Anthropic SSE 验证截断不会被记为成功。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createPiContactMind } from "@g-group/adapter-pi-contact";
import { one } from "./db.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-a5-length-"));
const hosts: Host[] = [];
after(async () => {
  for (const host of hosts) await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const model = "claude-sonnet-4-6";
const key = "test-only-secret-for-a5";
const encoder = new TextEncoder();
const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function response(stop: "max_tokens" | "end_turn" | "tool_use", roomId?: string, text = "不得提交的草稿"): Response {
  let body = event("message_start", { message: { id: "a5-message", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  if (roomId) {
    body += event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "a5-reply", name: "reply", input: {} } });
    body += event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ roomId, text }) } });
    body += event("content_block_stop", { index: 0 });
  }
  body += event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  body += event("message_stop", {});
  return new Response(encoder.encode(body), { headers: { "content-type": "text/event-stream" } });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("宿主未在时限内处理 A5 测试轮次");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let n = 0;
async function scenario(firstAction: boolean, truncated: boolean) {
  let requests = 0;
  let roomId = "";
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    if (firstAction && requests === 1) return response("tool_use", roomId);
    return response(truncated ? "max_tokens" : "end_turn");
  };
  const host = new Host({
    file: path.join(dir, `${++n}.db`),
    mind: () => createPiContactMind({ provider: "fake", model, baseUrl: "http://fake-anthropic.invalid", apiKey: key, fetch }),
    retry: { maxAutoRetries: 0, unknownMaxRetries: 0 },
    maxDeferMs: 5,
  });
  hosts.push(host);
  const c = host.createContact({ name: "A5 联系人" });
  roomId = host.createGroup("A5 群", [{ kind: "contact", id: c.id }]).id;
  const sent = host.send({ roomId, clientActionId: "a5-user", text: "请处理这条群消息", mentions: [{ id: c.id, source: "manual" }] });
  const cursor = () => one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", c.id, roomId)?.processed_seq ?? 0;
  const messages = () => host.listMessages(roomId, {}).messages;
  await until(() => cursor() >= sent.seq || messages().some((m) => m.card?.kind === "failure"));
  return { host, sent, cursor, messages, requests: () => requests };
}

test("A5 宿主:无动作 max_tokens 不推进群游标,进入失败流程", async () => {
  const s = await scenario(false, true);
  assert.equal(s.cursor(), 0, "截断不是成功,不能吞掉群消息");
  assert.equal(s.messages().filter((m) => m.card?.kind === "failure").length, 1);
  assert.equal(s.host.listTasks({}).length, 0);
  assert.equal(s.requests(), 1);
  assert.ok(!JSON.stringify(s.messages()).includes(key), "失败卡不得泄露 API key");
});

test("A5 宿主:动作后 max_tokens 整轮不提交,群游标不推进", async () => {
  const s = await scenario(true, true);
  assert.equal(s.cursor(), 0, "截断不是成功,不能吞掉群消息");
  assert.equal(s.messages().filter((m) => m.card?.kind === "failure").length, 1);
  assert.equal(s.messages().filter((m) => m.text === "不得提交的草稿").length, 0);
  assert.equal(s.requests(), 2);
  assert.ok(!JSON.stringify(s.messages()).includes(key), "失败卡不得泄露 API key");
});

test("A5 宿主:正常 end_turn 空回合照常成功并推进游标", async () => {
  const s = await scenario(false, false);
  assert.equal(s.cursor(), s.sent.seq);
  assert.equal(s.messages().filter((m) => m.card?.kind === "failure").length, 0);
  assert.equal(s.requests(), 1);
});

test("A5 宿主:默认未知失败上限一次重试,恢复时原消息仍被处理且不换模型预算", async () => {
  let roomId = "";
  const bodies: { model: string; max_tokens: number; messages: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    bodies.push(JSON.parse(await req.text()) as (typeof bodies)[number]);
    if (bodies.length === 1) return response("max_tokens");
    if (bodies.length === 2) return response("tool_use", roomId, "重试后收到");
    return response("end_turn");
  };
  const host = new Host({
    file: path.join(dir, `${++n}.db`),
    mind: () => createPiContactMind({ provider: "fake", model, baseUrl: "http://fake-anthropic.invalid", apiKey: key, fetch }),
    retry: { baseDelayMs: 5, maxDelayMs: 5, jitter: 0 },
    maxDeferMs: 5,
  });
  hosts.push(host);
  const c = host.createContact({ name: "A5 重试联系人" });
  roomId = host.createGroup("A5 重试群", [{ kind: "contact", id: c.id }]).id;
  const sent = host.send({ roomId, clientActionId: "a5-retry", text: "重试不得丢失的消息", mentions: [{ id: c.id, source: "manual" }] });
  const messages = () => host.listMessages(roomId, {}).messages;
  await until(() => messages().some((m) => m.text === "重试后收到"));
  await host.idle();
  const cursor = one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", c.id, roomId)?.processed_seq ?? 0;
  assert.equal(cursor, sent.seq);
  assert.equal(messages().filter((m) => m.text === "重试后收到").length, 1);
  assert.equal(messages().filter((m) => m.card?.kind === "failure").length, 0);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((b) => [b.model, b.max_tokens]), [[model, 4096], [model, 4096], [model, 4096]]);
  assert.match(JSON.stringify(bodies[1]!.messages), /重试不得丢失的消息/);
  assert.ok(!JSON.stringify(messages()).includes(key));
});

test("A5 宿主:持续截断按默认未知失败上限只重试一次,不推进游标", async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return response("max_tokens"); };
  const host = new Host({
    file: path.join(dir, `${++n}.db`),
    mind: () => createPiContactMind({ provider: "fake", model, baseUrl: "http://fake-anthropic.invalid", apiKey: key, fetch }),
    retry: { baseDelayMs: 5, maxDelayMs: 5, jitter: 0 },
    maxDeferMs: 5,
  });
  hosts.push(host);
  const c = host.createContact({ name: "A5 失败联系人" });
  const roomId = host.createGroup("A5 失败群", [{ kind: "contact", id: c.id }]).id;
  host.send({ roomId, clientActionId: "a5-exhausted", text: "保留的消息", mentions: [{ id: c.id, source: "manual" }] });
  const messages = () => host.listMessages(roomId, {}).messages;
  await until(() => messages().some((m) => m.card?.kind === "failure"));
  await host.idle();
  const cursor = one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", c.id, roomId)?.processed_seq ?? 0;
  assert.equal(cursor, 0);
  assert.equal(requests, 2);
  assert.equal(messages().filter((m) => m.card?.kind === "failure").length, 1);
  assert.ok(!JSON.stringify(messages()).includes(key));
});
