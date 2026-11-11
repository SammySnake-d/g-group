/**
 * #5620: ref-recoverable media — classification + mechanical ref preservation.
 *
 * hasUnrecoverableMediaPayload (protected.ts) historically pinned EVERY
 * message whose media bytes bili cannot store locally — remote-URL images,
 * DeepSeek Files API `{type:"file"}` refs, Google fileData/videoMetadata.
 * In an image-heavy workflow that conflation built the #5620 usage wall:
 * each such message became a permanent non-foldable anchor, turn integrity
 * pinned its partners, folds kept pace with growth but the context floor
 * climbed to ~70% of the window and never came down.
 *
 * The fix splits the class: a media message is FOLDABLE when it exposes at
 * least one extractable re-access handle (a non-data: URL, a file id, a
 * fileUri). Folding then loses nothing unrecoverable — the handles ride the
 * stored summary verbatim (collectFoldMediaRefs appends them mechanically at
 * apply time, below), and decompress restores the original message
 * losslessly regardless. Only media with NO extractable ref stays pinned,
 * as do control-plane structured system messages (different mechanism —
 * folding those un-declares tools; untouched here).
 *
 * Conservative by design: only KNOWN ref shapes are enumerated. Unknown
 * opaque parts keep pinning (pre-#5620 behavior) until their semantics are
 * established — the litmus is "can the payload be re-acquired from the
 * surviving text alone?", and an unenumerated shape answers that with no
 * evidence either way.
 *
 * #5865-P2 (PR #5865 review F2): the litmus also requires the handle to be
 * DURABLE. A pre-signed/expiring HTTP(S) URL (S3/GCS/Azure-SAS/CDN tokens)
 * satisfies "has a ref" but lapses — by the time a folded summary is
 * decompressed (hours later by definition of folding) the handle is dead and
 * the payload is gone, whereas pre-#5620 pinned such messages forever. Such
 * URLs are therefore classified as NON-recoverable (the message keeps
 * pinning). Deliberately over-eager: a false positive only re-pins one media
 * message; a false negative silently loses the payload.
 */
import type { CompressionBlock, CoreMessage } from "./types.js";
/** #5865-P2: true when the ref is an HTTP(S) URL whose query carries a
 *  signed/expiring marker — its re-access is time-bounded, so it must not
 *  count as a durable re-access handle (see module header). */
export declare function looksEphemeralSignedUrl(ref: string): boolean;
/** Collect every re-access handle (non-data: URL / file id / fileUri) a
 *  message exposes across all five wire sidecar families, in stable
 *  sidecar-then-part order, deduplicated. Empty array = no extractable
 *  handle (the message's media, if any, is byteless-and-refless). */
export declare function extractMediaRefs(message: CoreMessage): string[];
/** True when msg carries at least one extractable re-access handle — the
 *  #5620 split of hasUnrecoverableMediaPayload's media class. */
export declare function hasRefRecoverableMediaPayload(message: CoreMessage): boolean;
/** Deterministic header of the mechanically-appended summary section. Exact
 *  match is the parse boundary — models are told to preserve it verbatim,
 *  and the append/strip/parse trio below is idempotent on it. */
export declare const MEDIA_REFS_MARKER = "MEDIA REFS (verbatim re-access handles \u2014 preserve when distilling):";
/** Parse the mechanically-appended section back out (empty when absent —
 *  summaries written before #5620 carry none). */
export declare function parseMediaRefsSection(summary: string): string[];
/** Append the canonical section (replacing any model-written twin, so a
 *  fold re-applied over the same content never double-lists). Returns the
 *  input unchanged when refs is empty. */
export declare function appendMediaRefsSection(summary: string, refs: readonly string[]): string;
/** Union of the re-access handles a fold must record: extracted from the
 *  newly-folded direct messages, plus carried forward from every consumed
 *  block's stored summary (merges/distillations must not drop handles their
 *  sources already recorded). Stable order: direct-message order, then
 *  consumed-block order, deduplicated. */
export declare function collectFoldMediaRefs(directMessages: readonly (CoreMessage | undefined)[], consumedBlocks: readonly (CompressionBlock | undefined)[]): string[];
//# sourceMappingURL=media-refs.d.ts.map