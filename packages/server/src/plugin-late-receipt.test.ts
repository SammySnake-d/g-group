// T-177 C2:迟到应答留记录(需求 D29 第 5 条:迟到的应答按请求 id 丢弃并留记录,不改已经落地的账本状态)。
// 「迟到」= 宿主已不再等这一次投递之后插件才回的应答:内核记了超时,或宿主重启后这一行已记为结果未知。
// 记录只追加,不改外发状态、不触发重发、不改当时已返回的结果;不存应答全文;一直保留(卸载、重启都在)。
// 插件在真实隔离子进程里跑;接收端是插件进程里的中性计数(回执带上这个进程收到过的 action_id);只在每个用例自己的临时目录里测。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "gg-c2-late-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20 }));
const NOW_MS = Date.parse("2026-11-11T01:00:00.000Z");
let n = 0;

/** payload late:<毫秒> 过这么久才回(回执里回显载荷原文);bad 当场回一个动作对不上的应答;boom 报错;hang 永不回应;hold 等 release。 */
function pluginCode(describe: string) {
  return `const seen = [];
const held = [];
const receipt = (req) => ({ action_id: req.action_id, receiptId: JSON.stringify({ pid: process.pid, seen: [...seen] }), echo: req.payload });
export default {
  kind: "outbound-channel",
  describe() { return ${describe}; },
  async send(req) {
    seen.push(req.action_id);
    if (req.action_id.startsWith("release")) { for (const f of held.splice(0)) f(); return receipt(req); }
    if (req.payload.startsWith("late:")) { const ms = Number(req.payload.slice(5)); return new Promise((r) => setTimeout(() => r(receipt(req)), ms)); }
    if (req.payload === "bad") return { action_id: "别的动作", receiptId: "x" };
    if (req.payload === "boom") throw new Error("中性接收端报错");
    if (req.payload === "hang") return new Promise(() => {});
    if (req.payload === "hold") return new Promise((r) => held.push(() => r(receipt(req))));
    return receipt(req);
  },
};`;
}
const B2 = `{ idempotency: "none", endpoint: "neutral:b2" }`;
const B1 = `{ idempotency: "action-id", idempotencyWindowMs: 86400000, endpoint: "neutral:b1" }`;

function pkg(dir: string, id: string, describe: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", publisher: "test", description: "", kinds: ["outbound-channel"], permissions: [], entry: "index.mjs", configSchema: { type: "object" } }));
  writeFileSync(path.join(dir, "index.mjs"), pluginCode(describe));
  return dir;
}
interface World {
  readonly dir: string;
  readonly hosts: Host[];
  readonly pending: Promise<unknown>[];
}
function world(): World {
  const dir = path.join(root, `w${++n}`);
  mkdirSync(dir, { recursive: true });
  return { dir, hosts: [], pending: [] };
}
/** 在 w 的数据文件上开一个宿主(同一文件再开一个 = 重启后的宿主)。内核等 400ms 就记超时,插件进程再宽限 1500ms 才被结束。 */
function boot(H: typeof Host, w: World) {
  const h = new H({
    file: path.join(w.dir, "gg.db"),
    dataDir: path.join(w.dir, "data"),
    mind: () => scriptedMind(),
    maxDeferMs: 5,
    clockMs: () => NOW_MS,
    pluginFetch: async () => new Response("", { status: 404 }),
    pluginRuntime: { sendTimeoutMs: 400, sendGraceMs: 1500 },
  });
  w.hosts.push(h);
  return h;
}
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 等迟到记录出现(最多约 4 秒)。 */
async function lateOf(h: Host, id: string, action: string, want: number) {
  for (let i = 0; i < 80 && h.plugins.lateReceipts(id, action).length < want; i++) await pause(50);
  return h.plugins.lateReceipts(id, action);
}

test("L01 内核超时之后插件才回的回执记成迟到:来源、时间、回执 id 原样与整条应答指纹;不存应答全文", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await h.plugins.install({ kind: "local-path", path: pkg(path.join(w.dir, "src", "ledger"), "ledger", B2) }, []);
    const r = await h.plugins.send("ledger", "l1", "late:900");
    assert.deepEqual([r.state, r.reason, r.receiptId], ["delivery-unknown", "timeout", null]);
    assert.deepEqual(h.plugins.lateReceipts("ledger", "l1"), [], "内核放弃等待时还没有应答");
    const [rec, ...rest] = await lateOf(h, "ledger", "l1", 1);
    assert.equal(rest.length, 0);
    assert.ok(rec, "迟到的回执被记下");
    assert.deepEqual(
      [rec.pluginId, rec.actionId, rec.cause, rec.stateAtArrival, rec.reasonAtArrival, rec.installId, rec.version, rec.endpoint, rec.actionMatches, rec.receivedAt.length > 0],
      ["ledger", "l1", "timeout", "delivery_unknown", "timeout", h.plugins.installId("ledger"), "1.0.0", "neutral:b2", true, true],
    );
    assert.deepEqual(seenIn(rec), ["l1"], "回执 id 原样存下");
    const reply = JSON.stringify({ action_id: "l1", receiptId: rec.receiptId, echo: "late:900" });
    assert.deepEqual([rec.replySha256, rec.replyBytes], [sha(reply), Buffer.byteLength(reply)]);
    assert.equal(rec.boot, h.plugins.delivery("ledger", "l1")?.boot, "记录带上收到它的宿主启动编号");
    const raw = JSON.stringify(h.db.store.db.prepare("SELECT * FROM gg_plugin_late_receipts").all());
    assert.equal(raw.includes("late:900"), false, "插件回显的载荷原文没有进库");
  } finally {
    await end(w);
  }
});

test("L02 记迟到不改外发状态、不触发重发、不改这次返回;之后同一动作照外发规则拒发", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await h.plugins.install({ kind: "local-path", path: pkg(path.join(w.dir, "src", "ledger"), "ledger", B2) }, []);
    const r = await h.plugins.send("ledger", "l2", "late:900");
    assert.equal(r.reason, "timeout");
    await lateOf(h, "ledger", "l2", 1);
    await pause(300);
    const v = h.plugins.delivery("ledger", "l2");
    assert.deepEqual(v && [v.state, v.reason, v.receiptId], ["delivery_unknown", "timeout", null], "外发状态没被迟到的回执改成已确认");
    const retry = await h.plugins.send("ledger", "l2", "late:900");
    assert.deepEqual([retry.state, retry.reason], ["delivery-unknown", "retry-refused"]);
    const probe = await h.plugins.send("ledger", "p2", "p");
    assert.deepEqual(seenIn(probe), ["l2", "p2"], "迟到记录与之后的拒发都没有再投递 l2");
    assert.equal(h.plugins.lateReceipts("ledger", "l2").length, 1);
  } finally {
    await end(w);
  }
});

test("L03 宿主重启后才落地的确认记成迟到:原因 host-restarted,外发表仍是结果未知", async () => {
  const w = world();
  try {
    const h1 = boot(Host, w);
    await h1.plugins.install({ kind: "local-path", path: pkg(path.join(w.dir, "src", "ledger"), "ledger", B2) }, []);
    await h1.plugins.send("ledger", "warm", "w");
    const x = later(w, h1.plugins.send("ledger", "x3", "hold"));
    assert.deepEqual(seenIn(await h1.plugins.send("ledger", "p3", "p")), ["warm", "x3", "p3"]);
    const h2 = boot(Host, w);
    await h1.plugins.send("ledger", "release3", "r");
    const lateResult = await x;
    assert.deepEqual([lateResult.state, lateResult.reason], ["delivery-unknown", "host-restarted"]);
    const [rec] = await lateOf(h2, "ledger", "x3", 1);
    assert.deepEqual(rec && [rec.cause, rec.stateAtArrival, rec.reasonAtArrival, rec.actionMatches], ["host-restarted", "delivery_unknown", "host-restarted", true]);
    assert.deepEqual(rec && seenIn(rec), ["warm", "x3", "p3", "release3"]);
    const v = h2.plugins.delivery("ledger", "x3");
    assert.deepEqual(v && [v.state, v.reason, v.receiptId], ["delivery_unknown", "host-restarted", null]);
  } finally {
    await end(w);
  }
});

test("L04 只记迟到的:按时确认、插件报错、按时回了对不上的应答、超出宽限被结束都不记,同一进程里真迟到的那一条记下", async () => {
  const w = world();
  try {
    const h = boot(Host, w);
    await h.plugins.install({ kind: "local-path", path: pkg(path.join(w.dir, "src", "ledger"), "ledger", B2) }, []);
    const ok = await h.plugins.send("ledger", "ok4", "好");
    const boom = await h.plugins.send("ledger", "boom4", "boom");
    const bad = await h.plugins.send("ledger", "bad4", "bad");
    const late = await h.plugins.send("ledger", "late4", "late:900");
    const hang = await h.plugins.send("ledger", "hang4", "hang");
    assert.deepEqual(
      [ok.state, boom.reason, bad.reason, late.reason, hang.reason],
      ["confirmed", "send-threw", "invalid-receipt", "timeout", "timeout"],
    );
    await pause(2200);
    assert.deepEqual(
      ["ok4", "boom4", "bad4", "late4", "hang4"].map((a) => h.plugins.lateReceipts("ledger", a).length),
      [0, 0, 0, 1, 0],
    );
    assert.equal(h.plugins.delivery("ledger", "ok4")?.state, "confirmed");
  } finally {
    await end(w);
  }
});

test("L05 迟到记录一直保留:卸载插件、重启宿主之后还在;同一动作多次迟到各记一条", async () => {
  const w = world();
  try {
    const h1 = boot(Host, w);
    await h1.plugins.install({ kind: "local-path", path: pkg(path.join(w.dir, "src", "b1"), "b1", B1) }, []);
    const a = await h1.plugins.send("b1", "l5", "late:900");
    assert.equal(a.reason, "timeout");
    await lateOf(h1, "b1", "l5", 1);
    const b = await h1.plugins.send("b1", "l5", "late:900");
    assert.equal(b.reason, "timeout", "同一次启动里 B1 照内核保留期再投递一次,又超时");
    const two = await lateOf(h1, "b1", "l5", 2);
    assert.equal(two.length, 2);
    assert.notEqual(two[0]!.attempt, two[1]!.attempt, "两次认领各记一条");
    h1.plugins.uninstall("b1");
    await h1.close();
    const h2 = boot(Host, w);
    const kept = h2.plugins.lateReceipts("b1", "l5");
    assert.deepEqual(kept.map((x) => [x.attempt, x.receiptId]), two.map((x) => [x.attempt, x.receiptId]));
    assert.equal(h2.plugins.delivery("b1", "l5")?.state, "delivery_unknown");
  } finally {
    await end(w);
  }
});
