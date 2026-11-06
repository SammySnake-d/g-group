// Claude Code Compute 适配器:把 brief 变成一次真实的 CLI 子进程,把它的 stream-json 与 report_progress 映射成语义事件。
//
// 停止语义对照 mirasim 0.0.774 server-main.cjs 的 z2(child,{graceMs:0,group:true})(g-group#2309),见 procgroup.ts:
// POSIX 上初始 SIGTERM 只发给 CLI 主进程(z2 的 MLe:child.kill);reapForceMs 后主进程仍未退出才对进程组 SIGKILL(k2 → FG);
// 主进程先退出就取消这次组 SIGKILL(j2);主进程已经退出时什么都不发(z2 开头的 exitCode/signalCode 判断)。
// stopped 立即产出,scope:"main-then-group"。内核不得把 stopped 当作执行树已静止。
// reapForceMs 未显式给出时按 mirasim 的 Ukc 在每次回收时读 MIRASIM_REAP_FORCE_MS(合法正数生效,否则 10000),显式选项优先(R4-03)。
// 外部输入(适配器选项、brief、spawn 选项与 handoff、computeId、续接文本)读取前按纯数据合同判定(plain.ts,R4-01),
// getter/setter/Proxy 不调用即拒收、不起子进程。
// 磁盘(g-group#2900,原则 67):每轮在 os.tmpdir() 建 g-group-cc-* 放 mcp.json,CLI 主进程退出时删掉,谁建谁清。
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { allowedTools, cliArgs, cliEnv, firstPrompt, toolOverreach } from "./cli.ts";
import { type AcceptedReport, preInitFrame, streamParser, type Terminal, terminalFor } from "./events.ts";
import { freezeDeep, isPlainRecord, plainData } from "./plain.ts";
import { IS_WINDOWS, signalGroup } from "./procgroup.ts";
import type { AdapterOptions, Brief, ClaudeRunner, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, Refusal, RejectedReport } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });
/** 默认 SIGTERM → SIGKILL 的间隔,对应 mirasim 的 MIRASIM_REAP_FORCE_MS 默认值(Lkc=1e4) */
export const DEFAULT_REAP_FORCE_MS = 10_000;

/** 对照 mirasim 0.0.774 z2 的 `c2.forceMs ?? Ukc()`:显式值优先;否则 Number(环境值) 是有限正数就用它,其余回落 10000。
 *  经包根导出,是外部入口(R6-01):显式值只收非负有限数字或 undefined,环境值只收字符串或 undefined,先判 typeof,
 *  对象(含 Proxy、带 toPrimitive 的对象)不做隐式转换、抛受控 TypeError */
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
const SPAWN_KEYS: readonly string[] = Object.freeze(["handoff", "cwd"]);
const isStrArr = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

/** 启动命令 {command, args?}:x 已是纯数据副本 */
function commandOf(x: unknown, name: string): Command | undefined {
  if (x === undefined) return undefined;
  if (!isPlainRecord(x) || typeof x.command !== "string" || !x.command || Object.keys(x).some((k) => k !== "command" && k !== "args") || (x.args !== undefined && !isStrArr(x.args))) {
    throw new TypeError(`适配器选项 ${name} 必须是 {command: 非空字符串, args?: 字符串数组}`);
  }
  return x as Command;
}

/** 适配器选项也是外部输入:先按纯数据合同判定(访问器、Proxy 不调用即拒收),不合格抛受控 TypeError,之后只读副本 */
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

/** spawn 选项与 handoff:同样先判纯数据,只收 handoff/cwd。未声明的字段即使值为 undefined 也拒绝;
 *  声明过的 cwd/handoff 为 undefined 时按没给处理(R5-01) */
function spawnOptions(opts: unknown): { readonly ok: true; readonly handoff: HandoffSnapshot | undefined; readonly cwd: string | undefined } | Refusal {
  if (opts === undefined) return { ok: true, handoff: undefined, cwd: undefined };
  const p = plainData(opts, "spawn 选项");
  if (!p.ok) return refuse(`spawn 选项必须是纯数据:${p.path} ${p.why}`);
  const o = p.value;
  if (!isPlainRecord(o)) return refuse("spawn 选项必须是对象");
  const extra = Object.keys(o).filter((k) => !SPAWN_KEYS.includes(k));
  if (extra.length) return refuse(`spawn 选项只收 ${SPAWN_KEYS.join("/")},拒绝 ${extra.join(", ")}`);
  if (o.cwd !== undefined && (typeof o.cwd !== "string" || !o.cwd)) return refuse("spawn 选项 cwd 必须是非空字符串");
  if (o.handoff === undefined) return { ok: true, handoff: undefined, cwd: o.cwd as string | undefined };
  const h = checkSnapshot(o.handoff);
  if (!h.ok) return h;
  return { ok: true, handoff: h.snapshot, cwd: o.cwd as string | undefined };
}

interface Round {
  readonly events: ComputeEvent[];
  /** CLI 主进程已退出、终态已产出(或停在受阻) */
  readonly done: Promise<readonly ComputeEvent[]>;
  /** CLI 的 pid,也是它的进程组号(POSIX) */
  readonly pid: number | undefined;
  child: ChildProcess | null;
  /** CLI 主进程已退出 */
  exited: boolean;
  /** 终态事件已产出,或已停在受阻 */
  finished: boolean;
  /** 已受理 blocked、进程组已被 SIGSTOP 冻结时 resolve(冻结的进程不会退出,settled 不能只等 done) */
  readonly paused: Promise<void>;
  markPaused: () => void;
  terminal: Terminal["kind"] | null;
  /** 已经走过一次 reap(对主进程 SIGTERM 并开始组 SIGKILL 计时,或主进程已退出而什么都不发) */
  reaping: boolean;
  /** CLI 主进程对象;退出后 round.child 置空,但 reap 仍要看它的 exitCode/signalCode */
  readonly proc: ChildProcess;
  stopRequested: boolean;
  initOk: boolean;
  /** 已受理 blocked 或判定违规后不再处理这一轮的输出 */
  halted: boolean;
  pausedBlocked: boolean;
  readonly violations: string[];
  reportedFailure: string | undefined;
}

interface ComputeState {
  readonly id: string;
  readonly brief: Brief;
  readonly cwd: string;
  sessionId: string | null;
  round: Round | null;
  constraintVer: unknown;
  openQuestions: readonly string[];
  doneSideEffects: string[];
  readonly rejected: RejectedReport[];
  /** 被拒收、还没有同种合规重报或宿主解除的 blocked/failed 实例(RR-01) */
  unresolved: RejectedReport[];
}

const refuse = (reason: string): Refusal => ({ ok: false, reason });
/** 事件的浅层副本,数组字段(violations)另拷一份,不和本轮内部状态共用 */
const eventCopy = (e: ComputeEvent): ComputeEvent => {
  const out: Record<string, unknown> = { ...e };
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = [...v];
  return out as ComputeEvent;
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export function createComputeAdapter(options: AdapterOptions = {}): ComputeAdapter {
  const cfg = adapterConfig(options);
  const runner = cfg.runner;
  const server = cfg.server;
  const hub = eventHub();
  const computes = new Map<string, ComputeState>();

  /** 对外事件只发一份深冻结的快照(R6-02):violations 等数组是本轮记录的副本并冻结,
   *  任何一个订阅者或 settled() 的调用方都改不了其他人看到的历史 */
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
    const p = round.proc;
    const mainExited = () => p.exitCode !== null || p.signalCode !== null;
    if (mainExited()) return;
    try { p.kill("SIGTERM"); } catch { /* 已退出 */ }
    // 到期对进程组 SIGKILL(k2 → FG);主进程先退出就清掉计时器(j2),这是取消组 SIGKILL 的唯一途径。
    // 间隔与 z2 一样在每次回收时取:显式选项优先,否则读 MIRASIM_REAP_FORCE_MS(Ukc)
    const reapForceMs = resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS);
    const timer = setTimeout(() => signalGroup(round.pid, "SIGKILL"), reapForceMs);
    timer.unref();
    p.once("exit", () => clearTimeout(timer));
  }

  /** 违规:记下来(可审计),停止处理这一轮的输出并回收进程组 */
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
      emit(round, { computeId: st.id, kind: "blocked", needs: r.needs, summary: r.summary });
      // 受理 blocked 后机械地停在受阻:对进程组 SIGSTOP 冻结。这是**非 mirasim 对照项**:mirasim 0.0.774 没有暂停进程的做法
      // (源码里 SIGSTOP 只出现在一处注释,SIGCONT 没有出现)。之后的任何汇报与 result 都不处理,
      // 直到宿主显式 resume(校验通过后 SIGKILL 冻结的进程组,再用同一 CLI 会话号续接)或 stop(对冻结的进程组 SIGKILL)
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
    // init 之前每一行都要显式认可(R3-03):只放行真实 CLI 在 init 前会输出的 system 帧,其余一律违规,
    // 也不交给解析器,init 前的 tool_use 就不会被记住、在 init 之后配对生效
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
        // 以 CLI 自报的实际挂载清单核对授权:超出 brief 的工具一出现就回收(F-01)
        const over = toolOverreach(st.brief, s.tools);
        if (over.length) { violate(round, `CLI 实际挂载了 brief 未授权的工具 ${over.join(", ")}`); return; }
        round.initOk = true;
        st.sessionId = s.sessionId;
        emit(round, { computeId: st.id, kind: "started", sessionId: s.sessionId, resumed });
        continue;
      }
      if (s.type === "report") absorb(st, round, s.report);
      else if (s.type === "invalid-report" || s.type === "rejected-report") {
        const reason = s.type === "invalid-report" ? s.errors.join(";") : s.reason;
        // kind 来自 CLI 输出的 JSON,可能是数组或对象:拷贝后深冻结,rejectedReports 的读者改不了记录
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
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { host: { command: server.command, args: [...(server.args ?? [])], env: {} } } }));
      const args = [...(runner.args ?? []), ...cliArgs(st.brief, prompt, mcpConfig, resumeSession)];
      // POSIX 上 detached:CLI 自成进程组,stop 与收尾对整组发信号;Windows 不 detached(与 mirasim 一致)
      child = spawnChild(runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, cfg.hostEnv), stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS });
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
      reaping: false, stopRequested: false, initOk: false, halted: false, pausedBlocked: false, violations: [], reportedFailure: undefined,
    };
    st.round = round;
    const parse = streamParser();
    let result: { success: boolean; text: string } | undefined;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    const stdoutClosed = new Promise<void>((r) => {
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => onLine(st, round, parse, line, resumeSession !== undefined, (x) => { result = x; }));
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
      // 主进程正常退出后不发任何信号:mirasim 的 z2 在 exitCode/signalCode 已有值时直接返回,同组孙进程不被回收
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
      // brief 与选项都先按纯数据合同判定,任何访问器、Proxy 都在起进程之前不调用即拒收(R4-01)
      const b = checkBrief(brief);
      if (!b.ok) return b;
      if (b.brief.placement !== "local") return refuse(`本适配器只在本机运行,不支持 ${b.brief.placement}`);
      const o = spawnOptions(opts);
      if (!o.ok) return o;
      const handoff = o.handoff;
      const id = `cc-${crypto.randomUUID()}`;
      const { prompt, sections } = firstPrompt(b.brief, handoff);
      const st: ComputeState = {
        id, brief: b.brief, cwd: o.cwd ?? process.cwd(), sessionId: null, round: null,
        constraintVer: handoff?.constraintVer, openQuestions: handoff?.openQuestions ?? [], doneSideEffects: [...(handoff?.doneSideEffects ?? [])],
        rejected: [], unresolved: [],
      };
      computes.set(id, st);
      const manifest: Manifest = Object.freeze({
        computeId: id, sections: Object.freeze(sections), allowedTools: Object.freeze([...allowedTools(b.brief)]),
        credentialRefs: b.brief.credentialRefs, placement: b.brief.placement,
      });
      launch(st, prompt, undefined);
      return { ok: true, computeId: id, manifest };
    },

    async resume(computeId: string, text: string) {
      // 状态参数也是外部输入:不是字符串就拒收,不做任何隐式转换(toString/toPrimitive 不调用)
      if (typeof computeId !== "string" || typeof text !== "string") return refuse("computeId 与续接内容必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      // 先校验输入与前置条件,任何信号和状态变更都在校验之后(R3-02)
      if (!text.trim()) return refuse("续接的内容不能为空");
      if (!st.sessionId) return refuse("上一轮没有拿到 CLI 会话号,无法续接");
      const prev = st.round;
      const frozen = prev !== null && !prev.exited && prev.terminal === "paused-blocked";
      if (!frozen && !prev?.exited) return refuse("这个 Compute 还在运行,等它结束这一轮再续");
      if (frozen) {
        // 停在受阻的上一轮进程组还冻结着:先 SIGKILL 它,等主进程退出再续,避免两个 CLI 占同一会话(非 mirasim 对照项)
        signalGroup(prev.pid, "SIGKILL");
        await prev.done;
      }
      // 宿主显式续接即解除上一轮被拒收的受阻/放弃(RR-01)
      st.unresolved = [];
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
      // 封存这一轮(R3-01):stopped 之后的任何 stdout/tool_result 都不再产事件、改状态或发信号
      round.halted = true;
      // 冻结的进程组收不到 SIGTERM:直接对组 SIGKILL(非 mirasim 对照项);否则走 mirasim 的 z2:SIGTERM 主进程,到期组 SIGKILL
      if (frozen) signalGroup(round.pid, "SIGKILL");
      else reap(round);
      round.terminal = "stopped";
      round.finished = true;
      emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [...round.violations] });
      return { ok: true };
    },

    events: () => hub.iterate(),

    async settled(computeId: string) {
      if (typeof computeId !== "string") return [];
      const round = computes.get(computeId)?.round;
      // 主进程退出,或停在受阻(进程被冻结、不会退出)时返回;每次给当前的事件列表,停在受阻后被 stop 时 stopped 追加在后面
      return round ? Promise.race([round.done, round.paused]).then(() => Object.freeze([...round.events])) : [];
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
