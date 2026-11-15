// PR #97 第一轮返修:失败错误撤回可见性、完整排序键分页、同联系人单飞和生成快照。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { TrendSummaryView } from "@g-group/api-contract";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";
import { SUMMARY_SYSTEM } from "./trend-summary-format.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-trend-r1-"));
const hosts: Host[] = [];
const releaseOnExit: (() => void)[] = [];
let n = 0;
afterEach(async () => {
  for (const release of releaseOnExit.splice(0)) release();
  for (const host of hosts.splice(0)) await host.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, label: string, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`没等到:${label}`);
}
function host(opts: Partial<HostOptions> & Pick<HostOptions, "mind">) {
  const h = new Host({ file: path.join(dir, `${++n}.db`), maxDeferMs: 5, ...opts });
  hosts.push(h);
  return h;
}
async function idle(h: Host) {
  await Promise.race([h.idle(), tick(5000).then(() => { throw new Error("宿主未空闲"); })]);
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  releaseOnExit.push(release);
  return { promise, release };
}
const isSummary = (i: RoundInput) => i.request.blocks[0]!.text.startsWith(SUMMARY_SYSTEM);
function summaryMind(write: (i: RoundInput) => Promise<MindAction[]> | MindAction[] = (i) => [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: `- 已讨论 [#${(i.fresh[0] as { seq: number }).seq}]` }]): ContactMind {
  return {
    async round(input) {
      if (isSummary(input)) return { actions: await write(input), stateNote: null };
      const actions: MindAction[] = [];
      for (const f of input.fresh) if (f.kind === "message" && f.sender.kind === "user" && f.text === "每 1 条消息总结一次") {
        actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: f.text, taskId: null, everyNMessages: 1 });
      }
      return { actions, stateNote: null };
    },
  };
}
type Page = { summaries: TrendSummaryView[]; hasMore: boolean; nextCursor: unknown };
const val = <T>(r: { ok: boolean; value?: unknown; error?: unknown }): T => { assert.ok(r.ok, JSON.stringify(r)); return r.value as T; };

// 不只是清 items:错误、读接口和重启后的记录都不能带原文。
test("R1-01 解析失败含来源原文后撤回:错误不保存原文,get/list 与重启后均不泄漏", async () => {
  const marker = "NEUTRAL_PRIVATE_PR97_R1";
  const f = path.join(dir, `privacy-${++n}.db`);
  const h = new Host({ file: f, mind: () => summaryMind(() => [{ kind: "reply", roomId: "ROOM", replyToSeq: null, text: "" }]), maxDeferMs: 5 });
  hosts.push(h);
  // 输出不含来源,但其正文就是敏感输入。
  const a = h.createContact({ name: "摘要员" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  // 替换为针对实际 room 的脑子通过可变闭包实现
  await h.close();
  hosts.pop();
  const h2 = new Host({ file: f, mind: () => summaryMind((i) => [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: `- ${marker}` }]), maxDeferMs: 5 });
  hosts.push(h2);
  h2.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h2);
  const msg = h2.send({ roomId: g.id, clientActionId: "secret", text: marker });
  await idle(h2);
  const svc = createService(h2);
  const first = val<Page>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.equal(first.status, "failed");
  assert.equal(JSON.stringify(first).includes(marker), false, "失败错误不应保存模型复述的来源原文");
  h2.retractMessage(g.id, msg.seq);
  assert.equal(JSON.stringify(await svc.handle("summaries.get", { summaryId: first.summaryId })).includes(marker), false);
  assert.equal(JSON.stringify(await svc.handle("summaries.list", { roomId: g.id })).includes(marker), false);
  await h2.close();
  hosts.pop();
  const h3 = new Host({ file: f, mind: () => summaryMind(), maxDeferMs: 5 });
  hosts.push(h3);
  assert.equal(JSON.stringify(h3.getSummary(first.summaryId)).includes(marker), false, "重启后仍不可见");
});

test("R1-01 生成期间撤回后解析失败:不把来源原文写进失败错误", async () => {
  const marker = "NEUTRAL_DURING_PR97_R1";
  const gate = deferred();
  let started = false;
  const h = host({ mind: () => summaryMind(async (i) => { started = true; await gate.promise; return [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: `- ${marker}` }]; }) });
  const a = h.createContact({ name: "摘要员" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  const msg = h.send({ roomId: g.id, clientActionId: "secret", text: marker });
  await until(() => started, "摘要已读取消息");
  h.retractMessage(g.id, msg.seq);
  gate.release();
  await idle(h);
  const result = val<Page>(await createService(h).handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(h.db.store.db.prepare("SELECT error,items FROM gg_summaries").all()).includes(marker), false, "持久字段不能保留原文");
});

test("R1-01 模型错误回显来源时:失败错误不存或向本端删除的用户暴露原文", async () => {
  const marker = "NEUTRAL_THROW_PR97_R1";
  const h = host({ mind: () => summaryMind(() => { throw new Error(`模型拒绝:${marker}`); }) });
  const a = h.createContact({ name: "摘要员" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  const msg = h.send({ roomId: g.id, clientActionId: "secret", text: marker });
  await idle(h);
  const svc = createService(h);
  const s = val<Page>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.equal(s.status, "failed");
  assert.equal(JSON.stringify(s).includes(marker), false, "上游错误也不能保存来源正文");
  val(await svc.handle("messages.delete", { roomId: g.id, seqs: [msg.seq], clientActionId: "hide" }));
  assert.equal(JSON.stringify(await svc.handle("summaries.get", { summaryId: s.summaryId })).includes(marker), false);
});

test("R1-01 旧版遗留失败错误在撤回时同事务清空,重启后不可恢复", async () => {
  const marker = "NEUTRAL_LEGACY_PR97_R1";
  const h = host({ mind: () => summaryMind((i) => [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: "- 无来源" }]) });
  const a = h.createContact({ name: "摘要员" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  const msg = h.send({ roomId: g.id, clientActionId: "secret", text: marker });
  await idle(h);
  const s = val<Page>(await createService(h).handle("summaries.list", { roomId: g.id })).summaries[0]!;
  h.db.store.db.prepare("UPDATE gg_summaries SET error = ? WHERE id = ?").run(marker, s.summaryId);
  h.retractMessage(g.id, msg.seq);
  const row = h.db.store.db.prepare("SELECT error FROM gg_summaries WHERE id = ?").get(s.summaryId);
  assert.equal(JSON.stringify(row).includes(marker), false, "撤回事务清理旧记录的错误");
  assert.equal(JSON.stringify(h.getSummary(s.summaryId)).includes(marker), false);
});

test("R1-02 同终点不同联系人:limit=1 按 nextCursor 翻页不重不漏", async () => {
  const h = host({ mind: () => summaryMind() });
  const a = h.createContact({ name: "甲" });
  const b = h.createContact({ name: "乙" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  const target = h.send({ roomId: g.id, clientActionId: "m", text: "同一区间" });
  await idle(h);
  const svc = createService(h);
  const all = val<Page>(await svc.handle("summaries.list", { roomId: g.id, limit: 200 }));
  assert.equal(all.summaries.filter((s) => s.toSeqInclusive === target.seq).length, 2);
  const page1 = val<Page>(await svc.handle("summaries.list", { roomId: g.id, limit: 1 }));
  assert.ok(page1.hasMore && page1.nextCursor, "还有摘要必须给完整游标");
  const page2 = val<Page>(await svc.handle("summaries.list", { roomId: g.id, limit: 1, cursor: page1.nextCursor } as never));
  assert.deepEqual([...page1.summaries, ...page2.summaries].map((s) => s.summaryId).sort(), all.summaries.map((s) => s.summaryId).sort());
  assert.equal(new Set([...page1.summaries, ...page2.summaries].map((s) => s.summaryId)).size, 2);
});

test("R1-02 同终点历史多版本:includeSuperseded 用 nextCursor 逐页不重不漏", async () => {
  const h = host({ mind: () => summaryMind((i) => [{ kind: "reply", roomId: i.fresh[0]!.roomId, replyToSeq: null, text: "- 无来源" }]) });
  const a = h.createContact({ name: "甲" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  h.send({ roomId: g.id, clientActionId: "m", text: "待总结" });
  await idle(h);
  const svc = createService(h);
  const first = val<Page>(await svc.handle("summaries.list", { roomId: g.id })).summaries[0]!;
  const second = val<TrendSummaryView>(await svc.handle("summaries.regenerate", { summaryId: first.summaryId, clientActionId: "redo" }));
  await idle(h);
  const page1 = val<Page>(await svc.handle("summaries.list", { roomId: g.id, includeSuperseded: true, limit: 1 }));
  assert.ok(page1.hasMore && page1.nextCursor);
  const page2 = val<Page>(await svc.handle("summaries.list", { roomId: g.id, includeSuperseded: true, limit: 1, cursor: page1.nextCursor } as never));
  assert.deepEqual([...page1.summaries, ...page2.summaries].map((s) => s.summaryId), [second.summaryId, first.summaryId]);
  assert.equal(page2.hasMore, false);
});

test("R1-03 同联系人普通轮在途:另一群摘要排队,两次推理绝不重叠", async () => {
  const gate = deferred();
  let normalStarted = false, summaryStarted = false, active = 0, maxActive = 0;
  const base = summaryMind();
  const mind: ContactMind = { async round(i, s) {
    const hold = !isSummary(i) && i.fresh.some((f) => f.kind === "message" && f.text === "阻塞普通轮");
    if (isSummary(i)) summaryStarted = true;
    active++; maxActive = Math.max(maxActive, active);
    try { if (hold) { normalStarted = true; await gate.promise; } return await base.round(i, s); } finally { active--; }
  } };
  const h = host({ mind: () => mind });
  const a = h.createContact({ name: "甲" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  const dm = h.openDm(a.id);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  h.send({ roomId: dm.id, clientActionId: "hold", text: "阻塞普通轮" });
  await until(() => normalStarted, "普通轮开始");
  h.send({ roomId: g.id, clientActionId: "go", text: "摘要触发" });
  await tick(80);
  assert.equal(summaryStarted, false, "普通轮在途时摘要应排队");
  gate.release();
  await idle(h);
  assert.equal(summaryStarted, true);
  assert.equal(maxActive, 1);
});

test("R1-03 同联系人摘要轮在途:另一会话普通轮排队,不同联系人仍可运行", async () => {
  const gate = deferred();
  let summaryStarted = false, sameNormal = false, otherNormal = false;
  let aId = "", bId = "";
  const base = summaryMind();
  const mind: ContactMind = { async round(i, s) {
    if (i.contact.id === aId && isSummary(i)) { summaryStarted = true; await gate.promise; }
    if (!isSummary(i) && i.fresh.some((f) => f.kind === "message" && f.text === "普通消息")) {
      if (i.contact.id === aId) sameNormal = true;
      if (i.contact.id === bId) otherNormal = true;
    }
    return base.round(i, s);
  } };
  const h = host({ mind: () => mind });
  const a = h.createContact({ name: "甲" }); aId = a.id;
  const b = h.createContact({ name: "乙" }); bId = b.id;
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  const dmA = h.openDm(a.id), dmB = h.openDm(b.id);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  h.send({ roomId: g.id, clientActionId: "go", text: "摘要触发" });
  await until(() => summaryStarted, "摘要开始");
  h.send({ roomId: dmA.id, clientActionId: "same", text: "普通消息" });
  h.send({ roomId: dmB.id, clientActionId: "other", text: "普通消息" });
  await until(() => otherNormal, "另一联系人可以运行");
  assert.equal(sameNormal, false, "摘要在途时相同联系人不能并发");
  gate.release();
  await idle(h);
  assert.equal(sameNormal, true);
});

test("R1-04 摘要记生成完成时点,更换说话模型后历史仍保留生成快照", async () => {
  let now = "2026-11-14T10:00:00.000Z";
  const h = host({ now: () => now, mind: () => summaryMind() });
  const a = h.createContact({ name: "甲" });
  const g = h.createGroup("群", [{ kind: "contact", id: a.id }]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 1 条消息总结一次" });
  await idle(h);
  now = "2026-11-14T10:01:00.000Z";
  h.send({ roomId: g.id, clientActionId: "m", text: "会话内容" });
  await idle(h);
  const before = val<Page>(await createService(h).handle("summaries.list", { roomId: g.id })).summaries[0]!;
  assert.equal(before.generatedAt, now, "生成时点必须是真实生成时刻");
  h.updateContact(a.id, { speakingModel: "review-current-model", confirmAffected: true });
  assert.deepEqual(h.getSummary(before.summaryId).model, { speakingModel: a.speakingModel }, "历史摘要保留生成时模型");
});
