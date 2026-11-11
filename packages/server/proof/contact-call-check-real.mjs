// 片 CA2(feat/contact-call-check)的真实运行一次(手动跑,不在测试 glob 内):startServer mind=pi compute=claude。
// 验两件事:① 联系人用 reply 的 everyone 发言时,消息 mentions 是该会话全体成员(含用户、不含发送者自己、不含 Helper);
// ② 宿主当场校验拒下一个动作之后(这里让小克去认领小研名下的任务),小克不会在群里宣称「我认领了那个任务」,
//    被拒的 claim 不落盘(gg_effects 无记录、负责人不变),下一轮第 5 块把原因交给它。
//   node packages/server/proof/contact-call-check-real.mjs > packages/server/proof/contact-call-check-real.txt
// 网关地址与令牌只从环境变量读(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),不打印。
// 2026-11-12 本机跑不成:网关探测返回 HTTP 503,见同目录 contact-call-check-real-probe.txt;网关恢复后直接跑本脚本即可。
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
const dir = mkdtempSync(path.join(tmpdir(), "gg-contact-call-check-real-"));
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
console.log("# 命令: node packages/server/proof/contact-call-check-real.mjs");
const ke = await call("contacts.create", { clientActionId: "c1", name: "小克", persona: "你是群里的工程师小克,说话简短。" });
const yan = await call("contacts.create", { clientActionId: "c2", name: "小研", persona: "你是群里的工程师小研,说话简短。" });
names.set(ke.id, "小克");
names.set(yan.id, "小研");
const g = await call("rooms.createGroup", { clientActionId: "g1", title: "项目群", members: [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }] });

console.log("\n## 1 用户建一个面板任务并指定给小研");
const t = await call("tasks.create", { clientActionId: "t0", roomId: g.id, title: "写 alpha.md", description: "在当前工作目录写一个文件 alpha.md,内容只有一行:NEUTRAL_FIXTURE alpha ok。写完就算完成。" });
console.log(`tasks.create → ${t.id}「${t.title}」${t.state} 负责人=${t.ownerContactId ?? "无"} 来源 #${t.sourceSeq}`);
const assigned = await call("tasks.assign", { taskId: t.id, contactId: yan.id, clientActionId: "a1" });
console.log(`tasks.assign → ${t.id} 负责人=${nameOf({ kind: "contact", id: assigned.ownerContactId })}(${assigned.state})`);

console.log(`\n## 2 用户点名让小克去接小研名下那个任务(会被当场拒:已有人负责)`);
const ask = await call("messages.send", { roomId: g.id, clientActionId: "u1", text: `小克:小研手头那个任务(${t.id})你接过去做,用 claim_task 直接认领。接好之后在群里说一声。` });
console.log(`messages.send → #${ask.seq}:${ask.text}`);
await until("小克这一轮说完", async () => !host.loop.busy(), 5 * 60_000);

console.log("\n## 3 用户叫上群里所有人一起看一下安排(reply 的 everyone)");
const ask2 = await call("messages.send", { roomId: g.id, clientActionId: "u2", text: "叫上群里所有人一起看一下现在的安排(用 reply 的 everyone 参数 @ 全体),各自说一句。" });
console.log(`messages.send → #${ask2.seq}:${ask2.text}`);
await until("联系人安静下来", async () => !host.loop.busy(), 5 * 60_000);

const transcript = await msgs(g.id);
console.log("\n## 群聊全文");
for (const m of transcript) console.log(line(m));

const rejected = reports.filter((r) => r.what === "action-rejected");
console.log(`\n## 宿主判下的拒绝(${rejected.length} 条)`);
for (const r of rejected) console.log(`[${(r.t / 1000).toFixed(1)}s] ${nameOf({ kind: "contact", id: r.detail.contactId })} ${r.detail.action.kind} ${redact(JSON.stringify(r.detail.action)).slice(0, 200)} → ${r.detail.reason}`);
const notes = host.db.store.db.prepare("SELECT action_id, contact_id, tool, action, reason, shown_in FROM gg_rejection_notes ORDER BY rowid").all();
console.log(`\n## 被拒动作回告台账 gg_rejection_notes(${notes.length} 条;shown_in = 第 5 块给到它的那一轮)`);
for (const n of notes) console.log(JSON.stringify({ contact: nameOf({ kind: "contact", id: n.contact_id }), action: n.action, reason: n.reason, shownIn: n.shown_in }));
const effects = host.db.store.db.prepare("SELECT action_id, kind, status, error FROM gg_effects ORDER BY created_at, action_id").all();
console.log(`\n## gg_effects(${effects.length} 条)`);
for (const e of effects) console.log(JSON.stringify({ kind: e.kind, status: e.status, error: e.error }));
const failedRounds = reports.filter((r) => r.what === "round-failed" || String(r.what).startsWith("attention:error"));
if (failedRounds.length) {
  console.log("\n## 轮次失败");
  for (const r of failedRounds) {
    const d = r.detail;
    const msg = d instanceof Error ? `${d.name}: ${d.message}` : "";
    console.log(`[${(r.t / 1000).toFixed(1)}s] ${r.what} ${redact(JSON.stringify(d ?? null)).slice(0, 300)} ${redact(msg).slice(0, 400)}`);
  }
}

// 联系人一个动作都没出时,先看宿主报了什么、私聊里有没有失败卡(诊断用)
const kinds = new Map();
for (const r of reports) kinds.set(r.what, (kinds.get(r.what) ?? 0) + 1);
console.log(`\n## onReport 汇总(${reports.length} 条)`);
for (const [k, n] of kinds) console.log(`  ${k} × ${n}`);
console.log("\n## 联系人与他们的私聊(失败卡出在这里)");
for (const c of [ke, yan]) {
  const v = host.listContacts().find((x) => x.id === c.id);
  console.log(`  ${nameOf({ kind: "contact", id: c.id })}:说话模型=${v?.speakingModel} 活动=${JSON.stringify(v?.activity ?? null)}`);
  const dm = host.openDm(c.id);
  for (const m of await msgs(dm.id)) console.log(`    [私聊] ${line(m)}`);
}
console.log("\n## 全部 report(最多 40 条)");
for (const r of reports.slice(0, 40)) console.log(`[${(r.t / 1000).toFixed(1)}s] ${r.what} ${redact(JSON.stringify(r.detail ?? null)).slice(0, 400)}`);

// ① 小克有没有真的去碰那个任务(被当场拒或轮末拒的 claim)
const claimRejections = rejected.filter((r) => r.detail.action.kind === "claim");
// ② 被当场拒的同一轮里宣称「已经接走」的 reply 被轮末拦下的条数(机制生效的证据)
const withheld = rejected.filter((r) => String(r.detail.reason).includes("这句话宣称它已完成"));
// ③ 被当场拒的 claim 没落盘:负责人没变、gg_effects 里没有 claim
const owner = (await call("tasks.get", { taskId: t.id })).ownerContactId;
const claimEffects = effects.filter((e) => e.kind === "claim");
// ④ 有联系人用 @everyone 发言:mentions 覆盖该会话全体成员(含用户、不含发送者自己)
const members = host.members(g.id);
const everyoneMsgs = transcript.filter((m) => {
  if (m.sender.kind !== "contact" || !m.mentions?.length) return false;
  const got = new Set(m.mentions.map((x) => x.id));
  const want = members.filter((x) => !(x.kind === m.sender.kind && x.id === m.sender.id)).map((x) => x.id);
  return want.length > 1 && want.every((id) => got.has(id));
});
// 被拒的动作有没有回告过(之后的轮次给到它);模型没去碰就是 0 条
const taskNotes = notes.filter((n) => n.action.includes(t.id));
console.log("\n# 实测读数(不是通过/失败判决,按上面原始输出核):");
console.log(`#   ① 针对 ${t.id} 的 claim 被拒:${claimRejections.length} 条(0 条说明这一次模型没去碰它)`);
console.log(`#   ② 当场被拒的同一轮里宣称「已完成」而被轮末拦下的 reply:${withheld.length} 条${withheld.length ? `(${withheld.map((r) => `${nameOf({ kind: "contact", id: r.detail.contactId })} #${String(r.detail.action.roomId)}, 「${String(r.detail.action.text).slice(0, 30)}」`).join(";")})` : "(这一次模型没有在被拒的同一轮里宣称;被拦下时这里会出现 1 条,原因以「这句话宣称它已完成」开头)"}`);
console.log(`#   ③ 被拒的 claim 没落盘:负责人仍是小研 = ${owner === yan.id}(${nameOf({ kind: "contact", id: owner ?? "无" })});gg_effects 里 claim 记录 = ${claimEffects.length} 条`);
console.log(`#   ④ 联系人用 @everyone 发言:${everyoneMsgs.length} 条${everyoneMsgs.length ? `(${everyoneMsgs.map((m) => `#${m.seq} ${nameOf(m.sender)} → @${m.mentions.map((x) => nameOf({ kind: x.id === host.userId ? "user" : "contact", id: x.id })).join(",")}`).join(";")})` : "(这一次没有)"}`);
console.log(`#   ⑤ 被拒的动作有回告:${taskNotes.length === 0 ? "不适用(没去碰)" : taskNotes.map((n) => `shown_in=${n.shown_in ?? "还没给过"}`).join(";")}`);
console.log(`#   耗时 ${Date.now() - t0} ms;用户请求 #${ask.seq}、#${ask2.seq}`);
await s.close();
rmSync(dir, { recursive: true, force: true });
