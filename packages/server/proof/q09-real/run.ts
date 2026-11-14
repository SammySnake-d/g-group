// Q09 最小闭环剩余具名验收的真实运行:生产入口 startServer({ mind: "pi", compute: "claude" })(真实 pi 联系人脑子 + 真实 Claude Code 常驻 Compute),
// 一切动作与读状态都走 startServer 返回的 service.handle(...)(与桌面端 IPC 同一入口),不直接改宿主状态。
//   a4  停止:长工具(Bash 前台 sleep 120)确实已起(ps 看到是 CLI 的后代)后 tasks.cancel;约 20 毫秒采样,CLI 主进程与全部后代退出之前
//       任务停在 T9、槽位不归还;都退出后才 T10 并归还;超时即失败。
//   a5  成员移出:联系人 X 个人槽位 1 个;二群那件先占个人槽位,一群那件借一群的临时槽位;rooms.removeMember {stopTasks:true} 移出一群的 X →
//       移出中、一群新消息不派给它 / 接新活被拒 → 真实进程停稳 → 才删成员、归还临时槽位;重复移出不重发停止;二群那件全程不受影响,最后取消并停稳。
//   a3  在途纠正:Compute 第一轮在跑(前台 sleep)时用户改条件 → 联系人 forward(sourceSeq)→ constraintVersion 升版 → 这一轮结束后续接同一个
//       computeId → 产物按新条件变化 → 交付时 resultVer == constraintVersion → T8a → 本人普通回复「通过」经联系人 verdict 到 T8。
// 每个场景:steps.log(时间戳 + 动作 + 结果)、samples.csv(采样)、events.jsonl / reports.jsonl、messages.txt、tasks.json、runs.json、
//   gg-backup.sqlite(结束时 SQLite 只读备份)、result.json(每条具名断言 pass/fail)。任何断言失败、异常或超时都非零退出。
// 输出目录必须是新的、不存在的绝对路径;不删除任何已有目录。网关地址与令牌只从 ~/.claude/settings.json 的 env 读,只经环境变量交给 pi 与 CLI,不打印、不落盘。
// 用法: node packages/server/proof/q09-real/run.ts <新的绝对输出目录> [a3|a4|a5|all]
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MethodName, ParamsOf, ResultOf, ServerEvent, TaskView } from "@g-group/api-contract";
import { type Started, startServer } from "../../src/start.ts";

const MODEL = "workbuddy-ai/deepseek-v4.1-flash-sg";
const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// ---------------------------------------------------------------- 参数与网关
const [outArg, whichArg = "all"] = process.argv.slice(2);
if (!outArg || !path.isAbsolute(outArg) || !["a3", "a4", "a5", "all"].includes(whichArg)) {
  console.error("用法: node packages/server/proof/q09-real/run.ts <新的绝对输出目录> [a3|a4|a5|all]");
  process.exit(2);
}
if (fs.existsSync(outArg)) {
  console.error(`输出目录 ${outArg} 已存在:不覆盖、不删除,请换一个新的目录`);
  process.exit(2);
}
const OUT = outArg;
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")) as { env?: Record<string, string> };
const BASE = settings.env?.ANTHROPIC_BASE_URL;
const TOKEN = settings.env?.ANTHROPIC_AUTH_TOKEN;
if (!BASE || !TOKEN) {
  console.error("~/.claude/settings.json 的 env 里缺 ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN");
  process.exit(2);
}
/** 只给 startServer 这三项:网关地址、令牌、说话与 Compute 模型(startServer 把它写进默认说话模型与默认 Compute 模型) */
const ENV = { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL };
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const COMMIT = git("rev-parse", "HEAD");
const DIRTY = git("status", "--porcelain", "--untracked-files=no") !== "";
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- 进程
type Row = { pid: number; ppid: number; pgid: number; stat: string; cmd: string };
async function psTable(): Promise<Row[]> {
  const { stdout } = await execFileP("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,command="], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4]!, cmd: m[5]! }] : [];
  });
}
/** 本进程(宿主)直接起的 Claude Code CLI:常驻适配器从 stdin 收 stream-json */
const myClis = (rows: readonly Row[]) => rows.filter((r) => r.ppid === process.pid && r.cmd.includes("--input-format stream-json"));
const descendants = (root: number, rows: readonly Row[]): Row[] => {
  const out: Row[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const r of rows) if (r.ppid === p && !out.some((x) => x.pid === r.pid)) { out.push(r); queue.push(r.pid); }
  }
  return out;
};
async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}
const killAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: unknown }).code === "EPERM"; }
};
/** 严格判活:kill(0) 还在时再看 ps 状态,僵尸(已退出、未被回收)算已退出 */
const aliveStrict = (pid: number) => {
  if (!killAlive(pid)) return false;
  try { return !execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return false; }
};
type Tree = { cli: Row; desc: Row[]; target: Row | undefined };
const cliCwd = new Map<number, string>();
/** 这个任务的 CLI(cwd 是 <数据目录>/compute/<任务 id>)、它此刻的后代,以及命令行正好是 want 的那个后代 */
async function treeOf(dataDir: string, taskId: string, want: RegExp): Promise<Tree | null> {
  const rows = await psTable();
  const dir = fs.realpathSync(path.join(dataDir, "compute", taskId));
  for (const c of myClis(rows)) {
    let cwd = cliCwd.get(c.pid);
    if (cwd === undefined) {
      cwd = (await cwdOf(c.pid)) ?? "";
      if (cwd) cliCwd.set(c.pid, cwd);
    }
    if (cwd !== dir) continue;
    const desc = descendants(c.pid, rows);
    return { cli: c, desc, target: desc.find((r) => want.test(r.cmd)) };
  }
  return null;
}
const short = (r: Row) => `pid=${r.pid} ppid=${r.ppid} pgid=${r.pgid} ${r.cmd.slice(0, 80)}`;

// ---------------------------------------------------------------- 场景记录
type Assertion = { id: string; name: string; pass: boolean; detail: string };
type Ctx = ReturnType<typeof scenario>;
function scenario(name: string) {
  const dir = path.join(OUT, name);
  const data = path.join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
  const t0 = Date.now();
  const asserts: Assertion[] = [];
  const stepsFile = path.join(dir, "steps.log");
  const step = (action: string, result = "") => {
    const line = `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(2)}s ${action}${result ? ` → ${result}` : ""}`;
    fs.appendFileSync(stepsFile, `${line}\n`);
    console.log(`[${name}] ${line}`);
  };
  const check = (id: string, title: string, pass: boolean, detail: string) => {
    asserts.push({ id, name: title, pass, detail });
    step(`断言 ${id} ${title}`, `${pass ? "通过" : "失败"}:${detail}`);
  };
  const events = fs.openSync(path.join(dir, "events.jsonl"), "a");
  const reports = fs.openSync(path.join(dir, "reports.jsonl"), "a");
  const onEvent = (e: ServerEvent) => {
    const x = e as unknown as { type: string; task?: TaskView; room?: { id: string; members: unknown; leavingMembers?: unknown }; message?: { roomId: string; seq: number; sender: unknown; text: string } };
    const brief = x.task
      ? { taskId: x.task.id, state: x.task.state, slot: x.task.slot ?? null, constraintVersion: x.task.constraintVersion, computeIds: x.task.computeRuns.map((r) => r.computeId), deliveredSeq: x.task.deliveredSeq ?? null }
      : x.room
        ? { roomId: x.room.id, members: x.room.members, leavingMembers: x.room.leavingMembers ?? [] }
        : x.message
          ? { roomId: x.message.roomId, seq: x.message.seq, sender: x.message.sender, text: x.message.text.slice(0, 300) }
          : {};
    fs.writeSync(events, `${JSON.stringify({ at: new Date().toISOString(), type: x.type, ...brief })}\n`);
  };
  const onReport = (what: string, detail: unknown) => {
    let d = "";
    try { d = JSON.stringify(detail, (_k, v) => (v instanceof Error ? v.message : v)) ?? ""; } catch { d = String(detail); }
    fs.writeSync(reports, `${JSON.stringify({ at: new Date().toISOString(), what, detail: d.slice(0, 2000) })}\n`);
  };
  const writeCsv = (file: string, rows: readonly Record<string, unknown>[]) => {
    if (!rows.length) { fs.writeFileSync(path.join(dir, file), ""); return; }
    const keys = Object.keys(rows[0]!);
    fs.writeFileSync(path.join(dir, file), `${keys.join(",")}\n${rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(",")).join("\n")}\n`);
  };
  return { name, dir, data, t0, asserts, step, check, onEvent, onReport, writeCsv, close: () => { fs.closeSync(events); fs.closeSync(reports); } };
}

/** service.handle 包一层:失败抛错(带错误码),每次调用记进 steps.log(读状态的轮询不记) */
function caller(s: Started, sc: Ctx) {
  async function call<M extends MethodName>(m: M, p: ParamsOf<M>, quiet = false): Promise<ResultOf<M>> {
    const r = await s.service.handle(m, p);
    if (!r.ok) {
      if (!quiet) sc.step(`service ${m}`, `错误 ${r.error.code}:${r.error.message}`);
      throw Object.assign(new Error(`${m}: ${r.error.code} ${r.error.message}`), { code: r.error.code });
    }
    if (!quiet) sc.step(`service ${m}`, "ok");
    return r.value as ResultOf<M>;
  }
  async function attempt<M extends MethodName>(m: M, p: ParamsOf<M>) {
    const r = await s.service.handle(m, p);
    sc.step(`service ${m}`, r.ok ? "ok" : `错误 ${r.error.code}:${r.error.message}`);
    return r;
  }
  return { call, attempt };
}

async function waitFor<T>(sc: Ctx, what: string, ms: number, every: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) { sc.step(`等到:${what}`); return v; }
    if (Date.now() > end) throw new Error(`超时 ${ms / 1000} 秒:${what}`);
    await sleep(every);
  }
}

/** 约 intervalMs 一次的采样循环;fn 里读状态全走 service(handle 内部同步执行,与进程判活在同一个事件循环片段里) */
function sampler<R extends Record<string, unknown>>(intervalMs: number, fn: () => Promise<R>) {
  const rows: (R & { at: number })[] = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      rows.push({ at: t, ...(await fn()) });
      await sleep(Math.max(0, intervalMs - (Date.now() - t)));
    }
  })();
  return { rows, stop: async () => { on = false; await loop; } };
}
const gaps = (rows: readonly { at: number }[]) => {
  const g = rows.slice(1).map((r, i) => r.at - rows[i]!.at).sort((a, b) => a - b);
  return { n: rows.length, median: g.length ? g[Math.floor(g.length / 2)]! : 0, max: g.length ? g[g.length - 1]! : 0 };
};

/** 收尾:关宿主、等本进程起的 CLI 与记下的进程全部退出(超时即失败)、SQLite 只读备份、导出视图 */
async function finish(sc: Ctx, s: Started, tracked: readonly number[], dump: () => Promise<void>) {
  try { await dump(); } catch (e) { sc.step("导出视图失败", e instanceof Error ? e.message : String(e)); }
  await s.close();
  sc.step("宿主已关闭");
  const end = Date.now() + 30_000;
  let left: string[] = [];
  for (;;) {
    const rows = await psTable();
    left = [...myClis(rows).map(short), ...tracked.filter((p) => aliveStrict(p)).map((p) => `记下的 pid ${p}`)];
    if (!left.length || Date.now() > end) break;
    await sleep(300);
  }
  sc.check(`${sc.name.toUpperCase()}-CLEAN`, "收尾清干净:宿主关闭后本次起的 CLI 与记下的后代全部退出", left.length === 0, left.length ? `还活着:${left.join(" ; ")}` : `记下的 ${tracked.length} 个进程与本进程起的 CLI 都已退出`);
  try {
    const db = new DatabaseSync(path.join(sc.data, "gg.db"), { readOnly: true });
    await backup(db, path.join(sc.dir, "gg-backup.sqlite"));
    db.close();
    sc.step("SQLite 只读备份", "gg-backup.sqlite");
  } catch (e) {
    sc.check(`${sc.name.toUpperCase()}-DB`, "SQLite 只读备份", false, e instanceof Error ? e.message : String(e));
  }
}
async function dumpViews(sc: Ctx, s: Started) {
  const { call } = caller(s, sc);
  const rooms = (await call("rooms.list", {}, true)).rooms;
  const lines: string[] = [];
  for (const r of rooms) {
    lines.push(`== ${r.id} ${r.kind} ${r.title}`);
    for (const m of (await call("messages.list", { roomId: r.id, limit: 500 }, true)).messages) {
      lines.push(`#${m.seq} ${m.at} ${m.sender.kind}:${m.sender.id}${m.replyToSeq ? ` ↩#${m.replyToSeq}` : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}${m.card ? ` [卡片:${m.card.kind}]` : ""}${m.artifacts?.length ? ` [工件:${m.artifacts.map((a) => `${a.name} ${a.sha256 ?? ""}`).join(";")}]` : ""}`);
    }
  }
  fs.writeFileSync(path.join(sc.dir, "messages.txt"), `${lines.join("\n")}\n`);
  const tasks = (await call("tasks.list", { limit: 200 }, true)).tasks;
  fs.writeFileSync(path.join(sc.dir, "tasks.json"), JSON.stringify(tasks, null, 2));
  fs.writeFileSync(path.join(sc.dir, "runs.json"), JSON.stringify((await call("runs.list", { limit: 500 }, true)).runs, null, 2));
  const progress: Record<string, unknown> = {};
  for (const t of tasks) progress[t.id] = (await call("tasks.progress", { taskId: t.id, limit: 500 }, true)).progress;
  fs.writeFileSync(path.join(sc.dir, "progress.json"), JSON.stringify(progress, null, 2));
}
function writeResult(sc: Ctx, extra: Record<string, unknown>) {
  const pass = sc.asserts.length > 0 && sc.asserts.every((a) => a.pass);
  fs.writeFileSync(path.join(sc.dir, "result.json"), JSON.stringify({ scenario: sc.name, pass, commit: COMMIT, dirty: DIRTY, model: MODEL, startedAt: new Date(sc.t0).toISOString(), endedAt: new Date().toISOString(), dataDir: sc.data, ...extra, assertions: sc.asserts }, null, 2));
  sc.step(`场景 ${sc.name} 结束`, pass ? "全部断言通过" : `失败:${sc.asserts.filter((a) => !a.pass).map((a) => a.id).join(", ")}`);
  sc.close();
  return pass;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const at = (id: string) => [{ id, source: "manual" as const }];

// ---------------------------------------------------------------- A4 停止
async function a4(): Promise<boolean> {
  const sc = scenario("a4");
  sc.step(`场景 a4 开始:代码 ${COMMIT}${DIRTY ? "(工作区有未提交改动)" : ""};startServer mind=pi compute=claude;说话与 Compute 模型 ${MODEL}`);
  const s = await startServer({ dataDir: sc.data, mind: "pi", compute: "claude", env: ENV, onReport: sc.onReport });
  const off = s.service.subscribe(sc.onEvent);
  const { call } = caller(s, sc);
  const tracked: number[] = [];
  let samples: Record<string, unknown>[] = [];
  try {
    const x = await call("contacts.create", { clientActionId: "a4-x", name: "小克" });
    const dm = await call("rooms.openDm", { contactId: x.id });
    await call("messages.send", { roomId: dm.id, clientActionId: "a4-u1", text: "帮我开一个 Compute:用 Bash 工具在前台运行命令 sleep 120(不要放后台、不要加 &、不要换成别的命令),等它自己结束后再汇报完成。" });
    const SLEEP = /^(\S*\/)?sleep 120$/;
    const got = await waitFor(sc, "任务建好、CLI 起了 sleep 120", 300_000, 1000, async () => {
      const t = (await call("tasks.list", { roomId: dm.id }, true)).tasks[0];
      if (!t) return null;
      const tree = await treeOf(sc.data, t.id, SLEEP);
      return tree?.target ? { t, tree } : null;
    });
    const task = await call("tasks.get", { taskId: got.t.id }, true);
    const { cli, desc, target } = got.tree;
    sc.step("停止前进程树", [`CLI ${short(cli)}`, ...desc.map((r) => `后代 ${short(r)}`)].join(" | "));
    tracked.push(cli.pid, ...desc.map((r) => r.pid));
    sc.check("A4-01", "长工具确实已起:sleep 120 是这个任务 CLI 的后代,任务在跑、占着个人槽位", target !== undefined && task.state === "T3_Running" && task.slot?.scope === "personal" && task.slot.stopping === false,
      `任务 ${task.id} ${task.state} slot=${JSON.stringify(task.slot)};sleep ${target ? short(target) : "无"}(进程组${target && target.pgid === cli.pgid ? "与 CLI 相同" : "与 CLI 不同"});CLI 后代 ${desc.length} 个`);
    const smp = sampler(20, async () => {
      const v = await call("tasks.get", { taskId: task.id }, true);
      const seen = tracked.filter((p) => killAlive(p));
      // 宿主已归还或已 T10 时,kill(0) 还看得到的再当场看 ps 状态:僵尸(已退出、未被回收)算已退出(与停止确认 stillAlive 同一口径),另列一栏
      const released = v.state === "T10_Cancelled" || !v.slot;
      const live = released ? seen.filter((p) => aliveStrict(p)) : seen;
      return { state: v.state, slot: v.slot ? `${v.slot.scope}${v.slot.stopping ? "/stopping" : ""}` : "", waitingFor: v.waitingFor ?? "", cliAlive: killAlive(cli.pid), sleepAlive: killAlive(target!.pid), aliveCount: live.length, alivePids: live.join(" "), zombies: seen.filter((p) => !live.includes(p)).join(" ") };
    });
    await sleep(100);
    const stopAt = Date.now();
    await call("tasks.cancel", { taskId: task.id, clientActionId: "a4-cancel" });
    let timedOut = false;
    try {
      await waitFor(sc, "任务落 T10", 60_000, 20, async () => (await call("tasks.get", { taskId: task.id }, true)).state === "T10_Cancelled");
    } catch (e) {
      timedOut = true;
      sc.step("停止确认超时", errText(e));
    }
    await sleep(300);
    await smp.stop();
    samples = smp.rows.map((r) => ({ ...r, t_ms: r.at - stopAt }));
    sc.writeCsv("samples.csv", samples);
    // 宿主已归还/已 T10 时还 kill(0) 得到的进程:看一眼 ps,僵尸(已退出未回收)算已退出
    const released = smp.rows.filter((r) => r.at >= stopAt && (r.state === "T10_Cancelled" || r.slot === ""));
    const badPids = new Set(released.flatMap((r) => (r.alivePids ? r.alivePids.split(" ").map(Number) : [])));
    const stillAliveNow = [...badPids].filter((p) => aliveStrict(p));
    const bad = released.filter((r) => r.aliveCount > 0);
    const first = (pred: (r: (typeof smp.rows)[number]) => boolean) => { const r = smp.rows.find((x) => x.at >= stopAt && pred(x)); return r ? r.at - stopAt : null; };
    const g = gaps(smp.rows);
    sc.step("时间线(毫秒,相对停止请求)", `sleep 退出 ${first((r) => !r.sleepAlive)};CLI 退出 ${first((r) => !r.cliAlive)};全部后代退出 ${first((r) => r.aliveCount === 0)};T9 ${first((r) => r.state === "T9_StopRequested")};槽位归还 ${first((r) => r.slot === "")};T10 ${first((r) => r.state === "T10_Cancelled")};采样 ${g.n} 次,间隔中位 ${g.median} 最大 ${g.max}`);
    sc.check("A4-02", "停止请求经 service 受理后任务进 T9(停止请求 ≠ 已停止)", smp.rows.some((r) => r.at >= stopAt && r.state === "T9_StopRequested"), `首次看到 T9 在停止请求后 ${first((r) => r.state === "T9_StopRequested")} 毫秒`);
    sc.check("A4-03", "CLI 主进程或任一后代还活着时,任务没有落 T10、槽位没有归还", bad.length === 0, bad.length ? `${bad.length} 次采样在归还/T10 时仍有进程(kill 0 可见);其中此刻仍非僵尸的 pid: ${stillAliveNow.join(",") || "无"};例:${JSON.stringify(bad[0])}` : `归还/T10 之后的 ${released.length} 次采样里进程全部已退出`);
    const window = smp.rows.filter((r) => r.state === "T9_StopRequested" && r.slot === "personal/stopping" && r.aliveCount > 0);
    sc.check("A4-04", "停稳窗口被采到:T9、槽位停止中(仍占着)、进程还在", window.length > 0, `${window.length} 次采样`);
    const fin = await call("tasks.get", { taskId: task.id }, true);
    const leftPids = tracked.filter((p) => aliveStrict(p));
    sc.check("A4-05", "全部退出后才 T10 并归还,60 秒内完成(超时即失败)", !timedOut && fin.state === "T10_Cancelled" && fin.slot === null && leftPids.length === 0,
      `停止请求后 ${first((r) => r.state === "T10_Cancelled")} 毫秒落 T10;此刻 state=${fin.state} slot=${JSON.stringify(fin.slot)} 记下的进程还活着 ${leftPids.join(",") || "无"};超时=${timedOut}`);
    sc.check("A4-06", "约 20 毫秒采样", g.n >= 10 && g.median <= 40, `采样 ${g.n} 次,间隔中位 ${g.median} 毫秒、最大 ${g.max} 毫秒`);
  } catch (e) {
    sc.check("A4-ERR", "场景执行没有异常或超时", false, errText(e));
  } finally {
    off();
    await finish(sc, s, tracked, () => dumpViews(sc, s));
  }
  return writeResult(sc, { samples: samples.length });
}

// ---------------------------------------------------------------- A5 成员移出
async function a5(): Promise<boolean> {
  const sc = scenario("a5");
  sc.step(`场景 a5 开始:代码 ${COMMIT}${DIRTY ? "(工作区有未提交改动)" : ""};startServer mind=pi compute=claude;说话与 Compute 模型 ${MODEL}`);
  const s = await startServer({ dataDir: sc.data, mind: "pi", compute: "claude", env: ENV, onReport: sc.onReport });
  const t1States: string[] = [];
  let t1Id = "";
  const off = s.service.subscribe((e) => {
    sc.onEvent(e);
    if (e.type === "task.updated" && e.task.id === t1Id && t1States.at(-1) !== e.task.state) t1States.push(e.task.state);
  });
  const { call, attempt } = caller(s, sc);
  const tracked: number[] = [];
  let samples: Record<string, unknown>[] = [];
  try {
    const x = await call("contacts.create", { clientActionId: "a5-x", name: "小克" });
    await call("contacts.update", { contactId: x.id, computeSlots: 1 });
    const g1 = await call("rooms.createGroup", { clientActionId: "a5-g1", title: "一群", members: [{ kind: "contact", id: x.id }] });
    const g2 = await call("rooms.createGroup", { clientActionId: "a5-g2", title: "二群", members: [{ kind: "contact", id: x.id }] });
    const g1v = await call("rooms.update", { roomId: g1.id, tempComputeSlots: 1 });
    sc.step("一群临时槽位", String(g1v.tempComputeSlots));
    const S2 = /^(\S*\/)?sleep 300$/;
    const S1 = /^(\S*\/)?sleep 200$/;
    await call("messages.send", { roomId: g2.id, clientActionId: "a5-b1", text: "@小克 帮我开一个 Compute:用 Bash 工具在前台运行命令 sleep 300,调用时把 timeout 参数设为 600000(不要放后台、不要加 &、不要换成别的命令),等它自己结束后再汇报完成。", mentions: at(x.id) });
    const t2 = await waitFor(sc, "二群任务开工(占个人槽位)", 300_000, 1000, async () => {
      const t = (await call("tasks.list", { roomId: g2.id }, true)).tasks[0];
      return t?.slot ? t : null;
    });
    await call("messages.send", { roomId: g1.id, clientActionId: "a5-a1", text: "@小克 帮我开一个 Compute:用 Bash 工具在前台运行命令 sleep 200,调用时把 timeout 参数设为 600000(不要放后台、不要加 &、不要换成别的命令),等它自己结束后再汇报完成。", mentions: at(x.id) });
    const tr2 = await waitFor(sc, "二群 CLI 起了 sleep 300", 300_000, 1000, async () => { const tr = await treeOf(sc.data, t2.id, S2); return tr?.target ? tr : null; });
    const got1 = await waitFor(sc, "一群任务建好、CLI 起了 sleep 200", 300_000, 1000, async () => {
      const t = (await call("tasks.list", { roomId: g1.id }, true)).tasks[0];
      if (!t) return null;
      const tr = await treeOf(sc.data, t.id, S1);
      return tr?.target ? { t, tr } : null;
    });
    const tr2now = (await treeOf(sc.data, t2.id, S2)) ?? tr2;
    const tr1 = got1.tr;
    t1Id = got1.t.id;
    const v1 = await call("tasks.get", { taskId: got1.t.id }, true);
    const v2 = await call("tasks.get", { taskId: t2.id }, true);
    t1States.push(v1.state);
    sc.step("一群进程树", [`CLI ${short(tr1.cli)}`, ...tr1.desc.map((r) => `后代 ${short(r)}`)].join(" | "));
    sc.step("二群进程树", [`CLI ${short(tr2now.cli)}`, ...tr2now.desc.map((r) => `后代 ${short(r)}`)].join(" | "));
    const g1Pids = [tr1.cli.pid, ...tr1.desc.map((r) => r.pid)];
    const g2Pids = [tr2now.cli.pid, ...tr2now.desc.map((r) => r.pid)];
    tracked.push(...g1Pids, ...g2Pids);
    sc.check("A5-01", "两件长任务都确实已起:二群 sleep 300、一群 sleep 200 各是自己 CLI 的后代,两件都在跑", !!tr1.target && !!tr2now.target && v1.state === "T3_Running" && v2.state === "T3_Running",
      `一群 ${v1.id} ${v1.state} sleep ${tr1.target ? short(tr1.target) : "无"};二群 ${v2.id} ${v2.state} sleep ${tr2now.target ? short(tr2now.target) : "无"}`);
    sc.check("A5-02", "群临时槽位实际被借用:一群那件占一群的临时槽位,二群那件占个人槽位", v1.slot?.scope === "group" && v1.slot.stopping === false && v2.slot?.scope === "personal" && v2.slot.stopping === false, `一群 slot=${JSON.stringify(v1.slot)};二群 slot=${JSON.stringify(v2.slot)}`);
    const g2Before = await call("rooms.get", { roomId: g2.id }, true);
    const g2Key = JSON.stringify([g2Before.members, g2Before.leavingMembers ?? []]);
    const sleep2 = tr2now.target!.pid;
    const smp = sampler(20, async () => {
      const a = await call("tasks.get", { taskId: v1.id }, true);
      const b = await call("tasks.get", { taskId: v2.id }, true);
      const r1 = await call("rooms.get", { roomId: g1.id }, true);
      const r2 = await call("rooms.get", { roomId: g2.id }, true);
      const seen1 = g1Pids.filter((p) => killAlive(p));
      // 已归还 / 已 T10 / 已删成员时再当场看 ps 状态:僵尸算已退出(与停止确认 stillAlive 同一口径),另列一栏
      const released = a.state === "T10_Cancelled" || !a.slot || !r1.members.some((m) => m.id === x.id);
      const live1 = released ? seen1.filter((p) => aliveStrict(p)) : seen1;
      return {
        t1: a.state, slot1: a.slot ? `${a.slot.scope}${a.slot.stopping ? "/stopping" : ""}` : "", inG1: r1.members.some((m) => m.id === x.id), leavingG1: (r1.leavingMembers ?? []).some((m) => m.id === x.id),
        g1Alive: live1.length, g1AlivePids: live1.join(" "), g1Zombies: seen1.filter((p) => !live1.includes(p)).join(" "), cli1: killAlive(tr1.cli.pid),
        t2: b.state, slot2: b.slot ? `${b.slot.scope}${b.slot.stopping ? "/stopping" : ""}` : "", cli2: killAlive(tr2now.cli.pid), sleep2: killAlive(sleep2), g2Same: JSON.stringify([r2.members, r2.leavingMembers ?? []]) === g2Key,
      };
    });
    await sleep(100);
    const stopAt = Date.now();
    const leaving = await call("rooms.removeMember", { roomId: g1.id, member: { kind: "contact", id: x.id }, stopTasks: true });
    const again = await call("rooms.removeMember", { roomId: g1.id, member: { kind: "contact", id: x.id }, stopTasks: true });
    sc.check("A5-03", "移出进入「移出中」:leavingMembers 有 X,X 仍是成员", (leaving.leavingMembers ?? []).some((m) => m.id === x.id) && leaving.members.some((m) => m.id === x.id), `members=${JSON.stringify(leaving.members)} leaving=${JSON.stringify(leaving.leavingMembers)}`);
    const cmd = await attempt("messages.send", { roomId: g1.id, clientActionId: "a5-a2", text: "/task 再做一件", command: { name: "task", args: { contact: x.id, what: "再做一件" } } });
    const msg = await call("messages.send", { roomId: g1.id, clientActionId: "a5-a3", text: "@小克 在吗?帮我再开一个 Compute 跑 echo hi", mentions: at(x.id) });
    const stillLeaving = ((await call("rooms.get", { roomId: g1.id }, true)).leavingMembers ?? []).some((m) => m.id === x.id);
    sc.check("A5-05", "移出中接新活被拒:一群里 /task 交给 X 返回 conflict", !cmd.ok && cmd.error.code === "conflict" && stillLeaving, `${cmd.ok ? "ok(未被拒)" : `${cmd.error.code} ${cmd.error.message}`};发送时仍在移出中=${stillLeaving}`);
    let timedOut = false;
    try {
      await waitFor(sc, "一群任务 T10、X 被删出一群", 60_000, 20, async () => {
        const t = await call("tasks.get", { taskId: v1.id }, true);
        const r = await call("rooms.get", { roomId: g1.id }, true);
        return t.state === "T10_Cancelled" && !r.members.some((m) => m.id === x.id);
      });
    } catch (e) {
      timedOut = true;
      sc.step("移出停稳超时", errText(e));
    }
    await sleep(300);
    await smp.stop();
    samples = smp.rows.map((r) => ({ ...r, t_ms: r.at - stopAt }));
    sc.writeCsv("samples.csv", samples);
    const progress1 = (await call("tasks.progress", { taskId: v1.id, limit: 500 }, true)).progress;
    const stops = progress1.filter((p) => p.kind === "stopped").length;
    sc.check("A5-04", "重复移出不重复发停止:第二次 removeMember 原样返回移出中,一群那件只进一次 T9、只有一次 stopped", (again.leavingMembers ?? []).some((m) => m.id === x.id) && t1States.filter((st) => st === "T9_StopRequested").length === 1 && stops === 1,
      `第二次返回 leaving=${JSON.stringify(again.leavingMembers)};一群任务状态序列 ${t1States.join(">")};stopped 进度 ${stops} 条`);
    const first = (pred: (r: (typeof smp.rows)[number]) => boolean) => { const r = smp.rows.find((y) => y.at >= stopAt && pred(y)); return r ? r.at - stopAt : null; };
    const g = gaps(smp.rows);
    sc.step("时间线(毫秒,相对移出请求)", `一群 CLI 退出 ${first((r) => !r.cli1)};一群全部进程退出 ${first((r) => r.g1Alive === 0)};T10 ${first((r) => r.t1 === "T10_Cancelled")};临时槽位归还 ${first((r) => r.slot1 === "")};X 删出一群 ${first((r) => !r.inG1)};采样 ${g.n} 次,间隔中位 ${g.median} 最大 ${g.max}`);
    const released = smp.rows.filter((r) => r.at >= stopAt && (r.t1 === "T10_Cancelled" || r.slot1 === "" || !r.inG1));
    const bad = released.filter((r) => r.g1Alive > 0);
    const badNow = [...new Set(bad.flatMap((r) => r.g1AlivePids.split(" ").map(Number)))].filter((p) => aliveStrict(p));
    sc.check("A5-07", "一群进程没停稳之前:任务不落 T10、临时槽位不归还、X 不被删出", bad.length === 0, bad.length ? `${bad.length} 次采样违例,此刻仍非僵尸 ${badNow.join(",") || "无"};例 ${JSON.stringify(bad[0])}` : `归还/删成员之后的 ${released.length} 次采样里一群进程全部已退出`);
    const window = smp.rows.filter((r) => r.t1 === "T9_StopRequested" && r.slot1 === "group/stopping" && r.inG1 && r.leavingG1 && r.g1Alive > 0);
    sc.check("A5-08", "停稳窗口被采到:T9、一群临时槽位停止中、X 仍在并标移出中、进程还在", window.length > 0, `${window.length} 次采样`);
    const fin1 = await call("tasks.get", { taskId: v1.id }, true);
    const r1 = await call("rooms.get", { roomId: g1.id }, true);
    const left1 = g1Pids.filter((p) => aliveStrict(p));
    sc.check("A5-09", "停稳后才删成员、归还临时槽位,60 秒内完成(超时即失败)", !timedOut && fin1.state === "T10_Cancelled" && fin1.slot === null && !r1.members.some((m) => m.id === x.id) && (r1.leavingMembers ?? []).length === 0 && left1.length === 0,
      `state=${fin1.state} slot=${JSON.stringify(fin1.slot)} members=${JSON.stringify(r1.members)} leaving=${JSON.stringify(r1.leavingMembers)} 一群进程还活着 ${left1.join(",") || "无"};超时=${timedOut}`);
    const after = (await call("messages.list", { roomId: g1.id, afterSeq: msg.seq, limit: 500 }, true)).messages.filter((m) => m.sender.kind === "contact" && m.sender.id === x.id);
    const g1Tasks = (await call("tasks.list", { roomId: g1.id }, true)).tasks;
    sc.check("A5-06", "移出中一群的新消息不再派给 X:@X 之后 X 在一群没有发言、没有新任务", stillLeaving && after.length === 0 && g1Tasks.length === 1, `那条消息 #${msg.seq} 发送时仍在移出中=${stillLeaving};之后 X 在一群的发言 ${after.length} 条;一群任务 ${g1Tasks.length} 个`);
    const off2 = smp.rows.filter((r) => r.t2 !== "T3_Running" || r.slot2 !== "personal" || !r.cli2 || !r.sleep2 || !r.g2Same);
    sc.check("A5-10", "别群不误伤:一群移出全过程中二群那件一直在跑、个人槽位不变、CLI 与 sleep 300 都在、二群成员不变", off2.length === 0, off2.length ? `${off2.length} 次采样违例,例 ${JSON.stringify(off2[0])}` : `${smp.rows.length} 次采样全部正常`);
    sc.check("A5-06b", "采样密度约 20 毫秒", g.n >= 10 && g.median <= 60, `采样 ${g.n} 次(每次 4 个 service 读),间隔中位 ${g.median} 毫秒、最大 ${g.max} 毫秒`);
    // 收尾:取消二群那件并确认停稳
    const c2 = Date.now();
    await call("tasks.cancel", { taskId: v2.id, clientActionId: "a5-cancel2" });
    let t2Out = false;
    try {
      await waitFor(sc, "二群任务 T10", 60_000, 50, async () => (await call("tasks.get", { taskId: v2.id }, true)).state === "T10_Cancelled");
    } catch (e) {
      t2Out = true;
      sc.step("二群停止超时", errText(e));
    }
    const fin2 = await call("tasks.get", { taskId: v2.id }, true);
    const left2 = g2Pids.filter((p) => aliveStrict(p));
    sc.check("A5-11", "最后取消二群那件:停稳后 T10、个人槽位归还", !t2Out && fin2.state === "T10_Cancelled" && fin2.slot === null && left2.length === 0, `${Date.now() - c2} 毫秒;state=${fin2.state} slot=${JSON.stringify(fin2.slot)} 二群进程还活着 ${left2.join(",") || "无"}`);
  } catch (e) {
    sc.check("A5-ERR", "场景执行没有异常或超时", false, errText(e));
  } finally {
    off();
    await finish(sc, s, tracked, () => dumpViews(sc, s));
  }
  return writeResult(sc, { samples: samples.length });
}

// ---------------------------------------------------------------- A3 在途纠正
async function a3(): Promise<boolean> {
  const sc = scenario("a3");
  sc.step(`场景 a3 开始:代码 ${COMMIT}${DIRTY ? "(工作区有未提交改动)" : ""};startServer mind=pi compute=claude;说话与 Compute 模型 ${MODEL}`);
  const s = await startServer({ dataDir: sc.data, mind: "pi", compute: "claude", env: ENV, onReport: sc.onReport });
  const off = s.service.subscribe(sc.onEvent);
  const { call } = caller(s, sc);
  const tracked: number[] = [];
  const timeline: { at: number; content: string }[] = [];
  const taskTimeline: Record<string, unknown>[] = [];
  let watching = true;
  let watcher: Promise<void> = Promise.resolve();
  try {
    const x = await call("contacts.create", { clientActionId: "a3-x", name: "小克" });
    const g = await call("rooms.createGroup", { clientActionId: "a3-g", title: "纠正群", members: [{ kind: "contact", id: x.id }] });
    const SLEEP = /^(\S*\/)?sleep 90$/;
    const src = await call("messages.send", { roomId: g.id, clientActionId: "a3-u1", text: "@小克 帮我开一个 Compute:先用 Bash 工具在前台运行命令 sleep 90(调用时把 timeout 参数设为 600000,不要放后台、不要加 &),等它结束后,在它的当前工作目录写文件 color.txt,内容只有一行 RED。写好后读回核对,再汇报完成。", mentions: at(x.id) });
    const got = await waitFor(sc, "任务建好、Compute 第一轮在跑 sleep 90", 300_000, 1000, async () => {
      const t = (await call("tasks.list", { roomId: g.id }, true)).tasks[0];
      if (!t) return null;
      const tr = await treeOf(sc.data, t.id, SLEEP);
      return tr?.target ? { t, tr } : null;
    });
    const taskId = got.t.id;
    const v1 = await call("tasks.get", { taskId }, true);
    const computeId = v1.computeRuns[0]?.computeId ?? "";
    tracked.push(got.tr.cli.pid, ...got.tr.desc.map((r) => r.pid));
    sc.step("第一轮在跑", `任务 ${taskId} ${v1.state} constraintVersion=${v1.constraintVersion} computeId=${computeId};CLI ${short(got.tr.cli)};sleep ${short(got.tr.target!)}`);
    const file = path.join(sc.data, "compute", taskId, "color.txt");
    watcher = (async () => {
      let last = "<无文件>";
      let lastTask = "";
      timeline.push({ at: Date.now(), content: last });
      while (watching) {
        const c = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "<无文件>";
        if (c !== last) { timeline.push({ at: Date.now(), content: c }); sc.step("color.txt 变化", JSON.stringify(c)); last = c; }
        // 观察(不作断言):任务状态、条件版本、槽位、Compute 个数的变化,写进 task-timeline.csv
        const t = await call("tasks.get", { taskId }, true);
        const row = { state: t.state, constraintVersion: t.constraintVersion, slot: t.slot ? `${t.slot.scope}${t.slot.stopping ? "/stopping" : ""}` : "", computes: t.computeRuns.length, deliveredSeq: t.deliveredSeq ?? "" };
        const key = JSON.stringify(row);
        if (key !== lastTask) { taskTimeline.push({ at: Date.now(), ...row }); lastTask = key; }
        await sleep(200);
      }
    })();
    const corrAt = Date.now();
    const corr = await call("messages.send", { roomId: g.id, clientActionId: "a3-u2", text: "@小克 改一下条件:color.txt 的内容改成 BLUE,不要 RED,其它不变。", mentions: at(x.id) });
    sc.step("用户改条件", `#${corr.seq}`);
    const amended = await waitFor(sc, "联系人转交补充、任务条件升版", 240_000, 300, async () => {
      const t = await call("tasks.get", { taskId }, true);
      return t.constraintVersion > v1.constraintVersion ? { t, at: Date.now(), sleepAlive: killAlive(got.tr.target!.pid), cliAlive: killAlive(got.tr.cli.pid) } : null;
    });
    const link = (amended.t.followUps ?? []).find((f) => f.roomId === g.id && f.seq === corr.seq);
    sc.check("A3-01", "联系人 forward 带 sourceSeq:用户改条件那条消息挂到任务上,任务 constraintVersion 升版", amended.t.constraintVersion === v1.constraintVersion + 1 && link !== undefined && link.version === amended.t.constraintVersion,
      `改条件 #${corr.seq} 后 ${amended.at - corrAt} 毫秒升版 v${v1.constraintVersion}→v${amended.t.constraintVersion};followUps 里 #${corr.seq}=${JSON.stringify(link)}`);
    sc.check("A3-02", "改条件时 Compute 第一轮还在跑(在途纠正)", amended.sleepAlive || amended.cliAlive, `升版时 sleep 90 还活着=${amended.sleepAlive},CLI 还活着=${amended.cliAlive}`);
    const delivered = await waitFor(sc, "按新条件交付(T8a)", 600_000, 1000, async () => {
      const t = await call("tasks.get", { taskId }, true);
      return t.deliveredSeq != null && t.state === "T8a_Delivered" ? t : ["T10_Cancelled", "T11_Failed", "T8_Accepted"].includes(t.state) ? t : null;
    });
    await sleep(1500);
    watching = false;
    await watcher;
    sc.writeCsv("file-timeline.csv", timeline.map((r) => ({ t_ms: r.at - corrAt, content: r.content })));
    const runs = (await call("runs.list", { roomId: g.id, limit: 500 }, true)).runs.filter((r) => r.layer === "compute-turn" && r.computeId === computeId).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    const turns = runs.map((r) => `${r.id} ${r.status} ${r.startedAt}→${r.endedAt ?? "…"}`);
    sc.step("同一 Compute 的轮次", turns.join(" | "));
    const firstEnd = runs[0]?.endedAt ? Date.parse(runs[0].endedAt) : Number.NaN;
    const secondStart = runs[1] ? Date.parse(runs[1].startedAt) : Number.NaN;
    sc.check("A3-03", "补充排队到这一轮结束后再续接:升版发生在第一轮结束前,第二轮在第一轮结束之后才开始", runs.length >= 2 && amended.at < firstEnd && secondStart >= firstEnd,
      `compute-turn ${runs.length} 轮;升版 ${new Date(amended.at).toISOString()};第一轮结束 ${runs[0]?.endedAt};第二轮开始 ${runs[1]?.startedAt}`);
    const ids = [...new Set(delivered.computeRuns.map((r) => r.computeId))];
    sc.check("A3-04", "续接的是同一个 computeId,没有新开 Compute", ids.length === 1 && ids[0] === computeId, `任务的 Compute:${ids.join(",")};派活时 ${computeId}`);
    const seen = timeline.map((r) => r.content);
    const redAt = seen.indexOf("RED");
    const blueAt = seen.lastIndexOf("BLUE");
    sc.check("A3-05", "产物按新条件变化:color.txt 先按旧条件是 RED,续接后变成 BLUE", redAt >= 0 && blueAt > redAt && seen.at(-1) === "BLUE", `文件内容序列 ${JSON.stringify(seen)}`);
    const art = delivered.artifacts.find((a) => a.name === "color.txt" || a.name.endsWith("/color.txt"));
    const got2 = art ? await call("artifacts.get", { ref: art.ref }, true) : null;
    const disk = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    const sha = createHash("sha256").update(disk).digest("hex");
    const applied = (delivered.followUps ?? []).find((f) => f.seq === corr.seq);
    sc.check("A3-06", "交付依据新版本:补充 Applied 且 appliedVersion == constraintVersion;交付工件 color.txt 经 artifacts.get 读回是 BLUE、hash 与磁盘一致",
      delivered.state === "T8a_Delivered" && applied?.state === "Applied" && applied.appliedVersion === delivered.constraintVersion && got2 !== null && got2.sha256 === sha && got2.text?.trim() === "BLUE" && art?.sha256 === sha,
      `state=${delivered.state} constraintVersion=${delivered.constraintVersion} 补充=${JSON.stringify(applied)};工件 ${art ? `${art.ref} ${art.sha256}` : "无"};artifacts.get ${got2 ? `${got2.bytes}B ${got2.sha256} ${JSON.stringify(got2.text)}` : "无"};磁盘 ${sha}`);
    // 交付是普通消息:本人普通回复「通过」(回复交付消息、@ 联系人),联系人转成 verdict
    const ok = await call("messages.send", { roomId: g.id, clientActionId: "a3-u3", text: "@小克 通过", replyToSeq: delivered.deliveredSeq!, mentions: at(x.id) });
    const accepted = await waitFor(sc, "本人回复「通过」后经联系人 verdict 到 T8", 240_000, 1000, async () => {
      const t = await call("tasks.get", { taskId }, true);
      return ["T8_Accepted", "T10_Cancelled", "T11_Failed"].includes(t.state) ? t : null;
    }).catch((e: unknown) => { sc.step("等 T8 超时", errText(e)); return null; });
    sc.check("A3-07", "本人普通回复「通过」经联系人 verdict 验到 T8", accepted?.state === "T8_Accepted", `「通过」#${ok.seq} 回复交付 #${delivered.deliveredSeq};最终 ${accepted?.state ?? "超时未到"} reviewGate=${accepted?.reviewGate}`);
    // resultVer 来自宿主的 follow 文档(SQLite 只读):交付时依据的版本 == 当前条件版本
    const db = new DatabaseSync(path.join(sc.data, "gg.db"), { readOnly: true });
    const row = db.prepare("SELECT value FROM docs WHERE key = ?").get(`follow:${taskId}`) as { value?: string } | undefined;
    db.close();
    const follow = row?.value ? (JSON.parse(row.value) as { resultVer?: number | null; rounds?: number[] }) : null;
    sc.check("A3-08", "交付时 resultVer == constraintVersion(宿主 follow 文档)", follow?.resultVer === delivered.constraintVersion, `follow:${taskId} resultVer=${follow?.resultVer} rounds=${JSON.stringify(follow?.rounds)};constraintVersion=${delivered.constraintVersion}`);
    sc.step("派活来源", `#${src.seq}`);
  } catch (e) {
    sc.check("A3-ERR", "场景执行没有异常或超时", false, errText(e));
  } finally {
    watching = false;
    await watcher;
    sc.writeCsv("task-timeline.csv", taskTimeline.map((r) => ({ ...r, at: new Date(r.at as number).toISOString() })));
    off();
    const rows = await psTable();
    for (const c of myClis(rows)) tracked.push(...descendants(c.pid, rows).map((r) => r.pid));
    await finish(sc, s, tracked, () => dumpViews(sc, s));
  }
  return writeResult(sc, { fileTimeline: timeline.length });
}

// ---------------------------------------------------------------- 入口
const order = whichArg === "all" ? ["a4", "a5", "a3"] : [whichArg];
const results: Record<string, boolean> = {};
for (const name of order) results[name] = name === "a4" ? await a4() : name === "a5" ? await a5() : await a3();
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ commit: COMMIT, dirty: DIRTY, model: MODEL, results }, null, 2));
const allPass = Object.values(results).every(Boolean);
console.log(`总结果:${JSON.stringify(results)} → ${allPass ? "全部通过" : "有失败"}`);
process.exit(allPass ? 0 : 1);
