// 找旧消息的内置只读查询工具 query_history 接进联系人一轮(T-177 G4;需求 D06 §3「精筛内置」:一个查询工具,检索与分页回读两种用法;
// 实施方案 §6、§8 G4-01、G4-02;审查条件 G4-a、G1-a):
// 宿主先按当前权限、撤回、私聊回退与最新编辑版本形成可见语料再交检索(探针包住 G3 接缝,看实际传进去的文档);
// 「当前会话」= 这一轮新输入所在的会话,群里这一轮搜不到也读不到同一联系人的私聊;检索后到返回前再核(编辑改读当前版本、撤回与移出的去掉);
// 回读时每条邻居单独核对,正文受回读预算约束、装不下给续读位置。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type HistoryDoc, type RoundInput, type RoundTools, searchHistory } from "@g-group/kernel";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-hist-"));
/** 测试里建的宿主:失败的测试来不及 close,收尾时统一关(最多等 1 秒),再删临时目录 */
const hosts: Host[] = [];
const track = (h: Host): Host => {
  hosts.push(h);
  return h;
};
after(async () => {
  for (const h of hosts) await Promise.race([h.close(), new Promise((r) => setTimeout(r, 1000))]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
let no = 0;
const file = () => path.join(dir, `h${++no}.db`);
/** 等宿主安静下来;最多 8 秒,一直有轮次在跑或在退避重跑就按名失败,不挂住整个文件 */
async function settle(host: Host) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 50))]);
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
type OnRound = (text: string, tools: RoundTools, i: RoundInput) => Promise<void>;
const mind = (on: OnRound) => () => ({
  async round(i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
    const m = i.fresh.find((f) => f.kind === "message");
    if (m?.kind === "message" && tools) await on(m.text, tools, i);
    return { actions: [], stateNote: null };
  },
});
const all = (s: string | null | undefined) => s ?? "(null)";

test("G4-01 交给检索的文档只有当前可见的最新版本:撤回的、私聊回退撤下的、编辑前的旧稿都不在里面;命中的版本取最后一次编辑的 seq", async () => {
  const seen: HistoryDoc[][] = [];
  const got: (string | null)[] = [];
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      historySearch: (docs, q, n) => {
        seen.push([...docs]);
        return searchHistory(docs, q, n);
      },
      mind: mind(async (text, tools) => {
        if (text === "部署端口现在是多少") got.push(await tools.queryHistory!({ kind: "search", query: "部署端口", roomId: null, limit: null }));
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const start = host.send({ roomId: dm.id, clientActionId: "a", text: "部署说明从这里开始" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "b", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 部署端口先用 7070" });
  await settle(host);
  host.rewind({ roomId: dm.id, toSeq: start.seq, clientActionId: "rw" });
  await settle(host);
  const kept = host.send({ roomId: dm.id, clientActionId: "c", text: "部署端口是 8081" });
  await settle(host);
  host.editMessage(dm.id, kept.seq, "部署端口是 9090");
  const editSeq = host.lastSeq(dm.id);
  await settle(host);
  const gone = host.send({ roomId: dm.id, clientActionId: "d", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 部署端口临时 6060" });
  await settle(host);
  host.retractMessage(dm.id, gone.seq);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "部署端口现在是多少" });
  await settle(host);
  const view = host.listMessages(dm.id, {}).messages;
  assert.equal(view.find((m) => m.seq === gone.seq)?.retracted, true, "前提:这条已撤回");
  assert.equal(view.find((m) => m.seq === kept.seq)?.edited, true, "前提:这条改过");
  assert.ok(seen.length >= 2, "预取与工具都经过检索接缝");
  const texts = seen.flat().map((d) => d.text);
  assert.deepEqual(texts.filter((t) => /NEUTRAL_FIXTURE|8081/.test(t)), [], "撤回的、回退撤下的、编辑前的旧稿从没交给检索");
  assert.ok(texts.includes("部署端口是 9090"), "编辑后的版本在语料里");
  assert.ok(seen.flat().every((d) => d.ref.startsWith(`${dm.id}#`)), "ref 是会话加 seq");
  assert.equal(got.length, 1);
  assert.match(all(got[0]), new RegExp(`\\n〔${dm.id} #${kept.seq}〕我 · [^\\n]+ · 版本 ${editSeq}:部署端口是 9090(?:\\n|$)`));
  assert.doesNotMatch(all(got[0]), /NEUTRAL_FIXTURE|8081|7070|6060/);
  await host.close();
});

test("G4-01 联系人同时在私聊和群里:群里这一轮搜不到也读不到私聊的内容,私聊那一轮照常搜得到", async () => {
  const seen: { phase: string; refs: string[] }[] = [];
  let phase = "";
  const inGroup: (string | null)[] = [];
  const inDm: (string | null)[] = [];
  let dmSeq = 0;
  let dmId = "";
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      historySearch: (docs, q, n) => {
        seen.push({ phase, refs: docs.map((d) => d.ref) });
        return searchHistory(docs, q, n);
      },
      mind: mind(async (text, tools) => {
        if (text === "群里也说说预算") {
          inGroup.push(await tools.queryHistory!({ kind: "search", query: "预算", roomId: null, limit: null }));
          inGroup.push(await tools.queryHistory!({ kind: "search", query: "预算", roomId: dmId, limit: null }));
          inGroup.push(await tools.queryHistory!({ kind: "read", roomId: dmId, seq: dmSeq, before: 0, after: 0 }));
        }
        if (text === "私聊里预算多少") inDm.push(await tools.queryHistory!({ kind: "search", query: "预算", roomId: null, limit: null }));
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  dmId = dm.id;
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  dmSeq = host.send({ roomId: dm.id, clientActionId: "p", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 私聊里定的预算是 300" }).seq;
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "g1", text: "群里先聊别的" });
  await settle(host);
  phase = "群";
  host.send({ roomId: g.id, clientActionId: "g2", text: "群里也说说预算" });
  await settle(host);
  phase = "私聊";
  host.send({ roomId: dm.id, clientActionId: "p2", text: "私聊里预算多少" });
  await settle(host);
  assert.deepEqual(host.roomsOfContact(c.id).map((r) => r.id).sort(), [dm.id, g.id].sort(), "前提:联系人同时在私聊和群里");
  assert.equal(inGroup.length, 3);
  assert.doesNotMatch(all(inGroup[0]), /NEUTRAL_FIXTURE|300/, "群里这一轮搜不到私聊的内容");
  assert.match(all(inGroup[0]), new RegExp(`只搜了本轮所在的会话 ${g.id}[;)]`));
  assert.equal(inGroup[1], null, "点名搜私聊也拒绝");
  assert.equal(inGroup[2], null, "回读私聊也拒绝");
  const groupDocs = seen.filter((s) => s.phase === "群").flatMap((s) => s.refs);
  assert.ok(groupDocs.length >= 1, "群里这一轮交给检索的有群里的旧消息");
  assert.deepEqual(groupDocs.filter((r) => !r.startsWith(`${g.id}#`)), [], "群里这一轮交给检索的文档里没有私聊的");
  assert.ok(seen.some((s) => s.phase === "私聊" && s.refs.includes(`${dm.id}#${dmSeq}`)), "私聊那一轮的语料里有它");
  assert.equal(inDm.length, 1);
  assert.match(all(inDm[0]), new RegExp(`〔${dm.id} #${dmSeq}〕我 · [^\\n]+:NEUTRAL_FIXTURE_NO_CREDENTIALS 私聊里定的预算是 300`), "私聊这一轮搜得到");
  await host.close();
});

test("G4-a 一轮同时带群和私聊的新消息:预取每条只搜它自己的会话,工具在这一轮的会话集合里搜,不同会话同号不串", async () => {
  const seen: { q: string; refs: string[] }[] = [];
  const got: (string | null)[] = [];
  const fresh: string[][] = [];
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 2000,
      historySearch: (docs, q, n) => {
        seen.push({ q, refs: docs.map((d) => d.ref) });
        return searchHistory(docs, q, n);
      },
      mind: mind(async (_text, tools, i) => {
        const rooms = [...new Set(i.fresh.map((f) => f.roomId))];
        fresh.push(rooms);
        if (rooms.length === 2 && i.fresh.some((f) => f.kind === "message" && f.text === "私聊预算多少")) got.push(await tools.queryHistory!({ kind: "search", query: "预算", roomId: null, limit: null }));
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const inGroup = host.send({ roomId: g.id, clientActionId: "g0", text: "群里的预算还没定" }).seq;
  const inDm = host.send({ roomId: dm.id, clientActionId: "p0", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 私聊里定的预算是 300" }).seq;
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "g1", text: "群里预算多少" });
  host.send({ roomId: dm.id, clientActionId: "p1", text: "私聊预算多少" });
  await settle(host);
  assert.deepEqual(host.roomsOfContact(c.id).map((r) => r.id).sort(), [dm.id, g.id].sort(), "前提:联系人同时在私聊和群里");
  assert.deepEqual(fresh.at(-1)?.sort(), [dm.id, g.id].sort(), "前提:最后一轮同时带两个会话的新消息");
  assert.equal(inGroup, inDm, "前提:两个会话里的旧消息同号");
  const groupQ = seen.filter((s) => s.q === "群里预算多少").at(-1);
  const dmQ = seen.filter((s) => s.q === "私聊预算多少").at(-1);
  assert.deepEqual(groupQ?.refs, [`${g.id}#${inGroup}`], "群里那条只在群里预取");
  assert.deepEqual(dmQ?.refs, [`${dm.id}#${inDm}`], "私聊那条只在私聊里预取");
  assert.equal(got.length, 1);
  assert.match(all(got[0]), new RegExp(`只搜了本轮所在的会话 ${[dm.id, g.id].sort().join("、")}[;)]`));
  assert.match(all(got[0]), new RegExp(`〔${g.id} #${inGroup}〕我 · [^\\n]+:群里的预算还没定`));
  assert.match(all(got[0]), new RegExp(`〔${dm.id} #${inDm}〕我 · [^\\n]+:NEUTRAL_FIXTURE_NO_CREDENTIALS 私聊里定的预算是 300`));
  await host.close();
});

test("G4-02 检索之后、返回之前被编辑或撤回:撤回的命中去掉,编辑过的改读当前版本,不回检索时的旧正文", async () => {
  const got: (string | null)[] = [];
  let armed = false;
  let edited = 0;
  let a = 0;
  let b = 0;
  let roomId = "";
  let host: Host | undefined;
  host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      historySearch: (docs, q, n) => {
        const hits = searchHistory(docs, q, n);
        if (armed && q === "部署端口" && host) {
          armed = false;
          host.editMessage(roomId, a, "部署端口最后定为 9443");
          edited = host.lastSeq(roomId);
          host.retractMessage(roomId, b);
        }
        return hits;
      },
      mind: mind(async (text, tools) => {
        if (text === "端口定了没") {
          armed = true;
          got.push(await tools.queryHistory!({ kind: "search", query: "部署端口", roomId: null, limit: null }));
        }
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  roomId = dm.id;
  a = host.send({ roomId: dm.id, clientActionId: "a", text: "部署端口先定 8443" }).seq;
  await settle(host);
  b = host.send({ roomId: dm.id, clientActionId: "b", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 部署端口备用 7443" }).seq;
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "端口定了没" });
  await settle(host);
  const view = host.listMessages(dm.id, {}).messages;
  assert.equal(view.find((m) => m.seq === b)?.retracted, true, "前提:检索途中撤回了");
  assert.ok(edited > a, "前提:检索途中编辑了");
  assert.equal(got.length, 1);
  assert.match(all(got[0]), new RegExp(`\\n〔${dm.id} #${a}〕我 · [^\\n]+ · 版本 ${edited}:部署端口最后定为 9443(?:\\n|$)`));
  assert.doesNotMatch(all(got[0]), /8443/, "不回检索时的旧正文");
  assert.doesNotMatch(all(got[0]), new RegExp(`#${b}〕|NEUTRAL_FIXTURE`), "撤回的命中去掉");
  await host.close();
});

test("G4-02 检索之后、返回之前联系人被移出这个群:这个群的命中不再返回", async () => {
  const got: (string | null)[] = [];
  let armed = false;
  let groupId = "";
  let contactId = "";
  let host: Host | undefined;
  host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      historySearch: (docs, q, n) => {
        const hits = searchHistory(docs, q, n);
        if (armed && q === "部署端口" && host) {
          armed = false;
          host.removeMember(groupId, { kind: "contact", id: contactId });
        }
        return hits;
      },
      mind: mind(async (text, tools) => {
        if (text === "群里部署端口多少") {
          armed = true;
          got.push(await tools.queryHistory!({ kind: "search", query: "部署端口", roomId: null, limit: null }));
        }
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  contactId = c.id;
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  groupId = g.id;
  host.send({ roomId: g.id, clientActionId: "a", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 群里的部署端口 8443" });
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "q", text: "群里部署端口多少" });
  await settle(host);
  assert.deepEqual(host.roomsOfContact(c.id).map((r) => r.id), [], "前提:检索途中被移出了");
  assert.equal(got.length, 1);
  assert.doesNotMatch(all(got[0]), /NEUTRAL_FIXTURE|8443/);
  assert.match(all(got[0]), /^没有找到相关的旧消息/);
  await host.close();
});

test("G4-02 回读时每条邻居单独核对:撤回的只给占位、回退撤下的看不见,中心这条给最新版本", async () => {
  const got: (string | null)[] = [];
  let anchor = 0;
  let roomId = "";
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      mind: mind(async (text, tools) => {
        if (text === "读一下") got.push(await tools.queryHistory!({ kind: "read", roomId, seq: anchor, before: 2, after: 2 }));
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  roomId = dm.id;
  const s1 = host.send({ roomId: dm.id, clientActionId: "1", text: "第一句" }).seq;
  const s2 = host.send({ roomId: dm.id, clientActionId: "2", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 第二句" }).seq;
  anchor = host.send({ roomId: dm.id, clientActionId: "3", text: "第三句原稿" }).seq;
  const s4 = host.send({ roomId: dm.id, clientActionId: "4", text: "第四句" }).seq;
  await settle(host);
  host.retractMessage(dm.id, s2);
  host.editMessage(dm.id, anchor, "第三句改过");
  const rev = host.lastSeq(dm.id);
  await settle(host);
  const s5 = host.send({ roomId: dm.id, clientActionId: "5", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 第五句" }).seq;
  await settle(host);
  host.rewind({ roomId: dm.id, toSeq: s4, clientActionId: "rw" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "读一下" });
  await settle(host);
  assert.equal(host.listMessages(dm.id, {}).messages.find((m) => m.seq === s5)?.rewound, true, "前提:第五句被回退撤下");
  assert.equal(got.length, 1);
  const at = "[^\\n]+";
  assert.match(
    all(got[0]),
    new RegExp(
      `^〔${dm.id} #${s1}〕我 · ${at} · 版本 ${s1}\\n第一句\\n` +
        `〔${dm.id} #${s2}〕DeletedOrWithdrawn · 这条已撤回,不提供原文\\n` +
        `〔${dm.id} #${anchor}〕我 · ${at} · 版本 ${rev}\\n第三句改过\\n` +
        `〔${dm.id} #${s4}〕我 · ${at} · 版本 ${s4}\\n第四句\\n` +
        `〔${dm.id} #${s5}〕AccessDenied · 这条已被回退撤下,看不见$`,
    ),
  );
  assert.doesNotMatch(all(got[0]), /NEUTRAL_FIXTURE|原稿/);
  await host.close();
});

test("G4-02 回读超过回读预算就分页:每页正文不超预算,照给出的续读位置接着读能读全", async () => {
  const pages: string[] = [];
  let anchor = 0;
  let roomId = "";
  const host = track(
    new Host({
      file: file(),
      maxDeferMs: 5,
      recallBudgetBytes: 100,
      mind: mind(async (text, tools) => {
        if (text !== "从头读") return;
        let next: [number, number] | null = [anchor, 6];
        for (let i = 0; next && i < 6; i++) {
          const page = await tools.queryHistory!({ kind: "read", roomId, seq: next[0], before: next[1], after: 0 });
          pages.push(all(page));
          const m = /续读位置 roomId=\S+ seq=(\d+) before=(\d+) after=0\)/.exec(all(page));
          next = m ? [Number(m[1]), Number(m[2])] : null;
        }
      }),
    }),
  );
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  roomId = dm.id;
  const seqs: number[] = [];
  for (const ch of "甲乙丙丁戊己庚") seqs.push(host.send({ roomId: dm.id, clientActionId: ch, text: ch.repeat(10) }).seq);
  anchor = seqs.at(-1)!;
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "q", text: "从头读" });
  await settle(host);
  assert.equal(host.listMessages(dm.id, {}).messages.filter((m) => seqs.includes(m.seq)).length, 7, "前提:七条各 30 字节");
  assert.ok(pages.length >= 2, "一页装不下,要分页");
  for (const p of pages) {
    const body = p.split("\n").filter((l) => !l.startsWith("〔") && !l.startsWith("("));
    assert.ok(Buffer.byteLength(body.join(""), "utf8") <= 100, `每页正文不超过预算:${p}`);
  }
  const read = pages.flatMap((p) => [...p.matchAll(new RegExp(`〔${dm.id} #(\\d+)〕`, "g"))].map((m) => Number(m[1])));
  assert.deepEqual([...new Set(read)].sort((x, y) => x - y), seqs, "照续读位置接着读,七条都读到");
  assert.doesNotMatch(pages.at(-1)!, /回读预算用完/, "读完就没有续读位置");
  await host.close();
});
