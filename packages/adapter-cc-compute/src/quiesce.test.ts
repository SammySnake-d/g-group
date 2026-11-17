// AC-23 停止确认(适配器一侧,需求 §8.1 已定第 16 条:停止照 mirasim、不用容器;
// 「助手启动的程序及其子程序全部找出来关掉、确认都退出才显示已停止;交给系统后台托管的程序找不到也关不掉」)。
// 起真实子进程:假 CLI(test-support/fake-claude.mjs)按剧本起孙进程,孙进程的副作用只写本测试目录里的中性标记文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { processTable, stillAlive, treeByPgrep, treeOf } from "./procgroup.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const brief = { task: "跑一个很慢的脚本", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };

const ownDirs = new Set<string>();
function reapOwn() {
  let out = "";
  try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { out = ""; }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    if ([...ownDirs].some((d) => m[2]!.includes(d))) { try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* 已退出 */ } }
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("quiesce.test.ts 超过 120 秒,强制结束"); process.exit(1); }, 120_000).unref();

function fake(script: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-q-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const marker = path.join(dir, "outside-marker.txt");
  const filled = JSON.parse(JSON.stringify(script).replaceAll("@MARKER@", marker));
  return { record, options: { runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(filled), FAKE_RECORD: record }, reapForceMs: 800 } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function started(a: ReturnType<typeof createComputeAdapter>, id: string) {
  for await (const e of a.events()) if (e.computeId === id && e.kind === "started") return;
}

test("停止确认:脱离进程组(setsid)且忽略 SIGTERM 的子进程也被找出来关掉,都退出后才返回 ok", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { marker: "@MARKER@", setsid: true, ignoreTerm: true } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief);
  assert.ok(r.ok);
  await started(a, r.computeId);
  const gc = Number(fs.readFileSync(`${f.record}.grandchild.pid`, "utf8"));
  assert.ok(alive(gc));
  assert.ok((await a.stop(r.computeId)).ok);
  const q = await a.quiesce!(r.computeId, 5000);
  assert.deepEqual(q, { ok: true, killed: 1 });
  assert.equal(alive(gc), false, "mirasim 的停止只发主进程与进程组,脱组子进程要靠停止确认关掉");
});

test("停止确认的已知边界:停止前父子链就断了的守护进程(双 fork)找不到,quiesce 照样 ok,守护进程仍在", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", daemon: { marker: "@MARKER@" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief);
  assert.ok(r.ok);
  await started(a, r.computeId);
  const daemon = Number(fs.readFileSync(`${f.record}.daemon.pid`, "utf8"));
  await a.stop(r.computeId);
  const q = await a.quiesce!(r.computeId, 2000);
  assert.equal(q.ok, true);
  assert.equal(alive(daemon), true, "交给系统托管的进程不在保证范围(需求 §8.1 第 16 条)");
});

test("还在运行或未知的 Compute 不做停止确认", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief);
  assert.ok(r.ok);
  await started(a, r.computeId);
  assert.deepEqual(await a.quiesce!(r.computeId), { ok: false, reason: "这一轮还没结束(运行中或停在受阻),先停止", remaining: [] });
  assert.deepEqual(await a.quiesce!("cc-没有"), { ok: false, reason: "未知的 Compute cc-没有", remaining: [] });
  await a.stop(r.computeId);
  assert.equal((await a.quiesce!(r.computeId)).ok, true);
});

test("纯函数:后代按父子链找(含脱组的),同组成员也算,僵尸不算;pid 复用到别的进程组不算还活着;读不到进程表给 null 不给空表", () => {
  const table = processTable(() => ["  100     1   100 S", "  101   100   100 S", "  102   101   102 Ss", "  103   102   102 S", "  104     1   100 S", "  105   100   100 Z", "  200     1   200 S", "garbage"].join("\n"));
  assert.equal(table?.length, 7);
  assert.deepEqual(treeOf(100, table!).map((r) => r.pid).sort(), [101, 102, 103, 104]);
  assert.deepEqual(treeOf(200, table!), []);
  const known = table!.find((r) => r.pid === 103)!;
  assert.equal(stillAlive(known, table!), true);
  assert.equal(stillAlive(known, processTable(() => "  103     1   999 S")!), false);
  assert.equal(stillAlive(known, processTable(() => "  103   102   102 Z")!), false);
  assert.equal(stillAlive(known, []), false);
  assert.equal(processTable(() => { throw new Error("ps 不可用"); }), null);
  assert.deepEqual(table![0], { pid: 100, ppid: 1, pgid: 100, stat: "S" });
});

test("纯函数:ps 读不到时按 pgrep 逐层找后代与同组成员;pgrep 本身失败给 null(不能当成没有子进程)", () => {
  const answers: Record<string, number[] | null> = { "-P 100": [101, 104], "-P 101": [102], "-P 102": [], "-P 104": [], "-g 100": [101, 105, 100] };
  const asked: string[] = [];
  const rows = treeByPgrep(100, (args) => { asked.push(args.join(" ")); return answers[args.join(" ")] ?? []; });
  assert.deepEqual(rows?.map((r) => [r.pid, r.ppid, r.pgid]), [[101, 100, -1], [104, 100, -1], [102, 101, -1], [105, -1, 100]]);
  assert.deepEqual(asked, ["-P 100", "-P 101", "-P 104", "-P 102", "-g 100"]);
  assert.equal(treeByPgrep(100, (args) => (args[0] === "-g" ? null : [])), null);
  assert.equal(treeByPgrep(100, () => null), null);
});
