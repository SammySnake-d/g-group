import type { ComputeEvent, QuiesceResult, TurnModel } from "@g-group/kernel/compute";
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
export function createCodexComputeProtocol(_options: CodexProtocolOptions): CodexComputeProtocol {
  return {
    initialize: async () => ({ ok: false, reason: "native protocol not initialized" }),
    startThread: async () => ({ ok: false, reason: "not implemented" }),
    resumeThread: async () => ({ ok: false, reason: "not implemented" }),
    startTurn: async () => ({ ok: false, reason: "not implemented" }),
    steer: async () => ({ ok: false, reason: "not implemented" }),
    interrupt: async () => ({ ok: false, reason: "not implemented" }),
    settled: async () => ({ ok: false, reason: "not implemented" }),
    events: async function* () {},
    quiesce: async () => ({ ok: true, killed: 0 }),
  };
}
