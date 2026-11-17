// 输入框草稿落盘(AC-24、AC-37 ②):按会话独立、重启还在、按 draftVer CAS、发送回执只清对应版本;草稿不是消息,不进联系人注意循环。
// 以及 AC-37 ① 发送落盘:reply_to_seq 与 quoted_seqs 正交存储,引用保序去重,主回复一定在引用里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ApiResult, MethodName, ServerEvent } from "@g-group/api-contract";
import { one } from "./db.ts";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { type Service, createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-drafts-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `d${++n}.db`);
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
const call = async <M extends MethodName>(svc: Service, m: M, p: unknown) => (await svc.handle(m, p)) as ApiResult<M>;
const body = (over: Record<string, unknown> = {}) => ({ text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 1, ...over });

test("AC-24 / AC-37 ② 草稿按会话独立保存,切到别的会话不串;重启宿主后正文、主回复、引用、@ 与版本原样还在", async () => {
  const f = file();
  const host = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "Claude Code" });
  const g = host.createGroup("登录模块", [{ kind: "contact", id: a.id }]);
  const dm = host.openDm(a.id);
  const groupDraft = body({ text: "关于登录模块,我认为还要加上", replyToSeq: 10, replyAuthorId: a.id, quotedSeqs: [10, 12, 15, 18], mentions: [{ id: a.id, source: "auto" }, { id: "c-argon", source: "manual" }], draftVer: 7 });
  const saved = await call(svc, "drafts.save", { roomId: g.id, expectedVer: 0, draft: groupDraft });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.ok((await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 0, draft: body({ text: "私聊里回一句", draftVer: 1 }) })).ok);
  const dmView = await call(svc, "drafts.get", { roomId: dm.id });
  assert.deepEqual(dmView.ok && [dmView.value.text, dmView.value.quotedSeqs], ["私聊里回一句", []], "私聊草稿不串入群里的文字和引用");
  await settle(host);
  await host.close();

  const again = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const back = await call(createService(again), "drafts.get", { roomId: g.id });
  assert.ok(back.ok);
  const { updatedAt: _u, roomId, ...rest } = back.value as unknown as Record<string, unknown>;
  assert.deepEqual({ roomId, ...rest }, { roomId: g.id, ...groupDraft });
  assert.equal(again.roomView(g.id).draftPreview, "[草稿] 关于登录模块,我认为还要加上");
  assert.equal(again.roomView(dm.id).draftPreview, "[草稿] 私聊里回一句");
  const fresh = again.createGroup("新群", []);
  assert.equal("draftPreview" in again.roomView(fresh.id), false, "没存过草稿的会话不带提示");
  const empty = await call(createService(again), "drafts.get", { roomId: fresh.id });
  assert.deepEqual(empty.ok && [empty.value.draftVer, empty.value.text, empty.value.updatedAt], [0, "", null]);
  await again.close();
});

test("drafts.save 按 draftVer CAS:旧版本写入返回 conflict 并带当前草稿,不静默覆盖;版本不前进与不合格草稿被拒", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const dm = host.openDm(host.createContact({ name: "小克" }).id);
  assert.ok((await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 0, draft: body({ text: "主窗口", draftVer: 2 }) })).ok);
  const stale = await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 0, draft: body({ text: "侧边栏", draftVer: 1 }) });
  assert.equal(!stale.ok && stale.error.code, "conflict");
  const current = !stale.ok ? (stale.error.detail as { current: { text: string; draftVer: number } }).current : null;
  assert.deepEqual(current && [current.text, current.draftVer], ["主窗口", 2]);
  const kept = await call(svc, "drafts.get", { roomId: dm.id });
  assert.deepEqual(kept.ok && [kept.value.text, kept.value.draftVer], ["主窗口", 2], "冲突的写入没有落盘");
  const notForward = await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 2, draft: body({ text: "x", draftVer: 2 }) });
  assert.equal(!notForward.ok && notForward.error.code, "invalid_params");
  const replyNotQuoted = await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 2, draft: body({ replyToSeq: 3, quotedSeqs: [1], draftVer: 3 }) });
  assert.equal(!replyNotQuoted.ok && replyNotQuoted.error.code, "invalid_params");
  assert.match(!replyNotQuoted.ok ? replyNotQuoted.error.message : "", /主回复 #3 必须在 quotedSeqs 里/);
  const next = await call(svc, "drafts.save", { roomId: dm.id, expectedVer: 2, draft: body({ text: "主窗口继续", draftVer: 3 }) });
  assert.deepEqual(next.ok && [next.value.text, next.value.draftVer], ["主窗口继续", 3]);
  const missing = await call(svc, "drafts.get", { roomId: "g-nope" });
  assert.equal(!missing.ok && missing.error.code, "not_found");
  await host.close();
});

test("草稿不是消息:反复保存不产生会话事件、不进待处理输入、不触发联系人轮次;对照:真发一条就触发", async () => {
  let rounds = 0;
  const host = new Host({ file: file(), mind: () => scriptedMind({ onRound: () => rounds++ }), maxDeferMs: 5 });
  const events: ServerEvent["type"][] = [];
  host.bus.subscribe((e) => events.push(e.type));
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  events.length = 0;
  for (let v = 1; v <= 5; v++) host.saveDraft(dm.id, v - 1, body({ text: `帮我写报告 ${v}`, draftVer: v }));
  await settle(host);
  assert.equal(rounds, 0, "联系人没有被唤醒");
  assert.equal(host.lastSeq(dm.id), 0, "会话日志里没有新事件");
  assert.equal(one<{ n: number }>(host.db, "SELECT count(*) AS n FROM gg_inbox WHERE contact_id = ?", c.id)?.n, 0);
  assert.deepEqual([...new Set(events)].sort(), ["draft.updated", "room.updated"]);
  host.send({ roomId: dm.id, clientActionId: "s1", text: "你好" });
  await settle(host);
  assert.equal(rounds, 1, "对照:真消息会送达联系人");
  await host.close();
});

test("AC-24 发送带 draftVer:版本一致整份清空;等回执期间草稿已更新只去掉已发部分(S24-B);不带 draftVer 不动草稿", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const g = host.createGroup("群", []);
  const drafts: { text: string; draftVer: number }[] = [];
  host.bus.subscribe((e) => {
    if (e.type === "draft.updated") drafts.push({ text: e.draft.text, draftVer: e.draft.draftVer });
  });
  host.saveDraft(g.id, 0, body({ text: "第一条", draftVer: 2 }));
  const s1 = await call(svc, "messages.send", { roomId: g.id, clientActionId: "a1", text: "第一条", draftVer: 2 });
  assert.ok(s1.ok, JSON.stringify(s1));
  const cleared = host.draft(g.id);
  assert.deepEqual([cleared.text, cleared.draftVer], ["", 3]);
  assert.equal(host.roomView(g.id).draftPreview, null);
  assert.deepEqual(drafts.at(-1), { text: "", draftVer: 3 });

  // 点发送(v4)后、回执前用户继续打字并引用了 #1:v5 先落盘,v4 的回执后到
  host.saveDraft(g.id, 3, body({ text: "第二条", quotedSeqs: [], draftVer: 4 }));
  host.saveDraft(g.id, 4, body({ text: "第二条\n第三条接着写", quotedSeqs: [1], draftVer: 5 }));
  assert.ok((await call(svc, "messages.send", { roomId: g.id, clientActionId: "a2", text: "第二条", draftVer: 4 })).ok);
  const late = host.draft(g.id);
  assert.deepEqual([late.text, late.quotedSeqs, late.draftVer], ["第三条接着写", [1], 6], "迟到回执没有误删 v5 新打的字和新引用");
  assert.ok((await call(svc, "messages.send", { roomId: g.id, clientActionId: "a2", text: "第二条", draftVer: 4 })).ok, "同一动作号重放");
  assert.deepEqual([host.draft(g.id).text, host.draft(g.id).draftVer], ["第三条接着写", 6], "重放不再动草稿");
  assert.ok((await call(svc, "messages.send", { roomId: g.id, clientActionId: "a3", text: "第三条接着写" })).ok);
  assert.deepEqual([host.draft(g.id).text, host.draft(g.id).draftVer], ["第三条接着写", 6], "对照:不带 draftVer 的发送不碰草稿");
  await settle(host);
  await host.close();
});

test("AC-37 ① 发送落盘:reply_to_seq 与 quoted_seqs 正交存储,引用保序去重,主回复不在引用里时补在末尾;auto/manual @ 原样保留,重启后不变", async () => {
  const f = file();
  const host = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "Claude Code" });
  const g = host.createGroup("群", [{ kind: "contact", id: a.id }]);
  for (const t of ["一", "二", "三"]) host.send({ roomId: g.id, clientActionId: `m-${t}`, text: t });
  const r1 = await call(svc, "messages.send", {
    roomId: g.id,
    clientActionId: "r1",
    text: "看这几条",
    replyToSeq: 1,
    quotedSeqs: [1, 2, 3, 2],
    mentions: [{ id: a.id, source: "auto" }, { id: a.id, source: "manual" }],
  });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.deepEqual(r1.ok && [r1.value.replyToSeq, r1.value.quotedSeqs, r1.value.mentions], [1, [1, 2, 3], [{ id: a.id, source: "auto" }, { id: a.id, source: "manual" }]]);
  const r2 = host.send({ roomId: g.id, clientActionId: "r2", text: "回 #3", replyToSeq: 3, quotedSeqs: [2] });
  assert.deepEqual([r2.replyToSeq, r2.quotedSeqs], [3, [2, 3]]);
  const r3 = host.send({ roomId: g.id, clientActionId: "r3", text: "只引用", quotedSeqs: [2, 1] });
  assert.deepEqual([r3.replyToSeq, r3.quotedSeqs], [null, [2, 1]], "对照:只引用不设主回复");
  await settle(host);
  await host.close();
  const again = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const stored = again.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "user").map((m) => [m.replyToSeq, m.quotedSeqs]);
  assert.deepEqual(stored.slice(-3), [[1, [1, 2, 3]], [3, [2, 3]], [null, [2, 1]]]);
  await again.close();
});
