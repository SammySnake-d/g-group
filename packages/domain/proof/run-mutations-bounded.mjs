// R-05: 使用 mutations.mjs 的原始清单,在冻结快照的隔离副本逐项注入并运行全部 domain 测试。
// 用法: node packages/domain/proof/run-mutations-bounded.mjs /tmp/<新目录> [CK183,CK184]
// MUTATION_JOBS=1 或 2;每个 Node 测试进程自身单并发。输出 events.jsonl / report.txt / summary.json。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const pkg = path.resolve(import.meta.dirname, "..");
const root = path.resolve(pkg, "../..");
const outArg = process.argv[2];
if (!outArg || !path.isAbsolute(outArg)) throw new Error("需要绝对的全新输出目录");
const out = path.resolve(outArg);
const width = Number(process.env.MUTATION_JOBS ?? "1");
if (![1, 2].includes(width)) throw new Error("MUTATION_JOBS 只允许 1 或 2");
const filter = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const runnerSource = fs.readFileSync(path.join(pkg, "proof/mutations.mjs"), "utf8");
const start = runnerSource.indexOf("const M = [");
const end = runnerSource.indexOf("\n];\n// 所测功能已按", start) + 3;
if (start < 0 || end < 3) throw new Error("找不到清单边界");
const all = vm.runInNewContext(`${runnerSource.slice(start, end)}; M`);
const selected = all.map((m, i) => ({ m, i })).filter(({ m }) => !filter || filter.has(m[0].split(" ")[0]));
if (filter && selected.length !== filter.size) throw new Error("变异筛选名称未全部匹配");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const unique = new Set(all.map(([, f, from, to]) => JSON.stringify([f, from, to])));
if (unique.size !== all.length) throw new Error("存在重复注入");
for (const [name, file, from] of all) {
  const text = fs.readFileSync(path.join(pkg, "src", file), "utf8");
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`${name}:注入点 ${hits} 次`);
}
fs.mkdirSync(out); // 禁止重用或覆盖旧输出。
const snapshot = path.join(out, "snapshot");
fs.cpSync(pkg, snapshot, { recursive: true, filter: (p) => !p.includes(`${path.sep}proof`) });
fs.symlinkSync(path.join(root, "node_modules"), path.join(snapshot, "node_modules"));
const sourceHashes = {};
for (const name of fs.readdirSync(path.join(snapshot, "src")).sort()) {
  const p = path.join(snapshot, "src", name);
  if (fs.statSync(p).isFile()) sourceHashes[name] = sha(fs.readFileSync(p));
}
const files = fs.readdirSync(path.join(snapshot, "src")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join("src", f));
fs.writeFileSync(path.join(out, "metadata.json"), `${JSON.stringify({ node: process.version, width, testConcurrency: 1, listSha256: sha(runnerSource), listCount: all.length, uniqueCount: unique.size, selected: selected.length, sourceHashes, files }, null, 2)}\n`);
const parse = (stdout) => {
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
    summary[key] = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  const failures = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { summary, failures };
};
const run = (dir) => new Promise((resolve) => {
  const t = Date.now();
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout.on("data", (d) => stdout.push(d));
  child.stderr.on("data", (d) => stderr.push(d));
  child.on("error", (error) => resolve({ code: null, signal: null, error: String(error), stdout: "", stderr: "", elapsedMs: Date.now() - t }));
  child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), elapsedMs: Date.now() - t }));
});
const clean = await run(snapshot);
const cleanParsed = parse(clean.stdout);
fs.writeFileSync(path.join(out, "clean.tap"), clean.stdout + clean.stderr);
const n = cleanParsed.summary.tests;
if (clean.code !== 0 || !n || cleanParsed.summary.pass !== n || cleanParsed.summary.fail !== 0 || cleanParsed.summary.cancelled !== 0 || cleanParsed.summary.skipped !== 0 || cleanParsed.summary.todo !== 0) throw new Error(`原样对照异常:${JSON.stringify(cleanParsed.summary)} 退出码=${clean.code}`);
console.error(`原样副本 ${n}/${n} 通过;开始 ${selected.length} 个变异,并发 ${width}`);
const events = [];
let next = 0;
const eventFile = path.join(out, "events.jsonl");
fs.writeFileSync(eventFile, "");
async function worker(slot) {
  while (true) {
    const item = selected[next++];
    if (!item) return;
    const [name, file, from, to] = item.m;
    const dir = path.join(out, `case-${slot}`);
    fs.cpSync(snapshot, dir, { recursive: true, dereference: false });
    const target = path.join(dir, "src", file);
    const original = fs.readFileSync(target, "utf8");
    const hits = original.split(from).length - 1;
    if (hits !== 1) throw new Error(`${name}:快照注入点 ${hits} 次`);
    fs.writeFileSync(target, original.replace(from, to));
    const r = await run(dir);
    const p = parse(r.stdout);
    const s = p.summary;
    const named = p.failures.filter((x) => !/\.test\.ts$/.test(x));
    const valid = r.code === 1 && r.signal === null && s.tests === n && s.pass + s.fail === n && s.fail > 0 && s.cancelled === 0 && s.skipped === 0 && s.todo === 0 && named.length === s.fail && named.length === p.failures.length;
    const event = { index: item.i, name, file, hits, code: r.code, signal: r.signal, summary: s, failed: named, valid, elapsedMs: r.elapsedMs, stdoutSha256: sha(r.stdout), ...(r.stderr ? { stderr: r.stderr.slice(0, 2000) } : {}), ...(r.error ? { error: r.error } : {}) };
    events.push(event);
    fs.appendFileSync(eventFile, `${JSON.stringify(event)}\n`);
    if (!valid) fs.writeFileSync(path.join(out, `invalid-${item.i}.tap`), r.stdout + r.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
    if (events.length % 25 === 0 || !valid || events.length === selected.length) console.error(`变异 ${events.length}/${selected.length},异常 ${events.filter((e) => !e.valid).length}${valid ? "" : `: ${name}`}`);
  }
}
await Promise.all(Array.from({ length: width }, (_, i) => worker(i)));
events.sort((a, b) => a.index - b.index);
const failed = events.filter((e) => !e.valid);
const targeted = { CK183: events.find((e) => e.name.startsWith("CK183 ")), CK184: events.find((e) => e.name.startsWith("CK184 ")), CK185: events.find((e) => e.name.startsWith("CK185 ")) };
const targetOk = (!targeted.CK183 || targeted.CK183.failed.filter((x) => x.startsWith("R20-01 ") && x.includes("带")).length === 4)
  && (!targeted.CK184 || targeted.CK184.failed.some((x) => x.startsWith("R20-02 ")))
  && (!targeted.CK185 || targeted.CK185.failed.filter((x) => x.startsWith("R20-03 ")).length === 2);
const report = [`共 ${all.length} 个变异,${unique.size} 种不同注入;本次运行 ${events.length} 个;测试进程并发 ${width},每进程测试并发 1`, `✓ 原样副本:${n} 绿 / 0 红`, ...events.map((e) => `${e.valid ? "✓" : "✗"} ${e.name}:${e.summary.pass} 绿 / ${e.summary.fail} 红${e.valid ? `,被「${e.failed.join("」「")}」发现` : ",结果异常或存活"}`), failed.length === 0 && targetOk ? "变异校准通过" : "变异校准失败"];
fs.writeFileSync(path.join(out, "report.txt"), `${report.join("\n")}\n`);
fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify({ total: all.length, selected: events.length, killed: events.filter((e) => e.valid).length, invalidOrSurvived: failed.length, targetOk, clean: cleanParsed.summary, listSha256: sha(runnerSource), sourceHashes, width }, null, 2)}\n`);
fs.rmSync(snapshot, { recursive: true, force: true });
console.error(report.at(-1));
process.exit(failed.length === 0 && targetOk ? 0 : 1);
