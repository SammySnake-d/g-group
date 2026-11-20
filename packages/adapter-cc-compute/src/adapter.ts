// 停止语义对照 mirasim 0.0.774 server-main.cjs 的 z2(child,{graceMs:0,group:true})(g-group#2309),见 procgroup.ts:
// 磁盘(g-group#2900,原则 67):每轮在 os.tmpdir() 建 g-group-cc-* 放 mcp.json,CLI 主进程退出时删掉,谁建谁清。
// 落败的 resume 立即被明确拒绝;等冻结的上一轮退出之后重新核对这一轮有没有被 stop,stop 确认之后不再起新的 CLI。
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { allowedTools, cliArgs, cliEnv } from "./cli.ts";
import { type AcceptedReport, activityOf, preInitFrame, streamParser, type Terminal, terminalFor } from "./events.ts";
import { type Isolation, NO_ISOLATION, checkInitIsolation, isolationOf, mcpConfigFor, promptWithSkills } from "./isolation.ts";
import { freezeDeep, isPlainRecord, plainData } from "./plain.ts";
import { IS_WINDOWS, signalGroup } from "./procgroup.ts";
import { createProcessCleanup, type ProcessCleanup } from "@g-group/process-tools";
import type { AdapterOptions, Brief, ClaudeRunner, ComputeActivity, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, QuiesceResult, Refusal, RejectedReport } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });
export const DEFAULT_REAP_FORCE_MS = 10_000;

export function resolveReapForceMs(explicit: number | undefined, env: string | undefined): number {
  if (explicit !== undefined && !(typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0)) throw new TypeError("reapForceMs 必须是非负有限数");
  if (env !== undefined && typeof env !== "string") throw new TypeError("MIRASIM_REAP_FORCE_MS 必须是字符串");
  if (explicit !== undefined) return explicit;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REAP_FORCE_MS;
}

type Command = { readonly command: string; readonly args?: readonly string[] };
interface Config {
  readonly runner: Command;
  readonly hostEnv: Readonly<Record<string, string>> | undefined;
  readonly reapForceMs: number | undefined;
  readonly server: Command;
}
const OPTION_KEYS: readonly string[] = Object.freeze(["runner", "hostEnv", "reapForceMs", "reportServer"]);
const SPAWN_KEYS: readonly string[] = Object.freeze(["handoff", "cwd", "configDir", "pluginDirs", "mcpServers"]);
const isStrArr = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

function commandOf(x: unknown, name: string): Command | undefined {
  if (x === undefined) return undefined;
  if (!isPlainRecord(x) || typeof x.command !== "string" || !x.command || Object.keys(x).some((k) => k !== "command" && k !== "args") || (x.args !== undefined && !isStrArr(x.args))) {
    throw new TypeError(`适配器选项 ${name} 必须是 {command: 非空字符串, args?: 字符串数组}`);
  }
  return x as Command;
}

function adapterConfig(options: unknown): Config {
  const p = plainData(options, "适配器选项");
  if (!p.ok) throw new TypeError(`适配器选项必须是纯数据:${p.path} ${p.why}`);
  const o = p.value;
  if (!isPlainRecord(o)) throw new TypeError("适配器选项必须是对象");
  const extra = Object.keys(o).filter((k) => !OPTION_KEYS.includes(k));
  if (extra.length) throw new TypeError(`适配器选项只收 ${OPTION_KEYS.join("/")},拒绝 ${extra.join(", ")}`);
  const { hostEnv, reapForceMs } = o;
  if (hostEnv !== undefined && !(isPlainRecord(hostEnv) && Object.values(hostEnv).every((v) => typeof v === "string"))) throw new TypeError("适配器选项 hostEnv 必须是字符串到字符串的对象");
  if (reapForceMs !== undefined && !(typeof reapForceMs === "number" && reapForceMs >= 0)) throw new TypeError("适配器选项 reapForceMs 必须是非负有限数");
  return {
    runner: commandOf(o.runner, "runner") ?? DEFAULT_RUNNER,
    hostEnv: hostEnv as Readonly<Record<string, string>> | undefined,
    reapForceMs: reapForceMs as number | undefined,
    server: commandOf(o.reportServer, "reportServer") ?? { command: process.execPath, args: [REPORT_MCP_PATH] },
  };
}

type SpawnParsed = { readonly ok: true; readonly handoff: HandoffSnapshot | undefined; readonly cwd: string | undefined; readonly iso: Isolation };

function spawnOptions(opts: unknown): SpawnParsed | Refusal {
  if (opts === undefined) return { ok: true, handoff: undefined, cwd: undefined, iso: NO_ISOLATION };
  const p = plainData(opts, "spawn 选项");
  if (!p.ok) return refuse(`spawn 选项必须是纯数据:${p.path} ${p.why}`);
  const o = p.value;
  if (!isPlainRecord(o)) return refuse("spawn 选项必须是对象");
  const extra = Object.keys(o).filter((k) => !SPAWN_KEYS.includes(k));
  if (extra.length) return refuse(`spawn 选项只收 ${SPAWN_KEYS.join("/")},拒绝 ${extra.join(", ")}`);
  if (o.cwd !== undefined && (typeof o.cwd !== "string" || !o.cwd)) return refuse("spawn 选项 cwd 必须是非空字符串");
  const iso = isolationOf(o);
  if (typeof iso === "string") return refuse(iso);
  if (o.handoff === undefined) return { ok: true, handoff: undefined, cwd: o.cwd as string | undefined, iso };
  const h = checkSnapshot(o.handoff);
  if (!h.ok) return h;
  return { ok: true, handoff: h.snapshot, cwd: o.cwd as string | undefined, iso };
}

interface Round {
  readonly events: ComputeEvent[];
  readonly done: Promise<readonly ComputeEvent[]>;
  readonly pid: number | undefined;
  child: ChildProcess | null;
  exited: boolean;
  finished: boolean;
  /** 已受理 blocked、进程组已被 SIGSTOP 冻结时 resolve(冻结的进程不会退出,settled 不能只等 done) */
  readonly paused: Promise<void>;
  markPaused: () => void;
  terminal: Terminal["kind"] | null;
  reaping: boolean;
  readonly proc: ChildProcess;
  stopRequested: boolean;
  initOk: boolean;
  /** 已受理 blocked 或判定违规后不再处理这一轮的输出 */
  halted: boolean;
  pausedBlocked: boolean;
  readonly violations: string[];
  reportedFailure: string | undefined;
  /** 停止时按进程表记下的后代与同组成员(AC-23 停止确认要逐个确认它们退出);null 表示停止时读不到进程表 */
  cleanup: ProcessCleanup;
}

interface ComputeState {
  readonly id: string;
  brief: Brief;
  readonly cwd: string;
  /** 勾选能力(AC-29),每一轮(含续接)都按它起 CLI */
  readonly iso: Isolation;
  sessionId: string | null;
  round: Round | null;
  constraintVer: unknown;
  openQuestions: readonly string[];
  doneSideEffects: string[];
  readonly rejected: RejectedReport[];
  /** 被拒收、还没有同种合规重报或宿主解除的 blocked/failed 实例(RR-01) */
  unresolved: RejectedReport[];
  resuming: boolean;
}

const refuse = (reason: string): Refusal => ({ ok: false, reason });
/** 事件的浅层副本,数组字段(violations)另拷一份,不和本轮内部状态共用 */
const eventCopy = (e: ComputeEvent): ComputeEvent => {
  const out: Record<string, unknown> = { ...e };
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = [...v];
  return out as ComputeEvent;
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errorText = (err: unknown): string => (err instanceof Error && typeof err.message === "string" ? err.message : "非 Error 异常");

/** 所有 Compute 共享的事件流:每个迭代器从头按顺序读,不丢事件 */
function eventHub() {
  const log: ComputeEvent[] = [];
  let wake: (() => void)[] = [];
  return {
    push(e: ComputeEvent) {
      log.push(e);
      const w = wake;
      wake = [];
      for (const f of w) f();
    },
    async *iterate(): AsyncGenerator<ComputeEvent> {
      let i = 0;
      for (;;) {
        while (i < log.length) yield log[i++]!;
        await new Promise<void>((r) => wake.push(r));
      }
    },
  };
}

export function activityHub() {
  const subs = new Set<{ queue: ComputeActivity[]; wake: (() => void) | null }>();
  return {
    push(a: ComputeActivity) {
      for (const s of subs) {
        if (s.queue.length < 10_000) s.queue.push(a);
        const w = s.wake;
        s.wake = null;
        w?.();
      }
    },
    async *iterate(): AsyncGenerator<ComputeActivity> {
      const s: { queue: ComputeActivity[]; wake: (() => void) | null } = { queue: [], wake: null };
      subs.add(s);
      try {
        for (;;) {
          while (s.queue.length) yield s.queue.shift()!;
          await new Promise<void>((r) => { s.wake = r; });
        }
      } finally {
        subs.delete(s);
      }
    },
  };
}

export function createComputeAdapter(options: AdapterOptions = {}): ComputeAdapter {
  const cfg = adapterConfig(options);
  const runner = cfg.runner;
  const server = cfg.server;
  const hub = eventHub();
  const acts = activityHub();
  const computes = new Map<string, ComputeState>();

  function emit(round: Round, e: ComputeEvent) {
    const snapshot = freezeDeep(eventCopy(e));
    round.events.push(snapshot);
    hub.push(snapshot);
  }

  /** mirasim z2(graceMs:0, group:true) 的 POSIX 路径:主进程已退出就什么都不做;否则 SIGTERM 只发主进程,
   *  reapForceMs 后主进程仍未退出就对进程组 SIGKILL;主进程先退出则取消。不等待,也不确认进程树为空 */
  function reap(round: Round) {
    if (round.reaping) return;
    round.reaping = true;
    round.cleanup.requestStop(resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS));
  }

  function violate(round: Round, msg: string) {
    round.violations.push(msg);
    if (round.halted) return;
    round.halted = true;
    reap(round);
  }

  function absorb(st: ComputeState, round: Round, r: AcceptedReport) {
    if (r.constraintVer !== undefined) st.constraintVer = r.constraintVer;
    if (r.openQuestions !== undefined) st.openQuestions = Object.freeze([...r.openQuestions]);
    if (r.doneSideEffects !== undefined) for (const x of r.doneSideEffects) if (!st.doneSideEffects.includes(x)) st.doneSideEffects.push(x);
    // 只有同种的合规重报才解除被拒收的 blocked/failed(RR-01);completed、started 等别的种类不算
    if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);
    if (r.kind === "milestone" && r.stage !== undefined) emit(round, { computeId: st.id, kind: "milestone", stage: r.stage, summary: r.summary });
    if (r.kind === "failed") round.reportedFailure = r.summary;
    if (r.kind === "blocked" && r.needs !== undefined) {
      emit(round, { computeId: st.id, kind: "blocked", needs: r.needs, summary: r.summary, ...(r.attachments !== undefined ? { attachments: Object.freeze([...r.attachments]) } : {}) });
      round.pausedBlocked = true;
      round.halted = true;
      signalGroup(round.pid, "SIGSTOP");
      round.terminal = "paused-blocked";
      round.finished = true;
      round.markPaused();
    }
  }

  function onLine(st: ComputeState, round: Round, parse: ReturnType<typeof streamParser>, line: string, resumed: boolean, setResult: (r: { success: boolean; text: string }) => void) {
    if (round.halted) return;
    if (!round.initOk) {
      const pre = preInitFrame(line);
      if (pre.kind === "allowed") return;
      if (pre.kind === "rejected") { violate(round, `CLI 在 init 之前输出了未认可的内容:${pre.reason}`); return; }
    }
    for (const s of parse(line)) {
      if (round.halted) return;
      if (s.type === "init" || s.type === "bad-init") {
        if (round.initOk) { violate(round, "CLI 输出了第二个 init"); return; }
        if (s.type === "bad-init") { violate(round, `CLI 的 init 无法核验:${s.reason}`); return; }
        // 以 CLI 自报的实际挂载清单核对授权与勾选能力(F-01、AC-29,isolation.ts):越出 brief 的工具、未勾选的 MCP、勾选的没连上,一出现就回收
        const iso = checkInitIsolation(st.brief, st.iso, s.tools, line);
        if (!iso.ok) { violate(round, iso.reason); return; }
        round.initOk = true;
        st.sessionId = s.sessionId;
        emit(round, { computeId: st.id, kind: "started", sessionId: s.sessionId, resumed, loaded: iso.loaded });
        continue;
      }
      if (s.type === "report") absorb(st, round, s.report);
      else if (s.type === "invalid-report" || s.type === "rejected-report") {
        const reason = s.type === "invalid-report" ? s.errors.join(";") : s.reason;
        const rec = freezeDeep({ kind: structuredClone(s.kind), reason });
        st.rejected.push(rec);
        if (s.kind === "blocked" || s.kind === "failed") st.unresolved = [...st.unresolved, rec];
      } else setResult({ success: s.success, text: s.text });
    }
  }

  function launch(st: ComputeState, prompt: string, resumeSession: string | undefined): void {
    // 每轮一个临时目录放 mcp.json;CLI 主进程退出时删掉(磁盘谁建谁清,g-group#2900)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g-group-cc-"));
    const removeDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响终态 */ } };
    const mcpConfig = path.join(dir, "mcp.json");
    let child: ChildProcess;
    try {
      fs.writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor(st.iso, server)));
      const args = [...(runner.args ?? []), ...cliArgs(st.brief, prompt, mcpConfig, resumeSession, { pluginDirs: [...st.iso.pluginDirs], mcpServers: Object.keys(st.iso.mcpServers) })];
      child = spawnChild(runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, cfg.hostEnv, st.iso.configDir), stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS });
    } catch (err) {
      removeDir();
      throw err;
    }
    let finish: (evs: readonly ComputeEvent[]) => void = () => {};
    let markPaused: () => void = () => {};
    const paused = new Promise<void>((r) => { markPaused = r; });
    const round: Round = {
      events: [], done: new Promise((r) => { finish = r; }), paused, markPaused: () => markPaused(),
      pid: child.pid, child, proc: child, exited: false, finished: false, terminal: null,
      reaping: false, stopRequested: false, initOk: false, halted: false, pausedBlocked: false, violations: [], reportedFailure: undefined, cleanup: createProcessCleanup(child),
    };
    st.round = round;
    const parse = streamParser();
    let result: { success: boolean; text: string } | undefined;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    const stdoutClosed = new Promise<void>((r) => {
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        try {
          onLine(st, round, parse, line, resumeSession !== undefined, (x) => { result = x; });
        } catch (err) {
          violate(round, `处理 CLI 输出时出错:${errorText(err)}`);
        }
        if (round.initOk && !round.halted) {
          try {
            for (const a of activityOf(line)) acts.push(Object.freeze({ computeId: st.id, ...a }) as ComputeActivity);
          } catch { /* 活动只是计时依据 */ }
        }
      });
      rl.on("close", () => r());
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      child.on("exit", (code, signal) => r({ code, signal }));
      child.on("error", (err) => { stderr = `${stderr}${err.message}`; r({ code: null, signal: null }); });
    });
    void (async () => {
      const exit = await exited;
      await Promise.race([stdoutClosed, delay(2000)]);
      round.child = null;
      if (!round.finished) {
        if (!round.initOk && round.violations.length === 0) round.violations.push("CLI 没有输出可校验的 init");
        const terminal = terminalFor(exit, result, {
          stopRequested: round.stopRequested, violations: round.violations, pausedBlocked: round.pausedBlocked,
          unresolved: st.unresolved.map((u) => `${String(u.kind)}:${u.reason}`),
          ...(round.reportedFailure !== undefined ? { reportedFailure: round.reportedFailure } : {}),
        }, stderr.trim().split("\n").slice(-3).join(" | "));
        round.terminal = terminal.kind;
        if (terminal.kind !== "paused-blocked") emit(round, { computeId: st.id, ...terminal });
        round.finished = true;
      }
      removeDir();
      round.exited = true;
      finish([...round.events]);
    })();
  }

  return {
    async spawn(brief: unknown, opts?: unknown) {
      const b = checkBrief(brief);
      if (!b.ok) return b;
      if (b.brief.placement !== "local") return refuse(`本适配器只在本机运行,不支持 ${b.brief.placement}`);
      const o = spawnOptions(opts);
      if (!o.ok) return o;
      const handoff = o.handoff;
      const id = `cc-${crypto.randomUUID()}`;
      // 勾选 skill(AC-29):--bare 下没有 Skill 工具,在首个提示里列出可用 skill 与 SKILL.md 路径
      const { prompt, sections } = promptWithSkills(b.brief, handoff, o.iso.pluginDirs);
      const st: ComputeState = {
        id, brief: b.brief, cwd: o.cwd ?? process.cwd(), iso: o.iso, sessionId: null, round: null,
        constraintVer: handoff?.constraintVer, openQuestions: handoff?.openQuestions ?? [], doneSideEffects: [...(handoff?.doneSideEffects ?? [])],
        rejected: [], unresolved: [], resuming: false,
      };
      computes.set(id, st);
      const manifest: Manifest = Object.freeze({
        computeId: id, sections: Object.freeze(sections), allowedTools: Object.freeze([...allowedTools(b.brief, Object.keys(o.iso.mcpServers))]),
        credentialRefs: b.brief.credentialRefs, placement: b.brief.placement,
        mcpServers: Object.freeze(Object.keys(o.iso.mcpServers)), pluginDirs: Object.freeze([...o.iso.pluginDirs]), configDir: o.iso.configDir ?? null,
      });
      launch(st, prompt, undefined);
      return { ok: true, computeId: id, manifest };
    },

    async resume(computeId: string, text: string, _turn?: unknown, opts?: unknown) {
      // 状态参数也是外部输入:不是字符串就拒收,不做任何隐式转换(toString/toPrimitive 不调用)
      if (typeof computeId !== "string" || typeof text !== "string") return refuse("computeId 与续接内容必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      // 先校验输入与前置条件,任何信号和状态变更都在校验之后(R3-02)
      if (!text.trim()) return refuse("续接的内容不能为空");
      let nextBrief: Brief | null = null;
      if (opts !== undefined) {
        const o = plainData(opts, "续接选项");
        if (!o.ok || !isPlainRecord(o.value)) return refuse("续接选项必须是纯数据对象");
        const extra = Object.keys(o.value).filter((k) => k !== "tools");
        if (extra.length) return refuse(`续接选项只认 tools,多了 ${extra.join(", ")}`);
        if (o.value.tools !== undefined) {
          const b = checkBrief({ ...st.brief, tools: o.value.tools });
          if (!b.ok) return refuse(`续接的工具清单不合格:${b.reason}`);
          nextBrief = b.brief;
        }
      }
      if (!st.sessionId) return refuse("上一轮没有拿到 CLI 会话号,无法续接");
      if (st.resuming) return refuse("这个 Compute 正在续接,同一时刻只受理一个续接");
      const prev = st.round;
      const frozen = prev !== null && !prev.exited && prev.terminal === "paused-blocked";
      if (!frozen && !prev?.exited) return refuse("这个 Compute 还在运行,等它结束这一轮再续");
      if (frozen) {
        st.resuming = true;
        try {
          // 停在受阻的上一轮进程组还冻结着:先 SIGKILL 它,等主进程退出再续,避免两个 CLI 占同一会话(非 mirasim 对照项)
          signalGroup(prev.pid, "SIGKILL");
          await prev.done;
        } finally {
          st.resuming = false;
        }
        // 跨过 await 重新核对(R7-01):等待期间这一轮被 stop 了,这次续接作废,stop 确认之后不再起新的 CLI
        if (prev.stopRequested) return refuse("续接还没启动时这个 Compute 已被停止,这次续接作废");
      }
      // 宿主显式续接即解除上一轮被拒收的受阻/放弃(RR-01)
      st.unresolved = [];
      if (nextBrief) st.brief = nextBrief;
      launch(st, text, st.sessionId);
      return { ok: true };
    },

    async stop(computeId: string) {
      if (typeof computeId !== "string") return refuse("computeId 必须是字符串");
      const st = computes.get(computeId);
      const round = st?.round;
      if (!st || !round) return refuse(`未知的 Compute ${computeId}`);
      if (round.finished && round.terminal !== "paused-blocked") return refuse(`Compute ${computeId} 没有在运行的进程`);
      const frozen = round.terminal === "paused-blocked" && !round.exited;
      round.stopRequested = true;
      // 停止确认要用(AC-23):发信号之前记下主进程的后代与同组成员,主进程退出后它们会被过继,事后按父子链就找不到了
      round.cleanup.capture();
      // 封存这一轮(R3-01):stopped 之后的任何 stdout/tool_result 都不再产事件、改状态或发信号
      round.halted = true;
      if (frozen) signalGroup(round.pid, "SIGKILL");
      else reap(round);
      round.terminal = "stopped";
      round.finished = true;
      emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [...round.violations] });
      return { ok: true };
    },

    events: () => hub.iterate(),

    activity: () => acts.iterate(),

    async settled(computeId: string) {
      if (typeof computeId !== "string") return [];
      const round = computes.get(computeId)?.round;
      return round ? Promise.race([round.done, round.paused]).then(() => Object.freeze([...round.events])) : [];
    },

    async quiesce(computeId: string, timeoutMs = 5000): Promise<QuiesceResult> {
      if (typeof computeId !== "string") return { ok: false, reason: "computeId 必须是字符串", remaining: [] };
      if (typeof timeoutMs !== "number" || !(timeoutMs >= 0)) return { ok: false, reason: "timeoutMs 必须是非负数", remaining: [] };
      const round = computes.get(computeId)?.round;
      if (!round) return { ok: false, reason: `未知的 Compute ${computeId}`, remaining: [] };
      if (!round.finished || (round.terminal === "paused-blocked" && !round.stopRequested)) return { ok: false, reason: "这一轮还没结束(运行中或停在受阻),先停止", remaining: [] };
      const pid = round.pid;
      const limit = resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS) + timeoutMs;
      round.cleanup.capture();
      let timer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([round.done.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), limit); timer.unref(); })]);
      clearTimeout(timer);
      if (!exited) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };
      if (IS_WINDOWS || pid === undefined) return { ok: true, killed: 0 };
      return round.cleanup.quiesce(timeoutMs, limit);
    },

    rejectedReports(computeId: string) {
      if (typeof computeId !== "string") return Object.freeze([]);
      return Object.freeze([...(computes.get(computeId)?.rejected ?? [])]);
    },

    snapshot(computeId: string) {
      if (typeof computeId !== "string") return refuse("computeId 必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      // 最终交接快照只在终态且 CLI 主进程已退出之后给出(RR-04);脱离进程组的后代不在检查范围内
      const r = st.round;
      const terminal = r?.terminal === "stopped" || r?.terminal === "completed" || r?.terminal === "failed";
      if (!r?.exited || !terminal) return refuse("not-quiescent");
      return checkSnapshot({ constraintVer: st.constraintVer, openQuestions: [...st.openQuestions], doneSideEffects: [...st.doneSideEffects] });
    },
  };
}
