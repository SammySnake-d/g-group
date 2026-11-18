import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
export type CleanupResult = { readonly ok: true; readonly killed: number } | { readonly ok: false; readonly reason: string; readonly remaining: readonly number[] };
export interface ProcessCleanup { capture(): void; requestStop(forceMs: number): void; quiesce(timeoutMs?: number, mainExitTimeoutMs?: number): Promise<CleanupResult> }
export interface CleanupOptions { readonly platform?: NodeJS.Platform }
export function createProcessCleanup(_child: ChildProcess, _options: CleanupOptions = {}): ProcessCleanup { return { capture() {}, requestStop() { assert.fail("process stop not implemented"); }, async quiesce() { return { ok: false, reason: "not implemented", remaining: [] }; } }; }
