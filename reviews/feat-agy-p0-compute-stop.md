# PR #120 — independent review

## Round 1 — REJECT

**Reviewed HEAD:** `a1266082434d47f4df9e8682bd0d6d05ceebf3fd`  
**Base:** `origin/dev/agy-backend` at `926956560af22959c726953cfb4248f4056e3155`  
**Content hash:** `3a020254a65e1948a6e9eed1bd3a744f47c89860c98c7b614b264ce1d701ebd7`  
**Author:** `codex-cli:01a1ebf2-9504-7bf0-937c-48c2ba061e8b` (`shayu/gpt-6.2-sol`, OpenAI)  
**Reviewer:** `antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98` (`carbon-agy` / `gemini-4-carbon-high`, Google)

### Blocking findings

1. **P1 — Normal Host restart misclassifies already-quiesced/released tasks as legacy `uncertain` holds, permanently deadlocking personal and group Compute slots and wedging failure-card actions (`AC-23`, `AC-36`).**
   - `openDb()` (`packages/server/src/db.ts:36–39, 88–92`) executes `CREATE TABLE IF NOT EXISTS gg_compute_leases (...)` unconditionally before `Host` checks whether `gg_compute_leases` pre-existed.
   - `Host` constructor (`packages/server/src/host.ts:516–536`) then scans `listDocs<TaskDoc>(this.db, "task:")` on **every** boot and pushes any task in `T3_Running | T4b_BlockedOnHuman | T9_StopRequested` with `(task.computeId || task.launch || task.orphans.length)` and `!savedTasks.has(task.id)` into `uncertain` and `this.stopUnconfirmed`.
   - In `QuotaTable.fit` (`packages/server/src/quota.ts:74–86, 107`), any entry in `uncertain` blocks **all** personal slots for `u.contactId` (`!this.uncertain.some((u) => u.contactId === r.contactId)`) and **all** temporary group slots for `u.roomId`, regardless of slot count (even `personalComputeSlots = 5` or `Infinity`).
   - **Independent runtime reproduction on a fresh B1 database**:
     - Contact created with `personalComputeSlots: 5`; task `t1` failed (`403 Insufficient user quota`), posted an AC-36 in-place failure card (`task.state === "T3_Running"`, `task.computeId === "cp-1"`), and `afterRound` (`host.ts:3699–3725`) ran `quiesce -> { ok: true, killed: 0 }` and `giveBack`, deleting `t1`'s row from `gg_compute_leases` (`leases.length === 0`, `waitingFor === null`).
     - After `await h1.close()` and reopening `new Host(...)` on the same DB, `t1` was marked `waitingFor = "停止未确认:上次宿主结束时的执行占用尚未核对"`, and `h2.quota.acquire` for a brand-new task returned `{ queued: "个人算力已满;排队等,或转交别人" }` despite 5 free personal slots and 0 leaked processes.
     - The same false-positive triggers for: (a) tasks in `AC-36` `paused` / `retrying` states whose `quiesce` already confirmed stop and deleted the lease; (b) `AC-36 F6` tasks where Compute already emitted `completed` + `settled` (deleting the lease at `host.ts:3704, 3721`) before the contact round called `deliver` (`task.state` still `T3_Running`); and (c) queued-only `T9_StopRequested` tasks (`!task.computeId && !task.orphans.length && task.launch !== null`) that never acquired a lease or spawned a process.
     - Furthermore, once `uncertain` is restricted to genuine pre-B1 legacy databases, verify post-restart `[不重试]` (`give-up`, `host.ts:4680–4694`) and `stopTask` (`host.ts:3563–3570, 3699–3730`) on a failure card whose stop **was already confirmed before shutdown** (`!this.quota.leaseOf(taskId) && !this.stopUnconfirmed.has(taskId)` and `gg_compute.status IN ('failed','stopped','completed')`): because `this.computeRuns` is empty after restart, `afterRound` currently sets `why = "找不到原执行器,无法核验停止"` and traps the already-quiesced task in `T9_StopRequested` (whereas when a lease in `gg_compute_leases` or persisted legacy `uncertain` hold **does** exist, `stop-confirmation.test.ts:62` must continue keeping `T9_StopRequested` and retaining the lease).
   - **Fix direction**: Detect whether `gg_compute_leases` existed prior to schema creation (and persist any migrated legacy `uncertain` holds across subsequent restarts of that legacy DB); in B1+ databases treat `gg_compute_leases` as authoritative for unconfirmed leases instead of fabricating `uncertain` holds from `task:*` docs; exclude `completed` Compute rows and `!computeId && !orphans.length` tasks even during legacy migration; and allow post-restart `give-up`/`stopTask` to complete `StoppedConfirmed` when no lease or `stopUnconfirmed` hold exists for an already-terminal `gg_compute` row. Add regression tests for restart after failure-card `quiesce: ok` (new tasks acquire slots; `give-up`, `retry`, and `rerunRun` work) alongside existing unconfirmed-restart tests.

2. **P1 — Cross-vendor review Compute (`T5_InReview`) hardcodes `"claude-code"`, silently substituting `claude-code` when the selected reviewer contact uses `codex` (`R-17`, `AC-51`, `AC-26`).**
   - While `spawn` (`packages/server/src/host.ts:3798–3813`) and `computeTurn` (`:3611–3625`) now route via `this.factories` by Harness and block unconnected Harnesses via `harnessBlockReason`, `spawnReview` (`:3872–3889`) still hardcodes `const adapter = this.adapterFor("claude-code", e.model);`, and `adapterForCompute` (`:3587–3591`) hardcodes `SELECT 'claude-code' AS harness, model FROM gg_reviews`.
   - **Independent runtime reproduction**: On a `Host` with only `claude-code` connected (`codex` unconnected), an Anthropic author (`claude-code` / `claude-sonnet-4-6`) delivered a task in a group with an OpenAI reviewer contact configured as `harness: "codex"`, `computeModel: { mode: "explicit", model: "gpt-5.4" }`. `Host` selected that `codex` reviewer and **silently spawned `cc-2` on `claude-code` with `{ model: "gpt-5.4" }`** (`cc.spawned` = `[{ computeId: "cc-1", model: "claude-sonnet-4-6" }, { computeId: "cc-2", model: "gpt-5.4" }]`). Even when both `claude-code` and `codex` factories are connected in `ComputeFactories`, `spawnReview` and `adapterForCompute` still route `codex` reviewers to `claude-code`. This contradicts `R-17` (marked `"通过"` in `receipts/feat-agy-p0-compute-stop.json`) and `runtime-config.ts`'s no-silent-Harness-substitution rule.
   - **Fix direction**: Resolve the reviewer contact's `{ harness, model, effort }` (`resolveComputeFor`), enforce `harnessBlockReason` and `modelConfig.checkCompute` before spawning review Compute (never substituting `claude-code` for `codex`; skip ineligible/unconnected reviewers in candidate selection or fall back via `reviewFallback` with an explicit reason), record `harness` on `gg_reviews` (with backward-compatible migration for existing DBs if needed) so `spawnReview` and `adapterForCompute` route stop/events to the actual Harness adapter, and add regression tests for `codex` reviewer contacts both when `codex` is unconnected and when `codex` is connected.

### Non-blocking notes & verified scope

- **Minor note (`packages/server/src/host.ts:2779`)**: `progressGet` receives `this.roomsOfContact(contactId)` without filtering `this.exits.leavingRoomsOf(contactId)` (unlike `:2591`). Consider filtering `leavingRooms` if a contact mid-removal should lose `progress_get` visibility immediately.
- **Zero regression & contract preservation**:
  - `packages/adapter-cc-compute/*`: untouched (`0` diff lines vs `origin/dev/agy-backend`).
  - `packages/api-contract/src/*`: all **89** RPC methods preserved; only additive `opt(...)` fields (`stall`, `runThresholds`, `warning`).
  - `packages/adapter-pi-contact/*` & `recall.test.ts`: 14 bounded contact tools (`progress_get` read-only, non-action), Block-1 4000B prompt budget and `recall.test.ts` (**17/17**) green.
- **Wheel reuse & attribution (`origin-analysis-wheels.md`)**: `packages/server/src/atomic.ts` + `atomic.test.ts` carry proper `SPDX-License-Identifier: Apache-2.0`, `Copyright 2026 Milind Soni and OpenMausBot contributors`, `Adapted from milind-soni/OpenMausBot (613ed01fd)` headers, full license text at `packages/server/licenses/OpenMausBot-APACHE-2.0.txt`, attribution in `README.md:75–77`, clean `node:test` conversion, `O_NOFOLLOW | O_NONBLOCK` symlink/FIFO safety, `renameWithRetry`, and real wiring in `ArtifactStore.put` (`packages/server/src/artifacts.ts:58–63`).
- **Stop quarantine, `fakes.ts`, `runtime-config`, `orphan-pid`, `progress_get`, Receipt (`R-06`/`R-08`)**:
  - `QuotaTable.markStopping` preserves in-memory `stopping: true` when SQLite `UPDATE` fails (`stop-storage-failure.test.ts`).
  - `recoverRuns()` transitions `T3`/`T4b` to `T9_StopRequested` without fabricating `StoppedConfirmed`.
  - `fakes.ts` cancels pending `haltOnStop` timers on both `stop()` and `close()`.
  - `composeThresholds` dynamically resolves `base <- settings (defaults/byUpstream) <- contact.stall` (`15m` / `120s` defaults verified).
  - `reconcileOrphans` checks `pidAlive` only for `status === "running"` in same `bootId`, leaving `waiting_user` intact (`orphan-pid.test.ts`).
  - `receipts/feat-agy-p0-compute-stop.json` honestly marks `AC-43` and `AC-51` `"未测"` for X-layer gaps; once Findings #1 and #2 are resolved, `AC-23` and `R-17` `"通过"` will match runtime truth.

### Commands and independent verification evidence

```sh
node /tmp/gg-agy-rev-120/scripts/gates/run-all.ts --hash --repo=/tmp/gg-agy-rev-120 --branch=feat/agy-p0-compute-stop --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
node scripts/gates/run-all.ts --local --repo=/tmp/gg-agy-rev-120 --base=origin/dev/agy-backend --branch=feat/agy-p0-compute-stop
```

- `npm run typecheck`: exit 0.
- `npm run lint`: Biome checked 244 files, exit 0.
- `npm test`: **1753/1753** passed (`0` failed, `0` skipped, `0` todo).
- Isolated Red replay (`ba39ad48b6c00a0f266e441da5435f9fa3a4aac7` in `/tmp/gg-agy-fault-120`): `tsc -p tsconfig.json` exit 0; `git diff ba39ad48 2afdf13b -- "packages/**/*.test.ts"` empty; 11 changed test files ran `101` tests with **59 named assertion failures** and `42` unchanged passing controls (`0` skipped).
- Isolated single-point fault injections (`5/5` killed in `/tmp/gg-agy-fault-120`, then deleted):

| Fault ID | Single-point mutation | Caught by named test(s) |
|---|---|---|
| `F1` | `host.ts` `afterRound`: fall back to `settled()` when `!a.quiesce` | `stop-confirmation.test.ts`: `AC-23 执行器未提供停止核验:轮次 settled 不得确认停止或归还槽位` |
| `F2` | `quota.ts` `markStopping`: omit in-memory `stopping: true` quarantine on `persist` throw | `stop-storage-failure.test.ts`: both `AC-23` storage-failure tests failed |
| `F3` | `runtime-config.ts` `harnessBlockReason`: return `null` (bypass unconnected Harness check) | `runtime-config.test.ts`: `联系人选 codex:派活在启动前被拦...` |
| `F4` | `run-ledger.ts` `reconcileOrphans`: drop `u.status === "running"` guard on `!probe.alive(u.pid)` | `orphan-pid.test.ts`: `等人回答的单元不按执行进程判定...` |
| `F5` | `progress-get.ts` `progressGet`: drop `visibleRuns([u], viewer)` check | `runtime-config.test.ts`: `progress_get 可见范围...` |

## Round 2 — APPROVE

**Reviewed HEAD:** `943b9d9523ffed4513cebf9cea7fb7992591fd6f`  
**Base:** `origin/dev/agy-backend` at `926956560af22959c726953cfb4248f4056e3155`  
**Content hash:** `6eb4a7937a27ab36a9a0c0df0a262e9eda2c8f5355133da41da429d58635dff7`  
**Author:** `codex-cli:01a1ec1b-5225-7370-80a4-3596ddbad3a4` (`shayu/gpt-6.2-sol`, OpenAI)  
**Reviewer:** `antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98` (`carbon-agy` / `gemini-4-carbon-high`, Google)

### Round 1 findings verification

1. **Round 1 P1 #1 (`AC-23` / `AC-36` — `packages/server/src/db.ts:38–44, 93–159`, `packages/server/src/host.ts:520–524, 597, 1987–2002, 3710–3789`) — RESOLVED.**
   - `openDb()` checks `sqlite_schema` for `gg_compute_leases` **inside the same transaction** before executing `SCHEMA`, and invokes `migrateLegacyHolds(db)` into `gg_compute_legacy_holds` only when upgrading a pre-B1 database (`!hadLeases`), rolling back and closing the DB handle on error.
   - `migrateLegacyHolds(db)` excludes queued-only tasks (`!computeId && !orphans.length`) and tasks whose Compute instances are already `'completed'`, while persisting genuine pre-B1 `T3_Running` / `T4b_BlockedOnHuman` / `T9_StopRequested` holds across subsequent restarts.
   - On B1+ databases, `Host` reads `gg_compute_leases` (`savedLeases`) and `gg_compute_legacy_holds` (`uncertain`) directly without fabricating phantom `uncertain` holds from `task:*` docs.
   - `detachedStopConfirmed`, `recoverReleasedStops`, `cancelQueuedSpawn` (guarded by `this.quota.leaseOf(e.taskId) || this.stopUnconfirmed.has(e.taskId)` so in-flight `spawn` leases are never bypassed), and `ledgerResume` (re-binding persisted `compute-session` on post-restart `resume`) cleanly handle post-restart failure-card `retry`, `rerunRun`, `give-up`, `stopTask`, queued-only `T9`, and `completed`-before-`deliver` tasks, while preserving `T9_StopRequested` and lease quarantine whenever an unconfirmed lease or legacy hold exists.

2. **Round 1 P1 #2 (`R-17` / `AC-51` / `AC-26` — `packages/server/src/db.ts:81–85, 102–105`, `packages/server/src/host.ts:3598–3600, 3885–3929, 5134–5146`) — RESOLVED.**
   - `reviewerFor` resolves each candidate contact's Compute `{ harness, model, effort }` (`resolveComputeFor`) and prefers connected, compatible cross-vendor reviewers (`!this.reviewComputeProblem(c.resolved)`).
   - `spawnReview` re-verifies `reviewComputeProblem(resolved)` and `reviewModelProblem` at spawn time, routes via `this.adapterFor(harness, model)` with `{ model, effort }`, and falls back via `reviewFallback` with an explicit reason when unconnected or incompatible — **never** substituting `claude-code` for `codex`.
   - `openDb` migrates existing `gg_reviews` tables via `ALTER TABLE gg_reviews ADD COLUMN harness TEXT` (preserving `NULL` for historical pre-migration rows without fabricating `"claude-code"`), `spawnReview` persists `harness`, and both `adapterForCompute` and `Host.close()` route stop calls to the actual Harness adapter.

3. **Round 1 note (`packages/server/src/host.ts:2789–2792`) & Review History — RESOLVED.**
   - `progressGet` now filters `this.exits.leavingRoomsOf(contactId)` dynamically on every query (`compute-stop-restart.test.ts:311–336`).
   - Round 1 review in `reviews/feat-agy-p0-compute-stop.md` was preserved byte-for-byte verbatim, and `receipts/feat-agy-p0-compute-stop.json` accurately documents `R-02` incremental + combined Red SHAs, `AC-23`/`R-17` D-layer scope, and `AC-43`/`AC-51` `"未测"` X-layer boundaries.

### Commands and Round 2 verification evidence

```sh
node /tmp/gg-agy-rev-120/scripts/gates/run-all.ts --hash --repo=/tmp/gg-agy-rev-120 --branch=feat/agy-p0-compute-stop --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
node scripts/gates/run-all.ts --local --base=origin/dev/agy-backend --branch=feat/agy-p0-compute-stop
```

- `npm run typecheck`: exit 0.
- `npm run lint`: Biome checked 245 files, exit 0.
- `npm test`: **1767/1767** passed (`0` failed, `0` skipped, `0` todo, `0` cancelled).
- Zero test diff `eb1744c4..8f7a8da0` (`packages/**/*.test.ts`, `scripts/gates/*.test.ts`) and `bbf69bf8..8f7a8da0` (`compute-stop-restart.test.ts`).
- Isolated R2 incremental Red replay (`bbf69bf8cbe920e19e22a8120b270ce9814ed766` on R1 implementation): **14/14** named tests in `compute-stop-restart.test.ts` failed (`0` passed, `0` skipped).
- Isolated combined R1+R2 Red replay (`eb1744c444a7469a06e20ea33cfc2d46452c48cf`): 12 changed test files ran `115` tests with **73 named assertion failures** and `42` unchanged passing controls (`0` skipped).
- Isolated Round 2 single-site fault injections (`4/4` killed in `/tmp/gg-agy-fault-120`, then deleted):

| Fault ID | Single-point mutation | Caught by named test(s) |
|---|---|---|
| `R2-F1` | `db.ts` `openDb`: skip `migrateLegacyHolds(db)` when `!hadLeases` | `compute-stop-restart.test.ts`: both pre-B1 migration & second-boot tests failed |
| `R2-F2` | `host.ts` `afterRound`: bypass `detachedStopConfirmed` check when `!a` | `compute-stop-restart.test.ts`: post-restart `give-up`, `stopTask`, and `completed`-before-`deliver` tests failed |
| `R2-F3` | `host.ts` `spawnReview`: drop `this.reviewComputeProblem(resolved)` check | `compute-stop-restart.test.ts`: disconnected & incompatible `codex` reviewer `R-17` tests failed |
| `R2-F4` | `host.ts` `progressGet`: drop `!leaving.has(r.id)` filter | `compute-stop-restart.test.ts`: `B1 R2 AC-43: progress_get hides a leaving room while membership is still present` |
