// AC-06 引用旧消息确定性 Page-in:被引用 #seq 原文精确进装配;超预算显式失败,禁止静默截断;已在历史里的引用不重复页入。
// AC-39 / D22 群聊缓存前缀纪律:stable 段不含会变内容;历史只追加不重截;Page-in 与会变状态只在 tail;断点 ≤ 4。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log } from "@g-group/domain";
import { assemble, type AssembleOptions, type AssembleResult, MAX_BREAKPOINTS, prefixHash, prefixLength, serialize } from "./assemble.ts";

const user = { kind: "user", id: "u1" } as const;
const contact = { kind: "contact", id: "c-astra" } as const;
const at = "2026-11-05T13:40:00Z";
const OLD = "压测报告结论:p99 在 820ms,瓶颈在登录接口的 bcrypt 轮数";
const STABLE = [
  { kind: "system", text: "你是群聊里的联系人,只在被叫到或有把握时发言。" },
  { kind: "tools", text: "read_log(compute_id, offset, limit)\nrecall_by_chain(seq)" },
  { kind: "persona", text: "小审:负责代码审查,说话简短。群规:先给结论再给证据。" },
] as const;
const BIG = 1_000_000;

/** 10 条消息:#1 是早已压缩掉的旧结论,#2..#10 是日常闲聊 */
function history(n = 10): Log {
  let log = append(emptyLog(), contact, { kind: "message", text: OLD }, at);
  for (let i = 2; i <= n; i++) log = append(log, i % 2 ? contact : user, { kind: "message", text: `闲聊第${i}句` }, at);
  return log;
}
const opts = (over: Partial<AssembleOptions> = {}): AssembleOptions => ({
  stable: STABLE, compressed: { throughSeq: 7, builtAtSeq: 7, text: "前 7 条摘要:讨论了压测和登录页" }, quotes: [], budgetBytes: BIG, ...over,
});
function ok(r: AssembleResult) {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("装配失败");
  return r;
}

test("请求按 stable → history → tail 分段,压缩点之后的可见消息全量进 history", () => {
  const r = ok(assemble(history(), opts({ volatile: "当前时间 2026-11-05 13:40" })));
  const secs = r.request.segments.map((s) => s.section);
  assert.deepEqual([...new Set(secs)], ["stable", "history", "tail"]);
  assert.deepEqual(r.request.segments.filter((s) => s.section === "stable").map((s) => s.label), ["system", "tools", "persona"]);
  assert.deepEqual(r.request.segments.filter((s) => s.label === "message").map((s) => s.seq), [8, 9, 10]);
  assert.ok(r.request.segments.find((s) => s.label === "volatile")?.section === "tail");
});

test("被引用的已压缩旧消息按原文精确页入 tail,清单记 seq 与字节数", () => {
  const r = ok(assemble(history(), opts({ quotes: [1] })));
  const paged = r.request.segments.find((s) => s.seq === 1);
  assert.equal(paged?.section, "tail");
  assert.ok(paged?.text.includes(OLD), "#1 原文必须逐字出现");
  assert.deepEqual(r.manifest.find((m) => m.seq === 1), { seq: 1, bytes: paged?.bytes, via: "page-in" });
  assert.ok((paged?.bytes ?? 0) >= Buffer.byteLength(OLD, "utf8"));
});

test("同一历史只切引用开关:不引用 1 号旧消息时它不进装配(阴性对照)", () => {
  const r = ok(assemble(history(), opts({ quotes: [] })));
  assert.equal(serialize(r.request).includes(OLD), false);
  assert.deepEqual(r.manifest.map((m) => m.seq), [8, 9, 10]);
});

test("清单字节数与各段字节数之和等于请求体实际 UTF-8 字节数", () => {
  const r = ok(assemble(history(), opts({ quotes: [1, 2], volatile: "任务表:无" })));
  const body = serialize(r.request);
  assert.equal(r.totalBytes, Buffer.byteLength(body, "utf8"));
  assert.equal(r.request.segments.reduce((a, s) => a + s.bytes, 0), r.totalBytes);
  for (const m of r.manifest) assert.equal(m.bytes, r.request.segments.find((s) => s.seq === m.seq)?.bytes);
});

test("超预算一个字节就显式失败并要求压缩,而不是静默截断(阳性埋雷)", () => {
  const full = ok(assemble(history(), opts({ quotes: [1] })));
  const r = assemble(history(), opts({ quotes: [1], budgetBytes: full.totalBytes - 1 }));
  assert.deepEqual(r, { ok: false, reason: "over-budget", need: full.totalBytes, budget: full.totalBytes - 1, action: "compress" });
});

test("预算恰好等于所需字节时装配成功(阴性对照)", () => {
  const full = ok(assemble(history(), opts({ quotes: [1] })));
  const r = ok(assemble(history(), opts({ quotes: [1], budgetBytes: full.totalBytes })));
  assert.equal(serialize(r.request), serialize(full.request));
});

test("引用已在 history 里的消息不触发页入,原文只出现一次", () => {
  const r = ok(assemble(history(), opts({ quotes: [9] })));
  assert.equal(r.request.segments.some((s) => s.section === "tail"), false);
  assert.equal(serialize(r.request).split("闲聊第9句").length - 1, 1);
});

test("撤回的消息既不进 history 也不能被引用页入,清单把它列为跳过", () => {
  let log = history();
  log = append(log, user, { kind: "retract", target: 10 }, at);
  log = append(log, contact, { kind: "retract", target: 1 }, at);
  const r = ok(assemble(log, opts({ quotes: [1], compressed: { throughSeq: 7, builtAtSeq: 12, text: "前 7 条摘要:讨论了压测和登录页" } })));
  const body = serialize(r.request);
  assert.equal(body.includes(OLD), false);
  assert.equal(body.includes("闲聊第10句"), false);
  assert.deepEqual(r.manifest.map((m) => m.seq), [8, 9]);
  assert.deepEqual(r.skipped, [{ seq: 1, reason: "retracted" }]);
});

test("编辑过的消息按最新文字装配", () => {
  let log = history();
  log = append(log, contact, { kind: "edit", target: 1, text: "压测报告结论(订正):p99 在 640ms" }, at);
  const r = ok(assemble(log, opts({ quotes: [1] })));
  assert.ok(serialize(r.request).includes("p99 在 640ms"));
  assert.equal(serialize(r.request).includes(OLD), false);
});

test("引用不存在的消息序号显式失败", () => {
  const r = assemble(history(), opts({ quotes: [99] }));
  assert.deepEqual(r, { ok: false, reason: "quote-not-found", seq: 99 });
});
test("把最近 25 条、时间、消息序号、任务号或新消息原文注入 stable 段都报错(AC-39 阳性埋雷)", () => {
  const injected: [string, string][] = [
    ["system", "以下是最近 25 条消息:……"],
    ["system", "当前时间 2026-11-05"],
    ["persona", "现在是 13:40,注意时效"],
    ["persona", "上一条是 #9,记得回"],
    ["tools", "当前任务 T-12 进行中"],
    ["persona", "用户刚说:闲聊第10句"],
  ];
  for (const [kind, text] of injected) {
    const stable = STABLE.map((p) => (p.kind === kind ? { kind: p.kind, text: `${p.text}\n${text}` } : p));
    const r = assemble(history(), opts({ stable }));
    assert.equal(r.ok === false && r.reason, "volatile-in-stable", text);
    if (!r.ok && r.reason === "volatile-in-stable") assert.equal(r.part, kind);
  }
});

test("同样的时间与任务表放进 tail 的会变状态里照常装配(单开关对照)", () => {
  const r = ok(assemble(history(), opts({ volatile: "当前时间 2026-11-05 13:40;最近 25 条摘要;任务 T-12" })));
  assert.equal(r.request.segments.at(-1)?.section, "tail");
});

test("正常追加一条消息后,新请求从开头到上次 history 末尾逐字节相同(AC-39 阴性对照)", () => {
  const before = ok(assemble(history(10), opts()));
  const after = ok(assemble(history(11), opts()));
  const n = prefixLength(before.request);
  assert.equal(prefixHash(after.request, n), prefixHash(before.request));
  assert.equal(Buffer.from(serialize(after.request)).subarray(0, n).equals(Buffer.from(serialize(before.request)).subarray(0, n)), true);
  assert.ok(prefixLength(after.request) > n, "新消息追加在 history 末尾");
});

test("连续多轮追加不滑动窗口:压缩点之后的消息一条不少,旧前缀每轮都保留", () => {
  let prev = ok(assemble(history(10), opts()));
  for (let n = 11; n <= 40; n++) {
    const cur = ok(assemble(history(n), opts()));
    assert.equal(prefixHash(cur.request, prefixLength(prev.request)), prefixHash(prev.request), `第 ${n} 条`);
    assert.deepEqual(cur.request.segments.filter((s) => s.label === "message").map((s) => s.seq), Array.from({ length: n - 7 }, (_, i) => i + 8));
    prev = cur;
  }
});

test("旧历史被重截时前缀哈希不一致,宿主据此能发现(AC-39 阳性埋雷)", () => {
  const before = ok(assemble(history(10), opts()));
  const retruncated = ok(assemble(history(11), opts({ compressed: { throughSeq: 8, builtAtSeq: 8, text: "前 7 条摘要:讨论了压测和登录页" } })));
  assert.notEqual(prefixHash(retruncated.request, prefixLength(before.request)), prefixHash(before.request));
});

test("引用页入与会变状态都不改变缓存前缀", () => {
  const plain = ok(assemble(history(), opts()));
  const withTail = ok(assemble(history(), opts({ quotes: [1, 3], volatile: "当前时间 2026-11-05 13:40" })));
  assert.equal(prefixLength(withTail.request), prefixLength(plain.request));
  assert.equal(prefixHash(withTail.request), prefixHash(plain.request));
  const firstTail = withTail.request.segments.findIndex((s) => s.section === "tail");
  assert.ok(withTail.request.segments.slice(firstTail).every((s) => s.section === "tail"), "tail 之后不再有前缀段");
});

test("缓存断点不超过 4 个,位于工具定义末尾、stable 末尾、已压缩块末尾与最新追加消息,tail 里没有", () => {
  const r = ok(assemble(history(), opts({ quotes: [1], volatile: "任务表:无" })));
  const marks = r.request.segments.filter((s) => s.cacheBreakpoint);
  assert.ok(marks.length <= MAX_BREAKPOINTS);
  assert.deepEqual(marks.map((s) => [s.section, s.label, s.seq]), [
    ["stable", "tools", undefined], ["stable", "persona", undefined], ["history", "compressed", undefined], ["history", "message", 10],
  ]);
  const next = ok(assemble(history(11), opts()));
  assert.equal(next.request.segments.filter((s) => s.cacheBreakpoint).at(-1)?.seq, 11, "最后一个断点随最新追加消息移动");
  const noCompressed = ok(assemble(history(), { stable: STABLE, quotes: [], budgetBytes: BIG }));
  assert.equal(noCompressed.request.segments.filter((s) => s.cacheBreakpoint).length, 3);
});

// —— 第四轮:R3-01..R3-06
const FOOD = "用户原来决定吃面";
function foodLog(): Log {
  let log = append(emptyLog(), user, { kind: "message", text: FOOD }, at);
  log = append(log, user, { kind: "message", text: "普通记录" }, at);
  return log;
}
const SUMMARY = { throughSeq: 2, builtAtSeq: 2, text: `${FOOD};普通记录` };

test("撤回的原文在压缩块里:压缩块生成于撤回前即作废,不给 recompress 时显式要求重建(R3-01 阳性埋雷)", () => {
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  const r = assemble(log, opts({ compressed: SUMMARY, quotes: [1] }));
  assert.deepEqual(r, { ok: false, reason: "recompress-required", fromSeq: 1 });
});

test("撤回的原文在压缩块里:给 recompress 就只用仍可见的消息重建,请求里不再有原文,并标 prefixBreak", () => {
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  let seen: number[] = [];
  const r = ok(assemble(log, opts({
    compressed: SUMMARY, quotes: [1],
    recompress: (through, visible) => { seen = visible.map((m) => m.seq); return `至 #${through}:${visible.map((m) => m.text).join(";")}`; },
  })));
  assert.deepEqual(seen, [2]);
  assert.equal(serialize(r.request).includes(FOOD), false);
  assert.deepEqual(r.prefixBreaks, [{ reason: "retract", seq: 1, at: "compressed" }]);
  assert.deepEqual(r.compressed, { throughSeq: 2, builtAtSeq: 3, text: "至 #2:普通记录" });
  assert.deepEqual(r.skipped, [{ seq: 1, reason: "retracted" }]);
});

test("压缩块生成于撤回之后(已不含原文)照常复用,不报 prefixBreak(单开关对照)", () => {
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  const r = ok(assemble(log, opts({ compressed: { throughSeq: 2, builtAtSeq: 3, text: "普通记录" }, previousHeadSeq: 3 })));
  assert.deepEqual(r.prefixBreaks, []);
  assert.equal(serialize(r.request).includes(FOOD), false);
});

test("重建后的压缩块或调用方给的块仍含撤回原文,显式失败而不是送进模型", () => {
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  const a = assemble(log, opts({ compressed: SUMMARY, recompress: () => `还是${FOOD}` }));
  assert.deepEqual(a, { ok: false, reason: "retracted-text-leaked", where: "compressed", seq: 1 });
  const b = assemble(log, opts({ compressed: { throughSeq: 2, builtAtSeq: 3, text: FOOD } }));
  assert.deepEqual(b, { ok: false, reason: "retracted-text-leaked", where: "compressed", seq: 1 });
});

test("撤回的原文在 history 里:下一次装配不再含原文,从该位置起标 prefixBreak,宿主不计为前缀错误", () => {
  const before = ok(assemble(foodLog(), opts({ compressed: undefined as never })));
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  const after = ok(assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG, previousHeadSeq: before.headSeq }));
  assert.equal(serialize(after.request).includes(FOOD), false);
  assert.deepEqual(after.prefixBreaks, [{ reason: "retract", seq: 1, at: "history" }]);
  const again = ok(assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG, previousHeadSeq: after.headSeq }));
  assert.deepEqual(again.prefixBreaks, [], "同一撤回只报一次");
});

test("撤回的原文进 tail:引用页入跳过它,会变状态里带了原文就显式失败", () => {
  const log = append(foodLog(), user, { kind: "retract", target: 1 }, at);
  const quoted = ok(assemble(log, { stable: STABLE, quotes: [1], budgetBytes: BIG }));
  assert.equal(serialize(quoted.request).includes(FOOD), false);
  assert.equal(quoted.request.segments.some((s) => s.section === "tail"), false);
  const v = assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG, volatile: `摘要:${FOOD}` });
  assert.deepEqual(v, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 });
});

test("撤回连带它之后的编辑文字也不再出现", () => {
  let log = append(foodLog(), user, { kind: "edit", target: 1, text: "用户改为决定吃米饭" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  const r = ok(assemble(log, { stable: STABLE, quotes: [1], budgetBytes: BIG }));
  const body = serialize(r.request);
  assert.equal(body.includes(FOOD), false);
  assert.equal(body.includes("吃米饭"), false);
});

test("未压缩时编辑作为新事件追加在 history 末尾,旧消息原文不改,前缀逐字节不变(R3-02 阳性埋雷)", () => {
  const before = ok(assemble(foodLog(), { stable: STABLE, quotes: [], budgetBytes: BIG }));
  const edited = append(foodLog(), user, { kind: "edit", target: 1, text: "用户改为决定吃米饭" }, at);
  const after = ok(assemble(edited, { stable: STABLE, quotes: [], budgetBytes: BIG }));
  assert.equal(prefixHash(after.request, prefixLength(before.request)), prefixHash(before.request));
  const last = after.request.segments.filter((s) => s.section === "history").at(-1);
  assert.deepEqual([last?.label, last?.seq, last?.text], ["edit", 3, "#3 user:u1 编辑 #1 为: 用户改为决定吃米饭\n"]);
  assert.deepEqual(after.prefixBreaks, []);
});

test("压缩点之后编辑压缩块里的旧消息:编辑事件照样进 history,不被旧消息 seq 过滤掉(R3-02 阳性埋雷)", () => {
  const before = ok(assemble(foodLog(), opts({ compressed: SUMMARY })));
  const edited = append(foodLog(), user, { kind: "edit", target: 1, text: "用户改为决定吃米饭" }, at);
  const after = ok(assemble(edited, opts({ compressed: SUMMARY })));
  assert.ok(serialize(after.request).includes("编辑 #1 为: 用户改为决定吃米饭"));
  assert.notEqual(serialize(after.request), serialize(before.request));
  assert.equal(prefixHash(after.request, prefixLength(before.request)), prefixHash(before.request));
});

test("连续多轮编辑与新消息交替,每轮前缀都保留上一轮,最新编辑在末尾", () => {
  let log = foodLog();
  let prev = ok(assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG }));
  for (let i = 0; i < 6; i++) {
    log = i % 2 ? append(log, contact, { kind: "message", text: `回应${i}` }, at) : append(log, user, { kind: "edit", target: 1, text: `第${i}次改主意` }, at);
    const cur = ok(assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG }));
    assert.equal(prefixHash(cur.request, prefixLength(prev.request)), prefixHash(prev.request), `第 ${i} 轮`);
    prev = cur;
  }
  assert.ok(serialize(prev.request).includes("编辑 #1 为: 第4次改主意"));
});

test("用户自然复述固定提示词里的话不再误拦(R3-04 阴性对照)", () => {
  const stable = [{ kind: "system", text: "你是群聊助手,请帮助用户解决问题。" }] as const;
  const log = append(emptyLog(), user, { kind: "message", text: "帮助用户" }, at);
  const r = ok(assemble(log, { stable, quotes: [], budgetBytes: BIG }));
  assert.ok(serialize(r.request).includes("#1 user:u1: 帮助用户"));
});

test("stable 段自身写了新消息字样仍拦下,不管会话里有没有消息(单开关对照)", () => {
  const stable = [{ kind: "system", text: "你是群聊助手。用户刚说:帮助用户" }] as const;
  const r = assemble(emptyLog(), { stable, quotes: [], budgetBytes: BIG });
  assert.equal(r.ok === false && r.reason, "volatile-in-stable");
});

test("固定段顺序必须是 system → tools → persona,倒序、重复、未知段、缺 system 都拒(R3-05 阳性埋雷)", () => {
  const [sys, tools, persona] = STABLE;
  const bad = [[persona, sys, tools], [sys, persona, tools], [sys, sys], [tools, persona], [], [sys, { kind: "rules", text: "x" }]];
  for (const stable of bad) {
    const r = assemble(history(), { stable: stable as never, quotes: [], budgetBytes: BIG });
    assert.equal(r.ok === false && r.reason, "invalid-stable", JSON.stringify(stable.map((p) => p.kind)));
  }
  for (const stable of [[sys], [sys, tools], [sys, persona], [sys, tools, persona]]) {
    const r = assemble(history(), { stable, quotes: [], budgetBytes: BIG });
    assert.equal(r.ok, true, JSON.stringify(stable.map((p) => p.kind)));
  }
});

test("压缩点必须是不超过日志最新 seq 的非负整数,生成点在压缩点与最新之间,否则拒绝(R3-05 阳性埋雷)", () => {
  const head = history().events.at(-1)?.seq ?? 0;
  const bad = [
    { throughSeq: head + 1, builtAtSeq: head + 1 }, { throughSeq: 999, builtAtSeq: 999 }, { throughSeq: -1, builtAtSeq: 0 },
    { throughSeq: 2.5, builtAtSeq: 3 }, { throughSeq: 3, builtAtSeq: 2 }, { throughSeq: 3, builtAtSeq: head + 1 },
  ];
  for (const c of bad) {
    const r = assemble(history(), opts({ compressed: { ...c, text: "摘要" } }));
    assert.equal(r.ok === false && r.reason, "invalid-compressed", JSON.stringify(c));
  }
  for (const c of [{ throughSeq: 0, builtAtSeq: 0 }, { throughSeq: head, builtAtSeq: head }]) {
    const r = assemble(history(), opts({ compressed: { ...c, text: "摘要" } }));
    assert.equal(r.ok, true, JSON.stringify(c));
  }
});

test("user、contact、helper 的消息原文逐字进 history,清单逐条对应(R3-06)", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "用户提问" }, at);
  log = append(log, contact, { kind: "message", text: "联系人回答" }, at);
  log = append(log, { kind: "helper", id: "h1" }, { kind: "message", text: "重要工具结果" }, at);
  const r = ok(assemble(log, { stable: STABLE, quotes: [], budgetBytes: BIG }));
  assert.deepEqual(r.request.segments.filter((s) => s.section === "history").map((s) => s.text), [
    "#1 user:u1: 用户提问\n", "#2 contact:c-astra: 联系人回答\n", "#3 helper:h1: 重要工具结果\n",
  ]);
  assert.deepEqual(r.manifest, [
    { seq: 1, bytes: Buffer.byteLength("#1 user:u1: 用户提问\n"), via: "history" },
    { seq: 2, bytes: Buffer.byteLength("#2 contact:c-astra: 联系人回答\n"), via: "history" },
    { seq: 3, bytes: Buffer.byteLength("#3 helper:h1: 重要工具结果\n"), via: "history" },
  ]);
});

test("会变状态原文逐字出现在 tail 末段;空字符串不产生段(R3-06)", () => {
  const r = ok(assemble(history(), opts({ volatile: "必须停止发送\n任务表:无" })));
  assert.deepEqual(r.request.segments.at(-1), { section: "tail", label: "volatile", text: "[当前状态]\n必须停止发送\n任务表:无\n", bytes: Buffer.byteLength("[当前状态]\n必须停止发送\n任务表:无\n"), cacheBreakpoint: false });
  const empty = ok(assemble(history(), opts({ volatile: "" })));
  assert.equal(empty.request.segments.some((s) => s.label === "volatile"), false);
});
