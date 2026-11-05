// Claude Code Compute 适配器:把 brief 变成一次真实的 CLI 子进程,把它的 stream-json 与 report_progress 映射成语义事件。
//
// 停止语义对齐 mirasim 0.0.774(g-group#2309),见 procgroup.ts:stop 对进程组 SIGTERM 后立即产出 stopped(scope:"process-group"),
// reapForceMs 后组 SIGKILL;不追脱离进程组的后代。内核不得把 stopped 当作执行树已静止。
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { allowedTools, cliArgs, cliEnv, firstPrompt, toolOverreach } from "./cli.ts";
import { type AcceptedReport, streamParser, type Terminal, terminalFor } from "./events.ts";
import { groupAlive, IS_WINDOWS, signalGroup } from "./procgroup.ts";
import type { AdapterOptions, Brief, ClaudeRunner, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, Refusal, RejectedReport, SpawnOptions } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });
/** 默认 SIGTERM → SIGKILL 的间隔,对应 mirasim 的 MIRASIM_REAP_FORCE_MS 默认值 */
export const DEFAULT_REAP_FORCE_MS = 10_000;

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
  /** 已对进程组发过 SIGTERM,升级计时已开始 */
  reaping: boolean;
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
  readonly dir: string;
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
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 所有 Compute 共享的事件流:每个迭代器从头按顺序读,不丢事件 */
function eventHub() {
  const log: ComputeEvent[] = [];
  let wake: (() => void)[] = [];
  return {
    push(e: ComputeEvent) {
      log.push(Object.freeze(e));
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
  const runner = options.runner ?? DEFAULT_RUNNER;
  const reapForceMs = options.reapForceMs ?? DEFAULT_REAP_FORCE_MS;
  const server = options.reportServer ?? { command: process.execPath, args: [REPORT_MCP_PATH] };
  const hub = eventHub();
  const computes = new Map<string, ComputeState>();

  function emit(round: Round, e: ComputeEvent) {
    round.events.push(e);
    hub.push(e);
  }

  /** 对进程组 SIGTERM;reapForceMs 后组里还有进程就 SIGKILL(mirasim 的做法)。不等待,也不确认进程树为空 */
  function reap(round: Round) {
    if (round.reaping) return;
    round.reaping = true;
    signalGroup(round.pid, "SIGTERM");
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (!groupAlive(round.pid)) { clearInterval(timer); return; }
      if (Date.now() - t0 >= reapForceMs) { signalGroup(round.pid, "SIGKILL"); clearInterval(timer); }
    }, Math.min(100, Math.max(10, Math.floor(reapForceMs / 10))));
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
      // 受理 blocked 后机械地停在受阻:只对进程组发 SIGSTOP 冻结(不多发别的信号)。之后的任何汇报与 result 都不处理,
      // 直到宿主显式 resume(先 SIGKILL 冻结的进程组再用同一 CLI 会话号续接)或 stop
      round.pausedBlocked = true;
      round.halted = true;
      signalGroup(round.pid, "SIGSTOP");
      round.terminal = "paused-blocked";
      round.finished = true;
      round.markPaused();
    }
  }

  function onLine(st: ComputeState, round: Round, parse: ReturnType<typeof streamParser>, line: string, resumed: boolean, setResult: (r: { success: boolean; text: string }) => void) {
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
      // 必须先收到可校验的 init 才算进入运行(RR-02)
      if (!round.initOk) { violate(round, "CLI 在 init 之前输出了汇报或结果"); return; }
      if (s.type === "report") absorb(st, round, s.report);
      else if (s.type === "invalid-report" || s.type === "rejected-report") {
        const reason = s.type === "invalid-report" ? s.errors.join(";") : s.reason;
        const rec = Object.freeze({ kind: s.kind, reason });
        st.rejected.push(rec);
        if (s.kind === "blocked" || s.kind === "failed") st.unresolved = [...st.unresolved, rec];
      } else setResult({ success: s.success, text: s.text });
    }
  }

  function launch(st: ComputeState, prompt: string, resumeSession: string | undefined): void {
    const mcpConfig = path.join(st.dir, "mcp.json");
    const args = [...(runner.args ?? []), ...cliArgs(st.brief, prompt, mcpConfig, resumeSession)];
    // POSIX 上 detached:CLI 自成进程组,stop 与收尾对整组发信号;Windows 不 detached(与 mirasim 一致)
    const child = spawnChild(runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, options.hostEnv), stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS });
    let finish: (evs: readonly ComputeEvent[]) => void = () => {};
    let markPaused: () => void = () => {};
    const paused = new Promise<void>((r) => { markPaused = r; });
    const round: Round = {
      events: [], done: new Promise((r) => { finish = r; }), paused, markPaused: () => markPaused(),
      pid: child.pid, child, exited: false, finished: false, terminal: null,
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
      // 收尾(mirasim 的做法):CLI 退出后对进程组 SIGTERM,reapForceMs 后仍有进程就 SIGKILL;终态立即产出,不等孙进程
      reap(round);
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
      round.exited = true;
      finish([...round.events]);
    })();
  }

  return {
    async spawn(brief: unknown, opts: SpawnOptions = {}) {
      const b = checkBrief(brief);
      if (!b.ok) return b;
      if (b.brief.placement !== "local") return refuse(`本适配器只在本机运行,不支持 ${b.brief.placement}`);
      let handoff: HandoffSnapshot | undefined;
      if (opts.handoff !== undefined) {
        const h = checkSnapshot(opts.handoff);
        if (!h.ok) return h;
        handoff = h.snapshot;
      }
      const id = `cc-${crypto.randomUUID()}`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g-group-cc-"));
      fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { host: { command: server.command, args: [...(server.args ?? [])], env: {} } } }));
      const { prompt, sections } = firstPrompt(b.brief, handoff);
      const st: ComputeState = {
        id, brief: b.brief, dir, cwd: opts.cwd ?? process.cwd(), sessionId: null, round: null,
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
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      const prev = st.round;
      if (prev && !prev.exited && prev.terminal === "paused-blocked") {
        // 停在受阻的上一轮进程组还冻结着:宿主显式续接时先 SIGKILL 它,等主进程退出再续,避免两个 CLI 占同一会话
        signalGroup(prev.pid, "SIGKILL");
        await prev.done;
      }
      if (!st.round?.exited) return refuse("这个 Compute 还在运行,等它结束这一轮再续");
      if (!st.sessionId) return refuse("上一轮没有拿到 CLI 会话号,无法续接");
      if (!text.trim()) return refuse("续接的内容不能为空");
      // 宿主显式续接即解除上一轮被拒收的受阻/放弃(RR-01)
      st.unresolved = [];
      launch(st, text, st.sessionId);
      return { ok: true };
    },

    async stop(computeId: string) {
      const st = computes.get(computeId);
      const round = st?.round;
      if (!st || !round) return refuse(`未知的 Compute ${computeId}`);
      if (round.finished && round.terminal !== "paused-blocked") return refuse(`Compute ${computeId} 没有在运行的进程`);
      const frozen = round.terminal === "paused-blocked" && !round.exited;
      round.stopRequested = true;
      // mirasim 的做法:对进程组 SIGTERM,立即把这一轮标为已停止,不等进程退出;reapForceMs 后组 SIGKILL
      reap(round);
      // 停在受阻的进程组被 SIGSTOP 冻结着,挂起的 SIGTERM 要 SIGCONT 后才生效
      if (frozen) signalGroup(round.pid, "SIGCONT");
      round.terminal = "stopped";
      round.finished = true;
      emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null, scope: "process-group", violations: [...round.violations] });
      return { ok: true };
    },

    events: () => hub.iterate(),

    async settled(computeId: string) {
      const round = computes.get(computeId)?.round;
      // 主进程退出,或停在受阻(进程被冻结、不会退出)时返回;每次给当前的事件列表,停在受阻后被 stop 时 stopped 追加在后面
      return round ? Promise.race([round.done, round.paused]).then(() => Object.freeze([...round.events])) : [];
    },

    rejectedReports(computeId: string) {
      return Object.freeze([...(computes.get(computeId)?.rejected ?? [])]);
    },

    snapshot(computeId: string) {
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
