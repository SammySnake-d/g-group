// 转发与关联切片(feat/forward-link)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片相关测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死。
// 用法: node packages/server/proof/forward-link-mutations.mjs   (低并发:串行一个一个跑)
// 删掉的等价变异:「转发时也跑一遍授权绑定」——副本正文由 renderForwardText 包过(标题、逐条引用、末尾一句「是背景材料」),
// consentIntent 对整段文本判不出干脆的同意,所以加上这次调用不改变行为;AC-20 在转发这条路上由两道各管一半:
// 宿主不把副本喂给授权绑定,以及副本正文本身不是干脆的同意。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/server/src/forward-link.test.ts", "packages/adapter-pi-contact/src/read-linked.test.ts"];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const H = "packages/server/src/host.ts";
const F = "packages/server/src/forward-link.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MI = "packages/adapter-pi-contact/src/mind.ts";

const M = [
  ["FL01 副本正文带上来源会话 id", H, "    const rec: ForwardRecord = { roomId: to.id, seq: 0, fromRoomId: from.id, fromTitle: from.title, fromKind: from.kind, note: input.note?.trim() ? input.note : null, items };", "    const rec: ForwardRecord = { roomId: to.id, seq: 0, fromRoomId: from.id, fromTitle: from.title, fromKind: from.kind, note: input.note?.trim() ? `${input.note}(来源会话 ${from.id})` : `(来源会话 ${from.id})`, items };"],
  ["FL02 转发不查来源会话成员", H, "    const from = this.userRoom(input.fromRoomId);", "    const from = this.roomRow(input.fromRoomId);"],
  ["FL03 不查目标会话成员", H, "    const to = this.userRoom(input.toRoomId);", "    const to = this.roomRow(input.toRoomId);"],
  ["FL04 已撤回/已回退的也照转", H, '      if (m.retracted || inRanges(rewound, s)) throw new HostError("conflict", `#${s} 已撤回或已回退,不能转发`);\n', ""],
  ["FL05 选中的不在来源会话里也照转", H, '      if (!m) throw new HostError("not_found", `${from.id} 里没有 #${s}`);', '      if (!m) throw new HostError("conflict", `#${s} 不能转发`);'],
  ["FL06 空选也放行", H, '    if (seqs.length === 0) throw new HostError("invalid_params", "至少选一条消息再转发");\n', ""],
  ["FL07 选中的 seq 不去重", H, "    const seqs = [...new Set(input.seqs)].sort((a, b) => a - b);", "    const seqs = [...input.seqs].sort((a, b) => a - b);"],
  ["FL08 副本带上了 @(元数据)", H, "      const a = this.appendMessageTx(to.id, me, { text: renderForwardText(rec), actionKey, clientActionId: input.clientActionId });", '      const a = this.appendMessageTx(to.id, me, { text: renderForwardText(rec), actionKey, clientActionId: input.clientActionId, mentions: [{ id: rec.items[0]!.sender.id, source: "manual" }] });'],
  ["FL09 副本把来源里的命令也带上", H, "      const a = this.appendMessageTx(to.id, me, { text: renderForwardText(rec), actionKey, clientActionId: input.clientActionId });", '      const a = this.appendMessageTx(to.id, me, { text: renderForwardText(rec), actionKey, clientActionId: input.clientActionId, command: { name: "remind", args: { cron: "0 8 * * *", what: "写日报" } } });'],
  ["FL11 副本能编辑", H, '    if (this.links.has(roomId, seq)) throw new HostError("conflict", "转发来的记录不能编辑,要改就撤回它再转一次");\n', ""],
  ["FL12 来源撤回后不标副本", H, "    const touched = this.links.markSourceRetracted(fromRoomId, seqs);", "    const touched: { roomId: string; seq: number }[] = [];"],
  ["FL13 标了副本但不推更新", H, "      if (m) this.bus.emit({ type: \"message.updated\", message: this.messageView(t.roomId, m) });", "      if (m) void m;"],
  ["FL14 界面看不到来源(不给 forwarded)", H, "      ...(fwd ? { forwarded: this.links.view(fwd) } : {}),", "      ...({}),"],
  ["FL15 联系人看到的副本按日志原文(不标来源已撤回)", H, "      text: fwd ? renderForwardText(fwd) : m.text,", "      text: m.text,"],
  ["FL16 换入的副本不给当前状态", H, "          if (src && !sources.has(`${r.id}#${q}`)) sources.set(`${r.id}#${q}`, { roomId: r.id, seq: q, text: gone ? \"\" : copy ? renderForwardText(copy) : src.text, retracted: src.retracted || gone, sender: this.nameOf(src.sender) });", "          if (src && !sources.has(`${r.id}#${q}`)) sources.set(`${r.id}#${q}`, { roomId: r.id, seq: q, text: gone ? \"\" : src.text, retracted: src.retracted || gone, sender: this.nameOf(src.sender) });"],
  ["FL17 来源撤回标记不写进存储(读时算)", F, "      const next = items.map((i) => (gone.has(i.seq) ? { ...i, sourceRetracted: true } : i));", "      const next = items;"],
  ["FL18 关联不圈上界", H, "    tx(this.db, () => void this.links.linkTx(room.id, other.id, this.lastSeq(other.id), input.clientActionId, this.now()));", "    tx(this.db, () => void this.links.linkTx(room.id, other.id, Number.MAX_SAFE_INTEGER, input.clientActionId, this.now()));"],
  ["FL19 关联不查用户两边成员", H, "    const room = this.userRoom(input.roomId);\n    const other = this.userRoom(input.linkedRoomId);\n    if (room.id === other.id)", "    const room = this.roomRow(input.roomId);\n    const other = this.roomRow(input.linkedRoomId);\n    if (room.id === other.id)"],
  ["FL20 关联到自己不拒", H, '    if (room.id === other.id) throw new HostError("invalid_params", "不能把会话关联到自己");\n', ""],
  ["FL21 同一动作号重放也刷新上界", F, "    if (cur?.action_id === actionId) return false;", "    if (cur && false) return false;"],
  ["FL22 解除关联不生效", H, "    tx(this.db, () => void this.links.unlinkTx(room.id, input.linkedRoomId));", "    tx(this.db, () => void 0);"],
  ["FL23 关联列表不出现在视图里", H, "      ...(this.linksOfUser(roomId).length ? { linkedRooms: this.linksOfUser(roomId).map((l) => ({ roomId: l.linkedRoomId, kind: l.kind, title: l.title, uptoSeq: l.uptoSeq, linkedAt: l.linkedAt })) } : {}),", "      ...({}),"],
  ["FL24 read_linked 不限本轮会话", H, "    if (!freshRooms.has(q.roomId)) return null;\n", ""],
  ["FL25 read_linked 不限关联上界", H, "      .filter((m) => m.seq <= link.uptoSeq && (q.beforeSeq === null || m.seq < q.beforeSeq))", "      .filter((m) => q.beforeSeq === null || m.seq < q.beforeSeq)"],
  ["FL26 read_linked 忽略 beforeSeq", H, "      .filter((m) => m.seq <= link.uptoSeq && (q.beforeSeq === null || m.seq < q.beforeSeq))", "      .filter((m) => m.seq <= link.uptoSeq)"],
  ["FL27 read_linked 不按词过滤", H, "      .filter((r) => matchTerms(r.text, q.query))", "      .filter((r) => matchTerms(r.text, null))"],
  ["FL28 read_linked 忽略条数上限", H, "    const page = rows.slice(-limit);", "    const page = rows;"],
  ["FL29 read_linked 撤回的也给原文", H, "        gone: m.retracted || isRewound(this.db, link.linkedRoomId, m.seq),", "        gone: false,"],
  ["FL30 解除后仍算关联", F, "  unlinkTx(roomId: string, linkedRoomId: string): boolean {", "  unlinkTx(roomId: string, linkedRoomId: string): boolean {\n    return true;"],
  ["FL31 关联不查用户还在不在被关联会话", H, "    const links = this.linksOfUser(q.roomId);", "    const links = this.links.linksOf(q.roomId);"],
  ["FL32 副本正文渲染不带来源标题", F, "  const head = `【转发的聊天记录】来自 ${kindWord(rec.fromKind)}「${rec.fromTitle}」的 ${rec.items.length} 条:`;", "  const head = `【转发的聊天记录】共 ${rec.items.length} 条:`;"],
  ["FL33 副本不标来源已撤回", F, "  const lines = rec.items.map((i) => `> ${i.senderName} ${i.at}: ${i.text}${i.sourceRetracted ? \"(来源已撤回)\" : \"\"}`);", "  const lines = rec.items.map((i) => `> ${i.senderName} ${i.at}: ${i.text}`);"],
  ["FL34 read_linked 参数:linkedRoomId 不登记", T, 'case "read_linked": return { ok: true, value: { kind: "read-linked", query: { roomId: s("roomId"), linkedRoomId: sn("linkedRoomId"), query: sn("query"), beforeSeq: nn("beforeSeq"), limit: nn("limit") } } };', 'case "read_linked": return { ok: true, value: { kind: "read-linked", query: { roomId: s("roomId"), linkedRoomId: null, query: sn("query"), beforeSeq: nn("beforeSeq"), limit: nn("limit") } } };'],
  ["FL35 read_linked 不经宿主的查询口", MI, "          const got = await tools.readLinked(r.value.query);", "          const got = null as string | null;"],
  ["FL37 副本正文不走当前状态(界面看到的正文里没有来源已撤回)", H, '      text: m.retracted ? "" : fwd ? renderForwardText(fwd) : m.text,', '      text: m.retracted ? "" : m.text,'],
  ["FL36 read_linked 读不到时不报错(当成空结果)", MI, '          if (got === null) return { content: [{ type: "text", text: `读不到关联记录(${r.value.query.linkedRoomId ?? r.value.query.roomId} 不在本轮可查的范围里,或没有这个关联)` }], details: null, isError: true };\n', ""],
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fwdlink-mut-"));
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
  if (r.timedOut) { ok = false; timeouts++; console.log(`✗ ${tag} ${name}:超时,不算杀死`); }
  else if (kills.length > 0) { killed++; console.log(`✓ ${tag} ${name}:用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被「${kills[0]}」发现`); }
  else { ok = false; survived++; console.log(`✗ ${tag} ${name}:存活(或只有文件级失败)`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived},超时 ${timeouts}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
