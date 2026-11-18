import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { realpathSync } from "node:fs";
import { plainData } from "@g-group/kernel";
import type { ComputeEvent, QuiesceResult, TurnModel } from "@g-group/kernel/compute";
import { createProcessCleanup, type ProcessCleanup } from "@g-group/process-tools";
export type ProtocolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export interface CodexProtocolOptions {
  readonly runner: { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> };
  readonly cwd: string;
  readonly configDir: string;
  readonly models: Readonly<Record<string, readonly string[]>>;
  readonly timeoutMs?: number;
  readonly reapForceMs?: number;
  readonly developerInstructions?: string;
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
const no = <T>(reason: string): ProtocolResult<T> => ({ ok: false, reason });
export function createCodexComputeProtocol(_options: CodexProtocolOptions): CodexComputeProtocol {
  return { initialize: async () => no("not implemented"), startThread: async () => no("not implemented"), resumeThread: async () => no("not implemented"), startTurn: async () => no("not implemented"), steer: async () => no("not implemented"), interrupt: async () => no("not implemented"), settled: async () => no("not implemented"), async *events() {}, async quiesce() { return { ok: true, killed: 0 }; } };
}
