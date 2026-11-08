// 联系人记忆的纯函数(D25)。红提交:空壳。
export type MemoryStatus = "active" | "superseded" | "revoked" | "degraded";
export interface MemorySource { readonly roomId: string; readonly seq: number; readonly userQuote: boolean }
export interface MemoryUse { readonly at: string; readonly good: boolean; readonly note?: string }
export interface MemoryEntry {
  readonly id: string;
  readonly version: number;
  readonly status: MemoryStatus;
  readonly title: string;
  readonly body: string;
  readonly anchors: readonly string[];
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly source: MemorySource | null;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly refines: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly derivedFrom: readonly string[];
  readonly evidence: readonly { readonly roomId: string; readonly seq: number; readonly at: string }[];
  readonly uses: readonly MemoryUse[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MemoryWrite {
  readonly title: string;
  readonly body: string;
  readonly anchors: readonly string[];
  readonly source: MemorySource | null;
  readonly relation: { readonly kind: "change" | "refine" | "conflict"; readonly target: string } | null;
}
export type MemoryPlan =
  | { readonly kind: "new" | "change" | "refine"; readonly entry: MemoryEntry; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "restate"; readonly target: string; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "ask-user"; readonly target: string; readonly entry: MemoryEntry; readonly changed: readonly MemoryEntry[] }
  | { readonly kind: "invalid"; readonly why: string };
export function serializeMemory(_e: MemoryEntry): string {
  return "";
}
export function parseMemory(_t: string): { ok: true; entry: MemoryEntry } | { ok: false; why: string } {
  return { ok: false, why: "" };
}
export function planMemoryWrite(_es: readonly MemoryEntry[], _w: MemoryWrite, _now: string, _id: () => string): MemoryPlan {
  return { kind: "invalid", why: "" };
}
export function selectMemories(_es: readonly MemoryEntry[], _c: { anchors: readonly string[]; text: string; now: string }): { expanded: MemoryEntry[]; listed: { id: string; title: string }[] } {
  return { expanded: [], listed: [] };
}
export function prefixMemories(_es: readonly MemoryEntry[], _now: string): MemoryEntry[] {
  return [];
}
export function recordMemoryUse(e: MemoryEntry, _u: MemoryUse, _now: string): MemoryEntry {
  return e;
}
