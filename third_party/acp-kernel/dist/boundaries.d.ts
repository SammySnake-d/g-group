import type { CompressionBlock, CompressionState, CoreMessage, ResolvedBoundary } from "./types.js";
export type BoundaryKind = "message" | "block";
export interface ParsedBoundary {
    kind: BoundaryKind;
    numericId: number;
    raw: string;
}
export declare function parseBoundary(ref: string): ParsedBoundary | null;
/**
 * Thrown when a boundary ref parses but cannot be anchored in the visible
 * context. `kind` distinguishes a ref that never existed ("unknown", e.g. a
 * typo or a ref from another session) from one that was consumed by an
 * existing block ("consumed", messages hidden by prune). `endpoint` names the
 * failing side of the range so callers can attribute the error precisely.
 */
export declare class BoundaryNotFoundError extends Error {
    readonly code = "BOUNDARY_NOT_FOUND";
    readonly kind: "unknown" | "consumed";
    readonly endpoint: "start" | "end";
    constructor(kind: "unknown" | "consumed", endpoint: "start" | "end", message: string);
}
/** #5337 option A: one O(n) raw-id -> index map over a message array. Built
 *  once per screening pass (many units share it) instead of once per unit,
 *  which was one of the O(n) terms multiplied by the unit count. Duplicate
 *  ids resolve to their LAST position — same as the per-call maps replaced. */
export declare function buildIndexByMessageId(messages: readonly CoreMessage[]): Map<string, number>;
export interface ResolveBoundariesInput {
    startRef: string;
    endRef: string;
    messages: CoreMessage[];
    state: CompressionState;
    /** #5337 option A: prebuilt raw-id -> index map over EXACTLY `messages`
     *  (screening screens many units against one array — build once per pass).
     *  Omitted callers build one here as before. */
    indexByMessageId?: Map<string, number>;
}
export interface ResolvedRange {
    startIndex: number;
    endIndex: number;
    messageIds: string[];
    nestedBlockIds: string[];
    boundaryKind: BoundaryKind;
    protectedGaps: number[];
    snappedBoundaries: string[];
    reversedNote?: string;
}
export declare function resolveBoundaries(input: ResolveBoundariesInput): ResolvedRange;
/**
 * Visible anchor index for a block: its rendered summary message if present
 * (post-prune views replace raw messages with `acp_summary_bN`), else the
 * earliest visible raw message it covers. Without the summary fallback an
 * active block whose raws were pruned becomes unresolvable and cannot be
 * promoted (dog/billion-context-pi#195).
 */
export declare function visibleBlockAnchor(block: CompressionBlock, indexByMessageId: Map<string, number>): number | null;
export declare function blockVisibleInRange(block: CompressionBlock, indexByMessageId: Map<string, number>, startIndex: number, endIndex: number): boolean;
export declare function earliestIndexOfIds(ids: string[], indexByMessageId: Map<string, number>): number | null;
export declare function toResolvedBoundary(range: ResolvedRange): ResolvedBoundary;
//# sourceMappingURL=boundaries.d.ts.map