import type { CleanupResult } from "./cleanup.ts";
import type { ProcRow } from "./procgroup.ts";

export const treeNow = (_root: number): readonly ProcRow[] | null => null;
export async function confirmStopped(_root: number, _before: readonly ProcRow[] | null, _timeoutMs: number): Promise<CleanupResult> {
  return { ok: false, reason: "red stub", remaining: [] };
}
