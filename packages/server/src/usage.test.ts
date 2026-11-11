// 缓存命中可观测(AC-39 ③⑤⑥、D22 第 3 节第 7 条)与生产入口的状态笔记上限(D06 第 2 小节第 3 块)。
// 生产路径用 startServer(mind=pi):把 globalThis.fetch 换成进程内的假网关(不连网、不开端口),pi-ai 照常构造请求体;
// 假网关按请求体认出是联系人一轮、每轮检查还是笔记压缩/缩写,回带 usage 的 SSE。统计口径用合成的用量行喂纯函数核对。
// 令牌与网关地址都是中性假值(NEUTRAL_FIXTURE_NO_CREDENTIALS),只经 env 参数传给 startServer。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactCompactor, ContactMind, ModelUsage } from "@g-group/kernel";
import { type CacheStatsQuery, cacheStats, type UsageRow } from "./cache-stats.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { DEFAULT_STATE_NOTE_MAX_BYTES, startServer } from "./start.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-usage-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const sub = () => path.join(dir, `d${++n}`);

const TOKEN = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const TOKEN_SEGMENT = "NEUTRAL_TOKEN_SEGMENT_9f2c";
const MODEL = "m-cache-1";
const ENV = { ANTHROPIC_BASE_URL: `http://gw.example.invalid:52247/${TOKEN_SEGMENT}`, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL };
const LINE = `anthropic|gw.example.invalid|${MODEL}`;

interface Block { type: string; text?: string }
interface Body { system?: Block[]; tools?: unknown[]; messages: { role: string; content: string | Block[] }[] }
type Kind = "round-1" | "round-2" | "reflect" | "round-note" | "shrink";
const USE: Record<Kind, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {
  "round-1": { input: 1000, cacheRead: 0, cacheWrite: 6000, output: 20 },
  "round-2": { input: 30, cacheRead: 7000, cacheWrite: 900, output: 5 },
  reflect: { input: 1500, cacheRead: 0, cacheWrite: 0, output: 25 },
  "round-note": { input: 400, cacheRead: 0, cacheWrite: 0, output: 12 },
  shrink: { input: 450, cacheRead: 0, cacheWrite: 0, output: 9 },
};
const textOf = (b: Body) => [...(b.system ?? []).map((s) => s.text ?? ""), ...b.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((c) => c.text ?? "")))].join("\n");

/** 假网关:替换 globalThis.fetch;联系人第一次请求调 update_state_note 写 note,第二次回一句话;检查回空 JSON;缩写回固定短笔记 */
function fakeGateway(note: string) {
  const seen: { kind: Kind; url: string; body: Body }[] = [];
  const enc = new TextEncoder();
  const sse = (type: string, data: object) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as Body;
    const all = textOf(body);
    const kind: Kind = body.tools?.length ? (body.messages.length === 1 ? "round-1" : "round-2") : all.includes("只输出一个 JSON 对象") ? "reflect" : all.includes("缩写这份笔记") ? "shrink" : "round-note";
    seen.push({ kind, url: req.url, body });
    const u = USE[kind];
    const text = kind === "round-2" ? "收到" : kind === "reflect" ? '{"note":null,"memories":[],"personaSuggestion":null}' : kind === "shrink" ? "缩写后的笔记" : kind === "round-note" ? "补写的笔记" : "";
    const call = kind === "round-1" ? { name: "update_state_note", input: { note } } : null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse("message_start", { message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u.input, output_tokens: 0, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite } } }));
        if (call) {
          c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${seen.length}`, name: call.name, input: {} } }));
          c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
        } else {
          c.enqueue(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
          c.enqueue(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
        }
        c.enqueue(sse("content_block_stop", { index: 0 }));
        c.enqueue(sse("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: u.output } }));
        c.enqueue(sse("message_stop", {}));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function until(host: Host, cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    if (cond() && !host.loop.busy()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等不到:${what}`);
}

/** startServer(mind=pi) 建一个联系人和群,@ 它发一条,等这一轮连同检查/压缩收尾 */
async function oneRound(opts: { stateNoteMaxBytes?: number | null }, note: string, done: (kinds: Kind[]) => boolean) {
  const gw = fakeGateway(note);
  const s = await startServer({ dataDir: sub(), mind: "pi", env: ENV, ...opts });
  try {
    const c = s.host.createContact({ name: "小后" });
    const g = s.host.createGroup("缓存群", [{ kind: "contact", id: c.id }]);
    s.host.send({ roomId: g.id, clientActionId: "m1", text: "第一轮:回个好", mentions: [{ id: c.id, source: "manual" }] });
    await until(s.host, () => done(gw.seen.map((x) => x.kind)), "这一轮收尾");
    return { s, c, g, gw };
  } catch (e) {
    gw.restore();
    await s.close();
    throw e;
  }
}

test("startServer(mind=pi) 连假网关跑一轮:每次模型请求在 gg_usage 落一行(联系人两次请求加一次检查,同一联系人、同一群、同一轮号),数字取自网关回的 usage,线路不含网关路径里的令牌段", async () => {
  const { s, c, g, gw } = await oneRound({}, "在做:回个好", (k) => k.includes("reflect"));
  try {
    const rows = s.host.usage.rows();
    assert.deepEqual(rows.map((r) => [r.kind, r.request]), [["round", 1], ["round", 2], ["reflect", 1]]);
    for (const r of rows) {
      assert.equal(r.line, LINE);
      assert.equal(r.contactId, c.id);
      assert.deepEqual(r.roomIds, [g.id]);
      assert.equal(r.roundId, rows[0]!.roundId);
    }
    assert.ok(rows[0]!.roundId.startsWith(`${c.id}:`), "轮次号是宿主这一轮的 roundId");
    assert.deepEqual(rows.map((r) => [r.input, r.cacheRead, r.cacheWrite, r.output]), [USE["round-1"], USE["round-2"], USE.reflect].map((u) => [u.input, u.cacheRead, u.cacheWrite, u.output]));
    assert.ok(rows[0]!.breakpoints > 0 && rows[0]!.breakpoints <= 4, "联系人请求带断点且不超过 4 个");
    assert.equal(rows[2]!.breakpoints, 0, "检查不设断点");
    assert.equal(rows[0]!.prefixHash, rows[1]!.prefixHash, "同一轮两次请求固定前缀相同");
    assert.ok(gw.seen.every((x) => x.url.includes(TOKEN_SEGMENT)), "请求照常发到带令牌的网关地址");
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes(TOKEN_SEGMENT) || dump.includes(TOKEN) || dump.includes("52247"), false, "用量表里没有令牌段、令牌与端口");
    const r = await createService(s.host).handle("usage.cacheStats", { by: ["line", "contact", "room"] });
    assert.ok(r.ok, JSON.stringify(r));
    const groups = (r.value as { groups: { line: string; contactId: string; room: string; calls: number; cacheRead: number; hitRate: number; misses: unknown }[] }).groups;
    const total = USE["round-1"].input + USE["round-1"].cacheWrite + USE["round-2"].input + USE["round-2"].cacheRead + USE["round-2"].cacheWrite + USE.reflect.input;
    assert.deepEqual(groups.map((x) => [x.line, x.contactId, x.room, x.calls, x.cacheRead, x.hitRate]), [[LINE, c.id, g.id, 3, 7000, 7000 / total]]);
    assert.deepEqual(groups[0]!.misses, { cold: 1, prefixChanged: 0, expired: 0, uncached: 0 }, "首调未命中记 cold;检查不带断点不归因");
  } finally {
    gw.restore();
    await s.close();
  }
});

test("startServer 传了 stateNoteMaxBytes:模型写的笔记超限,宿主请同一说话模型缩写(假网关收到缩写请求,上限就是传入值),缩写结果落盘,这次缩写也记成 compact 用量", async () => {
  const long = "长".repeat(200);
  const { s, c, gw } = await oneRound({ stateNoteMaxBytes: 300 }, long, (k) => k.includes("shrink"));
  try {
    const shrink = gw.seen.filter((x) => x.kind === "shrink");
    assert.equal(shrink.length, 1);
    assert.match(textOf(shrink[0]!.body), /新笔记不超过 300 字节/);
    assert.ok(textOf(shrink[0]!.body).includes(long), "缩写的是模型写的那份笔记");
    assert.equal(shrink[0]!.body.tools, undefined, "缩写不带工具");
    assert.equal(s.host.stateNote(c.id), "缩写后的笔记");
    const rows = s.host.usage.rows();
    assert.deepEqual(rows.map((r) => r.kind), ["round", "round", "reflect", "compact"]);
    assert.deepEqual([rows[3]!.input, rows[3]!.output, rows[3]!.roundId], [USE.shrink.input, USE.shrink.output, rows[0]!.roundId]);
    const r = await createService(s.host).handle("usage.cacheStats", { by: ["kind"] });
    assert.ok(r.ok, JSON.stringify(r));
    const groups = (r.value as { groups: { kind: string; calls: number; input: number }[] }).groups;
    assert.deepEqual(groups.map((g) => [g.kind, g.calls, g.input]), [["compact", 1, USE.shrink.input], ["reflect", 1, USE.reflect.input], ["round", 2, USE["round-1"].input + USE["round-2"].input]], "接口按种类分得出这次缩写");
  } finally {
    gw.restore();
    await s.close();
  }
});

test("startServer 不传 stateNoteMaxBytes 用默认上限 DEFAULT_STATE_NOTE_MAX_BYTES(超过就缩写);传 null 不设上限、不缩写", async () => {
  const long = "长笔记".repeat(1000);
  assert.ok(Buffer.byteLength(long) > DEFAULT_STATE_NOTE_MAX_BYTES);
  const a = await oneRound({}, long, (k) => k.includes("shrink"));
  try {
    const shrink = a.gw.seen.filter((x) => x.kind === "shrink");
    assert.equal(shrink.length, 1);
    assert.ok(textOf(shrink[0]!.body).includes(`新笔记不超过 ${DEFAULT_STATE_NOTE_MAX_BYTES} 字节`));
    assert.equal(a.s.host.stateNote(a.c.id), "缩写后的笔记");
  } finally {
    a.gw.restore();
    await a.s.close();
  }
  const b = await oneRound({ stateNoteMaxBytes: null }, long, (k) => k.includes("reflect"));
  try {
    assert.deepEqual(b.gw.seen.map((x) => x.kind), ["round-1", "round-2", "reflect"], "不设上限就不缩写");
    assert.equal(b.s.host.stateNote(b.c.id), long);
  } finally {
    b.gw.restore();
    await b.s.close();
  }
});

// ---------- 统计口径:合成的用量行 ----------
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const T0 = Date.parse("2026-11-11T08:00:00.000Z");
let rid = 0;
function row(over: Partial<UsageRow> & { t: number }): UsageRow {
  const { t, ...rest } = over;
  return { id: ++rid, at: new Date(T0 + t).toISOString(), kind: "round", line: "L-a", contactId: "c1", roomIds: ["g1"], roundId: `r${rid}`, request: 1, prefixHash: h("p1"), breakpoints: 3, input: 100, cacheRead: 0, cacheWrite: 0, output: 10, ...rest };
}
const MIN = 60_000;
const pick = (q: CacheStatsQuery, rows: UsageRow[]) => cacheStats(rows, q).groups.map((g) => ({ key: [g.line, g.contactId, g.room, g.kind], calls: g.calls, sums: [g.input, g.cacheRead, g.cacheWrite, g.output], hitRate: g.hitRate, flags: g.flags }));

test("cacheStats 按线路 × 联系人 × 群分组:调用数与四项求和正确,命中率 = cache_read / (input + cache_read + cache_write);只按线路时合并;kinds 只算指定种类;since/until 是半开窗口;多个会话的调用按会话集合分组", () => {
  const rows = [
    row({ t: 0, input: 1000, cacheWrite: 4000 }),
    row({ t: MIN, input: 200, cacheRead: 4000, cacheWrite: 300 }),
    row({ t: 2 * MIN, roomIds: ["g2"], input: 300, cacheRead: 4100, cacheWrite: 100 }),
    row({ t: 3 * MIN, contactId: "c2", input: 500, cacheRead: 3000, cacheWrite: 500 }),
    row({ t: 4 * MIN, kind: "reflect", breakpoints: 0, prefixHash: h("ps"), input: 800 }),
    row({ t: 5 * MIN, line: "L-b", input: 50, cacheRead: 0, cacheWrite: 950 }),
    row({ t: 6 * MIN, roomIds: ["g2", "g1"], input: 100, cacheRead: 4200, cacheWrite: 0 }),
  ];
  assert.deepEqual(pick({ by: ["line", "contact", "room"] }, rows), [
    { key: ["L-a", "c1", "g1", null], calls: 3, sums: [2000, 4000, 4300, 30], hitRate: 4000 / 10300, flags: [] },
    { key: ["L-a", "c1", "g1,g2", null], calls: 1, sums: [100, 4200, 0, 10], hitRate: 4200 / 4300, flags: [] },
    { key: ["L-a", "c1", "g2", null], calls: 1, sums: [300, 4100, 100, 10], hitRate: 4100 / 4500, flags: [] },
    { key: ["L-a", "c2", "g1", null], calls: 1, sums: [500, 3000, 500, 10], hitRate: 3000 / 4000, flags: [] },
    { key: ["L-b", "c1", "g1", null], calls: 1, sums: [50, 0, 950, 10], hitRate: 0, flags: [] },
  ]);
  assert.deepEqual(pick({ by: ["line"] }, rows).map((g) => [g.key[0], g.calls, g.sums]), [["L-a", 6, [2900, 15300, 4900, 60]], ["L-b", 1, [50, 0, 950, 10]]]);
  assert.deepEqual(pick({ by: ["line", "kind"], kinds: ["round"] }, rows).map((g) => [g.key[0], g.key[3], g.calls]), [["L-a", "round", 5], ["L-b", "round", 1]]);
  const win = { since: new Date(T0 + MIN).toISOString(), until: new Date(T0 + 3 * MIN).toISOString() };
  const w = cacheStats(rows, { by: ["line"], ...win });
  assert.deepEqual([w.since, w.until, w.groups.map((g) => [g.line, g.calls, g.cacheRead])], [win.since, win.until, [["L-a", 2, 8100]]], "窗口含 since、不含 until");
});

test("喂入 kiro 式 4:1 拆账数据:该线路标 split-accounting(constant-ratio),它的调用不计入命中率——跨线路的组只用正常线路算,拆账线自己的组命中率为空;正常线路(命中恒定、input 变化)不误标", () => {
  const kiro = [10_000, 15_000, 22_000, 30_000, 41_000].map((input, i) => row({ t: i * MIN, line: "L-kiro", input, cacheRead: 4 * input + (i % 2) }));
  const fine = [row({ t: 0, line: "L-ok", input: 3000, cacheWrite: 6000 }), ...[900, 1400, 2600].map((input, i) => row({ t: (i + 1) * MIN, line: "L-ok", input, cacheRead: 6000 }))];
  const all = [...kiro, ...fine];
  const r = cacheStats(all, { by: ["line"] });
  assert.deepEqual(r.lines.map((v) => [v.line, v.splitAccounting, v.firstSegmentOnly]), [["L-kiro", "constant-ratio", false], ["L-ok", null, false]]);
  const okRate = 18_000 / (3000 + 6000 + 900 + 1400 + 2600 + 18_000);
  assert.deepEqual(r.groups.map((g) => [g.line, g.calls, g.countedCalls, g.hitRate, g.flags]), [["L-kiro", 5, 0, null, ["split-accounting"]], ["L-ok", 4, 4, okRate, []]]);
  const byContact = cacheStats(all, { by: ["contact"] }).groups;
  assert.deepEqual(byContact.map((g) => [g.contactId, g.calls, g.countedCalls, g.hitRate, g.flags]), [["c1", 9, 4, okRate, ["split-accounting"]]], "拆账线的调用照数,但不进命中率");
});

test("不声明缓存的请求(没有 cache_control)也报命中的线路标 split-accounting(hit-without-breakpoint);正常线路上这类请求命中为 0,首调就有命中(缓存被别的实例焐热)也不误标;只看窗口内的行", () => {
  const rows = [
    row({ t: 0, line: "L-split", input: 1000, cacheRead: 3000 }),
    row({ t: MIN, line: "L-split", input: 300, cacheRead: 4100 }),
    row({ t: 2 * MIN, line: "L-split", kind: "reflect", breakpoints: 0, prefixHash: h("ps"), input: 400, cacheRead: 1600 }),
    row({ t: 0, line: "L-warm", input: 4, cacheRead: 4046, cacheWrite: 1771 }),
    row({ t: MIN, line: "L-warm", input: 4, cacheRead: 5584, cacheWrite: 317 }),
    row({ t: 2 * MIN, line: "L-warm", kind: "reflect", breakpoints: 0, prefixHash: h("ps"), input: 1516 }),
    row({ t: 0, line: "L-old", kind: "compact", breakpoints: 0, prefixHash: h("pc"), input: 500, cacheRead: 200 }),
    row({ t: 10 * MIN, line: "L-old", input: 600, cacheRead: 3000, cacheWrite: 200 }),
  ];
  const all = cacheStats(rows, { by: ["line"] });
  assert.deepEqual(all.lines.map((v) => [v.line, v.splitAccounting]), [["L-old", "hit-without-breakpoint"], ["L-split", "hit-without-breakpoint"], ["L-warm", null]]);
  assert.deepEqual(all.groups.map((g) => [g.line, g.hitRate, g.flags]), [
    ["L-old", null, ["split-accounting"]],
    ["L-split", null, ["split-accounting"]],
    ["L-warm", (4046 + 5584) / (4 + 4046 + 1771 + 4 + 5584 + 317 + 1516), []],
  ]);
  const later = cacheStats(rows, { by: ["line"], since: new Date(T0 + 5 * MIN).toISOString() });
  assert.deepEqual(later.lines.map((v) => [v.line, v.splitAccounting]), [["L-old", null]], "窗口里只剩 L-old 带断点的那次");
});

/** 一条线路上先有一次冷启动(写入固定前缀),再若干轮,每轮两次请求(工具往返):第二次的命中数由 second(第一次命中数, 第几轮) 决定 */
function rounds(line: string, inputs: number[], first: number, second: (hit: number, i: number) => number): UsageRow[] {
  return [row({ t: -10 * MIN, line, roundId: `${line}-r-cold`, input: 1000, cacheWrite: first }), ...inputs.flatMap((input, i) => [
    row({ t: i * 10 * MIN, line, roundId: `${line}-r${i}`, request: 1, input, cacheRead: first }),
    row({ t: i * 10 * MIN + 5000, line, roundId: `${line}-r${i}`, request: 2, input: 50, cacheRead: second(first, i) }),
  ])];
}

test("喂入只缓存首段的数据(命中恒为固定值、轮内后续请求不增长):给了阈值时命中率低于阈值标 low-hit-rate 并标 first-segment-only;正常线路不标;阈值不给不标,按线路单独设、minCalls 都按参数生效", () => {
  const firstOnly = rounds("L-first", [2000, 6000, 12000, 20000], 4000, (hit) => hit);
  const healthy = rounds("L-good", [1000, 1200, 1500, 1100], 4000, (hit, i) => hit + 1000 + i * 100);
  const rows = [...firstOnly, ...healthy];
  const rate = (rs: UsageRow[]) => rs.reduce((s, r) => s + r.cacheRead, 0) / rs.reduce((s, r) => s + r.input + r.cacheRead + r.cacheWrite, 0);
  const lowRate = rate(firstOnly);
  const goodRate = rate(healthy);
  assert.ok(lowRate < 0.5 && goodRate > 0.7, `${lowRate} / ${goodRate}`);
  const flags = (q: Omit<CacheStatsQuery, "by">) => cacheStats(rows, { by: ["line"], ...q }).groups.map((g) => [g.line, g.hitRate, g.alertBelow, g.flags]);
  assert.deepEqual(flags({ alertBelow: 0.5 }), [["L-first", lowRate, 0.5, ["first-segment-only", "low-hit-rate"]], ["L-good", goodRate, 0.5, []]]);
  assert.deepEqual(flags({}), [["L-first", lowRate, null, ["first-segment-only"]], ["L-good", goodRate, null, []]], "阈值待定:不给就不标");
  assert.deepEqual(flags({ alertBelow: 0.5, alertBelowByLine: [{ line: "L-first", below: 0.1 }, { line: "L-good", below: 0.95 }] }), [["L-first", lowRate, 0.1, ["first-segment-only"]], ["L-good", goodRate, 0.95, ["low-hit-rate"]]]);
  assert.deepEqual(flags({ alertBelow: 0.5, minCalls: 10 }), [["L-first", lowRate, 0.5, ["first-segment-only"]], ["L-good", goodRate, 0.5, []]], "计入的调用不够 minCalls 不标");
  assert.equal(cacheStats(rows, { by: ["line"] }).lines.find((v) => v.line === "L-good")?.firstSegmentOnly, false);
});

test("未命中归因:同前缀间隔超过 TTL 的未命中记过期(不算前缀变化);TTL 内同前缀仍未命中记 uncached;前缀变了记 prefix-changed;首调记 cold;不带断点的请求不归因;TTL 按参数", () => {
  const rows = [
    row({ t: 0 }),
    row({ t: MIN, cacheRead: 5000 }),
    row({ t: 2 * MIN }),
    row({ t: 12 * MIN }),
    row({ t: 13 * MIN, prefixHash: h("p2-规矩改了") }),
    row({ t: 14 * MIN, kind: "reflect", breakpoints: 0, prefixHash: h("ps") }),
    row({ t: 15 * MIN, contactId: "c2", prefixHash: h("p3") }),
  ];
  const misses = (ttlMs?: number) => cacheStats(rows, { by: ["line"], ...(ttlMs ? { ttlMs } : {}) }).groups[0]!.misses;
  const base = cacheStats(rows, { by: ["line"] });
  assert.deepEqual(base.lines.map((v) => [v.line, v.splitAccounting, v.firstSegmentOnly]), [["L-a", null, false]], "这是一条正常线路,未命中照常计入");
  assert.equal(base.groups[0]!.hitRate, 5000 / (7 * 100 + 5000));
  assert.deepEqual(misses(), { cold: 2, prefixChanged: 1, expired: 1, uncached: 1 });
  assert.deepEqual(misses(60 * MIN), { cold: 2, prefixChanged: 1, expired: 0, uncached: 2 }, "1 小时 TTL 下 10 分钟的间隔不算过期");
  assert.equal(cacheStats(rows, { by: ["line"] }).ttlMs, 5 * MIN);
  const byContact = cacheStats(rows, { by: ["contact"] }).groups.map((g) => [g.contactId, g.misses]);
  assert.deepEqual(byContact, [["c1", { cold: 1, prefixChanged: 1, expired: 1, uncached: 1 }], ["c2", { cold: 1, prefixChanged: 0, expired: 0, uncached: 0 }]]);
});

test("宿主把回执口交给脑子与压缩器:每次回报立刻落一行(种类、联系人、会话、轮次号由宿主补),这一轮失败前已发出的请求也记;形状不合格的回执拒收并报告;usage.cacheStats 按合同校验参数与结果", async () => {
  const U = (request: number, over: Partial<ModelUsage> = {}): ModelUsage => ({ line: "fake|gw.example.invalid|m-x", request, prefixHash: h("p"), breakpoints: 3, input: 100 * request, cacheRead: 0, cacheWrite: 0, output: 5, ...over });
  const reports: [string, unknown][] = [];
  let fail = false;
  const mind: ContactMind = {
    async round(_i, _signal, _tools, usage) {
      usage?.(U(1));
      usage?.(U(2, { prefixHash: "不是哈希" }));
      usage?.(U(2, { cacheRead: 300 }));
      if (fail) throw new Error("上游 500");
      return { actions: [], stateNote: null };
    },
  };
  const compactor: ContactCompactor = {
    async compact(_r, _signal, usage) {
      usage?.(U(1, { breakpoints: 0, input: 900, prefixHash: h("c") }));
      return "补写的笔记";
    },
  };
  const at = "2026-11-11T09:00:00.000Z";
  const host = new Host({ file: path.join(dir, `host-${++n}.db`), maxDeferMs: 5, now: () => at, mind: () => mind, compactor: () => compactor, retry: { maxAutoRetries: 0, unknownMaxRetries: 0 }, onReport: (w, d) => reports.push([w, d]) });
  try {
    const c = host.createContact({ name: "小克", speakingModel: "m-x" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "1", text: "一" });
    await until(host, () => host.usage.rows().length >= 3, "第一轮落表");
    const rows = host.usage.rows();
    assert.deepEqual(rows.map((r) => [r.kind, r.request, r.input, r.cacheRead, r.contactId, r.roomIds, r.at]), [
      ["round", 1, 100, 0, c.id, [dm.id], at],
      ["round", 2, 200, 300, c.id, [dm.id], at],
      ["compact", 1, 900, 0, c.id, [dm.id], at],
    ]);
    assert.equal(new Set(rows.map((r) => r.roundId)).size, 1, "同一轮");
    assert.ok(reports.some(([w, d]) => w === "usage-rejected" && /prefixHash/.test(JSON.stringify(d))), "形状不合格的回执拒收并报告");
    fail = true;
    host.send({ roomId: dm.id, clientActionId: "2", text: "二" });
    await until(host, () => host.usage.rows().length >= 5, "失败的一轮也落表");
    const later = host.usage.rows().slice(3);
    assert.deepEqual(later.map((r) => [r.kind, r.request]), [["round", 1], ["round", 2]]);
    assert.notEqual(later[0]!.roundId, rows[0]!.roundId);
    const svc = createService(host);
    const ok = await svc.handle("usage.cacheStats", { by: ["line", "kind"] });
    assert.ok(ok.ok, JSON.stringify(ok));
    const v = ok.value as { groups: { kind: string; calls: number; hitRate: number }[]; lines: unknown[] };
    assert.deepEqual(v.groups.map((g) => [g.kind, g.calls, g.hitRate]), [["compact", 1, 0], ["round", 4, 600 / 1200]]);
    const empty = await svc.handle("usage.cacheStats", { by: ["line"], until: "2026-11-11T08:00:00.000Z" });
    assert.ok(empty.ok && (empty.value as { groups: unknown[] }).groups.length === 0, "窗口之外没有行");
    for (const [p, why] of [[{}, "by 必填"], [{ by: ["vendor"] }, "维度只认四种"], [{ by: ["line"], alertBelow: 1.5 }, "阈值越界"], [{ by: ["line"], since: "2026-11-11T10:00:00.000Z", until: "2026-11-11T09:00:00.000Z" }, "since 晚于 until"]] as const) {
      const bad = await svc.handle("usage.cacheStats", p);
      assert.equal(bad.ok ? "ok" : bad.error.code, "invalid_params", why);
    }
  } finally {
    await host.close();
  }
});
