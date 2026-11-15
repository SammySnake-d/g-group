// 动向摘要的输入拼装与输出解析(U80,D21.4 第 2 步):五块怎么拼、要点怎么认、来源怎么核、按字节预算怎么截。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitLines, parseSummary, summaryRequest, SUMMARY_SYSTEM } from "./trend-summary-format.ts";

const contact = { id: "c1", name: "小记", speakingModel: "m-1", persona: "说话简短" };
const line = (seq: number, text: string, senderName = "阿明") => ({ seq, sender: { kind: "user", id: "u1" }, text, at: "2026-11-14T00:00:00.000Z", senderName });

test("五块:第 1 块是只读摘要的规矩加人设且带缓存断点,第 2 块是承诺原文,第 4 块逐条带 seq 与发言者,第 5 块写明区间与条数", () => {
  const { request, fresh } = summaryRequest({ contact, roomId: "g1", roomTitle: "研发群", fromSeqExclusive: 10, toSeqInclusive: 13, lines: [line(11, "先修登录"), line(13, "周五发版", "小安")], messageCount: 2, commitmentText: "每 2 条消息总结一次" });
  assert.deepEqual(request.blocks.map((b) => [b.block, b.label, b.cacheBreakpoint]), [[1, "固定前缀", true], [2, "承诺账本", false], [3, "状态笔记", false], [4, "新消息", false], [5, "指针与按需换入", false]]);
  assert.equal(request.blocks[0]!.text, `${SUMMARY_SYSTEM}\n\n## 你是谁\n小记\n\n## 人设\n说话简短`);
  // 规矩里这几句是给模型的硬约束:只读、只依据原文、固定格式带来源
  for (const rule of ["这一轮是只读的:不要派活、交付、下验收结论、停止任务、登记承诺或写记忆", "只依据第 4 块里的消息原文,不补充没出现的内容", "格式固定为「- 要点 [#seq #seq]」", "每条要点都要带来源"]) assert.equal(request.blocks[0]!.text.includes(rule), true, rule);
  assert.equal(request.blocks[1]!.text, "引出这次摘要的承诺:每 2 条消息总结一次");
  assert.equal(request.blocks[3]!.text, "[待总结的消息](会话 g1,原文,按先后)\n#11 · 阿明(user:u1) · 2026-11-14T00:00:00.000Z\n先修登录\n#13 · 小安(user:u1) · 2026-11-14T00:00:00.000Z\n周五发版\n");
  assert.equal(request.blocks[4]!.text, "会话:研发群(g1)\n区间:#10 之后到 #13(含),当前可见的群聊发言 2 条。\n2 条全部在第 4 块里。");
  assert.deepEqual([request.basedOnSeq, fresh.map((f) => [f.kind, f.roomId, f.seq, f.sender.name, f.text, f.replyToSeq, f.quotedSeqs, f.mentions, f.command])], [{ g1: 13 }, [["message", "g1", 11, "阿明", "先修登录", null, [], [], null], ["message", "g1", 13, "小安", "周五发版", null, [], [], null]]]);
});

test("截断如实写进第 5 块:只给了前几条、读到哪一条;没有承诺原文、没有人设时用占位", () => {
  const { request } = summaryRequest({ contact: { ...contact, persona: "" }, roomId: "g1", roomTitle: "研发群", fromSeqExclusive: 10, toSeqInclusive: 20, lines: [line(11, "一"), line(12, "二")], messageCount: 7, commitmentText: null });
  assert.equal(request.blocks[4]!.text, "会话:研发群(g1)\n区间:#10 之后到 #20(含),当前可见的群聊发言 7 条。\n输入超过上限,这次只给了前 2 条(到 #12);摘要只覆盖这一部分,宿主会如实标出没读完。");
  assert.deepEqual([request.blocks[1]!.text, request.blocks[0]!.text.endsWith("## 人设\n(未设置)"), request.basedOnSeq], ["(无)", true, { g1: 12 }]);
  // 第 4 块只有给了的那两条
  assert.equal(request.blocks[3]!.text, "[待总结的消息](会话 g1,原文,按先后)\n#11 · 阿明(user:u1) · 2026-11-14T00:00:00.000Z\n一\n#12 · 阿明(user:u1) · 2026-11-14T00:00:00.000Z\n二\n");
});

test("要点解析:只认项目符号行,来源去重升序;中文括号、逗号顿号分隔、编号列表都认;不带符号的行不算要点", () => {
  const allowed = new Set([11, 12, 13]);
  const r = parseSummary(["这段主要聊了两件事:\n- 先修登录 [#13 #11 #13]\n* 周五发版【#12,#13】\n1. 小安负责回归 [#11、#12]", "• 另一条回复里的要点 [#12]\n\n结束"], allowed);
  assert.deepEqual(r, { ok: true, items: [{ text: "先修登录", sourceSeqs: [11, 13] }, { text: "周五发版", sourceSeqs: [12, 13] }, { text: "小安负责回归", sourceSeqs: [11, 12] }, { text: "另一条回复里的要点", sourceSeqs: [12] }] });
});

test("不合格整份不要并说明原因:没带来源、来源不在读到的消息里、只有来源没有内容、一条都没有", () => {
  const allowed = new Set([11, 12]);
  assert.deepEqual(parseSummary(["- 先修登录 [#11]\n- 这条没来源"], allowed), { ok: false, reason: "有要点没带来源:这条没来源" });
  assert.deepEqual(parseSummary(["- 先修登录 [#11]\n- 编的 [#12 #99]"], allowed), { ok: false, reason: "来源 #99 不在这次读到的消息里" });
  assert.deepEqual(parseSummary(["- 来源写在中间 [#11] 后面还有话"], allowed), { ok: false, reason: "有要点没带来源:来源写在中间 [#11] 后面还有话" });
  assert.deepEqual(parseSummary(["- [#11]"], allowed), { ok: false, reason: "有要点只有来源没有内容" });
  assert.deepEqual(parseSummary(["没有项目符号的一段话 [#11]", ""], allowed), { ok: false, reason: "没有给出带来源的要点" });
  assert.deepEqual(parseSummary([], allowed), { ok: false, reason: "没有给出带来源的要点" });
});

test("上限:要点 30 条、每条 500 字、每条来源 20 个,正好到上限收下,多一个就整份不要", () => {
  const many = new Set(Array.from({ length: 40 }, (_, i) => i + 1));
  const bullets = (k: number) => Array.from({ length: k }, (_, i) => `- 要点 ${i + 1} [#${(i % 40) + 1}]`).join("\n");
  const at30 = parseSummary([bullets(30)], many);
  assert.deepEqual([at30.ok && at30.items.length, parseSummary([bullets(31)], many)], [30, { ok: false, reason: "要点超过 30 条" }]);
  const long = (k: number) => parseSummary([`- ${"长".repeat(k)} [#1]`], many);
  const at500 = long(500);
  assert.deepEqual([at500.ok && at500.items[0]!.text.length, long(501)], [500, { ok: false, reason: "有要点超过 500 字" }]);
  const cite = (k: number) => parseSummary([`- 来源很多 [${Array.from({ length: k }, (_, i) => `#${i + 1}`).join(" ")}]`], many);
  const at20 = cite(20);
  assert.deepEqual([at20.ok && at20.items[0]!.sourceSeqs.length, cite(21)], [20, { ok: false, reason: "一条要点的来源超过 20 个" }]);
});

test("按字节预算截取连续前缀:每条算正文的 UTF-8 字节加 64 字节记账;放不下的那条和它之后的都不要", () => {
  const lines = [{ text: "啊".repeat(10) }, { text: "b".repeat(30) }, { text: "c" }];
  // 第一条 30+64=94,第二条 30+64=94,第三条 1+64=65
  assert.deepEqual([fitLines(lines, 93).length, fitLines(lines, 94).length, fitLines(lines, 187).length, fitLines(lines, 188).length, fitLines(lines, 252).length, fitLines(lines, 253).length], [0, 1, 1, 2, 2, 3]);
  assert.deepEqual(fitLines(lines, 200), [lines[0], lines[1]]);
});
