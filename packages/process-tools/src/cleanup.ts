// Explicit red scaffold for the round-2 G-RED calibration; never a production implementation. The next commit restores the real file byte for byte.
import type { ChildProcess } from "node:child_process";
export type CleanupResult = { readonly ok: true; readonly killed: number } | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };
export interface ProcessCleanup { capture(): void; requestStop(forceMs: number): void; quiesce(timeoutMs?: number, mainExitTimeoutMs?: number): Promise<CleanupResult>; }
export interface CleanupOptions { readonly platform?: NodeJS.Platform; }
export function createProcessCleanup(_child: ChildProcess, _options: CleanupOptions = {}): ProcessCleanup {
  return { capture() {}, requestStop(_forceMs) {}, async quiesce() { return { ok: false, reason: "red scaffold", remaining: [] }; } };
}
