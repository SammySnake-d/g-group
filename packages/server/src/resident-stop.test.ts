// AC-23 R1-01 (review round 1): real Host + real CC resident adapter + the repository's resident fake CLI (owned processes only).
// A failed turn of a resident Compute keeps the process resident and gives the slot back, as before the shared cleanup existed;
// only a stop requires the confirmed exit of everything it started (the Host waits for it before confirming the stop).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter } from "@g-group/adapter-cc-compute/resident";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const FIXTURE = fileURLToPath(new URL("../../adapter-cc-compute/test-support/resident-leaver.mjs", import.meta.url));
const live = (pid: number) => {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").some((l) => { const p = l.trim().split(/\s+/); return Number(p[0]) === pid && !p[1]?.startsWith("Z"); });
  } catch {
    const listed = spawnSync("pgrep", ["-fl", "."], { encoding: "utf8" });
    if (listed.status === 1) return false;
    if (listed.error || listed.status !== 0) throw new Error(`pid enumeration unavailable: ${listed.error?.message ?? listed.stderr}`);
    return listed.stdout.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === pid);
  }
};
async function until(cond: () => boolean, what: string, ms: number) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const readPids = (log: string): { main: number; descendant: number }[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { main: number; descendant: number }) : []);

test("S-PROC-HOST-01 AC-23: 常驻 Compute 一轮 failed 后进程照常驻留、槽位归还、不报停止未确认", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-host-resident-"));
  const log = path.join(dir, "pids.jsonl");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [FIXTURE, `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: "{}", FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PIDS_LOG: log, Q08_FAIL_RESULTS: "1" }, reapForceMs: 30 });
  const reports: string[] = [];
  const host = new Host({ file: path.join(dir, "h.db"), mind: () => scriptedMind(), compute: () => adapter, maxDeferMs: 5, personalComputeSlots: 1, onReport: (what) => reports.push(what) });
  try {
    const c = host.createContact({ name: "小克" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
    await until(() => host.listTasks({ contactId: c.id })[0]?.computeRuns.at(-1)?.status === "failed", "这一轮以 failed 结束", 20000);
    const task = host.listTasks({ contactId: c.id })[0]!;
    await until(() => host.quota.leaseOf(task.id) === undefined, "failed 之后归还槽位", 9000);
    const [resident] = readPids(log);
    if (!resident) throw new Error("没有记录到常驻进程");
    assert.equal(live(resident.main), true, "一轮 failed 不结束常驻进程");
    assert.equal(host.taskView(host.taskDoc(task.id).value).waitingFor, null);
    assert.deepEqual(reports.filter((w) => w === "stop-unconfirmed"), []);
  } finally {
    await host.close();
    for (const p of readPids(log)) for (const pid of [p.descendant, p.main]) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S-PROC-HOST-02 AC-23: 取消正在跑的常驻 Compute,要等它和它留下的脱组子进程都真退出才确认停止、归还槽位", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q08-host-resident-stop-"));
  const log = path.join(dir, "pids.jsonl");
  const adapter = createResidentComputeAdapter({
    runner: { command: process.execPath, args: [FIXTURE, `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: JSON.stringify({ turnMs: 60000 }), FAKE_RECORD: path.join(dir, "record.jsonl"), Q08_PIDS_LOG: log }, reapForceMs: 30 });
  const reports: string[] = [];
  const host = new Host({ file: path.join(dir, "h.db"), mind: () => scriptedMind(), compute: () => adapter, maxDeferMs: 5, personalComputeSlots: 1, onReport: (what) => reports.push(what) });
  try {
    const c = host.createContact({ name: "小克" });
    const dm = host.openDm(c.id);
    host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个很慢的脚本" });
    await until(() => host.listTasks({ contactId: c.id })[0]?.computeRuns.at(-1)?.status === "running" && readPids(log).length === 1, "这一轮开跑", 20000);
    const task = host.listTasks({ contactId: c.id })[0]!;
    const [resident] = readPids(log);
    if (!resident) throw new Error("没有记录到常驻进程");
    assert.equal(live(resident.descendant), true);
    host.taskDecision(task.id, "cancel", "c1");
    await until(() => host.taskDoc(task.id).value.task.state === "T10_Cancelled", "取消后确认停止", 20000);
    assert.deepEqual([live(resident.main), live(resident.descendant)], [false, false], "确认停止之前,常驻进程与它留下的脱组子进程都已退出");
    assert.equal(host.quota.leaseOf(task.id), undefined);
    assert.deepEqual(reports.filter((w) => w === "stop-unconfirmed"), []);
  } finally {
    await host.close();
    for (const p of readPids(log)) for (const pid of [p.descendant, p.main]) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
