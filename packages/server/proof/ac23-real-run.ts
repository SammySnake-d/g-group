// AC-23 真实运行:真实 Claude Code Compute + 规则替身联系人脑子。个人槽位 1 个;
// 任务一让 Compute 用 Bash 起一个会自己脱离进程组(setsid)的慢进程再等着,任务二排队;
// 中途取消任务一 → 看任务一在停止确认前是否停在 T9、槽位不交出;确认后慢进程是否已不在、任务二是否才开工。
// 用法: node packages/server/proof/ac23-real-run.ts [数据目录,默认系统临时目录下 gg-ac23-real]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const D = process.argv[2] ?? path.join(os.tmpdir(), "gg-ac23-real");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
const MARK = `gg-ac23-slow-${process.pid}`;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL!;
const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: model };
for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) hostEnv[k] = process.env[k]!;
const adapter = createComputeAdapter({ hostEnv });
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (s: string) => console.log(`${at()} ${s}`);
const host = new Host({
  file: path.join(D, "gg.db"), dataDir: D, mind: () => scriptedMind(), compute: () => adapter, personalComputeSlots: 1, maxDeferMs: 50,
  computeCwd: (t) => { const d = path.join(D, "work", t); fs.mkdirSync(d, { recursive: true }); return d; },
  onReport: (w, d) => log(`[宿主报告] ${w} ${JSON.stringify(d)}`),
});
/** 慢进程:命令行以标记开头(exec -a 把 argv[0] 换成标记);CLI 自己的命令行里也带着这段提示,所以不能只按包含匹配 */
const slow = () => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m?.[2]?.startsWith(MARK)).map((m) => m![1]!);
const c = host.createContact({ name: "小克", speakingModel: model, computeModel: { mode: "explicit", model } });
const dm = host.openDm(c.id);
console.log(`# ${new Date().toISOString()} 真实 Claude Code Compute(${model}),个人槽位 1;慢进程命令行标记 ${MARK}`);
host.send({ roomId: dm.id, clientActionId: "u1", text: `帮我用 Bash 工具执行这一条命令并等它结束:setsid sh -c 'exec -a ${MARK} sleep 600' & sleep 600` });
const wait = async (cond: () => boolean, what: string, ms = 240_000) => {
  const s = Date.now();
  while (!cond()) { if (Date.now() - s > ms) { log(`超时:${what}`); return false; } await host.idle(); await new Promise((r) => setTimeout(r, 500)); }
  return true;
};
const tasks = () => host.listTasks({ roomId: dm.id }).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
await wait(() => slow().length > 0, "慢进程起来");
const t1 = tasks()[0]!;
log(`任务一 ${t1.id} [${host.taskDoc(t1.id).value.task.state}],慢进程 pid ${slow().join(",")},租约 ${JSON.stringify(host.quota.leaseOf(t1.id)?.scope)}`);
host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我在当前目录写一个 hello.txt,内容是 hi" });
await wait(() => tasks().length === 2, "任务二建好");
const t2 = tasks()[1]!;
log(`任务二 ${t2.id} [${host.taskDoc(t2.id).value.task.state}] waitingFor=${JSON.stringify(host.taskView(host.taskDoc(t2.id).value).waitingFor)}`);
host.taskDecision(t1.id, "cancel", "c1");
log(`取消任务一:状态 ${host.taskDoc(t1.id).value.task.state},租约 stopping=${host.quota.leaseOf(t1.id)?.stopping},任务二 Compute 次数 ${host.taskView(host.taskDoc(t2.id).value).computeRuns.length}`);
await wait(() => host.taskDoc(t1.id).value.task.state === "T10_Cancelled", "任务一确认停止");
log(`任务一 [${host.taskDoc(t1.id).value.task.state}],慢进程还在的:${JSON.stringify(slow())},任务一租约 ${JSON.stringify(host.quota.leaseOf(t1.id) ?? null)}`);
await wait(() => ["T5_InReview", "T11_Failed"].includes(host.taskDoc(t2.id).value.task.state), "任务二做完", 480_000);
const v2 = host.taskView(host.taskDoc(t2.id).value);
log(`任务二 [${v2.state}] 进度=${v2.recentProgress.map((p) => p.kind).join(">")} hello.txt=${JSON.stringify(fs.existsSync(path.join(D, "work", t2.id, "hello.txt")) ? fs.readFileSync(path.join(D, "work", t2.id, "hello.txt"), "utf8") : null)}`);
for (const m of host.listMessages(dm.id, {}).messages) console.log(`#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text.slice(0, 160)}${m.card ? `  [卡片:${m.card.kind}]` : ""}`);
await host.close();
for (const p of slow()) { log(`收尾:残留慢进程 ${p},kill`); try { process.kill(Number(p), "SIGKILL"); } catch { /* 已退出 */ } }
process.exit(0);
