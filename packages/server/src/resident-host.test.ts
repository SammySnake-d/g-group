// 宿主接常驻 Compute 适配器(生产入口 start.ts / cli.ts 用的就是它)的三条生产路径:
//   AC-29 联系人勾选 skill/MCP 时宿主照常带专属运行目录启动(原来常驻适配器没声明 isolation,宿主直接拒绝);
//   AC-43 ①⑦⑩⑫ 常驻进程的活动流进运行台账:首字节窗口判 no_response、工具在跑不判卡死、子代理与后台任务成单元;
//   AC-23 停止确认:后代进程都退出之后才确认停止、归还槽位,排队的才开工。
// 真实的常驻适配器 + 真实子进程:假 CLI 是适配器包的 test-support/fake-claude-resident.mjs(按包入口解析路径,不跨包相对导入)。
// 只用临时目录与中性内容(NEUTRAL_FIXTURE_NO_CREDENTIALS),不读本机任何账户文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter } from "@g-group/adapter-cc-compute/resident";
import { scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.resolve("@g-group/adapter-cc-compute")));
const SEC = 1000;
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ownDirs = new Set<string>();
const hosts: Host[] = [];
async function reapOwn() {
  for (const h of hosts.splice(0)) await Promise.race([h.close().catch(() => {}), sleep(2000)]);
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
    await sleep(100);
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => { void reapOwn(); console.error("resident-host.test.ts 超过 150 秒,强制结束"); process.exit(1); }, 150_000).unref();

type Clock = { ms: () => number; iso: () => string; advance: (d: number) => void };
function fakeClock(): Clock {
  let t = Date.parse("2026-11-11T02:00:00.000Z");
  return { ms: () => t, iso: () => new Date(t).toISOString(), advance: (d) => { t += d; } };
}
type Rec = { pid: number; kind: string; [k: string]: unknown };
/** 宿主 + 真实常驻适配器(假 CLI);数据目录里有能力库:skill a-style、b-style 与 MCP notes */
function rig(make: typeof createResidentComputeAdapter, script: Record<string, unknown>, opts: Partial<HostOptions> = {}, reapForceMs = 800) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-res-host-"));
  ownDirs.add(dir);
  for (const name of ["a-style", "b-style"]) {
    fs.mkdirSync(path.join(dir, "library", "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "library", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n正文\n`);
  }
  fs.mkdirSync(path.join(dir, "library", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, "library", "mcp", "notes.json"), JSON.stringify({ command: "/usr/bin/true", args: ["--notes"] }));
  const record = path.join(dir, "record.jsonl");
  const adapter = make({ runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs });
  const work = path.join(dir, "work");
  const host = new Host({
    file: path.join(dir, "h.db"), dataDir: dir, mind: () => scriptedMind(), compute: () => adapter, maxDeferMs: 5,
    computeCwd: (t) => { const d = path.join(work, t); fs.mkdirSync(d, { recursive: true }); return d; },
    ...opts,
  });
  hosts.push(host);
  const recs = (): Rec[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const launches = () => recs().filter((x) => x.kind === "launch");
  const until = async (pred: () => boolean, what: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等不到:${what}`);
      await sleep(10);
    }
  };
  return { dir, record, adapter, host, recs, launches, until };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runsOf = (host: Host, layer: string) => host.listRuns({}).runs.filter((r) => r.layer === layer);

test("常驻适配器 + 联系人勾选 skill/MCP:宿主不再拒绝,带专属配置目录、勾选 skill 插件目录与勾选 MCP 启动,实际加载清单记进任务视图", async () => {
  const r = rig(createResidentComputeAdapter, {});
  assert.equal(r.adapter.capabilities?.isolation, true);
  const c = r.host.createContact({ name: "小克" });
  r.host.updateContact(c.id, { computeAssets: [{ name: "a-style", kind: "skill" }, { name: "notes", kind: "mcp" }] });
  const dm = r.host.openDm(c.id);
  r.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理笔记" });
  await r.until(() => r.host.listTasks({ roomId: dm.id })[0]?.state === "T5_InReview" || r.host.listTasks({ roomId: dm.id })[0]?.state === "T11_Failed", "任务跑完");
  const [task] = r.host.listTasks({ roomId: dm.id });
  assert.equal(task!.state, "T5_InReview", "勾选了能力也照常跑完,不落 T11");
  const [l] = r.launches() as unknown as { configDir: string; pluginDirs: string[]; mcpConfig: { mcpServers: Record<string, unknown> }; argv: string[] }[];
  assert.equal(l!.configDir, path.join(r.dir, "run_homes", c.id, "claude-code", "config"));
  assert.equal(l!.pluginDirs.length, 1);
  assert.deepEqual(r.host.capabilities.linkedSkills(l!.pluginDirs[0]!).map((s) => s.name), ["a-style"]);
  assert.deepEqual(Object.keys(l!.mcpConfig.mcpServers).sort(), ["host", "notes"]);
  assert.deepEqual(l!.mcpConfig.mcpServers.notes, { command: "/usr/bin/true", args: ["--notes"], env: {} });
  assert.deepEqual(task!.computeRuns[0]?.loaded, { skills: ["gg-skills:a-style"], mcpServers: ["host", "notes"] });
  const texts = r.host.listMessages(dm.id, {}).messages.map((m) => m.text);
  assert.equal(texts.some((t) => t.includes("还不支持勾选") || t.includes("没做成")), false, texts.join(" | "));
});

test("常驻进程发出请求后上游不回应:活动流进台账,过了首字节窗口在一个核对周期内判 no_response,先停这一轮再写失败,停止确认后进程已退出", async () => {
  const clock = fakeClock();
  const r = rig(createResidentComputeAdapter, { byIncludes: { "[任务]\n查一下天气": { hang: true } } }, {
    clockMs: clock.ms, now: clock.iso, runCheckMs: 10, retry: { maxAutoRetries: 0 }, runThresholds: { defaults: { stallMs: MIN, firstByteMs: 20 * SEC } },
  });
  const c = r.host.createContact({ name: "小克" });
  const dm = r.host.openDm(c.id);
  r.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我查一下天气" });
  await r.until(() => r.recs().some((x) => x.kind === "hang") && runsOf(r.host, "compute-turn").length === 1, "请求已发出");
  const turn = runsOf(r.host, "compute-turn")[0]!;
  await r.until(() => (r.host.runs.get(turn.id)?.progress.awaitingSince ?? null) !== null, "台账记下调用已发出");
  let steps = 0;
  while (r.host.getRun(turn.id).run.status !== "failed") {
    if (++steps > 20) throw new Error("拨到 100 秒还没判");
    clock.advance(5 * SEC);
    await sleep(30);
  }
  assert.ok(steps * 5 >= 20 && steps * 5 <= 30, `过了 20 秒窗口、一个周期内判(拨了 ${steps * 5} 秒)`);
  const v = r.host.getRun(turn.id).run;
  assert.deepEqual([v.reasonClass, v.label, v.thresholdMs], ["no_response", "上游没回应", 20 * SEC]);
  const main = r.launches()[0]!.pid;
  await r.until(() => !alive(main) && r.host.quota.leaseOf(r.host.listTasks({ roomId: dm.id })[0]!.id) === undefined, "停掉这一轮、确认退出后归还槽位");
  assert.equal(r.host.listTasks({ roomId: dm.id })[0]!.state, "T11_Failed");
});

test("常驻进程里的长工具在跑:超过整轮阈值也不判卡死;子代理与后台命令各成台账单元,挂在这一轮下面", async () => {
  const clock = fakeClock();
  const r = rig(createResidentComputeAdapter, {
    byIncludes: {
      "[任务]\n跑全量测试": { tools: [{ name: "Task", input: { description: "查资料" }, inner: true, holdMs: 50 }, { name: "Bash", input: { command: "npm run watch", run_in_background: true } }, { name: "Bash", input: { command: "npm test" }, holdMs: 2500 }] },
    },
  }, { clockMs: clock.ms, now: clock.iso, runCheckMs: 10, retry: { maxAutoRetries: 0 }, runThresholds: { defaults: { stallMs: MIN, firstByteMs: 20 * SEC } } });
  const c = r.host.createContact({ name: "小克" });
  const dm = r.host.openDm(c.id);
  r.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑全量测试" });
  await r.until(() => r.recs().filter((x) => x.kind === "tool-start").length === 3 && runsOf(r.host, "compute-turn").length === 1, "长工具开始");
  const turn = runsOf(r.host, "compute-turn")[0]!;
  await r.until(() => r.host.getRun(turn.id).run.waiting === "tool_running", "台账看到工具在跑");
  for (let i = 0; i < 36; i++) {
    clock.advance(5 * SEC);
    await sleep(15);
  }
  assert.equal(r.host.getRun(turn.id).run.status, "running", "3 分钟超过 1 分钟阈值,工具在跑不判卡死");
  await r.until(() => r.host.getRun(turn.id).run.status === "done", "这一轮跑完");
  const sub = runsOf(r.host, "subagent");
  const bg = runsOf(r.host, "background");
  assert.deepEqual([sub.length, bg.length], [1, 1]);
  assert.deepEqual([sub[0]!.parentId, bg[0]!.parentId, sub[0]!.status], [turn.id, turn.id, "done"]);
  assert.equal(r.host.listTasks({ roomId: dm.id })[0]!.state, "T5_InReview");
});

test("停止确认后才归还槽位:取消在跑的任务,CLI 主进程与脱组后代都退出之前槽位不归还、排队的不开工;都退出后才落 T10、排队的开工", async () => {
  const r = rig(createResidentComputeAdapter, { ignoreTerm: true, byIncludes: { "[任务]\n跑慢脚本": { grandchild: { setsid: true, ignoreTerm: true }, hang: true } } }, { personalComputeSlots: 1 }, 1200);
  const c = r.host.createContact({ name: "小克" });
  const dm = r.host.openDm(c.id);
  r.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑慢脚本" });
  await r.until(() => r.recs().some((x) => x.kind === "hang") && r.host.listTasks({ roomId: dm.id })[0]?.state === "T3_Running", "第一个任务开跑");
  const t1 = r.host.listTasks({ roomId: dm.id })[0]!;
  const gc = Number(fs.readFileSync(`${r.record}.grandchild.pid`, "utf8"));
  const main = r.launches()[0]!.pid;
  r.host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我写个文件" });
  await r.until(() => r.host.listTasks({ roomId: dm.id }).length === 2, "第二个任务建好");
  const t2 = r.host.listTasks({ roomId: dm.id }).find((t) => t.id !== t1.id)!;
  assert.equal(r.launches().length, 1, "个人槽位只有 1 个,第二个排队");
  const samples: { launches: number; main: boolean; gc: boolean; state: string; stopping: boolean }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push({ launches: r.launches().length, main: alive(main), gc: alive(gc), state: r.host.taskDoc(t1.id).value.task.state, stopping: r.host.quota.leaseOf(t1.id)?.stopping === true });
      await sleep(10);
    }
  })();
  r.host.taskDecision(t1.id, "cancel", "c1");
  await r.until(() => r.host.taskDoc(t1.id).value.task.state === "T10_Cancelled" && r.launches().length === 2, "确认停止后落 T10、排队的开工");
  sampling = false;
  await sampler;
  assert.deepEqual(samples.filter((s) => s.launches === 2 && (s.main || s.gc)), [], "排队的开工时主进程与后代都已退出");
  assert.ok(samples.some((s) => s.state === "T9_StopRequested" && s.stopping && s.main && s.launches === 1), "停止请求发出后、主进程还没退出时:T9、槽位在停止中、不给后继");
  assert.equal(samples.some((s) => s.state === "T10_Cancelled" && (s.main || s.gc)), false, "没退干净就不确认停止");
  assert.deepEqual([alive(main), alive(gc), r.host.quota.leaseOf(t1.id)], [false, false, undefined]);
  assert.equal(r.host.quota.leaseOf(t2.id)?.scope, `personal:${c.id}`);
});
