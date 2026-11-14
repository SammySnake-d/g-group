// 输入框草稿 reducer(AC-37 ①②、AC-24 迟到回执候选细化 S24-B):按验收文档 AC-37 的夹具逐步核对。
// 群里 #10 作者 @Claude Code、#12 作者 @Argon、#15 作者 @Astra、#18 作者 @Argon(测试名里不写 #:TAP 会把 # 转义成 \#,门禁按名对不上)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDraft, type ClientInputDraft, type DraftOp, draftIssues, draftPreview, draftToSend, emptyDraft, isDraftEmpty, settleDraft } from "./index.ts";

const CLAUDE = { kind: "contact", id: "c-claude" } as const;
const ARGON = { kind: "contact", id: "c-argon" } as const;
const ME = { kind: "user", id: "me" } as const;
const run = (d: ClientInputDraft, ...ops: DraftOp[]) => ops.reduce(applyDraft, d);
const state = (d: ClientInputDraft) => ({ replyToSeq: d.replyToSeq, quotedSeqs: [...d.quotedSeqs], mentions: d.mentions.map((m) => `${m.source}:${m.id}`) });
/** 夹具:先对 #10 点回复,再依次引用 #12/#15/#18,并重复引用一次 #12 */
const fixture = () => run(emptyDraft("g1"), { op: "reply", seq: 10, author: CLAUDE }, { op: "quote", seq: 12 }, { op: "quote", seq: 15 }, { op: "quote", seq: 18 }, { op: "quote", seq: 12 });

test("AC-37 ① 回复消息 10 后连续引用 12/15/18 并重复引用 12:reply=10、quoted=[10,12,15,18] 保序去重,只自动 @Claude Code", () => {
  const d = fixture();
  assert.deepEqual(state(d), { replyToSeq: 10, quotedSeqs: [10, 12, 15, 18], mentions: ["auto:c-claude"] });
  assert.equal(d.draftVer, 4, "回复 1 次 + 有效引用 3 次;重复引用不算改动");
  assert.equal(applyDraft(d, { op: "quote", seq: 12 }), d, "重复引用返回原对象,版本不变");
});

test("AC-37 ① a) 再对消息 12 点回复切换主回复:消息 10 降为普通引用留在原位,auto @ 从 Claude Code 换成 Argon,手打的 @Argon 不动", () => {
  const typed = run(fixture(), { op: "setText", text: "@Argon 你看下" }, { op: "mention", id: "c-argon" });
  const d = applyDraft(typed, { op: "reply", seq: 12, author: ARGON });
  assert.deepEqual(state(d), { replyToSeq: 12, quotedSeqs: [10, 12, 15, 18], mentions: ["manual:c-argon", "auto:c-argon"] });
  assert.equal(d.replyAuthorId, "c-argon");
  assert.equal(d.text, "@Argon 你看下");
});

test("AC-37 ① b) 点当前主回复消息 12 的 [×]:清掉 reply 与它注入的 auto @Argon,用户手打的同一个人的 @Argon 保留", () => {
  const d = applyDraft(run(fixture(), { op: "mention", id: "c-argon" }, { op: "reply", seq: 12, author: ARGON }), { op: "removeQuote", seq: 12 });
  assert.deepEqual(state(d), { replyToSeq: null, quotedSeqs: [10, 15, 18], mentions: ["manual:c-argon"] });
  assert.equal(d.replyAuthorId, null);
});

test("AC-37 ① c) 删尽所有引用块后 reply 为空、quoted=[],手打 @ 仍在", () => {
  const d = applyDraft(run(fixture(), { op: "mention", id: "c-argon" }, { op: "removeQuote", seq: 15 }, { op: "removeQuote", seq: 10 }, { op: "removeQuote", seq: 18 }), { op: "removeQuote", seq: 12 });
  assert.deepEqual(state(d), { replyToSeq: null, quotedSeqs: [], mentions: ["manual:c-argon"] });
});

test("AC-37 ② 逐条 [×]:删普通引用 18 只移除 18,主回复 10 与 auto @ 不动;再引用 18 追加在末尾", () => {
  const removed = applyDraft(fixture(), { op: "removeQuote", seq: 18 });
  assert.deepEqual(state(removed), { replyToSeq: 10, quotedSeqs: [10, 12, 15], mentions: ["auto:c-claude"] });
  const back = applyDraft(removed, { op: "quote", seq: 18 });
  assert.deepEqual(back.quotedSeqs, [10, 12, 15, 18]);
  assert.equal(applyDraft(back, { op: "removeQuote", seq: 99 }), back, "删不在引用里的序号不算改动");
});

test("切换主回复到同一作者的另一条(12→18 都是 Argon):auto @Argon 只有一条,不重复也不丢", () => {
  const d = applyDraft(applyDraft(fixture(), { op: "reply", seq: 12, author: ARGON }), { op: "reply", seq: 18, author: ARGON });
  assert.deepEqual(state(d), { replyToSeq: 18, quotedSeqs: [10, 12, 15, 18], mentions: ["auto:c-argon"] });
});

test("回复自己的消息或宿主卡片不自动 @ 任何人;从联系人消息切到自己的消息时撤掉原 auto @", () => {
  const own = applyDraft(emptyDraft("g1"), { op: "reply", seq: 3, author: ME });
  assert.deepEqual(state(own), { replyToSeq: 3, quotedSeqs: [3], mentions: [] });
  assert.equal(own.replyAuthorId, null);
  const sw = applyDraft(fixture(), { op: "reply", seq: 3, author: { kind: "system", id: "host" } });
  assert.deepEqual(state(sw), { replyToSeq: 3, quotedSeqs: [10, 12, 15, 18, 3], mentions: [] });
});

test("用户手动删掉主回复的 auto @ 后主回复保留;之后再切主回复不会误删手打 @", () => {
  const d = applyDraft(run(fixture(), { op: "unmention", id: "c-claude", source: "auto" }, { op: "mention", id: "c-claude" }), { op: "reply", seq: 12, author: ARGON });
  assert.deepEqual(state(d), { replyToSeq: 12, quotedSeqs: [10, 12, 15, 18], mentions: ["manual:c-claude", "auto:c-argon"] });
  const manualOnly = applyDraft(run(fixture(), { op: "mention", id: "c-claude" }), { op: "unmention", id: "c-claude", source: "manual" });
  assert.deepEqual(state(manualOnly).mentions, ["auto:c-claude"], "按 id + source 精确删,删手打的不动 auto");
});

test("纯函数:不改入参;未改动返回原对象,改动后 draftVer + 1;入参不合格抛错", () => {
  const d0 = emptyDraft("g1");
  const d1 = applyDraft(d0, { op: "setText", text: "你好" });
  assert.deepEqual([d0.text, d0.draftVer, d1.text, d1.draftVer], ["", 0, "你好", 1]);
  assert.equal(applyDraft(d1, { op: "setText", text: "你好" }), d1);
  assert.ok(Object.isFrozen(d1) && Object.isFrozen(d1.quotedSeqs));
  const cleared = applyDraft(fixture(), { op: "clear" });
  assert.deepEqual([state(cleared), cleared.text, cleared.draftVer], [{ replyToSeq: null, quotedSeqs: [], mentions: [] }, "", 5]);
  assert.throws(() => applyDraft(d1, { op: "quote", seq: -1 }), TypeError);
  assert.throws(() => applyDraft(d1, { op: "reply", seq: 1, author: { kind: "robot", id: "x" } as never }), TypeError);
  assert.throws(() => applyDraft(d1, { op: "explode" } as never), /未知草稿操作/);
  assert.throws(() => applyDraft({ ...d1, replyToSeq: 7 }, { op: "quote", seq: 1 }), /主回复 #7 必须在 quotedSeqs 里/);
  const full = Array.from({ length: 50 }, (_, i) => i + 1).reduce((d, s) => applyDraft(d, { op: "quote", seq: s }), d0);
  assert.equal(full.quotedSeqs.length, 50);
  assert.throws(() => applyDraft(full, { op: "quote", seq: 51 }), RangeError);
  assert.throws(() => emptyDraft(""), TypeError);
});

test("AC-24 迟到回执(S24-B):草稿版本等于或早于发送版本整份清空;等回执期间改过就只去掉已发部分,新打的字和新引用保留", () => {
  const sent = run(emptyDraft("g1"), { op: "setText", text: "关于登录模块,我认为" }, { op: "reply", seq: 10, author: CLAUDE }, { op: "quote", seq: 12 });
  const receipt = { roomId: "g1", submittedVer: sent.draftVer, submitted: draftToSend(sent) };
  const same = settleDraft(sent, receipt);
  assert.deepEqual([same.text, state(same), same.draftVer], ["", { replyToSeq: null, quotedSeqs: [], mentions: [] }, 4]);
  const older = settleDraft(run(emptyDraft("g1"), { op: "setText", text: "关于" }), receipt);
  assert.deepEqual([older.text, older.draftVer], ["", 4], "旧于发送版本的草稿已被那一版包含");
  const later = run(sent, { op: "setText", text: "关于登录模块,我认为\n还要加限流" }, { op: "quote", seq: 18 });
  const kept = settleDraft(later, receipt);
  assert.deepEqual([kept.text, state(kept), kept.draftVer], ["还要加限流", { replyToSeq: null, quotedSeqs: [18], mentions: [] }, later.draftVer + 1]);
  const rewritten = applyDraft(sent, { op: "setText", text: "整段重写了" });
  assert.equal(settleDraft(rewritten, receipt).text, "整段重写了", "不是以已发正文开头就不动正文");
});

test("迟到回执:别的会话的回执不动本草稿;回执期间新选的主回复与它的 auto @ 保留", () => {
  const sent = run(emptyDraft("g1"), { op: "setText", text: "A" }, { op: "reply", seq: 10, author: CLAUDE });
  const receipt = { roomId: "g1", submittedVer: sent.draftVer, submitted: draftToSend(sent) };
  assert.equal(settleDraft(sent, { ...receipt, roomId: "g2" }), sent);
  const switched = run(sent, { op: "setText", text: "A B" }, { op: "reply", seq: 20, author: CLAUDE });
  const kept = settleDraft(switched, receipt);
  assert.deepEqual([kept.text, state(kept), kept.replyAuthorId], ["B", { replyToSeq: 20, quotedSeqs: [20], mentions: ["auto:c-claude"] }, "c-claude"]);
  assert.throws(() => settleDraft(sent, { roomId: "g1", submittedVer: -1, submitted: receipt.submitted }), TypeError);
});

test("空草稿判定与会话列表「[草稿]」提示:空白正文不算草稿;正文取第一行前 60 字,只有引用写条数", () => {
  const blank = applyDraft(emptyDraft("g1"), { op: "setText", text: "  \n " });
  assert.equal(isDraftEmpty(blank), true);
  assert.equal(draftPreview(blank), null);
  const typed = applyDraft(blank, { op: "setText", text: "  关于登录模块\n第二行" });
  assert.equal(isDraftEmpty(typed), false);
  assert.equal(draftPreview(typed), "[草稿] 关于登录模块");
  assert.equal(draftPreview(applyDraft(blank, { op: "setText", text: "长".repeat(61) })), `[草稿] ${"长".repeat(60)}…`);
  const quotes = run(blank, { op: "quote", seq: 1 }, { op: "quote", seq: 2 });
  assert.equal(isDraftEmpty(quotes), false);
  assert.equal(draftPreview(quotes), "[草稿] 引用 2 条");
  assert.equal(draftPreview(applyDraft(blank, { op: "mention", id: "c-argon" })), "[草稿] @");
});

test("draftToSend 带出 messages.send 字段与 draftVer;draftIssues 逐条指出不合格的草稿", () => {
  const d = fixture();
  assert.deepEqual(draftToSend(d), { text: "", replyToSeq: 10, quotedSeqs: [10, 12, 15, 18], mentions: [{ id: "c-claude", source: "auto" }], draftVer: 4 });
  assert.deepEqual(draftIssues(d), []);
  assert.deepEqual(draftIssues({ ...d, quotedSeqs: [10, 12, 12] }), ["quotedSeqs 有重复"]);
  assert.deepEqual(draftIssues({ ...d, replyToSeq: null }), ["没有主回复时 replyAuthorId 必须为 null"]);
  assert.deepEqual(draftIssues({ ...d, mentions: [{ id: "c-x", source: "auto" }, { id: "c-x", source: "auto" }] }), ["mentions 有重复"]);
  assert.deepEqual(draftIssues({ ...d, mentions: [{ id: "c-x", source: "bot" }] }), ["mentions 必须是 {id, source: auto|manual} 数组"]);
  assert.deepEqual(draftIssues(null), ["草稿必须是对象"]);
});
