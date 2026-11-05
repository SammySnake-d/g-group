// Claude Code Compute 适配器:把 brief 变成一次真实的 CLI 子进程,把它的 stream-json 与 report_progress 映射成语义事件。
//
// 停止语义(RR-03):stopped 只保证这一轮的**已知后代树**已经不存在(scope: "descendant-tree"),见 proctree.ts。
// 双 fork 后被 init/launchd 收养的守护进程不在范围内;内核不得把 stopped 当作容器级静止,完全隔离归 cloud_sandbox/容器。
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
import { DescendantTree } from "./proctree.ts";
import type { AdapterOptions, Brief, ClaudeRunner, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, Refusal, RejectedReport, SpawnOptions } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });
/** 运行期间多久采样一次后代树:后代脱离进程组(setsid)后,只有趁它的父进程还在时按 ppid 才找得到 */
const SAMPLE_MS = 200;
/** SIGKILL 之后最多再等多久确认后代树为空 */
const HARD_MS = 2000;

interface Round {
  readonly events: ComputeEvent[];
  readonly done: Promise<readonly ComputeEvent[]>;
  readonly tree: DescendantTree;
  child: ChildProcess | null;
  /** 进程退出、后代树处理完、终态已定 */
  finished: boolean;
  terminal: Terminal["kind"] | null;
  treeClean: boolean;
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
  const grace = options.stopGraceMs ?? 3000;
  const server = options.reportServer ?? { command: process.execPath, args: [REPORT_MCP_PATH] };
  const hub = eventHub();
  const computes = new Map<string, ComputeState>();

  function emit(round: Round, e: ComputeEvent) {
    round.events.push(e);
    hub.push(e);
  }

  /** 违规:记下来(可审计),停止处理这一轮的输出并回收后代树 */
  function violate(round: Round, msg: string) {
    round.violations.push(msg);
    if (round.halted) return;
    round.halted = true;
    void round.tree.reap(grace, HARD_MS);
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
      // 受理 blocked 后机械地停在受阻:先 SIGSTOP 冻结整棵后代树,再 SIGKILL 回收。之后的任何汇报与 result 都不处理,
      // 直到宿主显式 resume(用同一 CLI 会话号续接)或 stop
      round.pausedBlocked = true;
      round.halted = true;
      void round.tree.freezeAndReap(HARD_MS);
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
        void round.tree.sample();
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
    // detached:CLI 自成进程组;另外运行期间按 ppid 采样后代树,脱离进程组(setsid)的后代也能找到
    const child = spawnChild(runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, options.hostEnv), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let finish: (evs: readonly ComputeEvent[]) => void = () => {};
    const round: Round = {
      events: [], done: new Promise((r) => { finish = r; }), tree: new DescendantTree(child.pid ?? -1, options.procLister),
      child, finished: false, terminal: null, treeClean: false, stopRequested: false, initOk: false, halted: false,
      pausedBlocked: false, violations: [], reportedFailure: undefined,
    };
    st.round = round;
    const parse = streamParser();
    let result: { success: boolean; text: string } | undefined;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    const sampler = setInterval(() => { void round.tree.sample(); }, SAMPLE_MS);
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
      clearInterval(sampler);
      await Promise.race([stdoutClosed, delay(2000)]);
      // CLI 退出不等于这一轮停了:已知后代树(含脱组的后代)一并回收,确认为空之后才定终态
      round.treeClean = await round.tree.reap(grace, HARD_MS);
      round.child = null;
      if (!round.initOk && round.violations.length === 0) round.violations.push("CLI 没有输出可校验的 init");
      const terminal = terminalFor(exit, result, {
        stopRequested: round.stopRequested, treeClean: round.treeClean, violations: round.violations,
        pausedBlocked: round.pausedBlocked, unresolved: st.unresolved.map((u) => `${String(u.kind)}:${u.reason}`),
        ...(round.reportedFailure !== undefined ? { reportedFailure: round.reportedFailure } : {}),
      }, stderr.trim().split("\n").slice(-3).join(" | "));
      round.terminal = terminal.kind;
      if (terminal.kind !== "paused-blocked") emit(round, { computeId: st.id, ...terminal });
      round.finished = true;
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
      if (!st.round?.finished) return refuse("这个 Compute 还在运行,等它结束这一轮再续");
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
      if (round.finished && round.terminal === "paused-blocked") {
        // 停在受阻的这一轮进程早已回收、后代树已确认为空,直接结束
        round.terminal = "stopped";
        emit(round, { computeId: st.id, kind: "stopped", code: null, signal: null, scope: "descendant-tree", violations: [...round.violations] });
        return { ok: true };
      }
      if (round.finished) return refuse(`Compute ${computeId} 没有在运行的进程`);
      round.stopRequested = true;
      // 整棵已知后代树:先 SIGTERM,宽限期后 SIGKILL;stopped 由收尾在后代树确认为空之后产出
      await round.tree.reap(grace, HARD_MS);
      await round.done;
      return { ok: true };
    },

    events: () => hub.iterate(),

    async settled(computeId: string) {
      const round = computes.get(computeId)?.round;
      // 每次给当前的事件列表:停在受阻后被 stop 时,stopped 是在这一轮 done 之后追加的
      return round ? round.done.then(() => Object.freeze([...round.events])) : [];
    },

    rejectedReports(computeId: string) {
      return Object.freeze([...(computes.get(computeId)?.rejected ?? [])]);
    },

    snapshot(computeId: string) {
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      // 最终交接快照只在终态且后代树确认为空之后给出(RR-04)
      const r = st.round;
      const terminal = r?.terminal === "stopped" || r?.terminal === "completed" || r?.terminal === "failed";
      if (!r?.finished || !terminal || !r.treeClean) return refuse("not-quiescent");
      return checkSnapshot({ constraintVer: st.constraintVer, openQuestions: [...st.openQuestions], doneSideEffects: [...st.doneSideEffects] });
    },
  };
}
