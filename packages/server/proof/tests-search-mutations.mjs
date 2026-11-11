// 回执判定 / 注意循环 / 终态回收 / 全局搜群与联系人 / 转发授权标志(feat/tests-search)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片与相邻的既有测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死。
// 用法: node packages/server/proof/tests-search-mutations.mjs   (低并发:串行一个一个跑)
// 没做成本片变异的等价项:SR04「只列自己所在的会话」——现有多用户场景里没有「自己不在的会话」可构造(单用户产品),
// 这一条由 search.ts 的 JOIN gg_members ... member_id = ? 保证,留待多用户会话出来再埋雷。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/receipts.test.ts",
  "packages/server/src/attention-group.test.ts",
  "packages/server/src/search-rooms.test.ts",
  "packages/server/src/consent-forward.test.ts",
  "packages/server/src/host.test.ts",
  "packages/server/src/chat-ops.test.ts",
  "packages/server/src/search.test.ts",
  "packages/server/src/rewind.test.ts",
];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const H = "packages/server/src/host.ts";
const R = "packages/server/src/receipts.ts";
const A = "packages/server/src/attention-group.ts";
const S = "packages/server/src/search.ts";

const M = [
  // ---- AC-46 回执位置(③④②)----
  ["RC01 已读位置允许回退", R, "  const upto = Math.min(seq, lastSeq);\n  return upto > cur ? upto : null;", "  return Math.min(seq, lastSeq);"],
  ["RC02 已读位置根本不推进", R, "  const upto = Math.min(seq, lastSeq);\n  return upto > cur ? upto : null;", "  return null;"],
  ["RC03 读到时间取最后一次(不是第一次越过)", R, "  let first: string | null = null;\n  for (const m of marks) {\n    if (m.uptoSeq < seq) continue;\n    if (first === null || m.at < first) first = m.at;\n  }\n  return first;", "  let last: string | null = null;\n  for (const m of marks) {\n    if (m.uptoSeq < seq) continue;\n    last = m.at;\n  }\n  return last;"],
  ["RC04 回执名单把发送人自己也算进去", H, "    const audience = this.members(roomId).filter((x) => !(x.kind === m.sender.kind && x.id === m.sender.id));", "    const audience = this.members(roomId);"],
  ["RC05 接走时不推进已读(落盘才算已读)", H, '    for (const r of rooms) if (fresh.some((f) => f.kind === "message" && f.roomId === r.id)) this.markRead(r.id, { kind: "contact", id: contactId }, lastSeen[r.id] ?? 0);', "    for (const r of rooms) void r;"],
  ["RC06 这一轮失败就把已读位置丢掉(回退)", H, "      return this.onContactFailure(contactId, contact.name, e, { upstream, focusRoom, lastSeen, inboxEnd });", '      run(this.db, "DELETE FROM gg_read WHERE kind = \'contact\' AND member_id = ?", contactId);\n      return this.onContactFailure(contactId, contact.name, e, { upstream, focusRoom, lastSeen, inboxEnd });'],
  // ---- AC-31 ①④ 注意循环 ----
  ["AG01 群里没被 @ 就不送达(前置过滤)", A, '  return o.direct && o.fromUser ? "now" : "batch";', '  return o.direct && o.fromUser ? "now" : null;'],
  ["AG02 不做发送前撤销检查", A, "  return events.filter((e) => e.seq > sinceSeq && e.sender.kind === \"user\").map((e) => e.seq);", "  return [];"],
  // ---- AC-31 ⑤ 终态回收 ----
  ["GC01 终态不回收承诺", H, "    if (!dead.length) return [];\n    this.ledgerTx(", "    if (!dead.length) return [];\n    if (dead.length) return [];\n    this.ledgerTx("],
  ["GC02 终态只认失败(漏掉取消 T10)", H, '      if (doc.task.state !== "T10_Cancelled" && doc.task.state !== "T11_Failed") continue;', '      if (doc.task.state !== "T11_Failed") continue;'],
  ["GC03 不看终态,只要还在跑就回收", H, '      if (doc.task.state !== "T10_Cancelled" && doc.task.state !== "T11_Failed") continue;', "      if (false) continue;"],
  // ---- U32 全局搜群与联系人 ----
  ["SR01 全局搜群与联系人不返回结果", S, "  const out: RoomSearchHit[] = [];", "  const out: RoomSearchHit[] = [];\n  if (terms.length) return out;"],
  ["SR02 搜索区分大小写", S, "    if (!terms.every((t) => fields.some((f) => f.name.toLowerCase().includes(t.toLowerCase())))) continue;", "    if (!terms.every((t) => fields.some((f) => f.name.includes(t)))) continue;"],
  ["SR03 多词只要有一个命中就算", S, "    if (!terms.every((t) => fields.some((f) => f.name.toLowerCase().includes(t.toLowerCase())))) continue;", "    if (!terms.some((t) => fields.some((f) => f.name.toLowerCase().includes(t.toLowerCase())))) continue;"],
  ["SR04 命中位置不按关键词给", S, "      highlights: highlightsIn(hit.name, mine),", "      highlights: [],"],
  // ---- AC-20 转发同意不放行 ----
  ["CF01 转发标志写死 false", H, "    return this.links.has(roomId, seq);", "    return false;"],
  ["CF02 非转发也说成转发", H, "    return this.links.has(roomId, seq);", "    return seq > 0;"],
  ["CF03 转发副本不过授权判定", H, "      const consent = this.consentFromMessage(to.id, r.seq);", "      const consent = { effects: [] as HostEffect[], appended: [] as { roomId: string; seq: number; sender: Member }[], tasks: [] as string[] };"],
];

function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      resolve({ code, timedOut, failed: [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]), passed: [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]) });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsearch-mut-"));
// 副本自带 node_modules:第三方依赖链接到原仓库,@g-group/* 链到副本自己的 packages,跨包导入也能看到注入的故障
function copy(name) {
  const d = path.join(tmp, name);
  fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/(^|[/\\])(node_modules|\.git|proof)([/\\]|$)/.test(path.relative(ROOT, s)) });
  const nm = path.join(d, "node_modules");
  fs.mkdirSync(path.join(nm, "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) if (e !== "@g-group") fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(nm, e));
  for (const pkg of fs.readdirSync(path.join(d, "packages"))) fs.symlinkSync(path.join("..", "..", "packages", pkg), path.join(nm, "@g-group", pkg));
  return d;
}

let ok = true;
const clean = await run(copy("clean"));
const named = new Set(clean.passed);
const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`node ${process.version}`);
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (!cleanOk) ok = false;
let killed = 0, survived = 0, timeouts = 0;
const ONLY = process.env.MUT_ONLY ? process.env.MUT_ONLY.split(",") : null;
for (const [i, [name, file, from, to]] of M.entries()) {
  if (ONLY && !ONLY.some((p) => name.startsWith(p))) continue;
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  const f = path.join(d, file);
  const src = fs.readFileSync(f, "utf8");
  const n = src.split(from).length - 1;
  if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次`); fs.rmSync(d, { recursive: true, force: true }); continue; }
  fs.writeFileSync(f, src.replace(from, to));
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (process.env.CC_MUT_PROGRESS) fs.appendFileSync(process.env.CC_MUT_PROGRESS, `__MUT__${JSON.stringify({ name, killed: kills, red: r.failed })}\n`);
  if (r.timedOut) { ok = false; timeouts++; console.log(`✗ ${tag} ${name}:超时,不算杀死`); }
  else if (kills.length > 0) { killed++; console.log(`✓ ${tag} ${name}:用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被「${kills[0]}」发现`); }
  else { ok = false; survived++; console.log(`✗ ${tag} ${name}:存活(或只有文件级失败)`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived},超时 ${timeouts}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
