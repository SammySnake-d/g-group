import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { realpathSync } from "node:fs";
import type { ComputeEvent, QuiesceResult, TurnModel } from "@g-group/kernel/compute";
import { createProcessCleanup, type ProcessCleanup } from "@g-group/process-tools";
export type ProtocolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export interface CodexProtocolOptions {
  readonly runner: { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> };
  readonly cwd: string;
  readonly configDir: string;
  readonly models: Readonly<Record<string, readonly string[]>>;
  readonly timeoutMs?: number;
}
export interface CodexComputeProtocol {
  initialize(): Promise<ProtocolResult<{ readonly codexHome: string }>>;
  startThread(turn: TurnModel, tools?: readonly string[]): Promise<ProtocolResult<{ readonly threadId: string }>>;
  resumeThread(threadId: string, turn: TurnModel, tools?: readonly string[]): Promise<ProtocolResult<{ readonly threadId: string }>>;
  startTurn(threadId: string, text: string, turn: TurnModel, tools?: readonly string[]): Promise<ProtocolResult<{ readonly turnId: string }>>;
  steer(threadId: string, expectedTurnId: string, text: string): Promise<ProtocolResult<{ readonly turnId: string }>>;
  interrupt(threadId: string, turnId: string): Promise<ProtocolResult<{ readonly status: "interrupted" }>>;
  settled(threadId: string, turnId: string): Promise<ProtocolResult<ComputeEvent>>;
  events(): AsyncIterable<ComputeEvent>;
  quiesce(timeoutMs?: number): Promise<QuiesceResult>;
}
const no = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** Native wire bookkeeping only. Codex owns sessions, turns, history and persistence. */
export function createCodexComputeProtocol(options: CodexProtocolOptions): CodexComputeProtocol {
  const timeout = options.timeoutMs ?? 10000;
  let child: ChildProcessWithoutNullStreams | null = null;
  let cleanup: ProcessCleanup | null = null;
  let initialized = false;
  let sequence = 0;
  const pending = new Map<string, { finish: (r: ProtocolResult<Record<string, unknown>>) => void; timer: NodeJS.Timeout }>();
  const failPending = (reason: string) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.finish(no(reason)); }
    pending.clear();
  };
  function send(message: Record<string, unknown>) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try { child.stdin.write(JSON.stringify(message) + "\n"); return true; } catch { return false; }
  }
  function request(method: string, params: Record<string, unknown>): Promise<ProtocolResult<Record<string, unknown>>> {
    const id = `g-group-codex-${++sequence}`;
    return new Promise((finish) => {
      const timer = setTimeout(() => { pending.delete(id); finish(no("native request timeout")); }, timeout);
      pending.set(id, { finish, timer });
      if (!send({ id, method, params })) { pending.delete(id); clearTimeout(timer); finish(no("native process unavailable")); }
    });
  }
  function launch() {
    if (child) return;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...options.runner.env, HOME: options.configDir, CODEX_HOME: options.configDir };
    child = spawn(options.runner.command, [...(options.runner.args ?? [])], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: "pipe" });
    cleanup = createProcessCleanup(child); cleanup.capture();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      cleanup?.capture();
      try {
        const msg: unknown = JSON.parse(line);
        if (!record(msg) || typeof msg.id !== "string") return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        p.finish(record(msg.result) ? { ok: true, value: msg.result } : no("native RPC rejected"));
      } catch { failPending("invalid native JSON"); }
    });
    child.stderr.resume();
    child.once("exit", () => failPending("native process exited"));
    child.once("error", () => failPending("native process failed to start"));
    child.stdin.on("error", () => failPending("native stdin closed"));
  }
  const client: CodexComputeProtocol = {
    async initialize() {
      if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.configDir)) return no("cwd/configDir must be absolute");
      launch();
      const r = await request("initialize", { clientInfo: { name: "g-group-codex-protocol", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      if (!r.ok) return r;
      if (typeof r.value.codexHome !== "string" || realpathSync(r.value.codexHome) !== realpathSync(options.configDir)) return no("native config owner mismatch");
      if (!send({ method: "initialized", params: {} })) return no("initialized write failed");
      initialized = true;
      return { ok: true, value: { codexHome: r.value.codexHome } };
    },
    async startThread(turn) {
      if (!initialized) return no("initialize first");
      const r = await request("thread/start", { model: turn.model, cwd: options.cwd, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
      if (!r.ok) return r;
      if (!record(r.value.thread) || typeof r.value.thread.id !== "string") return no("invalid native thread id");
      return { ok: true, value: { threadId: r.value.thread.id } };
    },
    resumeThread: async () => no("not implemented"),
    startTurn: async () => no("not implemented"),
    steer: async () => no("not implemented"),
    interrupt: async () => no("not implemented"),
    settled: async () => no("not implemented"),
    events: async function* () {},
    async quiesce(timeoutMs = 5000) {
      if (!cleanup || !child) return { ok: true, killed: 0 };
      cleanup.capture(); child.stdin.end();
      const timer = setTimeout(() => cleanup?.requestStop(50), timeoutMs); timer.unref();
      const r = await cleanup.quiesce(timeoutMs, timeoutMs + 500); clearTimeout(timer); return r;
    },
  };
  return client;
}
