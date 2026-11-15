// 联系人状态笔记与压缩(需求文档 D06 第 2 小节第 3 块、D25 第 8 节、D23 第 9 节;AC-32 ③ 的调用方、AC-08 撤回优先)。
// 联系人本轮没写状态笔记时宿主用同一说话模型补写;超上限缩写;撤回原文不经状态笔记回到请求。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type ContactCompactor, type RoundInput, STATE_NOTE_GUIDE } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-note-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `n${++fileNo}.db`);
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const texts = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.map((m) => `${m.sender.kind}:${m.text}`);

type CompactCall = Parameters<ContactCompactor["compact"]>[0];
const silentMind = (onRound?: (i: RoundInput) => void, note: (i: RoundInput) => string | null = () => null) => () => ({
  async round(i: RoundInput) {
    onRound?.(i);
    const m = i.fresh.find((f) => f.kind === "message");
    const actions = m?.kind === "message" ? [{ kind: "reply" as const, roomId: m.roomId, text: `回:${m.text}`, replyToSeq: m.seq }] : [];
    return { actions, stateNote: note(i) };
  },
});

test("联系人本轮没写状态笔记:宿主用它的说话模型做一次独立压缩,材料是本轮新消息原文与联系人动作,下一轮第 3 块就是压缩结果", async () => {
  const reqs: RoundInput["request"][] = [];
  const calls: CompactCall[] = [];
  const host = new Host({
    file: file(), maxDeferMs: 5, mind: silentMind((i) => reqs.push(i.request)),
    compactor: () => ({ async compact(r: CompactCall) { calls.push(r); return `笔记${calls.length}:在排 kiwi, banana, fig`; } }),
  });
  const c = host.createContact({ name: "小克", speakingModel: "model-x" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "把这几个词按字母倒序排:kiwi, banana, fig" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "2", text: "等下,改成按长度排" });
  await settle(host);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.contact.speakingModel, "model-x", "用联系人的说话模型");
  assert.equal(calls[0]!.kind, "round-note");
  assert.equal(calls[0]!.previous, null);
  assert.match(calls[0]!.material, /把这几个词按字母倒序排:kiwi, banana, fig/);
  assert.match(calls[0]!.material, /- reply → .* ↩#1:回:把这几个词/);
  assert.equal(calls[1]!.previous, "笔记1:在排 kiwi, banana, fig");
  assert.equal(reqs[1]!.blocks[2]!.text, "[状态笔记 v1]\n笔记1:在排 kiwi, banana, fig\n", "第二轮第 3 块是第一轮的压缩结果");
  assert.equal(host.stateNote(c.id), "笔记2:在排 kiwi, banana, fig", "第二轮的压缩结果落盘");
  await host.close();
});

test("模型自己写了状态笔记就不压缩;压缩失败保留旧笔记并报告,本轮回复照常落盘", async () => {
  const calls: CompactCall[] = [];
  const reports: [string, unknown][] = [];
  let fail = false;
  const host = new Host({
    file: file(), maxDeferMs: 5, onReport: (w, d) => reports.push([w, d]),
    mind: silentMind(undefined, (i) => (i.fresh.some((f) => f.kind === "message" && f.text === "自己写") ? "模型自己写的笔记" : null)),
    compactor: () => ({ async compact(r: CompactCall) { calls.push(r); if (fail) throw new Error("上游 500"); return "压缩出的笔记"; } }),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "自己写" });
  await settle(host);
  assert.equal(calls.length, 0, "模型写了笔记就不压缩");
  assert.equal(host.stateNote(c.id), "模型自己写的笔记");
  fail = true;
  host.send({ roomId: dm.id, clientActionId: "2", text: "这轮不写" });
  await settle(host);
  assert.equal(calls.length, 1);
  assert.equal(host.stateNote(c.id), "模型自己写的笔记", "压缩失败保留旧笔记");
  assert.ok(reports.some(([w, d]) => w === "compact-failed" && /上游 500/.test(JSON.stringify(d))));
  assert.ok(texts(host, dm.id).includes("contact:回:这轮不写"), "本轮回复照常发出");
  await host.close();
});

test("状态笔记超过上限:请压缩器按上限缩写;缩写后仍超就保留原文并报告,不截断", async () => {
  const calls: CompactCall[] = [];
  const reports: string[] = [];
  let shrinkTo = "短笔记";
  const host = new Host({
    file: file(), maxDeferMs: 5, stateNoteMaxBytes: 30, onReport: (w) => reports.push(w),
    mind: silentMind(undefined, () => "很长的笔记".repeat(10)),
    compactor: () => ({ async compact(r: CompactCall) { calls.push(r); return shrinkTo; } }),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "一" });
  await settle(host);
  assert.deepEqual(calls.map((x) => [x.kind, x.previous, x.maxBytes]), [["shrink", "很长的笔记".repeat(10), 30]]);
  assert.equal(host.stateNote(c.id), "短笔记");
  shrinkTo = "仍然很长的笔记".repeat(5);
  host.send({ roomId: dm.id, clientActionId: "2", text: "二" });
  await settle(host);
  assert.equal(host.stateNote(c.id), "仍然很长的笔记".repeat(5), "缩写后仍超:保留,不截断");
  assert.ok(reports.includes("state-note-over-limit"));
  shrinkTo = "反而更长".repeat(100);
  host.send({ roomId: dm.id, clientActionId: "3", text: "三" });
  await settle(host);
  assert.equal(host.stateNote(c.id), "很长的笔记".repeat(10), "缩写结果比原笔记还长:保留模型原笔记");
  await host.close();
});

test("撤回的消息原文不经状态笔记回到请求:笔记里的撤回原文换成占位;去空白后仍比对得到就作废整份笔记", async () => {
  const reqs: RoundInput["request"][] = [];
  const reports: string[] = [];
  let note = "";
  const host = new Host({ file: file(), maxDeferMs: 5, onReport: (w) => reports.push(w), mind: silentMind((i) => reqs.push(i.request), () => note || null) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  note = "在做:记下 NEUTRAL_FIXTURE_NO_CREDENTIALS 这段别外传;下一步:等确认";
  const secret = host.send({ roomId: dm.id, clientActionId: "1", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 这段别外传" });
  await settle(host);
  host.retractMessage(dm.id, secret.seq);
  await settle(host);
  assert.doesNotMatch(host.stateNote(c.id) ?? "", /NEUTRAL_FIXTURE/, "撤回这一轮模型又交回含原文的笔记:落盘前就移除");
  note = "";
  host.send({ roomId: dm.id, clientActionId: "2", text: "继续" });
  await settle(host);
  const b3 = reqs.at(-1)!.blocks[2]!.text;
  assert.doesNotMatch(b3, /NEUTRAL_FIXTURE/);
  assert.match(b3, /〔已撤回内容已移除〕/);
  assert.ok(reports.includes("state-note-scrubbed"));
  const host2 = new Host({ file: file(), maxDeferMs: 5, onReport: (w) => reports.push(w), mind: silentMind((i) => reqs.push(i.request), () => note || null) });
  const c2 = host2.createContact({ name: "小克" });
  const dm2 = host2.openDm(c2.id);
  note = "记下:甲乙 丙丁戊己庚";
  const s2 = host2.send({ roomId: dm2.id, clientActionId: "1", text: "甲乙丙丁戊己庚" });
  await settle(host2);
  host2.retractMessage(dm2.id, s2.seq);
  note = "";
  await settle(host2);
  host2.send({ roomId: dm2.id, clientActionId: "2", text: "继续" });
  await settle(host2);
  const v = reqs.at(-1)!.blocks[2]!.text;
  assert.doesNotMatch(v.replace(/\s/g, ""), /甲乙丙丁戊己庚/);
  assert.match(v, /已作废/);
  assert.ok(reports.includes("state-note-voided"));
  await host2.close();
  await host.close();
});

test("固定前缀的工具声明列出 update_state_note,系统提示带状态笔记写法", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ file: file(), mind: () => scriptedMind({ onRound: (i: RoundInput) => reqs.push(i.request) }), maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "你好" });
  await settle(host);
  const b1 = reqs[0]!.blocks[0]!.text;
  assert.match(b1, /update_state_note\(note\)/);
  assert.ok(b1.includes(STATE_NOTE_GUIDE));
  await host.close();
});

test("撤回前编辑过的稿也不经状态笔记回到请求:编辑稿与原稿都从笔记里移除", async () => {
  const reqs: RoundInput["request"][] = [];
  let note = "";
  const host = new Host({ file: file(), maxDeferMs: 5, mind: silentMind((i) => reqs.push(i.request), () => note || null) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  note = "原稿要点:第一版说法甲乙丙";
  const m = host.send({ roomId: dm.id, clientActionId: "1", text: "第一版说法甲乙丙" });
  await settle(host);
  note = "原稿要点:第一版说法甲乙丙;编辑后:第二版说法丁戊己";
  host.editMessage(dm.id, m.seq, "第二版说法丁戊己");
  await settle(host);
  note = "";
  host.retractMessage(dm.id, m.seq);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "2", text: "继续" });
  await settle(host);
  const b3 = reqs.at(-1)!.blocks[2]!.text;
  assert.doesNotMatch(b3, /第一版说法甲乙丙/);
  assert.doesNotMatch(b3, /第二版说法丁戊己/);
  assert.match(b3, /原稿要点:〔已撤回内容已移除〕;编辑后:〔已撤回内容已移除〕/);
  assert.equal(host.stateNote(c.id), "原稿要点:〔已撤回内容已移除〕;编辑后:〔已撤回内容已移除〕", "落盘的笔记也已移除");
  await host.close();
});
