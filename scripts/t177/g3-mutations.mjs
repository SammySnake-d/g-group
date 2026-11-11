// T-177 G3 逐项定点变异(pstack 第 3 步):每个具名判据一处单点故障,串行、一次一处,只认指定测试按名失败。
// 编译/导入失败(SyntaxError、找不到模块)不算杀死;原样对照前后各跑一次,必须全绿;注入点必须在源码里恰好出现 1 次;跑完源码还原。
// 用法(仓库根目录,依赖已装):node scripts/t177/g3-mutations.mjs [输出目录]   默认 receipts/evidence/t177-g3/mutations
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const H = "packages/kernel/src/history-search.ts";
const K = "packages/kernel/src/memory.ts";
const HT = "packages/kernel/src/history-search.test.ts";
const KT = "packages/kernel/src/memory-rank.test.ts";
// [编号, 文件, 原文, 改成, 指定测试文件, 指定测试名前缀, 故障说明]
const cases = [
  ["G3-01a", H, "{ limit: docs.length });", '{ limit: docs.length, algorithm: "substring" });', HT, "G3-01a ", "改回字面子串检索"],
  ["G3-01b", H, "const hits = searchBlocks(messageDocs(docs.map((d) => ({ ref: d.ref, role: d.role, text: d.text }))), query, { limit: docs.length });", "const hits = docs.map((d) => ({ ref: d.ref, score: 0, preview: d.text }));", HT, "G3-01b ", "不检索,整个集合当结果(返回全库)"],
  ["G3-01c", H, "b.score - a.score || order.get(a.ref)! - order.get(b.ref)!", "b.score - a.score || order.get(b.ref)! - order.get(a.ref)!", HT, "G3-01c ", "同分倒着排"],
  ["G3-01d", H, "if (order.has(d.ref)) throw new Error(", "if (false) throw new Error(", HT, "G3-01d ", "ref 重复不报错"],
  ["G3-a1", K, "out.set(h.ref, Math.max(1, top - levels.indexOf(h.score)));", "out.set(h.ref, h.score);", KT, "G3-a1 ", "全文分量直接用检索的小数分"],
  ["G3-a1b", K, "out.set(h.ref, Math.max(1, top - levels.indexOf(h.score)));", "out.set(h.ref, Math.max(1, top - hits.indexOf(h)));", KT, "G3-a1 ", "按序号不按分档,同分不同值"],
  ["G3-a2", K, "const top = Math.min(cap, levels.length);", "const top = levels.length;", KT, "G3-a2 ", "名次不封顶,超出旧整数区间"],
  ["G3-a3", K, "hits * 10 + (ranks.get(e.id) ?? 0) + good", "hits * 10 + good", KT, "G3-a3 ", "排序不看全文分量"],
  ["G3-a4", K, "b.s - a.s || byId(a.e, b.e)", "b.s - a.s", KT, "G3-a4 ", "同分按传入顺序,不按 id"],
  ["G3-a5", K, "out.set(h.ref, Math.max(1, top - levels.indexOf(h.score)));", "out.set(h.ref, Math.max(1, 1 + levels.indexOf(h.score)));", KT, "G3-a5 ", "名次倒置(分数低的分量高)"],
  ["G3-01e", K, "const ranked = cand.map((e) => ({ e, s: score(e, ctx.anchors, ranks) }))", "const ranked = entries.map((e) => ({ e, s: score(e, ctx.anchors, ranks) }))", KT, "G3-01e ", "排序用全部条目,越过硬筛"],
];

const out = process.argv[2] ?? "receipts/evidence/t177-g3/mutations";
mkdirSync(out, { recursive: true });
const LOAD_FAIL = /SyntaxError:|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module|does not provide an export/;
function run(files, name, pattern) {
  const args = ["--test", "--test-concurrency=1", "--test-timeout=60000", "--test-force-exit", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern}`] : []), ...files];
  const r = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const log = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(path.join(out, `${name}.tap`), log);
  const failed = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { status: r.status, signal: r.signal, log, failed, passed };
}
const control = run([HT, KT], "control");
console.log(`原样对照:通过 ${control.passed.length},失败 ${control.failed.length},退出 ${control.status}`);
if (control.status !== 0 || control.failed.length || control.passed.length !== 10) { console.log("原样对照不全绿,不判变异"); process.exit(1); }
const results = [];
for (const [id, file, before, after, testFile, prefix, why] of cases) {
  const source = readFileSync(file, "utf8");
  const n = source.split(before).length - 1;
  if (n !== 1) { results.push({ id, file, why, status: "invalid", reason: `注入点出现 ${n} 次` }); console.log(`${id} 注入点出现 ${n} 次,作废`); continue; }
  try {
    writeFileSync(file, source.replace(before, after));
    const r = run([testFile], id, prefix);
    const named = r.failed.filter((t) => t.startsWith(prefix));
    const loadFail = LOAD_FAIL.test(r.log);
    const killed = r.status !== 0 && named.length > 0 && !loadFail && r.signal === null;
    results.push({ id, file, why, designated: `${testFile} › ${prefix.trim()}…`, status: killed ? "killed" : "survived", exit: r.status, signal: r.signal, loadFail, failed: r.failed });
    console.log(`${id} ${killed ? "杀死" : "存活"}:${why}${killed ? `(被「${named[0]}」发现)` : ""}`);
  } finally { writeFileSync(file, source); }
}
const after = run([HT, KT], "after-control");
const summary = { node: process.version, mutations: results.length, killed: results.filter((r) => r.status === "killed").length, survived: results.filter((r) => r.status !== "killed").length, control: { passed: control.passed.length, failed: control.failed.length }, afterControl: { passed: after.passed.length, failed: after.failed.length, exit: after.status } };
writeFileSync(path.join(out, "results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary));
process.exit(summary.survived === 0 && after.status === 0 && after.passed.length === 10 ? 0 : 1);
