/**
 * ACP tool surface: the tool schemas (Anthropic / OpenAI chat / Responses
 * flat), the system-prompt builders for the three protocols (function tools,
 * text triggers, hybrid), and the lenient compress-argument parser.
 *
 * Single source for every downstream that injects the ACP tools into a
 * request (the billion-context proxy on the wire; hosts via their own tool
 * registration). The content is static — no transport, no state, no host
 * types. Moved from billion-context `src/compress-tool.ts` (Phase K1).
 */
import { type Prompts } from "./prompts.js";
import { type CompressPromptSections } from "./surface-config.js";
export declare const COMPRESS_TOOL_NAME = "compress";
export declare const DECOMPRESS_TOOL_NAME = "decompress";
export declare const SEARCH_CONTEXT_TOOL_NAME = "search_context";
export declare const ACP_STATUS_TOOL_NAME = "acp_status";
export declare const ACP_CACHE_TOOL_NAME = "acp_cache";
export declare const ABSORB_TOOL_NAME = "absorb";
/** Text-protocol trigger tags. The model emits these in its text output to
 *  request compression (used when host client tools cannot coexist with a
 *  declared `tools` field — e.g. OpenAI Codex code_mode). Distinct from the
 *  `<acp tokens=...>` history tags so they never collide. */
export declare const ACP_TEXT_OPEN = "<acp_compress>";
export declare const ACP_TEXT_CLOSE = "</acp_compress>";
export declare const ACP_STATUS_OPEN = "<acp_status>";
export declare const ACP_STATUS_CLOSE = "</acp_status>";
export declare const ACP_SEARCH_OPEN = "<acp_search>";
export declare const ACP_SEARCH_CLOSE = "</acp_search>";
export declare const ACP_DECOMPRESS_OPEN = "<acp_decompress>";
export declare const ACP_DECOMPRESS_CLOSE = "</acp_decompress>";
/** Object-form range entry. Both bound spellings are declared because
 *  parseCompressArgs accepts both (startRef/endRef canonical, startId/endId
 *  legacy drift) — a pre-validating host must reject nothing the kernel
 *  accepts (#374). */
/**
 *  Shared parameter schema for every compress wire shape (anthropic
 *  `input_schema`, openai `function.parameters`, responses flat
 *  `parameters`).
 *
 *  ADVERTISED FORM (#4252 decision, completed 2026-10-26): exactly one —
 *  content = ONE plain string holding ALL ranges (line form), declared as
 *  a single {type:"string"}. The earlier #4252 pass rewrote only the prose
 *  and kept the anyOf branches; guided-decoding models still blended the
 *  branches into parser-invalid hybrids (bili gate 2026-10-26: content sent
 *  as an array of headerless bare-summary strings with a top-level topic),
 *  so the array alternatives and the top-level `topic` declaration are now
 *  structurally removed. The parser keeps honoring every legacy shape
 *  (array content of line strings / range objects, the flat single-range
 *  call, summary-as-plain-text with top-level refs, top-level topic) —
 *  narrowing is advertise-side only.
 *
 *  Contract (#374, still holds for the object shell): the schema stays an
 *  OPEN object schema — no top-level `required`, no
 *  `additionalProperties: false` — so a flat single-range call
 *  {startId, endId, summary} and an undeclared top-level `topic` still
 *  validate. One deliberate acceptance-set reduction vs the pre-2026-10
 *  schema: `content` as a JSON ARRAY no longer validates (the kernel
 *  parser still honors it). Do not add strictness here without
 *  re-checking parse-compress-input.ts.
 *
 *  Wire-legality constraint (bili #1299, fixed after the #374 follow-up
 *  regressed it): the TOP LEVEL stays a plain object schema — no
 *  `oneOf`/`allOf`/`anyOf`/`not`. Anthropic rejects tool input_schema with
 *  top-level combinators (400 on every request carrying the tool).
 *  Copilot Gemini needs scalar types; the single string branch is
 *  trivially compliant.
 */
export declare const COMPRESS_PARAMETERS: {
    type: string;
    properties: {
        content: {
            type: string;
            description: string;
        };
    };
};
export declare const COMPRESS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
};
export type ParsedRange = {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    compressCallId?: string;
};
/** Lenient parse of a compress tool-call argument object into ranges.
 *  Accepts `content` as an array or a JSON-encoded string (non-strict-tool
 *  providers stringify array args, e.g. vLLM openai-completions), a single
 *  range object at the top level, and both startId/startRef spellings.
 *  `onWarn` receives diagnostics for rejected shapes — the kernel stays
 *  side-effect free, downstream wires its logger. */
export declare function parseCompressInput(input: unknown, callId?: string, onWarn?: (message: string) => void): ParsedRange[];
export declare const COMPRESS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                content: {
                    type: string;
                    description: string;
                };
            };
        };
    };
};
export declare const FUNCTION_ACP_TAGS_TIMESTAMPED = "ACP TAGS\n\nAddressable messages in the conversation are annotated with a <acp tokens=\"2.1K\" type=\"tool:bash\" time=\"2026-10-30 09:02:11\">m00175</acp> tag showing its reference ID, approximate token size, content type, and local time of occurrence (yyyy-mm-dd hh:mm:ss). Ordering: smaller ref number = earlier message; smaller time = earlier message. These tags are system metadata injected by the proxy. NEVER echo, repeat, or reference these XML tags in your responses \u2014 the tags must not appear in your output. Use only the ref ID (e.g. m00005) inside compress calls, never the XML wrapper. The token size is approximate \u2014 treat it as a relative guide, not an exact count.";
export declare const TEXT_ACP_TAGS_TIMESTAMPED = "ACP TAGS\n\nAddressable messages in the conversation are annotated with a <acp tokens=\"2.1K\" type=\"tool:bash\" time=\"2026-10-30 09:02:11\">m00175</acp> tag showing its reference ID, approximate token size, content type, and local time of occurrence (yyyy-mm-dd hh:mm:ss). Ordering: smaller ref number = earlier message; smaller time = earlier message. These tags are system metadata. NEVER echo these history tags. Use only the ref ID (e.g. m00005), never the XML wrapper.";
export declare function buildCompressSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare function buildCompressTextSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare function buildCompressHybridSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string;
export declare const DECOMPRESS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                blockId: {
                    type: string;
                    description: string;
                };
                toFile: {
                    type: string;
                    description: string;
                };
                full: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const SEARCH_CONTEXT_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const ACP_STATUS_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                scope: {
                    type: string;
                    description: string;
                };
                view: {
                    type: string;
                    description: string;
                };
                tool: {
                    type: string;
                    description: string;
                };
                sort: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
                archiveDetail: {
                    type: string;
                    description: string;
                };
            };
        };
    };
};
export declare const ACP_CACHE_TOOL_DESCRIPTION = "Prompt-cache reconciliation: grand ledger (total input/cached/output, overall hit rate) with every request's miss split into new content / compression re-pay / upstream-ttl-or-client-rewrite (unattributed stable-prefix misses), plus per-fold economics (breakeven turns vs measured cadence). Defaults to a compact summary (totals + verdicts + anomalies only); pass detail=\"full\" for every fold and its line-item breakdown. Read-only. Call when asked about cache hits, cache invalidation, or what compression costs.";
export declare const ACP_CACHE_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                detail: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
    };
};
export declare const ACP_TOOLS_OPENAI: readonly [{
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                content: {
                    type: string;
                    description: string;
                };
            };
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                blockId: {
                    type: string;
                    description: string;
                };
                toFile: {
                    type: string;
                    description: string;
                };
                full: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                scope: {
                    type: string;
                    description: string;
                };
                view: {
                    type: string;
                    description: string;
                };
                tool: {
                    type: string;
                    description: string;
                };
                sort: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
                archiveDetail: {
                    type: string;
                    description: string;
                };
            };
        };
    };
}, {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                detail: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
    };
}];
/** Anthropic-format tools (name + description + input_schema). The Anthropic
 *  request path (ZCode, Claude Code) injects all four so the model can
 *  actually call compress/decompress/search_context/acp_status — the system
 *  prompt describes all four, so declaring only COMPRESS_TOOL left the model
 *  able to see the docs but unable to call the rest. */
export declare const DECOMPRESS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
};
export declare const ACP_CACHE_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
export declare const ACP_TOOLS_ANTHROPIC: readonly [{
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
}, {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
export declare const COMPRESS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
};
export declare const DECOMPRESS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
};
export declare const ACP_CACHE_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
/** All ACP tools in Responses API flat format, matching ACP_TOOL_NAMES. */
export declare const ACP_TOOLS_RESPONSES: readonly [{
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
/** Read-only ACP tools (no compress) in Responses flat format. Used for the
 *  hybrid protocol (codex): compress stays a text marker (batch + STOP), while
 *  decompress/search_context/acp_status are injected as real function tools so
 *  the model can call them directly instead of emitting text triggers.
 *  Empirically (direct comfly A/B) declaring these tools does NOT disable
 *  codex code_mode — the earlier "tools can't coexist" assumption was wrong. */
export declare const ACP_READONLY_TOOLS_RESPONSES: readonly [{
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
}, {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
/** All ACP tool names (dynamic membership — Set, not a static record). Does
 *  NOT include absorb or acp_retrieve: both are opt-in (config.absorb.enabled
 *  / config.ccr.enabled) and hosts only register/inject them when on. */
export declare const ACP_TOOL_NAMES: ReadonlySet<string>;
/** compress/decompress: mutate history → must drive the compress loop (their
 *  result is folded into the request before the model continues). */
export declare const ACP_MUTATING_TOOLS: ReadonlySet<string>;
/** acp_status/search_context/acp_cache: read-only → must NOT loop. Looping them
 *  made the model re-call until the 5× limit and discarded the whole turn. */
export declare const ACP_READONLY_TOOLS: ReadonlySet<string>;
/** Opt-in absorb tool (instant tool-result absorption). Inject/register only
 *  when config.absorb.enabled — NOT part of ACP_TOOLS_* arrays. */
export declare const ABSORB_TOOL_DESCRIPTION = "Distill a tool result into a compact summary you write. REQUIRED immediately after a tool result ends with an [ACP absorb] instruction: pass its ref and the distilled essentials (outcome, key values, paths:lines, errors, decisions). The original output is then removed from context; your summary is the durable record. If nothing worth keeping survives, say so in the summary (e.g. '(nothing needed)') \u2014 that discards the output cleanly.";
export declare const ABSORB_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
            summary: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ABSORB_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                ref: {
                    type: string;
                    description: string;
                };
                summary: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const COMPRESS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
};
export declare const DECOMPRESS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const SEARCH_CONTEXT_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const ACP_STATUS_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
};
/** #5555 audit: google previously shipped acp_status but NOT acp_cache —
 *  Gemini lanes could be asked about cache economics through prose alone. */
export declare const ACP_CACHE_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
};
/** All ACP tools in Gemini flat format, matching ACP_TOOL_NAMES. */
export declare const ACP_TOOLS_GOOGLE: readonly [{
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            content: {
                type: string;
                description: string;
            };
        };
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            blockId: {
                type: string;
                description: string;
            };
            toFile: {
                type: string;
                description: string;
            };
            full: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            scope: {
                type: string;
                description: string;
            };
            view: {
                type: string;
                description: string;
            };
            tool: {
                type: string;
                description: string;
            };
            sort: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            archiveDetail: {
                type: string;
                description: string;
            };
        };
    };
}, {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            detail: {
                type: string;
                enum: string[];
                description: string;
            };
        };
    };
}];
/** Opt-in absorb tool in Gemini flat format (config.absorb.enabled). */
export declare const ABSORB_TOOL_GOOGLE: {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
            summary: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
/** Opt-in retrieve tool (lossless content-cached retrieval). Inject/register
 *  only when config.ccr.enabled — NOT part of ACP_TOOLS_* arrays (same
 *  opt-in pattern as absorb). */
export declare const RETRIEVE_TOOL_NAME = "acp_retrieve";
export declare const RETRIEVE_TOOL_DESCRIPTION = "Retrieve the full original text of a stored tool result. REQUIRED when you need details from a placeholder that starts with \uD83D\uDCE6 [acp-stored #mNNNNN: pass its ref. Returns the exact original text inline \u2014 very large originals are exported to a file instead, and the result then carries the exported file's path. The placeholder stays in context. Unknown refs return not-found.";
export declare const RETRIEVE_TOOL: {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare const RETRIEVE_TOOL_OPENAI: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: {
                ref: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const RETRIEVE_TOOL_RESPONSES: {
    type: "function";
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: {
            ref: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
//# sourceMappingURL=compress-tools.d.ts.map