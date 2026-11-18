export async function startupSlot(_timeoutMs: number): Promise<() => void> {
  throw new Error("red stub");
}
export const RPC_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  initialize: 15_000, "thread/start": 30_000, "thread/resume": 30_000,
  "turn/start": 30_000, "turn/steer": 10_000, "turn/interrupt": 10_000,
});
