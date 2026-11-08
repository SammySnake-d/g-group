// 联系人每轮五块重拼(D06 第 2 小节、D22 第 3 节、D23 第 9 小节)。
// AC-39 ①②:固定前缀输入相同的两轮,第 1 块逐字节相同;配置文本混入会变内容显式拒绝;账本、状态笔记、新消息不进前缀;断点只在第 1 块末尾。
// AC-40 坏实现⑪:请求里只有五块;账本是原文;上一轮的新消息不留到下一轮,旧消息只经第 5 块换入。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssembleRoundResult, assembleRound, type LedgerEntry, type RoundAssembleInput, type RoundPrefix } from "./rounds.ts";
import { BLOCK_LABELS, type BlockNo, type InboundCompute, type InboundMessage, type InboundSchedule } from "./runtime-ports.ts";

const at = "2026-11-08T14:00:00Z";
const ROOM = "g-group";
const DM = "dm-u1";
const SYSTEM = "你是群聊里的联系人,只在被叫到或有把握时发言。";
const TOOLS = "reply(roomId, text)\ndispatch(roomId, sourceSeq, title, task)\nread_quote_parent(seq)";
const PERSONA = "小前:负责前端,说话简短,先给结论再给证据。";
const NOTICE = "本群讨论 g-group 后端集成;PR 合并由用户做。";
const RULE = { id: "r-1", kind: "rule", sourceSeq: 1500, text: "改代码前先问我。22:00 后别 @ 我。" } as const;
const CORRECTION = { id: "r-2", kind: "correction", sourceSeq: 2063, text: "#2063 那条说错了:不用图谱存,按 seq 固化夹具。" } as const;
const PREFIX: RoundPrefix = { system: SYSTEM, tools: TOOLS, persona: PERSONA, roomNotice: NOTICE, rules: [CORRECTION, RULE] };

const C1: LedgerEntry = { id: "c-1", sourceSeq: 2101, taskId: "T-3", shortName: "快捷键", text: "我会排查 Meta+Raycast 快捷键冲突,\n  先列出 3 个候选原因再逐个验证 ✅", status: "active" };
const C2: LedgerEntry = { id: "c-2", sourceSeq: 2140, taskId: "T-4", shortName: "PR#3 审查", text: "我会对 PR #3 返修后做跨厂商复审,重点看变异分数。", status: "active" };
const C3: LedgerEntry = { id: "c-3", sourceSeq: 2150, taskId: null, text: "我会在 PR 合并后提醒你更新 dev/integration。", status: "active" };
const NOTE = { version: 7, text: "在做:快捷键排查。\n下一步:验证候选 2。\n完成判据:用户确认不再冲突。" };
const QUOTED = "返修已推送,commit 6c52402,请复审。";

const msg = (seq: number, text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  kind: "message", roomId: ROOM, seq, sender: { kind: "user", id: "u1", name: "Sammy" }, text, replyToSeq: null, quotedSeqs: [], mentions: [], command: null, at, ...over,
});
const compute = (roomId = ROOM): InboundCompute => ({ kind: "compute", roomId, taskId: "T-4", computeId: "cmp-7", signal: "milestone", summary: "变异分数 0.82,还剩 3 个存活", at });
const schedule = (roomId = ROOM): InboundSchedule => ({ kind: "schedule", roomId, scheduleId: "sch-1", prompt: "每天 8 点汇总在途任务", at });

function input(over: Partial<RoundAssembleInput> = {}): RoundAssembleInput {
  return {
    prefix: PREFIX,
    ledger: { open: [C1, C2, C3], boundIds: ["c-1"] },
    stateNote: NOTE,
    processedSeq: { [ROOM]: 2200 },
    fresh: [msg(2201, "快捷键那个先停一下"), msg(2203, "PR#3 再看一遍变异", { replyToSeq: 2141, quotedSeqs: [2140] })],
    pointers: [{ ref: "g-group#2141", text: QUOTED }],
    budgetBytes: 1_000_000,
    ...over,
  };
}

type Ok = Extract<AssembleRoundResult, { ok: true }>;
type Failure = Extract<AssembleRoundResult, { ok: false }>;
function ok(r: AssembleRoundResult): Ok {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("装配失败");
  return r;
}
function failed<K extends Failure["reason"]>(r: AssembleRoundResult, reason: K): Extract<Failure, { reason: K }> {
  assert.equal(r.ok, false, "应当失败");
  if (r.ok) throw new Error("应当失败");
  assert.equal(r.reason, reason, r.detail);
  return r as Extract<Failure, { reason: K }>;
}
const blockText = (r: Ok, n: BlockNo) => r.request.blocks.find((b) => b.block === n)?.text ?? "<缺块>";
const serial = (r: Ok) => r.request.blocks.map((b) => b.text).join("");
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

test("固定前缀输入相同的两轮:第 1 块逐字节相同,账本、状态笔记、新消息、指针都换了也不影响它", () => {
  const a = ok(assembleRound(input()));
  const b = ok(assembleRound(input({
    ledger: { open: [C2], boundIds: ["c-2"] },
    stateNote: { version: 8, text: "改做 PR#3 审查" },
    processedSeq: { [ROOM]: 2203 },
    fresh: [msg(2210, "新问题:登录页白屏"), compute()],
    pointers: [],
  })));
  assert.ok(Buffer.from(blockText(a, 1), "utf8").equals(Buffer.from(blockText(b, 1), "utf8")), "第 1 块必须逐字节相同");
  assert.notEqual(blockText(a, 4), blockText(b, 4), "对照:第 4 块确实换了");
  const moving = [C1.text, C2.text, NOTE.text, "改做 PR#3 审查", "快捷键那个先停一下", "新问题:登录页白屏", "变异分数 0.82", QUOTED];
  for (const t of moving) assert.equal(blockText(a, 1).includes(t) || blockText(b, 1).includes(t), false, `第 1 块不应出现每轮会变的内容:${t}`);
});

test("第 1 块按 系统提示词 → 工具 → 人设 → 群公告 → 规矩原文 排列;规矩按来源 seq 排序、带来源 seq,含 seq 与时刻的原文照放", () => {
  const r = ok(assembleRound(input()));
  const expected =
    `[系统提示词]\n${SYSTEM}\n[工具声明]\n${TOOLS}\n[人设]\n${PERSONA}\n[群公告]\n${NOTICE}\n` +
    `[已确认规矩与用户纠正(原文)]\n〔规矩 r-1 · 来源 #1500〕\n${RULE.text}\n〔纠正 r-2 · 来源 #2063〕\n${CORRECTION.text}\n`;
  assert.equal(blockText(r, 1), expected);
  const swapped = ok(assembleRound(input({ prefix: { ...PREFIX, rules: [RULE, CORRECTION] } })));
  assert.equal(blockText(swapped, 1), blockText(r, 1), "规矩表存储顺序不同,前缀仍逐字节相同");
  const changed = ok(assembleRound(input({ prefix: { ...PREFIX, rules: [RULE] } })));
  assert.notEqual(blockText(changed, 1), blockText(r, 1), "规矩变了前缀如实跟着变");
  const dm = ok(assembleRound(input({ prefix: { ...PREFIX, tools: "", persona: "", roomNotice: "", rules: [] } })));
  assert.equal(blockText(dm, 1), `[系统提示词]\n${SYSTEM}\n`);
});

test("第 1 块的配置文本混入日期、时刻、seq 号、任务号、最近 N 条时显式拒绝,并指出是哪一段、命中什么", () => {
  const sys = failed(assembleRound(input({ prefix: { ...PREFIX, system: `${SYSTEM}\n当前时间 2026-11-08` } })), "volatile-in-prefix");
  assert.deepEqual([sys.part, sys.match], ["system", "日期:2026-11-08"]);
  const clock = failed(assembleRound(input({ prefix: { ...PREFIX, system: `${SYSTEM} 现在 14:05` } })), "volatile-in-prefix");
  assert.deepEqual([clock.part, clock.match], ["system", "时刻:14:05"]);
  const tools = failed(assembleRound(input({ prefix: { ...PREFIX, tools: `${TOOLS}\n在途任务:T-12 修登录` } })), "volatile-in-prefix");
  assert.deepEqual([tools.part, tools.match], ["tools", "任务号:T-12"]);
  const persona = failed(assembleRound(input({ prefix: { ...PREFIX, persona: `${PERSONA}\n最近 25 条消息如下` } })), "volatile-in-prefix");
  assert.deepEqual([persona.part, persona.match], ["persona", "最近 N 条:最近 25 条"]);
  const notice = failed(assembleRound(input({ prefix: { ...PREFIX, roomNotice: "最新一条是 #2071" } })), "volatile-in-prefix");
  assert.deepEqual([notice.part, notice.match], ["roomNotice", "消息序号:#2071"]);
  assert.match(notice.detail, /第 2–5 块/);
});

test("本轮绑定的承诺放账本原文详情,其余每条只有一行索引(id、短名、状态、来源 seq),未绑定的原文不进请求", () => {
  const r = ok(assembleRound(input()));
  const expected =
    "[承诺账本]\n本轮绑定(详情,账本原文):\n" +
    `〔承诺 c-1 · 快捷键 · active · 来源 #2101 · 任务 T-3〕\n${C1.text}\n` +
    "其余未了结(一行索引,详情按 id 取):\n" +
    "- 承诺 c-2 · PR#3 审查 · active · 来源 #2140 · 任务 T-4\n" +
    "- 承诺 c-3 · active · 来源 #2150\n";
  assert.equal(blockText(r, 2), expected);
  assert.equal(serial(r).includes(C2.text), false);
  assert.equal(serial(r).includes(C3.text), false);
  const rebound = ok(assembleRound(input({ ledger: { open: [C1, C2, C3], boundIds: ["c-2", "c-3"] } })));
  assert.equal(occurrences(blockText(rebound, 2), C2.text), 1);
  assert.equal(occurrences(blockText(rebound, 2), C3.text), 1);
  assert.equal(serial(rebound).includes(C1.text), false, "改绑后 c-1 只剩索引行");
  assert.ok(blockText(rebound, 2).split("\n").includes("- 承诺 c-1 · 快捷键 · active · 来源 #2101 · 任务 T-3"));
  const unknown = failed(assembleRound(input({ ledger: { open: [C1], boundIds: ["c-404"] } })), "invalid-input");
  assert.match(unknown.detail, /c-404 不在未了结承诺列表里/);
});

test("账本原文逐字节复制:多行、首尾空白、制表符、CRLF、emoji、seq 号、Markdown 都不改写,只出现一次,调用方输入也不被改动", () => {
  const weird: LedgerEntry = { id: "c-9", sourceSeq: 2190, taskId: "T-9", text: "  我会做 A、B:\n\t1. 跑 `npm test`\r\n2. **别**改 #2063 的结论 🙂\n\n", status: "waiting" };
  const inp = input({ ledger: { open: [weird], boundIds: ["c-9"] } });
  const before = JSON.stringify(inp);
  const r = ok(assembleRound(inp));
  assert.equal(blockText(r, 2), `[承诺账本]\n本轮绑定(详情,账本原文):\n〔承诺 c-9 · waiting · 来源 #2190 · 任务 T-9〕\n${weird.text}\n`);
  assert.ok(Buffer.from(blockText(r, 2), "utf8").includes(Buffer.from(weird.text, "utf8")));
  assert.equal(occurrences(serial(r), weird.text), 1);
  assert.equal(JSON.stringify(inp), before, "装配不改调用方的输入");
});

test("状态笔记按版本号原样放入第 3 块;没有笔记时第 3 块写占位", () => {
  const r = ok(assembleRound(input()));
  assert.equal(blockText(r, 3), `[状态笔记 v7]\n${NOTE.text}\n`);
  const none = ok(assembleRound(input({ stateNote: null })));
  assert.equal(blockText(none, 3), "[状态笔记]\n(尚无)\n");
  const bad = failed(assembleRound(input({ stateNote: { version: -1, text: "x" } })), "invalid-input");
  assert.match(bad.detail, /stateNote/);
});

test("第 4 块按到达顺序放 processed_seq 之后的全部输入:消息带 seq 号、发送人与原文,Compute 事件与定时触发也在", () => {
  const fresh = [
    msg(2201, "快捷键那个先停一下"),
    compute(),
    msg(2203, "PR#3 再看一遍变异\n  重点看存活的 3 个", { replyToSeq: 2141, quotedSeqs: [2140], mentions: ["c-front"] }),
    schedule(),
    msg(2204, "/stop", { sender: { kind: "contact", id: "c-astra", name: "Astra" }, command: { name: "stop", args: { taskId: "T-3" } } }),
    msg(5, "私聊:今晚别发消息", { roomId: DM }),
  ];
  const r = ok(assembleRound(input({ processedSeq: { [ROOM]: 2200, [DM]: 4 }, fresh })));
  const expected =
    "[新消息](processed_seq 之后,按到达顺序,原文)\n" +
    `#2201 · g-group · Sammy(user:u1) · ${at}\n快捷键那个先停一下\n` +
    `〔Compute cmp-7 · 任务 T-4 · milestone〕 · g-group · ${at}\n变异分数 0.82,还剩 3 个存活\n` +
    `#2203 · g-group · Sammy(user:u1) · ${at} · ↩ #2141 · 引 #2140 · @c-front\nPR#3 再看一遍变异\n  重点看存活的 3 个\n` +
    `〔定时 sch-1〕 · g-group · ${at}\n每天 8 点汇总在途任务\n` +
    `#2204 · g-group · Astra(contact:c-astra) · ${at} · /stop {"taskId":"T-3"}\n/stop\n` +
    `#5 · dm-u1 · Sammy(user:u1) · ${at}\n私聊:今晚别发消息\n`;
  assert.equal(blockText(r, 4), expected);
  const none = ok(assembleRound(input({ fresh: [] })));
  assert.equal(blockText(none, 4), "[新消息]\n(无)\n");
  const unordered = failed(assembleRound(input({ fresh: [msg(2203, "后"), msg(2201, "前")] })), "invalid-input");
  assert.match(unordered.detail, /严格递增/);
  const dup = failed(assembleRound(input({ fresh: [msg(2201, "一"), msg(2201, "一")] })), "invalid-input");
  assert.match(dup.detail, /严格递增/);
});

test("超预算显式失败:给出需要、预算、超出字节与各块字节,不返回截断的请求;预算恰好够时成功,totalBytes 等于五块 UTF-8 字节之和", () => {
  const full = ok(assembleRound(input()));
  assert.equal(full.totalBytes, Buffer.byteLength(serial(full), "utf8"));
  const over = failed(assembleRound(input({ budgetBytes: full.totalBytes - 1 })), "over-budget");
  assert.deepEqual([over.need, over.budget, over.over], [full.totalBytes, full.totalBytes - 1, 1]);
  assert.deepEqual([...over.blockBytes], full.request.blocks.map((b) => Buffer.byteLength(b.text, "utf8")));
  assert.match(over.detail, /超出 1 字节/);
  assert.equal(Object.hasOwn(over, "request"), false, "超预算不给半截请求");
  const exact = ok(assembleRound(input({ budgetBytes: full.totalBytes })));
  assert.equal(serial(exact), serial(full));
  const big = "很长的要求".repeat(400);
  const huge = failed(assembleRound(input({ fresh: [msg(2201, big)], budgetBytes: 2000 })), "over-budget");
  assert.ok(huge.over > 0 && huge.need === huge.budget + huge.over);
});

test("五块顺序固定 1→5,标签取 BLOCK_LABELS,只有第 1 块末尾标缓存断点;材料为空也照样给五块", () => {
  const r = ok(assembleRound(input()));
  assert.deepEqual(r.request.blocks.map((b) => b.block), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.request.blocks.map((b) => b.label), ([1, 2, 3, 4, 5] as const).map((n) => BLOCK_LABELS[n]));
  assert.deepEqual(r.request.blocks.map((b) => b.cacheBreakpoint), [true, false, false, false, false]);
  assert.ok(Object.isFrozen(r.request) && Object.isFrozen(r.request.blocks) && r.request.blocks.every((b) => Object.isFrozen(b)));
  const empty = ok(assembleRound(input({ ledger: { open: [], boundIds: [] }, stateNote: null, processedSeq: {}, fresh: [], pointers: [] })));
  assert.deepEqual(empty.request.blocks.map((b) => [b.block, b.cacheBreakpoint]), [[1, true], [2, false], [3, false], [4, false], [5, false]]);
  assert.deepEqual(empty.request.blocks.slice(1).map((b) => b.text), ["[承诺账本]\n(无未了结承诺)\n", "[状态笔记]\n(尚无)\n", "[新消息]\n(无)\n", "[指针与按需换入]\n(无)\n"]);
});

test("请求里只有五块:上一轮的新消息不留到下一轮,seq 不在 processed_seq 之后的旧消息显式拒绝,被引用旧消息只经第 5 块换入", () => {
  const r1 = ok(assembleRound(input({ fresh: [msg(2201, "第一轮 A"), msg(2202, "第一轮 B")], pointers: [] })));
  assert.ok(blockText(r1, 4).includes("第一轮 A") && blockText(r1, 4).includes("第一轮 B"));
  const r2 = ok(assembleRound(input({ processedSeq: { [ROOM]: 2202 }, fresh: [msg(2203, "第二轮 C", { replyToSeq: 2201 })], pointers: [{ ref: "g-group#2201", text: "第一轮 A" }] })));
  assert.equal(r2.request.blocks.length, 5);
  assert.equal(serial(r2).includes("第一轮 B"), false, "上一轮的新消息没被引用就不该出现");
  assert.deepEqual(r2.request.blocks.filter((b) => b.text.includes("第一轮 A")).map((b) => b.block), [5], "被引用的旧消息只在第 5 块");
  assert.equal(occurrences(serial(r2), "第一轮 A"), 1);
  const stale = failed(assembleRound(input({ processedSeq: { [ROOM]: 2202 }, fresh: [msg(2202, "第一轮 B")] })), "stale-fresh");
  assert.deepEqual([stale.roomId, stale.seq, stale.processedSeq], [ROOM, 2202, 2202]);
  assert.match(stale.detail, /第 5 块/);
});

test("第 5 块按指针原样换入原文,text 为空时只给指针;指针重复显式拒绝", () => {
  const r = ok(assembleRound(input({ pointers: [{ ref: "g-group#2141", text: QUOTED }, { ref: "T-3 交接快照", text: "" }] })));
  assert.equal(blockText(r, 5), `[指针与按需换入]\n〔g-group#2141〕\n${QUOTED}\n〔T-3 交接快照〕(未换入,可按指针取原文)\n`);
  const dup = failed(assembleRound(input({ pointers: [{ ref: "g-group#2141", text: QUOTED }, { ref: "g-group#2141", text: "又一份" }] })), "invalid-input");
  assert.match(dup.detail, /指针 g-group#2141 重复/);
});

test("basedOnSeq 按会话记第 4 块里消息的最大 seq;只有 Compute 事件或定时触发的会话不记,没有新消息时为空", () => {
  const fresh = [msg(2201, "a"), msg(5, "私聊 1", { roomId: DM }), compute("room-x"), msg(2207, "b"), msg(9, "私聊 2", { roomId: DM }), schedule("room-y")];
  const r = ok(assembleRound(input({ processedSeq: { [ROOM]: 2200, [DM]: 4 }, fresh })));
  assert.deepEqual({ ...r.request.basedOnSeq }, { [ROOM]: 2207, [DM]: 9 });
  assert.ok(Object.isFrozen(r.request.basedOnSeq));
  const eventsOnly = ok(assembleRound(input({ fresh: [compute(), schedule()] })));
  assert.deepEqual(Object.keys(eventsOnly.request.basedOnSeq), []);
  const odd = ok(assembleRound(input({ processedSeq: {}, fresh: [msg(3, "会话 id 恰好叫 __proto__", { roomId: "__proto__" })] })));
  assert.equal(Object.getOwnPropertyDescriptor(odd.request.basedOnSeq, "__proto__")?.value, 3, "会话 id 是 __proto__ 时也记成自有数据属性,不改原型");
});

test("非普通数据输入一律拒绝:getter 不被调用,Proxy、类实例、Date、函数、非对象都返回 invalid-input", () => {
  let calls = 0;
  const prefix = { ...PREFIX };
  Object.defineProperty(prefix, "system", { get() { calls++; return SYSTEM; }, enumerable: true });
  const getter = failed(assembleRound(input({ prefix })), "invalid-input");
  assert.equal(calls, 0, "getter 永不调用");
  assert.match(getter.detail, /prefix\.system 不允许 getter/);
  const proxy = failed(assembleRound(input({ ledger: new Proxy({ open: [], boundIds: [] }, {}) })), "invalid-input");
  assert.match(proxy.detail, /Proxy/);
  class Note { version = 1; text = "类实例冒充的笔记"; }
  const inst = failed(assembleRound(input({ stateNote: new Note() })), "invalid-input");
  assert.match(inst.detail, /stateNote 只允许普通对象/);
  const date = failed(assembleRound(input({ fresh: [{ ...msg(2201, "x"), at: new Date(0) as unknown as string }] })), "invalid-input");
  assert.match(date.detail, /fresh\[0\]\.at/);
  const fn = failed(assembleRound(input({ pointers: [{ ref: "p", text: (() => "x") as unknown as string }] })), "invalid-input");
  assert.match(fn.detail, /函数/);
  const nil = failed(assembleRound(null as unknown as RoundAssembleInput), "invalid-input");
  assert.match(nil.detail, /必须是对象/);
});

test("结构不合规的输入显式拒绝:引用指向更晚的消息、规矩缺来源 seq、索引字段带换行、预算不是非负整数", () => {
  const forward = failed(assembleRound(input({ fresh: [msg(2201, "x", { replyToSeq: 2201 })] })), "invalid-input");
  assert.match(forward.detail, /replyToSeq/);
  const quoteLater = failed(assembleRound(input({ fresh: [msg(2201, "x", { quotedSeqs: [2300] })] })), "invalid-input");
  assert.match(quoteLater.detail, /quotedSeqs\[0\]/);
  const noSeq = failed(assembleRound(input({ prefix: { ...PREFIX, rules: [{ ...RULE, sourceSeq: 0 }] } })), "invalid-input");
  assert.match(noSeq.detail, /prefix\.rules\[0\]\.sourceSeq/);
  const multiLine = failed(assembleRound(input({ ledger: { open: [{ ...C2, shortName: "PR#3\n审查" }], boundIds: [] } })), "invalid-input");
  assert.match(multiLine.detail, /shortName/);
  const budget = failed(assembleRound(input({ budgetBytes: 1.5 })), "invalid-input");
  assert.match(budget.detail, /budgetBytes/);
});
