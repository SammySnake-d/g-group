# REVIEW 1: REJECT 072fb2d2c5c56ec555fa7e061fcd40b47f5e3d6bfda6af0d114b6ad6004575d2

## Round 1 — REJECT

- **PR**: `#124` (`feat/agy-priority-context-memory-playbook` → `dev/agy-backend` at `46284e53`)
- **Author**: `codex-cli:01a1eda8-b7c7-77c3-9505-693220ca61f5` (`ling-jing/gpt-6.1-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-3.8-flash-high`, vendor `google`)
- **Red Commit**: `92166d1f6c50181304322102163ffd187698af73`
- **Green Commit**: `6d0dcac40b4e967aa6dda809bf3ba768d349edc3`
- **Reviewed HEAD**: `9c15aa8ed002d77d6769f3d4b89df48b11ef52cb`
- **Reviewed Content Hash**: `072fb2d2c5c56ec555fa7e061fcd40b47f5e3d6bfda6af0d114b6ad6004575d2`

### 1. Blocking Defects (P1 — All 3 Live-Reproduced Against HEAD)

#### P1-1: `Host.settleNote` `capture()` silently records `state: "ok", unresolved: 0` on partial-failure batches and overwrites `work.writes` per item (`G1-03P` violation)
- **Location**: `packages/server/src/host.ts` (`settleNote` → `capture()`), `packages/server/src/memory-api.test.ts:191-206`.
- **Root Cause**: Inside `for (const m of r.memories)`, `capture()` calls `coverage.prepare(work.id, [singleWrite], unresolved)` and `coverage.apply(work.id)` **once per valid item**. When `r.memories` contains `[legitimate, fabrication]` (the exact scenario in `memory-api.test.ts:191-206`):
  1. Item 1 (`legitimate`) succeeds while `unresolved === 0`, so `coverage.prepare` + `coverage.apply` commits `state: "ok", unresolved: 0, error: null`.
  2. Item 2 (`fabrication`) fails `validateCapture`, increments local `unresolved` to `1`, and `continue`s.
  3. After the loop, `if (coverage.get(work.id).writes === null)` is `false`, so the rejected candidate is **never recorded** in `MemoryCoverage` (`unresolved` stays `0`, `state` stays `"ok"`).
  4. For 2+ valid items, each iteration overwrites `work.writes` with `[singleWrite]`, breaking `MemoryCoverage` batch crash-recovery/rollback for earlier writes in the same batch (and `id = ${work.id}:${m.roomId}:${m.sourceSeq}:${m.title}` collides if two entries in one batch share `(roomId, sourceSeq, title)`).
  5. `memory-api.test.ts:203` masked the bug because `assert.match(JSON.stringify(rows), /captured|writesDone|unresolved/)` matched the JSON key name `"unresolved":0`.
- **Live Reproduction Evidence**:
  - Executed `memory-api.test.ts:191-206` scenario against HEAD `9c15aa8e`: persisted `memory-coverage:*` doc was `{"state":"ok","unresolved":0,"writesLen":1,"error":null}` despite 1 rejected fabrication.
- **Required Fix**:
  - Plan all structured writes across the batch against a working copy of visible memories (`entries`), assign unique per-item write IDs (e.g. include loop index), accumulate `writes: CaptureWrite[]` and `unresolved`, and call `coverage.prepare(work.id, writes, unresolved)` + `coverage.apply(work.id, notify)` **once** after the loop.
  - Add/update test assertions verifying `cov.state === "failed"` and `cov.unresolved === 1` when `[valid, invalid]` are returned in the same `reflect()` batch, and that multiple valid memories in one batch are all retained in `work.writes`.

#### P1-2: `Host.settleNote` `capture()` passes `this.memory.listAll(contactId)` to `planMemoryWrite`, leaking `source-retracted` hidden memories into write-relation matching (`AC-08` / `memory-hygiene.ts` ① violation)
- **Location**: `packages/server/src/host.ts` (`settleNote` → `const before = this.memory.listAll(contactId)`).
- **Root Cause**: `memory-hygiene.ts` explicitly mandates that source-retracted memories are invisible to the contact across all read paths **including write-relation neighborhoods** ("写入判关系时也不当邻域"), and `Host.rememberTx` (`host.ts:2786`) correctly passes `this.memory.list(contactId)`. In contrast, `settleNote` `capture()` passes `this.memory.listAll(contactId)`, which includes `source-retracted` entries whose `status` is still `"active"`.
- **Live Reproduction Evidence**:
  - Seeded structured memory `m1` from message `#1` (`"以后都用中文回复"`), retracted `#1` (`host.memory.list(c.id).length === 0`), then sent `#3` (`"以后都用中文回复"`). Structured `reflect()` matched retracted `m1` as `"restate"` (`sameAsRetractedId: true`, `mem0SourceSeq: 1`, `mem0Evidence: [{ seq: 3 }]`), resurrecting a memory whose `source.seq` points to retracted message `#1` instead of creating a clean new entry anchored to `#3` (and similarly allowing `change`/`refine`/`conflict` against hidden retracted entries).
- **Required Fix**:
  - Plan structured memory writes against `this.memory.list(contactId)` (visible memories only), keeping `before` snapshots consistent with disk entries. Add a regression test verifying retracted memories are ignored by structured `reflect()` write planning.

#### P1-3: `capture()` commits structured memories inside `settleNote` before `commitRound`'s `GroupReplyStaleError` check, and drops `plan.kind === "ask-user"` conflict prompts
- **Location**: `packages/server/src/host.ts` (`settleNote` `capture?.()` before `commitRound`; `question: null` / omitted `notify` in `coverage.apply(work.id)`).
- **Root Cause**:
  1. `settleNote` runs `capture?.()` before `commitRound` checks whether another contact replied in the group (`GroupReplyStaleError`). When `commitRound` throws `GroupReplyStaleError`, the round is abandoned as `"stale"` without advancing cursors, yet `capture()` has already written `.md` files, `gg_memory` rows, and `memory-coverage:*` records to disk/SQLite.
  2. When `planMemoryWrite` returns `plan.kind === "ask-user"` (conflict between two `userQuote: true` memories per D25), `capture()` sets `question: null` and does not pass a `notify` callback to `coverage.apply(work.id)`, silently dropping the conflict confirmation message to the user.
- **Live Reproduction Evidence**:
  - In a 2-contact group where contact `b` posts while contact `a` is reflecting, `commitRound` threw `GroupReplyStaleError` and retried, yet `host.listMemories(a.id)` already contained `["stale-write"]` from the abandoned round.
- **Required Fix**:
  - Gate structured memory capture execution behind `commitRound`'s `GroupReplyStaleError` check (so stale/abandoned rounds commit zero `.md`/SQLite memory writes), and populate `question` + pass `notify` to `coverage.apply` when `plan.kind === "ask-user"`.

### 2. Non-Blocking Notes (P2)

- **`memory-coverage.test.ts` CAS guard gap**: Independent fault injection `P1A-F3` (disabling `!isDeepStrictEqual(disk, write.before[i] ?? null)` in `packages/server/src/memory-coverage.ts:52`) survived (`0` failures). Adding a test for concurrent external `.md` modification during `apply()`/`invalidate()` is recommended.
- **`playbook.ts` read-path write churn & event parity**: `PlaybookStore.list()` executes `UPDATE gg_playbook` (refreshing `updatedAt`) on every read even for entries already invalidated and scrubbed (`"来源已撤下"`). Also `PlaybookStore.clone()` does not emit `room.updated` on `host.bus` when no announcements are copied.
- **`memory-write-neighbors.test.ts:35`**: 1 Biome info diagnostic (`lint/style/useTemplate`) can be cleaned up when tests are updated in Round 2.

### 3. Verified Passing Areas & Independent Evidence

- **Passing subsystems**:
  - `SpeakingSnapshot` (`model-config.ts`, `speaking.ts`, `pi-runtime.ts`, `start.ts`, `cli.ts`): immutable per-round snapshot, sha256 fingerprint over non-secret fields + `bootId`, secret rejection without echo, turn-boundary replacement across `contacts.update` / `settings.update` / `models.batchReplace` / `contacts.rollback` preserving note & memory.
  - `memory-capture.ts`: `messageRevision`, `statedIn` (CN/EN hypotheticals & questions), `directLines` (quote/code/attribution filtering), `validateCapture` & `decodeReflect`.
  - `memory-hygiene.ts` & `memory-api.ts`: `HygienicMemoryStore` startup md/SQLite digest check & rebuild, `purgeHiddenPrefix`, `rewoundTexts` + `rescrubNotes`, owner-only `memory.*` RPCs & `contacts.profile` `longTerm` view.
  - `Host.memoryNeighbors`: C95-01..05 hard filters + title/body retrieval + relevance DESC / lexical ID ASC verified.
  - `PlaybookStore` & `rooms.clone`: active immediately (`WITHOUT ROWID`), separate from announcements, Block-5-only injection, clean-room clone without messages/tasks/cursors/docs/links, retract/hide/rewind invalidation & scrubbing.
  - **Block-1 prefix budget**: `packages/adapter-pi-contact/src/recall.test.ts` passed (`1/1`, `< 4000` UTF-8 bytes).
  - **RPC backward compatibility**: `95 → 105` methods (`0` removed, `10` additive).
  - **Docs & Receipt honesty**: `docs/BACKEND-PROGRESS-CHECKLIST.md`, `docs/spec/验收文档-v0.1.md` §11 (pure append), `README.md`, and `receipts/feat-agy-priority-context-memory-playbook.json` honestly keep `AC-42`/`AC-08`/`AC-32`/`AC-54` `"未测"` and mark DM#2103 as candidate.
- **Independent Verification Runs**:
  - `npm run typecheck`: exit `0`.
  - `npm run lint`: exit `0` (`309` files checked, `0` warnings/errors, `1` info).
  - Full offline `npm test`: **`2079/2079` passed** (`0` failed, `0` skipped, `0` cancelled, `0` todo).
  - Red commit (`92166d1f`) replay: `tsc -p tsconfig.json` exit `0`; `65/65` tests failed (`0` pass, `0` skip); empty test diff between Red `92166d1f` and Green `6d0dcac4`.
  - Single-site fault injections (`5/6` killed, `1` survivor noted in P2):
    - `P1A-F1` (`model-config.ts` `authRef` regex bypass): **KILLED** (`1` failure, `speaking-endpoint.test.ts`).
    - `P1A-F2` (`memory-capture.ts` `CHINESE_HYPOTHETICAL` bypass): **KILLED** (`1` failure, `memory-capture.test.ts`).
    - `P1A-F3` (`memory-coverage.ts:52` concurrent-disk-edit CAS guard bypass): **SURVIVED** (`0` failures — see P2 note).
    - `P1A-F4` (`memory-hygiene.ts:111` `purgeHiddenPrefix` bypass): **KILLED** (`1` failure, `memory-hygiene.test.ts`).
    - `P1A-F5` (`host.ts` `memoryNeighbors` body omitted from `searchHistory`): **KILLED** (`1` failure, `memory-write-neighbors.test.ts`).
    - `P1A-F6` (`playbook.ts:89` `clone` retained-member filter bypass): **KILLED** (`1` failure, `playbook.test.ts`).

### 4. Infrastructure Note (`G-PROVENANCE` Model Regex)

- After `@coordinator` switched `@reviewer-carbon` to `gemini-3.8-flash-high`, Antigravity `conversations/<id>.db` records `gemini-3.8-flash-s` in `gen_metadata`, which does not match `scripts/gates/gates.ts:141` `AGY_MODEL_RE` (`gemini-\d+-[a-z][\w-]*` lacks dotted versions like `3.8`). Before Round 2 approval can pass `G-PROVENANCE` (`8/8`), `@coordinator` will need either to switch `@reviewer-carbon` to a model matching `AGY_MODEL_RE` or land a base-branch update to `AGY_MODEL_RE`.


---

# REVIEW 2: APPROVE b21e64891feba05f2087b41a7044dde14272acb56add560992ad57eda7b28f2e

## Round 2 — APPROVE

- **PR**: `#124` (`feat/agy-priority-context-memory-playbook` → `dev/agy-backend` at `618fb79a`)
- **Author**: `codex-cli:01a1ee5f-e210-7b00-892f-836f6421b2c2` (`ling-jing/gpt-6.1-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-3.8-flash-high`, vendor `google`)
- **Combined Red Commit**: `2f3d0f2279e4dfd88e81ea4c32dfcc3504c11996`
- **Green Commit**: `1a9f8f9b9e019832807883ee8052d41a266a5ccf`
- **Reviewed HEAD**: `b1c39562fbe67e0c4b51719595b2fc159b4cf43f`
- **Reviewed Content Hash**: `b21e64891feba05f2087b41a7044dde14272acb56add560992ad57eda7b28f2e`

### 1. Verification of Round 1 Defect Fixes

1. **P1-1 (`Host.settleNote` batched `MemoryCoverage` & `G1-03P`) — FIXED**:
   - `capture()` now iterates `r.memories.entries()`, assigns unique per-item write IDs (`${work.id}:${index}:${m.roomId}:${m.sourceSeq}:${m.title}`), plans sequentially against a working `entries` copy, accumulates `writes[]` and `unresolved`, and calls `coverage.prepare(work.id, writes, unresolved)` + `coverage.apply(work.id, ...)` **once** after the loop.
   - `memory-api.test.ts` now tests `[legitimate, valid two, fabrication]` and asserts `coverage[0]?.state === "failed"`, `coverage[0]?.unresolved === 1`, and `coverage[0]?.writes?.length === 2`.
2. **P1-2 (`source-retracted` entries excluded from structured write planning) — FIXED**:
   - `capture()` initializes `const entries = this.memory.list(contactId)` (visible memories only, matching `Host.rememberTx`), preventing retracted memories from matching as `restate` or relation targets.
   - Verified by new regression test `P1A structured reflect ignores a source-retracted entry when planning relations`.
3. **P1-3 (Post-`commitRound` `capture()` gating & `ask-user` conflict prompt) — FIXED**:
   - `settleNote` now extracts unstructured legacy memories into `remember[]` immediately and returns `capture` to `runRound`, which invokes `settled.capture?.()` **after** `commitRound` succeeds — so a `GroupReplyStaleError` abandons the round with zero `.md`, `gg_memory`, or `memory-coverage:*` writes.
   - `plan.kind === "ask-user"` populates `question: { roomId: check.source.roomId, text: ... }` on `CaptureWrite` and passes `() => this.loop.notify(contactId, "now")` to `coverage.apply`, keeping both direct-quote memories `active` with `conflictsWith`.
   - Verified by `P1A stale group reply during reflect abandons all structured capture writes` and `P1A ask-user structured conflict passes its question through apply and notifies`.
4. **All 3 P2 Notes — ADDRESSED**:
   - `memory-coverage.test.ts` adds `G1-04CAS external md edit during apply is preserved and rejects the stale write` (killing former survivor `P1A-F3`).
   - `playbook.ts` short-circuits already-scrubbed invalidations in `list()` (zero extra writes, `updatedAt` preserved) and emits `room.updated` on `clone()` even when no announcements are copied.
   - `memory-write-neighbors.test.ts:35` cleaned up (`0` Biome infos/warnings/errors).

### 2. Independent Round 2 Verification & Fault Injection

- **Typecheck & Lint**: `npm run typecheck` (exit `0`) and `npm run lint` (`310` files checked, `0` errors, `0` warnings, `0` infos, exit `0`).
- **Full Offline Test Suite**: `npm test` passed **`2091/2091`** (`0` failed, `0` skipped, `0` cancelled, `0` todo).
- **Block-1 Prefix Budget**: `packages/adapter-pi-contact/src/recall.test.ts` passed (`1/1`, `< 4000` UTF-8 bytes).
- **Combined Red Replay (`2f3d0f22`)**: `tsc -p tsconfig.json` exit `0`; **`71/71` tests failed** (`0` passed, `0` skipped); empty test diff between Red `2f3d0f22` and Green `1a9f8f9b`.
- **Independent Round 2 Single-Site Fault Injections (`6/6` Killed)**:

| Fault ID | Target Site | Injected Mutation | Result | Killing Test(s) |
| :--- | :--- | :--- | :--- | :--- |
| `P1A-R2-F1` | `packages/server/src/host.ts` | Pass `0` instead of `unresolved` to `coverage.prepare` | **KILLED** (`1` failure) | `memory-api.test.ts` — `P1A Host structured reflect validates per-message verbatim evidence and records coverage` |
| `P1A-R2-F2` | `packages/server/src/host.ts` | Revert `this.memory.list(contactId)` back to `this.memory.listAll(contactId)` | **KILLED** (`1` failure) | `memory-api.test.ts` — `P1A structured reflect ignores a source-retracted entry when planning relations` |
| `P1A-R2-F3` | `packages/server/src/host.ts` | Skip post-`commitRound` `settled.capture?.()` call | **KILLED** (`3` failures) | `memory-api.test.ts` — structured reflect, source-retracted, ask-user conflict |
| `P1A-R2-F4` | `packages/server/src/memory-coverage.ts:52` | Bypass concurrent-disk-edit CAS guard (former R1 survivor `P1A-F3`) | **KILLED** (`1` failure) | `memory-coverage.test.ts` — `G1-04CAS external md edit during apply is preserved and rejects the stale write` |
| `P1A-R2-F5` | `packages/server/src/playbook.ts:39` | Bypass already-scrubbed invalidation short-circuit in `list()` | **KILLED** (`1` failure) | `playbook.test.ts` — `P1A repeated listing of scrubbed invalidation preserves updatedAt` |
| `P1A-R2-F6` | `packages/server/src/playbook.ts:99` | Remove `room.updated` emit in `clone()` | **KILLED** (`1` failure) | `playbook.test.ts` — `P1A clone emits room.updated even when no announcements are copied` |

### Verdict

All Round 1 P1 defects and P2 items are cleanly resolved and verified with runtime evidence and fault injections. **APPROVE** (`b21e64891feba05f2087b41a7044dde14272acb56add560992ad57eda7b28f2e`).
