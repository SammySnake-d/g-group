// AC-23 停止确认(常驻适配器一侧,生产入口用的就是它;需求 §8.1 已定第 16 条:停止照 mirasim、不用容器,
// 「助手启动的程序及其子程序全部找出来关掉、确认都退出才显示已停止;交给系统后台托管的程序找不到也关不掉」;D10)。
// 起真实子进程:假 CLI(test-support/fake-claude-resident.mjs)按剧本在一轮开始时起常驻孙进程,孙进程不写任何文件,只在收到 SIGTERM 时留标记。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter } from "./resident.ts";
import type { ComputeAdapter, ComputeEvent } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.url));
const brief = { task: "跑一个很慢的脚本", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };
const KEY = "[任务]\n跑一个很慢的脚本";

const ownDirs = new Set<string>();
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
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("resident-quiesce.test.ts 超过 150 秒,强制结束"); process.exit(1); }, 150_000).unref();

type Rec = { pid: number; kind: string; [k: string]: unknown };
function rig(make: typeof createResidentComputeAdapter, script: Record<string, unknown>, reapForceMs = 800) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ccr-q-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const adapter = make({ runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs });
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
  const spawn = async () => {
    const r = await adapter.spawn(brief, { cwd: dir, model: "model-A" });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    const id = (r as { computeId: string }).computeId;
    computes.push([adapter, id]);
    return id;
  };
  const gcPid = async () => {
    await until(() => fs.existsSync(`${record}.grandchild.pid`), 8000, "孙进程起来");
    return Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
  };
  const mainPid = () => recs().find((x) => x.kind === "launch")!.pid;
  return { dir, record, adapter, events, recs, until, spawn, gcPid, mainPid };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("停止确认:停止前起的后代另建进程组且忽略 SIGTERM,没退出前不回报;找出来关掉、都退出后才回报 ok 与关掉的数量", async () => {
  const r = rig(createResidentComputeAdapter, { byIncludes: { [KEY]: { grandchild: { setsid: true, ignoreTerm: true }, hang: true } } });
  const id = await r.spawn();
  const gc = await r.gcPid();
  await r.until(() => r.recs().some((x) => x.kind === "hang"), 8000, "这一轮在跑");
  const main = r.mainPid();
  assert.ok(alive(gc) && alive(main));
  assert.equal((await r.adapter.stop(id)).ok, true);
  await r.until(() => r.events.at(-1)?.kind === "stopped", 300, "stopped 立即产出(停止请求 ≠ 已停止)");
  assert.ok(alive(gc), "stopped 产出时脱组后代还在:停止请求 ≠ 已停止");
  let gcAliveAtReply: boolean | null = null;
  let mainAliveAtReply: boolean | null = null;
  const q = await r.adapter.quiesce!(id, 5000).then((x) => { gcAliveAtReply = alive(gc); mainAliveAtReply = alive(main); return x; });
  assert.deepEqual(q, { ok: true, killed: 1 });
  assert.equal(gcAliveAtReply, false, "回报停止确认时脱组后代已退出");
  assert.equal(mainAliveAtReply, false, "回报停止确认时 CLI 主进程已退出");
  assert.equal(fs.existsSync(`${r.record}.grandchild.term`), false, "脱组后代收不到 mirasim 式的 SIGTERM,是停止确认用 SIGKILL 关掉的");
});

test("主进程忽略 SIGTERM:到期对进程组 SIGKILL 之后才确认;同组后代一并关掉,回报前全部退出", async () => {
  const r = rig(createResidentComputeAdapter, { ignoreTerm: true, byIncludes: { [KEY]: { grandchild: { ignoreTerm: true }, hang: true } } }, 600);
  const id = await r.spawn();
  const gc = await r.gcPid();
  await r.until(() => r.recs().some((x) => x.kind === "hang"), 8000, "这一轮在跑");
  const main = r.mainPid();
  const t0 = Date.now();
  assert.equal((await r.adapter.stop(id)).ok, true);
  let state: [boolean, boolean] | null = null;
  const q = await r.adapter.quiesce!(id, 5000).then((x) => { state = [alive(main), alive(gc)]; return x; });
  assert.equal(q.ok, true, q.ok ? "" : q.reason);
  assert.deepEqual(state, [false, false], "主进程与同组后代都退出后才回报");
  assert.ok(Date.now() - t0 >= 550, `主进程忽略 SIGTERM,要等到期组 SIGKILL(用了 ${Date.now() - t0} 毫秒)`);
  assert.ok(r.recs().some((x) => x.kind === "sigterm" && x.pid === main), "先只对主进程发了 SIGTERM");
});

test("这一轮失败但常驻进程还活着:停止确认结束常驻进程并关掉它的后代,都退出才回报;之后续接用同一会话 id 恢复", async () => {
  const r = rig(createResidentComputeAdapter, { byIncludes: { [KEY]: { grandchild: { setsid: true }, result: "error" } } });
  const id = await r.spawn();
  const gc = await r.gcPid();
  await r.until(() => r.events.some((e) => e.kind === "failed"), 8000, "这一轮失败");
  const main = r.mainPid();
  assert.ok(alive(main), "常驻进程在失败的一轮之后照常等输入");
  let state: [boolean, boolean] | null = null;
  const q = await r.adapter.quiesce!(id, 5000).then((x) => { state = [alive(main), alive(gc)]; return x; });
  assert.deepEqual(q, { ok: true, killed: 1 });
  assert.deepEqual(state, [false, false]);
  assert.equal((await r.adapter.resume(id, "暗号是什么", { model: "model-A" })).ok, true);
  await r.until(() => r.events.filter((e) => e.kind === "completed").length === 1, 8000, "续接完成");
  const launches = r.recs().filter((x) => x.kind === "launch");
  assert.deepEqual([launches.length, launches[1]!.resume, launches[1]!.sessionId], [2, true, launches[0]!.sessionId]);
});

test("还在跑的一轮、停在受阻(没停止)、未知的 Compute 都不做停止确认;停止之后才做", async () => {
  const r = rig(createResidentComputeAdapter, { byIncludes: { [KEY]: { hang: true } } });
  const id = await r.spawn();
  await r.until(() => r.recs().some((x) => x.kind === "hang"), 8000, "这一轮在跑");
  assert.deepEqual(await r.adapter.quiesce!(id), { ok: false, reason: "这一轮还没结束(运行中或停在受阻),先停止", remaining: [] });
  assert.deepEqual(await r.adapter.quiesce!("ccr-没有"), { ok: false, reason: "未知的 Compute ccr-没有", remaining: [] });
  const r2 = rig(createResidentComputeAdapter, { byIncludes: { [KEY]: { reports: [{ kind: "blocked", summary: "缺权限", needs: "要不要覆盖 a.txt" }] } } });
  const b = await r2.spawn();
  await r2.until(() => r2.events.some((e) => e.kind === "blocked"), 8000, "停在受阻");
  await r2.adapter.settled(b);
  assert.deepEqual(await r2.adapter.quiesce!(b), { ok: false, reason: "这一轮还没结束(运行中或停在受阻),先停止", remaining: [] });
  assert.ok(alive(r2.mainPid()), "停在受阻时常驻进程照常等回答,不被停止确认关掉");
  await r.adapter.stop(id);
  const q = await r.adapter.quiesce!(id);
  assert.equal(q.ok, true, q.ok ? "" : q.reason);
  assert.equal(alive(r.mainPid()), false);
});
