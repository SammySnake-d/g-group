// AC-11 先机械后语义:有 @、↩ #seq、版本号可判定时不调分类器。AC-12 分类只出固定枚举 E1..E10 或 Uncertain。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Classifier, classifyInbound, EVENT_CODES } from "./classify.ts";

function counting(answer: unknown): { fn: Classifier; calls: () => number } {
  let n = 0;
  return { fn: () => { n++; return answer; }, calls: () => n };
}

test("带 @ 提及时机械判定,分类器调用 0 次", () => {
  const c = counting("E1");
  const r = classifyInbound({ text: "@小前 看下登录页", mentions: ["c-front"] }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.deepEqual(r.cues, ["mention"]);
  assert.equal(r.event, "E1");
  assert.equal(c.calls(), 0);
});

test("带 ↩ 引用旧消息时机械判定,分类器调用 0 次", () => {
  const c = counting("E1");
  const r = classifyInbound({ text: "这个结论还成立吗", quotes: [12] }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.deepEqual(r.cues, ["quote"]);
  assert.equal(c.calls(), 0);
});

test("带确认卡版本号时机械判定为 E6 人类回复,分类器调用 0 次", () => {
  const c = counting("E1");
  const r = classifyInbound({ text: "同意", version: 3 }, c.fn);
  assert.equal(r.via, "mechanical");
  assert.equal(r.event, "E6");
  assert.deepEqual(r.cues, ["version"]);
  assert.equal(c.calls(), 0);
});

test("同一句话去掉全部机械线索才调分类器,恰好 1 次(阴性对照)", () => {
  const c = counting("E3");
  const r = classifyInbound({ text: "@小前 看下登录页", mentions: [] }, c.fn);
  assert.equal(r.via, "semantic");
  assert.equal(r.event, "E3");
  assert.deepEqual(r.cues, []);
  assert.equal(c.calls(), 1);
});

test("分类器返回自由文本按 Uncertain 处理并记录违规原值(阳性埋雷)", () => {
  const c = counting("这是一条派活消息");
  const r = classifyInbound({ text: "帮我把数据导一下" }, c.fn);
  assert.equal(r.event, "Uncertain");
  assert.equal(r.violation, "这是一条派活消息");
  assert.equal(c.calls(), 1);
});

test("分类器返回非字符串或越界编号同样按 Uncertain 处理并记录", () => {
  for (const bad of [{ event: "E1" }, "E11", "e1", 7, null]) {
    const r = classifyInbound({ text: "嗯" }, () => bad);
    assert.equal(r.event, "Uncertain", `输入 ${JSON.stringify(bad)}`);
    assert.equal(typeof r.violation, "string");
  }
});

test("分类器给出每个合法枚举都原样采用且不记违规", () => {
  for (const code of [...EVENT_CODES, "Uncertain"] as const) {
    const r = classifyInbound({ text: "嗯" }, () => code);
    assert.equal(r.event, code);
    assert.equal(r.violation, undefined);
  }
  assert.deepEqual([...EVENT_CODES], ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"]);
});

test("分类器抛错时走 Uncertain 保守路径,不卡死", () => {
  const r = classifyInbound({ text: "嗯" }, () => { throw new Error("429"); });
  assert.equal(r.event, "Uncertain");
  assert.equal(r.via, "semantic");
  assert.match(r.violation ?? "", /429/);
});
