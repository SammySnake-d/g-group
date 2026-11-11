import type { LatestProtected } from "./protected.js";
import type { IntegrityPre } from "./turn-integrity.js";
import type { CompressionState, CompressionTier, Config, CoreMessage } from "./types.js";
/**
 * #3236: the ONE definition of "can this range fold" — the exact sequence
 * applySingleRange runs before it creates a block: boundary resolution →
 * checkpoint-carrier exclusion (#335/#2663) → pair-boundary widening
 * (tool/reasoning pairs) → nested-block rescan → protected-tool/media/zone
 * carves → turn-integrity withdrawal (#684) → empty check.
 *
 * Before this module existed the recommendation side re-implemented parts of
 * that judgment with a DIFFERENT input scope: global integrity screening over
 * ALL compressible messages at once (so a turn whose partners sit in another
 * advertised unit passed screening), while apply judges each SUBMITTED range
 * alone and throws when its carves split a turn or empty the fold. Production
 * result: acp_status / nudge advertised ranges that every submission rejected
 * with "Range would split N turn(s)" — a permanent advertise/reject loop.
 *
 * Now both sides run this one function on the same array class (the exact
 * array applyCompression executes on — see ProcessTurnInput.applyView). Apply
 * consumes the full projection and throws the carried Error verbatim; the
 * recommendation side uses it as a screen and demotes doomed units to gaps;
 * the acp_status uncompressed view flags rows whose projection is fatal.
 * Swapping any single carve criterion (dead ref, live carrier, media,
 * protected tools, zone, turn integrity) therefore changes advertise and
 * execute together — the #2663 acceptance criterion.
 */
export interface UnitProjectionInput {
    /** The EXACT message array class applyCompression will run on for this
     * lane (the unpruned log when the render view differs from it). */
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    startRef: string;
    endRef: string;
    /** Raw ids already covered by active blocks BEFORE this unit folds
     * (apply computes one such set per call; recommend passes the current one). */
    preExistingCoverage: Set<string>;
    /** REF ids (mNNNNN) of the soft-protection zone, computed on `messages` —
     * apply derives them from its own input array via computeProtectedRefs. */
    protectedMessageIds?: Set<string>;
    /** Warnings are pushed here in apply's original emission order so the
     * apply-side refactor stays byte-identical. Omit for read-only screens. */
    warnings?: string[];
    /** #5337 option A: per-pass O(n) derivations shared by every unit screened
     *  against the SAME (messages, state, config) triple — build once with
     *  {@link buildProjectionShared}. Omitted callers (the single-shot
     *  apply/report paths) compute inline exactly as before. */
    shared?: ProjectionShared;
    /** #5789 recovery ladder (internal): nested block ids kept ACTIVE even
     *  though they sit inside the span — the merge proceeds without consuming
     *  them. Set only by projectUnit's own shrink retry; external callers must
     *  never pass it. */
    excludeNestedBlockIds?: ReadonlySet<string>;
}
export interface UnitProjectionFatal {
    kind: "zone" | "split";
    error: Error;
}
export interface UnitProjection {
    /** Non-null when applySingleRange would THROW for this unit (and which
     * error, fully constructed). Null = the unit folds, possibly with warnings. */
    fatal: UnitProjectionFatal | null;
    rangeMessageIds: string[];
    skippedCarrierIds: string[];
    nestedBlockIds: string[];
    consumedBlockIds: string[];
    effectiveMessageIds: Set<string>;
    directMessageIds: string[];
    filteredIds: string[];
    withdrawnIds: Set<string>;
    splitTurnCount: number;
    splitPairCount: number;
    targetTier: CompressionTier;
    outputTier: CompressionTier;
    isBlockBoundary: boolean;
}
/** Read-only projection of one candidate range through the full apply
 * sequence. Never mutates `state`; never creates blocks. Throws
 * BoundaryNotFoundError when an endpoint ref cannot be resolved. */
export declare function projectUnit(input: UnitProjectionInput): UnitProjection;
/** #5337 option A: every per-screening-pass O(n) derivation over ONE message
 *  array, computed ONCE instead of once per screened unit. This was the
 *  quadratic term of the recommend node: U units x O(n) rescans (history
 *  index maps, carrier scan, protected/latest/aged collectors, tool-pairing
 *  map, last-user anchor, turn-integrity pre-scan) about O(n^2) total —
 *  ~17 s for a single processTurn at 23k core messages while Node's event
 *  loop was blocked (#5304 repro on v0.1.209).
 *
 *  Build once per (messages, state, config) triple via
 *  {@link buildProjectionShared} and pass to every projectUnit call on that
 *  triple. Semantics are byte-identical: each field is exactly the value the
 *  corresponding inline computation produced per unit (projectUnit screens
 *  many units against one immutable array within a turn). The judgment
 *  criteria themselves (#3236 discipline) are untouched — only how the
 *  inputs reach them changed. */
export interface ProjectionShared {
    /** Raw-id -> index over `messages` (last occurrence wins, map semantics). */
    byId: Map<string, number>;
    /** Host checkpoint carriers (#335/#2663) — the plain-range scan result. */
    liveCarrierIds: Set<string>;
    /** Failed-compress exchange toolCallIds (#4289). */
    failedCompressCallIds: Set<string>;
    /** Latest-only protection sets (protectedLatestTools). */
    latestProtected: LatestProtected;
    /** Aged compress-exchange toolCallIds (#4348 fold exemption lift). */
    agedCompressCallIds: Set<string>;
    /** latest.callIds plus the full-history protected-tool scan — the exact
     *  base set filterProtectedToolMessages builds without sharing. Callers
     *  must COPY it (per-unit passes add removed ids' toolCallIds). Immutable. */
    baseProtectedCallIds: Set<string>;
    /** tool-call/tool-result pairing keyed by toolCallId ?? id. */
    pairByCallId: Map<string, [string, string]>;
    /** Per-toolCallId [lowest, highest] positions over the whole array —
     *  #5751 id-exact boundary widening. Rebuilding it per unit is the #5337
     *  quadratic class (U units x O(n)) — hence shared. Immutable. */
    toolPairExtremes: Map<string, [number, number]>;
    /** Last visible user anchor (drives the #3953 truncation warning note). */
    anchorMessage: CoreMessage | undefined;
    /** Per-message inputs of computeIntegrityWithdrawals (#684 gate). */
    integrityPre: IntegrityPre;
}
/** One-pass build of {@link ProjectionShared}; see that interface for what
 *  each field mirrors and why one build serves an entire screening pass. */
export declare function buildProjectionShared(messages: CoreMessage[], state: CompressionState, config: Config): ProjectionShared;
/** Union of the raw ids covered by all active blocks — the set apply treats
 * as "already folded" before a new spec runs (one per applyCompression call). */
export declare function collectCoverage(state: CompressionState): Set<string>;
//# sourceMappingURL=unit-projection.d.ts.map