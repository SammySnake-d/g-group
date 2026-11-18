// 联系人长期记忆的对外接口(需求文档 D25 第 4 节;验收 AC-42 ⑤⑧⑨、AC-54):memory.list / get / revoke / rebuild 只给用户本人;
// revoke 走 D25 状态机标已撤销、不物理删除、之后不进上下文;rebuild 从 md 真源重建;contacts.profile 的长期记忆接真实条目。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactProfileView, MemoryView } from "@g-group/api-contract";
import type { MindAction, RoundInput } from "@g-group/kernel";
import { appendEvent } from "@g-group/adapter-sqlite";
import { all, run } from "./db.ts";
import { Host } from "./host.ts";
import { MemoryCoverage, type CaptureWrite } from "./memory-coverage.ts";
import { LONG_TERM_TOP, getMemoryView, listMemoryViews, longTermMemory, rebuildMemories, revokeMemory } from "./memory-api.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-memapi-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let no = 0;
const fresh = () => {
  const d = path.join(dir, `d${++no}`);
  mkdirSync(d, { recursive: true });
  return { file: path.join(d, "gg.db"), dataDir: d };
};
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
/** 「以后所有…」记全局;「记:xxx」记挂会话锚点的条目;「改:旧=>新」把正文为「旧」的条目改成「新」(change 关系) */
function memoryMind(reqs: RoundInput["request"][], host: () => Host, contactId: () => string) {
  return () => ({
    async round(i: RoundInput) {
      reqs.push(i.request);
      const m = [...i.fresh].reverse().find((f) => f.kind === "message");
      const actions: MindAction[] = [];
      if (m?.kind === "message") {
        const base = { kind: "remember" as const, roomId: m.roomId, sourceSeq: m.seq, quote: null, relation: null, target: null };
        if (m.text.startsWith("以后所有")) actions.push({ ...base, title: "回复格式", text: m.text, anchors: ["global"], quote: m.text });
        else if (m.text.startsWith("记:")) actions.push({ ...base, title: `要点 ${m.text.slice(2, 4)}`, text: m.text.slice(2), anchors: [`room:${m.roomId}`] });
        else if (m.text.startsWith("改:")) {
          const [from, to] = m.text.slice(2).split("=>");
          const target = host().listMemories(contactId()).find((e) => e.body === from)!.id;
          actions.push({ ...base, title: "改过的要点", text: to!, anchors: [`room:${m.roomId}`], relation: "change", target });
        }
      }
      return { actions, stateNote: null };
    },
  });
}
function setup(o = fresh()) {
  const reqs: RoundInput["request"][] = [];
  let cid = "";
  const host: Host = new Host({ ...o, maxDeferMs: 5, mind: memoryMind(reqs, () => host, () => cid) });
  const svc = createService(host);
  const add = (name: string) => {
    const c = host.createContact({ name });
    cid = c.id;
    return { c, dm: host.openDm(c.id) };
  };
  const say = async (roomId: string, k: string, text: string) => {
    const m = host.send({ roomId, clientActionId: k, text });
    await settle(host);
    return m.seq;
  };
  return { host, svc, reqs, add, say, o };
}
async function value<T>(p: Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value as T;
}
async function code(p: Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>) {
  const r = await p;
  return r.ok ? "ok" : r.error.code;
}
const b5 = (r: RoundInput["request"]) => r.blocks[4]!.text;

test("memory.list / get:按准入分 prefix / anchored、按对外状态筛,get 给全文与关系;联系人或别的用户身份来调 forbidden,联系人或条目不存在 not_found", async () => {
  const { host, svc, add, say } = setup();
  const { c, dm } = add("小克");
  await say(dm.id, "1", "以后所有回复都先给结论");
  await say(dm.id, "2", "记:审查交给 Astra");
  await say(dm.id, "3", "改:审查交给 Astra=>审查改交 Codex");
  const list = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: c.id }));
  const by = Object.fromEntries(list.memories.map((v) => [v.body, v]));
  assert.deepEqual(
    list.memories.map((v) => [v.body, v.scope, v.status, v.state, v.effective]),
    [
      ["以后所有回复都先给结论", "prefix", "active", "active", true],
      ["审查交给 Astra", "anchored", "superseded", "superseded", false],
      ["审查改交 Codex", "anchored", "active", "active", true],
    ],
  );
  assert.deepEqual(by.以后所有回复都先给结论!.source, { roomId: dm.id, seq: 1, userQuote: true });
  const prefix = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: c.id, scope: "prefix" }));
  assert.deepEqual(prefix.memories.map((v) => v.body), ["以后所有回复都先给结论"]);
  const old = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: c.id, status: "superseded" }));
  assert.deepEqual(old.memories.map((v) => v.id), [by["审查交给 Astra"]!.id]);
  const got = await value<MemoryView>(svc.handle("memory.get", { contactId: c.id, memoryId: by["审查改交 Codex"]!.id }));
  assert.deepEqual([got.body, got.supersedes, got.anchors], ["审查改交 Codex", [by["审查交给 Astra"]!.id], [`room:${dm.id}`]]);

  assert.throws(() => listMemoryViews(host, { kind: "contact", id: c.id }, { contactId: c.id }), { code: "forbidden" });
  assert.throws(() => getMemoryView(host, { kind: "user", id: "someone-else" }, { contactId: c.id, memoryId: got.id }), { code: "forbidden" });
  assert.throws(() => revokeMemory(host, { kind: "contact", id: c.id }, { contactId: c.id, memoryId: got.id, clientActionId: "x" }), { code: "forbidden" });
  assert.equal(host.listMemories(c.id).find((e) => e.id === got.id)!.status, "active", "被拒的撤销什么都不改");
  assert.equal(await code(svc.handle("memory.get", { contactId: c.id, memoryId: "m-不存在" })), "not_found");
  assert.equal(await code(svc.handle("memory.list", { contactId: "c-不存在" })), "not_found");
  await host.close();
});

test("memory.revoke:按状态机改已撤销并升版本,md 文件与索引行都在(不物理删除);下一轮不进上下文;再撤销原样返回;已替代的 conflict", async () => {
  const { host, svc, reqs, add, say, o } = setup();
  const { c, dm } = add("小克");
  await say(dm.id, "1", "记:部署前先跑测试");
  await say(dm.id, "2", "记:审查交给 Astra");
  await say(dm.id, "3", "改:审查交给 Astra=>审查改交 Codex");
  await say(dm.id, "4", "问");
  assert.match(b5(reqs.at(-1)!), /部署前先跑测试/);
  const target = host.listMemories(c.id).find((e) => e.body === "部署前先跑测试")!;
  const r = await value<MemoryView>(svc.handle("memory.revoke", { contactId: c.id, memoryId: target.id, clientActionId: "rv1" }));
  assert.deepEqual([r.status, r.state, r.version, r.effective], ["revoked", "revoked", target.version + 1, false]);
  const md = path.join(o.dataDir, "memory", c.id, `${target.id}.md`);
  assert.equal(existsSync(md), true, "md 真源还在");
  assert.match(readFileSync(md, "utf8"), /"status": "revoked"/);
  assert.equal(all(host.db, "SELECT id FROM gg_memory WHERE contact_id = ? AND id = ?", c.id, target.id).length, 1, "索引行还在");
  await say(dm.id, "5", "问");
  assert.doesNotMatch(reqs.at(-1)!.blocks.map((x) => x.text).join("\n"), /部署前先跑测试/, "撤销后不进上下文");
  const again = await value<MemoryView>(svc.handle("memory.revoke", { contactId: c.id, memoryId: target.id, clientActionId: "rv2" }));
  assert.equal(again.version, target.version + 1, "再撤销原样返回,不再升版本");
  const superseded = host.listMemories(c.id).find((e) => e.body === "审查交给 Astra")!;
  assert.equal(await code(svc.handle("memory.revoke", { contactId: c.id, memoryId: superseded.id, clientActionId: "rv3" })), "conflict");
  assert.equal(host.listMemories(c.id).length, 3, "条目一条没少");
  await host.close();
});

test("contacts.profile 的长期记忆接真实条目:按准入分前缀 / 锚点两类给生效条数与最近几条,来源已撤回与已失效分开计数", async () => {
  const { host, svc, add, say } = setup();
  const { c, dm } = add("小克");
  await say(dm.id, "1", "以后所有回复都先给结论");
  await say(dm.id, "2", "记:周报发给小王");
  await say(dm.id, "3", "记:部署前先跑测试");
  const gone = await say(dm.id, "4", "记:密钥放在 NEUTRAL_FIXTURE_NO_CREDENTIALS");
  await say(dm.id, "5", "记:审查交给 Astra");
  const astra = host.listMemories(c.id).find((e) => e.body === "审查交给 Astra")!;
  await value(svc.handle("memory.revoke", { contactId: c.id, memoryId: astra.id, clientActionId: "rv" }));
  host.retractMessage(dm.id, gone);
  await settle(host);
  const lt = longTermMemory(host, c.id);
  assert.deepEqual([lt.prefix.count, lt.anchored.count, lt.sourceRetracted, lt.inactive], [1, 2, 1, 1]);
  assert.deepEqual(lt.prefix.items.map((v) => v.body), ["以后所有回复都先给结论"]);
  assert.deepEqual(lt.anchored.items.map((v) => v.body).sort(), ["周报发给小王", "部署前先跑测试"].sort());
  const p = await value<ContactProfileView>(svc.handle("contacts.profile", { contactId: c.id }));
  assert.deepEqual(p.memory.longTerm, lt, "contacts.profile 经合同返回的就是这份概览");
  for (let k = 0; k < LONG_TERM_TOP; k++) await say(dm.id, `more${k}`, `记:补充要点${k}号`);
  const many = longTermMemory(host, c.id);
  assert.deepEqual([many.anchored.count, many.anchored.items.length], [2 + LONG_TERM_TOP, LONG_TERM_TOP], "计数是全部生效条目,条目只给最近更新的前几条");
  assert.equal(many.anchored.items[0]!.body, `补充要点${LONG_TERM_TOP - 1}号`, "最近更新的排在前面");
  await host.close();
});

test("memory.rebuild:用户触发从 md 真源重建,删掉索引后读回的条目与重建前一致;不给 contactId 就重建全部联系人;联系人身份调用 forbidden", async () => {
  const { host, svc, add, say } = setup();
  const a = add("小克");
  await say(a.dm.id, "1", "记:周报发给小王");
  await say(a.dm.id, "2", "记:部署前先跑测试");
  const z = add("小研");
  await say(z.dm.id, "3", "记:实验数据放共享盘");
  const before = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: a.c.id }));
  const beforeZ = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: z.c.id }));
  assert.equal(before.memories.length, 2);
  run(host.db, "DELETE FROM gg_memory");
  assert.deepEqual((await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: a.c.id }))).memories, [], "索引已删");
  const one = await value<{ contacts: { contactId: string; entries: number }[] }>(svc.handle("memory.rebuild", { contactId: a.c.id }));
  assert.deepEqual(one.contacts, [{ contactId: a.c.id, entries: 2 }]);
  assert.deepEqual(await value(svc.handle("memory.list", { contactId: a.c.id })), before, "读回与重建前一致");
  run(host.db, "DELETE FROM gg_memory");
  assert.throws(() => rebuildMemories(host, { kind: "contact", id: a.c.id }, {}), { code: "forbidden" });
  assert.deepEqual(all(host.db, "SELECT id FROM gg_memory"), [], "被拒的重建什么都不做");
  const every = rebuildMemories(host, { kind: "user", id: host.userId }, {});
  assert.deepEqual(every.contacts.map((x) => [x.contactId, x.entries]).sort(), [[a.c.id, 2], [z.c.id, 1]].sort());
  assert.deepEqual(await value(svc.handle("memory.list", { contactId: z.c.id })), beforeZ);
  assert.equal(await code(svc.handle("memory.rebuild", { contactId: "c-不存在" })), "not_found");
  await host.close();
});

test("P1A Host structured reflect validates per-message verbatim evidence and records coverage", async () => {
  const o = fresh(); let seq = 0; let roomId = "";
  const host = new Host({ ...o, maxDeferMs: 1, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }), compactor: () => ({ async compact() { return "note"; }, async reflect() { return { note: "note", personaSuggestion: null, memories: [
    { title: "legitimate", text: "中文回复", anchors: ["global"], relation: null, target: null, roomId, sourceSeq: seq, evidence: "以后都用中文回复" },
    { title: "valid two", text: "中文回复格式", anchors: ["global"], relation: null, target: null, roomId, sourceSeq: seq, evidence: "以后都用中文回复" },
    { title: "fabrication", text: "English", anchors: ["global"], relation: null, target: null, roomId, sourceSeq: seq, evidence: "以后都用英文回复" },
  ] }; } }) });
  try {
    const c = host.createContact({ name: "c" }); roomId = host.openDm(c.id).id;
    seq = host.send({ roomId, clientActionId: "capture", text: "以后都用中文回复" }).seq;
    await settle(host);
    assert.deepEqual(host.listMemories(c.id).map(x => x.title).sort(), ["legitimate", "valid two"]);
    const { MemoryCoverage } = await import("./memory-coverage.ts");
    const coverage = new MemoryCoverage(host.db, host.memory).list(c.id);
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]?.state, "failed"); assert.equal(coverage[0]?.unresolved, 1);
    assert.equal(coverage[0]?.writes?.length, 2, "all valid writes stay in the batch for recovery");
    assert.equal(host.listMemories(c.id)[0]?.source?.seq, seq);
  } finally { await host.close(); }
});

test("P1A structured reflect ignores a source-retracted entry when planning relations", async () => {
  const o = fresh(); let seq = 0; let roomId = ""; let round = 0;
  const host = new Host({ ...o, maxDeferMs: 1, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }), compactor: () => ({ async compact() { return "note"; }, async reflect() {
    round++; return { note: "note", personaSuggestion: null, memories: [{ title: "preference", text: "以后都用中文回复", anchors: ["global"], relation: null, target: null, roomId, sourceSeq: seq, evidence: "以后都用中文回复" }] };
  } }) });
  try {
    const c = host.createContact({ name: "c" }); roomId = host.openDm(c.id).id;
    seq = host.send({ roomId, clientActionId: "one", text: "以后都用中文回复" }).seq; await settle(host);
    const old = host.listMemories(c.id)[0]!; host.retractMessage(roomId, seq); await settle(host);
    seq = host.send({ roomId, clientActionId: "two", text: "以后都用中文回复" }).seq; await settle(host);
    const visible = host.listMemories(c.id);
    assert.ok(round >= 3);
    const fresh = visible.find(e => e.source?.seq === seq);
    assert.ok(fresh, "new message gets a memory anchored to its own source");
    assert.notEqual(fresh.id, old.id);
  } finally { await host.close(); }
});

test("P1A stale group reply during reflect abandons all structured capture writes", async () => {
  const o = fresh(); let roomId = ""; let otherId = ""; let seq = 0;
  const reports: { what: string; detail: unknown }[] = [];
  const host = new Host({ ...o, maxDeferMs: 1,
    onReport: (what, detail) => reports.push({ what, detail }),
    mind: () => ({ async round() { return { actions: [{ kind: "reply" as const, roomId, text: "stale draft", replyToSeq: seq }], stateNote: null }; } }),
    compactor: () => ({ async compact() { return "note"; }, async reflect() {
      appendEvent(host.db.store, `room:${roomId}`, { kind: "contact", id: otherId }, { kind: "message", text: "another contact spoke during reflect" }, new Date().toISOString());
      return { note: "note", personaSuggestion: null, memories: [{ title: "stale preference", text: "中文回复", anchors: ["global"], relation: null, target: null, roomId, sourceSeq: seq, evidence: "以后都用中文回复" }] };
    } }),
  });
  try {
    const c = host.createContact({ name: "speaker" }); otherId = host.createContact({ name: "other" }).id;
    roomId = host.createGroup("stale capture", [{ kind: "contact", id: c.id }, { kind: "contact", id: otherId }]).id;
    seq = appendEvent(host.db.store, `room:${roomId}`, { kind: "user", id: host.userId }, { kind: "message", text: "以后都用中文回复" }, new Date().toISOString()).seq;
    assert.equal(await host.runRound(c.id, new AbortController().signal), "stale");
    assert.ok(reports.some(r => r.what === "stale-round" && (r.detail as { newer?: number[] }).newer?.includes(seq + 1)), "commitRound detects the other contact's new message");
    assert.equal(host.listMessages(roomId, {}).messages.some(m => m.text === "stale draft"), false);
    const files = existsSync(path.join(o.dataDir, "memory")) ? readdirSync(path.join(o.dataDir, "memory"), { recursive: true }) : [];
    assert.deepEqual(files.filter(f => String(f).endsWith(".md")), [], "abandoned round leaves no md source");
    assert.deepEqual(all(host.db, "SELECT * FROM gg_memory"), [], "abandoned round leaves no memory index");
    assert.deepEqual(all(host.db, "SELECT * FROM docs WHERE key LIKE 'memory-coverage:%'"), [], "abandoned round leaves no coverage work");
  } finally { await host.close(); }
});

test("P1A ask-user structured conflict passes its question through apply and notifies", async (t) => {
  const o = fresh(); let roomId = ""; let seq = 0; let target: string | null = null;
  const applied: CaptureWrite[] = []; const notified: { roomId: string; text: string }[] = [];
  const apply = MemoryCoverage.prototype.apply;
  t.mock.method(MemoryCoverage.prototype, "apply", function (this: MemoryCoverage, id: string, notify?: Parameters<MemoryCoverage["apply"]>[1]) {
    applied.push(...(this.get(id).writes ?? []));
    return apply.call(this, id, notify ? (question, actionId) => { notified.push(question); notify(question, actionId); } : undefined);
  });
  const host = new Host({ ...o, maxDeferMs: 1, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }),
    compactor: () => ({ async compact() { return "note"; }, async reflect() { return { note: "note", personaSuggestion: null, memories: [{ title: "reply preference", text: target ? "以后都用英文回复" : "以后都用中文回复", anchors: ["global"], relation: target ? "conflict" as const : null, target, roomId, sourceSeq: seq, evidence: target ? "以后都用英文回复" : "以后都用中文回复" }] }; } }),
  });
  try {
    const c = host.createContact({ name: "c" }); roomId = host.openDm(c.id).id;
    const wake = t.mock.method(host.loop, "notify", () => {});
    seq = appendEvent(host.db.store, `room:${roomId}`, { kind: "user", id: host.userId }, { kind: "message", text: "以后都用中文回复" }, new Date().toISOString()).seq;
    assert.equal(await host.runRound(c.id, new AbortController().signal), "done");
    target = host.listMemories(c.id)[0]!.id; const before = wake.mock.callCount();
    seq = appendEvent(host.db.store, `room:${roomId}`, { kind: "user", id: host.userId }, { kind: "message", text: "以后都用英文回复" }, new Date().toISOString()).seq;
    assert.equal(await host.runRound(c.id, new AbortController().signal), "done");
    const conflict = applied.find(w => w.after.some(e => e.conflictsWith.includes(target!)));
    assert.ok(conflict, "both direct user quotes produce an ask-user conflict");
    assert.deepEqual(conflict.question, { roomId, text: "记忆“reply preference”与已有记忆冲突，请确认是否保留这条新说法。" });
    assert.deepEqual(notified, [conflict.question], "apply invokes the notification callback with the conflict prompt");
    assert.equal(wake.mock.callCount(), before + 1);
    assert.deepEqual(wake.mock.calls.at(-1)?.arguments, [c.id, "now"]);
    assert.equal(host.listMemories(c.id).filter(e => e.status === "active").length, 2, "neither direct quote is silently superseded");
  } finally { await host.close(); }
});
