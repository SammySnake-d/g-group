// Magpie / 网关模型发现测试:按 Claude Code / Codex Harness 身份查询各自的模型目录并聚合去重。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { discoverGatewayCatalog, inferModelVendor } from "./magpie-discovery.ts";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-magpie-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const response = (data: unknown, ok = true): Response => ({ ok, json: async () => data } as Response);

function localConfig(t: TestContext, port: number) {
  const homeDir = fs.mkdtempSync(path.join(root, "home-"));
  const previous = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  const dir = path.join(homeDir, ".config", "magpie");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ port }));
  return homeDir;
}

test("models.discoverGateway:分别按 magpie-claude 与 magpie-codex 探测并合并多 Harness 模型", async () => {
  const calls: { url: string; authorization?: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push(authorization ? { url, authorization } : { url });
    return response({ data: calls.at(-1)?.authorization === "Bearer magpie-claude" ? [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }, { id: "deepseek-v4.1-flash", magpie_label: "DeepSeek V4.1 Flash" }] : [{ id: "gpt-5.4", display_name: "GPT-5.4" }, { id: "deepseek-v4.1-flash", magpie_label: "DeepSeek V4.1 Flash" }] });
  };
  const v = await discoverGatewayCatalog({ baseUrl: "http://magpie.test", kind: "magpie" }, { fetch: fakeFetch });
  assert.deepEqual(v.harnesses, ["claude-code", "codex"]);
  assert.deepEqual(v.models.map((m) => [m.id, m.vendor, m.harnesses]), [["claude-opus-4-6", "anthropic", ["claude-code"]], ["deepseek-v4.1-flash", "deepseek", ["claude-code", "codex"]], ["gpt-5.4", "openai", ["codex"]]]);
  assert.equal(calls.length, 2);
});

test("models.discoverGateway:通用 apiKey 按网关类型发送 x-api-key 或 Bearer", async () => {
  const headers: Headers[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => { headers.push(new Headers(init?.headers)); return response({ data: [{ id: "custom-model" }] }); };
  const anthropic = await discoverGatewayCatalog({ baseUrl: "http://gateway.test", kind: "anthropic", apiKey: "a" }, { fetch: fakeFetch });
  const openai = await discoverGatewayCatalog({ baseUrl: "http://gateway.test", kind: "openai-compatible", apiKey: "b" }, { fetch: fakeFetch });
  assert.equal(headers[0]!.get("x-api-key"), "a");
  assert.equal(headers[0]!.get("authorization"), null);
  assert.equal(headers[1]!.get("authorization"), "Bearer b");
  assert.equal(anthropic.models[0]!.id, "custom-model");
  assert.equal(openai.models[0]!.id, "custom-model");
  const discovered = await discoverGatewayCatalog({ baseUrl: "http://gateway.test", kind: "openai-compatible", apiKey: "b" }, { fetch: fakeFetch });
  assert.equal(discovered.source, "openai-compatible");
  assert.equal(discovered.baseUrl, "http://gateway.test");
  assert.deepEqual(discovered.harnesses, ["claude-code", "codex"]);
  assert.deepEqual(discovered.models.map((m) => m.id), ["custom-model"]);
  assert.equal(discovered.models[0]!.vendor, "custom");
});

test("models.discoverGateway:scanLocal 从 homeDir 读取 Magpie 配置端口", async (t) => {
  const homeDir = localConfig(t, 3999);
  let seen = "";
  const fakeFetch: typeof fetch = async (input) => { seen = String(input); return response({ data: [{ id: "gpt-5" }] }); };
  const v = await discoverGatewayCatalog({ scanLocal: true }, { fetch: fakeFetch, homeDir });
  assert.equal(seen, "http://127.0.0.1:3999/v1/models");
  assert.equal(v.detectedMagpie, true);
  assert.equal(v.baseUrl, "http://127.0.0.1:3999");
  assert.deepEqual(v.harnesses, ["claude-code", "codex"]);
  assert.deepEqual((await discoverGatewayCatalog({ scanLocal: true }, { fetch: fakeFetch, homeDir })).models.map((m) => m.id), ["gpt-5"]);
  assert.equal(v.models[0]!.vendor, "openai");
});

test("models.discoverGateway:本机配置不证明远端网关是 Magpie", async (t) => {
  const homeDir = localConfig(t, 3999);
  const fetch: typeof globalThis.fetch = async () => response({}, false);
  const baseUrl = "https://remote-gateway.example.com";
  const remote = await discoverGatewayCatalog({ baseUrl, kind: "magpie" }, { fetch, homeDir });
  assert.equal(remote.detectedMagpie, false);
  assert.deepEqual(remote.models, []);
  const scannedRemote = await discoverGatewayCatalog({ baseUrl, scanLocal: true }, { fetch, homeDir });
  assert.equal(scannedRemote.detectedMagpie, false);
  const scannedLocal = await discoverGatewayCatalog({ baseUrl: "http://127.0.0.1:3999/", scanLocal: true }, { fetch, homeDir });
  assert.equal(scannedLocal.detectedMagpie, true);
});

test("models.discoverGateway:拒绝非 HTTP(S)、非法地址和内嵌凭据", async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return response({}, false); };
  for (const baseUrl of ["file:///tmp/models", "not a URL", "https://user@gateway.test", "https://:fixture@gateway.test"]) {
    await assert.rejects(discoverGatewayCatalog({ baseUrl }, { fetch }), { code: "invalid_params" });
  }
  assert.equal(requests, 0);
});

test("models.discoverGateway:拒绝本机配置生成的非法 URL", async (t) => {
  const homeDir = localConfig(t, 65536);
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return response({}, false); };
  await assert.rejects(discoverGatewayCatalog({ scanLocal: true }, { fetch, homeDir }), { code: "invalid_params" });
  assert.equal(requests, 0);
});

test("models.discoverGateway:合并 Harness 时用显示名称替换模型 ID", async () => {
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const codex = new Headers(init?.headers).get("authorization") === "Bearer magpie-codex";
    return response({ data: [{ id: "gpt-5", ...(codex ? { display_name: "GPT-5" } : {}) }] });
  };
  const result = await discoverGatewayCatalog({ baseUrl: "http://magpie.test", kind: "magpie" }, { fetch });
  assert.deepEqual(result.models, [{ id: "gpt-5", label: "GPT-5", vendor: "openai", harnesses: ["claude-code", "codex"] }]);
});

test("inferModelVendor:识别主要供应商并将未知模型归为 custom", () => {
  assert.deepEqual([inferModelVendor("claude-3"), inferModelVendor("gpt-5"), inferModelVendor("gemini-2"), inferModelVendor("deepseek-v4"), inferModelVendor("qwen3"), inferModelVendor("glm-5"), inferModelVendor("other")], ["anthropic", "openai", "google", "deepseek", "qwen", "glm", "custom"]);
});

test("models.discoverGateway service wiring:通过全局 fetch 并在 finally 恢复", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({ data: [{ id: "gpt-5" }] });
  const host = new Host({ file: path.join(root, "wiring.db"), dataDir: root, mind: () => scriptedMind() });
  try {
    const res = await createService(host).handle("models.discoverGateway", { baseUrl: "http://gateway.test", kind: "openai-compatible", apiKey: "k" });
    assert.equal(res.ok, true);
    assert.equal((res.value as { models: { id: string }[] }).models[0]!.id, "gpt-5");
  } finally {
    globalThis.fetch = original;
    await host.close();
  }
});
