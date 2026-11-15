// 引用链投递(需求文档 D24;验收 AC-41 ①–⑨)。纯函数:按层广度优先走引用 DAG,默认带前 K=3 级,每级标明还有没有上一级;
// 会话上文已有的只标编号;撤回或看不见的停在那一级;超预算从最远一级降成只给编号;read_quote_parent 只走一级。
// 夹具:g-group #2071 向上的真实引用链(fixtures/quote-chain-2071.json,从群聊原始日志按 seq 固化,共 14 级)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildQuoteChain, type QuoteChainInput, type QuoteMsg, quoteParent, renderQuoteChain } from "./quote-chain.ts";

const fx = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "quote-chain-2071.json"), "utf8")) as { messages: { seq: number; author: string; at: string; replyTo: number | null; text: string }[] };
const MSGS: QuoteMsg[] = fx.messages.map((m) => ({ seq: m.seq, author: m.author, at: m.at, text: m.text, quoted: m.replyTo === null ? [] : [m.replyTo], retracted: false }));
const base = (over: Partial<QuoteChainInput> = {}): QuoteChainInput => ({ fromSeq: 2071, refs: [2067], messages: MSGS, inContext: [], k: 3, scanCap: 32, budgetBytes: 1_000_000, ...over });
const text = (seq: number) => MSGS.find((m) => m.seq === seq)!.text;

test("重放 g-group 2071 号消息(新会话):带前 3 级 2067/2064/2063,原文按最新版本附上;第 3 级标明还有上一级;整条链 14 级,没带全时给出下一级 2061", () => {
  const c = buildQuoteChain(base())!;
  assert.deepEqual(c.levels.map((l) => [l.seq, l.depth, l.via, l.status]), [[2067, 1, 2071, "inline"], [2064, 2, 2067, "inline"], [2063, 3, 2064, "inline"]]);
  assert.deepEqual(c.levels.map((l) => l.text), [text(2067), text(2064), text(2063)]);
  assert.deepEqual(c.levels.map((l) => l.hasMoreAbove), [false, false, true]);
  assert.deepEqual(c.levels.map((l) => l.quotedSeqs), [[2064], [2063], [2061]]);
  assert.equal(c.depthTotal, 14);
  assert.equal(c.depthCapped, false);
  assert.equal(c.truncated, true);
  assert.deepEqual(c.nextSeqs, [2061]);
  assert.equal(c.levels[0]!.author, "Claude Code");
  const full = buildQuoteChain(base({ k: 20 }))!;
  assert.equal(full.levels.length, 14);
  assert.equal(full.truncated, false);
  assert.deepEqual(full.nextSeqs, []);
  assert.equal(full.levels.at(-1)!.seq, 1979);
  assert.equal(full.levels.at(-1)!.hasMoreAbove, false);
  const capped = buildQuoteChain(base({ scanCap: 5 }))!;
  assert.deepEqual([capped.depthTotal, capped.depthCapped], [5, true], "超过扫描上限只写到上限并标记");
  assert.equal(buildQuoteChain(base({ refs: [] })), null, "不带引用的消息没有引用链");
});

test("去重:会话上文已有的标 in_context、不贴原文,层数照算并继续往上走", () => {
  const c = buildQuoteChain(base({ inContext: [2067, 2064] }))!;
  assert.deepEqual(c.levels.map((l) => [l.seq, l.status, l.text]), [[2067, "in_context", null], [2064, "in_context", null], [2063, "inline", text(2063)]]);
  assert.equal(c.depthTotal, 14);
});

test("撤回与无权:撤回的标 deleted_or_withdrawn、看不见的标 not_visible,都不给原文,也不越过它往上走", () => {
  const withdrawn = MSGS.map((m) => (m.seq === 2064 ? { ...m, retracted: true } : m));
  const c = buildQuoteChain(base({ messages: withdrawn }))!;
  assert.deepEqual(c.levels.map((l) => [l.seq, l.status, l.text, l.hasMoreAbove]), [[2067, "inline", text(2067), false], [2064, "deleted_or_withdrawn", null, false]]);
  assert.equal(c.levels.some((l) => l.seq === 2063), false);
  assert.equal(c.depthTotal, 2);
  assert.deepEqual(c.nextSeqs, []);
  const hidden = buildQuoteChain(base({ messages: MSGS.filter((m) => m.seq !== 2063) }))!;
  assert.deepEqual(hidden.levels.map((l) => [l.seq, l.status, l.text]), [[2067, "inline", text(2067)], [2064, "inline", text(2064)], [2063, "not_visible", null]]);
  assert.equal(hidden.depthTotal, 3);
  assert.equal(hidden.levels[2]!.hasMoreAbove, false);
});

test("DAG:A 同时引用 B、C,B、C 都引用 D,D 只出现一次,via 记第一次走到它的那条;多条引用按层广度优先", () => {
  const m = (seq: number, quoted: number[]): QuoteMsg => ({ seq, author: "u", at: "t", text: `正文${seq}`, quoted, retracted: false });
  const c = buildQuoteChain({ fromSeq: 10, refs: [8, 9], messages: [m(5, []), m(8, [5]), m(9, [5])], inContext: [], k: 3, scanCap: 32, budgetBytes: 100_000 })!;
  assert.deepEqual(c.levels.map((l) => [l.seq, l.depth, l.via]), [[8, 1, 10], [9, 1, 10], [5, 2, 8]]);
  assert.equal(c.depthTotal, 2);
  const skip = buildQuoteChain({ fromSeq: 10, refs: [8, 5], messages: [m(5, []), m(8, [5])], inContext: [], k: 3, scanCap: 32, budgetBytes: 100_000 })!;
  assert.deepEqual(skip.levels.map((l) => [l.seq, l.depth, l.via]), [[8, 1, 10], [5, 1, 10]], "同一条既被直接引用又在更上一级:按最近的一级算,只出现一次");
  assert.equal(skip.depthTotal, 1);
  const bad = buildQuoteChain({ fromSeq: 10, refs: [8], messages: [m(8, [9]), m(9, [8])], inContext: [], k: 3, scanCap: 32, budgetBytes: 100_000 })!;
  assert.deepEqual(bad.levels.map((l) => l.seq), [8], "引用只能指向更早的 seq:指向更晚的当脏数据跳过,不成环");
});

test("预算:只够两级时从最远一级降成只给编号与作者,近的级不被挤掉,降级的进 nextSeqs 且 truncated 为真", () => {
  const two = Buffer.byteLength(text(2067), "utf8") + Buffer.byteLength(text(2064), "utf8");
  const c = buildQuoteChain(base({ budgetBytes: two }))!;
  assert.deepEqual(c.levels.map((l) => [l.seq, l.status]), [[2067, "inline"], [2064, "inline"], [2063, "id_only"]]);
  assert.equal(c.levels[2]!.text, null);
  assert.equal(c.levels[2]!.author, "Claude Code");
  assert.deepEqual(c.nextSeqs, [2061, 2063]);
  assert.equal(c.truncated, true);
  const none = buildQuoteChain(base({ budgetBytes: 0 }))!;
  assert.deepEqual(none.levels.map((l) => l.status), ["id_only", "id_only", "id_only"]);
});

test("read_quote_parent:只返回直接上一级,字段与引用链一致", () => {
  const p = quoteParent({ seq: 2064, messages: MSGS, inContext: [2067], budgetBytes: 1_000_000 });
  assert.deepEqual(p.map((l) => [l.seq, l.depth, l.via, l.status, l.hasMoreAbove]), [[2063, 1, 2064, "inline", true]]);
  assert.deepEqual(quoteParent({ seq: 1979, messages: MSGS, inContext: [], budgetBytes: 1_000_000 }), []);
  const gone = quoteParent({ seq: 2064, messages: MSGS.map((m) => (m.seq === 2063 ? { ...m, retracted: true } : m)), inContext: [], budgetBytes: 1_000_000 });
  assert.deepEqual(gone.map((l) => [l.seq, l.status, l.text]), [[2063, "deleted_or_withdrawn", null]]);
});

test("呈现:一行总况(深度、是否截断、下一级),每级一行编号、作者、层数、来由与状态,inline 的附原文", () => {
  const c = buildQuoteChain(base({ inContext: [2067] }))!;
  const t = renderQuoteChain(c);
  assert.match(t, /^引用链 depth_total=14 · truncated=true · next_seqs=#2061\n/);
  assert.match(t, /\nL1 #2067 · Claude Code · [^\n]* · via #2071 · in_context\n/);
  assert.match(t, /\nL3 #2063 · Claude Code · [^\n]* · via #2064 · inline · has_more_above\n/);
  assert.ok(t.includes(text(2063)));
  assert.equal(t.includes(text(2067)), false, "in_context 不贴原文");
  const capped = renderQuoteChain(buildQuoteChain(base({ scanCap: 5 }))!);
  assert.match(capped, /depth_total=≥5/);
  const m = (seq: number, quoted: number[], retracted = false): QuoteMsg => ({ seq, author: `u${seq}`, at: `t${seq}`, text: `正文${seq}`, quoted, retracted });
  const small = buildQuoteChain({ fromSeq: 10, refs: [9], messages: [m(5, []), m(7, [5], true), m(8, [7]), m(9, [8])], inContext: [9], k: 3, scanCap: 32, budgetBytes: 100_000 })!;
  assert.equal(renderQuoteChain(small), "引用链 depth_total=3 · truncated=false · next_seqs=无\nL1 #9 · u9 · t9 · via #10 · in_context\nL2 #8 · u8 · t8 · via #9 · inline\n正文8\nL3 #7 · u7 · t7 · via #8 · deleted_or_withdrawn\n", "整段逐字");
});
