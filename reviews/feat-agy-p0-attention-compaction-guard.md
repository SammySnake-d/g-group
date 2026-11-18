# PR #121 — independent review

## Round 1 — REJECT

**Reviewed HEAD:** `1c5372180f49cbc4d249cf3fe78db62ce84438ab`  
**Base:** `origin/dev/agy-backend` at `5d80aa865478eab0b6d83071db9717d37a7844f3`  
**Content hash:** `c5cbd909f6d05452459ca27a36abf0319fe73ec4198ace5520264498dfeaed3e`  
**Author:** `codex-cli:01a1ec48-cee6-7443-bea3-0bb9312c7274` (`shayu/gpt-6.2-sol`, OpenAI)  
**Reviewer:** `antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98` (`carbon-agy` / `gemini-4-carbon-high`, Google)

### Blocking finding

1. **P1 — `LoopGuard`-withheld group messages and `system` loop notices leak across session boundaries into unrelated private DM / other-room rounds (`US2`, `G4-01`/`G4-a`, `D06.3`/`AC-37`, `AC-46`).**
   - **Sub-issue A (`system` loop notice piggybacks into unrelated rounds, opening cross-room `prefetch` & `query_history` scope — `packages/server/src/host.ts:2790–2851, 3015` & `packages/server/src/history.ts:182–191`)**:
     - `postLoopNotice` (`host.ts:1106–1113`) appends `{ kind: "system", id: "loop-guard" }` into group `g` when `LoopGuard` stops a causal chain, and `runRound` (`:2846`) suppresses a round only when `fresh.every((f) => f.kind === "message" && f.sender.kind === "system")`.
     - As soon as the blocked contact (`丙`) is woken in **another** conversation (e.g. a private DM `dm-c`), `runRound` scans all `rooms`, pushes `g`'s unread `system` notice into `fresh`, and `:2846` no longer returns early because `dm-c` has a real user message.
     - **Independent runtime reproduction**: Group `g` (`maxHops: 2`) contained `#1` (`user`: `"绝密群消息:数据库密码在保险柜7788"`), `#2` (`甲 -> @乙`), `#3` (`乙 -> @甲 @丙`, withheld from `丙`), and `#4` (`system`: `"自动往返已到上限..."`). When the user sent a private DM `dm-c #1` (`"你好丙，私聊问个天气"`):
       1. `g #4` (`system`) piggybacked into `丙`'s private DM `fresh`, adding `g` to `new Set(fresh.map((f) => f.roomId))` (`host.ts:3015`, `history.ts:182`);
       2. `HistoryAccess.prefetch` (`history.ts:186–191`) ran a search query for `g #4` against `g` and injected `g #1` (`绝密群消息:数据库密码在保险柜7788`) into Block 5 of `丙`'s private DM prompt;
       3. `query_history` called during the private DM round searched and returned group `g`'s history (`只搜了本轮所在的会话 dm-c-..., g-...`), violating `G4-01` / `G4-a` / `US2` cross-session isolation;
       4. When `g.id < dm.id`, `focusRoom` (`host.ts:2851`) and `firstMsg` (`:2868`) also bind to the `system`-notice room instead of the active user room.
   - **Sub-issue B (`refs` collected before `LoopGuard` splicing leaks quoted group bodies on every subsequent DM turn — `packages/server/src/host.ts:2820–2843`)**:
     - `runRound` pushes `replyToSeq` / `quotedSeqs` into `refs` (`:2821–2830`) **before** `:2838–2842` splices withheld `!mayReceive` contact messages out of `fresh`.
     - **Independent runtime reproduction**: Even when no unread `system` notice remained in `g`, every subsequent private DM turn for `丙` paged the group message quoted by the withheld `g` contact reply directly into `丙`'s private DM Block 5 (`〔g-... #1(主回复)〕Full · 我 原文(47 字节):绝密群消息:数据库密码在保险柜7788`), violating `US2` / `D06.3` and consuming `recallBudgetBytes` on unrelated turns until a human speaks in `g`.
   - **Sub-issue C (`markRead` uses `lastSeen` instead of `cursorSeen` — `packages/server/src/host.ts:2866`)**:
     - `this.markRead(r.id, { kind: "contact", id: contactId }, lastSeen[r.id] ?? 0)` marks withheld `LoopGuard`-blocked tail messages as read (`AC-46`) whenever any message in `r.id` (including a `system` notice or an earlier unblocked message) is in `fresh`, even though `cursorSeen[r.id]` was capped at `f.seq - 1`.
   - **Fix direction**:
     1. Do not deliver `sender.kind === "system"` notices into contact `fresh` (or strip `system` messages from rooms that have no unblocked non-`system` input in the current round, and exclude `sender.kind === "system"` from `HistoryAccess.prefetch` queries at `history.ts:187` and `focusRoom`/`firstMsg` selection);
     2. Collect `refs`/`sources` **only** from messages kept in `fresh` after `LoopGuard` filtering (so withheld messages never trigger `planRecall` Page-In);
     3. Advance `markRead` (`host.ts:2866`) using `cursorSeen[r.id] ?? 0` rather than `lastSeen[r.id] ?? 0`;
     4. Add a regression test covering a group stopped by `LoopGuard` (with both a withheld quoting contact message and a `system` loop notice) followed by a private DM to the blocked contact, verifying `fresh` has only the DM, Block 5 has no group quote/prefetch, `query_history` cannot read/search the group, and group `readSeq` does not advance past withheld messages.

### Verified scope & non-blocking audit checklist

- **Billion Context (`third_party/acp-kernel` `0.0.191`, `541cf26`) & History Search/Scrub (`G3`+`G4`+`G4b`)**:
  - MIT + product-surface attribution honored in `README.md:79–81`, `third_party/acp-kernel/LICENSE`, `NOTICE`, and `UPSTREAM.md`.
  - `packages/kernel/src/history-search.ts` is the sole file in `packages/` importing `acp-kernel`; `memoryTextRanks` replaced `overlap()` in `packages/kernel/src/memory.ts`.
  - Clean-archive `npm ci --prefer-offline --silent --ignore-scripts` (with `.npmrc` `install-links=true`) exited 0 and passed live hybrid retrieval tests without lifecycle scripts.
  - `query_history` is the 15th bounded contact tool (`progress_get` preserved at the end); Block-1 stays at `3465` UTF-8 bytes (`< 4000`, `recall.test.ts` green); `retractedBodies` + `scrubLineBody` scrub retracted text across search, paging, prefetch, and compaction inputs.
- **Attention Routing, `LoopGuard` & `OpenMausBot` `room-post-budget.ts`**:
  - Zero `chat-admin`, `contact-actions`, or `contact-call-check` leakage.
  - `packages/server/src/room-post-budget.ts` carries `SPDX-License-Identifier: Apache-2.0` + `milind-soni/OpenMausBot (613ed01fd)` attribution (`README.md:82`) and is wired into `Host.roomPostRefusalTx` (`host.ts:1090–1097, 1118–1129, 3214–3217`) for autonomous group replies without blocking human-initiated rounds.
  - `GroupReplyStaleError` (`host.ts:3174–3180`) rechecks group log drift inside the commit transaction.
- **Length-Safe Contact Rounds & `OpenMausBot` `compaction-summary.ts`**:
  - `stopReason === "length"` rejects atomically in both `mind.ts:257–260, 286` and `compact.ts:143`.
  - `noteSourcesChanged` (`host.ts:2896–2906`) revalidates room membership, cursors, and retractions before `reflect`, before fallback `compact`, before `shrink`, and before `commitRound`.
  - `packages/server/src/compaction-summary.ts` carries Apache-2.0 (`613ed01fd`) attribution and is wired into `Host.noteWithPending` (`host.ts:2666–2677`) to bound Block-3 recovery excerpts to `MAX_SUMMARY_BYTES` while preserving full revalidated inputs in `note-pending` for retry compaction.
- **No B1 Regression & Honest Receipt (`R-06`/`R-08`)**:
  - `atomic.ts`, `runtime-config.ts`, `progress-get.ts`, `gg_compute_leases` / `gg_compute_legacy_holds`, and `gg_reviews.harness` remain intact; `receipts/feat-agy-p0-attention-compaction-guard.json` honestly marks `AC-08`, `AC-32`, `AC-42` as `"未测"` with accurate D-vs-product/X-layer boundaries.

### Commands and independent verification evidence

```sh
node /tmp/gg-agy-rev-121/scripts/gates/run-all.ts --hash --repo=/tmp/gg-agy-rev-121 --branch=feat/agy-p0-attention-compaction-guard --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
node scripts/gates/run-all.ts --local --base=origin/dev/agy-backend --branch=feat/agy-p0-attention-compaction-guard
```

- `npm run typecheck`: exit 0.
- `npm run lint`: Biome checked 269 files, exit 0.
- `npm test`: **1896/1896** passed (`0` failed, `0` skipped, `0` todo, `0` cancelled).
- Clean-archive `npm ci --prefer-offline --silent --ignore-scripts`: exit 0 (`history-search.test.ts` `4/4` passed).
- Isolated Red replay (`07cef7c6df795003e755f4b2b6191ab7e1a2fef5` in `/tmp/gg-agy-fault-121`): `tsc -p tsconfig.json` exit 0; `git diff 07cef7c6 3415fbea -- "packages/**/*.test.ts" "scripts/gates/*.test.ts"` empty; 20 changed test files ran `155` tests with **130 named assertion failures** and `25` unchanged passing controls (`0` skipped).
- Isolated single-point fault injections (`5/5` killed in `/tmp/gg-agy-fault-121`, then deleted):

| Fault ID | Single-point mutation | Caught by named test(s) |
|---|---|---|
| `B2-F1` | `history.ts` `scrub`: return `[...lines]` (bypass retract scrub) | `history-scrub.test.ts`: prefetch, read-window, and search retract-scrub tests failed |
| `B2-F2` | `host.ts` `commitRound`: skip `GroupReplyStaleError` check on newer contact posts | `group-supplement.test.ts`: `并发群回复在提交时发现别人已发言须复核...` |
| `B2-F3` | `loop-guard.ts` `admit`: bypass `row.count >= this.maxHops` cap | `loop-guard.test.ts`: causal root hop-cap tests failed |
| `B2-F4` | `mind.ts` `finishTurn`: skip `stopReason === "length"` truncation guard | `mind.test.ts`: `A5` truncated contact turn tests failed |
| `B2-F5` | `host.ts` `settleNote`: drop `sourcesChanged()` recheck before fallback `compact` | `a5-fresh-auth-races.test.ts`: `授权在失败反思期间撤回:不能将旧快照发给下一次普通压缩` |
