# REVIEW 1: REJECT 9cf5bea5f2756e1e4ebc471264344e626f3d247e43039bd4ee244378d01d3bd3

## Round 1 — REJECT

- **PR**: `#126` (`feat/agy-priority-codex-protocol` → `dev/agy-backend` at `0683b560`)
- **Author**: `codex-cli:01a1eea6-33fc-7510-965f-bbdab05304c0` (`fnqtz-gpt/gpt-6.1-sol`, vendor `openai`)
- **Reviewer**: `carbon-agy` (`antigravity:a4bfdfec-aaac-4a0e-b215-c3d5f158ba98`, `gemini-4-carbon-high`, vendor `google`)
- **Red Commit**: `64e43d187a247c38856d3de59057bf387b5228f1`
- **Green Commit**: `7f58a64ab727f07f3ae04cb50ed6bf6a4fcc23cb`
- **Reviewed HEAD**: `741f622c8529f64430018ac328416db11a5a5be0`
- **Reviewed Content Hash**: `9cf5bea5f2756e1e4ebc471264344e626f3d247e43039bd4ee244378d01d3bd3`

### 1. Blocking Defects (P1 — Live-Reproduced Against HEAD `741f622c`)

#### P1-1: `Host.switchHarness` leaves `e.computeId` trapped in `this.harnessRetiring` on `next.spawn()` refusal/failure — causing permanent event blackhole, permanent Compute quota lease leak, and permanent `T9_StopRequested` cancel deadlock
- **Location**: `packages/server/src/host.ts:3963, 4218-4256`.
- **Root Cause**:
  1. `Host.switchHarness` adds `e.computeId` to `this.harnessRetiring` (`host.ts:4218`), then calls `previous.stop(e.computeId)` + `previous.quiesce(e.computeId)` (`gg_compute.status = 'stopped'`, `runs.end(sessionId, "done")`, and for `adapter-cc-compute/resident.ts` permanently sets `st.stopped = true`), and only *afterward* calls `next.spawn(...)` (`host.ts:4244`).
  2. If `next.spawn(...)` returns `{ ok: false, reason }` (for example, Codex refusing `opts.pluginDirs` with `"Codex skill plugins are not mapped"`, Codex refusing a non-default tool whitelist `"Codex cannot enforce this per-tool whitelist"`, or any startup failure), `host.ts:4248` executes `return this.turnRefused(e.taskId, e.computeId, row, r.reason)` **without removing `e.computeId` from `this.harnessRetiring`**, while `task.computeId` still points to `e.computeId`.
  3. Because `Host.onComputeEvent` (`host.ts:3963`) drops every event matching `this.harnessRetiring.has(ev.computeId)`, any subsequent lifecycle event for `e.computeId` is silently discarded forever.
- **Live Reproduction Evidence (against HEAD `741f622c`)**:
  1. **Permanent Event Blackhole + Compute Quota Lease Leak**: Started a task on `claude-code` (`cc-1`), switched contact to `codex` whose `spawn` returned `{ ok: false, reason: "Codex cannot enforce this per-tool whitelist" }`, then reverted contact back to `claude-code` and sent a follow-up. `resumeCompute` acquired a Compute lease and resumed `cc-1`, but `onComputeEvent` dropped every `cc-1` event → `afterRound` never fired → `{"leaseStillHeld":true,"computeStatus":"stopped"}` (permanent Compute slot leak and wedged task). On real `resident.ts`, `st.stopped === true` additionally causes `resume()` to fail permanently with `"这个 Compute 已被停止"`.
  2. **Permanent `T9_StopRequested` Cancel Deadlock**: After the failed `codex.spawn`, called `host.taskDecision(t1.id, "cancel", "cancel-after-failed-switch")`. `task` transitioned to `T9_StopRequested`, issued `stop` on `cc-1` (`stopCalls: 2`), whose `stopped` event was dropped by `harnessRetiring` → task remained permanently stuck in `{"state":"T9_StopRequested","stopCalls":2}` instead of reaching `T10_Cancelled`.
- **Required Fix**:
  1. Clear `this.harnessRetiring.delete(e.computeId)` once `previous` quiesces (or on `!r.ok` / `catch`), never leaving an active `task.computeId` stuck in `harnessRetiring`.
  2. Recover cleanly when `next.spawn` fails after retiring `previous` (and/or preflight destination tool/plugin compatibility before stopping `previous`):
     - Cancelling a task whose `computeId` was already stopped & confirmed (no active lease, not unconfirmed) must transition cleanly to `T10_Cancelled` (`StoppedConfirmed`) rather than hanging in `T9_StopRequested`.
     - Reverting to `row.harness` after `previous` was already stopped during a failed handoff must not try to resume a permanently stopped `resident` instance or leak a quota lease (spawn a clean replacement session on `row.harness` or preserve `previous` when destination preflight fails).
  3. Add regression tests in `packages/server/src/harness-switch.test.ts` covering both failed `next.spawn` → cancel (`T10_Cancelled`) and failed `next.spawn` → revert/retry without event blackhole or quota leak.

#### P1-2: `createCodexComputeAdapter` refusal/lifecycle paths and `Host.switchHarness` missing-harness/quarantine guards are uncovered in `packages/**/*.test.ts` (Fault Injections `P1B-F5` & `P1B-F6` Survived)
- **Location**: `packages/adapter-codex-compute/src/adapter.ts`, `packages/adapter-codex-compute/src/protocol.test.ts`, `packages/server/src/harness-switch.test.ts`.
- **Root Cause**:
  1. `packages/adapter-codex-compute/src/adapter.ts` (151 LOC) has **zero** behavioral tests in `packages/**/*.test.ts` (only a 1-line `assert.doesNotThrow(() => factory("gpt-6-astra"))` in `harness-switch.test.ts:12`; all actual adapter lifecycle checks live only in standalone `proof/wire.mjs` / `proof/p1b-handoff.mjs`, which `npm test`, `G-RED`, and `G-STUB` do not execute). Injecting `P1B-F5` (bypassing `if (opts.pluginDirs?.length) return refuse("Codex skill plugins are not mapped")` at `adapter.ts:70`) survived with **0 failures** in `protocol.test.ts`, despite the receipt and spec explicitly asserting refusal of Claude skill plugins and partial tool whitelists.
  2. `packages/server/src/harness-switch.test.ts:49,84` states `"; missing harness blocks before stop"`, but lines `76-81` only test an incompatible model while both harnesses remain registered. Injecting `P1B-F6` (bypassing `harnessBlockReason(resolved.harness, connectedHarnesses(this.factories))` at `host.ts:4193`) survived with **0 failures** in `harness-switch.test.ts`.
- **Required Fix**:
  1. Add `*.test.ts` tests covering `createCodexComputeAdapter` (`spawn`, `resume`, `stop`, `quiesce`, `snapshot`, `opts.pluginDirs` refusal, partial tool-subset refusal, and `[]` vs full `DEFAULT_NATIVE_SCOPE` sandbox mapping).
  2. Add `*.test.ts` tests in `packages/server/src/harness-switch.test.ts` covering unconnected/missing destination harness (blocked before `previous.stop`) and unconfirmed `quiesce` quarantine (retaining stopping lease and blocking `next.spawn`).

### 2. Non-Blocking Notes (P2)

- **`packages/adapter-codex-compute/src/adapter.ts:122`**: On active-turn `stop()`, `slot.client.interrupt` resolves before `pump(slot)` drains the async generator into `slot.history`, so `slot.history.at(-1)?.kind !== "stopped"` can emit a duplicate `"stopped"` event. Guarding with an explicit per-turn stopped flag avoids duplicate emission.
- **`packages/adapter-codex-compute/src/{adapter,protocol}.ts`**: 9 Biome `lint/style/useTemplate` informational diagnostics (0 warnings/errors); cleanable in Round 2.

### 3. Verified Passing Areas & Independent Evidence

- **Passing subsystems**:
  - `@g-group/process-tools` (`process` layer): clean separation, shared by `adapter-cc-compute` (one-shot + resident) and `adapter-codex-compute`; `lstart` identity matching (`LC_ALL=C`), exit-handler `recordGroupAtExit()`, dynamic descendant refresh, memoized `confirmed` receipt, Windows/unreadable-`ps` refusal.
  - `@g-group/adapter-codex-compute/src/protocol.ts` & `startup.ts`: `codex-cli 0.169.0` `app-server` wire alignment (`initialize`/`initialized`, persistent `thread/start`, exact-id `thread/resume`, `turn/start` model+effort, `turn/steer`, `turn/interrupt`), `HOME` vs isolated per-slot `CODEX_HOME` (`realpathSync` check), startup concurrency 2 / queue 32, per-method RPC timeouts, 1 MiB line cap, zero per-line `ps` (`R1-03`), configured grace windows (`R1-05`).
  - Docs & receipt honesty: `docs/BACKEND-PROGRESS-CHECKLIST.md`, `docs/spec/验收文档-v0.1.md`, `README.md`, and `receipts/feat-agy-priority-codex-protocol.json` honestly keep `AC-23`, `AC-51`, and `V-02` `"未测"`.
- **Independent Verification Runs**:
  - `npm run typecheck`: exit `0`; `npm run lint`: exit `0` (0 warnings/errors, 9 infos).
  - Full offline `npm test`: **`2148/2148` passed** (`0` failed/skipped/cancelled/todo).
  - Standalone deterministic proofs (`wire.mjs`, `resources.mjs`, `startup.mjs`, `p1b-handoff.mjs`): all passed.
  - Red commit (`64e43d18`) replay: `RED_EXIT=1` (0 test edits between `64e43d18` and `7f58a64a`).
  - Independent fault injections:
    - `P1B-F2` (`cleanup.ts:125` `exitRecord === "unreadable"` guard): **KILLED** (`S-PROC-18`).
    - `P1B-F3` (`protocol.ts:254` `codexHome` owner check): **KILLED** (`CXP-17`).
    - `P1B-F4` (`protocol.ts:280` `thread/resume` id check): **KILLED** (`CXP-R1-01`).
    - `P1B-F5` (`adapter.ts:70` `pluginDirs` refusal): **SURVIVED** (`0` failures → P1-2).
    - `P1B-F6` (`host.ts:4193` `harnessBlockReason` guard): **SURVIVED** (`0` failures → P1-2).
