// 被引用消息的确定性 Page-in 规划(D06.3 第 2–4 条;AC-06、AC-37 ③)。
// 夹具照 AC-37 ③:群 g 里 #10 是超长文本(主回复),#12、#18 是短消息,#15 已撤回;dm-x 私聊里的 #99 是别的会话的消息。
// 阳性埋雷:先到先得让超长 #10 吞掉 #12;捞出已撤回原文;放行跨会话原文;保底装不下时悄悄丢一条;切坏多字节字符。
import assert from "node:assert/strict";
import { test } from "node:test";
import { planRecall, type RecallItem, type RecallPlanInput, type RecallPlanResult, type RecallRef, type RecallSource } from "./recall.ts";

const G = "g";
const DM = "dm-x";
const LONG = `压测报告:${"数据".repeat(1000)}END-OF-REPORT`;
const S12 = "第二条:登录限流阈值 100";
const S18 = "第三条:测试服端口 8081";
const RETRACTED = "NEUTRAL_RETRACTED 不同意上线";
const OTHER = "NEUTRAL_OTHER_ROOM 私聊内容";
const LONG2 = "x".repeat(5000);
const b = (s: string) => Buffer.byteLength(s, "utf8");

const SOURCES: RecallSource[] = [
  { roomId: G, seq: 10, text: LONG, retracted: false },
  { roomId: G, seq: 12, text: S12, retracted: false },
  { roomId: G, seq: 15, text: RETRACTED, retracted: true },
  { roomId: G, seq: 18, text: S18, retracted: false },
  { roomId: G, seq: 30, text: LONG2, retracted: false },
  { roomId: DM, seq: 99, text: OTHER, retracted: false },
];
const ref = (seq: number, over: Partial<RecallRef> = {}): RecallRef => ({ fromRoomId: G, roomId: G, seq, ...over });
/** AC-37 ③ 的引用:主回复 #10,引用 #12 #15 #18,外加伪造的跨会话 #99 */
const AC37: RecallRef[] = [ref(10, { primary: true }), ref(12), ref(15), ref(18), ref(99, { roomId: DM })];
const input = (over: Partial<RecallPlanInput> = {}): RecallPlanInput => ({
  refs: AC37, readableRooms: [G, DM], sources: SOURCES, budgetBytes: 1_000_000, minSliceBytes: 64, ...over,
});
function ok(r: RecallPlanResult) {
  if (!r.ok) assert.fail(`应成功,实际失败:${r.reason} ${r.detail}`);
  return r;
}
const pick = (items: readonly RecallItem[], seq: number) => {
  const it = items.find((x) => x.seq === seq);
  assert.ok(it, `清单里应有 #${seq}`);
  return it;
};

test("预算内:主回复与各条引用逐条 Full 原文,撤回给占位,跨会话拒绝,保序", () => {
  const r = ok(planRecall(input()));
  assert.deepEqual(r.items.map((x) => [x.roomId, x.seq, x.state, x.primary]), [
    [G, 10, "Full", true],
    [G, 12, "Full", false],
    [G, 15, "DeletedOrWithdrawn", false],
    [G, 18, "Full", false],
    [DM, 99, "AccessDenied", false],
  ]);
  assert.deepEqual(pick(r.items, 10), { roomId: G, seq: 10, primary: true, state: "Full", text: LONG, bytes: b(LONG), totalBytes: b(LONG), nextCursor: null });
  assert.equal(pick(r.items, 12).text, S12);
  assert.equal(pick(r.items, 18).bytes, b(S18));
  assert.equal(r.usedBytes, b(LONG) + b(S12) + b(S18));
  assert.equal(r.budgetBytes, 1_000_000);
});

test("恰在边界:原文总字节正好等于预算时全部 Full;少 1 字节时主回复显式截成 TruncatedSlice 带游标,不是整条消失", () => {
  const exact = b(LONG) + b(S12) + b(S18);
  const at = ok(planRecall(input({ budgetBytes: exact })));
  assert.deepEqual(at.items.map((x) => x.state), ["Full", "Full", "DeletedOrWithdrawn", "Full", "AccessDenied"]);
  assert.equal(at.usedBytes, exact);

  const under = ok(planRecall(input({ budgetBytes: exact - 1 })));
  const ten = pick(under.items, 10);
  assert.equal(ten.state, "TruncatedSlice");
  assert.equal(ten.text, LONG.slice(0, LONG.length - 1));
  assert.equal(ten.bytes, b(LONG) - 1);
  assert.equal(ten.totalBytes, b(LONG));
  assert.deepEqual(ten.nextCursor, { offset: LONG.length - 1, remainingBytes: 1 });
  assert.deepEqual([pick(under.items, 12).state, pick(under.items, 18).state], ["Full", "Full"]);
  assert.equal(under.usedBytes, exact - 1);
});

test("首条超长耗尽预算(阳性埋雷:先到先得会把第 12、18 条挤掉):第 10 条截断带原长与续读游标,第 12、18 条仍是 Full 原文", () => {
  const r = ok(planRecall(input({ budgetBytes: 300 })));
  const ten = pick(r.items, 10);
  assert.equal(ten.state, "TruncatedSlice");
  assert.equal(ten.bytes, 300 - b(S12) - b(S18));
  assert.equal(ten.text, LONG.slice(0, 80));
  assert.equal(ten.totalBytes, b(LONG));
  assert.deepEqual(ten.nextCursor, { offset: 80, remainingBytes: b(LONG) - ten.bytes });
  assert.deepEqual(pick(r.items, 12), { roomId: G, seq: 12, primary: false, state: "Full", text: S12, bytes: b(S12), totalBytes: b(S12), nextCursor: null });
  assert.deepEqual(pick(r.items, 18), { roomId: G, seq: 18, primary: false, state: "Full", text: S18, bytes: b(S18), totalBytes: b(S18), nextCursor: null });
  assert.equal(r.usedBytes, 300);
});

test("主回复优先补满:主回复超长时其余超长引用只拿保底切片,保底切片也显式带游标", () => {
  const r = ok(planRecall(input({ refs: [ref(12), ref(10, { primary: true }), ref(30)], budgetBytes: 601 })));
  assert.deepEqual(r.items.map((x) => [x.seq, x.state]), [[12, "Full"], [10, "TruncatedSlice"], [30, "TruncatedSlice"]]);
  const ten = pick(r.items, 10);
  assert.equal(ten.bytes, 505);
  assert.equal(ten.text, LONG.slice(0, 169));
  const thirty = pick(r.items, 30);
  assert.equal(thirty.text, "x".repeat(64));
  assert.deepEqual(thirty.nextCursor, { offset: 64, remainingBytes: 5000 - 64 });
  assert.equal(r.usedBytes, 601);
});

test("非主回复的多条超长引用按序均分剩余预算(公平切片),主回复短时先拿满", () => {
  const r = ok(planRecall(input({ refs: [ref(10), ref(12, { primary: true }), ref(30)], budgetBytes: 604 })));
  assert.equal(pick(r.items, 12).state, "Full");
  const ten = pick(r.items, 10);
  const thirty = pick(r.items, 30);
  assert.deepEqual([ten.state, ten.bytes, thirty.state, thirty.bytes], ["TruncatedSlice", 286, "TruncatedSlice", 286]);
  assert.equal(ten.text, LONG.slice(0, 96));
  assert.equal(thirty.text, "x".repeat(286));
  assert.equal(r.usedBytes, 604);
});

test("已撤回只给 DeletedOrWithdrawn 占位(阳性埋雷:捞出撤回原文):不带原文、不报原长、不给游标", () => {
  const r = ok(planRecall(input({ refs: [ref(15)] })));
  assert.deepEqual(r.items, [{ roomId: G, seq: 15, primary: false, state: "DeletedOrWithdrawn", text: "", bytes: 0, totalBytes: null, nextCursor: null }]);
  assert.equal(r.usedBytes, 0);
  assert.ok(!JSON.stringify(r).includes("NEUTRAL_RETRACTED"), "结果里不能出现撤回原文");
});

test("越权引用机械拒绝(阳性埋雷:放行跨会话原文):别的会话、非成员会话、本会话没有的 seq 都是 AccessDenied 且不带原文", () => {
  const cross = ok(planRecall(input({ refs: [ref(99, { roomId: DM })] })));
  assert.deepEqual(cross.items, [{ roomId: DM, seq: 99, primary: false, state: "AccessDenied", text: "", bytes: 0, totalBytes: null, nextCursor: null }]);
  assert.ok(!JSON.stringify(cross).includes("NEUTRAL_OTHER_ROOM"), "跨会话原文不能出现在结果里");

  const notMember = ok(planRecall(input({ refs: [ref(99, { fromRoomId: DM, roomId: DM })], readableRooms: [G] })));
  assert.equal(notMember.items[0]!.state, "AccessDenied");
  const missing = ok(planRecall(input({ refs: [ref(77)] })));
  assert.equal(missing.items[0]!.state, "AccessDenied");
  const retractedElsewhere = ok(planRecall(input({ refs: [ref(15, { fromRoomId: DM })] })));
  assert.equal(retractedElsewhere.items[0]!.state, "AccessDenied", "跨会话引用先判权限,不透露那边是否撤回");

  // 阴性对照:同一会话内、联系人是成员 → 正常换入
  const own = ok(planRecall(input({ refs: [ref(99, { fromRoomId: DM, roomId: DM })] })));
  assert.deepEqual([own.items[0]!.state, own.items[0]!.text], ["Full", OTHER]);
});

test("保底切片都装不下时显式失败 over-budget 并说明需要多少,不悄悄丢掉任何一条;占位不占预算", () => {
  const r = planRecall(input({ budgetBytes: 100 }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "over-budget");
  if (r.reason !== "over-budget") return;
  assert.deepEqual([r.need, r.budget, r.quotes], [64 + b(S12) + b(S18), 100, 3]);
  assert.match(r.detail, /126/);
  assert.match(r.detail, /100/);
  // 阴性对照:同样三条有效引用,预算刚好等于保底合计 → 成功
  const fits = ok(planRecall(input({ budgetBytes: 126 })));
  assert.deepEqual(fits.items.map((x) => [x.seq, x.state, x.bytes]), [[10, "TruncatedSlice", 64], [12, "Full", b(S12)], [15, "DeletedOrWithdrawn", 0], [18, "Full", b(S18)], [99, "AccessDenied", 0]]);
});

test("切片按字符边界切:多字节字符不切坏,切片字节不超过分到的预算,游标指向未读部分开头", () => {
  const emoji = "😀".repeat(10);
  const r = ok(planRecall(input({ refs: [ref(1)], sources: [{ roomId: G, seq: 1, text: emoji, retracted: false }], budgetBytes: 10, minSliceBytes: 10 })));
  assert.deepEqual(r.items[0], { roomId: G, seq: 1, primary: false, state: "TruncatedSlice", text: "😀😀", bytes: 8, totalBytes: 40, nextCursor: { offset: 4, remainingBytes: 32 } });
  assert.equal(r.usedBytes, 8);
});

test("重复引用保序去重,重复项里有一次是主回复就按主回复算", () => {
  const r = ok(planRecall(input({ refs: [ref(12), ref(18), ref(12, { primary: true }), ref(18)] })));
  assert.deepEqual(r.items.map((x) => [x.seq, x.primary]), [[12, true], [18, false]]);
  assert.equal(r.usedBytes, b(S12) + b(S18));
});

test("输入不合格返回 invalid-input,不抛错;同样输入逐字节同样输出,结果冻结", () => {
  const bad: unknown[] = [
    null,
    { ...input(), refs: "10" },
    { ...input(), refs: [{ fromRoomId: G, roomId: G, seq: 0 }] },
    { ...input(), refs: [{ fromRoomId: G, roomId: G, seq: 1.5 }] },
    { ...input(), refs: [{ fromRoomId: "", roomId: G, seq: 1 }] },
    { ...input(), refs: [{ fromRoomId: G, roomId: G, seq: 1, primary: "yes" }] },
    { ...input(), budgetBytes: -1 },
    { ...input(), minSliceBytes: 0.5 },
    { ...input(), readableRooms: [1] },
    { ...input(), sources: [{ roomId: G, seq: 1, text: 1, retracted: false }] },
    { ...input(), sources: [{ roomId: G, seq: 1, text: "a", retracted: false }, { roomId: G, seq: 1, text: "b", retracted: false }] },
    { ...input(), get budgetBytes() { return 10; } },
  ];
  for (const x of bad) {
    const r = planRecall(x as RecallPlanInput);
    assert.equal(r.ok, false, `应拒绝:${JSON.stringify(x)?.slice(0, 80)}`);
    if (!r.ok) assert.equal(r.reason, "invalid-input");
  }
  const one = ok(planRecall(input({ budgetBytes: 300 })));
  const two = ok(planRecall(input({ budgetBytes: 300 })));
  assert.deepEqual(one, two);
  assert.ok(Object.isFrozen(one) && Object.isFrozen(one.items) && Object.isFrozen(one.items[0]) && Object.isFrozen(one.items[0]!.nextCursor));
  assert.deepEqual(ok(planRecall(input({ refs: [] }))).items, []);
});
