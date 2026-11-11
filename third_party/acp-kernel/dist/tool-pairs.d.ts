import type { CoreMessage } from "./types.js";
/** Per-toolCallId [lowest, highest] position over the WHOLE array (#5751).
 *  One O(n) pass: a legal history can interleave arbitrarily many messages
 *  between a call and its result (parallel tool bursts, host-injected
 *  system/attachment messages), so pairing is id-exact, never
 *  distance-scanned. Positions are indexed for EVERY message carrying the id
 *  — including compress halves (#4348: aged compress results do seed, they
 *  carry no toolName; the compress half of an aged pair must widen INTO the
 *  range) — and a callId duplicated across messages (host re-echoes a result
 *  on retry) widens to its extremes so every message claiming the id folds on
 *  the same side of the boundary.
 *
 *  Cost contract: callers screening many units against one immutable array
 *  must build ONCE per pass and share via
 *  ProjectionShared.toolPairExtremes — rebuilding per unit is the #5337
 *  quadratic class (U units x O(n)). */
export declare function buildToolPairExtremes(messages: CoreMessage[]): Map<string, [number, number]>;
/**
 * Adjust compression range boundaries to include tool-call/result pairs.
 *
 * PREVENTIVE approach (adapted from opencode-acp PR #248): before compression
 * is applied, find tool-call or tool-result messages whose matching half (the
 * result for a call in range, or the call for a result in range) sits outside
 * the requested range. Pull the orphan half INTO the range so the pair is
 * compressed together — zero information loss.
 *
 * Pairing resolves through {@link buildToolPairExtremes}; when screening many
 * units against one immutable array, pass the pre-built map (per-unit rebuild
 * would pay O(n) each — the #5337 quadratic class).
 *
 * Only MESSAGE-boundary ranges are adjusted. Block-boundary ranges (bN) are
 * left untouched to preserve tier-detection correctness.
 *
 * @returns Adjusted { startIndex, endIndex } — may be wider than input.
 */
export declare function adjustBoundariesForToolPairs(startIndex: number, endIndex: number, messages: CoreMessage[], extremes?: Map<string, [number, number]>): {
    startIndex: number;
    endIndex: number;
};
//# sourceMappingURL=tool-pairs.d.ts.map