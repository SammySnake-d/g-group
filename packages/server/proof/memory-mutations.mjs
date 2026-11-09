// 记忆切片(feat/g-memory)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片相关测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死。
// 用法: node packages/server/proof/memory-mutations.mjs   (低并发:串行一个一个跑)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/kernel/src/memory.test.ts", "packages/adapter-pi-contact/src/mind.test.ts", "packages/adapter-pi-contact/src/compact.test.ts", "packages/server/src/memory.test.ts"];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const K = "packages/kernel/src/memory.ts";
const R = "packages/kernel/src/rounds.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MI = "packages/adapter-pi-contact/src/mind.ts";
const P = "packages/adapter-pi-contact/src/compact.ts";
const H = "packages/server/src/host.ts";
const S = "packages/server/src/memory-store.ts";

const M = [
  // —— 内核:md 真源
  ["M01 序列化丢正文", K, "return `---\\n${JSON.stringify(front, null, 2)}\\n---\\n${body}\\n`;", "return `---\\n${JSON.stringify(front, null, 2)}\\n---\\n\\n`;"],
  ["M02 不查 frontmatter 开头", K, 'if (!text.startsWith("---\\n")) return { ok: false, why: "缺少 frontmatter(文件应以 --- 开头)" };', ""],
  ["M03 不校验 status", K, 'if (!STATUSES.includes(f.status as MemoryStatus)) return bad("status");', ""],
  // —— 内核:写
  ["M04 复述不比内容(总新建)", K, "  if (same) {", "  if (false && same) {"],
  ["M05 复述不看锚点邻域", K, "live(e) && meets(e.anchors, w.anchors) && squash(e.body) === key", "live(e) && squash(e.body) === key"],
  ["M06 复述不加佐证", K, "evidence: [...same.evidence, ev]", "evidence: same.evidence"],
  ["M07 改变不把旧条目标已替代", K, 'const old: MemoryEntry = { ...target, status: "superseded",', 'const old: MemoryEntry = { ...target, status: target.status,'],
  ["M08 改变不写 supersedes", K, "const e = { ...fresh, supersedes: [target.id] };", "const e = { ...fresh };"],
  ["M09 冲突不问用户直接替代", K, 'if (w.relation.kind === "conflict" && bothQuotes) {', "if (false) {"],
  ["M10 只要一边是原话就问用户", K, "const bothQuotes = w.source?.userQuote === true && target.source?.userQuote === true;", "const bothQuotes = w.source?.userQuote === true || target.source?.userQuote === true;"],
  ["M11 可对已替代条目判关系", K, "if (!live(target)) return", "if (false) return"],
  ["M12 新条目不是生效", K, 'id, version: 1, status: "active",', 'id, version: 1, status: "degraded",'],
  // —— 内核:读
  ["M13 不排除全局(全局重复进读取)", K, "!e.anchors.includes(GLOBAL_ANCHOR) && meets(e.anchors, ctx.anchors)", "meets(e.anchors, ctx.anchors)"],
  ["M14 不查有效期", K, "live(e) && inWindow(e, ctx.now) && !e.anchors", "live(e) && !e.anchors"],
  ["M15 已替代也读", K, "const cand = entries.filter((e) => live(e) &&", "const cand = entries.filter((e) => e.status !== \"revoked\" &&"],
  ["M16 不在断崖截断", K, "    if (d > maxDrop) { maxDrop = d; cut = i + 1; }", ""],
  ["M17 重复内容都展开", K, "if (i < cut && !seen.has(k)) {", "if (i < cut) {"],
  ["M18 降级不扣分", K, ' - (e.status === "degraded" ? 5 : 0)', ""],
  ["M19 不看本轮文字", K, "return hits * 10 + overlap(text, e) + good - badN", "return hits * 10 + good - badN"],
  ["M20 降级条目进前缀", K, '.filter((e) => e.status === "active" && inWindow(e, now) && e.anchors.includes(GLOBAL_ANCHOR))', '.filter((e) => e.status !== "superseded" && e.status !== "revoked" && inWindow(e, now) && e.anchors.includes(GLOBAL_ANCHOR))'],
  ["M21 不降级", K, 'uses.slice(-DEGRADE_AFTER).every((u) => !u.good)) status = "degraded";', 'uses.slice(-DEGRADE_AFTER).every((u) => !u.good)) status = "active";'],
  ["M22 降级后不恢复", K, '  else if (status === "degraded" && use.good) status = "active";', ""],
  // —— 前缀槽
  ["M23 前缀不放全局记忆", R, "    for (const m of mems) t += `〔记忆 ${m.id} · ${m.title}〕\\n${m.text}\\n`;", ""],
  // —— pi 工具
  ["M24 锚点可为空", T, "if (!Array.isArray(x) || x.length === 0 ||", "if (!Array.isArray(x) ||"],
  ["M25 关系不查枚举", T, "if (!(RELATIONS as readonly unknown[]).includes(x)) problems.push", "if (false) problems.push"],
  ["M26 good 不查布尔", T, 'if (typeof x !== "boolean") problems.push(`${k} 必须是布尔值`);', ""],
  ["M27 read_memory 不经查询口", MI, "const got = tools ? await tools.readMemory(r.value.id) : null;", "const got = null as string | null;"],
  // —— pi reflect
  ["M28 模型已写笔记仍覆盖", P, "note: noteWritten ? null : ((o.note as string | null) ?? null)", "note: (o.note as string | null) ?? null"],
  ["M29 reflect 不带人设", P, "[联系人人设与职责]\\n${req.contact.persona || \"(未设置)\"}", "[联系人人设与职责]\\n(未设置)"],
  ["M30 reflect 不带邻域记忆", P, 'const neighbors = req.neighbors.length === 0 ? "(无)" : req.neighbors.map((n) => `${n.id} · ${n.title}:${n.body}`).join("\\n");', 'const neighbors = "(无)";'],
  ["M31 reflect 不查说话模型", P, "if (speaking !== cfg.model) throw new PiContactMindError(\"model-mismatch\", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};检查只用说话模型", "if (false) throw new PiContactMindError(\"model-mismatch\", `联系人的说话模型是 ${speaking},这个压缩器绑定的是 ${cfg.model};检查只用说话模型"],
  ["M32 记忆点 relation 不查", P, "if (relation !== null && !RELS.has(relation as string)) return bad", "if (false) return bad"],
  // —— 宿主
  ["M33 quote 不核对原话", H, 'if (src.sender.kind !== "user" || !src.text.includes(a.quote)) return "quote 必须是来源用户消息里的原话";', ""],
  ["M34 全局不收窄", H, 'if (anchors.includes(GLOBAL_ANCHOR) && !(userQuote && GLOBAL_WORDS.test(a.quote ?? ""))) {', "if (false) {"],
  ["M35 冲突不 @ 用户", H, '        mentions: [{ id: this.userId, source: "auto" }],\n', ""],
  ["M36 中途全局变化不进第 5 块", H, '      pointers.push({ ref: "记忆变化(全局,尚未并入前缀,以这里为准)", text: lines.join("\\n") });', ""],
  ["M37 全局变化立即改前缀", H, "    let snap = doc?.value.entries ?? cur;", "    let snap = cur;"],
  ["M38 不按阈值折叠", H, "if (doc && added.length + removed.length >= (this.opts.memoryFoldAfter ?? 20)) {", "if (false) {"],
  ["M39 读取结果不进第 5 块", H, "    for (const e of sel.expanded) pointers.push(", "    for (const e of [] as typeof sel.expanded) pointers.push("],
  ["M40 不给查询口", H, "      const tools: RoundTools = { readMemory: async (id: string) => this.renderMemory(contactId, id) };", "      const tools: RoundTools = { readMemory: async () => null };"],
  ["M41 不固定发起检查", H, "    if (compactor?.reflect && fresh.length > 0) {", "    if (false) {"],
  ["M42 检查的记忆点不写入", H, "        for (const m of r.memories) remember.push(", "        for (const m of [] as typeof r.memories) remember.push("],
  ["M43 检查不带邻域", H, "noteWritten: out.stateNote }, signal);", "noteWritten: out.stateNote, neighbors: [] }, signal);"],
  ["M44 人格建议改了人格以外也写进提示", H, '        const plan = planMemoryWrite(this.memory.list(contactId), { title: "建议改人格", body: out.personaSuggestion, anchors: [PERSONA_ANCHOR],', '        const plan = planMemoryWrite(this.memory.list(contactId), { title: "建议改人格", body: out.personaSuggestion, anchors: [`room:${[...roomIds][0]}`],'],
  ["M45 memory-use 不记", H, "            this.memory.put(contactId, recordMemoryUse(e, { at: this.now(), good: a.good,", "            void ((_c: string, x: unknown) => x)(contactId, recordMemoryUse(e, { at: this.now(), good: a.good,"],
  ["M46 索引不能重建(不读 md)", S, "      files = readdirSync(this.dir(contactId)).filter((f) => f.endsWith(\".md\"));", "      files = [];"],
  ["M47 不写 md 真源", S, "    renameSync(`${file}.tmp`, file);", "    void renameSync;"],
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-note-mut-"));
function copy(name) {
  const d = path.join(tmp, name);
  fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/(^|[/\\])(node_modules|\.git|proof)([/\\]|$)/.test(path.relative(ROOT, s)) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
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
for (const [i, [name, file, from, to]] of M.entries()) {
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
