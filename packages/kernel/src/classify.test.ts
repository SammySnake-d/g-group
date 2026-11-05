// AC-11 先机械后语义:机械锚点(@、↩ #seq、确认卡版本号)总是机械提取;只有锚点本身能确定意图时才不调分类器。
// AC-12 分类只出固定枚举 E1..E10 或 Uncertain;非法输出(含无法序列化的)封闭为 Uncertain 并记违规。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Classifier, classifyInbound, EVENT_CODES, safeDescribe } from "./classify.ts";

const user = { kind: "user", id: "u1" } as const;
/** 按输入框的方式给出结构化点名:找到第 nth 个 "@name" 的确切范围 */
function at(text: string, name: string, id: string, nth = 0) {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = text.indexOf(`@${name}`, start + 1);
  if (start < 0) throw new Error(`正文里没有 @${name}`);
  return { id, name, start, end: start + name.length + 1 };
}
function counting(answer: unknown): { fn: Classifier; calls: () => number } {
  let n = 0;
  return { fn: () => { n++; return answer; }, calls: () => n };
}

test("确认卡结构化回复(卡号 + 版本 + 决定)机械判定为 E6,带目标,分类器调用 0 次", () => {
  const c = counting("E1");
  const r = classifyInbound({ sender: user, text: "同意", card: { cardId: "q-7", version: 3, decision: "approve" } }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.equal(r.intent, "E6");
  assert.deepEqual(r.target, { cardId: "q-7", version: 3, decision: "approve" });
  assert.equal(r.violation, undefined);
  assert.equal(c.calls(), 0);
});

test("确认卡回复不是用户本人、缺卡号、版本非正整数、决定越界都封闭为 Uncertain,也不调分类器", () => {
  const cases = [
    { sender: { kind: "contact", id: "c1" }, text: "同意", card: { cardId: "q-7", version: 3, decision: "approve" } },
    { sender: user, text: "同意", card: { cardId: "", version: 3, decision: "approve" } },
    { sender: user, text: "同意", card: { cardId: "q-7", version: 0, decision: "approve" } },
    { sender: user, text: "同意", card: { cardId: "q-7", version: 2.5, decision: "approve" } },
    { sender: user, text: "同意", card: { cardId: "q-7", version: 3, decision: "maybe" } },
  ];
  for (const e of cases) {
    const c = counting("E6");
    const r = classifyInbound(e as Parameters<typeof classifyInbound>[0], c.fn);
    assert.equal(r.intent, "Uncertain", JSON.stringify(e));
    assert.equal(typeof r.violation, "string");
    assert.equal(r.target, undefined);
    assert.equal(c.calls(), 0);
  }
});

test("只有 @ 没有别的文字的点名机械判定为 E1,分类器调用 0 次", () => {
  const c = counting("E4");
  const text = "@小前 ";
  const r = classifyInbound({ sender: user, text, mentions: [at(text, "小前", "c-front")] }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.equal(r.intent, "E1");
  assert.deepEqual(r.anchors, { mentions: [{ id: "c-front", name: "小前", start: 0, end: 3 }], quotes: [] });
  assert.equal(c.calls(), 0);
});

test("带 @ 的停止、修改、纠偏文字意图不能机械确定,交给分类器并采用其结果,锚点照样提取", () => {
  for (const [text, code] of [["@小秘 停止定时总结", "E4"], ["@小秘 改成每天 9 点", "E3"], ["@小秘 我不是让你写代码", "E5"]] as const) {
    const c = counting(code);
    const r = classifyInbound({ sender: user, text, mentions: [at(text, "小秘", "xiaomi")] }, c.fn);
    assert.equal(r.via, "semantic", text);
    assert.equal(r.intent, code, text);
    assert.deepEqual(r.anchors.mentions.map((m) => m.id), ["xiaomi"]);
    assert.equal(c.calls(), 1);
  }
});

test("带 ↩ 引用的控制指令交给分类器,引用序号作为锚点保留", () => {
  const c = counting("E4");
  const r = classifyInbound({ sender: user, text: "这条先别弄了", quotes: [12, 15] }, c.fn);
  assert.equal(r.via, "semantic");
  assert.equal(r.intent, "E4");
  assert.deepEqual(r.anchors, { mentions: [], quotes: [12, 15] });
  assert.equal(c.calls(), 1);
});

test("同一句纯点名多一个引用就不再是纯点名,改调分类器(单开关对照)", () => {
  const c = counting("E1");
  const r = classifyInbound({ sender: user, text: "@小前", mentions: [at("@小前", "小前", "c-front")], quotes: [3] }, c.fn);
  assert.equal(r.via, "semantic");
  assert.equal(c.calls(), 1);
});

test("没有任何锚点时调分类器恰好 1 次", () => {
  const c = counting("E3");
  const r = classifyInbound({ sender: user, text: "看下登录页" }, c.fn);
  assert.equal(r.via, "semantic");
  assert.equal(r.intent, "E3");
  assert.deepEqual(r.anchors, { mentions: [], quotes: [] });
  assert.equal(c.calls(), 1);
});

test("分类器返回自由文本按 Uncertain 处理并记录违规原值(阳性埋雷)", () => {
  const c = counting("这是一条派活消息");
  const r = classifyInbound({ sender: user, text: "帮我把数据导一下" }, c.fn);
  assert.equal(r.intent, "Uncertain");
  assert.equal(r.violation, "这是一条派活消息");
  assert.equal(c.calls(), 1);
});

test("分类器返回非字符串或越界编号同样按 Uncertain 处理并记录", () => {
  for (const bad of [{ event: "E1" }, "E11", "e1", 7, null, undefined]) {
    const r = classifyInbound({ sender: user, text: "嗯" }, () => bad);
    assert.equal(r.intent, "Uncertain", `输入 ${String(bad)}`);
    assert.equal(typeof r.violation, "string");
  }
});

test("分类器返回循环对象、BigInt、toJSON 抛错的对象都封闭为 Uncertain 并记可读违规,不抛错", () => {
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;
  const evil = { toJSON() { throw new Error("toJSON 炸了"); } };
  const nested = { n: 2n, deep: { arr: [1n] } };
  for (const bad of [cycle, 1n, evil, nested, Symbol("s")]) {
    const r = classifyInbound({ sender: user, text: "嗯" }, () => bad);
    assert.equal(r.intent, "Uncertain");
    assert.equal(typeof r.violation, "string");
    assert.ok((r.violation ?? "").length > 0);
  }
  assert.match(safeDescribe(cycle), /循环/);
  assert.equal(safeDescribe(1n), "1n");
  assert.match(safeDescribe(evil), /无法序列化.*toJSON 炸了/);
  assert.match(safeDescribe(nested), /"2n"/);
});

test("分类器给出每个合法枚举都原样采用且不记违规", () => {
  for (const code of [...EVENT_CODES, "Uncertain"] as const) {
    const r = classifyInbound({ sender: user, text: "嗯" }, () => code);
    assert.equal(r.intent, code);
    assert.equal(r.violation, undefined);
  }
  assert.deepEqual([...EVENT_CODES], ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"]);
});

test("分类器抛错(含抛出无法转文字的值)时走 Uncertain 保守路径,不卡死", () => {
  const r = classifyInbound({ sender: user, text: "嗯" }, () => { throw new Error("429"); });
  assert.equal(r.intent, "Uncertain");
  assert.equal(r.via, "semantic");
  assert.match(r.violation ?? "", /429/);
  const weird = classifyInbound({ sender: user, text: "嗯" }, () => { throw { toString() { throw new Error("x"); } }; });
  assert.equal(weird.intent, "Uncertain");
  assert.equal(typeof weird.violation, "string");
});

test("@ 和控制文字之间只隔中文逗号、冒号或没有空格时,正文不被当成名字吞掉,交给分类器(RR-03 阳性埋雷)", () => {
  for (const text of ["@小秘，停止定时总结", "@小秘：改成每天 9 点", "@小秘停止定时总结", "@小秘,停一下", "@小秘…先别弄了"]) {
    const c = counting("E4");
    const r = classifyInbound({ sender: user, text, mentions: [at(text, "小秘", "xiaomi")] }, c.fn);
    assert.equal(r.via, "semantic", text);
    assert.equal(r.intent, "E4", text);
    assert.equal(c.calls(), 1, text);
    assert.deepEqual(r.anchors.mentions.map((m) => [m.id, m.start, m.end]), [["xiaomi", 0, 3]], text);
  }
});

test("多个 @ 之间只有空白才是纯点名;任一 @ 后面带了正文就交给分类器", () => {
  const pure = "@小秘 @小前  ";
  const p = counting("E4");
  const rp = classifyInbound({ sender: user, text: pure, mentions: [at(pure, "小秘", "xiaomi"), at(pure, "小前", "c-front")] }, p.fn);
  assert.equal(rp.via, "mechanical");
  assert.equal(rp.intent, "E1");
  assert.equal(p.calls(), 0);
  for (const text of ["@小秘 @小前 停止", "@小秘 停止 @小前", "@小秘，@小前"]) {
    const c = counting("E4");
    const r = classifyInbound({ sender: user, text, mentions: [at(text, "小秘", "xiaomi"), at(text, "小前", "c-front")] }, c.fn);
    assert.equal(r.via, "semantic", text);
    assert.equal(c.calls(), 1, text);
  }
});

test("点名范围和正文对不上、或名字里含标点空白,都不算锚点也不走纯点名", () => {
  const text = "@小秘，停止定时总结";
  const cases = [
    { id: "xiaomi", name: "小秘，停止定时总结", start: 0, end: text.length },
    { id: "xiaomi", name: "小秘", start: 1, end: 4 },
    { id: "xiaomi", name: "小秘", start: 0, end: 99 },
    { id: "", name: "小秘", start: 0, end: 3 },
    "xiaomi",
  ];
  for (const m of cases) {
    const c = counting("E4");
    const r = classifyInbound({ sender: user, text, mentions: [m] as never }, c.fn);
    assert.equal(r.via, "semantic", JSON.stringify(m));
    assert.deepEqual(r.anchors.mentions, [], JSON.stringify(m));
    assert.equal(c.calls(), 1);
  }
});

test("分类器抛出 message getter 会抛错、instanceof 会抛错的异常,兜底仍返回 Uncertain(RR-04 阳性埋雷)", () => {
  const badMessage = new Error("original");
  Object.defineProperty(badMessage, "message", { get() { throw new Error("message getter failed"); } });
  const badProto = new Proxy({}, { getPrototypeOf() { throw new Error("instanceof failed"); } });
  for (const thrown of [badMessage, badProto]) {
    const r = classifyInbound({ sender: user, text: "嗯" }, () => { throw thrown; });
    assert.equal(r.intent, "Uncertain");
    assert.equal(r.via, "semantic");
    assert.match(r.violation ?? "", /^classifier-threw: /);
  }
});
