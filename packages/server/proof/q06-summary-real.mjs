// 真实运行一次(手动跑,不在测试 glob 内):真实 pi 联系人在群里接「每 N 条消息总结一次」→ 到点读那一段写动向摘要 → 撤回一条来源 → 重做。
//   node packages/server/proof/q06-summary-real.mjs > packages/server/proof/q06-summary-real.txt
// 联系人模型就是它平时说话的那个入口(createPiContactMind);摘要轮没有另配模型或密钥。
// 网关地址与令牌只从环境变量读(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),不打印。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPiContactMind } from "@g-group/adapter-pi-contact";
import { Host } from "../src/host.ts";
import { SUMMARY_SYSTEM } from "../src/trend-summary-format.ts";

const baseUrl = process.env.ANTHROPIC_BASE_URL;
const bearer = process.env.ANTHROPIC_AUTH_TOKEN;
const apiKey = bearer || process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error("缺环境变量:ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL");
  process.exit(2);
}
const N = 4;
const dir = mkdtempSync(path.join(tmpdir(), "gg-q06-real-"));
const redact = (s) => String(s).split(baseUrl).join("[端点已隐去]").split(apiKey).join("[令牌已隐去]");
const reports = [];
const rounds = [];
const real = createPiContactMind({ provider: "anthropic", model, baseUrl, apiKey, authHeader: bearer ? "bearer" : "x-api-key", maxTokens: 2048 });
const mind = {
  async round(input, ...rest) {
    const summary = input.request.blocks[0].text.startsWith(SUMMARY_SYSTEM);
    const rec = { kind: summary ? "摘要轮" : "平常轮", freshSeqs: input.fresh.flatMap((f) => (f.kind === "message" ? [f.seq] : [])), block4: summary ? input.request.blocks[3].text : null, block5: summary ? input.request.blocks[4].text : null };
    rounds.push(rec);
    const t0 = Date.now();
    try {
      const out = await real.round(input, ...rest);
      Object.assign(rec, { ms: Date.now() - t0, actions: out.actions, wroteStateNote: out.stateNote !== null });
      return out;
    } catch (e) {
      Object.assign(rec, { ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};
const h = new Host({ file: path.join(dir, "gg.db"), mind: () => mind, maxDeferMs: 5, onReport: (what, detail) => reports.push({ what, detail }) });
const c = h.createContact({ name: "小记", speakingModel: model, persona: "说话简短、靠谱;只依据看到的原文,看不到的直说看不到。" });
const g = h.createGroup("研发群", [{ kind: "contact", id: c.id }]);
const started = Date.now();
async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await Promise.race([h.idle(), new Promise((r) => setTimeout(r, 500))]);
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}
const summaries = () => h.listSummaries({ roomId: g.id, includeSuperseded: true }).summaries;
const outcome = { committed: false, summarized: false, stale: false, redone: false };
let first = null;
let retracted = null;
let second = null;

const ask = h.send({ roomId: g.id, clientActionId: "ask", text: `小记,以后这个群每 ${N} 条消息帮我总结一次大家聊了什么、方向往哪走。` });
outcome.committed = await waitFor(() => h.listCommitments({ roomId: g.id }).some((k) => k.trigger), 120_000);
if (outcome.committed) {
  // 等它把这一轮说完再发下一批,免得它那句「记下了」和下面几条抢先后
  await waitFor(() => !h.loop.busy(), 60_000);
  const texts = ["登录接口的限流阈值我们定 100,周三前改完。", "周五发版,发版前要跑一遍回归。", "回归由小安负责,我来盯线上监控。", "另外测试服端口换成 8081 了,文档记得同步。"];
  for (const [i, text] of texts.entries()) h.send({ roomId: g.id, clientActionId: `m${i + 1}`, text });
  outcome.summarized = await waitFor(() => summaries().some((s) => s.status !== "generating"), 240_000);
  first = summaries().at(-1) ?? null;
  if (first?.status === "ok") {
    // 撤回它引用过的一条用户消息:摘要应当场过期、正文清掉
    const mine = new Set(h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "user").map((m) => m.seq));
    retracted = first.items.flatMap((it) => it.sourceSeqs).find((q) => mine.has(q)) ?? null;
    if (retracted !== null) {
      h.retractMessage(g.id, retracted);
      const now = h.getSummary(first.summaryId);
      outcome.stale = now.status === "stale" && now.items.length === 0 && now.staleBySeq === retracted;
      const redo = h.regenerateSummary({ summaryId: first.summaryId, clientActionId: "redo1" });
      await waitFor(() => h.getSummary(redo.summaryId).status !== "generating", 240_000);
      second = h.getSummary(redo.summaryId);
      outcome.redone = second.status === "ok" && second.version === 2 && second.supersedes === first.summaryId && !second.items.some((it) => it.sourceSeqs.includes(retracted));
    }
  }
}
await waitFor(() => !h.loop.busy() && !h.summaries.busy(), 60_000);

const inRange = (s) => s.items.every((it) => it.sourceSeqs.every((q) => q > s.fromSeqExclusive && q <= s.toSeqInclusive));
console.log(`# ${new Date().toISOString()} 真实 pi 联系人(模型 ${model},经网关 ${bearer ? "Bearer" : "x-api-key"})做群聊动向摘要,全程 ${Date.now() - started} ms`);
console.log(`# 命令: node packages/server/proof/q06-summary-real.mjs;每 ${N} 条消息一次;用户那句请求是 #${ask.seq}`);
console.log("\n## 承诺与触发(listCommitments)");
for (const k of h.listCommitments({ roomId: g.id })) console.log(JSON.stringify({ id: k.id, status: k.status, sourceSeq: k.sourceSeq, text: k.text, trigger: k.trigger ?? null }));
console.log("\n## 模型各轮(按先后;动作是模型原样给的)");
for (const [i, r] of rounds.entries()) {
  console.log(`--- 第 ${i + 1} 轮 · ${r.kind} · 新消息 ${r.freshSeqs.map((q) => `#${q}`).join(" ") || "(无)"} · ${r.ms ?? "?"} ms${r.error ? ` · 出错:${redact(r.error).slice(0, 300)}` : ""}`);
  if (r.block5) console.log(`[第 5 块]\n${r.block5}`);
  if (r.block4) console.log(`[第 4 块]\n${r.block4}`);
  for (const a of r.actions ?? []) console.log(`动作 ${redact(JSON.stringify(a))}`);
  if (r.wroteStateNote) console.log("(这一轮还写了状态笔记)");
}
console.log("\n## 第一份摘要(生成后、撤回前)");
console.log(first ? JSON.stringify(first, null, 2) : "(没有)");
console.log(`\n## 撤回 #${retracted ?? "(没撤)"} 之后这份摘要`);
console.log(first && retracted !== null ? JSON.stringify(h.getSummary(first.summaryId), null, 2) : "(没走到)");
console.log("\n## 重做出来的新版本");
console.log(second ? JSON.stringify(second, null, 2) : "(没走到)");
console.log("\n## 宿主报告(摘要与拒收相关)");
for (const r of reports.filter((x) => x.what.startsWith("summary-") || x.what === "count-window" || x.what === "action-rejected" || x.what === "round-failed")) console.log(r.what, redact(JSON.stringify(r.detail ?? null)).slice(0, 600));
console.log("\n## 会话(摘要不是消息,不在这里)");
for (const m of h.listMessages(g.id, {}).messages) console.log(`#${m.seq} ${m.sender.kind}:${m.sender.id === c.id ? "小记" : m.sender.id}: ${m.retracted ? "(已撤回)" : m.text.slice(0, 200)}`);
console.log(
  `\n# 判定: 真实模型登记了带 everyNMessages 的承诺=${outcome.committed};到点生成了摘要=${outcome.summarized}(状态 ${first?.status ?? "无"});` +
    `要点都带来源且都在区间内=${first?.status === "ok" ? inRange(first) : "不适用"};撤回后当场过期且正文清空=${outcome.stale};重做出新版本且不再引用被撤回的那条=${outcome.redone};` +
    `摘要轮次数=${rounds.filter((r) => r.kind === "摘要轮").length}`,
);
await h.close();
rmSync(dir, { recursive: true, force: true });
process.exit(outcome.committed && outcome.summarized && first?.status === "ok" && outcome.stale && outcome.redone ? 0 : 1);
