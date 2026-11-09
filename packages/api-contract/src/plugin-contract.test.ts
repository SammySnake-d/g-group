// 插件执行与 URL 安装的合同增量(AC-35 阶段 I):plugins.pull / plugins.send 两个新方法、url 来源可选 sha256、
// PluginView 可选 executable / integrity。只验合同本身的判别力;行为在 packages/server 的测试里。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParams, checkResult, formatIssues } from "./index.ts";

const AT = "2026-11-08T21:40:00+08:00";

test("plugins.install 的 url 来源可带 sha256:只收 64 位小写十六进制", () => {
  const sha = "a".repeat(64);
  const r = checkParams("plugins.install", { clientActionId: "p1", source: { kind: "url", url: "https://x.example/p.tgz", sha256: sha }, grantedPermissions: [] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.source, { kind: "url", url: "https://x.example/p.tgz", sha256: sha });
  for (const bad of ["A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
    const x = checkParams("plugins.install", { clientActionId: "p2", source: { kind: "url", url: "https://x.example/p.tgz", sha256: bad }, grantedPermissions: [] });
    assert.equal(x.ok, false, bad);
    assert.equal(x.ok ? "" : formatIssues(x.issues), "source.sha256: 格式不符 ^[0-9a-f]{64}$", bad);
  }
  const view = { id: "far", name: "远程", version: "1.0.0", latestVersion: null, kinds: ["data-source"], source: "url", enabled: true, status: "ready", error: null, permissions: [], configSchema: null, config: null, commands: [], installedAt: AT, executable: true, integrity: { sha256: sha, verified: false } };
  const v = checkResult("plugins.get", view);
  assert.ok(v.ok);
  const pv = v.value as { executable?: boolean; integrity?: unknown };
  assert.deepEqual([pv.executable, pv.integrity], [true, { sha256: sha, verified: false }]);
});

test("plugins.pull / plugins.send:外部事件必须标不可信,外发结果三态,参数缺 actionId 被拒", () => {
  assert.ok(checkParams("plugins.pull", { pluginId: "rss-reader" }).ok);
  assert.ok(checkParams("plugins.pull", { pluginId: "rss-reader", sourceId: "https://x.example/feed.xml" }).ok);
  const ev = { origin: { plugin: "rss-reader", source: "https://x.example/feed.xml", nativeId: "g1" }, sourceVersion: "v1", eventType: "create", author: "a", content: "标题", occurredAt: "2026-11-08T10:00:00.000Z", receivedAt: "2026-11-09T01:00:00.000Z", attachments: [{ ref: "https://x.example/a.mp3", mime: "audio/mpeg" }], trust: "untrusted" };
  const ok = checkResult("plugins.pull", { events: [ev], rejected: [{ sourceId: "s", index: 0, reason: "缺 nativeId" }], failures: [{ sourceId: "s2", reason: "pull-failed", detail: "HTTP 404" }] });
  assert.ok(ok.ok);
  assert.equal((ok.value as { events: { trust: string }[] }).events[0]!.trust, "untrusted");
  assert.equal(checkResult("plugins.pull", { events: [{ ...ev, trust: "trusted" }], rejected: [], failures: [] }).ok, false);
  assert.ok(checkParams("plugins.send", { pluginId: "webhook-out", actionId: "a1", payload: "你好" }).ok);
  const noAction = checkParams("plugins.send", { pluginId: "webhook-out", payload: "你好" });
  assert.equal(noAction.ok ? "" : formatIssues(noAction.issues), "actionId: 缺少必填字段");
  const sent = checkResult("plugins.send", { state: "delivery-unknown", receiptId: null, deduplicated: false, reason: "retry-refused", detail: "B2 渠道结果未知" });
  assert.ok(sent.ok);
  assert.equal((sent.value as { state: string }).state, "delivery-unknown");
  assert.equal(checkResult("plugins.send", { state: "maybe", receiptId: null, deduplicated: false, reason: null, detail: null }).ok, false);
});
