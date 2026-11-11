// 真实运行一次(手动跑,不在测试 glob 内):startServer mind=pi compute=claude。群里两位联系人;用户用 tasks.create 建 2 个面板任务
// (不指定负责人,停在 T1_Open),再不 @ 任何人说「面板上有两个任务,你们各自认领一个做掉」(按 US1)。核对:两人各用 claim_task 认领一个、
// 各起一个 Claude Code Compute 并交付、没有另建重复任务;过程中宿主判下的拒绝逐条列出,并核对每条都在该联系人的下一轮第 5 块给过。
//   node packages/server/proof/contact-actions-real.mjs > packages/server/proof/contact-actions-real.txt
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
const BUDGET_MS = Number(env.REAL_BUDGET_MS ?? 15 * 60_000);
const dir = mkdtempSync(path.join(tmpdir(), "gg-contact-actions-real-"));
const reports = [];
const t0 = Date.now();
const s = await startServer({ dataDir: dir, mind: "pi", compute: "claude", onReport: (what, detail) => reports.push({ t: Date.now() - t0, what, detail }) });
const host = s.host;
const call = async (method, params) => {
  const r = await s.service.handle(method, params);
  if (!r.ok) throw new Error(`${method} 失败:${r.error.code} ${r.error.message}`);
  return r.value;
};
const names = new Map();
const nameOf = (x) => (x.kind === "user" ? "我" : (names.get(x.id) ?? x.id));
const events = [];
s.service.subscribe((e) => {
  if (e.type === "task.updated") events.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 任务 ${e.task.id}「${e.task.title}」${e.task.state} v${e.task.constraintVersion} 负责人=${e.task.ownerContactId ? nameOf({ kind: "contact", id: e.task.ownerContactId }) : "无"}`);
});
async function until(what, cond, ms) {
  const end = Math.min(Date.now() + ms, t0 + BUDGET_MS);
  for (;;) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 2000))]);
    if (await cond()) return true;
    if (Date.now() > end) {
      console.log(`# 等不到:${what}(${Math.round((Date.now() - t0) / 1000)}s)`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const msgs = async (roomId) => (await call("messages.list", { roomId, limit: 500 })).messages;
const line = (m) => {
  const extra = [m.replyToSeq != null ? `↩#${m.replyToSeq}` : "", m.mentions?.length ? `@${m.mentions.map((x) => nameOf({ kind: x.id === host.userId ? "user" : "contact", id: x.id })).join(",")}` : "", m.card ? `[卡:${m.card.kind}]` : ""].filter(Boolean).join(" ");
  return `#${m.seq} ${nameOf(m.sender)}${extra ? `(${extra})` : ""}: ${m.text.replace(/\n/g, "\n    ")}`;
};

console.log(`# ${new Date().toISOString()} 真实 pi 联系人 + Claude Code Compute(模型 ${env.ANTHROPIC_DEFAULT_SONNET_MODEL},经网关 ${env.ANTHROPIC_AUTH_TOKEN ? "Bearer" : "x-api-key"}),startServer({ mind: "pi", compute: "claude" })`);
console.log("# 命令: node packages/server/proof/contact-actions-real.mjs");
const ke = await call("contacts.create", { clientActionId: "c1", name: "小克", persona: "你是群里的工程师小克,说话简短。" });
const yan = await call("contacts.create", { clientActionId: "c2", name: "小研", persona: "你是群里的工程师小研,说话简短。" });
names.set(ke.id, "小克");
names.set(yan.id, "小研");
const g = await call("rooms.createGroup", { clientActionId: "g1", title: "项目群", members: [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }] });

console.log("\n## 1 用户 tasks.create 建 2 个面板任务(不指定负责人)");
const specs = [
  ["写 alpha.md", "在当前工作目录写一个文件 alpha.md,内容只有一行:NEUTRAL_FIXTURE alpha ok。写完就算完成。"],
  ["写 beta.md", "在当前工作目录写一个文件 beta.md,内容只有一行:NEUTRAL_FIXTURE beta ok。写完就算完成。"],
];
const tasks = [];
for (const [i, [title, description]] of specs.entries()) tasks.push(await call("tasks.create", { clientActionId: `t${i}`, roomId: g.id, title, description }));
for (const t of tasks) console.log(`tasks.create → ${t.id}「${t.title}」${t.state} 负责人=${t.ownerContactId ?? "无"} 来源 #${t.sourceSeq}`);

console.log("\n## 2 用户不 @ 任何人:面板上有两个任务,你们各自认领一个做掉,做完在群里说一声");
const ask = await call("messages.send", { roomId: g.id, clientActionId: "u1", text: "面板上有两个任务,你们各自认领一个做掉,做完在群里说一声" });
const DONE = new Set(["T5_InReview", "T8a_Delivered", "T8_Accepted"]);
const finished = await until("两个任务都交付", async () => {
  const ts = (await call("tasks.list", { roomId: g.id })).tasks;
  return tasks.every((t) => DONE.has(ts.find((x) => x.id === t.id)?.state)) && !host.loop.busy();
}, 12 * 60_000);
// 交付后再等联系人把手头的一轮说完
await until("联系人安静下来", async () => !host.loop.busy(), 60_000);

const all = (await call("tasks.list", { roomId: g.id })).tasks;
console.log("\n## 任务面板(收尾时)");
for (const t of all) console.log(JSON.stringify({ id: t.id, title: t.title, state: t.state, v: t.constraintVersion, owner: t.ownerContactId ? nameOf({ kind: "contact", id: t.ownerContactId }) : null, computeRuns: (t.computeRuns ?? []).length }));
console.log("\n## 任务状态变化");
for (const e of events) console.log(e);

const transcript = await msgs(g.id);
console.log("\n## 群聊全文");
for (const m of transcript) console.log(line(m));

const rejected = reports.filter((r) => r.what === "action-rejected");
console.log(`\n## 宿主判下的拒绝(${rejected.length} 条)`);
for (const r of rejected) console.log(`[${(r.t / 1000).toFixed(1)}s] ${nameOf({ kind: "contact", id: r.detail.contactId })} ${r.detail.action.kind} ${redact(JSON.stringify(r.detail.action)).slice(0, 200)} → ${r.detail.reason}`);
const notes = host.db.store.db.prepare("SELECT action_id, contact_id, tool, action, reason, shown_in FROM gg_rejection_notes ORDER BY rowid").all();
console.log(`\n## 被拒动作回告台账 gg_rejection_notes(${notes.length} 条;shown_in = 第 5 块给到它的那一轮)`);
for (const n of notes) console.log(JSON.stringify({ contact: nameOf({ kind: "contact", id: n.contact_id }), action: n.action, reason: n.reason, shownIn: n.shown_in }));
const failedRounds = reports.filter((r) => r.what === "round-failed" || String(r.what).startsWith("attention:error"));
if (failedRounds.length) {
  console.log("\n## 轮次失败");
  for (const r of failedRounds) {
    const d = r.detail;
    const msg = d instanceof Error ? `${d.name}: ${d.message}` : "";
    console.log(`[${(r.t / 1000).toFixed(1)}s] ${r.what.replace(/:(c-[\w-]+)$/, (_, id) => `:${nameOf({ kind: "contact", id })}`)} ${redact(JSON.stringify(d ?? null)).slice(0, 300)} ${redact(msg).slice(0, 400)}`);
  }
}

const claimMsgs = transcript.filter((m) => m.sender.kind === "contact" && m.text.startsWith("认领了任务:"));
const owners = tasks.map((t) => all.find((x) => x.id === t.id)?.ownerContactId ?? null);
const assignMsgs = transcript.filter((m) => m.sender.kind === "user" && m.text.startsWith("把任务「"));
// 每位联系人的轮次顺序(宿主每轮装配时报一条 recall,带 roundId);一条拒绝之后该联系人还有轮次,才谈得上「下一轮给过」
const roundsOf = (contactId) => reports.filter((r) => r.what === "recall" && r.detail.contactId === contactId).map((r) => r.detail.roundId);
const laterRounds = (n) => {
  const rs = roundsOf(n.contact_id);
  const i = rs.indexOf(n.action_id.split(":rej:")[0]);
  return i < 0 ? [] : rs.slice(i + 1);
};
const owed = notes.filter((n) => laterRounds(n).length > 0);
console.log("\n# 判定:");
console.log(`#   ① 两个面板任务各有负责人且是不同的两人 = ${owners.every(Boolean) && new Set(owners).size === 2}(${owners.map((o) => (o ? nameOf({ kind: "contact", id: o }) : "无")).join("、")})`);
console.log(`#   ② 负责人来自联系人 claim_task(群里有「认领了任务」消息,用户没有 tasks.assign) = ${tasks.every((t, i) => claimMsgs.some((m) => m.sender.id === owners[i] && m.replyToSeq === t.sourceSeq)) && assignMsgs.length === 0}`);
console.log(`#   ③ 两个任务都起了 Compute 并交付(T5/T8a/T8) = ${tasks.every((t) => { const v = all.find((x) => x.id === t.id); return v && DONE.has(v.state) && (v.computeRuns ?? []).length >= 1; })}`);
console.log(`#   ④ 没有另建重复任务(本群任务数 = 2) = ${all.length === 2}`);
console.log(`#   ⑤ 被拒动作之后该联系人还有轮次的,都在之后的某一轮第 5 块给过且只记一次(shown_in 是之后的轮次) = ${owed.every((n) => laterRounds(n).includes(n.shown_in))}(共 ${notes.length} 条,其中之后还有轮次的 ${owed.length} 条)`);
console.log(`#   用户请求之后 ${finished ? "全部交付" : "未在预算内全部交付"};耗时 ${Date.now() - t0} ms;请求 #${ask.seq}`);
await s.close();
rmSync(dir, { recursive: true, force: true });
