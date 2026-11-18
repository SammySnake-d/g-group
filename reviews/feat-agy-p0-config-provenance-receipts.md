# REVIEW 2: APPROVE 5d2f0ffd9b4f509525b3a423a1b85cb9ceda1e23bc166127ae546f45f63ce6d0

## Round 1 — REJECT

**Reviewed HEAD:** `f24e3a623e7cced01bbc8cfc851f6b9113088124`  
**Base:** `origin/dev/agy-backend` at `491c26c3bfe44892276569fb46bbde38c525e151`  
**Content hash:** `b8198350a59df2538b1b8c39282e008131a982ee8f1e4ea3cddc8924ae125228`  
**Author:** `codex-cli:01a1ecc3-7e14-7b60-98ad-3684ffa7bb7b` (`shayu/gpt-6.2-sol`, OpenAI)  
**Reviewer:** `antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98` (`carbon-agy` / `gemini-4-carbon-high`, Google)

### Blocking finding

1. **P1 — `Host.readLinked` (`read_linked`) leaks echoed retracted message bodies across rooms (`AC-08` / `G4b`) and leaks post-`uptoSeq` message edits across the static link upper bound (`U24`) (`packages/server/src/host.ts:1605–1635`).**
   - **Sub-issue A (Missing `retractedBodies` + `scrubLineBody` scrub and unscrubbed `query` term filter — `AC-08`, `G4b`)**:
     - Across existing contact read/context paths (`HistoryAccess.scrub` in `packages/server/src/history.ts:77–104` for `prefetch` and `query_history` search/read, `Host.scrubNote` in `host.ts:2613`, `Host.visibleNoteInputs` in `host.ts:2652`, and `Host.appendUserEvent` in `host.ts:1413`), withdrawn message bodies and their pre-retract edits (`retractedBodies(log.events)`) are scrubbed out of any other visible message that copied/echoed them (`scrubLineBody(text, retracted)`).
     - `Host.readLinked` (`host.ts:1618–1626`) only blanks rows where `m.retracted || inRanges(rewound, m.seq)` itself is true, never passes surviving visible lines through `scrubLineBody(..., retractedBodies(log.events))`, and runs `terms.every((t) => text.toLowerCase().includes(t))` against the unscrubbed text.
     - **Independent runtime reproduction**: In `dm`, user sent `#1` (`"我的储物柜号码是 4471,钥匙放在前台"`), contact `小甲` replied `#2` (`"收到:我的储物柜号码是 4471,钥匙放在前台"`), user linked `g -> dm` (`uptoSeq = 3`), and user retracted `dm #1`. While `小甲`'s own `query_history({ kind: "search", query: "4471", roomId: dm.id })` inside `dm` returned `收到:〔已撤回内容已移除〕`, external group contact `小乙` calling `read_linked({ roomId: g.id, linkedRoomId: dm.id })` and `read_linked({ roomId: g.id, linkedRoomId: dm.id, query: "4471" })` received `#2 · 小甲 · ... · 收到:我的储物柜号码是 4471,钥匙放在前台` verbatim.
   - **Sub-issue B (Unbounded `this.projected(link.linkedRoomId)` leaks `edit` events with `ev.seq > link.uptoSeq` — `U24`, `forward-link.ts:6, 31`)**:
     - `rooms.link` establishes a static snapshot upper bound `uptoSeq` (`圈定关联那一刻的上界(upto_seq),上界之后的新消息不在范围内`).
     - `Host.readLinked` (`host.ts:1618`) calls `this.projected(link.linkedRoomId)` over the **entire** append-only `room:${link.linkedRoomId}` log and only filters `m.seq <= link.uptoSeq` (the target message's creation seq), allowing later `edit` events (`ev.seq > link.uptoSeq`) to cross `uptoSeq` without refreshing the link.
     - **Independent runtime reproduction**: After `rooms.link` pinned `uptoSeq = 3` on `dm`, `host.editMessage(dm.id, 3, "关联后改成的私密内容 POST_LINK_SECRET")` appended event `seq = 5 > 3`. `小乙` in `g` calling `read_linked({ roomId: g.id, linkedRoomId: dm.id, query: "POST_LINK_SECRET" })` received `#3 · 我 · ... · 关联后改成的私密内容 POST_LINK_SECRET`.
   - **Fix direction**:
     1. In `Host.readLinked`, load `log` once (`loadLog(this.db.store, \`room:${link.linkedRoomId}\`)`) and project `{ ...log, events: log.events.filter((e) => e.seq <= link.uptoSeq || e.body.kind === "retract") }` so `message` and `edit` events after `link.uptoSeq` stay outside the static link bound until `rooms.link` is refreshed, while `retract` events at any `seq` still honor `AC-08` withdrawal immediately;
     2. Compute `const retracted = retractedBodies(log.events)` across the full current `log.events` and pass each non-`gone` candidate's text through `scrubLineBody(rawText, retracted).text` **before** applying the `terms.every(...)` query filter and rendering;
     3. Add regression tests in `packages/server/src/forward-link.test.ts` verifying (a) a visible reply in `linkedRoomId` that echoed a retracted message is scrubbed in `read_linked` and cannot be matched by `query` on the retracted secret, and (b) an `editMessage` occurring after `uptoSeq` is not visible to `read_linked` until `rooms.link` refreshes `uptoSeq` (while a post-`uptoSeq` `retractMessage` still hides the retracted message and scrubs echoes).

### Verified scope & non-blocking audit checklist

- **Contact Config History (`packages/server/src/contact-config-history.ts`, `host.ts:672–743, 868–872`)**:
  - `gg_contact_config_versions` uses `WITHOUT ROWID` plus `BEFORE INSERT` (same-PK guard), `BEFORE UPDATE`, and `BEFORE DELETE` triggers — rejecting same-PK and `rowid`-targeted `INSERT OR REPLACE` even under `PRAGMA recursive_triggers = OFF` (`R2-01` / `CFG13` / `CFG17`).
  - `contactConfigOf` explicitly projects the 10 whitelisted config fields, preserves `computeModel.effort` (`S-1`), restores `avatar: null` and `computeSlots: null` on rollback (`S-2`), keeps `contacts.update` `clientActionId`/`expectedVersion` optional (`opt(...)`), and covers all 5 snapshot kinds (`baseline`, `create`, `update`, `batch`, `rollback`) atomically inside SQLite transactions.
- **Task Timeline (`packages/server/src/task-timeline.ts`, `db.ts:45–51`, `host.ts`)**:
  - Narrow transaction seams across `putDoc("task:...")` and `putDoc("follow:...")` (`R1-06`); `gg_task_events` is protected by `BEFORE INSERT` (same-id replace), `BEFORE UPDATE`, and `BEFORE DELETE` triggers (`R1-05`).
  - `eventActor` distinguishes user waiver (`event.waiverBy != null` -> `{ kind: "user", id: event.waiverBy }`) from cross-vendor contact reviewer (`{ kind: "contact", id: event.reviewerId }`) (`R1-01`), attributes `SubmitForReview` and contact-owned `Cancel` (`stop`) to `{ kind: "contact", id: contactId }`, unifies follow-up actors (`R1-03`), enforces current room membership on `tasks.timeline`, and validates canonical task-bound `base64url` keyset cursors without storing retractable message bodies.
- **Retract Side-Effect Disclosure (`packages/server/src/host.ts:1391–1436`, `rewind.ts:34–38`)**:
  - `appendUserEvent` retract discloses both `gg_progress` `kind = 'completed'` ledger rows (scrubbed via `scrubRetracted`, never `doc.result`, preserving ledger timestamp) and non-completed `gg_compute` runs (`running`/`failed`/`stopped`, `R1-04`), emits 0 disclosures when no task/Compute ran on the retracted message, leaves `gg_progress` byte-identical, and introduces zero `chat-admin` or `memory-hygiene` leakage.
- **Forward Copy Provenance & Contract Wire Compatibility (`forward-link.ts`, `api.ts`, `entities.ts`, `tools.ts`)**:
  - All 89 baseline RPC methods from `origin/dev/agy-backend` retained (`89 -> 94` with `contacts.history`, `contacts.rollback`, `rooms.link`, `rooms.unlink`, `tasks.timeline`); `note` in `messages.forward` and `forwarded` in `MessageView` are optional (`opt(...)`), preserving legacy `MessageView.forward`.
  - `consentFromMessage` (`host.ts:5516`) checks `Boolean(getDoc(this.db, \`forward:${roomId}:${seq}\`))` to veto forwarded approval text (`AC-20`); `retractMessage` and `rewind` atomically mark `sourceRetracted: true` via `markSourceRetractedTx` and emit `message.updated`; `read_linked` is inserted before `progress_get` (`progress_get` remains last) and `recall.test.ts` Block-1 prefix stays `< 4000` UTF-8 bytes.
- **Contract Polish (`b3-contract-polish.test.ts`)**:
  - `tasks.progress` filters strictly `AND at > ?` before `LIMIT ?`; committed visible contact replies emit `thinking -> replying -> idle`; search and receipt audience/idempotency checks pass.

### Commands and independent verification evidence

```sh
node /tmp/gg-agy-rev-b3/scripts/gates/run-all.ts --hash --repo=/tmp/gg-agy-rev-b3 --branch=feat/agy-p0-config-provenance-receipts --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
node scripts/gates/run-all.ts --local --base=origin/dev/agy-backend --branch=feat/agy-p0-config-provenance-receipts
```

- `npm run typecheck`: exit 0.
- `npm run lint`: Biome checked 279 files, exit 0.
- `npm test`: **1971/1971** passed (`0` failed, `0` skipped, `0` todo, `0` cancelled).
- Isolated Red replay (`d2e38ab3d6a8c1924c9ed4fb45aca551cae762d4` in `/tmp/gg-agy-fault-b3`): `tsc -p tsconfig.json` exit 0; zero test diff between `d2e38ab3` and Green `48549293`; 8 changed test files ran `93` tests with **70 named assertion failures** and `23` unchanged passing controls (`0` skipped).
- Isolated single-point fault injections (`8/8` killed in `/tmp/gg-agy-fault-b3`, then deleted):

| Fault ID | Single-point mutation | Caught by named test(s) |
|---|---|---|
| `B3-F1` | `contact-config-history.ts`: drop `WITHOUT ROWID` | `CFG17 R2-01 rowid-targeted replacement is rejected with recursive triggers off...` |
| `B3-F2` | `contact-config-history.ts`: omit `computeModel.effort` from `contactConfigOf` | `CFG15 R1-03 回滚恢复每个白名单字段含工具能力槽位和模型harness` |
| `B3-F3` | `task-timeline.ts`: ignore `event.waiverBy` in `eventActor` | `TT15` (`tasks.accept`, delivery card, and contact relay waiver actor tests) |
| `B3-F4` | `task-timeline.ts`: drop `v[0] !== q.taskId` cursor task-binding check | `TT06 same-timestamp keyset pages are task-bound...` |
| `B3-F5` | `host.ts`: substitute `doc.result` for `gg_progress` `clean.text` in retract disclosure | `RD01 retract discloses the ledger outcome, not the contact's different delivery` |
| `B3-F6` | `host.ts`: invert `compute.status === "completed"` filter on `computeRuns` | `RD03` (`failed`/`stopped`/`running` Compute disclosure tests + `RD01`/`RD02`) |
| `B3-F7` | `host.ts`: set `forwarded: false` in `consentFromMessage` | `forward-link.test.ts`: `forward provenance vetoes consent when the resolver sees a forwarded row...` |
| `B3-F8` | `host.ts`: drop `AND at > ?` filter in `Host.progress` | `B301 tasks.progress filters strictly after afterAt before applying the requested limit` |


## Round 2 — APPROVE

**Reviewed HEAD:** `910b905f6caf38e267ede8856c7038a604e12f65`  
**Base:** `origin/dev/agy-backend` at `491c26c3bfe44892276569fb46bbde38c525e151`  
**Content hash:** `5d2f0ffd9b4f509525b3a423a1b85cb9ceda1e23bc166127ae546f45f63ce6d0`  
**Author:** `codex-cli:01a1ecef-0b2a-7b20-8837-b3f7345344c2` (`shayu/gpt-6.2-sol`, OpenAI)  
**Reviewer:** `antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98` (`carbon-agy` / `gemini-4-carbon-high`, Google)

### Round 1 blocker resolution verified

1. **Resolved — `Host.readLinked` (`read_linked`) retract-echo scrubbing (`AC-08` / `G4b`) & static `uptoSeq` edit upper bound (`U24`) (`packages/server/src/host.ts:1630–1642`):**
   - **Sub-issue A (`AC-08` / `G4b` echoed retracted bodies & pre-retract edits)**:
     - `Host.readLinked` (`host.ts:1630–1631, 1638–1642`) loads `log` once via `loadLog(this.db.store, \`room:${link.linkedRoomId}\`)`, computes `retracted = retractedBodies(log.events)` across the full event log (capturing both original bodies and pre-retract edits), and scrubs every non-`gone` candidate text (`this.forwardText(link.linkedRoomId, m)`) via `scrubLineBody(raw, retracted).text` **before** applying `terms.every((t) => text.toLowerCase().includes(t))` and rendering.
     - Re-running the exact Round 1 live reproduction probe confirmed `#2 · 小甲` renders `收到:〔已撤回内容已移除〕` and `read_linked({ query: "4471" })` returns `本次 0 条`.
   - **Sub-issue B (`U24` static `uptoSeq` bound against post-link edits)**:
     - `Host.readLinked` (`host.ts:1633`) projects `{ ...log, events: log.events.filter((e) => e.seq <= link.uptoSeq || e.body.kind === "retract") }`, keeping post-link `message` and `edit` events (`e.seq > link.uptoSeq`) invisible until `rooms.link` refreshes `uptoSeq` while honoring post-link `retract` events immediately.
     - Re-running the Round 1 live reproduction probe confirmed `#3 · 我` retains `关联前的公开约定:12 月 3 日` and `read_linked({ query: "POST_LINK_SECRET" })` returns `本次 0 条`.
   - **Regression coverage**: `packages/server/src/forward-link.test.ts` adds 2 Round-2 tests (`AC-08 G4b: read_linked scrubs echoed retracted bodies and pre-retract edits before filtering query` and `U24: read_linked enforces static uptoSeq bound against post-link edits while honoring post-link retracts`).

### Independent Round 2 verification evidence

```sh
node /tmp/gg-agy-rev-b3/scripts/gates/run-all.ts --hash --repo=/tmp/gg-agy-rev-b3 --branch=feat/agy-p0-config-provenance-receipts --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
node scripts/gates/run-all.ts --local --base=origin/dev/agy-backend --branch=feat/agy-p0-config-provenance-receipts
```

- `npm run typecheck`: exit 0.
- `npm run lint`: Biome checked 279 files, exit 0.
- `npm test`: **1973/1973** passed (`0` failed, `0` skipped, `0` todo, `0` cancelled).
- Isolated R2 incremental Red replay (`8264ebe4ffe33837997c1ca23a30f4dfa40df5a1` in `/tmp/gg-agy-fault-b3`): zero diff on `packages/server/src/forward-link.test.ts` to Green (`8f9d547c`); **2/2** new R2 tests failed by name (`12` unchanged passed).
- Isolated combined R1+R2 Red replay (`ff8e700236ae677ad1a06ff9521fcce294f7e6c5` in `/tmp/gg-agy-fault-b3`): `tsc -p tsconfig.json` exit 0; zero test diff across `"packages/**/*.test.ts"` `"scripts/gates/*.test.ts"` to Green (`8f9d547c`); 8 changed test files ran `95` tests with **72 named failures** and `23` unchanged passing controls (`0` skipped).
- Isolated R2 single-point fault injections (`4/4` killed in `/tmp/gg-agy-fault-b3`, then deleted):

| Fault ID | Single-point mutation | Caught by named test(s) |
|---|---|---|
| `B3-R2-F1` | `host.ts:1639`: omit `scrubLineBody(raw, retracted)` (`const text = raw`) | `AC-08 G4b: read_linked scrubs echoed retracted bodies and pre-retract edits before filtering query` |
| `B3-R2-F2` | `host.ts:1642`: filter `terms` against unscrubbed `forwardText` instead of scrubbed `text` | `AC-08 G4b: read_linked scrubs echoed retracted bodies and pre-retract edits before filtering query` |
| `B3-R2-F3` | `host.ts:1633`: restore unbounded `project(log)` | `U24: read_linked enforces static uptoSeq bound against post-link edits while honoring post-link retracts` |
| `B3-R2-F4` | `host.ts:1633`: drop `|| e.body.kind === "retract"` from bounded log projection | `U24: read_linked enforces static uptoSeq bound against post-link edits while honoring post-link retracts` |
