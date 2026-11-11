// 运行时配置与进度查询补齐(feat/runtime-config)的行为变异校准(R-05 阳性埋雷):brief 点名的四个单点故障
// (工厂不看 harness、阈值缓存旧值、progress_get 不判范围、alive 恒真)加上接线上的其余单点故障,逐个注入单一故障,在隔离副本里跑
// 本片的测试文件;每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算),每处注入点必须恰好出现 1 次;
// 原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(内核、pi 适配器)测的才是注入后的代码。
// 用法: node packages/server/proof/runtime-config-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/runtime-config.test.ts",
  "packages/adapter-pi-contact/src/progress-tool.test.ts",
  "packages/adapter-pi-contact/src/mind.test.ts",
  "packages/kernel/src/orphan-pid.test.ts",
];
const RC = "packages/server/src/runtime-config.ts";
const PG = "packages/server/src/progress-get.ts";
const H = "packages/server/src/host.ts";
const RS = "packages/server/src/runs.ts";
const ST = "packages/server/src/start.ts";
const RL = "packages/kernel/src/run-ledger.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MD = "packages/adapter-pi-contact/src/mind.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  // ---- Harness 路由(AC-51 ⑦ 拦截部分、D07.4 规则 2)----
  ["R01 工厂不看 harness:一律取 Claude Code 的工厂", [[H, "    const make = Object.hasOwn(this.factories, harness) ? this.factories[harness as keyof ComputeFactories] : undefined;", '    const make = this.factories["claude-code"];']]],
  ["R02 启动前不拦没接入的 Harness", [[H, "    if (unconnected) {\n", "    if (false) {\n"]]],
  ["R03 没接入就静默改用 Claude Code 代跑", [[H, "    if (unconnected) {\n", "    if (false) {\n"], [H, "    const adapter = this.adapterFor(harness, model);", '    const adapter = this.adapterFor(harness, model) ?? this.adapterFor("claude-code", model);']]],
  ["R04 选了没接入的 Harness 不返回 warning", [[RC, "  if (connected.length === 0 || connected.includes(harness)) return undefined;", "  return undefined;"]]],
  ["R05 修复路径只给「改用已接入的」,不给「等接入」", [[RC, "    { kind: \"wait-for-harness\", harness, label: `等 ${labelOf(harness)} 接入` },\n", ""]]],
  ["R06 配置问题不归 invalid_request(按原文归类)", [[RC, '  return runFailure(classifyFailure({ text: raw, kind: "invalid_request" }));', "  return runFailure(classifyFailure({ text: raw }));"]]],
  ["R07 settings 视图不带 warning", [[H, "    return { ...rest, runThresholds: runThresholdsView(this.baseThresholds(), stored), ...(warning ? { warning } : {}) };", "    return { ...rest, runThresholds: runThresholdsView(this.baseThresholds(), stored) };"]]],
  // ---- 卡死阈值(AC-43 ⑦⑯、U92)----
  ["R08 阈值缓存旧值:第一次读到的配置一直用下去", [[H, "      thresholds: () => this.thresholdConfig(),\n", "      thresholds: (() => { let c; return () => (c ??= this.thresholdConfig()); })(),\n"]]],
  ["R09 设置里的默认层不进阈值", [[RC, "  return { defaults: { ...(base.defaults ?? {}), ...toKernel(stored?.defaults) }, byUpstream, byContact };", "  return { defaults: { ...(base.defaults ?? {}) }, byUpstream, byContact };"]]],
  ["R10 设置里按上游的不进阈值", [[RC, "  for (const e of stored?.byUpstream ?? []) byUpstream[e.upstream] = { ...(byUpstream[e.upstream] ?? {}), ...toKernel(e) };\n", ""]]],
  ["R11 联系人 stall 覆盖不进阈值", [[RC, "  for (const [id, s] of contacts) if (s) byContact[id] = { ...(byContact[id] ?? {}), ...toKernel(s) };\n", ""]]],
  ["R12 startServer 不透传基础层", [[ST, "    ...(o.runThresholds ? { runThresholds: o.runThresholds } : {}),\n", ""]]],
  ["R13 阈值不校验取值范围", [[RC, "    if (typeof v !== \"number\" || !Number.isSafeInteger(v) || v < STALL_MS_MIN || v > STALL_MS_MAX) return bad(`${where}.${k} 应为 ${STALL_MS_MIN}–${STALL_MS_MAX} 的整数毫秒`);\n", ""]]],
  // ---- progress_get(AC-43 ①④、U91)----
  ["R14 progress_get 不判可见范围", [[PG, "  if (!u || visibleRuns([u], viewer).length !== 1) return null;", "  if (!u) return null;"]]],
  ["R15 progress_get 不核会话是不是联系人的", [[PG, "  if (!room) return null;\n", ""], [PG, 'roomKind: room.kind === "dm" ? "dm" : "group" };', 'roomKind: room?.kind === "dm" ? "dm" : "group" };']]],
  ["R16 progress_get 子单元不设上限", [[PG, "seen.slice(0, PROGRESS_GET_MAX_CHILDREN)", "seen"]]],
  ["R17 progress_get 最近事件不设上限", [[PG, "  const events = runs.events(u.id, PROGRESS_GET_MAX_EVENTS + 1);\n  const recent = events.slice(-PROGRESS_GET_MAX_EVENTS);", "  const events = runs.events(u.id, 10_000);\n  const recent = events;"]]],
  ["R18 宿主不给联系人台账查询口", [[H, "        progressGet: async (id: string, roomId: string) => progressGet(this.runs, contactId, this.roomsOfContact(contactId), roomId, id),\n", ""]]],
  ["R19 pi 联系人不把 progress_get 交给查询口", [[MD, "          const got = tools?.progressGet ? await tools.progressGet(r.value.id, r.value.roomId) : null;", "          const got = null;"]]],
  ["R20 progress_get 的 roomId 不必填", [[T, '      roomId: f("text", true, "在哪个会话里查(决定你能看到哪些单元)"),', '      roomId: f("textOrNull", false, "在哪个会话里查(决定你能看到哪些单元)"),']]],
  // ---- 同一启动的孤儿(AC-43 ②)----
  ["R21 alive 恒真", [[RC, '    return (e as { code?: unknown }).code === "EPERM";', "    return true;"]]],
  ["R22 宿主不把存活核对交给台账", [[H, "      alive: opts.runAlive ?? pidAlive,\n", ""]]],
  ["R23 started 报的 pid 不记在这一轮上", [[H, "          this.runs.setPid(m.turnId, ev.pid);\n", ""]]],
  ["R24 续接的新一轮不沿用 pid", [[H, " upstream: session.upstream, ...(alive ? { pid } : {}) });", " upstream: session.upstream });"]]],
  ["R25 存活核对不限 running(等人回答的也按进程判)", [[RL, 'u.pid !== null && u.status === "running" && !probe.alive(u.pid)', "u.pid !== null && !probe.alive(u.pid)"]]],
  ["R26 台账不把同启动孤儿交给宿主", [[RS, "          this.opts.orphaned?.(gone);", "          void gone;"]]],
  ["R27 进程消失后会话不跟着成孤儿、任务不收口", [[H, '      const r = this.runs.setStatus(session.id, "orphaned", { note: "执行进程已不在" }, { by: "pid" });', "      const r = { ok: false as const };"]]],
  // ---- 换模型被拒(D27 第 4 节第 4 条、AC-43 ⑧)----
  ["R28 换模型被拒不写台账", [[H, "    if (session) {\n      const t = this.runs.start(", "    if (false) {\n      const t = this.runs.start("]]],
  ["R29 换模型被拒把会话也判失败", [[H, '      this.runs.end(t.id, "failed", { failure: configFailure(why) }, { refused: true });', '      this.runs.end(t.id, "failed", { failure: configFailure(why) }, { refused: true });\n      this.runs.end(session.id, "failed", { failure: configFailure(why) });']]],
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-mut-"));
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
const clean = await run(copy("clean"));
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
