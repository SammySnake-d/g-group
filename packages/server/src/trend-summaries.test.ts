// 群聊动向摘要(U80,D21.2–D21.4;AC-08 撤回级联、AC-19 只读不代办、AC-25 来源带 seq 可跳、AC-35 承诺触发):
// - 到点只调一次联系人模型,读的就是冻结的那段 (from, to];摘要不是消息,不进会话、不被计数;
// - 整段读全(201 条也是 201 条);超输入上限只读前一部分并如实标 truncated;来源必须是这次读到的消息,否则整份不要;
// - 区间里没有可总结的发言(全撤回、提出人本端全删、只剩通知和任务卡)记 empty,不调模型;
// - 只读:模型提出的派活、交付、验收结论、停止、承诺、记忆、去别的会话发言都不执行,任务/卡片/草稿/游标/账本/消息一条不变;
// - 撤回 → 摘要对所有人过期、正文清掉,和撤回同一事务落盘,重启后仍是过期;生成途中撤回的落不进正文;可重做出新版本;
// - 本端删除只影响那位用户的视图,不让摘要过期;模型失败、超时、重启打断记 failed,宿主不自己重试。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { CommitmentView, MessageView, ServerEvent, TaskView, TrendSummaryView } from "@g-group/api-contract";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { type Db, all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";
import { summaryLedgerNote } from "./trend-summaries.ts";
import { SUMMARY_SYSTEM } from "./trend-summary-format.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-trend-summary-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const live: { hosts: Host[]; gates: (() => void)[]; computes: { close(): void }[] } = { hosts: [], gates: [], computes: [] };
const track = (h: Host) => {
  live.hosts.push(h);
  return h;
};
afterEach(async () => {
  for (const g of live.gates.splice(0)) g();
  for (const c of live.computes.splice(0)) c.close();
  for (const h of live.hosts.splice(0)) await h.close();
});
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);
const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 600; i++) {
    await host.idle();
    await tick();
    if (!host.loop.busy() && !host.summaries.busy() && (!compute || compute.drained())) return;
  }
  throw new Error("没安静下来");
}
async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await tick();
  }
}
const okValue = <T>(r: { ok: boolean; value?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};
const errOf = (r: { ok: boolean; error?: { code: string; message: string } }) => (r.ok ? null : [r.error!.code, r.error!.message]);
const contact = (id: string) => ({ kind: "contact" as const, id });
const ASK = /^每 (\d+) 条消息总结一次$/;
const isSummaryRound = (i: RoundInput) => i.request.blocks[0]!.text.startsWith(SUMMARY_SYSTEM);
/** 摘要轮的默认写法:每条读到的消息一条要点,来源就是那条消息。 */
const perMessage = (i: RoundInput): MindAction[] => [
  { kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: i.fresh.map((f) => (f.kind === "message" ? `- 说到「${f.text}」 [#${f.seq}]` : "")).join("\n") },
];
/** 每 size 条消息合成一条要点,来源是这几条(长区间用,要点不超过 30 条)。 */
const chunked = (size: number) => (i: RoundInput): MindAction[] => {
  const seqs = i.fresh.map((f) => (f.kind === "message" ? f.seq : -1));
  const lines: string[] = [];
  for (let at = 0; at < seqs.length; at += size) lines.push(`- 第 ${at / size + 1} 段的动向 [${seqs.slice(at, at + size).map((q) => `#${q}`).join(" ")}]`);
  return [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: lines.join("\n") }];
};
/**
 * 联系人脑子:平时听到「每 N 条消息总结一次」就登记带 everyNMessages 的承诺,Compute 做完就交付,别的不出声;
 * 摘要轮(第 1 块是摘要规矩)记下输入,按 write 给的写法回。
 */
function mind(calls: RoundInput[], write: (i: RoundInput, signal: AbortSignal) => MindAction[] | Promise<MindAction[]> = perMessage, normal: RoundInput[] = []) {
  return (): ContactMind => ({
    async round(input, signal) {
      if (isSummaryRound(input)) {
        calls.push(input);
        return { actions: await write(input, signal), stateNote: null };
      }
      normal.push(input);
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `做完了:${f.summary}` });
        if (f.kind !== "message" || f.sender.kind !== "user") continue;
        const m = ASK.exec(f.text);
        if (!m) continue;
        actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: f.text, taskId: null, everyNMessages: Number(m[1]) });
        actions.push({ kind: "reply", roomId: f.roomId, text: "好,记下了", replyToSeq: f.seq });
      }
      return { actions, stateNote: null };
    },
  });
}
const rows = (host: { db: Db }) => all<{ id: string; status: string; items: string; from_seq: number; to_seq: number; version: number; error: string | null }>(host.db, "SELECT id, status, items, from_seq, to_seq, version, error FROM gg_summaries ORDER BY to_seq, version");
const reports = (out: { what: string; detail: unknown }[]) => (what: string, detail: unknown) => {
  if (what.startsWith("summary-")) out.push({ what, detail });
};
/** 摘要与触发自己的表之外,库里所有表的全部内容(核对「只写摘要自己的记录」)。 */
function everythingElse(host: { db: Db }) {
  const own = new Set(["gg_summaries", "gg_count_windows", "gg_count_triggers"]);
  const tables = all<{ name: string }>(host.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name).filter((t) => !own.has(t));
  return Object.fromEntries(tables.map((t) => [t, all<Record<string, unknown>>(host.db, `SELECT * FROM ${t} ORDER BY rowid`)]));
}

test("到点只调一次联系人模型:第 99 条不调、第 100 条调一次读的正是那一段、第 101 条不再调;摘要不进会话、不被计数,重启和重发也不再调", async () => {
  const f = file();
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: f, mind: mind(calls, chunked(10)), maxDeferMs: 5 }));
  const svc = createService(h);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 100 条消息总结一次" });
  await settle(h);
  const start = h.lastSeq(g.id);
  const sent: MessageView[] = [];
  for (let i = 1; i <= 99; i++) sent.push(h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }));
  await settle(h);
  assert.deepEqual([calls.length, rows(h)], [0, []]);
  sent.push(h.send({ roomId: g.id, clientActionId: "m100", text: "第 100 条" }));
  await settle(h);
  const end = sent[99]!.seq;
  assert.equal(calls.length, 1);
  // 读的正是冻结的那一段:100 条、起止对得上,用的是它自己的说话模型和档案
  const input = calls[0]!;
  assert.deepEqual([input.fresh.length, input.fresh.map((x) => (x.kind === "message" ? x.seq : -1)), input.contact], [100, sent.map((m) => m.seq), { id: a.id, name: "小记", speakingModel: a.speakingModel, persona: "" }]);
  assert.deepEqual(input.request.blocks.map((b) => [b.block, b.label]), [[1, "固定前缀"], [2, "承诺账本"], [3, "状态笔记"], [4, "新消息"], [5, "指针与按需换入"]]);
  assert.equal(input.request.blocks[1]!.text, "引出这次摘要的承诺:每 100 条消息总结一次");
  assert.equal(input.request.blocks[3]!.text.split("\n").slice(0, 3).join("|"), `[待总结的消息](会话 ${g.id},原文,按先后)|#${sent[0]!.seq} · 我(user:me) · ${sent[0]!.at}|第 1 条`);
  assert.equal(input.request.blocks[4]!.text, `会话:研发群(${g.id})\n区间:#${start} 之后到 #${end}(含),当前可见的群聊发言 100 条。\n100 条全部在第 4 块里。`);
  const list = okValue<{ summaries: TrendSummaryView[]; hasMore: boolean }>(await svc.handle("summaries.list", { roomId: g.id }));
  const s = list.summaries[0]!;
  const commitment = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments[0]!;
  assert.deepEqual(
    { ...s, summaryId: "", generatedAt: "", createdAt: "", items: s.items.length },
    { summaryId: "", roomId: g.id, contactId: a.id, commitmentId: commitment.id, nature: "llm-interpretation", fromSeqExclusive: start, toSeqInclusive: end, messageCount: 100, coveredCount: 100, coveredToSeq: end, truncated: false, status: "ok", items: 10, hiddenItems: 0, model: { speakingModel: a.speakingModel }, generatedAt: "", staleReason: null, staleBySeq: null, staleAt: null, error: null, version: 1, supersedes: null, supersededBy: null, createdAt: "" },
  );
  assert.deepEqual([list.hasMore, list.summaries.length, s.items[0], s.items[9]], [false, 1, { text: "第 1 段的动向", sourceSeqs: sent.slice(0, 10).map((m) => m.seq), hiddenSourceSeqs: [] }, { text: "第 10 段的动向", sourceSeqs: sent.slice(90).map((m) => m.seq), hiddenSourceSeqs: [] }]);
  assert.deepEqual(okValue<TrendSummaryView>(await svc.handle("summaries.get", { summaryId: s.summaryId })), s);
  // 每条来源都能用 messages.list 的 aroundSeq 跳回原消息
  const jump = okValue<{ messages: MessageView[] }>(await svc.handle("messages.list", { roomId: g.id, aroundSeq: s.items[4]!.sourceSeqs[1]!, limit: 1 }));
  assert.deepEqual(jump.messages.map((m) => [m.seq, m.text]), [[sent[41]!.seq, "第 42 条"]]);
  // 摘要不是消息:会话末尾没动;事件是 generating → ok 两条
  assert.equal(h.lastSeq(g.id), end);
  assert.deepEqual(events.flatMap((e) => (e.type === "summary.updated" ? [[e.summary.summaryId, e.summary.status]] : [])), [[s.summaryId, "generating"], [s.summaryId, "ok"]]);
  h.send({ roomId: g.id, clientActionId: "m101", text: "第 101 条" });
  h.send({ roomId: g.id, clientActionId: "m100", text: "第 100 条" });
  await settle(h);
  assert.deepEqual([calls.length, rows(h).length, okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments[0]!.trigger?.count], [1, 1, 1]);
  await h.close();
  const again: RoundInput[] = [];
  const h2 = track(new Host({ file: f, mind: mind(again), maxDeferMs: 5 }));
  await settle(h2);
  assert.deepEqual([again.length, rows(h2).map((r) => [r.status, r.version])], [0, [["ok", 1]]]);
});

test("整段读全不设条数上限:201 条就读 201 条;超过输入字节上限只读前一部分并如实标 truncated,引用没读到的消息整份不要", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls, chunked(20)), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 201 条消息总结一次" });
  await settle(h);
  const all201: number[] = [];
  for (let i = 1; i <= 201; i++) all201.push(h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }).seq);
  await settle(h);
  const full = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.deepEqual([calls.length, calls[0]!.fresh.length, full.messageCount, full.coveredCount, full.coveredToSeq, full.truncated, full.status, full.items.length], [1, 201, 201, 201, all201[200], false, "ok", 11]);
  // 最后一条要点的来源就是第 201 条:没有被 200 条这类上限挡在外面
  assert.deepEqual([full.items[10]!.sourceSeqs, full.items[0]!.sourceSeqs.length], [[all201[200]], 20]);

  // 字节上限小:每条 10 个汉字 ≈ 30 字节 + 64 字节记账,300 字节放得下前 3 条
  const small: RoundInput[] = [];
  const beyond = { on: false };
  const write = (i: RoundInput): MindAction[] => (beyond.on ? [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: `- 编的 [#${(i.fresh.at(-1) as { seq: number }).seq + 1}]` }] : perMessage(i));
  const h2 = track(new Host({ file: file(), mind: mind(small, write), maxDeferMs: 5, summaryInputMaxBytes: 300 }));
  const svc2 = createService(h2);
  const b = h2.createContact({ name: "小记" });
  const g2 = h2.createGroup("研发群", [contact(b.id)]);
  h2.send({ roomId: g2.id, clientActionId: "ask", text: "每 5 条消息总结一次" });
  await settle(h2);
  const sent: number[] = [];
  for (let i = 1; i <= 5; i++) sent.push(h2.send({ roomId: g2.id, clientActionId: `m${i}`, text: "十个汉字十个汉字十个" }).seq);
  await settle(h2);
  const cut = okValue<{ summaries: TrendSummaryView[] }>(await svc2.handle("summaries.list", { roomId: g2.id })).summaries[0]!;
  assert.deepEqual([small[0]!.fresh.length, cut.messageCount, cut.coveredCount, cut.coveredToSeq, cut.truncated, cut.status, cut.items.map((x) => x.sourceSeqs), cut.toSeqInclusive], [3, 5, 3, sent[2], true, "ok", [[sent[0]], [sent[1]], [sent[2]]], sent[4]]);
  assert.match(small[0]!.request.blocks[4]!.text, /这次只给了前 3 条/);
  // 引用区间里但没读到的那条(第 4 条):来源对不上,整份不要
  beyond.on = true;
  for (let i = 6; i <= 10; i++) sent.push(h2.send({ roomId: g2.id, clientActionId: `m${i}`, text: "十个汉字十个汉字十个" }).seq);
  await settle(h2);
  const refused = okValue<{ summaries: TrendSummaryView[] }>(await svc2.handle("summaries.list", { roomId: g2.id })).summaries[0]!;
  assert.deepEqual([refused.status, refused.error, refused.items, refused.coveredCount, refused.truncated], ["failed", `来源 #${sent[8]} 不在这次读到的消息里`, [], 3, true]);

  // 上限小到连第一条都放不下:不调模型,记 failed 写明原因(不是 empty:这段明明有话)
  const none: RoundInput[] = [];
  const h3 = track(new Host({ file: file(), mind: mind(none), maxDeferMs: 5, summaryInputMaxBytes: 70 }));
  const svc3 = createService(h3);
  const c = h3.createContact({ name: "小记" });
  const g3 = h3.createGroup("研发群", [contact(c.id)]);
  h3.send({ roomId: g3.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await settle(h3);
  h3.send({ roomId: g3.id, clientActionId: "m1", text: "十个汉字十个汉字十个" });
  await settle(h3);
  const over = okValue<{ summaries: TrendSummaryView[] }>(await svc3.handle("summaries.list", { roomId: g3.id })).summaries[0]!;
  assert.deepEqual([over.status, over.error, over.messageCount, over.coveredCount, none.length], ["failed", "区间里第一条消息就超过了摘要输入上限", 1, 0, 0]);
});

test("一段只有 1 条消息也照做:每 1 条消息一段,各读各的那一条,前一段的终点就是后一段的起点", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await settle(h);
  assert.equal(calls.length, 0);
  const m1 = h.send({ roomId: g.id, clientActionId: "m1", text: "先修登录" });
  await settle(h);
  const m2 = h.send({ roomId: g.id, clientActionId: "m2", text: "周五发版" });
  await settle(h);
  const [second, first] = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries as [TrendSummaryView, TrendSummaryView];
  assert.deepEqual(calls.map((c) => c.fresh.map((f) => (f.kind === "message" ? f.seq : -1))), [[m1.seq], [m2.seq]]);
  assert.deepEqual(
    [first, second].map((s) => [s.status, s.messageCount, s.coveredCount, s.truncated, s.toSeqInclusive, s.items.map((x) => x.sourceSeqs)]),
    [["ok", 1, 1, false, m1.seq, [[m1.seq]]], ["ok", 1, 1, false, m2.seq, [[m2.seq]]]],
  );
  assert.equal(second.fromSeqExclusive, first.toSeqInclusive);
});

test("来源必须在本房、本区间、生成时可见:引用区间外、别的会话的 seq、已撤回的消息、没带来源的要点,整份都不要", async () => {
  const calls: RoundInput[] = [];
  const cite: { text: string } = { text: "" };
  const write = (i: RoundInput): MindAction[] => [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: cite.text }];
  const h = track(new Host({ file: file(), mind: mind(calls, write), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  const other = h.createGroup("别的群", [contact(a.id)]);
  for (let i = 0; i < 30; i++) h.send({ roomId: other.id, clientActionId: `o${i}`, text: `别的群 ${i}` });
  const early = h.send({ roomId: g.id, clientActionId: "early", text: "更早的话" });
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h);
  const latest = async () => okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  let k = 0;
  const round = async (text: (seqs: number[]) => string, retractFirst = false) => {
    const seqs = [1, 2, 3].map(() => h.send({ roomId: g.id, clientActionId: `r${++k}`, text: `话 ${k}` }).seq);
    // 冻结和生成之间(同一拍里)撤回第一条:它不在这次读到的消息里
    if (retractFirst) h.retractMessage(g.id, seqs[0]!);
    cite.text = text(seqs);
    await settle(h);
    return { seqs, s: await latest() };
  };
  const before = await round(() => `- 引了区间之前的 [#${early.seq}]`);
  assert.deepEqual([before.s.status, before.s.error, before.s.items], ["failed", `来源 #${early.seq} 不在这次读到的消息里`, []]);
  const after_ = await round((q) => `- 引了区间之后的 [#${q[2]! + 1}]`);
  assert.deepEqual([after_.s.status, after_.s.error], ["failed", `来源 #${after_.seqs[2]! + 1} 不在这次读到的消息里`]);
  // 别的会话里确实有 #25,但本房这一段没有
  const foreign = await round(() => "- 引了别的群的 [#25]");
  assert.deepEqual([foreign.s.status, foreign.s.error, h.lastSeq(other.id) >= 25], ["failed", "来源 #25 不在这次读到的消息里", true]);
  const gone = await round((q) => `- 引了已撤回的 [#${q[0]}]\n- 正常 [#${q[1]}]`, true);
  assert.deepEqual([gone.s.status, gone.s.error, gone.s.coveredCount, calls.at(-1)!.fresh.map((x) => (x.kind === "message" ? x.seq : -1))], ["failed", `来源 #${gone.seqs[0]} 不在这次读到的消息里`, 2, [gone.seqs[1], gone.seqs[2]]]);
  const bare = await round((q) => `- 有来源 [#${q[0]}]\n- 没来源的一条`);
  assert.deepEqual([bare.s.status, bare.s.error], ["failed", "有要点没带来源:没来源的一条"]);
  // 对照:同样的写法,来源都在这一段里 → 生成
  const fine = await round((q) => `前言不算\n- 方向是先修登录 [#${q[0]} #${q[2]}]\n- 有人提议周五发版 [#${q[1]}]`);
  assert.deepEqual([fine.s.status, fine.s.error, fine.s.items], ["ok", null, [{ text: "方向是先修登录", sourceSeqs: [fine.seqs[0], fine.seqs[2]], hiddenSourceSeqs: [] }, { text: "有人提议周五发版", sourceSeqs: [fine.seqs[1]], hiddenSourceSeqs: [] }]]);
  assert.equal(calls.length, 6);
});

test("没有可总结的发言不调模型:这一段全被撤回、提出人本端全删、只剩通知和任务卡,都记 empty", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  const latest = async () => okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  // 全被撤回(中间夹着通知和任务卡:只剩它们也不算有话可总结)
  const x1 = h.send({ roomId: g.id, clientActionId: "x1", text: "发错了一" });
  h.postSystemNotice(g.id, "宿主通知", "n1");
  await svc.handle("tasks.create", { clientActionId: "t1", roomId: g.id, title: "整理周报" });
  const x2 = h.send({ roomId: g.id, clientActionId: "x2", text: "发错了二" });
  h.retractMessage(g.id, x1.seq);
  h.retractMessage(g.id, x2.seq);
  await settle(h);
  const e1 = await latest();
  assert.deepEqual([e1.status, e1.messageCount, e1.coveredCount, e1.items, e1.toSeqInclusive, e1.error, calls.length], ["empty", 0, 0, [], x2.seq, null, 0]);
  // 提出人在自己这一端全删了
  const y1 = h.send({ roomId: g.id, clientActionId: "y1", text: "我删一" });
  const y2 = h.send({ roomId: g.id, clientActionId: "y2", text: "我删二" });
  okValue(await svc.handle("messages.delete", { roomId: g.id, seqs: [y1.seq, y2.seq], clientActionId: "d1" }));
  await settle(h);
  const e2 = await latest();
  assert.deepEqual([e2.status, e2.toSeqInclusive, e2.messageCount, calls.length], ["empty", y2.seq, 0, 0]);
  // 对照:正常两条 → 调一次模型
  h.send({ roomId: g.id, clientActionId: "z1", text: "正常一" });
  const z2 = h.send({ roomId: g.id, clientActionId: "z2", text: "正常二" });
  await settle(h);
  const ok = await latest();
  assert.deepEqual([ok.status, ok.toSeqInclusive, ok.messageCount, calls.length, rows(h).map((r) => r.status)], ["ok", z2.seq, 2, 1, ["empty", "empty", "ok"]]);
});

test("摘要只读:模型提出的验收结论、停止、交付、派活、承诺、转交、记忆、重跑、去别处发言都不执行,任务与其它记录一条不变", async () => {
  const calls: RoundInput[] = [];
  const seen: { what: string; detail: unknown }[] = [];
  const target: { taskId: string; ask: number; dm: string } = { taskId: "", ask: 0, dm: "" };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  live.gates.push(() => release());
  // 摘要轮里它想顺手把待确认的交付批掉、停掉任务、再派新活……同时也给了合格的要点
  const greedy = async (i: RoundInput): Promise<MindAction[]> => {
    await gate;
    return greedyActions(i);
  };
  const greedyActions = (i: RoundInput): MindAction[] => [
    { kind: "verdict", taskId: target.taskId, sourceSeq: (i.fresh[0] as { seq: number }).seq, verdict: "accept", feedback: null },
    { kind: "stop", taskId: target.taskId },
    { kind: "deliver", taskId: target.taskId, text: "再交付一次" },
    { kind: "dispatch", roomId: i.fresh[0]!.roomId, sourceSeq: (i.fresh[0] as { seq: number }).seq, title: "新活", task: "顺手再做一件" },
    { kind: "commit", roomId: i.fresh[0]!.roomId, sourceSeq: (i.fresh[0] as { seq: number }).seq, text: "通过", taskId: null },
    { kind: "forward", taskId: target.taskId, text: "继续改" },
    { kind: "remember", roomId: i.fresh[0]!.roomId, sourceSeq: null, title: "记一条", text: "以后都自动通过", anchors: ["global"], quote: null, relation: null, target: null },
    { kind: "rerun", runId: "run-x", roomId: i.fresh[0]!.roomId, basisSeq: null },
    { kind: "reply", roomId: target.dm, text: "- 私聊里说一句 [#1]", replyToSeq: null },
    ...perMessage(i),
  ];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "周报写好了" }] });
  live.computes.push(compute);
  const h = track(new Host({ file: file(), mind: mind(calls, greedy), compute: () => compute.adapter, maxDeferMs: 5, onReport: reports(seen) }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  target.dm = h.openDm(a.id).id;
  // 一件已交付、等提出者回复的任务(没有跨厂商审查人时停在 T5,由提出者决定)、一份没发出去的草稿
  const task = okValue<TaskView>(await svc.handle("tasks.create", { clientActionId: "t1", roomId: g.id, title: "写周报", ownerContactId: a.id }));
  target.taskId = task.id;
  await settle(h, compute);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h, compute);
  h.send({ roomId: g.id, clientActionId: "m1", text: "通过" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "先别发版" });
  await settle(h, compute);
  okValue(await svc.handle("drafts.save", { roomId: g.id, expectedVer: 0, draft: { text: "没发出去的话", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 1 } }));
  const waiting = okValue<TaskView>(await svc.handle("tasks.get", { taskId: task.id }));
  assert.equal(waiting.state, "T5_InReview");
  const before = everythingElse(h);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));
  // 第三条消息落盘会动消息相关的表,所以基准取「摘要轮开跑那一刻」的全库状态,而不是发第三条之前
  const third = h.send({ roomId: g.id, clientActionId: "m3", text: "周五再看" });
  await until(() => calls.length === 1, "摘要轮开跑");
  // 等联系人平时那一轮把第三条处理完(处理游标到第三条),再取基准;此时摘要轮还卡在模型那里
  await until(() => all<{ p: number }>(h.db, "SELECT processed_seq AS p FROM gg_cursor WHERE contact_id = ? AND room_id = ?", a.id, g.id)[0]?.p === third.seq && !h.loop.busy(), "平时那一轮处理完第三条");
  const mid = everythingElse(h);
  assert.deepEqual(rows(h).map((r) => r.status), ["generating"]);
  release();
  await settle(h, compute);
  const s = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.deepEqual([s.status, s.items.map((x) => x.text), s.toSeqInclusive], ["ok", ["说到「通过」", "说到「先别发版」", "说到「周五再看」"], third.seq]);
  // 摘要轮开跑时的全库状态与它结束后的逐表相同:它只写了自己的记录
  assert.deepEqual(everythingElse(h), mid);
  assert.notDeepEqual(mid.events, before.events);
  assert.deepEqual(okValue<TaskView>(await svc.handle("tasks.get", { taskId: task.id })), waiting);
  assert.deepEqual([h.lastSeq(g.id), h.lastSeq(target.dm), compute.stopped.length], [third.seq, 0, 0]);
  assert.deepEqual(events.filter((e) => e.type === "task.updated" || e.type === "message.updated" || e.type === "draft.updated").length, 0);
  assert.deepEqual(seen, [{ what: "summary-actions-ignored", detail: { summaryId: s.summaryId, kinds: ["verdict", "stop", "deliver", "dispatch", "commit", "forward", "remember", "rerun", "reply"], stateNote: false } }]);
});

test("撤回后摘要对所有人过期、正文清掉:和撤回同一事务落盘,重启后仍过期;只认本会话、区间 (from, to] 里的撤回;搜索和联系人下一轮都见不到原文", async () => {
  const f = file();
  const calls: RoundInput[] = [];
  const normal: RoundInput[] = [];
  const h = track(new Host({ file: f, mind: mind(calls, perMessage, normal), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  const other = h.createGroup("别的群", [contact(a.id)]);
  const outside = h.send({ roomId: g.id, clientActionId: "pre", text: "区间之前的话" });
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  // 别的群:seq 和这边错不开,用来核对失效只认本会话
  h.send({ roomId: other.id, clientActionId: "oask", text: "每 4 条消息总结一次" });
  await settle(h);
  const o = [1, 2, 3, 4].map((i) => h.send({ roomId: other.id, clientActionId: `o${i}`, text: `别的群 ${i}` }).seq);
  const secret = h.send({ roomId: g.id, clientActionId: "m1", text: "密码是榴莲披萨" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "周五发版" });
  h.send({ roomId: g.id, clientActionId: "m3", text: "第二段一" });
  const edge = h.send({ roomId: g.id, clientActionId: "m4", text: "第二段二" });
  h.send({ roomId: g.id, clientActionId: "m5", text: "第三段一" });
  h.send({ roomId: g.id, clientActionId: "m6", text: "第三段二" });
  await settle(h);
  const [third, second, first] = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries as [TrendSummaryView, TrendSummaryView, TrendSummaryView];
  const elsewhere = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: other.id })).summaries[0]!;
  assert.deepEqual([first.status, first.items.map((x) => x.text), second.status, third.status, elsewhere.status], ["ok", ["说到「密码是榴莲披萨」", "说到「周五发版」"], "ok", "ok", "ok"]);
  // 别的群那份的区间按数字盖住了这边要撤回的 seq,但不是同一个会话
  assert.deepEqual([elsewhere.fromSeqExclusive < secret.seq && secret.seq <= elsewhere.toSeqInclusive, edge.seq, third.fromSeqExclusive], [true, second.toSeqInclusive, second.toSeqInclusive]);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));
  const status = () => Object.fromEntries(all<{ id: string; status: string }>(h.db, "SELECT id, status FROM gg_summaries").map((r) => [r.id, r.status]));
  // 区间之前的撤回:都不动
  h.retractMessage(g.id, outside.seq);
  assert.deepEqual(status(), { [first.summaryId]: "ok", [second.summaryId]: "ok", [third.summaryId]: "ok", [elsewhere.summaryId]: "ok" });
  // 撤回第二段的最后一条(右端含):第二段过期;它同时是第三段的起点(左端不含),第三段不动
  h.retractMessage(g.id, edge.seq);
  assert.deepEqual(status(), { [first.summaryId]: "ok", [second.summaryId]: "stale", [third.summaryId]: "ok", [elsewhere.summaryId]: "ok" });
  h.retractMessage(g.id, secret.seq);
  // 撤回一返回,库里这份摘要已经是过期、正文已清;别的群那份不受影响
  assert.deepEqual(status(), { [first.summaryId]: "stale", [second.summaryId]: "stale", [third.summaryId]: "ok", [elsewhere.summaryId]: "ok" });
  assert.deepEqual(rows(h).filter((r) => r.id === first.summaryId || r.id === third.summaryId).map((r) => [r.id, r.items === "[]"]), [[first.summaryId, true], [third.summaryId, false]]);
  const stale = okValue<TrendSummaryView>(await svc.handle("summaries.get", { summaryId: first.summaryId }));
  assert.deepEqual([stale.status, stale.staleReason, stale.staleBySeq, stale.items, typeof stale.staleAt], ["stale", "source-retracted", secret.seq, [], "string"]);
  assert.deepEqual(events.flatMap((e) => (e.type === "summary.updated" ? [[e.summary.summaryId, e.summary.status, e.summary.staleBySeq]] : [])), [[second.summaryId, "stale", edge.seq], [first.summaryId, "stale", secret.seq]]);
  assert.equal(JSON.stringify(all(h.db, "SELECT * FROM gg_summaries")).includes("榴莲披萨"), false);
  assert.deepEqual(okValue<{ hits: unknown[] }>(await svc.handle("search.messages", { query: "榴莲披萨" })).hits, []);
  // 联系人下一轮的输入里没有原文,也没有旧摘要的正文
  h.send({ roomId: g.id, clientActionId: "m7", text: "接着聊" });
  await settle(h);
  const lastRound = JSON.stringify(normal.at(-1));
  assert.deepEqual([lastRound.includes("接着聊"), lastRound.includes("榴莲披萨")], [true, false]);
  assert.equal(o.length, 4);
  await h.close();
  // 重启:过期是落了盘的,不靠内存事件
  const h2 = track(new Host({ file: f, mind: mind([]), maxDeferMs: 5 }));
  const again = h2.getSummary(first.summaryId);
  assert.deepEqual([again.status, again.staleReason, again.staleBySeq, again.items, h2.getSummary(second.summaryId).staleBySeq, h2.getSummary(third.summaryId).status], ["stale", "source-retracted", secret.seq, [], edge.seq, "ok"]);
});

test("过期后可重做:同一区间出新版本、指回旧版本,重新读这段现在可见的消息;同一 clientActionId 只做一次;不该重做的被拒", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h);
  const secret = h.send({ roomId: g.id, clientActionId: "m1", text: "密码是榴莲披萨" });
  const m2 = h.send({ roomId: g.id, clientActionId: "m2", text: "周五发版" });
  const m3 = h.send({ roomId: g.id, clientActionId: "m3", text: "先修登录" });
  await settle(h);
  const v1 = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.deepEqual(errOf(await svc.handle("summaries.regenerate", { summaryId: v1.summaryId, clientActionId: "early" })), ["conflict", "这份摘要是 ok,只有已过期或没生成成的才能重做"]);
  h.retractMessage(g.id, secret.seq);
  const started = okValue<TrendSummaryView>(await svc.handle("summaries.regenerate", { summaryId: v1.summaryId, clientActionId: "redo1" }));
  assert.deepEqual([started.status, started.version, started.supersedes, started.fromSeqExclusive, started.toSeqInclusive, started.commitmentId], ["generating", 2, v1.summaryId, v1.fromSeqExclusive, v1.toSeqInclusive, v1.commitmentId]);
  const replay = okValue<TrendSummaryView>(await svc.handle("summaries.regenerate", { summaryId: v1.summaryId, clientActionId: "redo1" }));
  await settle(h);
  assert.deepEqual([replay.summaryId, calls.length], [started.summaryId, 2]);
  // 新版本读的是现在可见的两条,不含撤回的那条
  assert.deepEqual(calls[1]!.fresh.map((x) => (x.kind === "message" ? [x.seq, x.text] : [])), [[m2.seq, "周五发版"], [m3.seq, "先修登录"]]);
  const v2 = okValue<TrendSummaryView>(await svc.handle("summaries.get", { summaryId: started.summaryId }));
  assert.deepEqual([v2.status, v2.messageCount, v2.items.map((x) => [x.text, x.sourceSeqs]), v2.supersededBy], ["ok", 2, [["说到「周五发版」", [m2.seq]], ["说到「先修登录」", [m3.seq]]], null]);
  // 时间轴默认只给最新版本;要历史再带 includeSuperseded
  const latest = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries;
  const history = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id, includeSuperseded: true })).summaries;
  assert.deepEqual([latest.map((x) => [x.summaryId, x.version]), history.map((x) => [x.version, x.status, x.supersededBy])], [[[v2.summaryId, 2]], [[2, "ok", null], [1, "stale", v2.summaryId]]]);
  // 旧版本已有更新的版本、新版本是 ok:都不能再重做
  assert.deepEqual(errOf(await svc.handle("summaries.regenerate", { summaryId: v1.summaryId, clientActionId: "redo2" })), ["conflict", "这份摘要已经有更新的版本"]);
  assert.deepEqual(errOf(await svc.handle("summaries.regenerate", { summaryId: v2.summaryId, clientActionId: "redo3" })), ["conflict", "这份摘要是 ok,只有已过期或没生成成的才能重做"]);
  // 新版本同样受撤回约束;联系人移出群后不能重做
  h.retractMessage(g.id, m2.seq);
  h.removeMember(g.id, contact(a.id));
  assert.deepEqual([h.getSummary(v2.summaryId).status, errOf(await svc.handle("summaries.regenerate", { summaryId: v2.summaryId, clientActionId: "redo4" })), calls.length], ["stale", ["conflict", "现在不能重做:联系人已不在这个会话"], 2]);
});

test("生成途中撤回:模型回来时这段已有新撤回,正文不落库,直接记过期;没撤回的那一份照常生成", async () => {
  const calls: RoundInput[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  live.gates.push(() => release());
  const slow = async (i: RoundInput): Promise<MindAction[]> => {
    await gate;
    return perMessage(i);
  };
  const h = track(new Host({ file: file(), mind: mind(calls, slow), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  const secret = h.send({ roomId: g.id, clientActionId: "m1", text: "密码是榴莲披萨" });
  const m2 = h.send({ roomId: g.id, clientActionId: "m2", text: "周五发版" });
  await until(() => calls.length === 1, "第一份开跑");
  // 模型已经读到原文,还没回来
  assert.deepEqual([JSON.stringify(calls[0]!.fresh).includes("榴莲披萨"), rows(h).map((r) => r.status)], [true, ["generating"]]);
  h.retractMessage(g.id, secret.seq);
  release();
  await settle(h);
  const s1 = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.deepEqual([s1.status, s1.staleReason, s1.staleBySeq, s1.items, s1.generatedAt], ["stale", "source-retracted", secret.seq, [], null]);
  assert.equal(JSON.stringify(all(h.db, "SELECT * FROM gg_summaries")).includes("榴莲披萨"), false);
  // 窗口已结清:不会因为这次没落成正文而再调一次
  assert.deepEqual(all<{ status: string }>(h.db, "SELECT status FROM gg_count_windows").map((w) => w.status), ["done"]);
  // 对照:下一段生成途中没有撤回 → 正常生成
  gate = new Promise<void>((r) => (release = r));
  live.gates.push(() => release());
  h.send({ roomId: g.id, clientActionId: "m3", text: "第二段一" });
  h.send({ roomId: g.id, clientActionId: "m4", text: "第二段二" });
  await until(() => calls.length === 2, "第二份开跑");
  // 途中撤回的是区间外的消息:这段的起点那条(左端不含)和这段之后才说的一条,这一份不受影响;已经过期的那份原因也不改写
  const later = h.send({ roomId: g.id, clientActionId: "m5", text: "这段之后才说的" });
  h.retractMessage(g.id, m2.seq);
  h.retractMessage(g.id, later.seq);
  release();
  await settle(h);
  assert.deepEqual(rows(h).map((r) => [r.status, r.items === "[]", r.from_seq === m2.seq]), [["stale", true, false], ["ok", false, true]]);
  assert.equal(h.getSummary(s1.summaryId).staleBySeq, secret.seq);
});

test("本端删除只影响那位用户的视图:摘要不过期、记录不变;他删掉全部来源的要点不再给他看,别人照常看到;重启后一样", async () => {
  const f = file();
  const calls: RoundInput[] = [];
  const write = (i: RoundInput): MindAction[] => {
    const q = i.fresh.map((x) => (x as { seq: number }).seq);
    return [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: `- 只靠第一条 [#${q[0]}]\n- 第一条和第二条 [#${q[0]} #${q[1]}]\n- 只靠第三条 [#${q[2]}]` }];
  };
  const h = track(new Host({ file: f, mind: mind(calls, write), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id), { kind: "user", id: "u2" }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h);
  const q = [1, 2, 3].map((i) => h.send({ roomId: g.id, clientActionId: `m${i}`, text: `话 ${i}` }).seq);
  await settle(h);
  const before = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  const stored = rows(h);
  assert.deepEqual([before.items.length, before.hiddenItems], [3, 0]);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));
  okValue(await svc.handle("messages.delete", { roomId: g.id, seqs: [q[0]!], clientActionId: "d1" }));
  const mine = okValue<TrendSummaryView>(await svc.handle("summaries.get", { summaryId: before.summaryId }));
  assert.deepEqual([mine.status, mine.staleReason, mine.hiddenItems, mine.items], ["ok", null, 1, [{ text: "第一条和第二条", sourceSeqs: [q[0], q[1]], hiddenSourceSeqs: [q[0]] }, { text: "只靠第三条", sourceSeqs: [q[2]], hiddenSourceSeqs: [] }]]);
  // 记录没动;群里另一位用户看到的还是完整的三条;没有推「摘要变了」
  assert.deepEqual(rows(h), stored);
  assert.deepEqual([h.summaries.view(before.summaryId, "u2").items.map((x) => x.text), h.summaries.view(before.summaryId, "u2").hiddenItems], [["只靠第一条", "第一条和第二条", "只靠第三条"], 0]);
  assert.deepEqual(events.filter((e) => e.type === "summary.updated").length, 0);
  await h.close();
  const h2 = track(new Host({ file: f, mind: mind([]), maxDeferMs: 5 }));
  assert.deepEqual([h2.getSummary(before.summaryId).items.map((x) => x.text), h2.getSummary(before.summaryId).status, h2.summaries.view(before.summaryId, "u2").items.length], [["第一条和第二条", "只靠第三条"], "ok", 3]);
  await h2.close();
  // 另一位用户打开同一份数据:他没删过,看到完整三条
  const h3 = track(new Host({ file: f, userId: "u2", mind: mind([]), maxDeferMs: 5 }));
  assert.deepEqual([h3.getSummary(before.summaryId).items.length, h3.getSummary(before.summaryId).hiddenItems], [3, 0]);
});

test("模型没成不重试:抛错、超时都记 failed 写明原因,之后再来消息也不替这一段重调;重启打断的记 failed,重做才再调", async () => {
  const f = file();
  const calls: RoundInput[] = [];
  const mode: { now: "throw" | "hang" | "ok" } = { now: "throw" };
  const signals: AbortSignal[] = [];
  const write = async (i: RoundInput, signal: AbortSignal): Promise<MindAction[]> => {
    signals.push(signal);
    if (mode.now === "throw") throw new Error("上游 502");
    if (mode.now === "hang") await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    return perMessage(i);
  };
  const h = track(new Host({ file: f, mind: mind(calls, write), maxDeferMs: 5, summaryTimeoutMs: 60 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  const latest = async () => okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  h.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "二" });
  await settle(h);
  const failed = await latest();
  assert.deepEqual([failed.status, failed.error, failed.items, failed.generatedAt, calls.length], ["failed", "模型调用没成:上游 502", [], null, 1]);
  const m3 = h.send({ roomId: g.id, clientActionId: "m3", text: "三" });
  await settle(h);
  assert.deepEqual([calls.length, all<{ status: string }>(h.db, "SELECT status FROM gg_count_windows").map((w) => w.status)], [1, ["failed"]]);
  // 没生成成的本来就没有正文:区间里再有撤回,它还是 failed,不改成过期
  h.retractMessage(g.id, failed.toSeqInclusive);
  assert.deepEqual([h.getSummary(failed.summaryId).status, h.getSummary(failed.summaryId).staleBySeq, m3.seq > failed.toSeqInclusive], ["failed", null, true]);
  mode.now = "hang";
  h.send({ roomId: g.id, clientActionId: "m4", text: "四" });
  await settle(h);
  const late = await latest();
  // 超时不只是不等了:在途的那次模型调用也被中止
  assert.deepEqual([late.status, late.error, calls.length, signals.at(-1)!.aborted], ["failed", "模型调用没成:等模型超时", 2, true]);
  // 重启打断:第三段开跑后关宿主(第四段已冻结、还在排队),重开后第三段记 failed、不自己再调;第四段没开跑过,关宿主后也不再开跑,重开才生成
  h.send({ roomId: g.id, clientActionId: "m5", text: "五" });
  const m6 = h.send({ roomId: g.id, clientActionId: "m6", text: "六" });
  h.send({ roomId: g.id, clientActionId: "m7", text: "七" });
  const m8 = h.send({ roomId: g.id, clientActionId: "m8", text: "八" });
  await until(() => calls.length === 3, "第三份开跑");
  await h.close();
  assert.equal(calls.length, 3);
  const after_: RoundInput[] = [];
  const h2 = track(new Host({ file: f, mind: mind(after_), maxDeferMs: 5 }));
  const svc2 = createService(h2);
  await settle(h2);
  const [queued, cut] = okValue<{ summaries: TrendSummaryView[] }>(await svc2.handle("summaries.list", { roomId: g.id })).summaries as [TrendSummaryView, TrendSummaryView];
  assert.deepEqual([cut.status, cut.error, cut.toSeqInclusive, queued.status, queued.toSeqInclusive, after_.length, all<{ status: string }>(h2.db, "SELECT status FROM gg_count_windows ORDER BY to_seq").map((w) => w.status)], ["failed", "宿主重启,这次生成被打断;可以重做", m6.seq, "ok", m8.seq, 1, ["failed", "failed", "failed", "done"]]);
  const redo = okValue<TrendSummaryView>(await svc2.handle("summaries.regenerate", { summaryId: cut.summaryId, clientActionId: "r1" }));
  await settle(h2);
  assert.deepEqual([h2.getSummary(redo.summaryId).status, h2.getSummary(redo.summaryId).version, after_.length, all<{ status: string }>(h2.db, "SELECT status FROM gg_count_windows ORDER BY to_seq").map((w) => w.status)], ["ok", 2, 2, ["failed", "failed", "failed", "done"]]);
});

test("撤销承诺后还没生成的那一段不再调模型;不在这个会话里的用户读不到摘要", async () => {
  const f = file();
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: f, mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  h.send({ roomId: g.id, clientActionId: "m1", text: "一" });
  h.send({ roomId: g.id, clientActionId: "m2", text: "二" });
  await settle(h);
  const commitment = okValue<{ commitments: CommitmentView[] }>(await svc.handle("commitments.list", { roomId: g.id })).commitments[0]!;
  // 第二段刚冻结(同一拍里)就撤销:窗口取消,不调模型、不留记录
  h.send({ roomId: g.id, clientActionId: "m3", text: "三" });
  h.send({ roomId: g.id, clientActionId: "m4", text: "四" });
  okValue(await svc.handle("commitments.revoke", { commitmentId: commitment.id, clientActionId: "rv" }));
  await settle(h);
  assert.deepEqual([calls.length, rows(h).map((r) => r.status), all<{ status: string }>(h.db, "SELECT status FROM gg_count_windows ORDER BY to_seq").map((w) => w.status)], [1, ["ok"], ["done", "cancelled"]]);
  const id = rows(h)[0]!.id;
  await h.close();
  const h2 = track(new Host({ file: f, userId: "u9", mind: mind([]), maxDeferMs: 5 }));
  const svc2 = createService(h2);
  assert.deepEqual([errOf(await svc2.handle("summaries.list", { roomId: g.id })), errOf(await svc2.handle("summaries.get", { summaryId: id })), errOf(await svc2.handle("summaries.regenerate", { summaryId: id, clientActionId: "x" }))], [["forbidden", "你不在这个会话里"], ["forbidden", "你不在这个会话里"], ["forbidden", "你不在这个会话里"]]);
  assert.deepEqual(errOf(await svc2.handle("summaries.get", { summaryId: "sum-nope" })), ["not_found", "没有摘要 sum-nope"]);
});

test("到点时联系人已不在这个会话或已被删除:不调模型,记 failed 写明原因", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const b = h.createContact({ name: "小安" });
  const g1 = h.createGroup("甲群", [contact(a.id)]);
  const g2 = h.createGroup("乙群", [contact(b.id)]);
  h.send({ roomId: g1.id, clientActionId: "ask1", text: "每 2 条消息总结一次" });
  h.send({ roomId: g2.id, clientActionId: "ask2", text: "每 2 条消息总结一次" });
  await settle(h);
  // 窗口刚冻结(同一拍里)联系人就被移出 / 被删除
  h.send({ roomId: g1.id, clientActionId: "a1", text: "一" });
  h.send({ roomId: g1.id, clientActionId: "a2", text: "二" });
  h.removeMember(g1.id, contact(a.id));
  h.send({ roomId: g2.id, clientActionId: "b1", text: "一" });
  h.send({ roomId: g2.id, clientActionId: "b2", text: "二" });
  h.removeContact(b.id);
  await settle(h);
  const s1 = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g1.id })).summaries[0]!;
  const s2 = okValue<{ summaries: TrendSummaryView[] }>(await svc.handle("summaries.list", { roomId: g2.id })).summaries[0]!;
  assert.deepEqual([[s1.status, s1.error], [s2.status, s2.error], calls.length], [["failed", "联系人已不在这个会话"], ["failed", "联系人已删除"], 0]);
  assert.deepEqual(errOf(await svc.handle("summaries.regenerate", { summaryId: s2.summaryId, clientActionId: "r" })), ["conflict", "现在不能重做:联系人已删除"]);
});

test("平常轮的承诺账本写明这条承诺到点由宿主另起一轮交给它:联系人不用自己在会话里发总结", async () => {
  const normal: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind([], perMessage, normal), maxDeferMs: 5 }));
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 3 条消息总结一次" });
  await settle(h);
  // 登记之前那一轮的账本里还没有承诺
  assert.equal(normal.at(-1)!.request.blocks[1]!.text.includes("每 3 条消息"), false);
  h.send({ roomId: g.id, clientActionId: "m1", text: "接着聊" });
  await settle(h);
  const ledger = normal.at(-1)!.request.blocks[1]!.text;
  // 这条承诺这一轮没被新消息绑定,只在一行索引里;那句说明跟在承诺 id 后面
  assert.equal(ledger.includes(` · ${summaryLedgerNote(3)} · active · 来源 #`), true, ledger);
  assert.equal(summaryLedgerNote(3), "每 3 条消息一次(宿主替你数,到点另起一轮把那一段交给你写摘要;平常轮不要自己在会话里发总结)");
});

test("时间轴读取:按区间从新到旧,beforeToSeq 翻页,limit 截断时 hasMore 为真", async () => {
  const calls: RoundInput[] = [];
  const h = track(new Host({ file: file(), mind: mind(calls), maxDeferMs: 5 }));
  const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await settle(h);
  const seqs: number[] = [];
  for (let i = 1; i <= 5; i++) {
    seqs.push(h.send({ roomId: g.id, clientActionId: `m${i}`, text: `话 ${i}` }).seq);
    await settle(h);
  }
  const page1 = okValue<{ summaries: TrendSummaryView[]; hasMore: boolean }>(await svc.handle("summaries.list", { roomId: g.id, limit: 2 }));
  const page2 = okValue<{ summaries: TrendSummaryView[]; hasMore: boolean }>(await svc.handle("summaries.list", { roomId: g.id, limit: 2, beforeToSeq: page1.summaries[1]!.toSeqInclusive }));
  const rest = okValue<{ summaries: TrendSummaryView[]; hasMore: boolean }>(await svc.handle("summaries.list", { roomId: g.id, beforeToSeq: page2.summaries[1]!.toSeqInclusive }));
  assert.deepEqual([page1.summaries.map((s) => s.toSeqInclusive), page1.hasMore, page2.summaries.map((s) => s.toSeqInclusive), page2.hasMore, rest.summaries.map((s) => [s.fromSeqExclusive, s.toSeqInclusive]), rest.hasMore], [[seqs[4], seqs[3]], true, [seqs[2], seqs[1]], true, [[seqs[0]! - 1, seqs[0]]], false]);
  assert.equal(calls.length, 5);
});
