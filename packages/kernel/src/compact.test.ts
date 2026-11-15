// 状态笔记压缩的纯函数(D06 第 2 小节第 3 块、D25 第 8 节):压缩材料怎么拼、撤回原文怎么从笔记里移除。
// 撤回优先(AC-08):被撤回的原文不能经状态笔记回到请求里(PR #6 第三轮审查「撤回原文仍留在压缩块进请求」在五块重拼下的对应)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMaterial, RETRACT_MIN_CHARS, scrubRetracted } from "./compact.ts";
import type { Inbound, MindAction } from "./runtime-ports.ts";

const at = "2026-11-09T02:00:00Z";
const m = (seq: number, text: string): Inbound => ({ kind: "message", roomId: "dm-1", seq, sender: { kind: "user", id: "me", name: "我" }, text, replyToSeq: null, quotedSeqs: [], mentions: [], command: null, at });

test("压缩材料:按到达顺序列出本轮新输入原文(带消息序号与发送人),再列联系人本轮每个动作的原文", () => {
  const fresh: Inbound[] = [
    m(1, "把这几个词按字母倒序排:kiwi, banana, fig"),
    { kind: "compute", roomId: "dm-1", taskId: "T-1", computeId: "cmp-1", signal: "completed", summary: "写好了 a.txt", at },
    { kind: "schedule", roomId: "dm-1", scheduleId: "s-1", prompt: "每天 8 点汇总", at },
  ];
  const actions: MindAction[] = [
    { kind: "reply", roomId: "dm-1", text: "按字母倒序:kiwi, fig, banana", replyToSeq: 1 },
    { kind: "dispatch", roomId: "dm-1", sourceSeq: 1, title: "排序", task: "把词排序" },
    { kind: "commit", roomId: "dm-1", sourceSeq: 1, text: "排好告诉你", taskId: null },
    { kind: "forward", taskId: "T-1", text: "再加一个词" },
    { kind: "deliver", taskId: "T-1", text: "a.txt 在工作目录" },
    { kind: "stop", taskId: "T-2" },
  ];
  const t = compactMaterial(fresh, actions);
  assert.equal(
    t,
    "[本轮新输入(原文)]\n" +
      `#1 · dm-1 · 我(user:me) · ${at}\n把这几个词按字母倒序排:kiwi, banana, fig\n` +
      `〔Compute cmp-1 · 任务 T-1 · completed〕 · dm-1 · ${at}\n写好了 a.txt\n` +
      `〔定时 s-1〕 · dm-1 · ${at}\n每天 8 点汇总\n` +
      "[联系人本轮动作]\n" +
      "- reply → dm-1 ↩#1:按字母倒序:kiwi, fig, banana\n" +
      "- dispatch → dm-1 #1「排序」:把词排序\n" +
      "- commit → dm-1 #1:排好告诉你\n" +
      "- forward → 任务 T-1:再加一个词\n" +
      "- deliver → 任务 T-1:a.txt 在工作目录\n" +
      "- stop → 任务 T-2\n",
  );
  assert.equal(compactMaterial([], []), "[本轮新输入(原文)]\n(无)\n[联系人本轮动作]\n(无)\n");
});

test("撤回原文从状态笔记里移除:精确命中换成占位,去空白后仍能比对到就判作废;短于下限的撤回不扫", () => {
  assert.equal(RETRACT_MIN_CHARS, 4);
  const note = "在做什么:按 #2 的要求处理 NEUTRAL_FIXTURE_NO_CREDENTIALS 那段;下一步:等确认。";
  const r = scrubRetracted(note, ["NEUTRAL_FIXTURE_NO_CREDENTIALS"]);
  assert.deepEqual(r, { text: "在做什么:按 #2 的要求处理 〔已撤回内容已移除〕 那段;下一步:等确认。", hits: 1, leaked: false });
  const multi = scrubRetracted("A 甲乙丙丁戊 B 甲乙丙丁戊", ["  甲乙丙丁戊\n"]);
  assert.deepEqual(multi, { text: "A 〔已撤回内容已移除〕 B 〔已撤回内容已移除〕", hits: 2, leaked: false });
  const spaced = scrubRetracted("备注:甲 乙丙​丁戊", ["甲乙丙丁戊"]);
  assert.deepEqual(spaced, { text: "备注:甲 乙丙​丁戊", hits: 0, leaked: true }, "去空白、零宽字符后比对得到但无法精确替换:判作废");
  const lines = scrubRetracted("第一行要点 xyz\n第二行要点 abc", ["第一行要点 xyz\n第二行要点 abc"]);
  assert.deepEqual(lines, { text: "〔已撤回内容已移除〕", hits: 1, leaked: false });
  const apart = scrubRetracted("另:第二行要点 abc;先:第一行要点 xyz", ["第一行要点 xyz\n第二行要点 abc"]);
  assert.deepEqual(apart, { text: "另:〔已撤回内容已移除〕;先:〔已撤回内容已移除〕", hits: 2, leaked: false }, "多行原文被拆开抄写:逐行移除");
  const short = scrubRetracted("好的,明天见。", ["好的"]);
  assert.deepEqual(short, { text: "好的,明天见。", hits: 0, leaked: false }, "短于 4 字的撤回原文不扫,避免误伤正常用词");
  assert.deepEqual(scrubRetracted("无关内容", ["另一段很长的撤回原文"]), { text: "无关内容", hits: 0, leaked: false });
});
