// 记忆与状态笔记的撤回 / 回退清洗(验收 AC-08 记忆与笔记侧、AC-42 ⑤⑧;需求 U29、D06 §1)。
// ① rewind 撤下的原文与撤回原文同一机制从状态笔记里清掉(U29 候选做法),长期记忆不随回退改变;
// ② 来源消息被撤回的记忆不进第 1 块前缀、不进第 5 块、read_memory 读不到正文,条目本身保留并标「来源已撤回」;
// ③ 宿主启动时 gg_memory 索引缺失或与 md 真源不一致就从 md 重建,读取结果与重建前一致。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactProfileView, MemoryView } from "@g-group/api-contract";
import { type MindAction, type RoundInput, type RoundTools, parseMemory, serializeMemory } from "@g-group/kernel";
import { run } from "./db.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-memhyg-"));
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
type Script = (i: RoundInput, tools: RoundTools | undefined) => Promise<MindAction[]> | MindAction[];
function scripted(script: Script, reqs: RoundInput["request"][], note: () => string | null = () => null) {
  return () => ({
    async round(i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
      reqs.push(i.request);
      return { actions: await script(i, tools), stateNote: note() };
    },
  });
}
const lastMsg = (i: RoundInput) => {
  const m = [...i.fresh].reverse().find((f) => f.kind === "message");
  return m?.kind === "message" ? m : null;
};
/** 「记:xxx」→ 记一条挂当前会话锚点的记忆;「以后所有…」→ 用户原话记全局 */
const memoryScript: Script = (i) => {
  const m = lastMsg(i);
  if (!m) return [];
  if (m.text.startsWith("以后所有")) return [{ kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: "回复格式", text: m.text, anchors: ["global"], quote: m.text, relation: null, target: null }];
  if (m.text.startsWith("记:")) return [{ kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: `要点 ${m.text.slice(2, 4)}`, text: m.text.slice(2), anchors: [`room:${m.roomId}`], quote: null, relation: null, target: null }];
  return [];
};
const b = (r: RoundInput["request"], n: number) => r.blocks[n - 1]!.text;
const all = (r: RoundInput["request"]) => r.blocks.map((x) => x.text).join("\n");
async function value<T>(p: Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value as T;
}

test("U29 回退:撤下范围的原文在回退事务里就从状态笔记清掉,模型交回旧笔记也清,下一轮第 3 块没有;长期记忆一条不变且照常读回;回退后重发同一句不被误清", async () => {
  const reqs: RoundInput["request"][] = [];
  let note: string | null = null;
  let wantMemory = true;
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: scripted((i) => {
      const m = lastMsg(i);
      if (!m?.text.startsWith("帮我订") || !wantMemory) return [];
      wantMemory = false;
      return [{ kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: "出行偏好", text: "出差优先坐高铁", anchors: [`room:${m.roomId}`], quote: null, relation: null, target: null }];
    }, reqs, () => note),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "第一条:周五开会" });
  await settle(host);
  note = "在做:帮我订周六去杭州的高铁票;下一步:查车次";
  host.send({ roomId: dm.id, clientActionId: "2", text: "帮我订周六去杭州的高铁票" });
  await settle(host);
  assert.match(host.stateNote(c.id) ?? "", /帮我订周六去杭州的高铁票/);
  const before = host.listMemories(c.id);
  assert.equal(before.length, 1);

  host.rewind({ roomId: dm.id, toSeq: 1, clientActionId: "rw" });
  assert.doesNotMatch(host.stateNote(c.id) ?? "", /帮我订周六去杭州的高铁票/, "回退事务里就清掉已落盘的笔记");
  assert.match(host.stateNote(c.id) ?? "", /在做:〔已撤回内容已移除〕;下一步:查车次/);
  await settle(host);
  assert.doesNotMatch(host.stateNote(c.id) ?? "", /帮我订周六去杭州的高铁票/, "回退说明那一轮模型又交回旧笔记:落盘前清掉");
  note = null;
  host.send({ roomId: dm.id, clientActionId: "4", text: "继续" });
  await settle(host);
  const last = reqs.at(-1)!;
  assert.doesNotMatch(b(last, 3), /帮我订周六去杭州的高铁票/, "下一轮第 3 块不含撤下原文");
  assert.match(b(last, 5), /出差优先坐高铁/, "长期记忆不随回退回滚,照常读回");
  assert.deepEqual(host.listMemories(c.id), before, "长期记忆条目数与内容都不变");

  note = "在做:帮我订周六去杭州的高铁票(重新确认车次)";
  host.send({ roomId: dm.id, clientActionId: "5", text: "帮我订周六去杭州的高铁票" });
  await settle(host);
  assert.equal(host.stateNote(c.id), "在做:帮我订周六去杭州的高铁票(重新确认车次)", "同一句又是有效消息:不再当撤下原文清掉");
  await host.close();
});

test("U29 回退时联系人正在跑一轮:回退事务里就清掉已落盘的笔记,资料页立刻读不到撤下原文", async () => {
  let note: string | null = null;
  let hold: Promise<void> | null = null;
  let release = () => {};
  let entered = false;
  const host = new Host({
    ...fresh(), maxDeferMs: 5,
    mind: () => ({
      async round(i: RoundInput) {
        if (lastMsg(i)?.text === "再查一下返程" && hold) {
          entered = true;
          await hold;
        }
        return { actions: [], stateNote: note };
      },
    }),
  });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "第一条:周五开会" });
  await settle(host);
  note = "在做:帮我订周六去杭州的高铁票";
  host.send({ roomId: dm.id, clientActionId: "2", text: "帮我订周六去杭州的高铁票" });
  await settle(host);
  note = null;
  hold = new Promise<void>((r) => {
    release = r;
  });
  host.send({ roomId: dm.id, clientActionId: "3", text: "再查一下返程" });
  try {
    for (let k = 0; k < 400 && !entered; k++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(entered, true, "联系人这一轮还没结束");
    host.rewind({ roomId: dm.id, toSeq: 1, clientActionId: "rw" });
    assert.doesNotMatch(host.stateNote(c.id) ?? "", /帮我订周六去杭州的高铁票/, "不等联系人这一轮结束就清掉");
    const p = await value<ContactProfileView>(svc.handle("contacts.profile", { contactId: c.id }));
    assert.equal(p.memory.stateNote?.text, "在做:〔已撤回内容已移除〕", "资料页读到的工作记忆也不含撤下原文");
  } finally {
    release();
    await settle(host);
    await host.close();
  }
});

test("来源消息撤回:由它写出的记忆不进第 1 块前缀(已并入的前缀快照也拿掉)、不进第 5 块,read_memory 读不到正文;无关记忆照常;条目还在并标来源已撤回", async () => {
  const reqs: RoundInput["request"][] = [];
  const reads: (string | null)[] = [];
  let readId = "";
  const host = new Host({
    ...fresh(), maxDeferMs: 5, memoryFoldAfter: 2,
    mind: scripted(async (i, tools) => {
      if (lastMsg(i)?.text === "读") reads.push(await tools!.readMemory(readId));
      return memoryScript(i, tools);
    }, reqs),
  });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const say = async (k: string, text: string) => {
    const m = host.send({ roomId: dm.id, clientActionId: k, text });
    await settle(host);
    return m.seq;
  };
  await say("0", "你好");
  const sGlobal = await say("1", "以后所有回复都先给结论");
  await say("1b", "以后所有代码都要先写测试");
  const sWeekly = await say("2", "记:周报每周五发给小王");
  await say("3", "记:部署前先跑测试");
  await say("4", "在吗");
  assert.match(b(reqs.at(-1)!, 1), /以后所有回复都先给结论[\s\S]*以后所有代码都要先写测试/, "两条全局条目已并入前缀");
  assert.match(b(reqs.at(-1)!, 5), /周报每周五发给小王/);
  const ids = Object.fromEntries(host.listMemories(c.id).map((e) => [e.body, e.id]));
  readId = ids.周报每周五发给小王!;

  host.retractMessage(dm.id, sGlobal);
  host.retractMessage(dm.id, sWeekly);
  await settle(host);
  await say("5", "继续");
  const last = reqs.at(-1)!;
  assert.doesNotMatch(b(last, 1), /以后所有回复都先给结论/, "来源撤回的全局条目从前缀快照里拿掉(只差 1 条、没到折叠阈值也拿掉)");
  assert.match(b(last, 1), /以后所有代码都要先写测试/, "没撤回的全局条目留在前缀");
  assert.doesNotMatch(all(last), /周报每周五/, "来源撤回的条目正文和标题都不进上下文");
  assert.doesNotMatch(all(last), /以后所有回复都先给结论/);
  assert.match(b(last, 5), /部署前先跑测试/, "与撤回消息无关的记忆照常读回");
  await say("6", "读");
  assert.deepEqual(reads, [null], "read_memory 按 id 也读不到来源撤回的条目");

  assert.equal(host.listMemories(c.id).length, 4, "条目本身保留");
  const list = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: c.id }));
  const state = Object.fromEntries(list.memories.map((v) => [v.body, [v.state, v.effective]]));
  assert.deepEqual(state, {
    以后所有回复都先给结论: ["source-retracted", false],
    以后所有代码都要先写测试: ["active", true],
    周报每周五发给小王: ["source-retracted", false],
    部署前先跑测试: ["active", true],
  });
  const only = await value<{ memories: MemoryView[] }>(svc.handle("memory.list", { contactId: c.id, status: "source-retracted" }));
  assert.deepEqual(only.memories.map((v) => v.id).sort(), [ids.以后所有回复都先给结论, ids.周报每周五发给小王].sort());
  await host.close();
});

test("来源撤回但同一件事被复述过:复述的那条消息还在就照常生效,复述也撤回了才挡下", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ ...fresh(), maxDeferMs: 5, mind: scripted(memoryScript, reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const first = host.send({ roomId: dm.id, clientActionId: "1", text: "记:周会改到周四下午" });
  await settle(host);
  const again = host.send({ roomId: dm.id, clientActionId: "2", text: "记:周会改到周四下午" });
  await settle(host);
  assert.equal(host.listMemories(c.id).length, 1, "复述只挂佐证");
  host.retractMessage(dm.id, first.seq);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "3", text: "在吗" });
  await settle(host);
  assert.match(b(reqs.at(-1)!, 5), /周会改到周四下午/, "复述的消息还在:照常读回");
  host.retractMessage(dm.id, again.seq);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "4", text: "在吗" });
  await settle(host);
  assert.doesNotMatch(all(reqs.at(-1)!), /周会改到周四下午/, "来源和复述都撤回:不再进上下文");
  await host.close();
});

test("启动核对:gg_memory 索引表被删后重启宿主,从 md 真源重建,条目与第 5 块读取结果都与重建前一致;一致时再启动不重建", async () => {
  const o = fresh();
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ ...o, maxDeferMs: 5, mind: scripted(memoryScript, reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  for (const [k, t] of [["1", "记:回复先给结论"], ["2", "记:代码要先写测试"], ["3", "记:周报发给小王"], ["4", "问"]] as const) {
    host.send({ roomId: dm.id, clientActionId: k, text: t });
    await settle(host);
  }
  const before5 = b(reqs.at(-1)!, 5);
  const beforeList = host.listMemories(c.id);
  assert.equal(beforeList.length, 3);
  run(host.db, "DROP TABLE gg_memory");
  await host.close();

  const reports: { what: string; detail: unknown }[] = [];
  const host2 = new Host({ ...o, maxDeferMs: 5, onReport: (what, detail) => reports.push({ what, detail }), mind: scripted(memoryScript, reqs) });
  assert.deepEqual(reports.filter((r) => r.what === "memory-index-rebuilt"), [{ what: "memory-index-rebuilt", detail: { contactId: c.id, entries: 3 } }]);
  assert.deepEqual(host2.listMemories(c.id), beforeList, "重建后条目逐字段一致");
  host2.send({ roomId: dm.id, clientActionId: "5", text: "问" });
  await settle(host2);
  assert.equal(b(reqs.at(-1)!, 5).replace(/#\d+/g, ""), before5.replace(/#\d+/g, ""), "读取结果与重建前一致");
  await host2.close();

  const again: string[] = [];
  const host3 = new Host({ ...o, maxDeferMs: 5, onReport: (what) => again.push(what), mind: scripted(memoryScript, reqs) });
  assert.equal(again.includes("memory-index-rebuilt"), false, "md 与索引一致:不重建");
  assert.equal(host3.listMemories(c.id).length, 3);
  await host3.close();
});

test("启动核对:宿主关着时 md 真源被改(条目改成已撤销),重启后索引跟着 md 走,下一轮不再读出它", async () => {
  const o = fresh();
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ ...o, maxDeferMs: 5, mind: scripted(memoryScript, reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "记:周报发给小王" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "2", text: "问" });
  await settle(host);
  assert.match(b(reqs.at(-1)!, 5), /周报发给小王/);
  await host.close();

  const mdDir = path.join(o.dataDir, "memory", c.id);
  const [file] = readdirSync(mdDir).filter((f) => f.endsWith(".md"));
  const parsed = parseMemory(readFileSync(path.join(mdDir, file!), "utf8"));
  assert.ok(parsed.ok);
  writeFileSync(path.join(mdDir, file!), serializeMemory({ ...parsed.entry, status: "revoked", version: parsed.entry.version + 1 }));

  const host2 = new Host({ ...o, maxDeferMs: 5, mind: scripted(memoryScript, reqs) });
  assert.deepEqual(host2.listMemories(c.id).map((e) => [e.status, e.version]), [["revoked", parsed.entry.version + 1]], "索引按 md 重建");
  host2.send({ roomId: dm.id, clientActionId: "3", text: "问" });
  await settle(host2);
  assert.doesNotMatch(all(reqs.at(-1)!), /周报发给小王/);
  await host2.close();
});
