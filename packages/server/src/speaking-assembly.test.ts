// T-177 G2 = D(AC-32 ③):生产入口 start.ts 与开发入口 cli.ts 共用一个说话侧装配。按指纹缓存、对话与压缩器拿同一组参数、
// 推理参数不支持就显式拒绝、密钥只在调用边界解析;两个入口对同一份宿主配置给出同一个结果。
// 生产入口的真实连线用 pi 适配器 + 注入的 HTTP 传输(进程内 Anthropic Messages 兼容假端点,SSE),门禁沙箱禁网也能跑。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ContactView } from "@g-group/api-contract";
import { modelConfig } from "@g-group/domain";
import type { ContactCompactor, ContactMind } from "@g-group/kernel";
import { type PiSpeakingModule, assembleSpeaking, speakingEndpointFromEnv } from "./speaking.ts";
import { startServer } from "./start.ts";

const SECRET = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const BASE = "http://127.0.0.1:9/neutral";
const view = { id: "c-1", name: "查证" } as unknown as ContactView;
function recorder() {
  const made: { kind: "mind" | "compactor"; opts: Record<string, unknown> }[] = [];
  const mod: PiSpeakingModule = {
    createPiContactMind: (opts): ContactMind => {
      made.push({ kind: "mind", opts });
      return { async round() { return { actions: [], stateNote: null }; } };
    },
    createPiCompactor: (opts): ContactCompactor => {
      made.push({ kind: "compactor", opts });
      return { model: String(opts.model), async compact() { return "笔记"; } };
    },
  };
  return { made, load: async () => mod };
}
const strip = (o: Record<string, unknown> | undefined) => {
  const { fetch: _f, ...rest } = o ?? {};
  return rest;
};

test("G2-01 装配按指纹缓存 同模型换输出上限得到新实例", async () => {
  const r = recorder();
  const a = await assembleSpeaking({ kind: "pi", env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: BASE, GG_SPEAKING_MAX_OUTPUT_TOKENS: "8192" }, load: r.load });
  const s1 = modelConfig.resolveSpeakingConfig(a.endpoint, "m-1", "boot-1");
  const s2 = modelConfig.resolveSpeakingConfig({ ...a.endpoint, maxOutputTokens: 16_384 }, "m-1", "boot-1");
  const m1 = a.mind(view, s1);
  assert.equal(a.mind(view, s1), m1, "同一指纹复用同一个无状态客户端");
  assert.notEqual(a.mind(view, s2), m1, "同模型换了配置不能复用旧客户端");
  assert.deepEqual(r.made.filter((x) => x.kind === "mind").map((x) => x.opts.maxTokens), [8192, 16_384]);
  const k1 = a.compactor?.(view, s1);
  assert.equal(a.compactor?.(view, s1), k1);
  assert.notEqual(a.compactor?.(view, s2), k1);
  assert.deepEqual(r.made.filter((x) => x.kind === "compactor").map((x) => x.opts.maxTokens), [8192, 16_384]);
});

test("G2-01 对话与压缩器拿同一组宿主级参数 压缩器不自设上限", async () => {
  const r = recorder();
  const a = await assembleSpeaking({ kind: "pi", env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: BASE, GG_SPEAKING_MAX_OUTPUT_TOKENS: "8192", GG_SPEAKING_CONTEXT_WINDOW: "64000" }, load: r.load });
  const s = modelConfig.resolveSpeakingConfig(a.endpoint, "m-1", "boot-1");
  a.mind(view, s);
  a.compactor?.(view, s);
  const [mind, compactor] = [r.made.find((x) => x.kind === "mind")?.opts, r.made.find((x) => x.kind === "compactor")?.opts];
  assert.deepEqual(strip(compactor), strip(mind), "两路参数逐项相同");
  assert.deepEqual(strip(mind), { provider: s.provider, model: s.model, baseUrl: s.baseUrl, apiKey: SECRET, authHeader: "bearer", maxTokens: s.maxOutputTokens, contextWindow: s.contextWindow });
  assert.deepEqual([a.endpoint.maxOutputTokens, a.endpoint.contextWindow, a.endpoint.baseUrl], [8192, 64_000, BASE], "宿主级参数来自环境");
});

test("G2-02 推理参数不被支持就显式拒绝 不丢弃后假装继承", async () => {
  const r = recorder();
  const a = await assembleSpeaking({ kind: "pi", env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: BASE }, load: r.load });
  const s = modelConfig.resolveSpeakingConfig({ ...a.endpoint, reasoning: { effort: "high" } }, "m-1", "boot-1");
  assert.throws(() => a.mind(view, s), /不支持推理参数 effort/);
  assert.throws(() => a.compactor?.(view, s), /不支持推理参数 effort/);
  assert.equal(r.made.length, 0, "一个客户端都不建");
  assert.deepEqual(a.endpoint, { provider: "anthropic", baseUrl: BASE, authRef: "bearer:env:ANTHROPIC_AUTH_TOKEN", maxOutputTokens: 4096, contextWindow: 200_000, reasoning: {} }, "宿主级默认推理参数为空");
});

test("G2-02 密钥只在调用边界按引用解析 不进端点和快照", async () => {
  const r = recorder();
  const env = { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: BASE };
  const a = await assembleSpeaking({ kind: "pi", env, load: r.load });
  assert.deepEqual(a.endpoint, { provider: "anthropic", baseUrl: BASE, authRef: "x-api-key:env:ANTHROPIC_API_KEY", maxOutputTokens: 4096, contextWindow: 200_000, reasoning: {} });
  const s = modelConfig.resolveSpeakingConfig(a.endpoint, "m-1", "boot-1");
  assert.equal(JSON.stringify(a.endpoint).includes(SECRET), false);
  assert.equal(JSON.stringify(s).includes(SECRET), false);
  a.mind(view, s);
  assert.equal(r.made[0]?.opts.apiKey, SECRET, "到了调用边界才取值");
  assert.equal(r.made[0]?.opts.authHeader, "x-api-key");
  const gone = modelConfig.resolveSpeakingConfig({ ...a.endpoint, maxOutputTokens: 1024 }, "m-1", "boot-1");
  delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
  assert.throws(() => a.mind(view, gone), (e: unknown) => e instanceof Error && /x-api-key:env:ANTHROPIC_API_KEY/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(speakingEndpointFromEnv({}).authRef, "none");
});

test("G2-01 生产入口真实连线 对话与检查发出的请求同模型同上限同端点", async (t) => {
  const seen: { url: string; auth: string | null; body: { model: string; max_tokens: number; system?: unknown } }[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const modelFetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as { model: string; max_tokens: number; system?: unknown };
    seen.push({ url: req.url, auth: req.headers.get("authorization"), body });
    const text = JSON.stringify(body.system ?? "").includes("JSON") ? JSON.stringify({ note: "笔记", memories: [], personaSuggestion: null }) : "收到";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
        c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
        c.enqueue(sse("content_block_stop", { index: 0 }));
        c.enqueue(sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const dir = mkdtempSync(path.join(tmpdir(), "gg-speaking-start-"));
  const reports: string[] = [];
  const s = await startServer({
    dataDir: dir,
    mind: "pi",
    env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_DEFAULT_SONNET_MODEL: "m-gateway", GG_SPEAKING_MAX_OUTPUT_TOKENS: "8192" },
    modelFetch,
    onReport: (what, detail) => reports.push(`${what} ${JSON.stringify(detail)}`),
  });
  t.after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const c = s.host.createContact({ name: "查证" });
  const dm = s.host.openDm(c.id);
  s.host.send({ roomId: dm.id, clientActionId: "one", text: "你好" });
  const end = Date.now() + 5000;
  while (seen.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 2, "对话一次、检查一次");
  await s.host.idle();
  assert.equal(c.speakingModel, "m-gateway", "联系人默认说话模型来自生产入口的环境");
  assert.deepEqual(seen.map((x) => [x.body.model, x.body.max_tokens]), [[c.speakingModel, 8192], [c.speakingModel, 8192]]);
  assert.deepEqual(seen.map((x) => x.url.startsWith(BASE)), [true, true], "两路都走宿主配置的端点");
  assert.deepEqual(seen.map((x) => x.auth), [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  assert.equal(reports.some((r) => r.includes(SECRET)), false, "报告里不出现密钥");
});

test("G2-01 生产与开发入口对同一份宿主配置给出同一个拒绝", async () => {
  const env = { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_DEFAULT_SONNET_MODEL: "m-gateway", GG_SPEAKING_MAX_OUTPUT_TOKENS: "0" };
  const dir = mkdtempSync(path.join(tmpdir(), "gg-speaking-entry-"));
  try {
    let fromStart = "";
    try {
      const s = await startServer({ dataDir: dir, mind: "pi", env });
      await s.close();
    } catch (e) {
      fromStart = e instanceof Error ? e.message : String(e);
    }
    assert.match(fromStart, /GG_SPEAKING_MAX_OUTPUT_TOKENS 必须是正整数/);
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const r = spawnSync(process.execPath, [cli, "dm", "--db", path.join(dir, "cli.db"), "--mind", "pi", "你好"], { env: { PATH: process.env.PATH ?? "", HOME: path.join(dir, "home"), ...env }, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), fromStart, "开发入口与生产入口走同一个装配,说明逐字相同");
    assert.throws(() => speakingEndpointFromEnv(env), { message: fromStart }, "两个入口的说明都来自同一个端点解析");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
