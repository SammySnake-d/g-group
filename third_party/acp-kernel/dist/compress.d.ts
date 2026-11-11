import { createInitialState } from "./state.js";
import type { ApplyRetrieveResult } from "./ccr.js";
import type { MessageContentStore } from "./content-store.js";
import type { RenderStrategy } from "./render-refs.js";
import { type PipelineNode } from "./pipeline.js";
import type { ApplyCompressionResult, CompressionBlock, CompressionState, Config, CoreMessage, ProcessTurnResult, StatusReport } from "./types.js";
export interface Ports {
    countTokens?: (text: string) => number;
    /** #4313 (toggle, PR #5236): enable immutable message timestamps — first-
     *  sight stamp minting into state.tsStamps and the <acp> tag's time
     *  attribute on the render node. Default false: neither runs, so a
     *  flag-off core renders byte-identically to pre-#4313 masters (hydrated
     *  ts values are carried but never displayed). Set true by hosts whose
     *  session opted in via compress.messageTimestamps / BILI_MESSAGE_TIMESTAMPS.
     *  Resolved ONCE per core (instance scope) — storage-layer stamping stays
     *  unconditional either way, so enabling later renders full history times. */
    timestamps?: boolean;
}
export interface CompressionCore {
    processTurn(input: ProcessTurnInput): ProcessTurnResult;
    /** Kernel primitive behind acp_retrieve: resolve a ref to its stored
     *  original plus the wire-safe injection pair (see ccr.ts). */
    retrieve(store: MessageContentStore, ref: string): ApplyRetrieveResult;
    applyCompression(input: ApplyCompressionInput): ApplyCompressionResult;
    defaultNodes(): PipelineNode[];
    decompress(blockId: string, state: CompressionState): CompressionBlock | undefined;
    search(query: string, state: CompressionState): CompressionBlock[];
    status(state: CompressionState, tokenCount: number, config: Config): StatusReport;
}
export interface ProcessTurnInput {
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    tokenCount: number;
    /** Where tokenCount came from:
     *   - "usage": a billing-grade reading (a fresh upstream input_tokens
     *     sample or a provenance-stable anchor derived from one).
     *   - "estimate": a local fallback (char-bound estimate — e.g. right
     *     after an aborted turn or a cache-TTL expiry that left no usage
     *     report). Such readings structurally run high relative to what will
     *     actually be billed.
     * Feeds the phantom-pressure guard: with nudge.requireUsageSampleForPressure
     * (default on) an ESTIMATE reading never arms the pressure band outright —
     * the injection is deferred one round until a usage-grade reading lands,
     * which costs nothing in practice (the next request carries the report).
     * The #5865 backstop bounds that deferral to nudge.maxEstimateHoldRounds
     * (default 2) consecutive estimate rounds so a backend that NEVER reports
     * usage cannot starve its pressure nudges forever. Omit for legacy behavior
     * (guard off). Non-pressure tiers are unaffected.
     */
    tokenCountSource?: "usage" | "estimate";
    /**
     * Which messages get an <acp> ref tag injected into their text
     * (the render-refs pipeline node). Refs are ALWAYS assigned regardless
     * (assign-refs node runs unconditionally).
     *   - "all" (default): tag every mapped message — in-process hosts
     *     like pai-acp want tags for the LLM to reference compress ranges.
     *   - "text-only": tag only user/assistant text; leave tool-call args
     *     and tool-result content pristine — proxy hosts where structured
     *     content must not be polluted.
     *   - "none": leave all text untouched — hosts that read the ref map
     *     directly from result.state.messageRefs.
     */
    renderTags?: RenderStrategy;
    /** Per-session CCR content store (pass result.contentStore back here).
     *  Omit for pre-CCR sessions — an empty store is used. */
    contentStore?: MessageContentStore;
    /** #3236: the EXACT message array class applyCompression will run on for
     * this lane. Hosts whose render view (`messages`) differs from the fold
     * view (pruned separators, host-side compaction tails) pass the unpruned
     * log here so recommendation screening and unit projection judge ranges on
     * the same class execute will — advertised and applied can't diverge.
     * Omit when `messages` already IS that class. */
    applyView?: CoreMessage[];
}
export interface ApplyCompressionInput {
    ranges: {
        startRef: string;
        endRef: string;
        summary: string;
        topic?: string;
        compressCallId?: string;
        summaryMaxChars?: number;
    }[];
    messages: CoreMessage[];
    state: CompressionState;
    config: Config;
    protectedMessageIds?: Set<string>;
}
/** #5698: a tier-1 fold answering the fire that offered `pending` tokens must
 *  reclaim at least this fraction of the offered mass for the T1 channel to
 *  count as draining. Partial compliance below it (production #5671: nudges
 *  offering ~450K answered by 3-6K folds) sets the harvest-stall flag so tier
 *  arbitration can route to mass-qualified distillation instead of starving
 *  it behind a never-draining T1. Measured against the fire's pendingT1, so
 *  eager lanes (fold the whole offer) never trip it. */
export declare const STALL_HARVEST_RATIO = 0.5;
export declare function createCore(ports?: Ports): CompressionCore;
export { createInitialState };
//# sourceMappingURL=compress.d.ts.map