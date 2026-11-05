// Claude Code Compute 适配器:把 brief 变成一次真实的 CLI 子进程,把它的 stream-json 与 report_progress 映射成语义事件。
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { allowedTools, cliArgs, cliEnv, firstPrompt, toolOverreach } from "./cli.ts";
import { type AcceptedReport, streamParser, terminalFor } from "./events.ts";
import type { AdapterOptions, Brief, ClaudeRunner, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, Refusal, RejectedReport, SpawnOptions } from "./types.ts";

export const REPORT_MCP_PATH = fileURLToPath(new URL("../mcp/report-mcp.mjs", import.meta.url));
export const DEFAULT_RUNNER: ClaudeRunner = Object.freeze({ command: "claude", args: Object.freeze([]) });

interface Round {
  readonly events: ComputeEvent[];
  readonly done: Promise<readonly ComputeEvent[]>;
  child: ChildProcess | null;
  /** CLI 自己的进程组号(detached 启动,组号 = CLI 的 pid);整棵进程树都在这个组里 */
  readonly pgid: number | undefined;
  stopRequested: boolean;
  fault: string | undefined;
  reportedFailure: string | undefined;
  /** 被拒收、尚未被合法汇报接替的 blocked/failed:Compute 想说"没完成",不能当完成 */
  rejectedStop: string | undefined;
}

interface ComputeState {
  readonly id: string;
  readonly brief: Brief;
  readonly dir: string;
  readonly cwd: string;
  sessionId: string | null;
  round: Round | null;
  blockedOpen: boolean;
  constraintVer: unknown;
  openQuestions: readonly string[];
  doneSideEffects: string[];
  readonly rejected: RejectedReport[];
}

const refuse = (reason: string): Refusal => ({ ok: false, reason });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 进程组里是否还有进程(POSIX:kill(-pgid, 0)) */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
function signalGroup(pgid: number | undefined, sig: NodeJS.Signals): void {
  if (pgid === undefined) return;
  try { process.kill(-pgid, sig); } catch { /* 组已退空 */ }
}
/** 把进程组收干净:先 SIGTERM,过了宽限期 SIGKILL;返回组是否已退空 */
async function reapGroup(pgid: number | undefined, graceMs: number): Promise<boolean> {
  if (pgid === undefined || !groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  const t0 = Date.now();
  let killed = false;
  while (groupAlive(pgid)) {
    if (!killed && Date.now() - t0 >= graceMs) { signalGroup(pgid, "SIGKILL"); killed = true; }
    if (Date.now() - t0 >= graceMs + 5000) return false;
    await delay(20);
  }
  return true;
}

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
  const hub = eventHub();
  const computes = new Map<string, ComputeState>();

  function emit(round: Round, e: ComputeEvent) {
    round.events.push(e);
    hub.push(e);
  }

  function absorb(st: ComputeState, round: Round, r: AcceptedReport) {
    if (r.constraintVer !== undefined) st.constraintVer = r.constraintVer;
    if (r.openQuestions !== undefined) st.openQuestions = Object.freeze([...r.openQuestions]);
    if (r.doneSideEffects !== undefined) for (const x of r.doneSideEffects) if (!st.doneSideEffects.includes(x)) st.doneSideEffects.push(x);
    if (r.kind === "blocked" || r.kind === "failed" || r.kind === "completed") round.rejectedStop = undefined;
    if (r.kind === "milestone" && r.stage !== undefined) {
      st.blockedOpen = false;
      emit(round, { computeId: st.id, kind: "milestone", stage: r.stage, summary: r.summary });
    }
    if (r.kind === "blocked" && r.needs !== undefined) {
      st.blockedOpen = true;
      emit(round, { computeId: st.id, kind: "blocked", needs: r.needs, summary: r.summary });
    }
    if (r.kind === "failed") round.reportedFailure = r.summary;
  }

  function launch(st: ComputeState, prompt: string, resumeSession: string | undefined): void {
    const mcpConfig = path.join(st.dir, "mcp.json");
    const args = [...(runner.args ?? []), ...cliArgs(st.brief, prompt, mcpConfig, resumeSession)];
    // detached:CLI 自成进程组,它起的 MCP 服务器、Bash 子进程等后代都在这个组里,stop 与收尾按组回收(F-03)
    const child = spawnChild(runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, options.hostEnv), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let finish: (evs: readonly ComputeEvent[]) => void = () => {};
    const round: Round = {
      events: [], done: new Promise((r) => { finish = r; }), child, pgid: child.pid, stopRequested: false,
      fault: undefined, reportedFailure: undefined, rejectedStop: undefined,
    };
    st.round = round;
    st.blockedOpen = false;
    const parse = streamParser();
    let result: { success: boolean; text: string } | undefined;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
    const stdoutClosed = new Promise<void>((r) => {
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        for (const s of parse(line)) {
          if (s.type === "init") {
            st.sessionId = s.sessionId;
            emit(round, { computeId: st.id, kind: "started", sessionId: s.sessionId, resumed: resumeSession !== undefined });
            // 以 CLI 自报的实际挂载清单为准核对授权:超出 brief 的工具一出现就终止整个进程组(F-01)
            const over = toolOverreach(st.brief, s.tools);
            if (over.length && round.fault === undefined) {
              round.fault = `CLI 实际挂载了 brief 未授权的工具 ${over.join(", ")}`;
              void reapGroup(round.pgid, grace);
            }
          } else if (s.type === "report") absorb(st, round, s.report);
          else if (s.type === "invalid-report" || s.type === "rejected-report") {
            const reason = s.type === "invalid-report" ? s.errors.join(";") : s.reason;
            st.rejected.push(Object.freeze({ kind: s.kind, reason }));
            // Compute 想报"受阻/放弃"却被拒收:在它按 schema 重报之前,这一轮不能当完成
            if (s.kind === "blocked" || s.kind === "failed") round.rejectedStop = reason;
          } else result = { success: s.success, text: s.text };
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
      // CLI 退出不等于这一轮停了:组里残留的后代一并回收,组退空之后才产出终态
      const empty = await reapGroup(round.pgid, grace);
      if (!empty && round.fault === undefined) round.fault = `进程组 ${round.pgid} 在 SIGKILL 后仍有进程`;
      await Promise.race([stdoutClosed, delay(2000)]);
      round.child = null;
      const reportedFailure = round.reportedFailure ?? (round.rejectedStop !== undefined ? `汇报被拒收且没有重报:${round.rejectedStop}` : undefined);
      const terminal = terminalFor(exit, result, {
        stopRequested: round.stopRequested,
        ...(round.fault !== undefined ? { fault: round.fault } : {}),
        ...(reportedFailure !== undefined ? { reportedFailure } : {}),
      }, stderr.trim().split("\n").slice(-3).join(" | "));
      if (terminal.kind === "completed") {
        if (!st.blockedOpen) emit(round, { computeId: st.id, ...terminal });
      } else emit(round, { computeId: st.id, ...terminal });
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
      fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { host: { command: process.execPath, args: [REPORT_MCP_PATH], env: {} } } }));
      const { prompt, sections } = firstPrompt(b.brief, handoff);
      const st: ComputeState = {
        id, brief: b.brief, dir, cwd: opts.cwd ?? process.cwd(), sessionId: null, round: null, blockedOpen: false,
        constraintVer: handoff?.constraintVer, openQuestions: handoff?.openQuestions ?? [], doneSideEffects: [...(handoff?.doneSideEffects ?? [])],
        rejected: [],
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
      if (st.round?.child) return refuse("这个 Compute 还在运行,等它结束这一轮再续");
      if (!st.sessionId) return refuse("上一轮没有拿到 CLI 会话号,无法续接");
      if (!text.trim()) return refuse("续接的内容不能为空");
      launch(st, text, st.sessionId);
      return { ok: true };
    },

    async stop(computeId: string) {
      const st = computes.get(computeId);
      const round = st?.round;
      if (!st || !round?.child) return refuse(`Compute ${computeId} 没有在运行的进程`);
      round.stopRequested = true;
      // 整个进程组:SIGTERM,宽限期后 SIGKILL;终态(stopped)由收尾在组退空之后产出
      await reapGroup(round.pgid, grace);
      await round.done;
      return { ok: true };
    },

    events: () => hub.iterate(),

    async settled(computeId: string) {
      const round = computes.get(computeId)?.round;
      return round ? round.done : [];
    },

    rejectedReports(computeId: string) {
      return Object.freeze([...(computes.get(computeId)?.rejected ?? [])]);
    },

    snapshot(computeId: string) {
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      return checkSnapshot({ constraintVer: st.constraintVer, openQuestions: [...st.openQuestions], doneSideEffects: [...st.doneSideEffects] });
    },
  };
}
