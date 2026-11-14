// AC-49 / AC-23 宿主一侧,接生产用的常驻 Compute 适配器(start.ts → compute.ts claudeCompute → createResidentComputeAdapter):
// 经 service 的 rooms.removeMember {stopTasks:true} 移出一个借了本群临时槽位、正在跑长任务的联系人——
//   先标「移出中」、这个群里接新活被拒;它在这个群的任务停止后,CLI 主进程(忽略 SIGTERM)与脱组后代都真的退出之前,
//   任务停在 T9、本群临时槽位不归还、成员不删;都退出后才落 T10、归还、删成员。重复移出不重发停止。
// 阴性:同一联系人在另一个群里的长任务(占个人槽位)全程不被停,那个群的成员与槽位不变;最后取消它并确认停稳。
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
import type { RoomView, TaskView } from "@g-group/api-contract";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.resolve("@g-group/adapter-cc-compute")));
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
setTimeout(() => { void reapOwn(); console.error("resident-exit.test.ts 超过 150 秒,强制结束"); process.exit(1); }, 150_000).unref();

type Rec = { pid: number; kind: string; text?: string; gc?: number };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const contact = (id: string) => ({ kind: "contact" as const, id });
const okValue = <T>(r: { ok: boolean; value?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value as T;
};

test("移出借了本群临时槽位的联系人:CLI 主进程与脱组后代都退出前任务停在 T9、临时槽位不归还、成员仍标移出中,退出后才 T10、归还、删成员;重复移出不重发停止;它在别群的长任务、成员与个人槽位全程不受影响", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-res-exit-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  // CLI 主进程忽略 SIGTERM(只有组 SIGKILL 能结束);一群那件另起一个脱组(setsid)且忽略 SIGTERM 的孙进程;两件都发出请求后再无输出(长任务)
  const script = { ignoreTerm: true, byIncludes: { "[任务]\n跑一群慢脚本": { grandchild: { setsid: true, ignoreTerm: true }, hang: true }, "[任务]\n跑二群慢脚本": { hang: true } } };
  const adapter = createResidentComputeAdapter({ runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs: 1200 });
  const work = path.join(dir, "work");
  const host = new Host({
    file: path.join(dir, "h.db"), dataDir: dir, mind: () => scriptedMind(), compute: () => adapter, maxDeferMs: 5,
    computeCwd: (t) => { const d = path.join(work, t); fs.mkdirSync(d, { recursive: true }); return d; },
  });
  hosts.push(host);
  const svc = createService(host);
  const recs = (): Rec[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const cliOf = (what: string) => recs().find((x) => x.kind === "turn-start" && x.text?.includes(`[任务]\n${what}`))?.pid;
  const until = async (pred: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等不到:${what}`);
      await sleep(10);
    }
  };

  const x = okValue<{ id: string }>(await svc.handle("contacts.create", { clientActionId: "x1", name: "小克" }));
  okValue(await svc.handle("contacts.update", { contactId: x.id, computeSlots: 1 }));
  const g1 = okValue<RoomView>(await svc.handle("rooms.createGroup", { clientActionId: "g1", title: "一群", members: [contact(x.id)] }));
  const g2 = okValue<RoomView>(await svc.handle("rooms.createGroup", { clientActionId: "g2", title: "二群", members: [contact(x.id)] }));
  assert.equal(okValue<RoomView>(await svc.handle("rooms.update", { roomId: g1.id, tempComputeSlots: 1 })).tempComputeSlots, 1);
  const at = [{ id: x.id, source: "manual" as const }];
  // 二群那件先开跑,占掉个人槽位(只有 1 个)
  okValue(await svc.handle("messages.send", { roomId: g2.id, clientActionId: "b1", text: "帮我跑二群慢脚本", mentions: at }));
  await until(() => { const p = cliOf("跑二群慢脚本"); return p !== undefined && recs().some((r) => r.kind === "hang" && r.pid === p); }, "二群任务开跑");
  // 一群那件:个人槽位满了,借一群的临时槽位
  okValue(await svc.handle("messages.send", { roomId: g1.id, clientActionId: "a1", text: "帮我跑一群慢脚本", mentions: at }));
  await until(() => { const p = cliOf("跑一群慢脚本"); return p !== undefined && recs().some((r) => r.kind === "hang" && r.pid === p) && recs().some((r) => r.kind === "grandchild" && r.pid === p); }, "一群任务开跑、孙进程已起");
  const tasks = async (roomId: string) => okValue<{ tasks: TaskView[] }>(await svc.handle("tasks.list", { roomId })).tasks;
  const t1 = (await tasks(g1.id))[0]!;
  const t2 = (await tasks(g2.id))[0]!;
  const main1 = cliOf("跑一群慢脚本")!;
  const main2 = cliOf("跑二群慢脚本")!;
  const gc = recs().find((r) => r.kind === "grandchild" && r.pid === main1)!.gc!;
  assert.deepEqual([t1.state, t1.slot, t2.state, t2.slot], ["T3_Running", { scope: "group", stopping: false }, "T3_Running", { scope: "personal", stopping: false }]);
  assert.deepEqual([alive(main1), alive(gc), alive(main2)], [true, true, true]);
  const g2Before = host.roomView(g2.id);

  type Sample = { main1: boolean; gc: boolean; main2: boolean; t1: string; t2: string; slot1: string | null; stopping1: boolean; slot2: string | null; stopping2: boolean; inG1: boolean; leavingG1: boolean; g2: string };
  const samples: Sample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const l1 = host.quota.leaseOf(t1.id);
      const l2 = host.quota.leaseOf(t2.id);
      const v1 = host.roomView(g1.id);
      const v2 = host.roomView(g2.id);
      samples.push({
        main1: alive(main1), gc: alive(gc), main2: alive(main2),
        t1: host.taskDoc(t1.id).value.task.state, t2: host.taskDoc(t2.id).value.task.state,
        slot1: l1?.scope ?? null, stopping1: l1?.stopping === true, slot2: l2?.scope ?? null, stopping2: l2?.stopping === true,
        inG1: v1.members.some((m) => m.id === x.id), leavingG1: (v1.leavingMembers ?? []).some((m) => m.id === x.id),
        g2: JSON.stringify([v2.members, v2.leavingMembers ?? []]),
      });
      await sleep(10);
    }
  })();

  const leaving = okValue<RoomView>(await svc.handle("rooms.removeMember", { roomId: g1.id, member: contact(x.id), stopTasks: true }));
  assert.deepEqual([leaving.members.some((m) => m.id === x.id), leaving.leavingMembers], [true, [contact(x.id)]]);
  // 重复移出:还在移出中,原样返回,不再发停止
  const again = okValue<RoomView>(await svc.handle("rooms.removeMember", { roomId: g1.id, member: contact(x.id), stopTasks: true }));
  assert.deepEqual(again.leavingMembers, [contact(x.id)]);
  // 移出中(进程还没退出,成员还在):这个群里交给它的新活被拒;成员若被提前删了,这里会是「不在这个会话里」
  const cmd = await svc.handle("messages.send", { roomId: g1.id, clientActionId: "a2", text: "/task 再做一件", command: { name: "task", args: { contact: x.id, what: "再做一件" } } });
  assert.equal(cmd.ok ? null : cmd.error.code, "conflict", `移出中接新活应被拒(conflict),实际 ${JSON.stringify(cmd)};CLI 主进程此刻还活着=${alive(main1)}`);

  await until(() => host.taskDoc(t1.id).value.task.state === "T10_Cancelled" && !host.roomView(g1.id).members.some((m) => m.id === x.id), "一群任务确认停止、成员删除", 30_000);
  await sleep(50);
  sampling = false;
  await sampler;

  const g1Slot = `group:${g1.id}`;
  const personal = `personal:${x.id}`;
  // 一群:没退干净就不确认、不归还、不删成员
  assert.deepEqual(samples.filter((s) => (s.main1 || s.gc) && (s.t1 === "T10_Cancelled" || s.slot1 !== g1Slot || !s.inG1)), [], "CLI 主进程或脱组后代还活着时,任务已 T10 / 临时槽位已归还 / 成员已删");
  assert.ok(samples.some((s) => s.t1 === "T9_StopRequested" && s.slot1 === g1Slot && s.stopping1 && s.inG1 && s.leavingG1 && s.main1), "停止请求发出后、主进程还没退出时:T9、本群临时槽位停止中、成员仍在并标移出中");
  assert.deepEqual([alive(main1), alive(gc), host.quota.leaseOf(t1.id)], [false, false, undefined]);
  const done = okValue<RoomView>(await svc.handle("rooms.get", { roomId: g1.id }));
  assert.deepEqual([done.members.some((m) => m.id === x.id), done.leavingMembers ?? []], [false, []]);
  // 一群那件只收到一次停止(重复移出没有重发)
  assert.equal(recs().filter((r) => r.kind === "sigterm" && r.pid === main1).length, 1);
  // 二群:全程在跑、占着个人槽位,成员不变,没收到停止
  assert.deepEqual(samples.filter((s) => !s.main2 || s.t2 !== "T3_Running" || s.slot2 !== personal || s.stopping2 || s.g2 !== JSON.stringify([g2Before.members, g2Before.leavingMembers ?? []])), [], "二群的任务、槽位或成员在一群移出过程中变了");
  assert.equal(recs().filter((r) => r.kind === "sigterm" && r.pid === main2).length, 0);
  const t2Now = okValue<TaskView>(await svc.handle("tasks.get", { taskId: t2.id }));
  assert.deepEqual([t2Now.state, t2Now.slot, alive(main2)], ["T3_Running", { scope: "personal", stopping: false }, true]);

  // 收尾:取消二群那件,确认停稳、槽位归还
  okValue(await svc.handle("tasks.cancel", { taskId: t2.id, clientActionId: "c2" }));
  await until(() => host.taskDoc(t2.id).value.task.state === "T10_Cancelled", "二群任务确认停止", 30_000);
  assert.deepEqual([alive(main2), host.quota.leaseOf(t2.id), host.quota.view().leases.length], [false, undefined, 0]);
});
