import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { startupSlot, RPC_TIMEOUT_MS } from "./startup.ts";
import path from "node:path";
import { realpathSync } from "node:fs";
import { plainData } from "@g-group/kernel";
import type { ComputeEvent, ComputeActivity, QuiesceResult, TurnModel } from "@g-group/kernel/compute";
import { createProcessCleanup, type ProcessCleanup } from "@g-group/process-tools";
export type ProtocolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string; readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown } };
export interface CodexProtocolOptions {
  readonly runner: { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> };
  readonly cwd: string;
  readonly configDir: string;
  readonly models: Readonly<Record<string, readonly string[]>>;
  readonly timeoutMs?: number;
  readonly reapForceMs?: number;
  readonly developerInstructions?: string;
  readonly trustOwnerModel?: boolean;
  readonly sandbox?: "read-only" | "workspace-write";
  readonly config?: Readonly<Record<string, unknown>>;
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
  activity(): AsyncIterable<ComputeActivity>;
  quiesce(timeoutMs?: number): Promise<QuiesceResult>;
}
const no = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

const freezeDeep = <T>(value: T): T => { if (value && typeof value === "object") { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); } return value; };

export function createCodexComputeProtocol(options: CodexProtocolOptions): CodexComputeProtocol {
  const snapshot = plainData(options, "protocol options");
  if (!snapshot.ok) throw new TypeError("protocol options must be plain data");
  options = snapshot.value as unknown as CodexProtocolOptions;
  const timeout = options.timeoutMs ?? 10000;
  const reapForceMs = options.reapForceMs ?? 10_000;
  for (const ms of [timeout, reapForceMs]) if (!Number.isFinite(ms) || ms < 0) throw new TypeError("invalid protocol timeout");
  let initialization: ReturnType<CodexComputeProtocol["initialize"]> | undefined;
  let releaseStartup: (() => void) | undefined;
  const activities: ComputeActivity[] = [];
  const activityWait = new Set<() => void>();
  function activity(event: ComputeActivity) { activities.push(freezeDeep(event)); for (const wake of activityWait) wake(); activityWait.clear(); }

  function capability(turn: TurnModel, tools: readonly string[] | undefined) {
    const t = plainData(tools ?? [], "requested tools");
    if (!t.ok || !Array.isArray(t.value) || t.value.length !== 0) return no("native per-tool authorization is not mapped; Host/G2 policy must not be guessed");
    const p = plainData(turn, "turn model");
    if (!p.ok || !record(p.value) || typeof p.value.model !== "string" || (!options.trustOwnerModel && !Object.hasOwn(options.models, p.value.model))) return no("requested model is not in the explicit owner catalog");
    if (typeof p.value.effort !== "string" || !(options.trustOwnerModel ? ["none", "minimal", "low", "medium", "high", "xhigh"].includes(p.value.effort) : options.models[p.value.model]?.includes(p.value.effort))) return no("requested effort is not supported by the explicit owner catalog");
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
  const deniedTurns = new Set<string>();
  const notes: Record<string, unknown>[] = [];
  function consume(msg: Record<string, unknown>) {
    if (record(msg.params) && msg.params.threadId === threadId) {
      const params = msg.params;
      const active = [...turns.values()].find(t => !t.result);
      if (!active || (typeof params.turnId === "string" && params.turnId !== active.id)) return;
      const id = threadId!;
      if (msg.method === "item/agentMessage/delta") activity({ computeId: id, kind: "progress", what: "text" });
      if (msg.method === "thread/tokenUsage/updated") activity({ computeId: id, kind: "progress", what: "output" });
      if (msg.method === "error" && record(params.error) && params.willRetry !== true) {
        finishFailed(active, typeof params.error.message === "string" ? params.error.message : "native error");
        return;
      }
      if ((msg.method === "item/started" || msg.method === "item/completed") && record(params.item)) {
        const item = params.item;
        const tool = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type));
        if (tool && typeof item.id === "string") {
          if (msg.method === "item/started") {
            cleanup?.capture();
            activity({ computeId: id, kind: "tool_start", toolId: item.id, name: String(item.tool ?? item.type), background: false, subagent: false });
          } else {
            activity({ computeId: id, kind: "tool_end", toolId: item.id, isError: item.status === "failed" || item.status === "declined" });
            if (item.tool === "report_progress" && record(item.result) && record(item.result.structuredContent)) report(item.result.structuredContent);
          }
        }
      }
    }
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
    if (deniedTurns.delete(native.id)) { finishFailed(turn, "unsupported native approval refused"); return; }
    if (native.status === "interrupted") {
      turn.result = { ok: true, value: { computeId: threadId!, kind: "stopped", code: null, signal: null, scope: "turn-interrupt", violations: [] } };
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
  function report(input: Record<string, unknown>): boolean {
    if (typeof input.summary !== "string" || !input.summary.trim() || !threadId) return false;
    if (input.kind === "milestone" && typeof input.stage === "string") publish({ computeId: threadId, kind: "milestone", stage: input.stage, summary: input.summary });
    else if (input.kind === "blocked" && typeof input.needs === "string") publish({ computeId: threadId, kind: "blocked", needs: input.needs, summary: input.summary });
    else return false;
    return true;
  }
  function finishFailed(turn: Turn, reason: string) {
    if (turn.result) return;
    turn.result = { ok: true, value: { computeId: threadId!, kind: "failed", reason, code: null, signal: null, violations: [] } };
    publish(turn.result.value); turn.finish(turn.result);
  }
  function failWire(reason: string) {
    wireFailure ??= reason; failPending(reason);
    for (const turn of turns.values()) finishFailed(turn, reason);
    cleanup?.requestStop(reapForceMs);
  }
  let sequence = 0;
  const pending = new Map<string, { finish: (r: ProtocolResult<Record<string, unknown>>) => void; timer: NodeJS.Timeout }>();
  const failPending = (reason: string) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.finish(no(reason)); }
    pending.clear();
  };
  function send(message: Record<string, unknown>): boolean {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try { child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; }
  }
  function request(method: string, params: Record<string, unknown>, accepted?: (value: Record<string, unknown>) => string | null): Promise<ProtocolResult<Record<string, unknown>>> {
    const id = `g-group-codex-${++sequence}`;
    return new Promise((finish) => {
      const timer = setTimeout(() => { pending.delete(id); finish(no(`native request timeout: ${method}`)); failWire(`native request timeout: ${method}`); }, options.timeoutMs ?? RPC_TIMEOUT_MS[method] ?? timeout);
      pending.set(id, { finish: result => {
        if (result.ok && accepted) {
          const error = accepted(result.value);
          if (error) { finish(no(error)); return; }
        }
        finish(result);
      }, timer });
      if (!send({ id, method, params })) { pending.delete(id); clearTimeout(timer); finish(no("native process unavailable")); }
    });
  }
  function launch() {
    if (child) return;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...options.runner.env, HOME: process.env.HOME ?? "", CODEX_HOME: options.configDir };
    child = spawn(options.runner.command, [...(options.runner.args ?? [])], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: "pipe" });
    cleanup = createProcessCleanup(child); cleanup.capture();
    const onLine = (line: string) => {
      try {
        const msg: unknown = JSON.parse(line);
        if (!record(msg)) { failWire("invalid native JSON object"); return; }
        if (typeof msg.method === "string" && Object.hasOwn(msg, "id")) {
          if (msg.method === "item/tool/call" && record(msg.params) && msg.params.threadId === threadId && typeof msg.params.turnId === "string" && turns.get(msg.params.turnId)?.result === null && msg.params.tool === "report_progress" && record(msg.params.arguments)) {
            const success = report(msg.params.arguments);
            send({ id: msg.id, result: { success, contentItems: [{ type: "inputText", text: success ? "reported" : "invalid progress report" }] } });
          } else {
            send({ id: msg.id, error: { code: -32601, message: "g-group has no approval or elicitation authority" } });
            const denied = record(msg.params) && typeof msg.params.turnId === "string" ? msg.params.turnId : null;
            if (denied) deniedTurns.add(denied);
            const timer = setTimeout(() => {
              for (const turn of turns.values()) if (!turn.result && (!denied || turn.id === denied)) finishFailed(turn, "unsupported native approval refused");
            }, timeout);
            timer.unref();
            for (const turn of turns.values()) if (!turn.result) void turn.done.then(() => clearTimeout(timer));
          }
          return;
        }
        if (typeof msg.method === "string") {
          if (msg.method === "thread/started") return;
          if (starting) {
            if (notes.length >= 64) failWire("too many early lifecycle events");
            else notes.push(msg);
          } else consume(msg);
          return;
        }
        if (typeof msg.id !== "string") return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        if (record(msg.error) && typeof msg.error.code === "number" && typeof msg.error.message === "string") p.finish({ ok: false, reason: msg.error.message, error: { code: msg.error.code, message: msg.error.message, ...(Object.hasOwn(msg.error, "data") ? { data: msg.error.data } : {}) } });
        else p.finish(record(msg.result) && !Object.hasOwn(msg, "error") ? { ok: true, value: msg.result } : no("invalid native RPC response"));
      } catch { failWire("invalid native JSON"); }
    };
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) { failWire("native line too large"); buffer = ""; return; }
        if (line.trim()) onLine(line);
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024) { buffer = ""; failWire("native line too large"); }
    });
    let eofTimer: NodeJS.Timeout | undefined;
    child.stdout.once("end", () => {
      if (buffer.trim()) failWire("invalid native JSON: unterminated line");
      failPending("native stdout exited");
      eofTimer = setTimeout(() => failWire("native stdout exited before matching turn/completed"), 250); eofTimer.unref();
    });
    child.stderr.resume();
    child.once("close", (code, signal) => {
      clearTimeout(eofTimer);
      failPending("native process exited");
      for (const turn of turns.values()) {
        if (turn.result) continue;
        turn.result = { ok: true, value: { computeId: threadId!, kind: "failed", reason: wireFailure ?? "native process exited before matching turn/completed", code: wireFailure ? null : code, signal: wireFailure ? null : signal, violations: [] } };
        publish(turn.result.value); turn.finish(turn.result);
      }
      closed = true; initialized = false; releaseStartup?.(); releaseStartup = undefined; wake(); for (const wake of activityWait) wake(); activityWait.clear();
    });
    child.once("error", () => { failWire("native process failed to start"); closed = true; releaseStartup?.(); releaseStartup = undefined; wake(); });
    child.stdin.on("error", () => failPending("native stdin closed"));
  }
  const client: CodexComputeProtocol = {
    initialize() {
      initialization ??= (async () => {
      if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.configDir)) return no("cwd/configDir must be absolute");
      try { releaseStartup = await startupSlot(timeout); } catch (error) { return no(String(error)); }
      launch();
      const r = await request("initialize", { clientInfo: { name: "g-group-codex-protocol", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      if (!r.ok) { cleanup?.requestStop(reapForceMs); releaseStartup?.(); releaseStartup = undefined; return r; }
      try {
        if (typeof r.value.codexHome !== "string" || realpathSync(r.value.codexHome) !== realpathSync(options.configDir)) return no("native config owner mismatch");
      } catch { return no("native config owner mismatch"); }
      if (!send({ method: "initialized" })) return no("initialized write failed");
      initialized = true; releaseStartup?.(); releaseStartup = undefined;
      return { ok: true as const, value: { codexHome: r.value.codexHome } };
      })().then(result => {
        releaseStartup?.(); releaseStartup = undefined;
        if (!result.ok) { cleanup?.requestStop(reapForceMs); void cleanup?.quiesce(5000, reapForceMs + 5000); }
        return result;
      });
      return initialization;
    },
    async startThread(turn, tools) {
      const refused = capability(turn, tools); if (refused) return refused;
      if (!initialized || closed || wireFailure) return no("initialize first");
      const r = await request("thread/start", { model: turn.model, cwd: options.cwd, ephemeral: false, approvalPolicy: "never", sandbox: options.sandbox ?? "read-only", developerInstructions: options.developerInstructions ?? null, ...(options.config ? { config: options.config } : {}) });
      if (!r.ok) return r;
      if (!record(r.value.thread) || typeof r.value.thread.id !== "string") return no("invalid native thread id");
      threadId = r.value.thread.id;
      return { ok: true, value: { threadId } };
    },
    async resumeThread(wantedThread, turn, tools) {
      const refused = capability(turn, tools); if (refused) return refused;
      if (!initialized || closed || wireFailure || typeof wantedThread !== "string" || !wantedThread) return no("native thread id required");
      const r = await request("thread/resume", { threadId: wantedThread, model: turn.model, cwd: options.cwd, approvalPolicy: "never", sandbox: options.sandbox ?? "read-only", developerInstructions: options.developerInstructions ?? null, ...(options.config ? { config: options.config } : {}) });
      if (!r.ok) return r;
      if (!record(r.value.thread) || r.value.thread.id !== wantedThread) return no("native resumed a different thread");
      threadId = wantedThread; resumed = true;
      return { ok: true, value: { threadId } };
    },
    async startTurn(wantedThread, text, turn, tools) {
      if (!initialized || closed || wireFailure) return no("native session unavailable");
      const refused = capability(turn, tools); if (refused) return refused;
      if (wantedThread !== threadId) return no("native thread mismatch");
      if (starting || [...turns.values()].some((t) => t.result === null)) return no("native turn already active");
      if (typeof text !== "string" || !text.trim()) return no("native turn input must be nonempty text");
      starting = true;
      let acceptedId: string | null = null;
      const r = await request("turn/start", { threadId: wantedThread, input: [{ type: "text", text, text_elements: [] }], model: turn.model, effort: turn.effort }, value => {
        if (!record(value.turn) || typeof value.turn.id !== "string") return "invalid native turn id";
        const id = value.turn.id;
        if (turns.has(id)) { failWire("duplicate native turn id"); return "duplicate native turn id"; }
        let finish: Turn["finish"] = () => {};
        const done = new Promise<ProtocolResult<ComputeEvent>>(resolve => { finish = resolve; });
        for (const [key, previous] of turns) if (previous.result && turns.size > 64) turns.delete(key);
        activity({ computeId: wantedThread, kind: "model_call" });
        turns.set(id, { started: false, id, done, finish, result: null });
        acceptedId = id;
        starting = false;
        for (const note of notes.splice(0)) consume(note);
        return null;
      });
      if (!r.ok) { starting = false; notes.length = 0; return r; }
      return acceptedId ? { ok: true, value: { turnId: acceptedId } } : no("invalid native turn id");
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
    activity: async function* () {
      let index = 0;
      for (;;) {
        while (index < activities.length) yield activities[index++]!;
        if (closed) return;
        await new Promise<void>(r => activityWait.add(r));
      }
    },
    async quiesce(timeoutMs = 5000) {
      if (!cleanup || !child) return { ok: true, killed: 0 };
      releaseStartup?.(); releaseStartup = undefined;
      if (threadId) {
        const turn = [...turns.values()].find(t => !t.result);
        if (turn) await client.interrupt(threadId, turn.id);
      }
      cleanup.capture(); child.stdin.end();
      const timer = setTimeout(() => cleanup?.requestStop(reapForceMs), timeoutMs); timer.unref();
      const r = await cleanup.quiesce(timeoutMs, timeoutMs + reapForceMs + 500); clearTimeout(timer); return r;
    },
  };
  return client;
}
