import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { test, type TestContext } from "node:test";
import { ATTACHMENT_UPLOAD_IPC_BYTES, ATTACHMENT_UPLOAD_LIMITS, API_VERSION, checkEvent, checkResult, type ServerEvent } from "@g-group/api-contract";
import { WebSocket, type ClientOptions } from "ws";
import { one } from "./db.ts";
import { createBus } from "./bus.ts";
import { createHttpWsBridge, serveHttpWs, type HttpWsOptions } from "./http-ws.ts";
import { startServer } from "./start.ts";

async function fixture(t: TestContext, createBridge: typeof createHttpWsBridge, options: HttpWsOptions = {}, capacity = 2000) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1c-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = await startServer({ dataDir: dir });
  t.after(() => started.close());
  const bus = capacity === 2000 ? started.host.bus : createBus(() => new Date().toISOString(), capacity);
  let subscriptions = 0;
  // Real bus with a counted public subscription boundary, independent of transport internals.
  const bridge = await createBridge({ host: started.host, service: {
    handle: (method, params) => started.service.handle(method, params),
    subscribe: (listener, since) => {
      subscriptions++;
      const off = bus.subscribe(listener, since);
      let active = true;
      return () => { if (active) { active = false; subscriptions--; off(); } };
    },
  } }, { ...options, port: 0 });
  t.after(() => bridge.close());
  return { ...bridge, started, bus, subscriptions: () => subscriptions };
}
async function post(base: string, method: string, params: unknown = { clientApiVersion: API_VERSION }, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/invoke`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ method, params }) });
}
async function socket(t: TestContext, url: string, options: ClientOptions = {}) {
  const ws = new WebSocket(url, options);
  const events: ServerEvent[] = [];
  ws.on("message", data => events.push(JSON.parse(String(data))));
  t.after(() => ws.terminate());
  await once(ws, "open");
  return { ws, events };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "condition completed within deadline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function rejected(url: string, expected: number, headers?: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { ...(headers ? { headers } : {}) });
    ws.on("error", () => {});
    ws.on("open", () => { ws.terminate(); reject(new Error("unexpected WS authorization")); });
    ws.on("unexpected-response", (_req, response) => {
      response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
  });
}

test("P1-C HTTP contract: hello, contact, DM and message round trip", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  const { events } = await socket(t, b.wsUrl);
  const hello = await post(b.httpUrl, "session.hello");
  assert.equal(hello.status, 200);
  assert.match(hello.headers.get("content-type") ?? "", /application\/json/);
  const h = await hello.json();
  assert.equal(h.ok, true); assert.equal(checkResult("session.hello", h.value).ok, true);
  const c = await (await post(b.httpUrl, "contacts.create", { clientActionId: "http-contact", name: "HTTP contact" })).json();
  assert.equal(c.ok, true); assert.equal(checkResult("contacts.create", c.value).ok, true);
  const room = await (await post(b.httpUrl, "rooms.openDm", { contactId: c.value.id })).json();
  assert.equal(room.ok, true);
  const message = await (await post(b.httpUrl, "messages.send", { roomId: room.value.id, clientActionId: "http-message", text: "hello" })).json();
  assert.equal(message.ok, true); assert.equal(checkResult("messages.send", message.value).ok, true);
  assert.equal(b.started.host.listMessages(room.value.id, {}).messages[0]?.text, "hello");
  await until(() => events.some(e => e.type === "message.appended"));
  assert.ok(events.every(e => checkEvent(e).ok));
  const health = await (await fetch(`${b.httpUrl}/api/health`)).json();
  assert.deepEqual(health, { ok: true, apiVersion: API_VERSION, eventSeq: b.started.host.bus.head() });
});

test("P1-C upload: near 35 MB base64 accepted; oversized declared and streamed bodies return 413", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  const base64 = Buffer.alloc(25 * 1024 * 1024).toString("base64");
  assert.ok(base64.length <= ATTACHMENT_UPLOAD_LIMITS.base64 && base64.length > 34_900_000);
  const res = await post(b.httpUrl, "attachments.upload", { name: "big.bin", base64 });
  assert.equal(res.status, 200);
  const uploaded = await res.json(); assert.equal(uploaded.ok, true);
  assert.equal(checkResult("attachments.upload", uploaded.value).ok, true);
  const tooLarge = "x".repeat(ATTACHMENT_UPLOAD_IPC_BYTES + 4097);
  const oversized = await fetch(`${b.httpUrl}/api/invoke`, { method: "POST", body: tooLarge });
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, "invalid_params");
  const streamed = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(`${b.httpUrl}/api/invoke`, { method: "POST" }, res => {
      let body = ""; res.on("data", data => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.write(tooLarge); req.end();
  });
  assert.equal(streamed.status, 413); assert.equal(JSON.parse(streamed.body).error.code, "invalid_params");
  assert.equal((await post(b.httpUrl, "session.hello")).status, 200);
});

test("P1-C malformed envelopes return 400; unknown RPC and paths preserve JSON errors", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  for (const body of ["{", "null", "[]", "42", '"method"', '{}', '{"method":42}']) {
    const res = await fetch(`${b.httpUrl}/api/invoke`, { method: "POST", body });
    assert.equal(res.status, 400); assert.equal((await res.json()).error.code, "invalid_params");
  }
  assert.equal((await (await post(b.httpUrl, "missing.method")).json()).error.code, "unknown_method");
  for (const route of ["/missing", "/api/events", "/api/invoke"]) {
    const res = await fetch(`${b.httpUrl}${route}`);
    assert.equal(res.status, 404); assert.equal((await res.json()).error.code, "not_found");
  }
  await rejected(`${b.wsUrl.replace('/api/events', '/missing')}`, 404);
});

test("P1-C CORS: preflight, loopback only defaults, explicit origins and wildcard", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:8000"]) {
    const res = await fetch(`${b.httpUrl}/api/invoke`, { method: "OPTIONS", headers: { Origin: origin } });
    assert.equal(res.status, 204); assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-methods"), "POST, GET, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
    assert.match(res.headers.get("vary") ?? "", /Origin/);
  }
  for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "file://"]) {
    const res = await post(b.httpUrl, "contacts.create", { clientActionId: "blocked-contact", name: "blocked" }, { Origin: origin });
    assert.equal(res.status, 403); assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(b.started.host.listContacts().some(c => c.name === "blocked"), false);
  const explicit = await fixture(t, createHttpWsBridge, { corsOrigins: ["https://app.example", "null"] });
  assert.equal((await post(explicit.httpUrl, "session.hello", { clientApiVersion: API_VERSION }, { Origin: "https://app.example" })).headers.get("access-control-allow-origin"), "https://app.example");
  const wildcard = await fixture(t, createHttpWsBridge, { corsOrigins: ["*"] });
  assert.equal((await post(wildcard.httpUrl, "session.hello", { clientApiVersion: API_VERSION }, { Origin: "https://else.example" })).headers.get("access-control-allow-origin"), "*");
});

test("P1-C auth: HTTP and WS reject missing/wrong tokens; header/query accepted without leaks", { timeout: 10_000 }, async t => {
  const token = "private + / token";
  const b = await fixture(t, createHttpWsBridge, { token });
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Basic ${token}` }]) {
    const res = await post(b.httpUrl, "session.hello", { clientApiVersion: API_VERSION }, headers);
    assert.equal(res.status, 401); const body = await res.text();
    assert.equal(JSON.parse(body).ok, false); assert.equal(body.includes(token), false);
  }
  assert.equal((await (await post(b.httpUrl, "session.hello", { clientApiVersion: API_VERSION }, { Authorization: `Bearer ${token}` })).json()).ok, true);
  const health = await (await fetch(`${b.httpUrl}/api/health`)).json();
  assert.deepEqual(health, { ok: true });
  await rejected(b.wsUrl, 401); await rejected(`${b.wsUrl}?token=wrong`, 401);
  await socket(t, `${b.wsUrl}?token=${encodeURIComponent(token)}`);
  await socket(t, b.wsUrl, { headers: { Authorization: `Bearer ${token}` } });
  await rejected(`${b.wsUrl}?token=${encodeURIComponent(token)}`, 403, { Origin: "https://evil.example" });
  assert.equal((await fetch(`${b.httpUrl}/api/invoke`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } })).status, 204);
});

test("P1-C WS replay: only missed events, ordered, contract-valid; disconnect unsubscribes", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  for (let i = 0; i < 4; i++) b.bus.emit({ type: "contact.removed", contactId: `contact-${i}` });
  const { ws, events } = await socket(t, `${b.wsUrl}?sinceEventSeq=2`);
  await until(() => events.length === 2);
  assert.deepEqual(events.map(e => e.eventSeq), [3, 4]);
  assert.ok(events.every(e => checkEvent(e).ok));
  b.bus.emit({ type: "contact.removed", contactId: "live" });
  await until(() => events.length === 3); assert.equal(events[2]?.eventSeq, 5);
  assert.equal(b.subscriptions(), 1);
  const closed = once(ws, "close"); ws.close(); await closed;
  await until(() => b.subscriptions() === 0); assert.equal(b.subscriptions(), 0);
});

test("P1-C WS resync: ring overflow reports bounds and stays subscribed", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge, {}, 2);
  for (let i = 0; i < 5; i++) b.bus.emit({ type: "contact.removed", contactId: `c-${i}` });
  const { events } = await socket(t, `${b.wsUrl}?sinceEventSeq=0`);
  await until(() => events.length > 0);
  assert.equal(events[0]?.type, "stream.resync"); assert.equal(events[0]?.eventSeq, 5);
  assert.equal(checkEvent(events[0]).ok, true);
  assert.match((events[0] as { reason?: string }).reason ?? "", /4/);
  // Window bounds are additive transport metadata; existing frontend reason remains intact.
  assert.equal((events[0] as unknown as { oldestEventSeq: number }).oldestEventSeq, 4);
  assert.equal((events[0] as unknown as { latestEventSeq: number }).latestEventSeq, 5);
  b.bus.emit({ type: "contact.removed", contactId: "next" });
  await until(() => events.length === 2); assert.equal(events[1]?.eventSeq, 6);
});

test("P1-C WS cursor: invalid safe-integer inputs rejected before subscription", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge);
  for (const value of ["-1", "1.5", "NaN", "9007199254740992", "", "1e2", "0&sinceEventSeq=1"]) {
    await rejected(`${b.wsUrl}?sinceEventSeq=${value}`, 400);
  }
  assert.equal(b.subscriptions(), 0);
  const { events } = await socket(t, b.wsUrl);
  b.bus.emit({ type: "contact.removed", contactId: "now" });
  await until(() => events.length === 1); assert.equal(events[0]?.eventSeq, 1);
});

test("P1-C WS backpressure closes consumer and removes listener, including synchronous replay", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge, { maxBufferedBytes: 128 });
  const { ws } = await socket(t, b.wsUrl);
  const closed = once(ws, "close");
  b.bus.emit({ type: "contact.removed", contactId: "x".repeat(1000) });
  const [code] = await closed; assert.equal(code, 1008);
  await until(() => b.subscriptions() === 0); assert.equal(b.subscriptions(), 0);
  const replay = await socket(t, `${b.wsUrl}?sinceEventSeq=0`);
  await once(replay.ws, "close");
  await until(() => b.subscriptions() === 0); assert.equal(b.subscriptions(), 0);
});

test("P1-C WS liveness: pongs keep connection alive; missing pong terminates and unsubscribes", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge, { pingIntervalMs: 30 });
  const healthy = await socket(t, b.wsUrl);
  let pings = 0; healthy.ws.on("ping", () => pings++);
  await until(() => pings >= 3); assert.equal(healthy.ws.readyState, WebSocket.OPEN);
  const dead = await socket(t, b.wsUrl, { autoPong: false });
  const [code] = await once(dead.ws, "close"); assert.equal(code, 1006);
  await until(() => b.subscriptions() === 1); assert.equal(b.subscriptions(), 1);
});

test("P1-C close drains sockets, subscriptions, HTTP listener; idempotent", { timeout: 10_000 }, async t => {
  const b = await fixture(t, createHttpWsBridge, { pingIntervalMs: 20 });
  const { ws } = await socket(t, b.wsUrl);
  const closed = once(ws, "close");
  await Promise.all([b.close(), b.close()]); await closed;
  assert.equal(b.subscriptions(), 0); assert.equal(b.wss.clients.size, 0); assert.equal(b.server.listening, false);
  await assert.rejects(fetch(`${b.httpUrl}/api/health`));
});

test("P1-C serve owns host and closes database after transport", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "p1c-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = await serveHttpWs({ dataDir: dir, port: 0 });
  t.after(() => server.close());
  assert.equal((await (await post(server.httpUrl, "session.hello")).json()).ok, true);
  await server.close();
  assert.throws(() => one(server.started.host.db, "SELECT 1"));
});

test("P1-C CLI serve emits endpoints, honors data-dir/db and shuts down on SIGTERM and SIGINT", { timeout: 10_000 }, async t => {
  // Start through the public bridge first: missing implementation must fail by this test name in red.
  const b = await fixture(t, createHttpWsBridge); assert.ok(b.httpUrl.startsWith("http://127.0.0.1:"));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), "p1c-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["packages/server/src/cli.ts", "serve", "--port", "0", "--data-dir", dir, "--db", path.join(dir, "custom.db"), "--token", "cli-secret", "--cors-origin", "https://app.example", "--mind", "fake", "--compute", "fake", "--note-max-bytes", "4096"], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    await until(() => stdout.includes("\n") || child.exitCode !== null);
    assert.equal(child.exitCode, null, stderr);
    const status = JSON.parse(stdout.trim());
    assert.match(status.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/api\/events$/); assert.equal(typeof status.eventSeq, "number");
    assert.equal(stdout.includes("cli-secret"), false);
    assert.equal((await post(status.httpUrl, "session.hello", { clientApiVersion: API_VERSION }, { Authorization: "Bearer cli-secret" })).status, 200);
    const exit = once(child, "exit"); child.kill(signal);
    const [code, exitSignal] = await exit; assert.equal(code, 0); assert.equal(exitSignal, null);
  }
});
