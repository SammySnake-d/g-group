import type { CompressionState, CoreMessage, MessageRefMap } from "./types.js";
export declare const BLOCKED_REF = "BLOCKED";
export declare function emptyRefMap(): MessageRefMap;
export declare function indexToRef(index: number): string;
export declare function refToIndex(ref: string): number | null;
export declare function refForRaw(map: MessageRefMap, rawId: string): string | null;
/** Canonical DISPLAY order for a positional ref pair. Direction is
 *  notational — resolveBoundaries swaps reversed pairs, so both orders select
 *  the same region and rendering may canonicalize to ascending numeric order.
 *  Under non-monotonic refs (client history rewrite #1001, subagent
 *  interleaving) a positional span's endpoint labels can be numerically
 *  descending; printing them as-is reads as a malformed range, and copy-
 *  pasted reversed pairs trip validators that reject startId > endId (#2168).
 *  Pairs with an unparseable side ("BLOCKED", bN specs) pass through. */
export declare function orderedRefPair(startRef: string, endRef: string): [string, string];
export declare function rawForRef(map: MessageRefMap, ref: string): string | null;
export interface AssignRefsResult {
    map: MessageRefMap;
    nextIndex: number;
    newlyAssigned: number;
    /** Ids whose stale BLOCKED entry migrated to a fresh numeric ref this pass
     *  (#2607). The caller defers their carrier re-render (#3939 ②/#3805). */
    migratedIds: string[];
}
export interface AssignRefsOptions {
    existing: MessageRefMap;
    nextIndex: number;
    isProtected?: (message: CoreMessage) => boolean;
    shouldSkip?: (message: CoreMessage) => boolean;
}
export declare function assignRefs(messages: CoreMessage[], options: AssignRefsOptions): AssignRefsResult;
export declare function rebuildRefIndex(map: MessageRefMap): MessageRefMap;
export interface RefRestampOutcome {
    /** Row-backed refs that already equalled seq+1 — untouched. */
    kept: number;
    /** Row-backed refs re-pointed onto seq+1. */
    restamped: number;
    /** Unbacked refs displaced by a stamp and re-homed onto fresh numbers. */
    rehomed: number;
    /** BLOCKED entries — protected messages keep taking no number. */
    blocked: number;
    /** Old ref → rawId for EVERY mapping that changed hands. Hosts keep this
     *  for the process lifetime so a compress call replaying pre-restart refs
     *  (a resent in-flight tool call) is honestly rejected instead of silently
     *  folding whatever message now owns the number. */
    superseded: Map<string, string>;
}
/** #4316 layer 3 PR3/3 — align the existing citation space with the unified
 *  ledger, exactly once per state. The counter path numbers messages in
 *  arrival order but skips protected messages (BLOCKED takes no number) while
 *  the store still gives them a row seq, so refs minted after a protected
 *  message drift ahead of seq+1; edits and churn widen the gap. After this
 *  call every row-backed, currently-mapped raw id holds ref = seq+1 — the
 *  same numbers the stamped lanes (assignRefs' ledgerSeq path) mint — so the
 *  model citation space and the storage truth agree and churn cannot renumber
 *  citations anymore.
 *
 *  Scope honesty: raw ids with NO current mapping are left to assignRefs (the
 *  stamp path aligns them on next sight); BLOCKED entries stay BLOCKED; dead
 *  refs stay reserved; an unbacked ref displaced by a stamp is re-homed onto a
 *  fresh number (the id-never-reused contract holds — it keeps A ref).
 *
 *  Slot retirement (#5196): a stamp permanently retires the vacated slot — no
 *  other message may take it during this pass (or ever: the slot sits below
 *  the allocation cursor). Without this, message A vacating m7 earlier in the
 *  same loop lets message B stamp onto m7 while superseded[m7] still names A:
 *  one number carries two identities, and the host's live-first resolver
 *  (src/stream.ts supersededRefRejection) then silently re-targets any
 *  pre-restart citation of m7 at B instead of translating it back to A.
 *  Retiring the slot breaks the alias permanently: A keeps superseded[m7]=A
 *  as a pure translation, B parks on a fresh high number (allocateFreeRef),
 *  and the citation space may carry a sparse gap — refs are display labels,
 *  sparseness has no functional cost, and the #4316 invariant survives as
 *  "one stable pass": every aligned id holds seq+1, every parked id holds a
 *  fresh number that assignRefs' ledgerSeq path will never mint over, so the
 *  next cold load finds nothing to move. */
export declare function restampRefsToLedger(state: CompressionState, seqByRawId: Map<string, number>): RefRestampOutcome;
export declare function highestUsedIndex(map: MessageRefMap): number;
//# sourceMappingURL=refs.d.ts.map