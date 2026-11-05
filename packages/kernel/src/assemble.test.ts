// AC-06 引用旧消息确定性 Page-in:被引用 #seq 原文精确进装配;超预算显式失败,禁止静默截断;已在历史里的引用不重复页入。
// AC-39 / D22 群聊缓存前缀纪律:stable 段不含会变内容;历史只追加不重截;Page-in 与会变状态只在 tail;断点 ≤ 4。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log } from "@g-group/domain";
import { assemble, INVISIBLE, type AssembleOptions, type AssembleResult, MAX_BREAKPOINTS, prefixHash, prefixLength, serialize, squash } from "./assemble.ts";

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
test("把最近 25 条、时间、消息序号、任务号注入 stable 段都报错(AC-39 阳性埋雷)", () => {
  const injected: [string, string][] = [
    ["system", "以下是最近 25 条消息:……"],
    ["system", "当前时间 2026-11-05"],
    ["persona", "现在是 13:40,注意时效"],
    ["persona", "上一条是 #9,记得回"],
    ["tools", "当前任务 T-12 进行中"],
    ["system", "现在是2026年11月5日"],
    ["persona", "以下最近 3 条:……"],
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

test("不含动态值的通用规则不误拦:新消息、刚才、最近、任务这类普通词都放行(R4-06 阴性对照)", () => {
  for (const text of ["收到新消息后,先遵守群规。", "用户刚说的话要先确认再执行。", "只看最近的上下文,不要翻旧账。", "接到任务先复述目标。", "回复保持 3 句以内。"]) {
    const r = assemble(emptyLog(), { stable: [{ kind: "system", text }], quotes: [], budgetBytes: BIG });
    assert.equal(r.ok, true, text);
  }
});

test("同一条规则只多一个动态值就拦下:日期、时刻、消息序号、任务号、带数字的最近 N 条(R4-06 单开关对照)", () => {
  const cases: [string, RegExp][] = [
    ["收到新消息后,先遵守群规。今天是 2026-11-05", /日期/],
    ["收到新消息后,先遵守群规。现在 09:30", /时刻/],
    ["收到新消息后,先遵守群规。参见 #42", /消息序号/],
    ["收到新消息后,先遵守群规。当前 T-7", /任务号/],
    ["收到新消息后,先遵守群规。附最近 25 条", /最近 N 条/],
  ];
  for (const [text, why] of cases) {
    const r = assemble(emptyLog(), { stable: [{ kind: "system", text }], quotes: [], budgetBytes: BIG });
    assert.equal(r.ok === false && r.reason, "volatile-in-stable", text);
    if (!r.ok && r.reason === "volatile-in-stable") assert.match(r.match, why);
  }
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

// —— 第五轮:R4-01、R4-07
const S = [{ kind: "system", text: "助手规则" }] as const;
function retractedLog(text: string): Log {
  let log = append(emptyLog(), user, { kind: "message", text }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  return log;
}

test("撤回的短原文(1 到 4 字)出现在会变状态里也显式失败,没有长度阈值(R4-01 阳性埋雷)", () => {
  for (const text of ["否", "不行", "不同意", "秘密口令"]) {
    const r = assemble(retractedLog(text), { stable: S, quotes: [], volatile: `状态:${text}`, budgetBytes: BIG });
    assert.deepEqual(r, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 }, text);
  }
});

test("撤回原文中间夹了空白也算命中:空白规范化后比对", () => {
  const r = assemble(retractedLog("秘密口令"), { stable: S, quotes: [], volatile: "状态:秘 密\n口令", budgetBytes: BIG });
  assert.deepEqual(r, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 });
});

test("会变状态不含撤回原文时照常装配,短原文只是没出现(单开关对照)", () => {
  const r = ok(assemble(retractedLog("不同意"), { stable: S, quotes: [], volatile: "状态:同意", budgetBytes: BIG }));
  assert.ok(serialize(r.request).includes("状态:同意"));
  assert.equal(serialize(r.request).includes("不同意"), false);
});

test("撤回原文出现在 stable、压缩块、其他消息里都在最终请求边界拦下,并指出位置", () => {
  const leakStable = assemble(retractedLog("不同意"), { stable: [{ kind: "system", text: "规则:不同意就停" }], quotes: [], budgetBytes: BIG });
  assert.deepEqual(leakStable, { ok: false, reason: "retracted-text-leaked", where: "stable", seq: 1 });
  const leakBlock = assemble(retractedLog("不同意"), { stable: S, quotes: [], budgetBytes: BIG, compressed: { throughSeq: 1, builtAtSeq: 2, text: "用户不同意" } });
  assert.deepEqual(leakBlock, { ok: false, reason: "retracted-text-leaked", where: "compressed", seq: 1 });
  const log = append(retractedLog("不同意"), contact, { kind: "message", text: "收到,你不同意" }, at);
  const leakHistory = assemble(log, { stable: S, quotes: [], budgetBytes: BIG });
  assert.deepEqual(leakHistory, { ok: false, reason: "retracted-text-leaked", where: "history", seq: 1 });
});

test("被引用的消息在 tail 里复述了撤回原文也拦下", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "不同意" }, at);
  log = append(log, contact, { kind: "message", text: "他说不同意" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  const r = assemble(log, { stable: S, quotes: [2], budgetBytes: BIG, compressed: { throughSeq: 2, builtAtSeq: 3, text: "旧事" } });
  assert.deepEqual(r, { ok: false, reason: "retracted-text-leaked", where: "tail", seq: 1 });
});

test("宿主加的序号与发言者标签不参与扫描:撤回原文恰好是标签片段也不误拦", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "u1" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  log = append(log, user, { kind: "message", text: "下一步" }, at);
  const r = ok(assemble(log, { stable: S, quotes: [], budgetBytes: BIG }));
  assert.ok(serialize(r.request).includes("#3 user:u1: 下一步"));
});

test("recompress 改不了交给它的消息,引用页入仍是日志里的原文(R4-01 阳性埋雷)", () => {
  const secret = "这是需要撤回的密码";
  let log = append(emptyLog(), user, { kind: "message", text: "真正的用户指令" }, at);
  log = append(log, user, { kind: "message", text: secret }, at);
  log = append(log, user, { kind: "retract", target: 2 }, at);
  let threw = false;
  const r = ok(assemble(log, {
    stable: S, quotes: [1], budgetBytes: BIG, compressed: { throughSeq: 2, builtAtSeq: 2, text: "旧摘要" },
    recompress: (_n, visible) => {
      try { (visible[0] as { text: string }).text = secret; } catch { threw = true; }
      try { (visible[0]?.sender as { id: string }).id = "攻击者"; } catch { threw = true; }
      return "安全摘要";
    },
  }));
  assert.equal(threw, true, "冻结的副本赋值会抛错");
  const body = serialize(r.request);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes("攻击者"), false);
});

test("recompress 拿到的是冻结深拷贝,内容与可见消息逐字一致", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "甲" }, at);
  log = append(log, contact, { kind: "message", text: "乙" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  let got: unknown;
  const r = ok(assemble(log, { stable: S, quotes: [], budgetBytes: BIG, compressed: { throughSeq: 2, builtAtSeq: 2, text: "甲乙" }, recompress: (_n, v) => { got = v; return "乙"; } }));
  assert.deepEqual(r.compressed, { throughSeq: 2, builtAtSeq: 3, text: "乙" });
  assert.equal(serialize(r.request).includes("甲"), false);
  const v = got as readonly { seq: number; sender: object; text: string }[];
  assert.equal(Object.isFrozen(v) && Object.isFrozen(v[0]) && Object.isFrozen(v[0]?.sender), true);
  assert.deepEqual(v.map((m) => [m.seq, m.text]), [[2, "乙"]]);
});

test("recompress 抛错时显式失败,不把半成品当压缩块", () => {
  const r = assemble(retractedLog("不同意"), { stable: S, quotes: [], budgetBytes: BIG, compressed: { throughSeq: 1, builtAtSeq: 1, text: "旧" }, recompress: () => { throw new Error("压缩器坏了"); } });
  assert.equal(r.ok === false && r.reason, "invalid-compressed");
  if (!r.ok && r.reason === "invalid-compressed") assert.match(r.detail, /压缩器坏了/);
});

test("撤回前多次编辑的每个版本出现在会变状态或压缩块里都拦下(R4-07 阳性埋雷)", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "最初的旧内容" }, at);
  log = append(log, user, { kind: "edit", target: 1, text: "第二版内容" }, at);
  log = append(log, user, { kind: "edit", target: 1, text: "新的非常机密内容" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  for (const v of ["最初的旧内容", "第二版内容", "新的非常机密内容"]) {
    const a = assemble(log, { stable: S, quotes: [], volatile: v, budgetBytes: BIG });
    assert.deepEqual(a, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 }, v);
    const b = assemble(log, { stable: S, quotes: [], budgetBytes: BIG, compressed: { throughSeq: 3, builtAtSeq: 4, text: `摘要:${v}` } });
    assert.deepEqual(b, { ok: false, reason: "retracted-text-leaked", where: "compressed", seq: 1 }, v);
  }
});

test("恰好 4 字与 3 字的撤回原文都拦,未撤回的同样文字照常(R4-07 边界对照)", () => {
  for (const text of ["秘密口令", "三个字"]) {
    const r = assemble(retractedLog(text), { stable: S, quotes: [], volatile: text, budgetBytes: BIG });
    assert.equal(r.ok === false && r.reason, "retracted-text-leaked", text);
    const kept = append(emptyLog(), user, { kind: "message", text }, at);
    const k = assemble(kept, { stable: S, quotes: [], volatile: text, budgetBytes: BIG });
    assert.equal(k.ok, true, text);
  }
});

// —— 第六轮:R5-03..R5-05
function staleBlockLog(): Log {
  let log = append(emptyLog(), user, { kind: "message", text: "旧的保密原文" }, at);
  log = append(log, user, { kind: "message", text: "普通消息" }, at);
  return append(log, user, { kind: "retract", target: 1 }, at);
}
const STALE = { throughSeq: 2, builtAtSeq: 2, text: "旧摘要" };

test("recompress 抛出 message getter 抛错、原型陷阱抛错、非 Error 值时都返回 invalid-compressed,不抛出(R5-03 阳性埋雷)", () => {
  const badMessage = new Error("x");
  Object.defineProperty(badMessage, "message", { get() { throw new Error("message getter 错误"); } });
  const badProto = new Proxy({}, { getPrototypeOf() { throw new Error("原型陷阱"); } });
  const badString = { toString() { throw new Error("toString 炸了"); } };
  for (const thrown of [badMessage, badProto, badString, 42, null, undefined]) {
    let r: ReturnType<typeof assemble> | undefined;
    assert.doesNotThrow(() => { r = assemble(staleBlockLog(), { stable: S, quotes: [], budgetBytes: BIG, compressed: STALE, recompress: () => { throw thrown; } }); });
    assert.equal(r?.ok === false && r.reason, "invalid-compressed", String(typeof thrown));
    if (r && !r.ok && r.reason === "invalid-compressed") assert.match(r.detail, /^recompress 抛错/);
  }
});

test("recompress 抛普通 Error 时失败原因里带它的文字(R5-03 单开关对照)", () => {
  const r = assemble(staleBlockLog(), { stable: S, quotes: [], budgetBytes: BIG, compressed: STALE, recompress: () => { throw new Error("压缩服务 503"); } });
  assert.equal(r.ok === false && r.reason, "invalid-compressed");
  if (!r.ok && r.reason === "invalid-compressed") assert.match(r.detail, /压缩服务 503/);
});

test("发言者 id 含冒号加空格、单个冒号或空格时,标签不参与撤回扫描(R5-04 阳性埋雷)", () => {
  for (const id of ["其他: 敏感词", "其他:敏感词", "其他 敏感词", "敏感词"]) {
    let log = append(emptyLog(), user, { kind: "message", text: "敏感词" }, at);
    log = append(log, user, { kind: "retract", target: 1 }, at);
    log = append(log, { kind: "user", id }, { kind: "message", text: "普通内容" }, at);
    log = append(log, { kind: "user", id }, { kind: "message", text: "原句" }, at);
    log = append(log, { kind: "user", id }, { kind: "edit", target: 4, text: "改过的句子" }, at);
    const r = assemble(log, { stable: S, quotes: [], budgetBytes: BIG });
    assert.equal(r.ok, true, id);
    if (r.ok) assert.ok(serialize(r.request).includes(`${id}: 普通内容`), id);
  }
});

test("引用页入的发言者 id 含撤回原文时同样不误拦", () => {
  let log = append(emptyLog(), { kind: "contact", id: "c: 敏感词" }, { kind: "message", text: "被引用的话" }, at);
  log = append(log, user, { kind: "message", text: "敏感词" }, at);
  log = append(log, user, { kind: "retract", target: 2 }, at);
  const r = ok(assemble(log, { stable: S, quotes: [1], budgetBytes: BIG, compressed: { throughSeq: 1, builtAtSeq: 3, text: "前情" } }));
  assert.ok(serialize(r.request).includes("[引用页入] #1 contact:c: 敏感词: 被引用的话"));
});

test("正文里真的含撤回原文时,不管发言者 id 长什么样都拦下(R5-04 单开关对照)", () => {
  for (const id of ["其他: 敏感词", "plain"]) {
    let log = append(emptyLog(), user, { kind: "message", text: "敏感词" }, at);
    log = append(log, user, { kind: "retract", target: 1 }, at);
    const msg = append(log, { kind: "user", id }, { kind: "message", text: "我也说敏感词" }, at);
    assert.deepEqual(assemble(msg, { stable: S, quotes: [], budgetBytes: BIG }), { ok: false, reason: "retracted-text-leaked", where: "history", seq: 1 }, id);
    const ed = append(append(log, { kind: "user", id }, { kind: "message", text: "原句" }, at), { kind: "user", id }, { kind: "edit", target: 3, text: "改成敏感词" }, at);
    assert.deepEqual(assemble(ed, { stable: S, quotes: [], budgetBytes: BIG }), { ok: false, reason: "retracted-text-leaked", where: "history", seq: 1 }, id);
  }
});

test("制表、换行、全角空格、不换行空格与零宽字符夹在撤回原文里都算命中(R5-05 阳性埋雷)", () => {
  for (const v of ["秘\t密口令", "秘\n密\r\n口令", "秘　密　口令", "秘 密口令", "秘​密‌口‍令", "秘⁠密﻿口令"]) {
    const r = assemble(retractedLog("秘密口令"), { stable: S, quotes: [], volatile: v, budgetBytes: BIG });
    assert.deepEqual(r, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 }, JSON.stringify(v));
  }
});

test("同样夹着各种空白但文字不同时照常装配(R5-05 单开关对照)", () => {
  for (const v of ["秘\t密码", "秘　诀口令", "秘​方"]) {
    const r = assemble(retractedLog("秘密口令"), { stable: S, quotes: [], volatile: v, budgetBytes: BIG });
    assert.equal(r.ok, true, JSON.stringify(v));
  }
});

test("多条消息分别撤回时每一条都拦,命中哪条报哪条(R5-05 阳性埋雷)", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "第一个秘密" }, at);
  log = append(log, user, { kind: "message", text: "第二个秘密" }, at);
  log = append(log, user, { kind: "message", text: "第三条留着" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  log = append(log, user, { kind: "retract", target: 2 }, at);
  assert.deepEqual(assemble(log, { stable: S, quotes: [], volatile: "第一个秘密", budgetBytes: BIG }), { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 });
  assert.deepEqual(assemble(log, { stable: S, quotes: [], volatile: "第二个秘密", budgetBytes: BIG }), { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 2 });
  const r = ok(assemble(log, { stable: S, quotes: [], volatile: "第三条留着", budgetBytes: BIG }));
  assert.deepEqual(r.manifest.map((m) => m.seq), [3]);
});

test("同一消息撤回后再被引用多次:每次都跳过,原文不出现,也不重复报跳过", () => {
  let log = append(emptyLog(), user, { kind: "message", text: "撤回的那句" }, at);
  log = append(log, user, { kind: "message", text: "留下的" }, at);
  log = append(log, user, { kind: "retract", target: 1 }, at);
  const first = ok(assemble(log, { stable: S, quotes: [1, 1], budgetBytes: BIG }));
  assert.deepEqual(first.skipped, [{ seq: 1, reason: "retracted" }, { seq: 1, reason: "retracted" }]);
  log = append(log, user, { kind: "message", text: "又提了一次" }, at);
  const again = ok(assemble(log, { stable: S, quotes: [1], budgetBytes: BIG, previousHeadSeq: first.headSeq }));
  assert.equal(serialize(again.request).includes("撤回的那句"), false);
  assert.deepEqual(again.skipped, [{ seq: 1, reason: "retracted" }]);
  assert.deepEqual(again.prefixBreaks, [], "同一次撤回不重复报前缀作废");
});

test("日志或装配选项带 getter、Proxy 时显式失败,getter 调用 0 次;同内容普通对象照常装配", () => {
  let calls = 0;
  const trap = <T extends object>(o: T, k: string, v: unknown): T => { Object.defineProperty(o, k, { enumerable: true, configurable: true, get() { calls++; return v; } }); return o; };
  const log = history();
  const quotes: unknown[] = [];
  trap(quotes, "0", 1);
  const cases: [unknown, unknown, RegExp][] = [
    [trap({}, "events", log.events), { stable: S, quotes: [], budgetBytes: BIG }, /日志\.events.*getter/],
    [log, trap({ stable: S, quotes: [] }, "budgetBytes", BIG), /装配选项\.budgetBytes.*getter/],
    [log, { stable: S, quotes, budgetBytes: BIG }, /装配选项\.quotes\[0\].*getter/],
    [log, { stable: [trap({ kind: "system" }, "text", "规则")], quotes: [], budgetBytes: BIG }, /装配选项\.stable\[0\]\.text.*getter/],
    [new Proxy(log, {}), { stable: S, quotes: [], budgetBytes: BIG }, /Proxy/],
  ];
  for (const [l, o, re] of cases) {
    const r = assemble(l as Log, o as AssembleOptions);
    assert.equal(r.ok === false && r.reason, "invalid-input");
    if (!r.ok && r.reason === "invalid-input") assert.match(r.detail, re);
  }
  assert.equal(calls, 0);
  assert.equal(assemble(log, { stable: S, quotes: [1], budgetBytes: BIG }).ok, true);
});

// —— 第六轮:原型污染穿透调用链(R6-01 / R6-02)、公开工具执行 getter(R6-03)、空白定义与实现同源(R6-05)
/** 在 target 的 key 上临时装属性(描述符用空原型构造),只在 fn 执行期间生效,结束后一定复原 */
function polluted<T>(target: object, key: string, mode: "setter" | "readonly", counter: { n: number }, fn: () => T): T {
  const had = Object.getOwnPropertyDescriptor(target, key);
  const d: PropertyDescriptor = Object.create(null);
  d.configurable = true;
  if (mode === "setter") d.set = () => { counter.n++; };
  else { d.value = 17; d.writable = false; }
  Object.defineProperty(target, key, d);
  try { return fn(); } finally {
    if (had) Object.defineProperty(target, key, had);
    else delete (target as Record<string, unknown>)[key];
  }
}

test("Object.prototype 上有 get/set/value/writable/enumerable/configurable 的 setter 或只读值时,合法装配照常成功且内容正确(R6-01 阳性埋雷)", () => {
  const baseline = ok(assemble(history(), opts({ quotes: [1] })));
  for (const key of ["get", "set", "value", "writable", "enumerable", "configurable"]) for (const mode of ["setter", "readonly"] as const) {
    const counter = { n: 0 };
    const log = history();
    const r = polluted(Object.prototype, key, mode, counter, () => assemble(log, opts({ quotes: [1] })));
    assert.equal(r.ok, true, `${key}/${mode}: ${JSON.stringify(r)}`);
    if (r.ok) assert.equal(serialize(r.request), serialize(baseline.request), `${key}/${mode}`);
    assert.equal(counter.n, 0, `${key}/${mode}`);
  }
});

test("Array.prototype[0] 上有 setter 或只读值时,合法装配照常成功,段、清单与跳过都是自有下标且内容正确(R6-02 阳性埋雷)", () => {
  let log = history();
  log = append(log, user, { kind: "retract", target: 8 }, at);
  const o = opts({ quotes: [1, 8], volatile: "任务表:无" });
  const baseline = ok(assemble(log, o));
  for (const mode of ["setter", "readonly"] as const) {
    const counter = { n: 0 };
    let r: AssembleResult | undefined;
    assert.doesNotThrow(() => { r = polluted(Array.prototype, "0", mode, counter, () => assemble(log, o)); }, mode);
    const got = ok(r as AssembleResult);
    assert.equal(counter.n, 0, mode);
    for (const arr of [got.request.segments, got.manifest, got.skipped, got.prefixBreaks]) assert.equal(Object.hasOwn(arr, "0"), true, mode);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(baseline)), mode);
  }
});

test("serialize、prefixLength、prefixHash 遇到带 getter 的请求抛受控 TypeError,getter 调用 0 次;装配结果照常可用(R6-03 阳性埋雷)", () => {
  let calls = 0;
  const req = {};
  Object.defineProperty(req, "segments", { enumerable: true, get() { calls++; return []; } });
  for (const fn of [() => serialize(req as never), () => prefixLength(req as never), () => prefixHash(req as never)]) {
    assert.throws(fn, (e: unknown) => e instanceof TypeError && /只接受普通数据对象.*segments.*getter/.test(e.message));
  }
  assert.equal(calls, 0);
  const r = ok(assemble(history(), opts()));
  assert.equal(prefixHash(r.request, prefixLength(r.request)), prefixHash(r.request));
  assert.equal(serialize(r.request).length > 0, true);
});

/** Unicode 空白(White_Space)全集里的代表点、零宽字符与 BOM:撤回比对时都必须被去掉 */
const INVISIBLE_SAMPLES = ["\u0009", "\u000A", "\u000B", "\u000C", "\u000D", "\u0020", "\u0085", "\u00A0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200A", "\u2028", "\u2029", "\u202F", "\u205F", "\u3000", "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"];

test("撤回原文中间夹着 U+000B、U+0085、U+1680、U+2000–U+200A、U+2028/2029、U+202F、U+205F、U+3000、零宽字符或 BOM 都算命中(R6-05 阳性埋雷)", () => {
  for (const ch of INVISIBLE_SAMPLES) {
    const hex = ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
    assert.equal(squash(`秘${ch}密`), "秘密", `U+${hex}`);
    const r = assemble(retractedLog("秘密口令"), { stable: S, quotes: [], volatile: `状态:秘${ch}密口令`, budgetBytes: BIG });
    assert.deepEqual(r, { ok: false, reason: "retracted-text-leaked", where: "volatile", seq: 1 }, `U+${hex}`);
  }
});

test("撤回比对用的不可见字符定义与实现同源:每个样例都在 INVISIBLE 里,普通可见字符都不在(R6-05 单开关对照)", () => {
  for (const ch of INVISIBLE_SAMPLES) assert.equal(new RegExp(INVISIBLE.source, "u").test(ch), true, `U+${ch.codePointAt(0)?.toString(16)}`);
  for (const ch of ["秘", "a", "_", "-", "\u00B7", "\u00AD"]) assert.equal(new RegExp(INVISIBLE.source, "u").test(ch), false, ch);
  const r = assemble(retractedLog("秘密口令"), { stable: S, quotes: [], volatile: "状态:秘-密口令", budgetBytes: BIG });
  assert.equal(r.ok, true);
});
