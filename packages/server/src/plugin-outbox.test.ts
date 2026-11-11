// T-177 C:插件外发跨宿主重启(审查记录 t177-backend-resume-review.md §C 十一条)。
// 权威状态在宿主 SQLite 的外发表;插件在真实隔离子进程里跑。接收端是插件进程里的中性计数:每个回执带上这个进程收到过的全部 action_id,
// 「接收次数」= 各插件进程里出现的次数之和;宿主拒发时不起进程(pid 为 null),新进程的回执里也没有它,即这一次没有投递。
// 宕机用同一个数据文件上新开一个宿主来模拟(重启时上一次的在途行改成结果未知);只在每个用例自己的临时数据目录里测。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { openDb } from "./db.ts";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { PluginOutbox, printOf } from "./plugin-outbox.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-c-outbox-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20 }));
const NOW_MS = Date.parse("2026-11-11T01:00:00.000Z");
let n = 0;

/** 中性接收端插件:payload hold 等到 release 动作才回执;hang 永不回应;exit 结束进程;flaky 本进程第一次见到这个动作时报错。 */
function pluginCode(describe: string) {
  return `const seen = [];
const held = [];
const failed = new Set();
const receipt = (id) => ({ action_id: id, receiptId: JSON.stringify({ pid: process.pid, seen: [...seen] }) });
export default {
  kind: "outbound-channel",
  describe() { return ${describe}; },
  async send(req) {
    seen.push(req.action_id);
    if (req.action_id.startsWith("release")) { for (const f of held.splice(0)) f(); return receipt(req.action_id); }
    if (req.payload === "hold") return new Promise((r) => held.push(() => r(receipt(req.action_id))));
    if (req.payload === "hang") return new Promise(() => {});
    if (req.payload === "exit") process.exit(3);
    if (req.payload === "flaky" && !failed.has(req.action_id)) { failed.add(req.action_id); throw new Error("中性接收端第一次报错"); }
    return receipt(req.action_id);
  },
};`;
}
const B2 = `{ idempotency: "none", endpoint: "neutral:b2" }`;
const B1 = `{ idempotency: "action-id", idempotencyWindowMs: 86400000, endpoint: "neutral:b1" }`;

function pkg(dir: string, id: string, version: string, describe: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version, publisher: "test", description: "", kinds: ["outbound-channel"], permissions: [], entry: "index.mjs", configSchema: { type: "object" } }));
  writeFileSync(path.join(dir, "index.mjs"), pluginCode(describe));
  return dir;
}

interface World {
  readonly dir: string;
  readonly hosts: Host[];
  readonly pending: Promise<unknown>[];
  readonly clock: { bad: boolean };
}
function world(): World {
  const dir = path.join(root, `w${++n}`);
  mkdirSync(path.join(dir, "catalog"), { recursive: true });
  writeFileSync(path.join(dir, "catalog", "catalog.json"), JSON.stringify({ entries: [] }));
  return { dir, hosts: [], pending: [], clock: { bad: false } };
}
/** 在 w 的数据文件上开一个宿主(同一文件再开一个 = 重启后的宿主)。 */
function boot(H: typeof Host, w: World, sendTimeoutMs = 10_000) {
  const h = new H({
    file: path.join(w.dir, "gg.db"),
    dataDir: path.join(w.dir, "data"),
    catalogFile: path.join(w.dir, "catalog", "catalog.json"),
    mind: () => scriptedMind(),
    maxDeferMs: 5,
    clockMs: () => (w.clock.bad ? Number.NaN : NOW_MS),
    pluginFetch: async () => new Response("", { status: 404 }),
    pluginRuntime: { sendTimeoutMs, sendGraceMs: 100 },
  });
  w.hosts.push(h);
  return h;
}
/** 收尾:关掉全部宿主(连带插件进程),等完还没结束的外发。 */
async function end(w: World) {
  for (const h of w.hosts.splice(0)) await h.close();
  await Promise.allSettled(w.pending);
}
function later<T>(w: World, p: Promise<T>) {
  w.pending.push(p.catch(() => undefined));
  return p;
}
const seenIn = (r: { receiptId: string | null }) => (JSON.parse(r.receiptId ?? "{}") as { seen?: string[] }).seen ?? [];
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
async function installLocal(h: Host, dir: string) {
  return h.plugins.install({ kind: "local-path", path: dir }, []);
}

test("C01 写前日志:插件收到之前在途行已落盘,带安装身份、版本、接收端与载荷指纹,不存载荷原文", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await installLocal(h, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    await h.plugins.send("ledger", "warm", "w");
    const x = later(w, h.plugins.send("ledger", "x1", "hold"));
    const probe = await h.plugins.send("ledger", "p1", "p");
    assert.deepEqual(seenIn(probe), ["warm", "x1", "p1"], "插件已经收到 x1");
    const v = h.plugins.delivery("ledger", "x1");
    assert.deepEqual(
      v && [v.state, v.reason, v.receiptId, v.installId, v.version, v.endpoint, v.idempotency, v.windowMs, v.payloadSha256, v.payloadBytes],
      ["in_flight", null, null, h.plugins.installId("ledger"), "1.0.0", "neutral:b2", "none", null, sha("hold"), 4],
    );
    const raw = JSON.stringify(h.db.store.db.prepare("SELECT * FROM gg_plugin_outbox").all());
    assert.equal(raw.includes('"hold"'), false, "外发表里没有载荷原文");
    await h.plugins.send("ledger", "release1", "r");
    const done = await x;
    assert.equal(done.state, "confirmed");
    assert.deepEqual(h.plugins.delivery("ledger", "x1")?.receiptId, done.receiptId, "回执 id 原样存");
  } finally {
    await end(w);
  }
});

test("C02 外发记录写不进数据库就不外发,也不留在途行", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await installLocal(h, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    await h.plugins.send("ledger", "warm", "w");
    h.db.store.db.exec("CREATE TRIGGER gg_c02_fail BEFORE INSERT ON gg_plugin_outbox BEGIN SELECT RAISE(ABORT, 'NEUTRAL_FIXTURE_NO_CREDENTIALS 写入失败'); END");
    await assert.rejects(h.plugins.send("ledger", "x2", "内容"), (e: Error & { code?: string }) => e.code === "unavailable" && /没有外发/.test(e.message));
    h.db.store.db.exec("DROP TRIGGER gg_c02_fail");
    assert.equal(h.plugins.delivery("ledger", "x2"), undefined);
    const probe = await h.plugins.send("ledger", "p2", "p");
    assert.deepEqual(seenIn(probe), ["warm", "p2"], "x2 没有交给插件");
    assert.equal(h.plugins.delivery("ledger", "p2")?.state, "confirmed");
  } finally {
    await end(w);
  }
});

test("C03 结果落盘:确认存回执 id;超时与插件进程退出存结果未知和原因", async () => {
  const w = world();
  try {
    const h = boot(Host, w, 800);
    await installLocal(h, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    const ok = await h.plugins.send("ledger", "ok", "好");
    const slow = await h.plugins.send("ledger", "slow", "hang");
    const gone = await h.plugins.send("ledger", "gone", "exit");
    assert.deepEqual([ok.state, slow.state, slow.reason, gone.state, gone.reason], ["confirmed", "delivery-unknown", "timeout", "delivery-unknown", "send-threw"]);
    const rows = ["ok", "slow", "gone"].map((a) => h.plugins.delivery("ledger", a));
    assert.deepEqual(
      rows.map((v) => v && [v.state, v.reason, v.receiptId]),
      [
        ["confirmed", null, ok.receiptId],
        ["delivery_unknown", "timeout", null],
        ["delivery_unknown", "send-threw", null],
      ],
    );
  } finally {
    await end(w);
  }
});

test("C04 插件收到后、宿主记确认前宕机:重启把在途记为未知,迟到的确认不改写,B2 不重发,接收端只收到一次", async () => {
  const w = world();
  try {
    const h1 = boot(Host, w);
    await installLocal(h1, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    await h1.plugins.send("ledger", "warm", "w");
    const x = later(w, h1.plugins.send("ledger", "x4", "hold"));
    assert.deepEqual(seenIn(await h1.plugins.send("ledger", "p4", "p")), ["warm", "x4", "p4"]);
    const h2 = boot(Host, w);
    const v = h2.plugins.delivery("ledger", "x4");
    assert.deepEqual(v && [v.state, v.reason], ["delivery_unknown", "host-restarted"]);
    const retry = await h2.plugins.send("ledger", "x4", "hold");
    assert.deepEqual([retry.state, retry.reason, retry.deduplicated], ["delivery-unknown", "retry-refused", false]);
    assert.equal(h2.plugins.pid("ledger"), null, "重启后的宿主没有为 x4 起插件进程");
    await h1.plugins.send("ledger", "release4", "r");
    const late = await x;
    assert.deepEqual([late.state, late.reason], ["delivery-unknown", "host-restarted"], "迟到的确认按表里的未知返回");
    const still = h2.plugins.delivery("ledger", "x4");
    assert.deepEqual(still && [still.state, still.reason, still.receiptId], ["delivery_unknown", "host-restarted", null], "迟到的确认没改写未知");
    const first = seenIn(await h1.plugins.send("ledger", "p4b", "p")).filter((a) => a === "x4").length;
    const second = seenIn(await h2.plugins.send("ledger", "w4", "w")).filter((a) => a === "x4").length;
    assert.equal(first + second, 1, "接收端收到 x4 恰好一次");
  } finally {
    await end(w);
  }
});

test("C05 重启后结果未知的 B1 也不自动重发;同一次启动里 B1 仍按内核保留期重试", async () => {
  const w = world();
  try {
    const h1 = boot(Host, w);
    await installLocal(h1, pkg(path.join(w.dir, "src", "b1"), "b1", "1.0.0", B1));
    const a = await h1.plugins.send("b1", "same", "flaky");
    assert.deepEqual([a.state, a.reason], ["delivery-unknown", "send-threw"]);
    const again = await h1.plugins.send("b1", "same", "flaky");
    assert.equal(again.state, "confirmed", "同一次启动、保留期内 B1 重试");
    assert.deepEqual(seenIn(again), ["same", "same"]);
    assert.equal(h1.plugins.delivery("b1", "same")?.state, "confirmed");
    const u = await h1.plugins.send("b1", "u5", "flaky");
    assert.equal(h1.plugins.delivery("b1", "u5")?.state, "delivery_unknown", u.reason ?? "");
    await h1.close();
    const h2 = boot(Host, w);
    const r = await h2.plugins.send("b1", "u5", "flaky");
    assert.deepEqual([r.state, r.reason], ["delivery-unknown", "clock-untrusted"]);
    assert.equal(h2.plugins.pid("b1"), null, "拒发时没有起插件进程");
    assert.deepEqual(seenIn(await h2.plugins.send("b1", "n5", "n")), ["n5"], "新进程没收到 u5");
  } finally {
    await end(w);
  }
});

test("C06 重启后已确认的动作复用存下的回执、不调插件;同一动作换了内容显式冲突", async () => {
  const w = world();
  try {
    const h1 = boot(Host, w);
    await installLocal(h1, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    const a = await h1.plugins.send("ledger", "a6", "内容");
    await h1.close();
    const h2 = boot(Host, w);
    const same = await h2.plugins.send("ledger", "a6", "内容");
    assert.deepEqual([same.state, same.receiptId, same.deduplicated], ["confirmed", a.receiptId, true]);
    const changed = await h2.plugins.send("ledger", "a6", "改过的内容");
    assert.deepEqual([changed.state, changed.reason], ["rejected", "payload-mismatch"]);
    assert.equal(h2.plugins.pid("ledger"), null, "复用与冲突都没有起插件进程");
    assert.equal(h2.plugins.delivery("ledger", "a6")?.payloadSha256, sha("内容"));
  } finally {
    await end(w);
  }
});

test("C07 安装身份:停用启用、改配置、更新都不变,卸载重装换新", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    const cat = path.join(w.dir, "catalog");
    pkg(path.join(cat, "m1"), "mk", "1.0.0", B1);
    writeFileSync(path.join(cat, "catalog.json"), JSON.stringify({ entries: [{ id: "mk", dir: "m1" }] }));
    await h.plugins.install({ kind: "marketplace", id: "mk" }, []);
    const id1 = h.plugins.installId("mk");
    await h.plugins.send("mk", "a7", "x");
    assert.equal(h.plugins.delivery("mk", "a7")?.installId, id1);
    h.plugins.setEnabled("mk", false);
    h.plugins.setEnabled("mk", true);
    h.plugins.configure("mk", { any: 1 });
    pkg(path.join(cat, "m2"), "mk", "1.1.0", B1);
    writeFileSync(path.join(cat, "catalog.json"), JSON.stringify({ entries: [{ id: "mk", dir: "m2" }] }));
    h.plugins.update("mk", undefined, undefined);
    assert.equal(h.plugins.get("mk").version, "1.1.0");
    assert.equal(h.plugins.installId("mk"), id1, "启停、改配置、更新后安装身份不变");
    h.plugins.uninstall("mk");
    await h.plugins.install({ kind: "marketplace", id: "mk" }, []);
    const id2 = h.plugins.installId("mk");
    assert.notEqual(id2, id1, "重装得到新的安装身份");
    await h.plugins.send("mk", "b7", "y");
    assert.deepEqual([h.plugins.delivery("mk", "a7")?.installId, h.plugins.delivery("mk", "b7")?.installId], [id1, id2]);
  } finally {
    await end(w);
  }
});

test("C08 卸载不删外发记录;重装后同一动作不发:已确认复用旧回执,结果未知不重发", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    const dir = pkg(path.join(w.dir, "src", "b1"), "b1", "1.0.0", B1);
    await installLocal(h, dir);
    const old = h.plugins.installId("b1");
    const a = await h.plugins.send("b1", "a8", "内容");
    const u = await h.plugins.send("b1", "u8", "flaky");
    assert.deepEqual([a.state, u.state], ["confirmed", "delivery-unknown"]);
    h.plugins.uninstall("b1");
    assert.deepEqual([h.plugins.delivery("b1", "a8")?.state, h.plugins.delivery("b1", "u8")?.state], ["confirmed", "delivery_unknown"], "卸载后外发记录还在");
    await installLocal(h, dir);
    assert.notEqual(h.plugins.installId("b1"), old);
    const again = await h.plugins.send("b1", "a8", "内容");
    assert.deepEqual([again.state, again.receiptId, again.deduplicated], ["confirmed", a.receiptId, true]);
    const retry = await h.plugins.send("b1", "u8", "flaky");
    assert.deepEqual([retry.state, retry.reason], ["delivery-unknown", "channel-changed"]);
    assert.equal(h.plugins.pid("b1"), null, "重装后旧动作都没有起插件进程");
    assert.deepEqual(seenIn(await h.plugins.send("b1", "n8", "n")), ["n8"], "新安装的进程没收到旧动作");
    assert.equal(h.plugins.delivery("b1", "u8")?.installId, old, "旧动作仍绑定旧安装");
  } finally {
    await end(w);
  }
});

test("C09 更新到新版本后,旧版本结果未知的 B1 动作不发", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    const cat = path.join(w.dir, "catalog");
    pkg(path.join(cat, "m1"), "mk", "1.0.0", B1);
    writeFileSync(path.join(cat, "catalog.json"), JSON.stringify({ entries: [{ id: "mk", dir: "m1" }] }));
    await h.plugins.install({ kind: "marketplace", id: "mk" }, []);
    const u = await h.plugins.send("mk", "u9", "flaky");
    assert.equal(u.state, "delivery-unknown");
    pkg(path.join(cat, "m2"), "mk", "1.1.0", B1);
    writeFileSync(path.join(cat, "catalog.json"), JSON.stringify({ entries: [{ id: "mk", dir: "m2" }] }));
    h.plugins.update("mk", undefined, undefined);
    const retry = await h.plugins.send("mk", "u9", "flaky");
    assert.deepEqual([retry.state, retry.reason], ["delivery-unknown", "channel-changed"]);
    assert.deepEqual(seenIn(await h.plugins.send("mk", "n9", "n")), ["n9"], "新版本进程没收到 u9");
    assert.equal(h.plugins.delivery("mk", "u9")?.version, "1.0.0");
  } finally {
    await end(w);
  }
});

test("C10 同一动作并发两次:只有认领到在途行的那一次外发,另一次按在途拒绝", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await installLocal(h, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    await h.plugins.send("ledger", "warm", "w");
    const one = later(w, h.plugins.send("ledger", "x10", "hold"));
    const two = await h.plugins.send("ledger", "x10", "hold");
    assert.deepEqual([two.state, two.reason], ["rejected", "in-flight"]);
    assert.equal(h.plugins.delivery("ledger", "x10")?.state, "in_flight");
    await h.plugins.send("ledger", "release10", "r");
    const won = await one;
    assert.equal(won.state, "confirmed");
    assert.equal(seenIn(await h.plugins.send("ledger", "p10", "p")).filter((a) => a === "x10").length, 1, "接收端只收到一次");
    assert.equal(h.plugins.delivery("ledger", "x10")?.receiptId, won.receiptId);
  } finally {
    await end(w);
  }
});

test("C11 没发生投递的拒绝不留在途行,之后同一动作照常首次外发", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await installLocal(h, pkg(path.join(w.dir, "src", "ledger"), "ledger", "1.0.0", B2));
    await h.plugins.send("ledger", "warm", "w");
    w.clock.bad = true;
    const r = await later(w, h.plugins.send("ledger", "z11", "内容")).finally(() => {
      w.clock.bad = false;
    });
    assert.deepEqual([r.state, r.reason], ["rejected", "clock-invalid"]);
    assert.equal(h.plugins.delivery("ledger", "z11"), undefined, "内核拒收时没有留在途行");
    const ok = await h.plugins.send("ledger", "z11", "内容");
    assert.deepEqual([ok.state, ok.deduplicated], ["confirmed", false]);
    assert.deepEqual(seenIn(ok), ["warm", "z11"]);
    assert.equal(h.plugins.delivery("ledger", "z11")?.state, "confirmed");
  } finally {
    await end(w);
  }
});

test("C12 外发表的持久化级别读回:WAL,synchronous 不是 OFF", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    const d = h.plugins.durability();
    console.log(`C12 PRAGMA journal_mode=${d.journalMode} synchronous=${d.synchronous}`);
    assert.equal(d.journalMode, "wal");
    assert.ok([1, 2, 3].includes(d.synchronous), `synchronous=${d.synchronous}`);
  } finally {
    await end(w);
  }
});

test("C13 两个连接同时认领同一个新动作:只有插入成功的那个拿到外发权,另一个按在途拒绝", () => {
  const w = world();
  const file = path.join(w.dir, "race.db");
  const a = openDb(file);
  const b = openDb(file);
  try {
    const now = () => "2026-11-11T01:00:00.000Z";
    const oa = new PluginOutbox(a, now, "boot-a");
    const ob = new PluginOutbox(b, now, "boot-b");
    const print = printOf("内容");
    const install = { installId: "i1", version: "1.0.0" };
    const ch = { endpoint: "neutral:b1", idempotency: "action-id" as const, windowMs: 1000 };
    assert.deepEqual([oa.decide("p", "x13", print, install, ch), ob.decide("p", "x13", print, install, ch)], [null, null], "两边都还没看到记录");
    const ca = oa.claim("p", "x13", print, install, ch);
    const cb = ob.claim("p", "x13", print, install, ch);
    assert.deepEqual([ca?.fresh, cb], [true, null]);
    const seen = ob.decide("p", "x13", print, install, ch);
    assert.deepEqual(seen && !seen.ok && [seen.state, seen.reason], ["rejected", "in-flight"]);
    assert.equal(ob.view("p", "x13")?.boot, "boot-a");
    assert.deepEqual(print, { sha256: sha("内容"), bytes: 6 });
  } finally {
    a.close();
    b.close();
  }
});
