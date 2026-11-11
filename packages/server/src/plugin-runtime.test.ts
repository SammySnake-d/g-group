// AC-35 阶段 I 宿主契约:插件代码在宿主起的独立进程里真正执行(§8.1 已定 17:插件交回的异常对象交进程隔离兜底)。
// 隔离用 Node 权限模型:只能读自己的包目录,不能写文件、起子进程,环境变量只给插件 id;网络不在权限模型里,未隔离。
// 只有 JSON 能过进程边界;超时、崩溃、非 JSON 输出、超大输出都收成受控失败,宿主照常可用。
// 两个示例插件(rss-reader 数据源、webhook-out 输出渠道)的真实代码在隔离进程里跑;门禁沙箱禁网,所以由宿主配置的预加载模块
// 把插件进程里的 fetch 换成按 URL 回剧本的替身(插件改不了预加载)。真实网络下的运行见 packages/server/proof/plugin-exec.txt。
// 隔离用例只用假 HOME 下的中性标记文件(内容 NEUTRAL_FIXTURE_NO_CREDENTIALS)。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { cleanupKit, closeKitHosts, setup } from "./test-kit.ts";

const HOST_ONLY = "GG_PLUGIN_TEST_HOST_ONLY";
process.env[HOST_ONLY] = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
afterEach(() => closeKitHosts());
const netDir = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-fakenet-")));
after(() => {
  delete process.env[HOST_ONLY];
  cleanupKit();
  rmSync(netDir, { recursive: true, force: true });
});

/** 在临时目录写一个本地插件包并经 local-path 装上。 */
async function installFixture(s: ReturnType<typeof setup>, id: string, code: string, extra: { kinds?: string[]; entry?: string; files?: Record<string, string> } = {}) {
  const pkg = path.join(s.root, "src", id);
  mkdirSync(pkg, { recursive: true });
  const entry = extra.entry ?? "index.mjs";
  writeFileSync(path.join(pkg, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", publisher: "test", description: "", kinds: extra.kinds ?? ["data-source"], permissions: [], entry, configSchema: { type: "object" } }));
  writeFileSync(path.join(pkg, entry), code);
  for (const [f, body] of Object.entries(extra.files ?? {})) writeFileSync(path.join(pkg, f), body);
  const r = await s.svc.handle("plugins.install", { clientActionId: `i-${id}`, source: { kind: "local-path", path: pkg }, grantedPermissions: [] });
  assert.ok(r.ok, JSON.stringify(r));
  return pkg;
}
type Ev = { origin: { plugin: string; source: string; nativeId: string }; content: string; eventType: string; author: string; occurredAt: string; receivedAt: string; trust: string; sourceVersion: string; attachments: unknown[] };
type SendOut = { state: string; reason: string | null };
type PullOut = { events: Ev[]; rejected: { sourceId: string; index: number; reason: string }[]; failures: { sourceId: string; reason: string; detail: string }[] };
async function pull(s: ReturnType<typeof setup>, pluginId: string, sourceId?: string) {
  const r = await s.svc.handle("plugins.pull", sourceId === undefined ? { pluginId } : { pluginId, sourceId });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as PullOut;
}
const EVENT = (nativeId: string, content: string) => `{ nativeId: ${JSON.stringify(nativeId)}, sourceVersion: "v1", eventType: "create", author: "a", content: ${JSON.stringify(content)}, occurredAt: "2026-11-08T00:00:00Z", attachments: [] }`;
async function gone(pid: number) {
  for (let i = 0; i < 500; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>站点</title>
<item><title>A &amp; B 发布</title><link>https://example.test/a</link><guid>guid-a</guid><pubDate>Sun, 08 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>第一条 <b>正文</b></p>]]></description><author>编辑甲</author></item>
<item><title>第二条</title><link>https://example.test/b</link><pubDate>Sun, 08 Nov 2026 11:30:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>原子</title>
<entry><id>urn:x:1</id><title type="html">Atom 条目</title><link href="https://example.test/c"/><updated>2026-11-08T12:00:00Z</updated><author><name>作者乙</name></author><summary>摘要 &lt;一&gt;</summary></entry>
</feed>`;
/** 插件进程里的 fetch 替身:订阅地址回 RSS/Atom;Webhook 把这一进程里第几次请求、方法、动作头与请求体(URL 编码)编进回执号;
 *  动作 hang 永不回应;其余地址 404。写进临时目录,经宿主选项 pluginRuntime.preload 交给插件进程。 */
function fakeNetPreload() {
  const f = path.join(netDir, "fake-net.mjs");
  writeFileSync(
    f,
    `let n = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === "https://feeds.example/rss.xml") return new Response(${JSON.stringify(RSS)}, { headers: { "content-type": "application/rss+xml" } });
  if (u === "https://feeds.example/atom.xml") return new Response(${JSON.stringify(ATOM)}, { headers: { "content-type": "application/atom+xml" } });
  if (u === "https://hooks.example/hook") {
    const body = String(init.body ?? "");
    if (JSON.parse(body).action_id === "hang") return new Promise(() => {});
    n++;
    return new Response("ok", { headers: { "x-receipt-id": \`r-\${n}|\${init.method}|\${new Headers(init.headers).get("x-g-group-action-id")}|\${encodeURIComponent(body)}\` } });
  }
  return new Response("", { status: 404 });
};
`,
  );
  return f;
}

test("插件在独立进程里运行:读包外的标记文件、写文件、起子进程都被拒,看不到宿主的环境变量", async () => {
  const s = setup();
  const home = path.join(s.root, "home");
  mkdirSync(home, { recursive: true });
  const marker = path.join(home, "outside-marker.txt");
  writeFileSync(marker, "NEUTRAL_FIXTURE_NO_CREDENTIALS\n");
  await installFixture(
    s,
    "probe",
    `import fs from "node:fs";
export default {
  kind: "data-source",
  describe() { return { sources: ["probe"] }; },
  async pull() {
    const r = { pid: process.pid };
    try { fs.readFileSync(${JSON.stringify(marker)}, "utf8"); r.read = "ok"; } catch (e) { r.read = e.code; }
    try { fs.writeFileSync("out.txt", "x"); r.write = "ok"; } catch (e) { r.write = e.code; }
    try { (await import("node:child_process")).execFileSync(process.execPath, ["-e", "0"]); r.spawn = "ok"; } catch (e) { r.spawn = e.code; }
    r.self = fs.readFileSync(new URL("./plugin.json", import.meta.url), "utf8").includes('"probe"');
    r.hostVar = process.env.${HOST_ONLY} ?? null;
    r.pluginId = process.env.G_GROUP_PLUGIN_ID ?? null;
    r.home = process.env.HOME ?? null;
    return [${EVENT("p1", "__R__")}].map((e) => ({ ...e, content: JSON.stringify(r) }));
  },
};`,
  );
  const out = await pull(s, "probe");
  assert.deepEqual(out.failures, []);
  assert.equal(out.events.length, 1);
  const r = JSON.parse(out.events[0]!.content) as Record<string, unknown>;
  assert.deepEqual(
    { read: r.read, write: r.write, spawn: r.spawn, self: r.self, hostVar: r.hostVar, pluginId: r.pluginId, home: r.home },
    { read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", self: true, hostVar: null, pluginId: "probe", home: null },
  );
  assert.notEqual(r.pid, process.pid, "插件代码不在宿主进程里跑");
  assert.equal(s.host.plugins.pid("probe"), r.pid);
  const ev = out.events[0]!;
  assert.deepEqual([ev.origin, ev.trust, ev.receivedAt, ev.occurredAt], [{ plugin: "probe", source: "probe", nativeId: "p1" }, "untrusted", "2026-11-09T01:00:00.000Z", "2026-11-08T00:00:00.000Z"]);
  assert.equal(existsSync(path.join(s.root, "data", "plugin-data", "probe", "out.txt")), false);
});

test("rss-reader 示例插件:在隔离进程里按配置拉 RSS 与 Atom 订阅,宿主盖章成不可信外部事件", async () => {
  const s = setup({ pluginRuntime: { preload: fakeNetPreload() } });
  const base = "https://feeds.example";
  const inst = await s.svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "rss-reader" }, grantedPermissions: ["net:fetch"] });
  assert.ok(inst.ok, JSON.stringify(inst));
  assert.equal((inst.value as { executable?: boolean }).executable, true);
  const none = await s.svc.handle("plugins.pull", { pluginId: "rss-reader" });
  assert.equal(!none.ok && none.error.code, "invalid_params", "没配置订阅就没有可拉的来源");
  await s.svc.handle("plugins.configure", { pluginId: "rss-reader", config: { feeds: [`${base}/rss.xml`, `${base}/atom.xml`, `${base}/missing.xml`] } });
  const out = await pull(s, "rss-reader");
  assert.deepEqual(
    out.events.map((e) => [e.origin.source.replace(base, ""), e.origin.nativeId, e.author, e.occurredAt, e.content, e.eventType, e.trust, e.receivedAt]),
    [
      ["/rss.xml", "guid-a", "编辑甲", "2026-11-08T10:00:00.000Z", "A & B 发布\nhttps://example.test/a\n第一条 正文", "create", "untrusted", "2026-11-09T01:00:00.000Z"],
      ["/rss.xml", "https://example.test/b", "", "2026-11-08T11:30:00.000Z", "第二条\nhttps://example.test/b", "create", "untrusted", "2026-11-09T01:00:00.000Z"],
      ["/atom.xml", "urn:x:1", "作者乙", "2026-11-08T12:00:00.000Z", "Atom 条目\nhttps://example.test/c\n摘要 <一>", "create", "untrusted", "2026-11-09T01:00:00.000Z"],
    ],
  );
  assert.deepEqual(out.failures.map((f) => [f.sourceId.replace(base, ""), f.reason]), [["/missing.xml", "pull-failed"]]);
  assert.match(out.failures[0]!.detail, /HTTP 404/);
  const one = await pull(s, "rss-reader", `${base}/atom.xml`);
  assert.deepEqual(one.events.map((e) => e.origin.nativeId), ["urn:x:1"]);
  assert.equal(one.events[0]!.sourceVersion, out.events[2]!.sourceVersion, "内容没变,源端版本号不变");
  const undeclared = await pull(s, "rss-reader", `${base}/other.xml`);
  assert.deepEqual(undeclared.failures.map((f) => f.reason), ["source-not-declared"]);
});

test("webhook-out 示例插件:在隔离进程里 POST 到配置的地址拿回执;同一动作重发只认已有回执,不再请求", async () => {
  const s = setup({ pluginRuntime: { preload: fakeNetPreload() } });
  await s.svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "webhook-out" }, grantedPermissions: ["net:post"] });
  const unset = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a0", payload: "x" });
  assert.equal(!unset.ok && unset.error.code, "invalid_params", "没配置地址就没有接收端");
  await s.svc.handle("plugins.configure", { pluginId: "webhook-out", config: { url: "https://hooks.example/hook" } });
  const rid = (k: number, action: string, text: string) => `r-${k}|POST|${action}|${encodeURIComponent(JSON.stringify({ action_id: action, text }))}`;
  const first = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a1", payload: "你好" });
  assert.deepEqual(first, { ok: true, value: { state: "confirmed", receiptId: rid(1, "a1", "你好"), deduplicated: false, reason: null, detail: null } });
  const again = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a1", payload: "你好" });
  assert.deepEqual(again, { ok: true, value: { state: "confirmed", receiptId: rid(1, "a1", "你好"), deduplicated: true, reason: null, detail: null } });
  const changed = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a1", payload: "改过的内容" });
  const ch = changed.ok ? (changed.value as SendOut) : null;
  assert.deepEqual(ch && [ch.state, ch.reason], ["rejected", "payload-mismatch"]);
  const next = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a3", payload: "第二件" });
  assert.deepEqual(next.ok && (next.value as { receiptId: string }).receiptId, rid(2, "a3", "第二件"), "重发与改内容都没有发请求:下一件是这个进程的第 2 次请求");
});

test("webhook 接收端不回应:记结果未知并结束插件进程;B2 渠道之后拒绝自动重发", async () => {
  const s = setup({ pluginRuntime: { sendTimeoutMs: 1500, preload: fakeNetPreload() } });
  await s.svc.handle("plugins.install", { clientActionId: "i1", source: { kind: "marketplace", id: "webhook-out" }, grantedPermissions: ["net:post"] });
  await s.svc.handle("plugins.configure", { pluginId: "webhook-out", config: { url: "https://hooks.example/hook" } });
  const warm = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "warm", payload: "p" });
  assert.equal(warm.ok && (warm.value as SendOut).state, "confirmed");
  const pid = s.host.plugins.pid("webhook-out")!;
  const first = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "hang", payload: "p" });
  const f1 = first.ok ? (first.value as SendOut) : null;
  assert.deepEqual(f1 && [f1.state, f1.reason], ["delivery-unknown", "timeout"]);
  assert.equal(await gone(pid), true, "不回应的插件进程被结束");
  const retry = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "hang", payload: "p" });
  const r2 = retry.ok ? (retry.value as SendOut) : null;
  assert.deepEqual(r2 && [r2.state, r2.reason], ["delivery-unknown", "retry-refused"]);
  const after1 = await s.svc.handle("plugins.send", { pluginId: "webhook-out", actionId: "a4", payload: "之后" });
  assert.deepEqual(after1.ok && (after1.value as { receiptId: string }).receiptId, `r-1|POST|a4|${encodeURIComponent(JSON.stringify({ action_id: "a4", text: "之后" }))}`, "新进程的第 1 次请求:拒绝重发时没有调用插件");
  assert.notEqual(s.host.plugins.pid("webhook-out"), pid);
});

test("插件死循环超时被结束,宿主照常可用;下次调用重新起进程", async () => {
  const s = setup({ pluginRuntime: { callTimeoutMs: 1500 } });
  await installFixture(
    s,
    "spinner",
    `export default {
  kind: "data-source",
  describe() { return { sources: ["ok", "spin"] }; },
  async pull(src) { if (src === "spin") { for (;;) {} } return [${EVENT("e1", "正常")}]; },
};`,
  );
  const ok1 = await pull(s, "spinner", "ok");
  assert.deepEqual(ok1.events.map((e) => e.content), ["正常"]);
  const pid1 = s.host.plugins.pid("spinner");
  assert.equal(typeof pid1, "number");
  const spun = await pull(s, "spinner", "spin");
  assert.deepEqual(spun.events, []);
  assert.deepEqual(spun.failures.map((f) => f.reason), ["pull-failed"]);
  assert.match(spun.failures[0]!.detail, /1500ms 没有回应/);
  assert.equal(await gone(pid1!), true, "死循环的进程被结束");
  const list = await s.svc.handle("plugins.list", {});
  assert.ok(list.ok, "宿主照常回应");
  const ok2 = await pull(s, "spinner", "ok");
  assert.deepEqual(ok2.events.map((e) => e.content), ["正常"]);
  const pid2 = s.host.plugins.pid("spinner");
  assert.notEqual(pid2, pid1);
});

test("插件进程崩溃、往标准输出写非 JSON、单行输出超过上限:都成受控失败,宿主仍可用", async () => {
  const s = setup({ pluginRuntime: { maxLineBytes: 64 * 1024 } });
  await installFixture(
    s,
    "flaky",
    `export default {
  kind: "data-source",
  describe() { return { sources: ["crash", "garbage", "huge", "ok"] }; },
  async pull(src) {
    if (src === "crash") process.exit(3);
    if (src === "garbage") { process.stdout.write("这不是 JSON\\n"); await new Promise((r) => setTimeout(r, 2000)); return []; }
    if (src === "huge") return [${EVENT("big", "x")}].map((e) => ({ ...e, content: "x".repeat(200 * 1024) }));
    return [${EVENT("e1", "正常")}];
  },
};`,
  );
  const cases: [string, RegExp][] = [
    ["crash", /插件进程退出\(code=3/],
    ["garbage", /非 JSON/],
    ["huge", /超过 65536 字节/],
  ];
  for (const [src, why] of cases) {
    const out = await pull(s, "flaky", src);
    assert.deepEqual(out.failures.map((f) => [f.sourceId, f.reason]), [[src, "pull-failed"]], src);
    assert.match(out.failures[0]!.detail, why, src);
    const ok = await pull(s, "flaky", "ok");
    assert.deepEqual(ok.events.map((e) => e.content), ["正常"], `${src} 之后照常可用`);
  }
});

type SendView = { state: string; receiptId: string | null; reason: string | null; detail: string | null };
async function send(s: ReturnType<typeof setup>, pluginId: string, actionId: string) {
  const r = await s.svc.handle("plugins.send", { pluginId, actionId, payload: "p" });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as SendView;
}

test("插件里没人接的拒绝、未捕获的异常、调 process.exit:只结束插件进程,这次外发记结果未知;重起后同一动作不自动重发", async () => {
  const s = setup({ pluginRuntime: { sendTimeoutMs: 10_000 } });
  await installFixture(
    s,
    "fragile",
    `let n = 0;
export default {
  kind: "outbound-channel",
  describe() { return { idempotency: "none", endpoint: "https://hooks.example/fragile" }; },
  async send(req) {
    n++;
    if (req.action_id === "reject") { Promise.reject(new Error("没人接的拒绝")); return new Promise(() => {}); }
    if (req.action_id === "throw") { setTimeout(() => { throw new Error("未捕获的异常"); }, 0); return new Promise(() => {}); }
    if (req.action_id === "exit") process.exit(5);
    return { action_id: req.action_id, receiptId: "进程内第 " + n + " 次" };
  },
};`,
    { kinds: ["outbound-channel"] },
  );
  const cases: [string, RegExp][] = [
    ["reject", /插件进程退出\(code=1,/],
    ["throw", /插件进程退出\(code=1,/],
    ["exit", /插件进程退出\(code=5,/],
  ];
  for (const [action, why] of cases) {
    const warm = await send(s, "fragile", `warm-${action}`);
    assert.equal(warm.state, "confirmed", action);
    const pid = s.host.plugins.pid("fragile")!;
    const r = await send(s, "fragile", action);
    assert.deepEqual([r.state, r.reason], ["delivery-unknown", "send-threw"], action);
    assert.match(r.detail ?? "", why, action);
    assert.equal(await gone(pid), true, `${action}:插件进程结束`);
    const list = await s.svc.handle("plugins.list", {});
    assert.ok(list.ok, `${action}:宿主照常回应`);
    const retry = await send(s, "fragile", action);
    assert.deepEqual([retry.state, retry.reason], ["delivery-unknown", "retry-refused"], `${action}:同一动作不自动重发`);
    const next = await send(s, "fragile", `next-${action}`);
    assert.deepEqual([next.state, next.receiptId], ["confirmed", "进程内第 1 次"], `${action}:新进程的第 1 次调用,拒绝重发时没有调用插件`);
    assert.notEqual(s.host.plugins.pid("fragile"), pid);
  }
});

test("插件内存超过上限:只结束插件进程,这次拉取记失败,宿主照常;下次调用重新起进程", async () => {
  const s = setup({ pluginRuntime: { maxHeapMb: 64, callTimeoutMs: 12_000 } });
  await installFixture(
    s,
    "hog",
    `export default {
  kind: "data-source",
  describe() { return { sources: ["hog", "ok"] }; },
  async pull(src) {
    if (src === "hog") {
      const keep = [];
      for (let i = 0; i < 400; i++) { keep.push(new Array(1 << 16).fill(i + 0.5)); if (i % 16 === 0) await new Promise((r) => setImmediate(r)); }
      await new Promise((r) => setTimeout(r, 15_000));
      return [keep.length];
    }
    return [${EVENT("e1", "正常")}];
  },
};`,
  );
  const ok1 = await pull(s, "hog", "ok");
  assert.deepEqual(ok1.events.map((e) => e.content), ["正常"]);
  const pid1 = s.host.plugins.pid("hog")!;
  const hog = await pull(s, "hog", "hog");
  assert.deepEqual(hog.failures.map((f) => [f.sourceId, f.reason]), [["hog", "pull-failed"]]);
  assert.match(hog.failures[0]!.detail, /插件进程退出/, "按内存上限结束,不是等到超时");
  assert.doesNotMatch(hog.failures[0]!.detail, /没有回应/);
  assert.equal(await gone(pid1), true);
  const ok2 = await pull(s, "hog", "ok");
  assert.deepEqual(ok2.events.map((e) => e.content), ["正常"]);
  assert.notEqual(s.host.plugins.pid("hog"), pid1);
});

test("插件回应按请求 id 对上:旧 id、未知 id 的回应被丢弃;外发超时后才到的回执不改已落地的结果未知", async () => {
  const s = setup({ pluginRuntime: { sendTimeoutMs: 1000, sendGraceMs: 4000 } });
  await installFixture(
    s,
    "stray",
    `export default {
  kind: "data-source",
  describe() { return { sources: ["stray"] }; },
  async pull() {
    const fake = [${EVENT("fake", "伪造")}];
    process.stdout.write(JSON.stringify({ id: 1, ok: true, result: fake }) + "\\n");
    process.stdout.write(JSON.stringify({ id: 99999, ok: true, result: fake }) + "\\n");
    process.stdout.write(JSON.stringify({ id: 1, ok: false, error: "伪造的失败" }) + "\\n");
    await new Promise((r) => setTimeout(r, 300));
    return [${EVENT("real", "真的")}];
  },
};`,
  );
  const out = await pull(s, "stray");
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.events.map((e) => [e.origin.nativeId, e.content]), [["real", "真的"]]);
  await installFixture(
    s,
    "slowpoke",
    `let n = 0;
export default {
  kind: "outbound-channel",
  describe() { return { idempotency: "none", endpoint: "https://hooks.example/slow" }; },
  async send(req) {
    n++;
    if (req.action_id === "late") await new Promise((r) => setTimeout(r, 1500));
    return { action_id: req.action_id, receiptId: "进程内第 " + n + " 次" };
  },
};`,
    { kinds: ["outbound-channel"] },
  );
  const warm = await send(s, "slowpoke", "warm");
  assert.equal(warm.state, "confirmed");
  const pid = s.host.plugins.pid("slowpoke")!;
  const late = await send(s, "slowpoke", "late");
  assert.deepEqual([late.state, late.reason], ["delivery-unknown", "timeout"]);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(s.host.plugins.pid("slowpoke"), pid, "回执在宽限内到了,进程没被结束");
  const retry = await send(s, "slowpoke", "late");
  assert.deepEqual([retry.state, retry.reason], ["delivery-unknown", "retry-refused"], "迟到的回执没把结果改成已确认");
  const next = await send(s, "slowpoke", "next");
  assert.deepEqual([next.state, next.receiptId], ["confirmed", "进程内第 3 次"], "迟到之后同一进程照常,拒绝重发时没有调用插件");
});

test("插件交回 getter、Proxy 包装的数组和类实例:过了进程边界只剩 JSON 数据,宿主照常盖章", async () => {
  const s = setup();
  await installFixture(
    s,
    "odd",
    `class Ev {
  constructor() {
    this.nativeId = "o1"; this.sourceVersion = "v1"; this.eventType = "create"; this.author = "a"; this.occurredAt = "2026-11-08T00:00:00Z"; this.attachments = []; this.extra = () => 1;
    Object.defineProperty(this, "content", { enumerable: true, get: () => "来自 getter" });
  }
}
export default {
  kind: "data-source",
  describe() { return { sources: ["s"] }; },
  async pull() { return new Proxy([new Ev()], {}); },
};`,
  );
  const out = await pull(s, "odd");
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.events.map((e) => [e.origin.nativeId, e.content, e.trust]), [["o1", "来自 getter", "untrusted"]]);
});

test("停用、改配置、卸载时结束旧插件进程;停用后调用被拒", async () => {
  const s = setup();
  const code = `let tag = "无";
export default {
  kind: "data-source",
  init(config) { tag = config?.tag ?? "无"; },
  describe() { return { sources: ["s"] }; },
  async pull() { return [${EVENT("e1", "__")}].map((e) => ({ ...e, content: tag })); },
};`;
  await installFixture(s, "life", code);
  assert.deepEqual((await pull(s, "life")).events.map((e) => e.content), ["无"]);
  const pid1 = s.host.plugins.pid("life")!;
  await s.svc.handle("plugins.setEnabled", { pluginId: "life", enabled: false });
  assert.equal(await gone(pid1), true, "停用后进程结束");
  assert.equal(s.host.plugins.pid("life"), null);
  const off = await s.svc.handle("plugins.pull", { pluginId: "life" });
  assert.deepEqual(!off.ok && [off.error.code, off.error.message], ["conflict", "插件 life 已停用"]);
  await s.svc.handle("plugins.setEnabled", { pluginId: "life", enabled: true });
  await s.svc.handle("plugins.configure", { pluginId: "life", config: { tag: "一" } });
  assert.deepEqual((await pull(s, "life")).events.map((e) => e.content), ["一"]);
  const pid2 = s.host.plugins.pid("life")!;
  await s.svc.handle("plugins.configure", { pluginId: "life", config: { tag: "二" } });
  assert.equal(await gone(pid2), true, "改配置后旧进程结束");
  assert.deepEqual((await pull(s, "life")).events.map((e) => e.content), ["二"], "新进程用新配置");
  const pid3 = s.host.plugins.pid("life")!;
  await s.svc.handle("plugins.uninstall", { pluginId: "life" });
  assert.equal(await gone(pid3), true, "卸载后进程结束");
  assert.equal(existsSync(path.join(s.root, "data", "plugin-data", "life")), false);
});

test("插件包里有符号链接、入口不是 .mjs、或没有可执行入口时不启动", async () => {
  const s = setup();
  const pkg = await installFixture(s, "linked", `export default { kind: "data-source", describe() { return { sources: ["s"] }; }, async pull() { return []; } };`);
  symlinkSync(path.join(s.root, "home-not-there"), path.join(s.root, "data", "plugins", "linked", "1.0.0", "link"));
  const linked = await s.svc.handle("plugins.pull", { pluginId: "linked" });
  assert.deepEqual(!linked.ok && [linked.error.code, linked.error.message], ["forbidden", "插件包里有符号链接 link,不启动(权限模型会跟着符号链接读到包外)"]);
  assert.equal(s.host.plugins.pid("linked"), null);
  assert.ok(existsSync(pkg));
  await installFixture(s, "cjs", "module.exports = {};", { entry: "index.js" });
  const cjs = await s.svc.handle("plugins.pull", { pluginId: "cjs" });
  assert.deepEqual(!cjs.ok && cjs.error.code, "unavailable");
  assert.match(!cjs.ok ? cjs.error.message : "", /入口必须是 \.mjs/);
  const manifestOnly = path.join(s.root, "src", "noentry");
  mkdirSync(manifestOnly, { recursive: true });
  writeFileSync(path.join(manifestOnly, "plugin.json"), JSON.stringify({ id: "noentry", name: "n", version: "1.0.0", publisher: "t", description: "", kinds: ["data-source"], permissions: [] }));
  await s.svc.handle("plugins.install", { clientActionId: "i-n", source: { kind: "local-path", path: manifestOnly }, grantedPermissions: [] });
  const noentry = await s.svc.handle("plugins.pull", { pluginId: "noentry" });
  assert.deepEqual(!noentry.ok && [noentry.error.code, noentry.error.message], ["unavailable", "插件 noentry 没有可执行代码(清单没有 entry)"]);
  const wrongKind = await s.svc.handle("plugins.send", { pluginId: "linked", actionId: "x", payload: "p" });
  assert.equal(!wrongKind.ok && wrongKind.error.code, "invalid_params");
});
