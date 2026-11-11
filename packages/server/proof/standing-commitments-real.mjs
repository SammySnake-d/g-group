// 真实运行一次(手动跑,不在测试 glob 内):startServer mind=pi,群里用户 @小克 要每天 8 点(上海时间)总结前一天的讨论,
// 核对 schedules.list 有一条 → runNow → 群里出现总结、运行记录写实;再「@小克 改成 9 点」「@小克 停掉」并核对。
//   node packages/server/proof/standing-commitments-real.mjs > packages/server/proof/standing-commitments-real.txt
// 网关地址与令牌只从环境变量读(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),不打印。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/start.ts";

const env = process.env;
const secret = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
if (!secret || !env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
  console.error("缺环境变量:ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL(ANTHROPIC_BASE_URL 可选)");
  process.exit(2);
}
const redact = (s) => {
  let t = String(s);
  for (const x of [secret, env.ANTHROPIC_BASE_URL].filter(Boolean)) t = t.split(x).join("[已隐去]");
  return t;
};
const dir = mkdtempSync(path.join(tmpdir(), "gg-standing-real-"));
const reports = [];
const s = await startServer({ dataDir: dir, mind: "pi", onReport: (what, detail) => reports.push({ what, detail }) });
const call = async (method, params) => {
  const r = await s.service.handle(method, params);
  if (!r.ok) throw new Error(`${method} 失败:${r.error.code} ${r.error.message}`);
  return r.value;
};
const host = s.host;
const started = Date.now();
const k = await call("contacts.create", { clientActionId: "c1", name: "小克", persona: "你是这个群的秘书小克。说话简短、靠谱;只依据看到的原文,看不到的直说看不到。" });
const g = await call("rooms.createGroup", { clientActionId: "g1", title: "项目群", members: [{ kind: "contact", id: k.id }] });
let n = 0;
const say = (text, at = true) => call("messages.send", { roomId: g.id, clientActionId: `u${++n}`, text, ...(at ? { mentions: [{ id: k.id, source: "manual" }] } : {}) });
const msgs = async () => (await call("messages.list", { roomId: g.id, limit: 200 })).messages;
const schedules = async () => (await call("schedules.list", { roomId: g.id })).schedules;
async function until(what, cond, ms = 240_000) {
  const end = Date.now() + ms;
  for (;;) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 1000))]);
    if (!host.loop.busy() && (await cond())) return true;
    if (Date.now() > end) {
      console.log(`# 等不到:${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
const contactSpokeAfter = async (seq) => (await msgs()).some((m) => m.seq > seq && m.sender.kind === "contact");
const line = (m) => `#${m.seq} ${m.sender.kind === "contact" ? "小克" : m.sender.kind}: ${m.text.replace(/\n/g, "\n    ")}${m.replyToSeq ? ` 〔回复 #${m.replyToSeq}〕` : ""}`;

console.log(`# ${new Date().toISOString()} 真实 pi 联系人(模型 ${env.ANTHROPIC_DEFAULT_SONNET_MODEL},经网关 ${env.ANTHROPIC_AUTH_TOKEN ? "Bearer" : "x-api-key"}),startServer({ mind: "pi" })`);
console.log("# 命令: node packages/server/proof/standing-commitments-real.mjs");

console.log("\n## 1 用户:@小克 每天早上 8 点(上海时间)把群里前一天的讨论总结发群里");
const m1 = await say("@小克 每天早上 8 点(上海时间)把群里前一天的讨论总结发群里");
await until("小克回复第 1 条", () => contactSpokeAfter(m1.seq));
const l1 = await schedules();
console.log(`schedules.list → ${l1.length} 条`);
for (const x of l1) console.log(JSON.stringify({ id: x.id, contactId: x.contactId === k.id ? "小克" : x.contactId, roomId: x.roomId === g.id ? "项目群" : x.roomId, cron: x.cron, tz: x.tz, prompt: x.prompt, enabled: x.enabled, nextRunAt: x.nextRunAt, commitmentId: x.commitmentId }));
const ks = (await call("commitments.list", { contactId: k.id })).commitments;
console.log(`commitments.list → ${ks.map((c) => JSON.stringify({ id: c.id, status: c.status, sourceSeq: c.sourceSeq, scheduleId: c.scheduleId, text: c.text })).join(" ")}`);

console.log("\n## 2 群里来了两条讨论(没 @ 小克),随即 runNow");
await say("NEUTRAL_FIXTURE 昨天定了:周五下午发版,发版前冻结主分支", false);
const m3 = await say("NEUTRAL_FIXTURE 接口文档周三前定稿,前端按新字段改", false);
const sch = l1[0];
let summarySeq = null;
if (sch) {
  const fired = await call("schedules.runNow", { scheduleId: sch.id, clientActionId: "run1" });
  console.log(`runNow 返回 lastRun = ${JSON.stringify(fired.lastRun)}`);
  await until("定时这一轮结束", async () => (await call("schedules.history", { scheduleId: sch.id })).runs[0]?.status !== "running");
  const h = (await call("schedules.history", { scheduleId: sch.id })).runs;
  console.log(`schedules.history → ${JSON.stringify(h)}`);
  summarySeq = h[0]?.messageSeq ?? null;
  const out = (await msgs()).find((m) => m.seq === summarySeq);
  console.log(`回填的 messageSeq #${summarySeq}:${out ? out.text : "(无)"}`);
}

console.log("\n## 3 用户:@小克 改成 9 点");
const m4 = await say("@小克 改成 9 点");
await until("小克回复改时间", () => contactSpokeAfter(m4.seq));
const l2 = await schedules();
console.log(`schedules.list → ${l2.map((x) => JSON.stringify({ id: x.id, cron: x.cron, tz: x.tz, enabled: x.enabled, nextRunAt: x.nextRunAt })).join(" ")}`);

console.log("\n## 4 用户:@小克 停掉");
const m5 = await say("@小克 停掉");
await until("小克回复停掉", () => contactSpokeAfter(m5.seq));
const l3 = await schedules();
console.log(`schedules.list → ${l3.length ? l3.map((x) => JSON.stringify({ id: x.id, cron: x.cron, enabled: x.enabled, nextRunAt: x.nextRunAt })).join(" ") : "(空,已删除)"}`);
const ks2 = (await call("commitments.list", { contactId: k.id })).commitments;
console.log(`commitments.list → ${ks2.map((c) => JSON.stringify({ id: c.id, status: c.status, scheduleId: c.scheduleId })).join(" ")}`);

console.log("\n## 会话全文");
for (const m of await msgs()) console.log(line(m));
console.log("\n## 宿主报告(被拒动作、轮次失败)");
const shown = reports.filter((r) => ["action-rejected", "round-failed"].includes(r.what) || r.what.startsWith("attention:error"));
if (!shown.length) console.log("(无)");
for (const r of shown) console.log(r.what, redact(JSON.stringify(r.detail ?? null)).slice(0, 600));

const after2 = l2.find((x) => x.id === sch?.id);
const after3 = l3.find((x) => x.id === sch?.id);
console.log("\n# 判定:");
console.log(`#   ① 建出 1 条定时,归小克、在项目群、cron 0 8 * * *、tz Asia/Shanghai、与常驻承诺互相引用 = ${l1.length === 1 && sch.contactId === k.id && sch.roomId === g.id && sch.cron === "0 8 * * *" && sch.tz === "Asia/Shanghai" && !!sch.commitmentId && ks.some((c) => c.id === sch.commitmentId && c.scheduleId === sch.id)}`);
console.log(`#   ② runNow 后群里出现小克的发言,运行记录 ok 并回填 messageSeq = ${summarySeq !== null && summarySeq > m3.seq}`);
console.log(`#   ③ 改成 9 点:同一条定时 cron 变为 0 9 * * * = ${after2?.cron === "0 9 * * *"}`);
console.log(`#   ④ 停掉:定时停用或删除 = ${!after3 || after3.enabled === false}`);
console.log(`# 耗时 ${Date.now() - started} ms`);
await s.close();
rmSync(dir, { recursive: true, force: true });
