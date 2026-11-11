// AC-39 缓存命中可观测(切片 cache-observability)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑本片两份测试;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算杀死),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(适配器、内核)测的才是注入后的代码。
// 用法: node packages/server/proof/cache-observability-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/adapter-pi-contact/src/usage.test.ts", "packages/server/src/usage.test.ts"];
const AU = "packages/adapter-pi-contact/src/usage.ts";
const AM = "packages/adapter-pi-contact/src/mind.ts";
const AC = "packages/adapter-pi-contact/src/compact.ts";
const CS = "packages/server/src/cache-stats.ts";
const SU = "packages/server/src/usage.ts";
const H = "packages/server/src/host.ts";
const ST = "packages/server/src/start.ts";
const SINK_COMPACT = 'signal, this.usage.sink({ kind: "compact", contactId, roomIds: usageRooms, roundId }));';
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  ["C01 线路里留令牌段(取 host + 路径)", [[AU, "    host = new URL(baseUrl).hostname;", "    host = new URL(baseUrl).host + new URL(baseUrl).pathname;"]]],
  ["C02 断点超 4 个(最后一条消息的每个内容块都标断点)", [[AU, "  if (inMessages && tail) at.push(tail);", "  if (inMessages && lastMessage) at.push(...blocksOf(lastMessage));"]]],
  ["C03 断点位置错(工具断点标在第一个工具上)", [[AU, "  const lastTool = tools.at(-1);", "  const lastTool = tools[0];"]]],
  ["C04 回报的断点数漏数消息里的断点", [[AU, "  return marked(list(payload.tools)) + marked(list(payload.system)) + list(payload.messages).reduce((n, m) => n + marked(blocksOf(m)), 0);", "  return marked(list(payload.tools)) + marked(list(payload.system));"]]],
  ["C05 固定前缀哈希不含工具声明", [[AU, "prefixHash: sha256({ tools, system: p.system ?? null })", "prefixHash: sha256({ system: p.system ?? null })"]]],
  ["C06 联系人一轮不回报用量", [[AM, "        report(usage, usageOf(line, requests, probe, m.usage));\n", ""]]],
  ["C07 请求序号恒为 1", [[AM, "usageOf(line, requests, probe, m.usage)", "usageOf(line, 1, probe, m.usage)"]]],
  ["C08 压缩与检查不回报用量", [[AC, "    report(usage, usageOf(line, 1, probe, msg.usage));\n", ""]]],
  ["C09 拆账不判(恒定比例判据失效)", [[CS, 'const split: SplitReason | null = constantRatio(win) ? "constant-ratio"', 'const split: SplitReason | null = false ? "constant-ratio"']]],
  ["C10 不声明缓存却报命中不判", [[CS, ': hitWithoutBreakpoint(win) ? "hit-without-breakpoint" : null;', ': false ? "hit-without-breakpoint" : null;']]],
  ["C11 拆账线路仍计入命中率", [[CS, "    const counted = gr.filter((r) => !verdict.get(r.line)?.splitAccounting);", "    const counted = gr;"]]],
  ["C12 过期未命中算成前缀错误", [[CS, 'ms(r.at) - ms(prev.at) > ttlMs ? "expired" : "uncached"', 'ms(r.at) - ms(prev.at) > ttlMs ? "prefix-changed" : "uncached"']]],
  ["C13 TTL 不按参数", [[CS, "  const ttlMs = q.ttlMs ?? DEFAULT_CACHE_TTL_MS;", "  const ttlMs = DEFAULT_CACHE_TTL_MS;"]]],
  ["C14 只缓存首段不判(轮内命中持平不算)", [[CS, "    if (r.cacheRead <= prev.cacheRead) flat++;", "    if (r.cacheRead < prev.cacheRead) flat++;"]]],
  ["C15 命中率低于阈值不标", [[CS, "counted.length >= minCalls && hitRate < alertBelow) flags.push", "counted.length >= minCalls && hitRate < 0) flags.push"]]],
  ["C16 按线路的阈值不生效", [[CS, "    const alertBelow = (only !== null ? byLine.get(only) : undefined) ?? q.alertBelow ?? null;", "    const alertBelow = q.alertBelow ?? null;"]]],
  ["C17 阈值没给也按硬填的 0.5 标", [[CS, "?? q.alertBelow ?? null;", "?? q.alertBelow ?? 0.5;"]]],
  ["C18 命中率分母漏掉 cache_write", [[CS, "const prompt = (r: UsageRow): number => r.input + r.cacheRead + r.cacheWrite;", "const prompt = (r: UsageRow): number => r.input + r.cacheRead;"]]],
  ["C19 分组丢掉群维度", [[CS, "    room: dims.has(\"room\") ? roomKey(r) : null,", "    room: null,"]]],
  ["C20 minCalls 不按参数", [[CS, "  const minCalls = q.minCalls ?? DEFAULT_CACHE_MIN_CALLS;", "  const minCalls = DEFAULT_CACHE_MIN_CALLS;"]]],
  ["C21 宿主不校验回执形状", [[SU, "    if (why !== null) {", "    if (false) {"]]],
  ["C22 宿主不把回执口交给联系人一轮", [[H, "ac.signal, tools, usage), stalled, closing]);", "ac.signal, tools), stalled, closing]);"]]],
  ["C23 宿主不记检查(reflect)用量", [[H, 'noteWritten: out.stateNote }, signal, this.usage.sink({ kind: "reflect", contactId, roomIds: usageRooms, roundId }));', "noteWritten: out.stateNote }, signal);"]]],
  ["C24 宿主不记缩写用量", [[H, `material: "", maxBytes: max }, ${SINK_COMPACT}`, 'material: "", maxBytes: max }, signal);']]],
  ["C25 宿主不记补写用量", [[H, `material: compactMaterial(fresh, out.actions), maxBytes: max }, ${SINK_COMPACT}`, "material: compactMaterial(fresh, out.actions), maxBytes: max }, signal);"]]],
  ["C26 startServer 不把 stateNoteMaxBytes 传给宿主", [[ST, "    stateNoteMaxBytes: o.stateNoteMaxBytes === undefined ? DEFAULT_STATE_NOTE_MAX_BYTES : o.stateNoteMaxBytes,", "    stateNoteMaxBytes: DEFAULT_STATE_NOTE_MAX_BYTES,"]]],
  ["C27 startServer 不给默认上限", [[ST, "    stateNoteMaxBytes: o.stateNoteMaxBytes === undefined ? DEFAULT_STATE_NOTE_MAX_BYTES : o.stateNoteMaxBytes,", "    stateNoteMaxBytes: o.stateNoteMaxBytes ?? null,"]]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cache-obs-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const cleanDir = copy("clean");
const clean = await run(cleanDir);
fs.rmSync(cleanDir, { recursive: true, force: true });
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
