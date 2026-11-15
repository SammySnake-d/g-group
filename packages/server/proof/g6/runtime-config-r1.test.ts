// PR #96 R1:配置矩阵、替身续跑身份与真正 runner CLI → driver 子进程 → 宿主 → HTTP 请求。
// 中性 loopback 响应器不连真实网关、不使用真实凭据。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { speakingEndpointFromEnv } from "../../src/speaking.ts";
import { gatewayEnv } from "./driver.ts";
import { mkItem, mkSet } from "./fixtures/build.ts";
import { configFingerprint, modelConfig, reuseKey } from "./manifest.ts";
import { driverProcessEnv } from "./run.ts";
import { standinReply } from "./standin.ts";
import type { RawRecord } from "./types.ts";

const BASE = "http://fixture.invalid";
const TOKEN = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const MODEL = "fixture-model";
const repo = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."));

test("C96-R1-01 API_KEY-only 与 AUTH_TOKEN 都经 runner 和 driver 传给宿主,无关环境不透传", () => {
  for (const auth of [{ ANTHROPIC_AUTH_TOKEN: TOKEN }, { ANTHROPIC_API_KEY: TOKEN }]) {
    const input = { ANTHROPIC_BASE_URL: BASE, ...auth, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010", UNRELATED_PRIVATE_SETTING: TOKEN };
    const child = driverProcessEnv("real", input);
    const gateway = gatewayEnv({ mode: "real", model: MODEL, env: child });
    assert.ok(gateway);
    assert.equal(child.UNRELATED_PRIVATE_SETTING, undefined);
    assert.equal(gateway.UNRELATED_PRIVATE_SETTING, undefined);
    assert.equal(gateway.GG_SPEAKING_MAX_OUTPUT_TOKENS, "65536");
    assert.equal(gateway.GG_SPEAKING_CONTEXT_WINDOW, "983010");
    assert.equal(speakingEndpointFromEnv(gateway).authRef, "ANTHROPIC_AUTH_TOKEN" in auth ? "bearer:env:ANTHROPIC_AUTH_TOKEN" : "x-api-key:env:ANTHROPIC_API_KEY");
    assert.equal(speakingEndpointFromEnv(gateway).maxOutputTokens, 65536);
    assert.equal(speakingEndpointFromEnv(gateway).contextWindow, 983010);
  }
});

test("C96-R1-02 仅 output、仅 context、两者、空值与缺省分别穿透,非法值由宿主拒绝", () => {
  const base = { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN };
  const defaults = speakingEndpointFromEnv(base);
  const cases = [
    [{}, defaults.maxOutputTokens, defaults.contextWindow],
    [{ GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536" }, 65536, defaults.contextWindow],
    [{ GG_SPEAKING_CONTEXT_WINDOW: "983010" }, defaults.maxOutputTokens, 983010],
    [{ GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" }, 65536, 983010],
    [{ GG_SPEAKING_MAX_OUTPUT_TOKENS: "", GG_SPEAKING_CONTEXT_WINDOW: "" }, defaults.maxOutputTokens, defaults.contextWindow],
  ] as const;
  for (const [budgets, output, context] of cases) {
    const input = { ...base, ...budgets };
    const child = driverProcessEnv("real", input);
    const gateway = gatewayEnv({ mode: "real", model: MODEL, env: child });
    assert.ok(gateway);
    const resolved = speakingEndpointFromEnv(gateway);
    assert.equal(resolved.maxOutputTokens, output);
    assert.equal(resolved.contextWindow, context);
    assert.deepEqual(modelConfig("real", MODEL, input).speaking, budgets);
  }
  for (const key of ["GG_SPEAKING_MAX_OUTPUT_TOKENS", "GG_SPEAKING_CONTEXT_WINDOW"] as const) {
    for (const bad of ["0", "-1", "1.5", "NaN"]) {
      const child = driverProcessEnv("real", { ...base, [key]: bad });
      const gateway = gatewayEnv({ mode: "real", model: MODEL, env: child });
      assert.ok(gateway);
      assert.equal(gateway[key], bad);
      assert.throws(() => speakingEndpointFromEnv(gateway), /必须是正整数/);
    }
  }
});

test("C96-R1-03 实际 65536/983010 档在两级环境、宿主配置与 manifest 中原样保留", () => {
  const input = { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" };
  const child = driverProcessEnv("real", input);
  const gateway = gatewayEnv({ mode: "real", model: MODEL, env: child });
  assert.ok(gateway);
  assert.deepEqual([child.GG_SPEAKING_MAX_OUTPUT_TOKENS, child.GG_SPEAKING_CONTEXT_WINDOW], ["65536", "983010"]);
  assert.deepEqual([gateway.GG_SPEAKING_MAX_OUTPUT_TOKENS, gateway.GG_SPEAKING_CONTEXT_WINDOW], ["65536", "983010"]);
  assert.deepEqual([speakingEndpointFromEnv(gateway).maxOutputTokens, speakingEndpointFromEnv(gateway).contextWindow], [65536, 983010]);
  assert.deepEqual(modelConfig("real", MODEL, input).speaking, { GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" });
});

test("C96-R1-04 standin 忽略真实预算变化:指纹与续跑身份不变,真实模式与凭据对照不回退", () => {
  const base = { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN };
  const configured = { ...base, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" };
  const standin = modelConfig("standin", MODEL, base);
  const standinConfigured = modelConfig("standin", MODEL, configured);
  assert.deepEqual(standin.speaking, {});
  assert.deepEqual(standinConfigured.speaking, {});
  assert.equal(configFingerprint(standin, "driver"), configFingerprint(standinConfigured, "driver"));
  assert.equal(reuseKey(standin, "driver"), reuseKey(standinConfigured, "driver"));
  const real = modelConfig("real", MODEL, base);
  const realConfigured = modelConfig("real", MODEL, configured);
  assert.notEqual(configFingerprint(real, "driver"), configFingerprint(realConfigured, "driver"));
  assert.notEqual(reuseKey(real, "driver"), reuseKey(realConfigured, "driver"));
  assert.equal(reuseKey(realConfigured, "driver"), reuseKey(modelConfig("real", MODEL, { ...configured, ANTHROPIC_AUTH_TOKEN: "OTHER_NEUTRAL" }), "driver"));
  assert.equal(JSON.stringify(realConfigured).includes(TOKEN), false);
});

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

test("C96-R1-05 真正 runner CLI 经子进程与宿主把 65536 送到对话及检查 HTTP,manifest 保留完整预算", { timeout: 120_000 }, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-g6-cli-r1-")));
  const item = mkItem();
  const fixture = path.join(dir, "set.json");
  writeFileSync(fixture, JSON.stringify(mkSet([item])));
  const seen: { body: { max_tokens?: number }; key: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200); res.end("fixture"); return; }
    const chunks: Buffer[] = [];
    for await (const data of req) chunks.push(Buffer.from(data));
    const text = Buffer.concat(chunks).toString("utf8");
    seen.push({ body: JSON.parse(text) as { max_tokens?: number }, key: req.headers["x-api-key"] as string | undefined });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(standinReply(item, text));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child: ChildProcess | undefined;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const out = path.join(dir, "out");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: TOKEN, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" };
    const args = [path.join(repo, "packages/server/proof/g6/run.ts"), "--mode=real", "--groups=g1", "--base=HEAD", `--models=${MODEL}`, "--items=T", "--reps=1", `--fixture=${fixture}`, `--out=${out}`, "--quiet=5", "--settle=0", "--step-timeout=5000", "--call-timeout=5000"];
    child = spawn(process.execPath, args, { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout!.on("data", (d: Buffer) => { log += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { log += d.toString(); });
    const timer = setTimeout(() => { if (child?.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM"); }, 100_000);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    assert.deepEqual(exit, { code: 0, signal: null }, log);
    const summary = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8")) as { models: { speaking: Record<string, string> }[] };
    assert.deepEqual(summary.models[0]?.speaking, { GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" });
    const files = walk(path.join(out, "raw")).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1, log);
    const raw = JSON.parse(readFileSync(files[0]!, "utf8")) as RawRecord;
    assert.equal(raw.status, "ok", raw.error ?? log);
    const dialogue = raw.calls.filter((call) => call.cls === "round");
    const checks = raw.calls.filter((call) => call.cls === "check");
    assert.ok(dialogue.length > 0 && checks.length > 0, "真实宿主必须发对话与检查两类请求");
    assert.ok([...dialogue, ...checks].every((call) => call.maxTokens === 65536));
    assert.equal(seen.length, raw.calls.length);
    assert.ok(seen.length > 0 && seen.every((request) => request.body.max_tokens === 65536 && request.key === TOKEN));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
