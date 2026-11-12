import type { ChildProcess } from "node:child_process";
export type CleanupResult = { readonly ok: true; readonly killed: number } | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };
export interface ProcessCleanup { capture(): void; requestStop(forceMs: number): void; quiesce(timeoutMs?: number, mainExitTimeoutMs?: number): Promise<CleanupResult>; }
export function createProcessCleanup(_child: ChildProcess): ProcessCleanup {
  return { capture() {}, requestStop(_forceMs) {}, async quiesce() { return { ok: true, killed: 0 }; } };
}
