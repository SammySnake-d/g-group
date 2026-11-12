// G6 配置链:runner 子进程 -> driver -> 被测 start.ts;用中性传输替身核对真实请求,不连网。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { driveItem, gatewayEnv } from "./driver.ts";
import { driverProcessEnv } from "./run.ts";
import { configFingerprint, modelConfig, reuseKey } from "./manifest.ts";
import { createStandin } from "./standin.ts";
import { mkItem, mkSet } from "./fixtures/build.ts";

const env = { ANTHROPIC_BASE_URL: "http://fixture.invalid", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS", GG_SPEAKING_MAX_OUTPUT_TOKENS: "9216", GG_SPEAKING_CONTEXT_WINDOW: "123456" };

test("G6CFG-01 driver keeps explicit output and context settings, including invalid values for host rejection", () => {
  const got = gatewayEnv({ mode: "real", model: "fixture-model", env })!;
  assert.equal(got.GG_SPEAKING_MAX_OUTPUT_TOKENS, env.GG_SPEAKING_MAX_OUTPUT_TOKENS);
  assert.equal(got.GG_SPEAKING_CONTEXT_WINDOW, env.GG_SPEAKING_CONTEXT_WINDOW);
  assert.equal(gatewayEnv({ mode: "real", model: "fixture-model", env: { ...env, GG_SPEAKING_MAX_OUTPUT_TOKENS: "invalid" } })!.GG_SPEAKING_MAX_OUTPUT_TOKENS, "invalid");
});

test("G6CFG-02 runner child environment carries speaking settings without copying unrelated host state", () => {
  const child = driverProcessEnv("real", { ...env, UNRELATED_PRIVATE_SETTING: "NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  assert.equal(child.GG_SPEAKING_MAX_OUTPUT_TOKENS, env.GG_SPEAKING_MAX_OUTPUT_TOKENS);
  assert.equal(child.GG_SPEAKING_CONTEXT_WINDOW, env.GG_SPEAKING_CONTEXT_WINDOW);
  assert.equal(child.UNRELATED_PRIVATE_SETTING, undefined);
  assert.equal(driverProcessEnv("standin", env).GG_SPEAKING_MAX_OUTPUT_TOKENS, undefined);
});

test("G6CFG-03 both budgets enter fingerprints and resume identity, but credentials do not", () => {
  const base = modelConfig("real", "fixture-model", env);
  for (const field of ["GG_SPEAKING_MAX_OUTPUT_TOKENS", "GG_SPEAKING_CONTEXT_WINDOW"] as const) {
    const changed = modelConfig("real", "fixture-model", { ...env, [field]: String(Number(env[field]) + 1) });
    assert.notEqual(configFingerprint(changed, "same-driver"), configFingerprint(base, "same-driver"), field);
    assert.notEqual(reuseKey(changed, "same-driver"), reuseKey(base, "same-driver"), field);
  }
  assert.equal(reuseKey(modelConfig("real", "fixture-model", { ...env, ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_OTHER" }), "same-driver"), reuseKey(base, "same-driver"));
  assert.equal(JSON.stringify(base).includes(env.ANTHROPIC_AUTH_TOKEN), false);
});

test("G6CFG-04 real-mode driver host sends the inherited cap to both dialogue and memory checks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "g6-config-"));
  const item = mkItem();
  const saved = globalThis.fetch;
  globalThis.fetch = createStandin(item);
  try {
    const rec = await driveItem({ set: mkSet([item]), item, group: "g2", commit: "fixture", rep: 1, mode: "real", model: "fixture-model", env: driverProcessEnv("real", env), dataDir: dir, fingerprint: "fixture", reuseKey: "fixture", stepTimeoutMs: 20_000, callTimeoutMs: 20_000, quietMs: 30, settleMs: 0, serial: true });
    assert.equal(rec.status, "ok");
    const dialogue = rec.calls.filter(c => c.cls === "round");
    const checks = rec.calls.filter(c => c.cls === "check");
    assert.ok(dialogue.length > 0 && checks.length > 0);
    assert.ok(dialogue.every(c => c.maxTokens === Number(env.GG_SPEAKING_MAX_OUTPUT_TOKENS)), "dialogue cap");
    assert.ok(checks.every(c => c.maxTokens === Number(env.GG_SPEAKING_MAX_OUTPUT_TOKENS)), "memory-check cap");
  } finally {
    globalThis.fetch = saved;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
