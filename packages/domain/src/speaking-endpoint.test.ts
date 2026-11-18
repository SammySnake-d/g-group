// T-177 G2 = D(AC-32 ③):说话侧有效配置快照。字段从哪来、指纹覆盖什么、认证引用不是密钥值、参数不合格显式拒绝。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SPEAKING_ENDPOINT, type SpeakingEndpoint, SpeakingConfigError, checkSpeakingEndpoint, resolveSpeakingConfig, speakingFingerprint } from "./model-config.ts";

const EP: SpeakingEndpoint = { provider: "anthropic", baseUrl: "http://127.0.0.1:9/neutral", authRef: "bearer:env:ANTHROPIC_AUTH_TOKEN", maxOutputTokens: 8192, contextWindow: 200_000 };

test("G2-01 快照取本轮实际模型与宿主级配置 冻结且推理参数默认空", () => {
  const s = resolveSpeakingConfig(EP, "gpt-5", "boot-1");
  const { fingerprint, ...rest } = s;
  assert.deepEqual(rest, { model: "gpt-5", vendor: "openai", provider: "anthropic", baseUrl: "http://127.0.0.1:9/neutral", authRef: "bearer:env:ANTHROPIC_AUTH_TOKEN", maxOutputTokens: 8192, contextWindow: 200_000, reasoning: {} });
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(s), true);
  assert.equal(Object.isFrozen(s.reasoning), true);
  const d = resolveSpeakingConfig(DEFAULT_SPEAKING_ENDPOINT, "claude-sonnet-4-6", "boot-1");
  assert.deepEqual([d.maxOutputTokens, d.contextWindow, d.authRef], [4096, 200_000, "none"], "默认值与两个 pi 适配器原有默认值相同");
});

test("G2-01 指纹覆盖每个非敏感字段与宿主启动号 同输入稳定", () => {
  const first = resolveSpeakingConfig(EP, "m-1", "boot-1");
  const base = first.fingerprint;
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  const { fingerprint: _f, ...body } = first;
  assert.equal(speakingFingerprint(body, "boot-1"), base, "快照里的指纹就是规范化内容加启动号的哈希");
  assert.equal(resolveSpeakingConfig({ ...EP }, "m-1", "boot-1").fingerprint, base, "同样的输入得到同样的指纹");
  const variants: [SpeakingEndpoint, string, string][] = [
    [{ ...EP, maxOutputTokens: 4096 }, "m-1", "boot-1"],
    [{ ...EP, contextWindow: 100_000 }, "m-1", "boot-1"],
    [{ ...EP, baseUrl: "http://127.0.0.1:9/other" }, "m-1", "boot-1"],
    [{ ...EP, provider: "magpie" }, "m-1", "boot-1"],
    [{ ...EP, authRef: "x-api-key:env:ANTHROPIC_API_KEY" }, "m-1", "boot-1"],
    [{ ...EP, reasoning: { effort: "high" } }, "m-1", "boot-1"],
    [EP, "m-2", "boot-1"],
    [EP, "m-1", "boot-2"],
  ];
  const all = [base, ...variants.map(([e, m, b]) => resolveSpeakingConfig(e, m, b).fingerprint)];
  assert.equal(new Set(all).size, variants.length + 1, "任一字段或启动号变了,指纹都要变");
  const ab = resolveSpeakingConfig({ ...EP, reasoning: { a: 1, b: { y: 2, x: 1 } } }, "m-1", "boot-1");
  const ba = resolveSpeakingConfig({ ...EP, reasoning: { b: { x: 1, y: 2 }, a: 1 } }, "m-1", "boot-1");
  assert.equal(ab.fingerprint, ba.fingerprint, "推理参数按规范化后的内容算,键顺序不影响");
});

test("G2-02 认证位置填了密钥值就拒绝 说明不回显原值", () => {
  const secret = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
  let message = "";
  assert.throws(
    () => resolveSpeakingConfig({ ...EP, authRef: secret }, "m-1", "boot-1"),
    (e: unknown) => {
      message = e instanceof Error ? e.message : "";
      return e instanceof SpeakingConfigError;
    },
  );
  assert.match(message, /authRef 必须是认证引用/);
  assert.equal(message.includes(secret), false, "拒绝说明里不能出现原值");
  const ok = resolveSpeakingConfig({ ...EP, authRef: "none" }, "m-1", "boot-1");
  assert.equal(ok.authRef, "none");
  assert.match(ok.fingerprint, /^sha256:[0-9a-f]{64}$/, "指纹是哈希,不是任何原值");
  assert.equal(JSON.stringify(resolveSpeakingConfig(EP, "m-1", "boot-1")).includes(secret), false);
});

test("G2-02 端点参数不合格显式拒绝 不悄悄放大或缩小", () => {
  const bad: Partial<Record<keyof SpeakingEndpoint, unknown>>[] = [
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { contextWindow: 0 },
    { maxOutputTokens: 300_000, contextWindow: 200_000 },
    { baseUrl: "不是网址" },
    { baseUrl: "http://u:p@127.0.0.1:9/" },
    { provider: " " },
    { reasoning: [] },
  ];
  const rejected = bad.filter((b) => {
    try {
      checkSpeakingEndpoint({ ...EP, ...b } as SpeakingEndpoint);
      return false;
    } catch (e) {
      return e instanceof SpeakingConfigError;
    }
  });
  assert.deepEqual(rejected, bad, "每一种不合格都要显式拒绝");
  assert.equal(checkSpeakingEndpoint(EP).maxOutputTokens, 8192, "合格的配置原样返回");
  assert.throws(() => resolveSpeakingConfig(EP, " ", "boot-1"), SpeakingConfigError);
});
