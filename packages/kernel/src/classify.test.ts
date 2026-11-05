// AC-11 先机械后语义:机械锚点(@、↩ #seq、确认卡版本号)总是机械提取;只有锚点本身能确定意图时才不调分类器。
// AC-12 分类只出固定枚举 E1..E10 或 Uncertain;非法输出(含无法序列化的)封闭为 Uncertain 并记违规。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Classifier, classifyInbound, EVENT_CODES, safeDescribe } from "./classify.ts";

const user = { kind: "user", id: "u1" } as const;
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
  const r = classifyInbound({ sender: user, text: "@小前 ", mentions: ["c-front"] }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.equal(r.intent, "E1");
  assert.deepEqual(r.anchors, { mentions: ["c-front"], quotes: [] });
  assert.equal(c.calls(), 0);
});

test("带 @ 的停止、修改、纠偏文字意图不能机械确定,交给分类器并采用其结果,锚点照样提取", () => {
  for (const [text, code] of [["@小秘 停止定时总结", "E4"], ["@小秘 改成每天 9 点", "E3"], ["@小秘 我不是让你写代码", "E5"]] as const) {
    const c = counting(code);
    const r = classifyInbound({ sender: user, text, mentions: ["xiaomi"] }, c.fn);
    assert.equal(r.via, "semantic", text);
    assert.equal(r.intent, code, text);
    assert.deepEqual(r.anchors.mentions, ["xiaomi"]);
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
  const r = classifyInbound({ sender: user, text: "@小前", mentions: ["c-front"], quotes: [3] }, c.fn);
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
