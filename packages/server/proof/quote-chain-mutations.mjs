// 引用链切片(feat/g-quote-chain)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片相关测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死。
// 删掉的等价变异:「越过看不见的往上走」——看不见的节点没有消息,也就没有可走的上一级(parents 为空),改不了行为。
// 用法: node packages/server/proof/quote-chain-mutations.mjs   (低并发:串行一个一个跑)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/kernel/src/quote-chain.test.ts", "packages/server/src/quote-chain.test.ts", "packages/adapter-pi-contact/src/mind.test.ts"];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const K = "packages/kernel/src/quote-chain.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MI = "packages/adapter-pi-contact/src/mind.ts";
const H = "packages/server/src/host.ts";

const M = [
  ["Q01 同一 seq 可出现多次", K, "      if (seen.has(f.seq)) continue;\n", ""],
  ["Q02 越过撤回往上走", K, "const traversable = (n: Node) => n.msg !== undefined && !n.msg.retracted;", "const traversable = (n: Node) => n.msg !== undefined;"],
  ["Q04 撤回仍给原文", K, 'text: status === "inline" ? (m as QuoteMsg).text : null,', 'text: m && status !== "not_visible" ? m.text : null,'],
  ["Q05 不认会话上文(in_context 也贴原文)", K, ': inContext.has(n.seq) ? "in_context" : "inline";', ': "inline";'],
  ["Q06 不标有没有上一级", K, "    hasMoreAbove: open && n.parents.some((p) => !included.has(p)),", "    hasMoreAbove: false,"],
  ["Q07 级数不按 k 截", K, "  const kept = nodes.filter((n) => n.depth <= input.k);", "  const kept = nodes;"],
  ["Q08 深度不扫全链", K, "const nodes = walk(input.fromSeq, input.refs, byseq, Math.max(input.k, input.scanCap) + 1);", "const nodes = walk(input.fromSeq, input.refs, byseq, input.k);"],
  ["Q09 超上限不标记", K, "  const depthCapped = maxDepth > input.scanCap;", "  const depthCapped = false;"],
  ["Q10 不给下一级", K, "  for (const n of nodes) if (n.depth === input.k + 1) next.add(n.seq);\n", ""],
  ["Q11 截断标记只看预算", K, "    truncated: maxDepth > input.k || fitted.dropped.length > 0,", "    truncated: fitted.dropped.length > 0,"],
  ["Q12 预算从最近一级开始降", K, ".sort((a, b) => b.l.depth - a.l.depth || a.l.seq - b.l.seq);", ".sort((a, b) => a.l.depth - b.l.depth || a.l.seq - b.l.seq);"],
  ["Q13 不做预算", K, "    if (used <= budget) break;", "    break;"],
  ["Q14 引用指向更晚的也走", K, ".filter((q) => Number.isSafeInteger(q) && q > 0 && q < m.seq);", ".filter((q) => Number.isSafeInteger(q) && q > 0);"],
  ["Q15 read_quote_parent 走两级", K, "  const kept = nodes.filter((n) => n.depth === 1);", "  const kept = nodes;"],
  ["Q16 呈现不贴原文", K, "    if (l.text !== null) t += `${l.text}\\n`;", ""],
  ["Q17 呈现不写深度上限符号", K, 'depth_total=${c.depthCapped ? "≥" : ""}', "depth_total="],
  ["Q18 宿主不附引用链", H, "      if (chain) pointers.push({ ref: `${f.roomId} #${f.seq} 的引用链`, text: renderQuoteChain(chain) });", ""],
  ["Q19 宿主不认已换入的直接引用", H, "      const inContext = [...qm.filter((m) => paged.has(`${f.roomId}#${m.seq}`)).map((m) => m.seq), ", "      const inContext = [...[] as number[], "],
  ["Q20 读上一级不查会话归属", H, "    if (!this.roomsOfContact(contactId).some((r) => r.id === roomId)) return null;\n", ""],
  ["Q21 宿主不给读上一级的口", H, ", readQuoteParent: async (roomId: string, seq: number) => this.readQuoteParent(contactId, roomId, seq) };", " };"],
  ["Q22 撤下(rewind)的仍当可见", H, "      if (inRanges(rewound, m.seq)) continue;\n", ""],
  ["Q23 pi 工具不经查询口", MI, "const got = tools?.readQuoteParent ? await tools.readQuoteParent(r.value.roomId, r.value.seq) : null;", "const got = null as string | null;"],
  ["Q24 登记时把 seq 记错一位", T, 'case "read_quote_parent": return { ok: true, value: { kind: "read-quote", roomId: s("roomId"), seq: n("seq") } };', 'case "read_quote_parent": return { ok: true, value: { kind: "read-quote", roomId: s("roomId"), seq: n("seq") + 1 } };'],
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
