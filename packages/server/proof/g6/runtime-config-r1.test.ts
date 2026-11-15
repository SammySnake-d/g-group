// PR #96 R1:配置矩阵、替身续跑身份与真正 runner CLI → driver 子进程 → 宿主 → HTTP 请求。
// 中性 loopback 响应器不连真实网关、不使用真实凭据。
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { speakingEndpointFromEnv } from "../../src/speaking.ts";
import { gatewayEnv } from "./driver.ts";
import { mkItem, mkSet } from "./fixtures/build.ts";
import { configFingerprint, modelConfig, reuseKey } from "./manifest.ts";
import { driverProcessEnv, linkNodeModules } from "./run.ts";
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

// 真正的 CLI、子进程、driver 和宿主均原样执行；禁网门禁中只把 fetch 末端换成进程内
// Anthropic 响应器。真实 TCP loopback 另由 fixtures/runtime-config-r1-http.mjs 独立核验。
test("C96-R1-05 禁网下真实 runner CLI 经子进程和宿主传递 65536 及 manifest", { timeout: 120_000 }, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-g6-cli-seatbelt-")));
  let child: ChildProcess | undefined;
  try {
    const fixtureRepo = path.join(dir, "repo");
    mkdirSync(fixtureRepo);
    cpSync(path.join(repo, "packages"), path.join(fixtureRepo, "packages"), { recursive: true });
    cpSync(path.join(repo, "package.json"), path.join(fixtureRepo, "package.json"));
    const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMPDIR: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.hooksPath=/dev/null", ...args], { cwd: fixtureRepo, env: gitEnv, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "packages", "package.json");
    git("commit", "-qm", "fixture source snapshot");
    linkNodeModules(repo, fixtureRepo);

    const item = mkItem();
    const fixture = path.join(dir, "set.json");
    const itemPath = path.join(dir, "item.json");
    const requests = path.join(dir, "requests.jsonl");
    const out = path.join(dir, "out");
    const preload = path.join(dir, "transport.mjs");
    const shim = path.join(dir, "node-with-transport");
    writeFileSync(fixture, JSON.stringify(mkSet([item])));
    writeFileSync(itemPath, JSON.stringify(item));
    writeFileSync(preload, [
      'import { readFileSync, appendFileSync } from "node:fs";',
      `import { standinReply } from ${JSON.stringify(pathToFileURL(path.join(fixtureRepo, "packages/server/proof/g6/standin.ts")).href)};`,
      `const item = JSON.parse(readFileSync(${JSON.stringify(itemPath)}, "utf8"));`,
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(shim)} });`,
      'globalThis.fetch = async (url, init = {}) => {',
      '  if (!init.method || init.method === "GET") return new Response("fixture", { status: 200 });',
      '  if (init.method !== "POST" || !/\\/v1\\/messages(?:\\?|$)/.test(String(url)) || typeof init.body !== "string") throw new Error("unexpected fixture request " + init.method + " " + String(url) + " " + typeof init.body);',
      `  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ body: JSON.parse(init.body), key: new Headers(init.headers).get("x-api-key") }) + "\\n");`,
      '  return new Response(standinReply(item, init.body), { status: 200, headers: { "content-type": "text/event-stream" } });',
      '};',
    ].join("\n"));
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' --import '${preload}' "$@"\n`);
    chmodSync(shim, 0o700);
    const env = { ...gitEnv, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: TOKEN, GG_SPEAKING_MAX_OUTPUT_TOKENS: "65536", GG_SPEAKING_CONTEXT_WINDOW: "983010" };
    const args = ["--import", preload, path.join(fixtureRepo, "packages/server/proof/g6/run.ts"), "--mode=real", "--groups=g1", "--base=HEAD", `--models=${MODEL}`, "--items=T", "--reps=1", `--fixture=${fixture}`, `--out=${out}`, "--quiet=5", "--settle=0", "--step-timeout=5000", "--call-timeout=5000"];
    child = spawn(process.execPath, args, { cwd: fixtureRepo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(p, entry.name)) : [path.join(p, entry.name)]);
    const files = walk(path.join(out, "raw")).filter((file) => file.endsWith(".json"));
    assert.equal(files.length, 1, log);
    const raw = JSON.parse(readFileSync(files[0]!, "utf8")) as RawRecord;
    assert.equal(raw.status, "ok", raw.error ?? log);
    const dialogue = raw.calls.filter((call) => call.cls === "round");
    const checks = raw.calls.filter((call) => call.cls === "check");
    assert.ok(dialogue.length > 0 && checks.length > 0, `真实宿主必须发对话与检查两类请求:${JSON.stringify({ calls: raw.calls, reports: raw.reports, steps: raw.steps, log })}`);
    assert.ok([...dialogue, ...checks].every((call) => call.maxTokens === 65536));
    const seen = readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { body: { max_tokens?: number }; key: string });
    assert.equal(seen.length, raw.calls.length);
    assert.ok(seen.length > 0 && seen.every((request) => request.body.max_tokens === 65536 && request.key === TOKEN));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
