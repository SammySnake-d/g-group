// G6 冻结清单:渠道只留协议主机端口与摘要,认证只记引用名;配置变了指纹就变;消息版本按操作先后冻结。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkItem, mkRecord } from "./fixtures/build.ts";
import { configFingerprint, endpointOf, modelConfig, reuseKey, runnerDigest, sourceFreeze } from "./manifest.ts";

const URL_WITH_TOKEN = "http://127.0.0.1:52247/g/NEUTRAL_FIXTURE_NO_CREDENTIALS/k/abc";

test("渠道只留协议主机端口,路径里的令牌只以摘要出现", () => {
  const e = endpointOf(URL_WITH_TOKEN);
  assert.equal(e.endpoint, "http://127.0.0.1:52247");
  assert.match(e.endpointHash, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(e).includes("NEUTRAL_FIXTURE_NO_CREDENTIALS"), false);
  assert.notEqual(endpointOf(`${URL_WITH_TOKEN}x`).endpointHash, e.endpointHash);
});

test("真实模式配置不含密钥值,认证只记环境变量名", () => {
  const SECRET = "NEUTRAL_FIXTURE_NO_CREDENTIALS-value";
  const c = modelConfig("real", "m1", { ANTHROPIC_BASE_URL: URL_WITH_TOKEN, ANTHROPIC_AUTH_TOKEN: SECRET });
  assert.deepEqual([c.endpoint, c.authRef], ["http://127.0.0.1:52247", "env:ANTHROPIC_AUTH_TOKEN"]);
  assert.equal(JSON.stringify(c).includes(SECRET), false);
  assert.equal(modelConfig("real", "m1", { ANTHROPIC_BASE_URL: URL_WITH_TOKEN }).authRef, "(缺)");
});

test("配置指纹:同配置同值,换模型、换渠道或换设置都变", () => {
  const env = { ANTHROPIC_BASE_URL: URL_WITH_TOKEN, ANTHROPIC_API_KEY: "k" };
  const a = configFingerprint(modelConfig("real", "m1", env));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(configFingerprint(modelConfig("real", "m1", env)), a);
  assert.notEqual(configFingerprint(modelConfig("real", "m2", env)), a);
  assert.notEqual(configFingerprint(modelConfig("real", "m1", { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:1/x" })), a);
  assert.notEqual(configFingerprint(modelConfig("real", "m1", env, { historyPrefetch: false })), a);
  assert.notEqual(configFingerprint(modelConfig("real", "m1", env, null, true)), a);
  assert.notEqual(configFingerprint(modelConfig("real", "m1", env), "d2"), a);
});

test("续跑身份:不含渠道地址(网关每次会话换端口与路径),换模型、组级选项、一次一个调用或驱动代码就变", () => {
  const env = { ANTHROPIC_BASE_URL: URL_WITH_TOKEN, ANTHROPIC_API_KEY: "k" };
  const k = reuseKey(modelConfig("real", "m1", env), "d1");
  assert.equal(reuseKey(modelConfig("real", "m1", { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:1/g/x/k/y" }), "d1"), k);
  assert.notEqual(configFingerprint(modelConfig("real", "m1", { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:1/g/x/k/y" }), "d1"), configFingerprint(modelConfig("real", "m1", env), "d1"));
  assert.notEqual(reuseKey(modelConfig("real", "m2", env), "d1"), k);
  assert.notEqual(reuseKey(modelConfig("real", "m1", env, { opts: { historyPrefetch: false } }), "d1"), k);
  assert.notEqual(reuseKey(modelConfig("real", "m1", env, null, true), "d1"), k);
  assert.notEqual(reuseKey(modelConfig("real", "m1", env), "d2"), k);
  assert.match(k, /^[0-9a-f]{32}$/);
});

test("驱动代码摘要:与文件顺序无关,改一个字就变", () => {
  const a = runnerDigest([{ name: "a.ts", text: "x" }, { name: "b.ts", text: "y" }]);
  assert.equal(runnerDigest([{ name: "b.ts", text: "y" }, { name: "a.ts", text: "x" }]), a);
  assert.notEqual(runnerDigest([{ name: "a.ts", text: "x!" }, { name: "b.ts", text: "y" }]), a);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("源权限与消息版本:编辑、撤回让版本前进,撤回标记保留", () => {
  const rec = mkRecord({
    ops: [
      { order: 1, op: "send", room: "dm", seq: 1, step: 0, at: 1 },
      { order: 2, op: "edit", room: "dm", seq: 1, step: 1, at: 2 },
      { order: 3, op: "send", room: "dm", seq: 4, step: 2, at: 3 },
      { order: 4, op: "retract", room: "dm", seq: 4, step: 3, at: 4 },
    ],
  });
  const f = sourceFreeze(mkItem(), rec);
  assert.deepEqual(f.rooms, [{ key: "dm", kind: "dm", contacts: ["A"] }]);
  assert.deepEqual(f.versions, [
    { room: "dm", seq: 1, version: 2, retracted: false },
    { room: "dm", seq: 4, version: 4, retracted: true },
  ]);
});
