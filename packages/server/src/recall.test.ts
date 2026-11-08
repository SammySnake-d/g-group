// 宿主一侧的引用召回与整轮超预算(D06.3、D06 §2;AC-06、AC-37 ③)。
// AC-37 ③:@Claude Code 处理一条「回复 #10 + 引用 #12 #15 #18」的消息时,第 5 块按逐条召回清单换入:超长 #10 显式截断带游标,
//          #12 #18 全文不被挤掉,已撤回 #15 只给占位,数据层伪造的跨会话引用 AccessDenied;装配清单经 onReport("recall") 可观测。
// AC-06:引用窗口内的消息不 Page-in(阴性对照);整轮超预算显式失败——会话里出失败卡说明超了多少,不截断、不吞、游标不推进,
//        不在后台无限重跑;跳过/重试由用户显式点。
// 被引用原文里的旧 @ 与指令只当数据换入第 5 块,不当本轮控制指令。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactView } from "@g-group/api-contract";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { one, run } from "./db.ts";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-recall-"));
const hosts: Host[] = [];
// 测试失败时也要关掉宿主(停注意循环的计时器),再删临时目录
after(async () => {
  for (const h of hosts) await h.close();
  rmSync(dir, { recursive: true, force: true });
});
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);

const LONG = `压测报告:${"数据".repeat(1000)}END-OF-REPORT`;
const S12 = "第二条:登录限流阈值 100";
const S18 = "第三条:测试服端口 8081";
const RETRACTED = "NEUTRAL_RETRACTED 不同意上线";
const OTHER = "NEUTRAL_OTHER_ROOM 私聊内容";
const b = (s: string) => Buffer.byteLength(s, "utf8");

type Reports = { what: string; detail: unknown }[];
type RecallReport = { contactId: string; items: { roomId: string; seq: number; state: string; bytes: number; totalBytes: number | null; nextCursor: { offset: number; remainingBytes: number } | null }[] };

/** 记录每位联系人每轮输入的脑子;script 按联系人名字给动作 */
function recorder(script: Record<string, (input: RoundInput) => MindAction[]> = {}) {
  const inputs = new Map<string, RoundInput[]>();
  const mind = (c: ContactView): ContactMind => ({
    async round(input) {
      inputs.set(c.id, [...(inputs.get(c.id) ?? []), input]);
      return { actions: script[c.name]?.(input) ?? [], stateNote: null };
    },
  });
  return { mind, inputs, last: (id: string) => inputs.get(id)?.at(-1) };
}
/** 宿主选项:默认短攒批,报告收进 reports */
const opts = (reports: Reports, over: Partial<HostOptions> & Pick<HostOptions, "mind">): HostOptions => ({ file: file(), maxDeferMs: 5, onReport: (what, detail) => reports.push({ what, detail }), ...over });
/** 登记宿主,测试结束(含失败)统一关闭 */
const track = (h: Host) => {
  hosts.push(h);
  return h;
};
async function settle(host: Host) {
  for (let i = 0; i < 100; i++) {
    // 有界等待:宿主若在后台反复重跑,idle 永远不来,这里按超时继续判断,最后报错而不是挂住
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 50))]);
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const block = (input: RoundInput | undefined, n: number) => input?.request.blocks.find((x) => x.block === n)?.text ?? "";
const wholeRequest = (input: RoundInput | undefined) => input?.request.blocks.map((x) => x.text).join("\n") ?? "";
const recallOf = (reports: Reports, contactId: string) =>
  reports.filter((r) => r.what === "recall" && (r.detail as RecallReport).contactId === contactId).map((r) => r.detail as RecallReport);
const failureCards = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.filter((m) => m.card?.kind === "failure");
const cursorOf = (host: Host, contactId: string, roomId: string) =>
  one<{ processed_seq: number }>(host.db, "SELECT processed_seq FROM gg_cursor WHERE contact_id = ? AND room_id = ?", contactId, roomId)?.processed_seq ?? 0;

test("AC-37 ③ 回复超长第 10 条 + 引用第 12/15/18 条:第 5 块里第 10 条显式截断带游标,第 12、18 条全文不被挤掉,撤回的第 15 条只给占位,清单可观测", async () => {
  const rec = recorder({ "Claude Code": (input) => input.fresh.flatMap((f) => (f.kind === "message" && f.text === "请发压测报告" ? [{ kind: "reply" as const, roomId: f.roomId, text: LONG, replyToSeq: null }] : [])) });
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, recallBudgetBytes: 300, recallMinSliceBytes: 64 })));
  const cc = host.createContact({ name: "Claude Code" });
  const argon = host.createContact({ name: "Argon" });
  const g = host.createGroup("压测群", [{ kind: "contact", id: cc.id }, { kind: "contact", id: argon.id }]);
  host.send({ roomId: g.id, clientActionId: "u0", text: "请发压测报告", mentions: [{ id: cc.id, source: "manual" }] });
  await settle(host);
  const ten = host.listMessages(g.id, {}).messages.find((m) => m.text === LONG)!.seq;
  const twelve = host.send({ roomId: g.id, clientActionId: "u12", text: S12 }).seq;
  const fifteen = host.send({ roomId: g.id, clientActionId: "u15", text: RETRACTED }).seq;
  host.retractMessage(g.id, fifteen);
  const eighteen = host.send({ roomId: g.id, clientActionId: "u18", text: S18 }).seq;
  await settle(host);

  const twenty = host.send({ roomId: g.id, clientActionId: "u20", text: "按这几条改", replyToSeq: ten, quotedSeqs: [ten, twelve, fifteen, eighteen], mentions: [{ id: cc.id, source: "auto" }] });
  await settle(host);
  const input = rec.inputs.get(cc.id)!.find((i) => i.fresh.some((f) => f.kind === "message" && f.seq === twenty.seq));
  assert.ok(input, "Claude Code 处理了 #20");
  const report = recallOf(reports, cc.id).at(-1)!;
  assert.deepEqual(report.items.map((x) => [x.roomId, x.seq, x.state, x.bytes, x.totalBytes]), [
    [g.id, ten, "TruncatedSlice", 300 - b(S12) - b(S18), b(LONG)],
    [g.id, twelve, "Full", b(S12), b(S12)],
    [g.id, fifteen, "DeletedOrWithdrawn", 0, null],
    [g.id, eighteen, "Full", b(S18), b(S18)],
  ]);
  assert.deepEqual(report.items[0]!.nextCursor, { offset: 80, remainingBytes: b(LONG) - (300 - b(S12) - b(S18)) });
  const five = block(input, 5);
  assert.ok(five.includes(LONG.slice(0, 80)), "超长 #10 换入头部切片");
  assert.match(five, /offset=80/, "截断显式带续读游标");
  assert.ok(five.includes(S12) && five.includes(S18), "#12 #18 全文都在,没被 #10 挤掉");
  assert.match(five, /DeletedOrWithdrawn/, "撤回的 #15 有占位");
  const all = wholeRequest(input);
  assert.ok(!all.includes(LONG.slice(0, 81)), "超出预算的部分不进请求");
  assert.ok(!all.includes("NEUTRAL_RETRACTED"), "撤回原文不进请求的任何一块");
});

test("越权两道拒绝(AC-37 的跨会话第 99 条):messages.send 引用本会话没有的 seq 直接 invalid_params 不入库;数据层伪造的跨会话引用在装配时 AccessDenied 且不带原文", async () => {
  const rec = recorder();
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, maxDeferMs: 40 })));
  const cc = host.createContact({ name: "Claude Code" });
  const dm = host.openDm(cc.id);
  for (let i = 1; i <= 4; i++) host.send({ roomId: dm.id, clientActionId: `d${i}`, text: `私聊第 ${i} 条` });
  const secret = host.send({ roomId: dm.id, clientActionId: "d5", text: OTHER }).seq;
  const g = host.createGroup("群", [{ kind: "contact", id: cc.id }]);
  const first = host.send({ roomId: g.id, clientActionId: "g1", text: "群里第一条" }).seq;
  await settle(host);

  const svc = createService(host);
  const refused = await svc.handle("messages.send", { roomId: g.id, clientActionId: "g-bad", text: "看下私聊那条", quotedSeqs: [secret] });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "invalid_params", "第一道:发送侧机械拒绝");
  assert.equal(host.listMessages(g.id, {}).messages.length, 1, "被拒的消息不入库");

  const sent = host.send({ roomId: g.id, clientActionId: "g2", text: "看下这几条", quotedSeqs: [first] });
  run(host.db, "UPDATE gg_msg SET quoted = ? WHERE room_id = ? AND seq = ?", JSON.stringify([first, secret]), g.id, sent.seq);
  await settle(host);
  const input = rec.inputs.get(cc.id)!.find((i) => i.fresh.some((f) => f.kind === "message" && f.roomId === g.id && f.seq === sent.seq));
  assert.ok(input);
  const report = recallOf(reports, cc.id).at(-1)!;
  assert.deepEqual(report.items.map((x) => [x.roomId, x.seq, x.state, x.bytes]), [
    [g.id, first, "Full", b("群里第一条")],
    [g.id, secret, "AccessDenied", 0],
  ]);
  assert.match(block(input, 5), /AccessDenied/);
  assert.ok(!wholeRequest(input).includes("NEUTRAL_OTHER_ROOM"), "第二道:别的会话的原文不进请求");
});

test("AC-06 阴性对照:同一批里被引用的消息已在第 4 块,不触发 Page-in;清单为空", async () => {
  const rec = recorder();
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, maxDeferMs: 40 })));
  const cc = host.createContact({ name: "Claude Code" });
  const g = host.createGroup("群", [{ kind: "contact", id: cc.id }]);
  const a = host.send({ roomId: g.id, clientActionId: "a", text: "窗口内第一条 A" }).seq;
  host.send({ roomId: g.id, clientActionId: "b", text: "接着上条说", quotedSeqs: [a] });
  await settle(host);
  const input = rec.last(cc.id);
  assert.equal(input?.fresh.length, 2, "两条在同一批");
  assert.ok(block(input, 4).includes("窗口内第一条 A"));
  assert.ok(!block(input, 5).includes("窗口内第一条 A"), "第 5 块不重复换入窗口内消息");
  assert.deepEqual(recallOf(reports, cc.id).at(-1)?.items, []);
});

test("AC-06 整轮超预算显式失败:会话里出失败卡说明超出多少字节,不调模型、不截断、游标不推进,不在后台反复重跑;同一批再来消息只更新这张卡", async () => {
  const rec = recorder();
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, roundBudgetBytes: 4000 })));
  const cc = host.createContact({ name: "Claude Code" });
  const dm = host.openDm(cc.id);
  const big = host.send({ roomId: dm.id, clientActionId: "big", text: "大".repeat(2000) }).seq;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host.loop.busy(), false, "失败后没有挂退避重跑");
  assert.equal(host.loop.rounds(cc.id), 1);
  assert.equal(rec.inputs.get(cc.id), undefined, "超预算不调模型,也没有截断后硬发");
  const [card] = failureCards(host, dm.id);
  assert.ok(card, "会话里有失败卡");
  assert.equal(card.sender.id, cc.id);
  assert.equal(card.card!.state, "open");
  assert.match(card.card!.title, /超预算/);
  assert.match(card.card!.body, /预算 4000 字节/);
  assert.match(card.card!.body, /超出 \d+ 字节/);
  assert.match(card.card!.body, /分批/);
  assert.deepEqual(card.card!.actions.map((x) => x.actionId), ["retry", "skip"]);
  assert.equal(cursorOf(host, cc.id, dm.id), 0, "游标不推进,输入还在");
  assert.equal(host.contactView(host.contactDoc(cc.id).value).activity, "blocked");
  const failed = reports.filter((r) => r.what === "round-failed");
  assert.equal(failed.length, 1);
  assert.equal((failed[0]!.detail as { reason: string }).reason, "over-budget");

  host.send({ roomId: dm.id, clientActionId: "more", text: "补一句" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host.loop.rounds(cc.id), 2, "新输入来了才再试一次");
  assert.equal(host.loop.busy(), false);
  assert.equal(failureCards(host, dm.id).length, 1, "不重复出卡");
  assert.ok(big < card.seq);
});

test("失败卡「跳过本轮」由用户显式点才推进游标,下一轮只处理跳过之后的消息;「重试」把这批重新交给联系人", async () => {
  const rec = recorder();
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, roundBudgetBytes: 4000 })));
  const cc = host.createContact({ name: "Claude Code" });
  const dm = host.openDm(cc.id);
  host.send({ roomId: dm.id, clientActionId: "big", text: "大".repeat(2000) });
  await settle(host);
  const more = host.send({ roomId: dm.id, clientActionId: "more", text: "补一句" }).seq;
  await settle(host);
  const [card] = failureCards(host, dm.id);
  const skip = host.cardAct({ roomId: dm.id, seq: card!.seq, cardId: card!.card!.cardId, actionId: "skip", clientActionId: "s1" });
  await settle(host);
  assert.equal(skip.text, "跳过本轮");
  const input = rec.last(cc.id);
  assert.ok(input, "跳过后联系人跑了一轮");
  assert.deepEqual(input.fresh.map((f) => (f.kind === "message" ? f.seq : -1)), [skip.seq], "只处理跳过之后的消息");
  assert.ok(cursorOf(host, cc.id, dm.id) >= skip.seq);
  assert.ok(more < skip.seq);
  assert.equal(failureCards(host, dm.id)[0]!.card!.state, "done");
  assert.equal(host.contactView(host.contactDoc(cc.id).value).activity, "idle");

  const rec2 = recorder();
  const reports2: Reports = [];
  const h2 = track(new Host(opts(reports2, { mind: rec2.mind, roundBudgetBytes: 4000 })));
  const c2 = h2.createContact({ name: "Claude Code" });
  const dm2 = h2.openDm(c2.id);
  h2.send({ roomId: dm2.id, clientActionId: "big", text: "大".repeat(2000) });
  await settle(h2);
  const [c2card] = failureCards(h2, dm2.id);
  h2.cardAct({ roomId: dm2.id, seq: c2card!.seq, cardId: c2card!.card!.cardId, actionId: "retry", clientActionId: "r1" });
  await settle(h2);
  assert.equal(h2.loop.rounds(c2.id), 2, "点重试才再跑一轮");
  const cards = failureCards(h2, dm2.id);
  assert.deepEqual(cards.map((m) => m.card!.state), ["done", "open"], "还是超预算就再出一张卡,旧卡收口");
  assert.equal(h2.loop.busy(), false);
});

test("被引用原文里的旧 @ 与 /stop 只当数据换入第 5 块:不唤醒被提到的联系人、不改新消息的 mentions 与命令", async () => {
  const rec = recorder({ "Claude Code": (input) => input.fresh.flatMap((f) => (f.kind === "message" && f.mentions.length ? [{ kind: "reply" as const, roomId: f.roomId, text: "在", replyToSeq: f.seq }] : [])) });
  const reports: Reports = [];
  const host = track(new Host(opts(reports, { mind: rec.mind, maxDeferMs: 40 })));
  const cc = host.createContact({ name: "Claude Code" });
  const argon = host.createContact({ name: "Argon" });
  const g = host.createGroup("群", [{ kind: "contact", id: cc.id }, { kind: "contact", id: argon.id }]);
  const old = host.send({ roomId: g.id, clientActionId: "o", text: `@${argon.id} /stop 全部停下` }).seq;
  host.send({ roomId: g.id, clientActionId: "p", text: "在吗", mentions: [{ id: cc.id, source: "manual" }] });
  await settle(host);
  const ccMsg = host.listMessages(g.id, {}).messages.find((m) => m.sender.id === cc.id)!.seq;
  const argonBefore = host.loop.rounds(argon.id);
  const sent = host.send({ roomId: g.id, clientActionId: "q", text: "照这条办", replyToSeq: ccMsg, quotedSeqs: [old], mentions: [{ id: cc.id, source: "auto" }] });
  assert.equal(host.loop.rounds(argon.id), argonBefore, "Argon 没被立即唤醒(只按新消息元数据调度)");
  assert.deepEqual(sent.mentions, [{ id: cc.id, source: "auto" }]);
  assert.equal(sent.command, null);
  await settle(host);
  const input = rec.inputs.get(argon.id)!.find((i) => i.fresh.some((f) => f.kind === "message" && f.seq === sent.seq));
  assert.ok(input);
  const fresh = input.fresh.find((f) => f.kind === "message" && f.seq === sent.seq);
  assert.deepEqual(fresh?.kind === "message" ? fresh.mentions : null, [cc.id]);
  assert.ok(!block(input, 4).includes("/stop 全部停下"), "旧文不在新消息那一块");
  assert.ok(block(input, 5).includes("/stop 全部停下"), "旧文作为引用原文换入第 5 块");
  assert.deepEqual(recallOf(reports, argon.id).at(-1)?.items.map((x) => [x.seq, x.state]), [[ccMsg, "Full"], [old, "Full"]]);
  assert.deepEqual(host.listTasks({ roomId: g.id }), []);
});
