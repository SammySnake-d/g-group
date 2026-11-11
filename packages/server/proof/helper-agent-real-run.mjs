// AC-52 / U04 真实运行(真模型经本机网关,令牌只经环境变量):全部走生产入口 cli.ts(helper 子命令叫 Helper,call 子命令建联系人与读库核对)。
// 三条路径:全局「建群拉人」;侧栏在该群「CSV 变任务」;全局「把小研删掉」→ Helper 照 skill 先问 →「同意」→ 删除。另走一次 @Helper。
// 网关偶发断流(502 / connection reset,属模型通道,不是软件问题)时同一步最多重跑 1 次,两次输出都照录。
// 用法:ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… ANTHROPIC_DEFAULT_SONNET_MODEL=… node packages/server/proof/helper-agent-real-run.mjs > packages/server/proof/helper-agent-real.txt
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.env.GG_ROOT ?? path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "packages/server/src/cli.ts");
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("需要 ANTHROPIC_AUTH_TOKEN(或 ANTHROPIC_API_KEY)环境变量");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-helper-real-"));
const db = path.join(dir, "gg.db");
const secrets = [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_BASE_URL].filter(Boolean);
const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join("[已隐去]"), s);
const cli = (args, label) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 600_000 });
  console.log(`\n$ cli.ts ${args.map((a) => (a.includes(" ") || a.includes("\n") ? JSON.stringify(a) : a)).join(" ").replace(db, "<db>")}   # ${label}(${((Date.now() - t0) / 1000).toFixed(1)}s,退出码 ${r.status})`);
  console.log(scrub(r.stdout).trimEnd());
  const err = scrub(r.stderr).split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l));
  if (err.length) console.log(`[stderr] ${err.join("\n[stderr] ")}`);
  return r.stdout;
};
const json = (s) => JSON.parse(s);
const gatewayDrop = (out) => /"code": "unavailable"/.test(out) && /(api_error|502|connection reset|EOF)/.test(out);
/** 叫 Helper;网关断流时重跑一次(建群那步先读库,已建出来就不重跑,免得重复建)。 */
const helper = (args, label, done = () => false) => {
  const out = cli(["helper", "--db", db, "--mind", "pi", ...args], label);
  if (!gatewayDrop(out)) return out;
  if (done()) {
    console.log("(这一步的工具已执行完,只有最后一次模型请求被网关断开;读库确认已生效,不重跑)");
    return out;
  }
  console.log("(网关断流,同一步重跑 1 次)");
  return cli(["helper", "--db", db, "--mind", "pi", ...args], `${label}·重跑`);
};
console.log(`# Helper 真实运行 ${new Date().toISOString()} node ${process.version} 模型 ${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "(未设)"}`);
cli(["call", "--db", db, "contacts.create", JSON.stringify({ clientActionId: "c1", name: "小克" })], "准备:建联系人小克");
cli(["call", "--db", db, "contacts.create", JSON.stringify({ clientActionId: "c2", name: "小研" })], "准备:建联系人小研");

console.log("\n## 一、全局入口:帮我建个群叫 发布群,拉小克和小研进来");
helper(["帮我建个群叫 发布群,拉小克和小研进来"], "全局", () => json(cli(["call", "--db", db, "rooms.list", "{}"], "读库:发布群建出来没有")).value.rooms.some((r) => r.title === "发布群" && r.members.length === 3));
const rooms = json(cli(["call", "--db", db, "rooms.list", "{}"], "读库核对:会话列表")).value.rooms;
const g = rooms.find((r) => r.title === "发布群");
const names = Object.fromEntries(json(cli(["call", "--db", db, "contacts.list", "{}"], "读库核对:联系人")).value.contacts.map((c) => [c.id, c.name]));
console.log(`核对:发布群${g ? `存在 id=${g.id},成员 ${g.members.map((m) => (m.kind === "user" ? "我" : names[m.id] ?? m.id)).join("、")}` : "不存在"}`);

console.log("\n## 二、在发布群的侧栏:把这个 CSV 变成任务");
const csv = "title,备注\n写发布说明,中英两版\n回归测试,\"覆盖登录, 支付\"\n整理发布清单,周五前";
const before = g ? json(cli(["call", "--db", db, "messages.list", JSON.stringify({ roomId: g.id })], "侧栏前的群消息")).value.messages.length : 0;
helper(["--entry", "sidebar", "--room", "发布群", `把这个 CSV 变成任务:\n${csv}`], "侧栏", () => g !== undefined && json(cli(["call", "--db", db, "tasks.list", JSON.stringify({ roomId: g.id })], "读库:任务建出来没有")).value.tasks.length === 3);
if (g) {
  const tasks = json(cli(["call", "--db", db, "tasks.list", JSON.stringify({ roomId: g.id })], "读库核对:发布群的任务")).value.tasks;
  const msgs = json(cli(["call", "--db", db, "messages.list", JSON.stringify({ roomId: g.id })], "读库核对:发布群消息")).value.messages;
  console.log(`核对:发布群任务 ${tasks.length} 个:${tasks.map((t) => `「${t.title}」${t.state}`).join("、")};群里新增消息 ${msgs.length - before} 条:${msgs.slice(before).map((m) => `${m.sender.kind}${m.card ? `[${m.card.kind}]` : ""}`).join("、")}`);
}

console.log("\n## 三、全局入口:把小研删掉 → 先问 → 同意");
helper(["把小研删掉"], "全局");
const mid = json(cli(["call", "--db", db, "contacts.list", "{}"], "读库核对:问完之后的联系人")).value.contacts.map((c) => c.name);
console.log(`核对:Helper 问完、用户还没同意时联系人 = ${mid.join("、")}`);
helper(["同意"], "全局");
let end = json(cli(["call", "--db", db, "contacts.list", "{}"], "读库核对:同意之后的联系人")).value.contacts.map((c) => c.name);
console.log(`核对:用户回「同意」后联系人 = ${end.join("、")}`);
if (end.includes("小研")) {
  // Helper 追问「删联系人还是移出群」时,用户照它的问法说清
  helper(["同意删除联系人"], "全局·用户说清");
  end = json(cli(["call", "--db", db, "contacts.list", "{}"], "读库核对:说清之后的联系人")).value.contacts.map((c) => c.name);
  console.log(`核对:用户说清后联系人 = ${end.join("、")}`);
}

console.log("\n## 四、在发布群里 @Helper");
cli(["helper", "--db", db, "--mind", "pi", "--entry", "mention", "--room", "发布群", "这个群现在有哪些任务?"], "@Helper");
if (g) {
  const last = json(cli(["call", "--db", db, "messages.list", JSON.stringify({ roomId: g.id, limit: 5 })], "读库核对:群里最后几条")).value.messages.slice(-2);
  console.log(`核对:群里最后两条 = ${last.map((m) => `#${m.seq} ${m.sender.kind}${m.replyToSeq !== null ? ` 回复#${m.replyToSeq}` : ""}`).join(";")}`);
}

console.log("\n## 审计表 gg_helper_ops 与上下文清单 gg_helper_context(读库)");
const { DatabaseSync } = await import("node:sqlite");
const sq = new DatabaseSync(db, { readOnly: true });
for (const r of sq.prepare("SELECT ask_id, entry, op, ok, substr(result, 1, 120) AS result FROM gg_helper_ops ORDER BY rowid").all()) console.log(`ops  ${r.ask_id} ${r.entry} ${r.op} ok=${r.ok} ${r.result.replace(/\n/g, " ")}`);
for (const r of sq.prepare("SELECT ask_id, entry, via, room_id, seqs FROM gg_helper_context ORDER BY rowid").all()) console.log(`ctx  ${r.ask_id} ${r.entry} ${r.via} ${r.room_id} ${r.seqs}`);
sq.close();
fs.rmSync(dir, { recursive: true, force: true });
