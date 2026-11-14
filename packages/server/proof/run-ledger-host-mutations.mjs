// 运行台账接宿主的行为变异校准(R-05 阳性埋雷):按验收文档 AC-43「坏实现」列与 AC-14 逐个注入单一故障(一个故障可以改几处,
// 比如「没有租约」要同时去掉预判和 CAS),在隔离副本里只跑相关测试文件;每个变异都必须让至少一条具名测试失败(文件级加载失败不算),
// 每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。主会话的子代理 α 所写。
// 用法: node packages/server/proof/run-ledger-host-mutations.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SERVER = ["src/runs.test.ts"];
const ADAPTER = ["src/activity.test.ts"];
const H = "src/host.ts";
const S = "src/runs.ts";
/** [名字, 包目录, [[文件, 原文, 改成]...], 跑哪些测试] */
const M = [
  ["H01 启动不核对上次留下的 running(坏实现 ①)", "server", [[H, "    this.recoverRuns();\n", ""]], SERVER],
  ["H02 孤儿化的任务不发停滞事件,要用户手发「继续」(AC-14)", "server", [[H, "        this.inboxTx(u.contactId, u.roomId, {", "        if (false) this.inboxTx(u.contactId, u.roomId, {"]], SERVER],
  // 人停有两条收口路:实例回报 stopped,和任务落 T10 时 syncTaskRuns 收口;分类器也按原文认「用户停止」,所以坏实现是两处都不说是人停的
  ["H03 人停的记成别的原因(坏实现 ②⑥)", "server", [
    [H, 'classifyFailure({ text: by && by !== this.userId ? `联系人 ${by} 停止了任务` : "用户停止了任务", userStopped: true })', 'classifyFailure({ text: "进程已退出" })'],
    [H, 'classifyFailure({ text: "任务已取消", userStopped: true })', 'classifyFailure({ text: "进程已退出" })'],
  ], SERVER],
  ["H04 子任务在跑父会话记完成(坏实现 ③)", "server", [[S, "    if (this.liveDescendants(id).length === 0) {\n      this.setStatus(id, \"done\", {}, detail);\n      return;\n    }\n    this.settled.add(id);", "    this.setStatus(id, \"done\", {}, detail);\n    if (this.live.has(id)) return;\n    this.settled.add(id);"]], SERVER],
  ["H05 私聊里查到别的群的单元(坏实现 ④)", "server", [[H, '      const units = this.runs.visible({ kind: "contact", contactId, roomId: r.id, roomKind: r.kind });', '      const units = this.runs.visible({ kind: "user" });']], SERVER],
  ["H06 平台拒绝的在原会话继续(坏实现 ⑤)", "server", [[H, '${plan.mode === "new_session" ? "(开新会话,不接着原会话)" : ""}', ""]], SERVER],
  ["H07 没有重跑租约,同一单元跑起两份(坏实现 ⑦)", "server", [
    [H, "lease: this.runs.lease(unit.id), sameUpstreamFailures }", "lease: null, sameUpstreamFailures }"],
    [H, '    if (!this.runs.claimLeaseTx(unit.id, plan.lease.holder, plan.lease.until)) return refuse("lease-held", null);\n', ""],
  ], SERVER],
  ["H08 联系人自动重跑别人名下的任务(坏实现 ⑦b)", "server", [[H, "const r = this.rerunTx(unit, { initiator, trigger,", 'const r = this.rerunTx(unit, { initiator: trigger === "auto" ? { kind: "contact", id: unit.contactId } : initiator, trigger,']], SERVER],
  ["H09 明确发起的重跑在群里不留记录(坏实现 ⑦b)", "server", [[H, "    if (plan.announce) {", "    if (false) {"]], SERVER],
  ["H10 自己名下第 3 次自动重跑(坏实现 ⑦c)", "server", [[H, "(d) => d.countsTowardLimit === true", "() => false"]], SERVER],
  ["H11 上游无响应:调用发出不记,永远不判 no_response(坏实现 ⑩)", "server", [[H, '      this.runs.activity(m.turnId, { kind: "model_call" });\n', ""]], SERVER],
  ["H12 重试公告当成进展(坏实现 ⑪)", "server", [[H, '      this.runs.activity(m.turnId, { kind: "retry", error: x.error, httpStatus: x.httpStatus });', '      this.runs.activity(m.turnId, { kind: "progress", what: "output" });']], SERVER],
  ["H13 等用户回答被判卡死(坏实现 ⑫)", "server", [[H, '        this.runs.setStatus(m.turnId, "waiting_user", {}, { needs: ev.needs });\n', ""]], SERVER],
  ["H14 工具子进程在跑被判卡死(坏实现 ⑫)", "server", [[H, '      this.runs.activity(m.turnId, { kind: "tool_start", toolId: x.toolId });', '      this.runs.activity(m.turnId, { kind: "progress", what: "output" });']], SERVER],
  ["H15 先写失败再停这一轮(D26 第 8.3 节顺序)", "server", [[H, "    await this.runEffects(effects);\n    // 适配器没报 stopped(拒绝停、或这一轮已经结束)也要写失败\n    this.finishStall(computeId, s);", "    this.finishStall(computeId, s);\n    await this.runEffects(effects);"]], SERVER],
  ["H16 判卡死后不停这一轮(坏实现 ⑩ 仍在跑)", "server", [[H, "    await this.runEffects(effects);\n    // 适配器没报 stopped", "    // 适配器没报 stopped"]], SERVER],
  ["H17 判卡死后不给负责联系人发停滞事件(AC-14)", "server", [[H, "    tx(this.db, () => this.inboxTx(row.contact_id, row.room_id, {", "    if (false) tx(this.db, () => this.inboxTx(row.contact_id, row.room_id, {"]], SERVER],
  ["H18 按联系人 / 上游单独设的阈值不生效(坏实现 ⑯)", "server", [[H, '      thresholds: typeof th === "function" ? th : () => th ?? {},', "      thresholds: () => ({}),"]], SERVER],
  ["H19 不跑周期核对,卡住的一直显示运行中(坏实现 ⑩)", "server", [[H, "    this.runs.startTicker();\n", ""]], SERVER],
  ["H20 同一上游同一原因让 N 个单元各刷一条提示(坏实现 ⑮)", "server", [[H, 'hints: this.runs.hints(units.filter((u) => u.layer === "compute-session" || u.layer === "contact-round"))', "hints: this.runs.hints(units)"]], SERVER],
  ["H21 联系人看不到台账(第 5 块没有运行台账)", "server", [[H, "      runs: this.runLinesFor(contactId, rooms),\n", ""]], SERVER],
  ["H22 不接 harness 活动流(子代理 / 后台任务不进台账)", "server", [[H, '      if (typeof a.activity === "function") this.pumps.push(this.pumpActivity(a));\n', ""]], SERVER],
  ["H23 确定不会自愈的错误也等阈值", "server", [[H, "      if (ff) void this.stopComputeFor(x.computeId, { failure: ff, verdict: null });", "      void ff;"]], SERVER],
  ["H24 台账查询读旧的落盘行,不读在跑单元的最新进展(⑥⑧ 同一份数据)", "server", [[S, "    const l = this.live.get(id);\n    if (l) return l;\n", ""]], SERVER],
  ["H25 父单元等的子单元都结束了也不收口(③)", "server", [[S, '    if (this.settled.has(parentId) && this.liveDescendants(parentId).length === 0) this.setStatus(parentId, "done", {}, { note: "子单元都已结束" });', "    void parentId;"]], SERVER],
  ["A01 认不出 CLI 的发请求帧(⑩)", "adapter-cc-compute", [["src/events.ts", '  if (m.type === "system" && m.subtype === "status" && m.status === "requesting") return [{ kind: "model_call" }];\n', ""]], ADAPTER],
  ["A02 重试公告当成进展(⑪)", "adapter-cc-compute", [["src/events.ts", '    return [{ kind: "retry", error:', '    return [{ kind: "progress", what: "output" } as never, { kind: "retry", error:']], ADAPTER],
  ["A03 后台命令、子代理不分(子单元不进台账)", "adapter-cc-compute", [["src/events.ts", 'background: b.name === "Bash" && input?.run_in_background === true, subagent: b.name === "Task" || b.name === "Agent"', "background: false, subagent: false"]], ADAPTER],
  ["A04 CLI 不开流式增量,长生成被误判没回应(⑫)", "adapter-cc-compute", [["src/cli.ts", '    "--include-partial-messages",\n', ""]], ADAPTER],
  ["A05 适配器不发活动", "adapter-cc-compute", [["src/adapter.ts", "        if (round.initOk && !round.halted) {\n          try {\n            for (const a of activityOf(line))", "        if (false) {\n          try {\n            for (const a of activityOf(line))"]], ADAPTER],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir, tests) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-host-mut-"));
const copy = (pkg, name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages", pkg), d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个`);
const named = new Map();
for (const [pkg, tests] of [["server", SERVER], ["adapter-cc-compute", ADAPTER]]) {
  const clean = await run(copy(pkg, `clean-${pkg}`), tests);
  const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
  console.log(`${good ? "✓" : "✗"} 原样副本 ${pkg}:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
  if (!good) ok = false;
  named.set(pkg, new Set(clean.passed));
}
let killed = 0, survived = 0;
for (const [i, [name, pkg, edits, tests]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(pkg, `m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) { bad = `${file} 注入点出现 ${n} 次`; break; }
    fs.writeFileSync(f, src.replace(from, to));
  }
  if (bad) { ok = false; survived++; console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`); fs.rmSync(d, { recursive: true, force: true }); continue; }
  const t0 = Date.now();
  const r = await run(d, tests);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.get(pkg).has(t));
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被「${kills[0]}」发现${kills.length > 1 ? `(另 ${kills.length - 1} 条)` : ""}`);
  } else {
    ok = false; survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
