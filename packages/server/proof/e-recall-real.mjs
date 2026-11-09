// 真实运行一次(手动跑,不在测试 glob 内):真实 pi 联系人处理一条「回复超长 #1 + 引用 #2 #3(已撤回) #5」的私聊消息。
//   node packages/server/proof/e-recall-real.mjs > packages/server/proof/e-recall-real.txt
// 第一段用不连模型的空脑子铺好历史(只为让联系人游标走过这些旧消息,不调模型);第二段换真实 pi 脑子,只发最后一条,真实跑一轮。
// 网关地址与令牌只从环境变量读(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),不打印。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPiContactMind } from "@g-group/adapter-pi-contact";
import { Host } from "../src/host.ts";

const baseUrl = process.env.ANTHROPIC_BASE_URL;
const bearer = process.env.ANTHROPIC_AUTH_TOKEN;
const apiKey = bearer || process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error("缺环境变量:ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL");
  process.exit(2);
}
const dir = mkdtempSync(path.join(tmpdir(), "gg-recall-real-"));
const file = path.join(dir, "gg.db");
const LONG = `压测报告(登录接口):${"第 N 轮压测,QPS 稳定,无错误。".repeat(300)}结论:限流阈值维持 100。`;
const redact = (s) => String(s).split(baseUrl).join("[端点已隐去]").split(apiKey).join("[令牌已隐去]");

// 第一段:铺历史(不连模型)
const quiet = { async round() { return { actions: [], stateNote: null }; } };
const h1 = new Host({ file, mind: () => quiet, maxDeferMs: 5 });
const c = h1.createContact({ name: "小后", speakingModel: model, persona: "说话简短、靠谱;只依据看到的原文回答,看不到的直说看不到。" });
const dm = h1.openDm(c.id);
const s1 = h1.send({ roomId: dm.id, clientActionId: "h1", text: LONG }).seq;
const s2 = h1.send({ roomId: dm.id, clientActionId: "h2", text: "第二条:登录限流阈值 100" }).seq;
const s3 = h1.send({ roomId: dm.id, clientActionId: "h3", text: "NEUTRAL_RETRACTED 这一条稍后撤回" }).seq;
h1.retractMessage(dm.id, s3);
const s5 = h1.send({ roomId: dm.id, clientActionId: "h5", text: "第三条:测试服端口 8081" }).seq;
await h1.idle();
await new Promise((r) => setTimeout(r, 50));
await h1.idle();
await h1.close();

// 第二段:真实 pi 联系人跑一轮
const reports = [];
let seenBlock5 = "";
const real = createPiContactMind({ provider: "anthropic", model, baseUrl, apiKey, authHeader: bearer ? "bearer" : "x-api-key", maxTokens: 2048 });
const mind = {
  async round(input, signal) {
    seenBlock5 = input.request.blocks.find((b) => b.block === 5)?.text ?? "";
    return real.round(input, signal);
  },
};
const h2 = new Host({ file, mind: () => mind, maxDeferMs: 5, recallBudgetBytes: 2000, recallMinSliceBytes: 256, onReport: (what, detail) => reports.push({ what, detail }) });
const started = Date.now();
const q = h2.send({
  roomId: dm.id,
  clientActionId: "q",
  text: "根据我引用的这几条:限流阈值和测试服端口分别是多少?被撤回的那条你能看到内容吗?",
  replyToSeq: s1,
  quotedSeqs: [s1, s2, s3, s5],
});
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await Promise.race([h2.idle(), new Promise((r) => setTimeout(r, 1000))]);
  if (!h2.loop.busy() && h2.listMessages(dm.id, {}).messages.some((m) => m.seq > q.seq && m.sender.kind === "contact")) break;
}
console.log(`# ${new Date().toISOString()} 真实 pi 联系人(模型 ${model},经网关 Bearer)处理一条多引用私聊消息,耗时 ${Date.now() - started} ms`);
console.log("# 命令: node packages/server/proof/e-recall-real.mjs;回读预算 recallBudgetBytes=2000、保底 recallMinSliceBytes=256(数值待决,v3.20 §8.1 待决 13)");
console.log(`# 用户消息 #${q.seq}: 回复 #${s1}(超长 ${Buffer.byteLength(LONG)} 字节),引用 #${s1} #${s2} #${s3}(已撤回) #${s5}`);
console.log("\n## 召回清单(onReport recall)");
for (const r of reports.filter((x) => x.what === "recall")) console.log(JSON.stringify(r.detail));
console.log("\n## 其他报告");
for (const r of reports.filter((x) => x.what !== "recall")) console.log(r.what, redact(JSON.stringify(r.detail ?? null)).slice(0, 500));
console.log("\n## 联系人看到的第 5 块(指针与按需换入)");
console.log(seenBlock5);
console.log("\n## 会话");
for (const m of h2.listMessages(dm.id, {}).messages) {
  const body = m.retracted ? "(已撤回)" : m.text.length > 160 ? `${m.text.slice(0, 160)}…(共 ${Buffer.byteLength(m.text)} 字节)` : m.text;
  console.log(`#${m.seq} ${m.sender.kind}:${m.sender.id === c.id ? "小后" : m.sender.id}: ${body}${m.quotedSeqs.length ? ` 〔回复 #${m.replyToSeq} 引用 ${m.quotedSeqs.map((s) => `#${s}`).join(" ")}〕` : ""}`);
}
const all = seenBlock5;
console.log(`\n# 判定: 撤回原文进请求=${all.includes("NEUTRAL_RETRACTED")};#${s2} 全文在=${all.includes("登录限流阈值 100")};#${s5} 全文在=${all.includes("测试服端口 8081")};#${s1} 截断带游标=${/TruncatedSlice[^\n]*offset=\d+/.test(all)}`);
await h2.close();
rmSync(dir, { recursive: true, force: true });
