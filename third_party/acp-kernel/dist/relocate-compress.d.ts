import type { CompressionState, CoreMessage } from "./types.js";
/** Opt-in view transform (experimental, default OFF — see Config.compressAtFoldPoint):
 *  relocate the SUMMARY TEXT of each still-visible compress carrier pair to the
 *  fold point, leaving the pair itself in its chronological slot with the call
 *  args replaced by a short pointer.
 *
 * Semantics (v2, #5470 follow-up — replaces the verbatim-pair move): when the
 *  knob is on, for each compress call/result pair that still owns an active
 *  block:
 *  - a synthetic `user` text core carrying the call's summary text (the args
 *    `content`, or the raw args string when not JSON) is inserted directly
 *    after the pair's own folded region ("[folded region] – [summary carrier] –
 *    [protected messages]");
 *  - the pair STAYS at its original (chronological) position — the tool
 *    exchange keeps reading as history, not as a fresh command — with the call
 *    core's args text replaced by a short pointer ("compression succeeded;
 *    summary relocated to its fold point above") so a weak-attention model
 *    cannot mistake the pair for an unfinished compression. The result core is
 *    forwarded verbatim.
 *
 * Why v2: with the v1 verbatim move, every historical pair stays visible
 * mid-history as a fully-shaped compress interaction — for weak-attention
 * models that gallery reads as an open invitation to keep compressing
 * (observed: voluntary re-compress loops). v2 keeps exactly one recent
 * interaction shape per fold (the pointer pair, which explicitly says
 * "already folded") and renders the payloads the model actually needs to
 * re-read (the summaries) as plain text at the place they describe.
 *
 * Invariants:
 *  - VIEW-ONLY + deterministic f(history, state): nothing is persisted, refs are
 *    untouched (assign-refs already ran; messageRefs is a persistent id→ref map),
 *    so the layout is recomputed identically on every turn — byte-stable from the
 *    second turn on, no incremental prefix-cache cost beyond the fold's own break.
 *    The call core is rewritten via a shallow CLONE (input cores are never
 *    mutated — callers reuse them for persistence and round-2 rebuilds).
 *  - Idempotent: a call id whose carrier (`acp_reloc_<callId>`) is already
 *    present, or whose args already carry the relocation marker, is skipped —
 *    re-running the transform on its own output is a same-reference no-op.
 *  - Pair integrity: a call is rewritten only when BOTH cores are present, in
 *    order, adjacent, and unambiguous (exactly one tool-call core per active
 *    block's call id). Any anomaly → the pair stays verbatim (safe direction).
 *  - Boundary rule: insert the carrier before the first surviving core whose
 *    allocated ref is strictly greater than max(endRef) across the blocks this
 *    call created (multi-range batches → rightmost boundary); when none exists
 *    (fold reaches the window end, #4732 regime) append at the tail instead.
 *  - Thinking clear (second opt-in, default off, predicate-gated): the run of
 *    contiguous `reasoning` cores immediately preceding the pair may be dropped
 *    IF opts.reasoningDroppable accepts each one. Without a predicate
 *    NOTHING is dropped — signed-thinking / strict-echo awareness lives in the
 *    host (it owns the wire signatures), and the conservative default here is
 *    "never drop". */
export interface RelocateOptions {
    /** Same contract as Config.isCompressTool: host dialect names count as a
     *  compress call. Unset = bare-name only. */
    isCompressTool?: (toolName: string) => boolean;
    /** Enable the #651-style reasoning drop around kept pairs. */
    clearThinking?: boolean;
    /** Host predicate deciding which reasoning cores may be dropped (signed
     *  thinking and strict-echo sessions must answer false). UNSET ⇒ no drop even
     *  with clearThinking set. Must be pure and cheap: runs once per candidate. */
    reasoningDroppable?: (msg: CoreMessage) => boolean;
}
export interface RelocateMove {
    callId: string;
    /** Index of the tool-call core in the input array. */
    callIndex: number;
    /** Index of the tool-result core in the input array (stays in place, verbatim). */
    resultIndex: number;
    /** Survivor ordinal: emit the carrier before the k-th surviving (non-removed)
     *  input. k == total survivors ⇒ tail append (#4732 regime). */
    insertAtOutput: number;
    /** Input indices of dropped reasoning cores (adjacent run before the call). */
    droppedReasoningIndices: number[];
    /** Synthetic fold-point carrier carrying the relocated summary text.
     *  `summaryOfBlockId` anchors the #335 live-checkpoint-carrier protection
     *  (plain compress ranges cannot fold it; block-ref distillation can). */
    carrier: CoreMessage;
    /** Replacement args text for the call core (pointer JSON). */
    pointerText: string;
}
export interface RelocatePlan {
    moves: RelocateMove[];
    /** Input indices of ALL cores removed (dropped reasoning only — pairs stay). */
    removedInputIndices: Set<number>;
    changed: boolean;
}
/** Marker embedded in the pointer args text; also the idempotency detector for
 *  hosts that round-trip a view whose carrier ids did not survive. */
export declare const RELOCATED_POINTER_MARKER = "[bili] compression succeeded \u2014 summary relocated";
/** Compute the relocation plan for `messages` under `state`. Pure: same inputs
 *  always yield the same plan (host-side determinism requirement). */
export declare function planRelocateCompressCarriers(messages: CoreMessage[], state: CompressionState, opts?: RelocateOptions): RelocatePlan;
/** Apply the plan to `messages`, returning a NEW array when anything changed.
 *  Fast path: no-op plans return the SAME array reference (byte-identical
 *  guarantee for the default-off regime).
 *
 *  Placement keys on the SURVIVOR ordinal, not the raw output length: a
 *  carrier "with insertAtOutput k" must appear right BEFORE the k-th surviving
 *  input. Emitted carriers grow the output array between survivors, so keying on
 *  out.length would skip slots whenever an earlier carrier landed first (two
 *  calls folding different ranges may legally interleave).
 *
 *  The rewritten call core is a shallow CLONE of the input (view-only purity:
 *  callers reuse input cores for persistence and round-2 rebuilds); every other
 *  core is forwarded by reference. */
export declare function relocateCompressCarriers(messages: CoreMessage[], state: CompressionState, opts?: RelocateOptions): CoreMessage[];
//# sourceMappingURL=relocate-compress.d.ts.map