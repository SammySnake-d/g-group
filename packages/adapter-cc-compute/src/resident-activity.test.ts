// AC-43 ①⑦⑩⑪⑫ 的 harness 侧,常驻适配器(生产入口用的就是它;需求文档 D26 第 8.3 节):按 stdout 每一行推送「活动」——
// 模型调用已发出(首字节窗口起点)、流式增量、工具开始 / 结束(后台命令、子代理分别标出)、子代理里的消息。宿主据此给运行台账计时、开子单元。
// 起真实子进程:假 CLI(test-support/fake-claude-resident.mjs)每轮 init 之后输出 system/status requesting,带 --include-partial-messages 时输出
// stream_event 增量(真实 CLI 2.1.319 在 stdin 收 stream-json 时的帧序见 proof/resident-partial-messages-probe.txt)。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter, residentArgs } from "./resident.ts";
import type { ComputeActivity, ComputeAdapter, ComputeEvent } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.url));
const brief = { task: "跑测试", rules: [], tools: ["Read", "Bash"], credentialRefs: [], placement: "local" };

const ownDirs = new Set<string>();
const computes: [ComputeAdapter, string][] = [];
const iters: AsyncIterator<ComputeActivity>[] = [];
function reapOwn() {
  for (const it of iters.splice(0)) void it.return?.();
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
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("resident-activity.test.ts 超过 120 秒,强制结束"); process.exit(1); }, 120_000).unref();

type Rec = { pid: number; kind: string; [k: string]: unknown };
function rig(make: typeof createResidentComputeAdapter, script: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ccr-act-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const adapter = make({ runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs: 1000 });
  const events: ComputeEvent[] = [];
  void (async () => { for await (const e of adapter.events()) events.push(e); })();
  const seen: ComputeActivity[] = [];
  const it = adapter.activity!()[Symbol.asyncIterator]();
  iters.push(it);
  void (async () => {
    for (;;) {
      const x = await it.next();
      if (x.done) return;
      seen.push(x.value);
    }
  })();
  const recs = (): Rec[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const until = async (pred: () => boolean, ms = 8000, what = "条件") => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等待超时:${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const spawn = async (b: Record<string, unknown> = brief) => {
    const r = await adapter.spawn(b, { cwd: dir, model: "model-A" });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    const id = (r as { computeId: string }).computeId;
    computes.push([adapter, id]);
    return id;
  };
  const ends = () => events.filter((e) => e.kind === "completed" || e.kind === "failed");
  return { dir, adapter, events, seen, recs, until, spawn, ends };
}
/** 活动的简写:kind 加关键字段,方便整段比对顺序 */
const brief1 = (a: ComputeActivity): string =>
  a.kind === "tool_start" ? `start:${a.name}${a.background ? ":bg" : ""}${a.subagent ? ":sub" : ""}`
    : a.kind === "tool_end" ? `end${a.isError ? ":err" : ""}`
      : a.kind === "progress" ? `progress:${a.what}`
        : a.kind;

test("常驻启动参数打开流式增量(--include-partial-messages):紧跟 --verbose,前 6 个参数与隔离参数不变", () => {
  const args = residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: false, model: "A" });
  assert.deepEqual(args.slice(0, 7), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  assert.ok(args.indexOf("--include-partial-messages") > args.lastIndexOf("stream-json"));
  for (const f of ["--bare", "--strict-mcp-config", "--permission-mode"]) assert.ok(args.includes(f), f);
  const again = residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: true });
  assert.equal(again.filter((x) => x === "--include-partial-messages").length, 1, "接回旧会话同样打开");
});

test("按 stdout 每行推送活动:发出请求、子代理开始与里面的消息、后台命令、普通工具、流式增量与文本,带 computeId;下一轮照样推", async () => {
  const r = rig(createResidentComputeAdapter, {
    byIncludes: {
      "[任务]\n跑测试": { tools: [{ name: "Task", input: { description: "查资料" }, inner: true, holdMs: 30 }, { name: "Bash", input: { command: "npm test", run_in_background: true } }, { name: "Read", input: { file_path: "a.txt" }, isError: true }] },
    },
  });
  const id = await r.spawn();
  await r.until(() => r.ends().length === 1, 8000, "第 1 轮结束");
  await new Promise((ok) => setTimeout(ok, 50));
  const mine = r.seen.filter((a) => a.computeId === id);
  assert.equal(mine.length, r.seen.length, "活动都带这个 Compute 的 id");
  assert.deepEqual(mine.map(brief1), [
    "model_call",
    "progress:output",
    "start:Task:sub",
    "progress:subagent",
    "end",
    "start:Bash:bg",
    "end",
    "start:Read",
    "end:err",
    "progress:output",
    "progress:text",
  ]);
  const starts = mine.filter((a): a is Extract<ComputeActivity, { kind: "tool_start" }> => a.kind === "tool_start");
  const toolIds = r.recs().filter((x) => x.kind === "tool-start").map((x) => x.id);
  assert.deepEqual(starts.map((a) => a.toolId), toolIds, "工具开始带 CLI 给的 tool_use id");
  assert.equal((await r.adapter.resume(id, "第二轮", { model: "model-A" })).ok, true);
  await r.until(() => r.ends().length === 2, 8000, "第 2 轮结束");
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(r.seen.filter((a) => a.computeId === id).slice(mine.length).map(brief1), ["model_call", "progress:output", "progress:output", "progress:text"], "第二轮同一进程照样推");
});

test("首字节前没有活动:请求发出后上游不回应,活动流只有 model_call、没有任何进展,首字节窗口判定能触发", async () => {
  const r = rig(createResidentComputeAdapter, { byIncludes: { "[任务]\n跑测试": { hang: true } } });
  const id = await r.spawn();
  await r.until(() => r.recs().some((x) => x.kind === "hang"), 8000, "请求已发出");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.deepEqual(r.seen.filter((a) => a.computeId === id).map(brief1), ["model_call"]);
  assert.equal(r.ends().length, 0, "这一轮还在等,没有被当成结束");
});

test("长工具在跑:tool_start 立即推送,tool_end 要等工具真的结束才推(工具在跑是合法等待,不是没有进展)", async () => {
  const r = rig(createResidentComputeAdapter, { byIncludes: { "[任务]\n跑测试": { tools: [{ name: "Bash", input: { command: "sleep 1" }, holdMs: 800 }] } } });
  const id = await r.spawn();
  await r.until(() => r.seen.some((a) => a.kind === "tool_start"), 8000, "工具开始");
  await new Promise((ok) => setTimeout(ok, 300));
  const during = r.seen.filter((a) => a.computeId === id).map(brief1);
  assert.equal(during.at(-1), "start:Bash", "工具还在跑,没有收到结束");
  assert.equal(during.includes("end"), false);
  await r.until(() => r.ends().length === 1, 8000, "这一轮结束");
  await new Promise((ok) => setTimeout(ok, 50));
  const all = r.seen.filter((a) => a.computeId === id).map(brief1);
  assert.ok(all.indexOf("end") > all.indexOf("start:Bash"));
});

test("init 核验没通过的这一轮不推活动:CLI 换了会话 id 判违规后,之后的请求与工具行都不算进展;同一适配器上合规的 Compute 照常推", async () => {
  // CLI 主进程忽略 SIGTERM:违规回收发出之后它仍把请求与工具行写完,才看得出这些行没被当成活动
  const r = rig(createResidentComputeAdapter, { ignoreTerm: true, byIncludes: { "[任务]\n跑测试": { initSession: "00000000-0000-4000-8000-000000000000", tools: [{ name: "Bash", input: { command: "ls" } }] } } });
  const id = await r.spawn();
  await r.until(() => r.ends().length === 1, 8000, "违规结束");
  const end = r.ends()[0]!;
  assert.equal(end.kind, "failed");
  assert.match(end.kind === "failed" ? end.reason : "", /会话 id 变成了/);
  await r.until(() => r.recs().some((x) => x.kind === "tool-end"), 8000, "CLI 把工具行写完");
  const ok = await r.spawn({ ...brief, task: "对照" });
  await r.until(() => r.events.some((e) => e.computeId === ok && e.kind === "completed"), 8000, "对照 Compute 完成");
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(r.seen.filter((a) => a.computeId === id), [], "违规的这一轮一条活动都没有");
  assert.deepEqual(r.seen.filter((a) => a.computeId === ok).map(brief1), ["model_call", "progress:output", "progress:output", "progress:text"]);
});

test("已经跑过合规一轮之后再判违规(第二个 init 换了会话):这一轮违规之后的请求与工具行同样不算进展", async () => {
  const r = rig(createResidentComputeAdapter, {
    ignoreTerm: true,
    byIncludes: { "[任务]\n跑测试": {}, "违规轮": { initSession: "00000000-0000-4000-8000-000000000000", tools: [{ name: "Bash", input: { command: "ls" } }] } },
  });
  const id = await r.spawn();
  await r.until(() => r.ends().length === 1, 8000, "第 1 轮结束");
  await new Promise((done) => setTimeout(done, 50));
  const afterFirst = r.seen.length;
  assert.deepEqual(r.seen.map(brief1), ["model_call", "progress:output", "progress:output", "progress:text"], "第 1 轮的活动照常推");
  assert.equal((await r.adapter.resume(id, "违规轮", { model: "model-A" })).ok, true);
  await r.until(() => r.ends().length === 2, 8000, "违规结束");
  const end = r.ends()[1]!;
  assert.equal(end.kind, "failed");
  assert.match(end.kind === "failed" ? end.reason : "", /会话 id 变成了/);
  await r.until(() => r.recs().some((x) => x.kind === "tool-end"), 8000, "CLI 把工具行写完");
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(r.seen.slice(afterFirst), [], "判违规之后的请求与工具行都没推成活动");
});
