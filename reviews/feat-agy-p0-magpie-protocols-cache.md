# REVIEW 1: APPROVE 519620f5cdff74209164e426f87ff0db200f17370ace14760b9119e8dc58de3e

## Round 1 — APPROVE

- **PR**: `#123` (`feat/agy-p0-magpie-protocols-cache` → `dev/agy-backend` at `d5f2fcb3cdb5239f63b96a8a043a99791757046a`)
- **Author**: `codex-cli:01a1ed38-962c-75b1-b7fd-5fd31c90467d` (`shayu/gpt-6.2-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-4-carbon-high`, vendor `google`)
- **Red Commit**: `766c1a17971377d063fe850980a34f36948a9baf`
- **Green Commit**: `6f6f969176581bd05ded5904b173c49ed632280a`
- **Reviewed HEAD**: `96683c49b8f6b2d03cd6980a618e120c2640558d`
- **Reviewed Content Hash**: `519620f5cdff74209164e426f87ff0db200f17370ace14760b9119e8dc58de3e`

### 1. Subsystem & Specification Audit

1. **Four Native Codecs, Session Affinity & Redaction (`protocols.ts`, `request.ts`, `usage.ts`)**:
   - Directly reuses `@earendil-works/pi-ai/api/*.lazy` (`anthropicMessagesApi`, `openAICompletionsApi`, `openAIResponsesApi`, `googleGenerativeAIApi`) in `packages/adapter-pi-contact/src/protocols.ts` with zero custom wire-codec reimplementation (R-05).
   - `modelForProtocol` constructs typed per-codec `compat` (`anthropic-messages`: `{ sendSessionAffinityHeaders }`, `openai-chat`: `{ sendSessionAffinityHeaders, sessionAffinityFormat: "openai" }`, `openai-responses`: `{ sessionAffinityFormat: "openai" }`, `google-generative-ai`: omitted), and `streamRequest` attaches `session_id` / `x-client-request-id` / `x-session-affinity` on OpenAI codecs while passing `cacheRetention: "none"` so no explicit `prompt_cache_retention` payload field is emitted.
   - `redactEndpointError` scrubs `apiKey`, URL userinfo, non-version path segments, query values, full `http(s)://` URLs, and email addresses; `usageLine` records `${provider}|${hostname}|${model}` without leaking ports, paths, query params, or credentials.

2. **Magpie Read-Only Discovery, Pre-Commit Same-Model Failover, Health Cache & Reasoning Floor (`magpie.ts`, `request.ts`, `pi-runtime.ts`, `host.ts`)**:
   - `discoverMagpieGateway` reads only `gateway.json` (`addr`), verifies `GET /api/hello` (`name === "magpie"`) **before** sending any credential, then fetches `GET /v1/models` with `Bearer` auth and maps `native_endpoints` authoritatively (`REASONING_ORDER` prioritizes `openai-responses` for reasoning/tool-call models). Never touches `~/.config/magpie/` writes or private upstream config files.
   - `withProtocols` + `streamRequest` enforce strict pre-commit failover on the exact same `cfg.model`: any observable delta (`text_delta`, `thinking_delta`, `toolcall_start`/`delta`/`end`, non-empty `text_end`/`thinking_end`), multi-request round progress (`requests > 1`), or `recordUsage` sink commit sets `attempt.committed = true`, barring protocol failover and propagating `PiContactMindError(..., committed = true)` so `Host.onContactFailure` surfaces a failure card without re-running a committed round and `Host.settleNote` preserves pending material without issuing a duplicate fallback compaction.
   - `ProtocolHealthCache` enforces exponential cooldowns `[60_000, 120_000, 300_000, 600_000]` (`1m → 2m → 5m → 10m`) scoped to `(origin, model, protocol)`, probes the earliest-expiring candidate when all candidates are cooling, resets on success, and is shared across `gateway`, `mind`, and `compactor` in `makePiRuntime`.
   - Reasoning output-token floor `>= 8192` is enforced in both `probeModelConnection` (`Math.max(cfg.maxTokens, 8192)`) and `makePiRuntime` (`selected.reasoning ? { maxTokens: 8192 } : {}`) across contact rounds and reflection.

3. **Prompt Cache Placement & Observability (`adapter-pi-contact/src/usage.ts`, `cache-stats.ts`, `server/src/usage.ts`, `api-contract/src/usage.ts`)**:
   - `placeBreakpoints` clones the outgoing Anthropic payload without mutating input and collapses `cache_control` markers to `<= 3` (`<= 4` Anthropic cap: last tool, last system block, last message tail block), preserving `ttl` when present and leaving unmarked payloads untouched.
   - `probeRequest` hashes `{ tools, system }` per codec (`system` for Anthropic, leading `system`/`developer` messages for `openai-chat`, `{ instructions, leading }` for `openai-responses`, `systemInstruction` for Google) and sets `explicitBreakpoints: false` on the three automatic-caching codecs so `hitWithoutBreakpoint` only flags unmarked Anthropic calls while `constantRatio` still flags kiro-style 4:1 split accounting across all four codecs.
   - `usage.cacheStats` RPC exposes `constant-ratio`, `hit-without-breakpoint`, `first-segment-only`, `cold`/`prefix-changed`/`expired`/`uncached` miss attribution, and optional `low-hit-rate` thresholds while preserving full RPC backward compatibility (`94 → 95` methods, `0` removed).
   - `DEFAULT_STATE_NOTE_MAX_BYTES = 8192` is wired into `start.ts` and `cli.ts`, and `recall.test.ts` confirms the Block-1 `wirePrefix` stays `< 4000` UTF-8 bytes.

4. **Turn-Boundary `speakingModel` Hot-Swap (`host.ts`, `model-config.ts`, `b4-hotswap-speaking.test.ts`)**:
   - `Host.runRound` pins `const model = prior?.model_override ?? contact.speakingModel` once at turn start and passes `{ ...contact, speakingModel: model }` to both `mind` and `settleNote` (`reflect` + `shrink`), preventing mid-turn `contacts.update`, `settings.update`, or `models.batchReplace` from splitting a turn across models.
   - `speakingModelInherited` cleanly distinguishes contacts inheriting `defaultSpeakingModel` from contacts with explicit `speakingModel` (or rolled-back config snapshots), so `settings.update` and `models.batchReplace` propagate to inherited contacts on the very next turn while preserving contact state (`note`, `memory`, cursors) and never falling back to the old model on upstream rejection.

5. **Honest Acceptance & Receipt Boundaries (`receipts/feat-agy-p0-magpie-protocols-cache.json`)**:
   - `R-05` is backed by deterministic proof (`packages/server/proof/b4-magpie-protocols-cache.txt`), while `AC-39`, `AC-51`, `AC-32`, and `AC-36` are honestly kept `"未测"` with explicit scope reasons because the live `ling-jing/deepseek-v4.1-flash` upstream returned HTTP 502 (`local_magpie.exit_code: 1`) and full UI/X-layer + B8 Codex harness coverage remain in subsequent slices.

### 2. Independent Verification & Fault Injection

- **Typecheck & Lint**: `npm run typecheck` (exit `0`) and `npm run lint` (`293` files checked by Biome, exit `0`) passed in clean isolated clone `/tmp/gg-agy-rev-b4`.
- **Full Offline Test Suite**: `npm test` passed **`2016/2016`** (`0` failed, `0` cancelled, `0` skipped, `0` todo) completely offline without touching local `~/.config/magpie/`.
- **Red Commit Replay (`766c1a17971377d063fe850980a34f36948a9baf`)**: `tsc -p tsconfig.json` exited `0`; replaying the 4 changed test files failed **`43/43`** (`# pass 0`, `# fail 43`, `# skipped 0`); zero test diff between Red `766c1a17` and Green `6f6f9691`.
- **Block-1 Prefix Budget Check**: `node --test packages/adapter-pi-contact/src/recall.test.ts` passed (`1/1`, `< 4000` UTF-8 bytes).
- **Independent Reviewer Single-Site Fault Injections (`6/6` Killed)**:

| Fault ID | Target Site | Injected Mutation | Result | Killing Test(s) |
| :--- | :--- | :--- | :--- | :--- |
| `B4-F1` | `packages/adapter-pi-contact/src/request.ts:117` | Disable post-commit failover guard (`if (false && attempt.committed)`) | **KILLED** (`4` failures) | `protocols.test.ts` — `B4 text, thinking and tool deltas independently bar failover after an SSE error` |
| `B4-F2` | `packages/adapter-pi-contact/src/protocols.ts:137` | Flatten `COOLDOWNS` schedule to `[60_000, 60_000, 60_000, 60_000]` | **KILLED** (`1` failure) | `protocols.test.ts` — `B4 cache cooldowns are 1m, 2m, 5m, 10m, 10m; all-cooling probes earliest expiry and success resets` |
| `B4-F3` | `packages/server/src/pi-runtime.ts:54` | Drop reasoning output-token floor (`selected.reasoning ? { maxTokens: 8192 } : {}` disabled) | **KILLED** (`1` failure) | `server/src/usage.test.ts` — `B4 Magpie reasoning models get at least 8192 output tokens for both contact rounds and reflection` |
| `B4-F4` | `packages/adapter-pi-contact/src/usage.ts:43` | Bypass `placeBreakpoints` marker collapse (`return p` before stripping) | **KILLED** (`1` failure) | `adapter-pi-contact/src/usage.test.ts` — `B4 breakpoint placement collapses oversized Anthropic markers without mutating the input` |
| `B4-F5` | `packages/server/src/cache-stats.ts:123` | Ignore `explicitBreakpoints !== false` in `hitWithoutBreakpoint` | **KILLED** (`1` failure) | `server/src/usage.test.ts` — `B4 RPC persists and respects implicit breakpoints for all three automatic codecs while catching 4:1 billing on each` |
| `B4-F6` | `packages/server/src/host.ts:3265` | Read live `contactDoc` `speakingModel` instead of turn-pinned `model` in `settleNote` | **KILLED** (`2` failures) | `server/src/b4-hotswap-speaking.test.ts` — `B4 contacts.update holds the old model through round, reflection and shrink, then next round retains contact state` |

### Verdict

Zero blocking or non-blocking defects found. **APPROVE** (`519620f5cdff74209164e426f87ff0db200f17370ace14760b9119e8dc58de3e`).
