import assert from "node:assert/strict";
import { test } from "node:test";
import { vendorOf } from "./vendor.ts";

test("常见模型 id 映射到原生研发厂商,带渠道前缀也认得出", () => {
  assert.equal(vendorOf("claude-opus-5-5"), "anthropic");
  assert.equal(vendorOf("ai-iisbo/[乾坤按量]gpt-6-astra"), "openai");
  assert.equal(vendorOf("o1"), "openai");
  assert.equal(vendorOf("gemini-4-argon"), "google");
  assert.equal(vendorOf("grok-4.7"), "xai");
  assert.equal(vendorOf("glm-5.3"), "zhipu");
  assert.equal(vendorOf("deepseek-v4"), "deepseek");
  assert.equal(vendorOf("kimi-k3"), "moonshot");
});

test("认不出或同时像两家的模型一律是 unknown", () => {
  assert.equal(vendorOf("stealth/crouton-alpha"), "unknown");
  assert.equal(vendorOf(undefined), "unknown");
  assert.equal(vendorOf("claude-vs-gpt-merge"), "unknown");
});
