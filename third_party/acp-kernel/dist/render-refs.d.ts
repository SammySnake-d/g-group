import type { CoreMessage, CompressionState } from "./types.js";
import type { PipelineNode } from "./pipeline.js";
/**
 * Controls which messages get an <acp> ref tag injected into their text.
 * Ref assignment (assignRefsNode) is unconditional — every message always
 * receives a ref in state.messageRefs regardless of this setting. This only
 * governs text rendering:
 *  - "all": tag every mapped message (in-process hosts like pai-acp)
 *  - "text-only": tag only user/assistant text; leave tool-call args and
 *    tool-result content pristine (proxy hosts — structured content must not
 *    be polluted)
 *  - "none": leave all text untouched (hosts that read the ref map directly)
 */
export type RenderStrategy = "all" | "text-only" | "none";
/** #4313: epoch ms -> LOCAL wall-clock string "yyyy-mm-dd hh:mm:ss" for the
 *  <acp> tag's time attribute. The stored value is always epoch ms (stable
 *  across TZ), only the DISPLAY is local. Uses Date methods (getFullYear,
 *  getMonth, ...) NOT a wall-clock read of "now" — it formats a persisted
 *  timestamp, so prefix-cache is unaffected: re-formatting the same ms in the
 *  same TZ yields byte-identical output. */
export declare function formatTagTime(ms: number): string;
export declare function renderVisibleRefs(messages: CoreMessage[], state: CompressionState, countTokens?: (text: string) => number, strategy?: RenderStrategy, timestamps?: boolean): CoreMessage[];
export interface RenderWithSnapshotResult {
    messages: CoreMessage[];
    tokenSnapshot: Record<string, number>;
}
/** Render with a stable token snapshot: token counts are written on first
 *  render and reused forever (keyed by ref). The snapshot starts as a shallow
 *  copy of the persisted state so old entries survive; new entries are added
 *  during this render. */
export declare function renderWithSnapshot(messages: CoreMessage[], state: CompressionState, countTokens?: (text: string) => number, strategy?: RenderStrategy, timestamps?: boolean): RenderWithSnapshotResult;
/** Factory: build a render-refs node bound to a specific render strategy and
 *  timestamp flag (#4313 toggle — `timestamps` gates the <acp> time attribute;
 *  default false renders legacy bytes). */
export declare function createRenderRefsNode(strategy: RenderStrategy, options?: {
    timestamps?: boolean;
}): PipelineNode;
/** Backward compat: default render-refs node using strategy "all". */
export declare const renderRefsNode: PipelineNode;
//# sourceMappingURL=render-refs.d.ts.map