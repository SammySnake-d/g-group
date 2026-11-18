# REVIEW 1: APPROVE d853764d7237224e52a180808cea0912f90c69d4a6fe3f73f545772d82cfef5c

## Round 1 — APPROVE

- **PR**: `#127` (`feat/agy-http-ws-bridge` → `dev/agy-backend` at `76dd7ce4`)
- **Author**: `codex-cli:01a1f0a2-30c5-7282-9fe7-b1bd1996a12a` (`fnqtz-gpt/gpt-6.2-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-4-carbon-high`, vendor `google`)
- **Red Commit**: `774485ef35685d19a10c5e12c8fdc0b00d831c4f`
- **Green Commit**: `bb8a0fb427d20ab3892681b38d79d53aaca697f1` (merged with `dev/agy-backend` in `2aef1b1d239e68d302ac55c445835ec0a33c9e40`)
- **Reviewed HEAD**: `0fc23a6b19491db03a7a0039030804e981238346`
- **Reviewed Content Hash**: `d853764d7237224e52a180808cea0912f90c69d4a6fe3f73f545772d82cfef5c`

### 1. Code & Security Audit Summary

1. **Authentication & Secret Redaction (`packages/server/src/http-ws.ts:36-38, 67-73, 120`, `cli.ts:177`)**:
   - Token verification hashes both configured `options.token` and candidate tokens with SHA-256 and compares fixed 32-byte digests via `timingSafeEqual`, preventing length-oracle side channels and `RangeError` mismatches.
   - `POST /api/invoke` enforces `Authorization: Bearer <token>` (`401`) prior to reading request bodies; `GET /api/events` WebSocket upgrade accepts `Authorization: Bearer <token>` or `?token=<token>` (`401` on missing/mismatch) and never echoes credentials in `wsUrl`, CLI startup JSON, or error bodies; `GET /api/health` redacts `apiVersion` and `eventSeq` (`{ ok: true }`) whenever `token` is configured.
2. **CORS & URL Isolation (`http-ws.ts:39-66, 115-119`)**:
   - Parses `req.url` against fixed `"http://localhost"` so `Host` headers cannot influence routing.
   - Default CORS policy (`options.corsOrigins` omitted) permits non-browser requests without `Origin` and strictly restricts browser `Origin` headers to `http:` / `https:` loopback (`localhost`, `127.0.0.1`, `[::1]`) with exact `origin === url.origin` match — rejecting `https://evil.example`, `http://localhost.evil.example`, `"null"`, and `"file://"` (`403`) on both HTTP and WebSocket upgrade before executing RPCs or opening subscriptions.
3. **Payload Bounds & Envelope Validation (`http-ws.ts:24, 74-100`)**:
   - Caps `POST /api/invoke` bodies at `ATTACHMENT_UPLOAD_IPC_BYTES + 4096` on both declared `Content-Length` and streamed chunks (`413`), accepting near-35 MB base64 `attachments.upload` payloads (`25 MiB` raw / `34,952,536` base64 bytes) while preserving host-level decoded attachment limits and path isolation under `dataDir`.
   - Rejects malformed JSON and non-object/missing-`method` envelopes (`400`), unknown HTTP routes/methods (`404`), and WS upgrades during shutdown (`503`) or off `/api/events` (`404`).
4. **WebSocket Replay, Resync, Backpressure & Heartbeat (`http-ws.ts:121-153`, `bus.ts:32-40`)**:
   - Validates `sinceEventSeq` before upgrade (`400` on duplicate params, non-digits, negative or unsafe integers).
   - Replays missed events in monotonic `eventSeq` order when within ring capacity, or emits contract-valid `stream.resync` preserving `reason` / `eventSeq` / `at` alongside additive `oldestEventSeq` and `latestEventSeq` bounds when `since + 1 < oldest`.
   - Enforces `ws.bufferedAmount + Buffer.byteLength(data) > maxBufferedBytes` (`1008` close + immediate `dispose(ws)`), including synchronous replay overflow (`if (state.disposed) off()`), and bounds slow/dead sockets via `pingIntervalMs` `ping`/`pong` liveness + `wss.clients` sweep.
5. **Lifecycle & Codex Compute Wiring (`http-ws.ts:166-193`, `cli.ts:77-84, 164-180, 216-219`, `start.ts:51-58, 77`)**:
   - `bridge.close()` idempotently clears `pingTimer`, unsubscribes all WS clients, terminates sockets, and closes `wss` + HTTP `server` (`closeAllConnections()`). `serveHttpWs` and `cli.ts serve` cleanly run `bridge.close()` → `compute.close()` → `host.close()` on `SIGINT` / `SIGTERM` (and release `started` if `listen` fails).
   - `cli.ts serve --compute codex` and `startServer({ compute: "codex" })` wire P1-B `codexCompute` alongside `claudeCompute` and set `defaultHarness: "codex"`.

### 2. Independent Verification & Fault Injection Results

- **Static, Unit & Integration Verification**:
  - `npm run typecheck`: exit `0`.
  - `npm run lint`: exit `0` (`328` files checked, `0` errors, `0` warnings, `0` infos).
  - Full offline `npm test`: **`2171/2171` passed** (`0` failed, `0` cancelled, `0` skipped, `0` todo), including `13/13` in `packages/server/src/http-ws.test.ts` and `1/1` in `recall.test.ts` (`< 4000` UTF-8 bytes).
  - Live `cli.ts serve --compute codex` smoke: `POST /api/invoke` `settings.get` returned `{"ok":true,"defaultHarness":"codex","warning":null}`, `SIGTERM` exited `0`.
  - Red (`774485ef35685d19a10c5e12c8fdc0b00d831c4f`) replay: `tsc` exit `0`, **`13/13` failed** (`0` passed), `0` byte diff on `packages/server/src/http-ws.test.ts` between Red and HEAD.
- **Single-Site Fault Injections (`4/4` Killed)**:

| Fault ID | Target & Mutation | Result | Killing Test |
| --- | --- | --- | --- |
| `P1C-F1` | `http-ws.ts:73`: bypass HTTP `POST /api/invoke` Bearer check | **KILLED** (`exit=1`) | `P1-C auth: HTTP and WS reject missing/wrong tokens; header/query accepted without leaks` |
| `P1C-F2` | `http-ws.ts:120`: bypass WS `/api/events` header/query token check | **KILLED** (`exit=1`) | `P1-C auth: HTTP and WS reject missing/wrong tokens; header/query accepted without leaks` |
| `P1C-F3` | `http-ws.ts:135`: bypass WS `maxBufferedBytes` backpressure guard | **KILLED** (`exit=1`) | `P1-C WS backpressure closes consumer and removes listener, including synchronous replay` |
| `P1C-F4` | `http-ws.ts:141`: omit `if (state.disposed) off()` on synchronous replay | **KILLED** (`exit=1`) | `P1-C WS backpressure closes consumer and removes listener, including synchronous replay` |

- **Honesty & Scope Boundaries**: `AC-05`, `AC-31`, `AC-46`, and `AC-51` remain honestly marked `"未测"` in `receipts/feat-agy-http-ws-bridge.json`, `docs/BACKEND-PROGRESS-CHECKLIST.md`, `docs/spec/验收文档-v0.1.md`, and `README.md` pending frontend UI smoke and P3 `D+X` verification.
