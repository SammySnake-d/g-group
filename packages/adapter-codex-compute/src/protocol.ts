import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { realpathSync } from "node:fs";
import { freezeDeep, plainData, type ComputeEvent, type QuiesceResult, type TurnModel } from "@g-group/kernel/compute";
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
  const snapshot = plainData(options, "protocol options");
  if (!snapshot.ok) throw new TypeError("protocol options must be plain data");
  options = snapshot.value as unknown as CodexProtocolOptions;
  const timeout = options.timeoutMs ?? 10000;
  function capability(turn: TurnModel, tools: readonly string[] | undefined) {
    const t = plainData(tools ?? [], "requested tools");
    if (!t.ok || !Array.isArray(t.value) || t.value.length !== 0) return no("native per-tool authorization is not mapped; Host/G2 policy must not be guessed");
    const p = plainData(turn, "turn model");
    if (!p.ok || !record(p.value) || typeof p.value.model !== "string" || !Object.hasOwn(options.models, p.value.model)) return no("requested model is not in the explicit owner catalog");
    if (typeof p.value.effort !== "string" || !options.models[p.value.model]?.includes(p.value.effort)) return no("requested effort is not supported by the explicit owner catalog");
    return null;
  }
  let child: ChildProcessWithoutNullStreams | null = null;
  let cleanup: ProcessCleanup | null = null;
  let initialized = false;
  let threadId: string | null = null;
  let starting = false;
  let resumed = false;
  let closed = false;
  let wireFailure: string | null = null;
  const emitted: ComputeEvent[] = [];
  const listeners = new Set<() => void>();
  function wake() { for (const w of listeners) w(); listeners.clear(); }
  function publish(event: ComputeEvent) { emitted.push(freezeDeep(event)); wake(); }
  type Turn = { started: boolean; id: string; done: Promise<ProtocolResult<ComputeEvent>>; finish: (r: ProtocolResult<ComputeEvent>) => void; result: ProtocolResult<ComputeEvent> | null };
  const turns = new Map<string, Turn>();
  const notes: Record<string, unknown>[] = [];
  function consume(msg: Record<string, unknown>) {
    if (!["turn/completed", "turn/started"].includes(String(msg.method)) || !record(msg.params) || msg.params.threadId !== threadId || !record(msg.params.turn)) return;
    const native = msg.params.turn;
    if (typeof native.id !== "string") return;
    const turn = turns.get(native.id);
    if (!turn || turn.result) return;
    if (!turn.started) {
      turn.started = true;
      publish({ computeId: threadId!, kind: "started", sessionId: threadId!, resumed, ...(child?.pid ? { pid: child.pid } : {}) });
    }
    if (msg.method === "turn/started") return;
    if (native.status === "interrupted") {
      turn.result = { ok: true, value: { computeId: threadId!, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [] } };
      publish(turn.result.value); turn.finish(turn.result); return;
    }
    if (native.status === "failed") {
      const reason = record(native.error) && typeof native.error.message === "string" ? native.error.message : "native turn failed";
      turn.result = { ok: true, value: { computeId: threadId!, kind: "failed", reason, code: null, signal: null, violations: [] } };
      publish(turn.result.value); turn.finish(turn.result); return;
    }
    if (native.status !== "completed") return;
    const items = Array.isArray(native.items) ? native.items : [];
    const text = items.filter((i): i is Record<string, unknown> => record(i) && i.type === "agentMessage" && typeof i.text === "string").map((i) => i.text).join("\n");
    turn.result = { ok: true, value: { computeId: threadId!, kind: "completed", result: text } };
    publish(turn.result.value); turn.finish(turn.result);
  }
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
        if (!record(msg)) return;
        if (typeof msg.method === "string" && Object.hasOwn(msg, "id")) {
          send({ id: msg.id, error: { code: -32601, message: "g-group protocol slice has no Host approval authority" } }); return;
        }
        if (typeof msg.method === "string") {
          if (!["turn/started", "turn/completed"].includes(msg.method)) return;
          if (starting) {
            if (notes.length >= 64) { failPending("too many early lifecycle events"); cleanup?.requestStop(50); }
            else notes.push(msg);
          } else consume(msg);
          return;
        }
        if (typeof msg.id !== "string") return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        p.finish(record(msg.result) ? { ok: true, value: msg.result } : no("native RPC rejected"));
      } catch { wireFailure = "invalid native JSON"; failPending(wireFailure); cleanup?.requestStop(50); }
    });
    child.stderr.resume();
    child.once("close", (code, signal) => {
      failPending("native process exited");
      for (const turn of turns.values()) {
        if (turn.result) continue;
        turn.result = { ok: true, value: { computeId: threadId!, kind: "failed", reason: wireFailure ?? "native process exited before matching turn/completed", code: wireFailure ? null : code, signal: wireFailure ? null : signal, violations: [] } };
        publish(turn.result.value); turn.finish(turn.result);
      }
      closed = true; wake();
    });
    child.once("error", () => failPending("native process failed to start"));
    child.stdin.on("error", () => failPending("native stdin closed"));
  }
  const client: CodexComputeProtocol = {
    async initialize() {
      if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.configDir)) return no("cwd/configDir must be absolute");
      launch();
      const r = await request("initialize", { clientInfo: { name: "g-group-codex-protocol", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      if (!r.ok) return r;
      try {
        if (typeof r.value.codexHome !== "string" || realpathSync(r.value.codexHome) !== realpathSync(options.configDir)) return no("native config owner mismatch");
      } catch { return no("native config owner mismatch"); }
      if (!send({ method: "initialized", params: {} })) return no("initialized write failed");
      initialized = true;
      return { ok: true, value: { codexHome: r.value.codexHome } };
    },
    async startThread(turn, tools) {
      const refused = capability(turn, tools); if (refused) return refused;
      if (!initialized) return no("initialize first");
      const r = await request("thread/start", { model: turn.model, cwd: options.cwd, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
      if (!r.ok) return r;
      if (!record(r.value.thread) || typeof r.value.thread.id !== "string") return no("invalid native thread id");
      threadId = r.value.thread.id;
      return { ok: true, value: { threadId } };
    },
    async resumeThread(wantedThread, turn, tools) {
      const refused = capability(turn, tools); if (refused) return refused;
      if (!initialized || typeof wantedThread !== "string" || !wantedThread) return no("native thread id required");
      const r = await request("thread/resume", { threadId: wantedThread, model: turn.model, cwd: options.cwd, approvalPolicy: "never", sandbox: "read-only" });
      if (!r.ok) return r;
      if (!record(r.value.thread) || r.value.thread.id !== wantedThread) return no("native resumed a different thread");
      threadId = wantedThread; resumed = true;
      return { ok: true, value: { threadId } };
    },
    async startTurn(wantedThread, text, turn, tools) {
      const refused = capability(turn, tools); if (refused) return refused;
      if (wantedThread !== threadId) return no("native thread mismatch");
      if (starting || [...turns.values()].some((t) => t.result === null)) return no("native turn already active");
      if (typeof text !== "string" || !text.trim()) return no("native turn input must be nonempty text");
      starting = true;
      const r = await request("turn/start", { threadId: wantedThread, input: [{ type: "text", text, text_elements: [] }], model: turn.model, effort: turn.effort });
      if (!r.ok) { starting = false; notes.length = 0; return r; }
      if (!record(r.value.turn) || typeof r.value.turn.id !== "string") { starting = false; notes.length = 0; return no("invalid native turn id"); }
      const id = r.value.turn.id;
      let finish: Turn["finish"] = () => {};
      const done = new Promise<ProtocolResult<ComputeEvent>>((r) => { finish = r; });
      turns.set(id, { started: false, id, done, finish, result: null });
      for (const note of notes.splice(0)) consume(note);
      starting = false;
      return { ok: true, value: { turnId: id } };
    },
    async steer(wantedThread, expectedTurnId, text) {
      const active = turns.get(expectedTurnId);
      if (wantedThread !== threadId || !active || active.result || typeof text !== "string" || !text.trim()) return no("no matching active native turn");
      const r = await request("turn/steer", { threadId: wantedThread, expectedTurnId, input: [{ type: "text", text, text_elements: [] }] });
      if (!r.ok) return r;
      if (r.value.turnId !== expectedTurnId) return no("native steer acknowledged a different turn");
      return { ok: true, value: { turnId: expectedTurnId } };
    },
    async interrupt(wantedThread, turnId) {
      const turn = turns.get(turnId);
      if (wantedThread !== threadId || !turn || turn.result) return no("no matching active native turn");
      const r = await request("turn/interrupt", { threadId: wantedThread, turnId });
      if (!r.ok) return r;
      let timer: NodeJS.Timeout | undefined;
      const terminal = await Promise.race([turn.done, new Promise<ProtocolResult<ComputeEvent>>((r) => { timer = setTimeout(() => r(no("native interrupt not confirmed")), timeout); })]);
      clearTimeout(timer);
      return terminal.ok && terminal.value.kind === "stopped" ? { ok: true, value: { status: "interrupted" } } : no("native interrupt not confirmed");
    },
    async settled(wantedThread, turnId) {
      if (wantedThread !== threadId || !turns.has(turnId)) return no("native turn mismatch");
      return turns.get(turnId)!.done;
    },
    events: async function* () {
      let index = 0;
      for (;;) {
        while (index < emitted.length) yield emitted[index++]!;
        if (closed) return;
        await new Promise<void>((r) => listeners.add(r));
      }
    },
    async quiesce(timeoutMs = 5000) {
      if (!cleanup || !child) return { ok: true, killed: 0 };
      cleanup.capture(); child.stdin.end();
      const timer = setTimeout(() => cleanup?.requestStop(50), timeoutMs); timer.unref();
      const r = await cleanup.quiesce(timeoutMs, timeoutMs + 500); clearTimeout(timer); return r;
    },
  };
  return client;
}
