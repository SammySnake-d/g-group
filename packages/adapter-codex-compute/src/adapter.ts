import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { plainData } from "@g-group/kernel";
import type { Brief, ComputeActivity, ComputeAdapter, ComputeEvent, HandoffSnapshot, SpawnOptions, TurnModel } from "@g-group/kernel/compute";
import { Feed } from "./feed.ts";
import { createCodexComputeProtocol, type CodexComputeProtocol } from "./protocol.ts";

export interface CodexAdapterOptions {
  readonly runner?: { readonly command: string; readonly args?: readonly string[] };
  readonly hostEnv?: Readonly<Record<string, string>>;
  readonly dataDir?: string;
  readonly timeoutMs?: number;
  readonly reapForceMs?: number;
}
type Slot = {
  id: string; client: CodexComputeProtocol; threadId: string; turnId: string;
  brief: Brief; opts: SpawnOptions; home: string; current: TurnModel;
  history: ComputeEvent[]; turnStopped: boolean; closed: boolean;
};
const refuse = (reason: string) => ({ ok: false as const, reason });
const DEFAULT_NATIVE_SCOPE = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
function scope(tools: readonly string[]): "read-only" | "workspace-write" | string {
  if (tools.length === 0) return "read-only";
  if (tools.length === DEFAULT_NATIVE_SCOPE.length && DEFAULT_NATIVE_SCOPE.every(t => tools.includes(t))) return "workspace-write";
  return "Codex cannot enforce this per-tool whitelist; choose the complete native workspace scope";
}
export function createCodexComputeAdapter(options: CodexAdapterOptions = {}): ComputeAdapter {
  const slots = new Map<string, Slot>();
  const events = new Feed<ComputeEvent>(), activities = new Feed<ComputeActivity>();
  function clientFor(slot: Pick<Slot, "home" | "brief" | "opts">, turn: TurnModel) {
    const sandbox = scope(slot.brief.tools);
    if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error(sandbox);
    return createCodexComputeProtocol({
      runner: { ...(options.runner ?? { command: "codex", args: ["app-server"] }), env: { ...options.hostEnv } },
      cwd: slot.opts.cwd ?? process.cwd(), configDir: slot.home,
      trustOwnerModel: true,
      models: { [turn.model]: [turn.effort ?? "medium"] },
      developerInstructions: [...slot.brief.rules, "Report meaningful milestones through gg_progress/report_progress."].join("\n"),
      sandbox,
      config: { mcp_servers: {
        ...(slot.opts.mcpServers ?? {}),
        gg_progress: { command: process.execPath, args: [path.resolve(import.meta.dirname, "../mcp/report.mjs")] },
      } },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.reapForceMs === undefined ? {} : { reapForceMs: options.reapForceMs }),
    });
  }
  function publish(slot: Slot, event: ComputeEvent) {
    if (event.kind === "stopped") {
      if (slot.turnStopped) return;
      slot.turnStopped = true;
    }
    slot.history.push(event);
    events.push(event);
  }
  function pump(slot: Slot) {
    const client = slot.client;
    setImmediate(() => {
      void (async () => {
        for await (const event of client.events()) {
          if (slot.client !== client) return;
          publish(slot, Object.freeze({ ...event, computeId: slot.id }));
        }
      })();
      void (async () => { for await (const event of client.activity()) {
        if (slot.client !== client) return;
        activities.push(Object.freeze({ ...event, computeId: slot.id }));
      } })();
    });
  }
  const adapter: ComputeAdapter = {
    capabilities: { inSessionModelSwitch: true, isolation: true },
    async spawn(input: unknown, opts: SpawnOptions = {}) {
      const snapshot = plainData(input);
      if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== "object") return refuse("brief must be plain data");
      const brief = snapshot.value as Brief;
      if (typeof brief.task !== "string" || !brief.task.trim() || !Array.isArray(brief.rules) || !brief.rules.every(r => typeof r === "string") || !Array.isArray(brief.tools) || !brief.tools.every(t => typeof t === "string") || !Array.isArray(brief.credentialRefs) || brief.placement !== "local") return refuse("invalid local Codex brief");
      if (!opts.model) return refuse("an explicit model is required");
      if (opts.pluginDirs?.length) return refuse("Codex skill plugins are not mapped");
      const sandbox = scope(brief.tools); if (sandbox !== "read-only" && sandbox !== "workspace-write") return refuse(sandbox);
      const id = randomUUID();
      const home = path.resolve(opts.configDir ?? options.dataDir ?? path.join(os.tmpdir(), "g-group-codex"), "slots", id);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const current = { model: opts.model, effort: opts.effort ?? "medium" };
      const draft = { home, brief, opts };
      const client = clientFor(draft, current);
      try {
        const init = await client.initialize(); if (!init.ok) { await client.quiesce(); return init; }
        const thread = await client.startThread(current); if (!thread.ok) { await client.quiesce(); return thread; }
        const prompt = opts.handoff ? `${brief.task}\nHandoff: ${JSON.stringify(opts.handoff)}` : brief.task;
        const turn = await client.startTurn(thread.value.threadId, prompt, current); if (!turn.ok) { await client.quiesce(); return turn; }
        const slot: Slot = { ...draft, id, client, threadId: thread.value.threadId, turnId: turn.value.turnId, current, history: [], turnStopped: false, closed: false };
        slots.set(id, slot); pump(slot);
        return { ok: true, computeId: id, manifest: { computeId: id, sections: [], allowedTools: [...brief.tools], credentialRefs: [...brief.credentialRefs], placement: "local", configDir: home, mcpServers: Object.keys(opts.mcpServers ?? {}) } };
      } catch (error) { await client.quiesce(); return refuse(String(error)); }
    },
    async resume(id, text, turn, extra) {
      const slot = slots.get(id); if (!slot) return refuse("unknown Codex compute");
      const current = turn ?? slot.current;
      const tools = extra?.tools ?? slot.brief.tools;
      const sandbox = scope(tools); if (sandbox !== "read-only" && sandbox !== "workspace-write") return refuse(sandbox);
      const last = slot.history.at(-1);
      if (!slot.closed && (!last || !["completed", "failed", "stopped"].includes(last.kind))) return refuse("native turn still active");
      if (slot.closed || JSON.stringify(tools) !== JSON.stringify(slot.brief.tools)) {
        if (!slot.closed) { const q = await slot.client.quiesce(); if (!q.ok) return q; }
        slot.brief = { ...slot.brief, tools };
        const next = clientFor(slot, current);
        const init = await next.initialize(); if (!init.ok) { await next.quiesce(); return init; }
        const r = await next.resumeThread(slot.threadId, current); if (!r.ok) { await next.quiesce(); return r; }
        slot.client = next; slot.closed = false; pump(slot);
      }
      const previousHistory = slot.history;
      const previousStopped = slot.turnStopped;
      slot.history = [];
      slot.turnStopped = false;
      const r = await slot.client.startTurn(slot.threadId, text, current);
      if (!r.ok) {
        slot.history = previousHistory;
        slot.turnStopped = previousStopped;
        return r;
      }
      slot.turnId = r.value.turnId;
      slot.current = current;
      return { ok: true };
    },
    async steer(id, text) {
      const slot = slots.get(id); if (!slot) return refuse("unknown Codex compute");
      const r = await slot.client.steer(slot.threadId, slot.turnId, text);
      return r.ok ? { ok: true } : r;
    },
    async stop(id) {
      const slot = slots.get(id); if (!slot) return refuse("unknown Codex compute");
      await slot.client.interrupt(slot.threadId, slot.turnId);
      const q = await slot.client.quiesce();
      slot.closed = q.ok;
      if (!q.ok) return q;
      await new Promise<void>(resolve => setImmediate(resolve));
      publish(slot, { computeId: id, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations: [] });
      return { ok: true };
    },
    events: () => events.iterate(),
    activity: () => activities.iterate(),
    async settled(id) {
      const slot = slots.get(id); if (!slot) return [];
      await slot.client.settled(slot.threadId, slot.turnId);
      await new Promise<void>(resolve => setImmediate(resolve));
      return [...slot.history];
    },
    async quiesce(id, timeoutMs) {
      const slot = slots.get(id); if (!slot) return { ok: false, reason: "unknown Codex compute", remaining: [] };
      const result = await slot.client.quiesce(timeoutMs);
      slot.closed = result.ok;
      return result;
    },
    snapshot(id) {
      const slot = slots.get(id);
      if (!slot?.closed) return refuse("not-quiescent");
      const snapshot: HandoffSnapshot = { constraintVer: 0, openQuestions: [], doneSideEffects: slot.history.filter(e => e.kind === "milestone").map(e => e.summary) };
      return { ok: true, snapshot };
    },
    rejectedReports: () => [],
  };
  return adapter;
}
