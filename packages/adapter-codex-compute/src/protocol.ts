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
export function createCodexComputeProtocol(_options: CodexProtocolOptions): CodexComputeProtocol {
  const absent = async () => ({ ok: false as const, reason: "not implemented" });
  return { initialize: absent, startThread: absent, resumeThread: absent, startTurn: absent, steer: absent, interrupt: absent, settled: absent, events: async function* () {}, quiesce: async () => ({ ok: false, killed: 0, reason: "not implemented" }) };
}
