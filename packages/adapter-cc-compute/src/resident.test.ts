// 常驻 Compute 适配器与轮边界换模型的行为测试(AC-51、需求文档 D27)。
// 适配器测试起真实子进程:假 CLI(test-support/fake-claude-resident.mjs)按 Claude Code 2.1.319 实测的常驻 stream-json 行为工作,
// 并真的起 report_progress MCP 服务器。不 mock child_process。每条测试只回收自己目录下的进程,结束删目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as entry from "@g-group/adapter-cc-compute/resident";
import { createResidentComputeAdapter, residentArgs, turnModels } from "./resident.ts";
import { checkTurnModel, planTurn, switchRefusalKind } from "./turn-model.ts";
import type { ComputeAdapter, ComputeEvent } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.url));
const brief = (over: Record<string, unknown> = {}) => ({ task: "记住暗号:PLUM-7731", rules: [], tools: ["Read"], credentialRefs: [], placement: "local", ...over });
const CAPS = { inSessionModelSwitch: true, inSessionEffort: true };

const ownDirs = new Set<string>();
const adapters: ComputeAdapter[] = [];
const computes: [ComputeAdapter, string][] = [];
function reapOwn() {
  for (const [a, id] of computes.splice(0)) void a.stop(id).catch(() => {});
  for (let round = 0; round < 3; round++) {
    let out = "";
    try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { break; }
    let found = 0;
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) <= 1 || Number(m[1]) === process.pid) continue;
      if (![...ownDirs].some((d) => m[2]!.includes(d))) continue;
      found++;
      try { process.kill(-Number(m[1]), "SIGKILL"); } catch { /* 不是组长 */ }
      try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* 已退出 */ }
    }
    if (!found) break;
    execFileSync("sleep", ["0.1"]);
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
  adapters.length = 0;
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("resident.test.ts 超过 180 秒,强制结束"); process.exit(1); }, 180_000).unref();

type Rec = { pid: number; kind: string; [k: string]: unknown };
function rig(make: typeof createResidentComputeAdapter, script: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ccr-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const adapter = make({
    runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record },
    reapForceMs: 1000,
    ...extra,
  } as Parameters<typeof createResidentComputeAdapter>[0]);
  adapters.push(adapter);
  const events: ComputeEvent[] = [];
  void (async () => { for await (const e of adapter.events()) events.push(e); })();
  const recs = (): Rec[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const until = async (pred: () => boolean, ms = 8000, what = "条件") => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等待超时:${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const spawn = async (opts: Record<string, unknown> = { model: "model-A" }) => {
    const r = await adapter.spawn(brief(), { cwd: dir, ...opts });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    const id = (r as { computeId: string }).computeId;
    computes.push([adapter, id]);
    return id;
  };
  const turnEnds = () => events.filter((e) => e.kind === "completed" || e.kind === "failed");
  return { dir, adapter, events, recs, until, spawn, turnEnds };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------- 纯函数:轮边界换模型的计划 ----------------
test("planTurn:模型和 effort 都没变时只发送,不发任何切换请求", () => {
  const steps = planTurn({ model: "A", effort: "high" }, { model: "A", effort: "high" }, CAPS);
  assert.deepEqual(steps, [{ kind: "send", model: "A", effort: "high" }]);
  assert.deepEqual(planTurn({ model: "A" }, undefined, CAPS), [{ kind: "send", model: "A" }]);
});

test("planTurn:模型变了且支持会话内换,先 set-model 再发送,不重启", () => {
  assert.deepEqual(planTurn({ model: "A" }, { model: "B" }, CAPS), [{ kind: "set-model", model: "B" }, { kind: "send", model: "B" }]);
});

test("planTurn:能力声明不支持会话内换模型时走 restart(同会话带新模型),不发 set-model", () => {
  const steps = planTurn({ model: "A", effort: "low" }, { model: "B" }, { inSessionModelSwitch: false, inSessionEffort: true });
  assert.deepEqual(steps, [{ kind: "restart", model: "B", effort: "low" }, { kind: "send", model: "B", effort: "low" }]);
});

test("planTurn:只改 effort 时 set-effort、模型不变;不能会话内改 effort 时 restart 带原模型", () => {
  assert.deepEqual(planTurn({ model: "A", effort: "low" }, { model: "A", effort: "high" }, CAPS), [{ kind: "set-effort", effort: "high" }, { kind: "send", model: "A", effort: "high" }]);
  assert.deepEqual(planTurn({ model: "A", effort: "low" }, { model: "A", effort: "high" }, { inSessionModelSwitch: true, inSessionEffort: false }), [{ kind: "restart", model: "A", effort: "high" }, { kind: "send", model: "A", effort: "high" }]);
});

test("planTurn:会话当前模型不明(上次切换超时)时先切再发", () => {
  assert.deepEqual(planTurn({ model: null }, { model: "A" }, CAPS), [{ kind: "set-model", model: "A" }, { kind: "send", model: "A" }]);
  assert.throws(() => planTurn({ model: null }, undefined, CAPS), /不明/);
});

test("switchRefusalKind:check_failed 是模型被拒,unsupported 是切换请求本身不可用", () => {
  assert.equal(switchRefusalKind("check_failed", "Model x is not available"), "model-rejected");
  assert.equal(switchRefusalKind("unsupported", "Unsupported control request subtype: set_model"), "unavailable");
  assert.equal(switchRefusalKind(undefined, "Unknown control request: set_model"), "unavailable");
});

test("生效模型是外部输入:Proxy、getter、多余字段、空模型一律拒收", () => {
  assert.throws(() => checkTurnModel(new Proxy({ model: "A" }, {})), /纯数据/);
  assert.throws(() => checkTurnModel({ get model() { return "A"; } }), /纯数据/);
  assert.throws(() => checkTurnModel({ model: "A", harness: "codex" }), /只收/);
  assert.throws(() => checkTurnModel({ model: "" }), /非空/);
  assert.deepEqual(checkTurnModel({ model: "A", effort: "high" }), { model: "A", effort: "high" });
});

test("result 帧里这一轮实际用过的模型取 model_usage_since_last_result,没有时退回 modelUsage", () => {
  assert.deepEqual(turnModels({ model_usage_since_last_result: { B: {} }, modelUsage: { A: {}, B: {} } }), ["B"]);
  assert.deepEqual(turnModels({ modelUsage: { A: {} } }), ["A"]);
  assert.deepEqual(turnModels({}), []);
});

test("常驻启动参数:stdin 收 stream-json、首次 --session-id、接回用 --resume 同一 id,带模型与 effort,保留隔离参数", () => {
  const first = residentArgs(brief() as never, "/tmp/m.json", { sessionId: "S1", resume: false, model: "A", effort: "high" });
  assert.deepEqual(first.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.equal(first[first.indexOf("--session-id") + 1], "S1");
  assert.equal(first[first.indexOf("--model") + 1], "A");
  assert.equal(first[first.indexOf("--effort") + 1], "high");
  for (const f of ["--bare", "--strict-mcp-config", "--permission-mode"]) assert.ok(first.includes(f), f);
  const again = residentArgs(brief() as never, "/tmp/m.json", { sessionId: "S1", resume: true, model: "B" });
  assert.equal(again[again.indexOf("--resume") + 1], "S1");
  assert.equal(again.includes("--session-id"), false);
});

test("子路径入口 @g-group/adapter-cc-compute/resident 导出常驻适配器与换模型计划;能力声明随选项", () => {
  assert.equal(entry.createResidentComputeAdapter, createResidentComputeAdapter);
  assert.equal(entry.planTurn, planTurn);
  assert.equal(entry.turnModels, turnModels);
  assert.equal(createResidentComputeAdapter({}).capabilities?.inSessionModelSwitch, true);
  assert.equal(createResidentComputeAdapter({ inSessionModelSwitch: false }).capabilities?.inSessionModelSwitch, false);
});

// ---------------- 常驻适配器:真实子进程 ----------------
test("常驻:三轮同一 PID、同一会话 id,首个提示和后续输入都写进同一进程的 stdin", async () => {
  const r = rig(createResidentComputeAdapter);
  const id = await r.spawn();
  await r.until(() => r.turnEnds().length === 1, 8000, "第 1 轮结束");
  assert.equal((await r.adapter.resume(id, "第二轮", { model: "model-A" })).ok, true);
  await r.until(() => r.turnEnds().length === 2, 8000, "第 2 轮结束");
  assert.equal((await r.adapter.resume(id, "第三轮", { model: "model-A" })).ok, true);
  await r.until(() => r.turnEnds().length === 3, 8000, "第 3 轮结束");
  const launches = r.recs().filter((x) => x.kind === "launch");
  assert.equal(launches.length, 1, "三轮只起一个进程");
  const ins = r.recs().filter((x) => x.kind === "in");
  assert.deepEqual(ins.map((x) => x.text), ["[任务]\n记住暗号:PLUM-7731\n\n[生效群规与硬约束]\n(无)", "第二轮", "第三轮"]);
  assert.equal(new Set(ins.map((x) => x.pid)).size, 1);
  const started = r.events.filter((e) => e.kind === "started");
  assert.equal(started.length, 1);
  assert.equal(started[0]!.kind === "started" && started[0]!.pid, launches[0]!.pid);
  assert.equal(started[0]!.kind === "started" && started[0]!.sessionId, launches[0]!.sessionId);
  assert.equal(alive(launches[0]!.pid), true, "轮与轮之间进程活着");
});

test("下一轮就用新模型:同一进程里先 set_model 再写输入,新模型答出换模型前记下的暗号", async () => {
  const r = rig(createResidentComputeAdapter);
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-B" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const recs = r.recs();
  const ctl = recs.filter((x) => x.kind === "control");
  assert.deepEqual(ctl.map((x) => [x.subtype, x.model]), [["set_model", "model-B"]]);
  const ask = recs.find((x) => x.kind === "turn-start" && x.text === "暗号是什么")!;
  assert.equal(ask.model, "model-B", "这一轮由新模型发出");
  assert.ok(recs.indexOf(ctl[0]!) < recs.indexOf(ask), "切换在写输入之前");
  assert.equal(recs.filter((x) => x.kind === "launch").length, 1, "没有重启");
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind === "completed" && end.result, "PLUM-7731");
});

test("在途这一轮不打断:轮中来的 resume 等这一轮 result 之后才发 set_model,这一轮只由原模型发出", async () => {
  const r = rig(createResidentComputeAdapter, { turnMs: 600 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-start"));
  const p = r.adapter.resume(id, "下一轮", { model: "model-B" });
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(r.recs().some((x) => x.kind === "control"), false, "这一轮还没结束就不发切换请求");
  assert.equal((await p).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const recs = r.recs();
  const firstEnd = recs.find((x) => x.kind === "turn-end")!;
  const ctl = recs.find((x) => x.kind === "control")!;
  assert.deepEqual(firstEnd.models, ["model-A"], "第 1 轮全部请求都是原模型");
  assert.equal(ctl.inTurn, false);
  assert.ok(recs.indexOf(firstEnd) < recs.indexOf(ctl), "set_model 在第 1 轮 result 之后");
  const e1 = r.turnEnds()[0]!;
  assert.deepEqual(e1.kind === "completed" ? e1.models : null, ["model-A"]);
});

test("插话进当前这一轮,不触发换模型", async () => {
  const r = rig(createResidentComputeAdapter, { turnMs: 600 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-start"));
  assert.equal((await r.adapter.steer!(id, "顺便看一下 README")).ok, true);
  await r.until(() => r.turnEnds().length === 1);
  const recs = r.recs();
  const steer = recs.find((x) => x.kind === "in" && x.text === "顺便看一下 README")!;
  assert.equal(steer.priority, "now");
  assert.equal(steer.inTurn, true);
  assert.equal(recs.some((x) => x.kind === "control"), false);
  assert.equal(recs.filter((x) => x.kind === "turn-start").length, 1, "插话没有另开一轮");
  const idle = await r.adapter.steer!(id, "再插一句");
  assert.equal(idle.ok, false, "没有在跑的一轮时插话被拒");
});

test("切换被拒不静默:set_model 回 check_failed,这一轮输入不写入,返回 model-switch-failed 与两条修复路径", async () => {
  const r = rig(createResidentComputeAdapter, { rejectModels: ["model-X"] });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const res = await r.adapter.resume(id, "用 X 跑这一轮", { model: "model-X" });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, "model-switch-failed");
  assert.deepEqual(!res.ok && res.fixes, ["explicit-compatible-model", "change-harness"]);
  assert.match(!res.ok ? res.reason : "", /check_failed/);
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(r.recs().some((x) => x.kind === "in" && x.text === "用 X 跑这一轮"), false, "被拒后没有用旧模型照常发出");
  assert.equal(r.turnEnds().length, 1);
  // 修好之后同一会话照常继续
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-B" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind === "completed" && end.result, "PLUM-7731");
});

test("切换超时同样不发出;会话当前模型记为不明,下一轮无论如何先重新切换", async () => {
  const r = rig(createResidentComputeAdapter, { silentModels: ["model-Q"] }, { switchTimeoutMs: 300 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const res = await r.adapter.resume(id, "用 Q", { model: "model-Q" });
  assert.equal(!res.ok && res.code, "model-switch-failed");
  assert.equal(r.recs().some((x) => x.kind === "in" && x.text === "用 Q"), false);
  assert.equal((await r.adapter.resume(id, "回到 A", { model: "model-A" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const ctl = r.recs().filter((x) => x.kind === "control").map((x) => x.model);
  assert.deepEqual(ctl, ["model-Q", "model-A"], "超时后当前模型不明,即便要的是启动模型也重新 set_model");
});

test("兜底重启:能力声明不支持会话内换模型时,轮边界结束旧进程,--resume 同一会话 id 带新模型,上下文还在", async () => {
  const r = rig(createResidentComputeAdapter, {}, { inSessionModelSwitch: false });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const first = r.recs().find((x) => x.kind === "launch")!;
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-B" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const launches = r.recs().filter((x) => x.kind === "launch");
  assert.equal(launches.length, 2);
  assert.equal(launches[1]!.resume, true);
  assert.equal(launches[1]!.sessionId, first.sessionId, "会话 id 不变");
  assert.equal(launches[1]!.model, "model-B");
  assert.equal(r.recs().some((x) => x.kind === "control"), false, "兜底路径不发 set_model");
  assert.ok(r.recs().some((x) => x.kind === "stdin-closed" && x.pid === first.pid), "旧进程是在轮边界关 stdin 结束的");
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind === "completed" && end.result, "PLUM-7731");
  const restarted = r.events.filter((e) => e.kind === "started");
  assert.equal(restarted.length, 2);
  assert.equal(restarted[1]!.kind === "started" && restarted[1]!.resumed, true);
});

test("切换请求本身不可用(不是模型被拒)时走兜底重启,同一会话 id", async () => {
  const r = rig(createResidentComputeAdapter, { unsupportedSetModel: true });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-B" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const launches = r.recs().filter((x) => x.kind === "launch");
  assert.equal(launches.length, 2);
  assert.equal(launches[1]!.sessionId, launches[0]!.sessionId);
  assert.equal(launches[1]!.model, "model-B");
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind === "completed" && end.result, "PLUM-7731");
});

test("账本:每轮 completed 带这一轮开始时的会话模型与 harness 回报实际用过的模型,换模型后不是只记启动模型", async () => {
  const r = rig(createResidentComputeAdapter);
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  await r.adapter.resume(id, "第二轮", { model: "model-B" });
  await r.until(() => r.turnEnds().length === 2);
  await r.adapter.resume(id, "第三轮", { model: "model-A" });
  await r.until(() => r.turnEnds().length === 3);
  const rows = r.turnEnds().map((e) => (e.kind === "completed" ? [e.model, e.models] : null));
  assert.deepEqual(rows, [["model-A", ["model-A"]], ["model-B", ["model-B"]], ["model-A", ["model-A"]]]);
});

test("只改 effort:下一轮 effort 变、模型不变,不发 set_model、不重启", async () => {
  const r = rig(createResidentComputeAdapter);
  const id = await r.spawn({ model: "model-A", effort: "low" });
  await r.until(() => r.turnEnds().length === 1);
  assert.equal((await r.adapter.resume(id, "第二轮", { model: "model-A", effort: "high" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const recs = r.recs();
  assert.deepEqual(recs.filter((x) => x.kind === "control").map((x) => [x.subtype, (x.settings as { effortLevel?: string } | null)?.effortLevel]), [["apply_flag_settings", "high"]]);
  const t2 = recs.filter((x) => x.kind === "turn-start")[1]!;
  assert.deepEqual([t2.model, t2.effort], ["model-A", "high"]);
  assert.equal(recs.filter((x) => x.kind === "launch").length, 1);
});

test("模型没改:三轮都不发任何切换请求、不重启", async () => {
  const r = rig(createResidentComputeAdapter);
  const id = await r.spawn({ model: "model-A", effort: "medium" });
  await r.until(() => r.turnEnds().length === 1);
  await r.adapter.resume(id, "二", { model: "model-A", effort: "medium" });
  await r.until(() => r.turnEnds().length === 2);
  await r.adapter.resume(id, "三", { model: "model-A" });
  await r.until(() => r.turnEnds().length === 3);
  assert.equal(r.recs().filter((x) => x.kind === "control").length, 0);
  assert.equal(r.recs().filter((x) => x.kind === "launch").length, 1);
});

test("空闲回收后下一轮用同一会话 id、带这一轮的生效模型恢复,上下文还在", async () => {
  const r = rig(createResidentComputeAdapter, {}, { idleReclaimMs: 50 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const first = r.recs().find((x) => x.kind === "launch")!;
  await r.until(() => !alive(first.pid), 5000, "空闲回收");
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-B" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const launches = r.recs().filter((x) => x.kind === "launch");
  assert.equal(launches.length, 2);
  assert.deepEqual([launches[1]!.resume, launches[1]!.sessionId, launches[1]!.model], [true, first.sessionId, "model-B"]);
  assert.equal(r.recs().some((x) => x.kind === "control"), false, "恢复时直接按生效模型启动,不再另发切换");
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind === "completed" && end.result, "PLUM-7731");
});

test("受阻:blocked 受理后这一轮结束、不产出 completed,进程不冻结;resume 把回答写进同一进程", async () => {
  const r = rig(createResidentComputeAdapter, { byText: { "[任务]\n记住暗号:PLUM-7731\n\n[生效群规与硬约束]\n(无)": { reports: [{ kind: "blocked", summary: "缺权限", needs: "要不要覆盖 a.txt" }] } } });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-end"));
  await r.until(() => r.events.some((e) => e.kind === "blocked"));
  const settled = await r.adapter.settled(id);
  assert.deepEqual(settled.map((e) => e.kind), ["started", "blocked"]);
  const pid = r.recs().find((x) => x.kind === "launch")!.pid;
  assert.equal(alive(pid), true);
  assert.equal((await r.adapter.resume(id, "覆盖", { model: "model-A" })).ok, true);
  await r.until(() => r.turnEnds().length === 1);
  assert.equal(r.recs().filter((x) => x.kind === "in" && x.text === "覆盖")[0]!.pid, pid);
});

test("停止:stopped 立即产出,进程被回收,之后的 resume 被拒且不起新进程", async () => {
  const r = rig(createResidentComputeAdapter, { turnMs: 5000 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-start"));
  const pid = r.recs().find((x) => x.kind === "launch")!.pid;
  assert.equal((await r.adapter.stop(id)).ok, true);
  await r.until(() => r.events.at(-1)?.kind === "stopped", 300, "stopped 立即产出");
  assert.equal(r.events.at(-1)?.kind, "stopped");
  await r.until(() => !alive(pid), 5000, "进程退出");
  const again = await r.adapter.resume(id, "继续", { model: "model-A" });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, "这个 Compute 已被停止", "停止之后来的续接直接拒绝,不认领、不等轮边界");
  assert.equal(r.recs().filter((x) => x.kind === "launch").length, 1);
  assert.equal((await r.adapter.stop(id)).ok, false, "重复停止被拒");
});

test("同一时刻只受理一个续接:第二个在第一个等轮边界时被明确拒绝", async () => {
  const r = rig(createResidentComputeAdapter, { turnMs: 500 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-start"));
  const p1 = r.adapter.resume(id, "一", { model: "model-B" });
  const p2 = await r.adapter.resume(id, "二", { model: "model-C" });
  assert.equal(p2.ok, false);
  assert.match(!p2.ok ? p2.reason : "", /同一时刻只受理一个续接/);
  assert.equal((await p1).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  assert.deepEqual(r.recs().filter((x) => x.kind === "control").map((x) => x.model), ["model-B"]);
});

test("spawn 选项只收 handoff/cwd/model/effort;续接的生效模型不合格时拒收且不写输入", async () => {
  const r = rig(createResidentComputeAdapter);
  const bad = await r.adapter.spawn(brief(), { model: "A", harness: "codex" } as never);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.reason : "", /拒绝 harness/);
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const res = await r.adapter.resume(id, "坏", { model: "" } as never);
  assert.equal(res.ok, false);
  assert.equal(r.recs().some((x) => x.kind === "in" && x.text === "坏"), false);
});

test("等轮边界期间被停止的续接作废:不发切换请求、不写输入", async () => {
  const r = rig(createResidentComputeAdapter, { turnMs: 800 });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.recs().some((x) => x.kind === "turn-start"));
  const p = r.adapter.resume(id, "被作废的一轮", { model: "model-B" });
  assert.equal((await r.adapter.stop(id)).ok, true);
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.reason : "", /作废/);
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(r.recs().some((x) => x.kind === "control"), false);
  assert.equal(r.recs().some((x) => x.kind === "in" && x.text === "被作废的一轮"), false);
});

test("每轮 init 的会话 id 必须不变:CLI 换了会话就判违规、这一轮 failed 并回收进程", async () => {
  const r = rig(createResidentComputeAdapter, { byText: { "第二轮": { initSession: "00000000-0000-4000-8000-000000000000" } } });
  const id = await r.spawn({ model: "model-A" });
  await r.until(() => r.turnEnds().length === 1);
  const pid = r.recs().find((x) => x.kind === "launch")!.pid;
  assert.equal((await r.adapter.resume(id, "第二轮", { model: "model-A" })).ok, true);
  await r.until(() => r.turnEnds().length === 2);
  const end = r.turnEnds()[1]!;
  assert.equal(end.kind, "failed");
  assert.match(end.kind === "failed" ? end.reason : "", /会话 id 变成了 00000000-0000-4000-8000-000000000000/);
  await r.until(() => !alive(pid), 5000, "违规后回收进程");
});
