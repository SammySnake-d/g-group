// 运行台账纯逻辑的行为变异校准(R-05 阳性埋雷):按验收文档 AC-43「坏实现」列与 D26 第 3–5、8.3–8.6 节逐个注入单一故障,
// 在隔离副本里只跑 run-ledger.test.ts;每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死),注入点必须恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。并发 1。主会话的子代理 α 所写。
// 用法: node packages/kernel/proof/run-ledger-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const FILE = "run-ledger.ts";
const TESTS = ["src/run-ledger.test.ts"];

const M = [
  ["R01 上一次启动留下的 running 不认孤儿(坏实现 ①)", '    if (u.bootId !== probe.bootId) note = "宿主进程退出";\n    else if', "    if"],
  ["R02 执行进程已不在不核对(①)", '    else if (u.pid !== null && !probe.alive(u.pid)) note = "执行进程已不在";\n', ""],
  ["R03 孤儿不级联到子孙(①)", "    for (const d of descendants(units, id)) if (LIVE.has(d.status) && !out.has(d.id))", "    for (const d of descendants(units, id)) if (false)"],
  ["R04 子任务在跑父会话记完成(坏实现 ③)", '    if (live.length) return { ok: false, reason: "children-running" };\n', ""],
  ["R05 父单元结束子单元仍运行中(③)", "  const cascade = live.map(", "  const cascade = [].map("],
  ["R06 私聊里查到另一个群的任务(坏实现 ④)", 'if (viewer.roomKind === "dm") return units.filter((u) => u.roomId === viewer.roomId && u.contactId === viewer.contactId);', 'if (viewer.roomKind === "dm") return units.filter((u) => u.contactId === viewer.contactId);'],
  ["R07 群里只看得到自己(④)", "  return units.filter((u) => u.roomId === viewer.roomId);\n}", "  return units.filter((u) => u.roomId === viewer.roomId && u.contactId === viewer.contactId);\n}"],
  ["R08 平台拒绝在原会话继续(坏实现 ⑤)", 'const mode = f?.autoRerun === "new_session_only" ? "new_session" : "same_session";', 'const mode = "same_session" as "same_session" | "new_session";'],
  ["R09 对 user_stopped 自动重跑(坏实现 ⑥)", '  if (f?.reasonClass === "user_stopped" && !(byUser && req.trigger === "explicit")) return no("user-stopped");\n', ""],
  ["R10 两个联系人同时重跑跑起两份(坏实现 ⑦)", '  if (ctx.lease && ctx.lease.until > req.at) return no("lease-held");\n', ""],
  ["R11 自动重跑别人名下的任务(坏实现 ⑦b)", '    if (!owner) return no("not-owner-auto");\n', ""],
  ["R12 明确发起的重跑不留群里记录(⑦b)", "    announce: !owner,", "    announce: false,"],
  ["R13 自己名下第 3 次自动重跑(坏实现 ⑦c)", "    if (ctx.autoReruns >= limit)", "    if (ctx.autoReruns > limit)"],
  ["R14 上游无响应超过首字节窗口仍不判(坏实现 ⑩)", '    if (waited < th.firstByteMs) return none("first_byte", 0);\n    return verdict("no_response"', '    if (waited >= 0) return none("first_byte", 0);\n    return verdict("no_response"'],
  ["R15 重试公告当成进展(坏实现 ⑪)", 'else if (a.kind === "retry") next = { ...p, toolsRunning: [...p.toolsRunning], retries: p.retries + 1, lastRetry: typeof a.error === "string" ? a.error : null };', 'else if (a.kind === "retry") next = progressed([...p.toolsRunning]);'],
  ["R16 心跳/存活当成进展(⑪)", "  // heartbeat / alive:进程活着、心跳都不代表在进展,不刷新\n", '  else next = progressed([...p.toolsRunning]);\n'],
  ["R17 等用户回答被判卡死(坏实现 ⑫)", '  if (unit.status === "waiting_user") return none("waiting_user");\n  if (unit.status !== "running" ||', "  if (!LIVE.has(unit.status) ||"],
  ["R18 工具子进程在跑被判卡死(⑫)", '  if (p.toolsRunning.length) return none("tool_running");\n', ""],
  ["R19 首字节窗口内就判无响应(⑫)", '    if (waited < th.firstByteMs) return none("first_byte", 0);\n', ""],
  ["R20 休眠唤醒宽限期内误判(⑫)", '  if (awake !== null && now < awake + (sleep.graceMs ?? DEFAULT_SLEEP_GRACE_MS)) return none("sleep_grace");\n', ""],
  ["R21 等人回答结束后把等待时间算进无进展(⑫)", "  const from = Math.max(p.lastProgressAt, p.resumedAt ?? Number.NEGATIVE_INFINITY,", "  const from = Math.max(p.lastProgressAt, Number.NEGATIVE_INFINITY,"],
  ["R22 默认阈值不是 15 分钟(坏实现 ⑯)", "Object.freeze({ stallMs: 15 * 60_000, firstByteMs: 120_000 })", "Object.freeze({ stallMs: 10 * 60_000, firstByteMs: 120_000 })"],
  ["R23 按联系人单独设的阈值不生效(⑯)", "    const cs = positive(c) ? c : null;", "    const cs = null as number | null;"],
  ["R24 按上游单独设的阈值不生效(⑯)", "    const us = positive(up) ? up : null;", "    const us = null as number | null;"],
  ["R25 failed 不带原因类别(坏实现 ⑬)", '  if ((to === "failed" || to === "interrupted") && !extra.failure) return { ok: false, reason: "failure-required" };\n', ""],
  ["R26 卡死不按结构化情形归类(⑦⑧)", "    const failure = runFailure(classifyFailure({ text: raw, stall: kind }));", "    const failure = runFailure(classifyFailure({ text: raw }));"],
  ["R27 判定不带最后进展时间(⑦)", "lastProgressAt: p.lastProgressAt, judgedAt: now,", "lastProgressAt: now, judgedAt: now,"],
  ["R28 同一上游 429 让 N 个单元各刷一条提示(坏实现 ⑮)", "    const key = `${u.roomId}|${u.upstream}|${u.failure.reasonClass}`;", "    const key = `${u.roomId}|${u.upstream}|${u.failure.reasonClass}|${u.id}`;"],
  ["R29 人停的和失败同色同字(⑮)", '      if (unit.failure?.reasonClass === "user_stopped") return { tone: "stopped", text: "已停止" };\n', ""],
  ["R30 终态还能改(状态与真实运行不一致)", '  if (!LIVE.has(u.status)) return { ok: false, reason: "terminal" };\n', ""],
  ["R31 重跑上限不是参数", "Math.min(ctx.limit ?? DEFAULT_RERUN_LIMIT,", "Math.min(DEFAULT_RERUN_LIMIT,"],
  ["R32 鉴权额度自动重跑(⑧)", '    if (f?.autoRerun === "never") return no("never-auto",', '    if (false) return no("never-auto",'],
  ["R33 同一上游连续失败仍自动重跑", '    if (sameStop && !ctx.upstreamChanged) return no("same-upstream",', '    if (false) return no("same-upstream",'],
  ["R34 认不出的失败不按低上限", "f?.autoRerunCap ?? Number.POSITIVE_INFINITY", "Number.POSITIVE_INFINITY"],
  ["R35 不会自愈的错误等阈值", "  return c.failFast ? runFailure(c) : null;", "  return null;"],
  ["R36 工具结束不出清单(长期误当工具在跑)", 'else if (a.kind === "tool_end") next = progressed(p.toolsRunning.filter((t) => t !== a.toolId));', 'else if (a.kind === "tool_end") next = progressed([...p.toolsRunning]);'],
  ["R37 用时写成无进展时长(⑦)", "durationMs: now - unit.startedAt, idleMs", "durationMs: idleMs, idleMs"],
  ["R38 有重试公告也按首字节窗口判无响应(⑪)", "  if (p.awaitingSince !== null && p.retries === 0) {", "  if (p.awaitingSince !== null) {"],
  ["R39 不知道副作用的不先说明", '    explainFirst: f?.retryClass === "UnknownEffect",', "    explainFirst: false,"],
  ["R40 只对联系人轮次计时以外的单元也判卡死", 'const TIMED: ReadonlySet<RunLayer> = new Set<RunLayer>(["contact-round", "compute-turn"]);', "const TIMED: ReadonlySet<RunLayer> = new Set<RunLayer>(RUN_LAYERS);"],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 120_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,只跑 ${TESTS.join(" ")}`);
const clean = await run(copy("clean"));
const named = new Set(clean.passed);
const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (!cleanOk) ok = false;
let killed = 0, survived = 0;
for (const [i, [name, from, to]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  const f = path.join(d, "src", FILE);
  const src = fs.readFileSync(f, "utf8");
  const n = count(src, from);
  if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次`); continue; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${kills[0]}」发现${kills.length > 1 ? `(另 ${kills.length - 1} 条)` : ""}`);
  } else {
    ok = false; survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
