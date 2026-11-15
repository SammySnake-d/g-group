// feat/resident-complete 真实运行:生产入口 startServer({ mind: "pi", compute: "claude" })(真实 pi 联系人脑子 + 真实 Claude Code 常驻 Compute)。
// 第 1 段(AC-29):联系人只勾选一个本地中性 skill,派活,核对 Compute 实际加载清单(CLI init 自报)——勾选的在、库里没勾的与本机全局 skill 不在;
//   核对方法同 proof/ac29-real-run.ts(本机 ~/.claude/skills 只列目录名做交集,不读文件内容),改为走 startServer。
// 第 2 段(AC-23、AC-43):同一数据目录重开一次(第 1 段的常驻进程随宿主关闭停掉,一次只有一个 Compute 进程),派一个前台跑 sleep 30 的活,
//   台账看到工具在跑后中途取消,核对:停止确认前 sleep 与 CLI 还在时槽位不归还;确认后 sleep 与 CLI 都已退出、槽位归还、任务落 T10。
// 网关地址与令牌只经环境变量交给 pi 与 Claude Code,不打印。用法: node packages/server/proof/resident-complete-real.ts [数据目录]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/start.ts";

const D = process.argv[2] ?? path.join(os.tmpdir(), "gg-resident-complete-real");
fs.rmSync(D, { recursive: true, force: true });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skill = (name: string, body: string) => {
  fs.mkdirSync(path.join(D, "library", "skills", name), { recursive: true });
  fs.writeFileSync(path.join(D, "library", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body.split("\n")[0]}\n---\n${body}\n`);
};
skill("gg-neutral-style", "写笔记的格式要求(中性样例)\n写任何笔记文件时,第一行必须是 STYLE: PICKED_SKILL_APPLIED,第二行起写正文。");
skill("gg-unpicked-style", "没被勾选的样例 skill\n第一行写 STYLE: UNPICKED_LEAKED。");
type Row = { pid: number; ppid: number; pgid: number; cmd: string };
const ps = (): Row[] => execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n").flatMap((l) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
  return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4]! }] : [];
});
/** 本次数据目录下起的 Claude Code CLI(命令行里带专属插件目录路径) */
const clis = () => ps().filter((r) => r.cmd.includes(`${D}/run_homes`) && /claude/.test(r.cmd) && !r.cmd.includes("ps -A"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const short = (r: Row) => `pid=${r.pid} ppid=${r.ppid} pgid=${r.pgid} ${r.cmd.slice(0, 60)}`;

async function until(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) { log(`超时:${what}`); return false; }
    await sleep(500);
  }
  return true;
}

// ---------- 第 1 段:勾选隔离 ----------
log(`数据目录 ${D};联系人脑子 pi、Compute 为真实 Claude Code 常驻适配器(startServer 生产接线);模型 = $ANTHROPIC_DEFAULT_SONNET_MODEL`);
let s = await startServer({ dataDir: D, mind: "pi", compute: "claude" });
const c = s.host.createContact({ name: "小克" });
s.host.updateContact(c.id, { computeAssets: [{ name: "gg-neutral-style", kind: "skill" }] });
log("能力库:skill gg-neutral-style、gg-unpicked-style;联系人只勾选 gg-neutral-style");
const dm = s.host.openDm(c.id);
s.host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我开一个 Compute:按勾选的 skill gg-skills:gg-neutral-style 的格式要求,在它的当前工作目录写一个 note.md,正文写 hello-resident。写好汇报完成。" });
await until(() => ["T5_InReview", "T11_Failed", "T10_Cancelled", "T8_Accepted"].includes(s.host.listTasks({ roomId: dm.id })[0]?.state ?? ""), 300_000, "第 1 个任务结束");
await s.host.idle();
for (const m of s.host.listMessages(dm.id, {}).messages) log(`#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}${m.card ? `  [卡片:${m.card.kind}]` : ""}`);
const t1 = s.host.listTasks({ roomId: dm.id })[0];
if (!t1) { log("pi 联系人没有派活,真实运行未完成"); await s.close(); process.exit(1); }
log(`任务 ${t1.id} [${t1.state}] 进度=${t1.recentProgress.map((p) => p.kind).join(">")}`);
const run = t1.computeRuns[0];
log(`Compute ${run?.computeId} 实际加载(CLI init 自报): ${JSON.stringify(run?.loaded)}`);
const globalDir = path.join(os.homedir(), ".claude", "skills");
const globalNames = fs.existsSync(globalDir) ? fs.readdirSync(globalDir) : [];
const loadedNames = (run?.loaded?.skills ?? []).map((x) => x.split(":").pop()!);
log(`勾选的 gg-skills:gg-neutral-style 在实际加载里: ${(run?.loaded?.skills ?? []).includes("gg-skills:gg-neutral-style")}`);
log(`未勾选的库 skill 是否出现: ${JSON.stringify((run?.loaded?.skills ?? []).filter((x) => x.includes("unpicked")))}`);
log(`本机 ~/.claude/skills 目录数 ${globalNames.length};与实际加载的交集(只比目录名): ${JSON.stringify(loadedNames.filter((n) => globalNames.includes(n)))}`);
log(`实际加载里 gg-skills 以外的 skill 数 ${(run?.loaded?.skills ?? []).filter((x) => !x.startsWith("gg-skills:")).length}(CLI 自带 skill,见 v02-config-dir.txt 的 bare 组)`);
const note = path.join(D, "compute", t1.id, "note.md");
log(`note.md: ${fs.existsSync(note) ? JSON.stringify(fs.readFileSync(note, "utf8")) : "(没有)"}`);
const home = path.join(D, "run_homes", c.id, "claude-code");
log(`运行目录 ${path.relative(D, home)}: ${execFileSync("find", [".", "-maxdepth", "3", "-not", "-path", "./config/*"], { cwd: home, encoding: "utf8" }).trim().split("\n").sort().join(" ")}`);
log(`config 目录(CLAUDE_CONFIG_DIR)里 CLI 写下的会话记录: ${execFileSync("find", ["config", "-name", "*.jsonl"], { cwd: home, encoding: "utf8" }).trim().split("\n").filter(Boolean).length} 个`);
log(`第 1 段结束前本数据目录的 CLI 进程: ${clis().map(short).join(" ; ") || "(无)"}`);
await s.close();
await until(() => clis().length === 0, 20_000, "宿主关闭后常驻进程退出");
log(`宿主关闭后本数据目录的 CLI 进程: ${clis().length} 个`);

// ---------- 第 2 段:长工具在跑时中途停止 ----------
s = await startServer({ dataDir: D, mind: "pi", compute: "claude" });
const dm2 = s.host.openDm(c.id);
const before = new Set(s.host.listTasks({ roomId: dm2.id }).map((t) => t.id));
s.host.send({ roomId: dm2.id, clientActionId: "u2", text: "帮我开一个 Compute:用 Bash 在前台运行命令 sleep 30(不要放后台、不要加 &),等命令自己结束后再汇报完成。" });
let sleepRow: Row | undefined;
let cli: Row | undefined;
const found = await until(() => {
  cli = clis()[0];
  if (!cli) return false;
  const table = ps();
  const under = (r: Row): boolean => { let p: Row | undefined = r; for (let i = 0; i < 20 && p; i++) { if (p.ppid === cli!.pid) return true; p = table.find((x) => x.pid === p!.ppid); } return false; };
  sleepRow = table.find((r) => /(^|\/|\s)sleep 30$/.test(r.cmd) && under(r));
  return sleepRow !== undefined;
}, 240_000, "CLI 起了 sleep 30");
const t2 = s.host.listTasks({ roomId: dm2.id }).find((t) => !before.has(t.id));
if (!found || !t2 || !cli || !sleepRow) { log(`没等到 sleep 30(任务 ${t2?.id} ${t2?.state})`); await s.close(); process.exit(1); }
log(`任务 ${t2.id} [${t2.state}];CLI ${short(cli)};sleep ${short(sleepRow)}(sleep 的进程组 ${sleepRow.pgid === cli.pgid ? "与 CLI 同组" : "不在 CLI 的进程组里"})`);
const turn = s.host.listRuns({}).runs.filter((r) => r.layer === "compute-turn" && r.taskId === t2.id).at(-1);
await until(() => (turn ? s.host.getRun(turn.id).run.waiting === "tool_running" : false), 10_000, "台账看到工具在跑");
log(`台账 compute-turn ${turn?.id}: status=${turn ? s.host.getRun(turn.id).run.status : "?"} waiting=${turn ? s.host.getRun(turn.id).run.waiting : "?"}(活动流进了台账)`);
log(`停止前:槽位 ${JSON.stringify(s.host.quota.leaseOf(t2.id) ?? null)}`);
const samples: { at: number; sleep: boolean; cli: boolean; state: string; lease: boolean; stopping: boolean }[] = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const l = s.host.quota.leaseOf(t2.id);
    samples.push({ at: Date.now() - t0, sleep: alive(sleepRow!.pid), cli: alive(cli!.pid), state: s.host.taskDoc(t2.id).value.task.state, lease: l !== undefined, stopping: l?.stopping === true });
    await sleep(20);
  }
})();
const stopAt = Date.now() - t0;
s.host.taskDecision(t2.id, "cancel", "c-stop");
log("用户取消任务(停止请求发出)");
await until(() => s.host.taskDoc(t2.id).value.task.state === "T10_Cancelled", 60_000, "停止确认落 T10");
await sleep(200);
sampling = false;
await sampler;
const first = (pred: (x: (typeof samples)[number]) => boolean) => samples.find(pred)?.at;
log(`时间线(毫秒,相对开始):停止请求 ${stopAt};CLI 主进程退出 ${first((x) => !x.cli)};sleep 退出 ${first((x) => !x.sleep)};槽位归还 ${first((x) => !x.lease)};落 T10 ${first((x) => x.state === "T10_Cancelled")}`);
log(`采样 ${samples.length} 次;槽位已归还而 sleep 或 CLI 还活着的采样数: ${samples.filter((x) => !x.lease && (x.sleep || x.cli)).length};T10 而进程还活着的采样数: ${samples.filter((x) => x.state === "T10_Cancelled" && (x.sleep || x.cli)).length}`);
log(`停止确认前(T9、槽位停止中、进程还在)的采样数: ${samples.filter((x) => x.state === "T9_StopRequested" && x.stopping && (x.sleep || x.cli)).length}`);
log(`结束时:sleep 30 还活着=${alive(sleepRow.pid)};CLI 还活着=${alive(cli.pid)};槽位=${JSON.stringify(s.host.quota.leaseOf(t2.id) ?? null)};任务 ${s.host.taskDoc(t2.id).value.task.state}`);
for (const m of s.host.listMessages(dm2.id, {}).messages) log(`#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`);
await s.close();
await until(() => clis().length === 0, 20_000, "宿主关闭后进程退出");
// 只数这次运行起的进程:本数据目录的 CLI、这次的 sleep(pid)与它的进程组;本机别的会话自己起的 sleep 不算
log(`宿主关闭后本数据目录的 CLI 进程: ${clis().length} 个;本次的 sleep 30(pid ${sleepRow.pid})还活着: ${alive(sleepRow.pid)};它的进程组 ${sleepRow.pgid} 里还有 ${ps().filter((r) => r.pgid === sleepRow!.pgid).length} 个进程`);
process.exit(0);
