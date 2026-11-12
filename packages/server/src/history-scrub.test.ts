// 撤回原文不得经找旧消息的三条入口回到请求(T-177 G4b;G6 实测缺口 k1-g4on-R1 的最小复现):
// 用户发一条含细节的消息 → 联系人回话里抄了这段原文(「收到:…」) → 用户撤回原消息 → 再发模糊追问。
// 撤回的消息本体已被排除(G4 的 G4-01/G4-02),漏的是「另一条未撤回的可见消息的正文里含已撤回原文」这一形态。
// 三条入口都验:每轮预取的第 5 块、query_history 的回读窗口与检索结果;行本身(编号、作者、时间、版本)保留,这条消息仍可定位。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type RoundInput, type RoundOutput, type RoundRequest, type RoundTools, SCRUBBED_BODY } from "@g-group/kernel";
import { Host } from "./host.ts";

const SECRET = "我的储物柜号码是 4471,钥匙放在前台";
const dir = mkdtempSync(path.join(tmpdir(), "gg-scrub-"));
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
const file = () => path.join(dir, `s${++no}.db`);
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
const block = (r: RoundRequest | undefined, n: number) => r?.blocks[n - 1]?.text ?? "";
const allBlocks = (r: RoundRequest | undefined) => (r?.blocks ?? []).map((b) => b.text).join("\n");
/** 模糊追问那一轮的请求(按第 4 块找,不看顺序) */
const vague = (reqs: readonly RoundRequest[]) => reqs.find((r) => block(r, 4).includes("我之前说的储物柜号码是多少?"));

interface Scene {
  readonly host: Host;
  readonly dm: string;
  readonly secretSeq: number;
  readonly replySeq: number;
  readonly extraSeq: number;
  readonly reqs: RoundRequest[];
  readonly reads: (string | null)[];
  readonly searches: (string | null)[];
  readonly reports: { what: string; detail: unknown }[];
}
interface Hooks {
  readonly report: (what: string, detail: unknown) => void;
  readonly round: (i: RoundInput, tools: RoundTools | undefined) => Promise<RoundOutput>;
}
/** 测试自己造宿主(注入这条时间线要的 mind 与报告回调);scene 只跑 G6 缺口的那条时间线 */
type Build = (hooks: Hooks) => Host;

/**
 * G6 缺口的时间线:发含细节的用户消息 → 联系人回话 → (可选)用户再发一条 → 撤回原消息 → 模糊追问 → 「读」「搜」两次查询。
 * reply 是联系人回话的原文;extra 是撤回前那条用户消息;anchorOf 决定「读」锚在回话还是那条用户消息。
 */
async function scene(o: { reply: string; extra?: string; anchorOf?: "reply" | "extra" }, build: Build): Promise<Scene> {
  const reqs: RoundRequest[] = [];
  const reads: (string | null)[] = [];
  const searches: (string | null)[] = [];
  const reports: { what: string; detail: unknown }[] = [];
  let anchor = 0;
  const round = async (i: RoundInput, tools: RoundTools | undefined): Promise<RoundOutput> => {
    reqs.push(i.request);
    const m = i.fresh.find((f) => f.kind === "message");
    if (m?.kind !== "message") return { actions: [], stateNote: null };
    if (m.text === SECRET) return { actions: [{ kind: "reply" as const, roomId: m.roomId, text: o.reply, replyToSeq: m.seq }], stateNote: null };
    if (m.text === "读" && tools?.queryHistory) reads.push(await tools.queryHistory({ kind: "read", roomId: m.roomId, seq: anchor, before: 2, after: 0 }));
    if (m.text === "搜" && tools?.queryHistory) searches.push(await tools.queryHistory({ kind: "search", query: "储物柜号码", roomId: null, limit: null }));
    return { actions: [], stateNote: null };
  };
  const host = track(build({ report: (what, detail) => reports.push({ what, detail }), round }));
  const c = host.createContact({ name: "小甲" });
  const dm = host.openDm(c.id);
  const secretSeq = host.send({ roomId: dm.id, clientActionId: "s1", text: SECRET }).seq;
  await settle(host);
  const replySeq = host.listMessages(dm.id, {}).messages.find((m) => m.sender.kind === "contact")?.seq ?? 0;
  let extraSeq = 0;
  if (o.extra !== undefined) {
    extraSeq = host.send({ roomId: dm.id, clientActionId: "x1", text: o.extra }).seq;
    await settle(host);
  }
  host.retractMessage(dm.id, secretSeq);
  await settle(host);
  anchor = o.anchorOf === "extra" ? extraSeq : replySeq;
  host.send({ roomId: dm.id, clientActionId: "q1", text: "我之前说的储物柜号码是多少?" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "r1", text: "读" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "s2", text: "搜" });
  await settle(host);
  return { host, dm: dm.id, secretSeq, replySeq, extraSeq, reqs, reads, searches, reports };
}
test("预取行不带已撤回原文:联系人回话抄了用户原文、用户撤回后,第 5 块只留编号、作者、时间,原文换成占位", async () => {
  const s = await scene({ reply: `收到:${SECRET}` }, (h) => new Host({ file: file(), maxDeferMs: 5, onReport: h.report, mind: () => ({ round: (i: RoundInput, _s: AbortSignal, tools?: RoundTools) => h.round(i, tools) }) }));
  const last = vague(s.reqs);
  assert.ok(last, "模糊追问那一轮跑过");
  assert.equal(s.host.listMessages(s.dm, {}).messages.find((m) => m.seq === s.secretSeq)?.retracted, true, "前提:原消息已撤回");
  assert.doesNotMatch(allBlocks(last), /4471/, "整个请求里不出现撤回原文里的号码");
  assert.doesNotMatch(allBlocks(last), /钥匙放在前台/, "整个请求里不出现撤回原文的其余部分");
  assert.match(block(last, 5), new RegExp(`^${s.dm} #${s.replySeq} · 小甲 · \\d{4}-[^ ]+ · 收到:〔已撤回内容已移除〕$`, "m"), "这条消息仍在,编号、作者、时间都在,只是正文换了");
  assert.doesNotMatch(block(last, 5), new RegExp(`#${s.secretSeq} `), "撤回的那条本体不预取");
  assert.equal(
    s.reports.some((r) => r.what === "history-scrubbed" && (r.detail as { lines: number }).lines >= 1),
    true,
    "换掉过撤回原文的条数进了诊断",
  );
  assert.equal(
    s.reports.filter((r) => r.what === "history-prefetch").some((r) => (r.detail as { scrubbed?: number }).scrubbed === 1),
    true,
    "预取诊断里报出有一轮换掉了 1 条",
  );
  await s.host.close();
});

test("回读窗口不带已撤回原文:抄了原文的邻居只换掉那一段,撤回的那条仍给占位,别的字留着", async () => {
  const s = await scene({ reply: `收到:${SECRET}`, extra: `补充一下,${SECRET},别忘了`, anchorOf: "extra" }, (h) => new Host({ file: file(), maxDeferMs: 5, onReport: h.report, mind: () => ({ round: (i: RoundInput, _s: AbortSignal, tools?: RoundTools) => h.round(i, tools) }) }));
  await s.host.close();
  const w = s.reads.at(-1);
  assert.ok(w, "回读跑过");
  assert.doesNotMatch(w, /4471|钥匙放在前台/, "窗口里不出现撤回原文");
  assert.match(w, new RegExp(`〔${s.dm} #${s.secretSeq}〕DeletedOrWithdrawn · 这条已撤回,不提供原文`), "撤回的那条给占位");
  assert.match(w, new RegExp(`〔${s.dm} #${s.replySeq}〕小甲 · [^\\n]+ · 版本 ${s.replySeq}\\n收到:〔已撤回内容已移除〕`), "联系人回话只换掉抄来的那段");
  assert.match(w, new RegExp(`〔${s.dm} #${s.extraSeq}〕我 · [^\\n]+\\n补充一下,〔已撤回内容已移除〕,别忘了`), "用户自己的消息不被整体抹掉,别的字留着");
});

test("检索结果不带已撤回原文:命中那条仍给编号、作者、时间与版本,正文里的原文换成占位", async () => {
  const s = await scene({ reply: `收到:${SECRET}` }, (h) => new Host({ file: file(), maxDeferMs: 5, onReport: h.report, mind: () => ({ round: (i: RoundInput, _s: AbortSignal, tools?: RoundTools) => h.round(i, tools) }) }));
  await s.host.close();
  const got = s.searches.at(-1);
  assert.ok(got, "检索跑过");
  assert.doesNotMatch(got, /4471|钥匙放在前台/);
  assert.match(got, new RegExp(`〔${s.dm} #${s.replySeq}〕小甲 · [^\\n]+ · 版本 ${s.replySeq}:收到:〔已撤回内容已移除〕`), "命中仍可定位,正文换了");
});

test("抄写时分不出原样(加了空格)时整段正文隐去:行还在、编号与作者还在,不留半截", async () => {
  const s = await scene({ reply: "收到:我的储物柜号码是 4471, 钥匙放在前台" }, (h) => new Host({ file: file(), maxDeferMs: 5, onReport: h.report, mind: () => ({ round: (i: RoundInput, _s: AbortSignal, tools?: RoundTools) => h.round(i, tools) }) }));
  await s.host.close();
  const w = s.reads.at(-1);
  assert.ok(w, "回读跑过");
  assert.doesNotMatch(w, /4471|钥匙/, "半截也不留");
  assert.match(w, new RegExp(`〔${s.dm} #${s.replySeq}〕小甲 · [^\\n]+ · 版本 ${s.replySeq}\\n${SCRUBBED_BODY}`), "整段隐去,行本身可定位");
});

test("只换抄到撤回原文的那条:没抄到的消息一字不动", async () => {
  const s = await scene({ reply: "好的,收到", extra: `帮我记一下:${SECRET}`, anchorOf: "extra" }, (h) => new Host({ file: file(), maxDeferMs: 5, onReport: h.report, mind: () => ({ round: (i: RoundInput, _s: AbortSignal, tools?: RoundTools) => h.round(i, tools) }) }));
  await s.host.close();
  const w = s.reads.at(-1);
  assert.ok(w, "回读跑过");
  assert.match(w, new RegExp(`〔${s.dm} #${s.replySeq}〕小甲 · [^\\n]+ · 版本 ${s.replySeq}\\n好的,收到`), "没抄到撤回原文的消息一字不动");
  assert.match(w, new RegExp(`〔${s.dm} #${s.extraSeq}〕我 · [^\\n]+\\n帮我记一下:〔已撤回内容已移除〕`), "抄到的那条只换掉那段,别的字留着");
  assert.equal(
    s.reports.filter((r) => r.what === "history-scrubbed").length >= 1,
    true,
    "换过就有诊断",
  );
});
