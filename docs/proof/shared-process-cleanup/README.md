# Q08 middle slice: one shared OS process cleanup implementation

Base: `3216bb1eeff5d1f0229b610cd37cb90e92db48c5` (the frozen pure Compute port slice). Initial primary semantic red: `3091ca6d29cdfdb36150cf7dea3c2e3b44a95fd9`. Complete same-body 12-name red: `9cae32b6d535d85433d08b8736a7d9b802386abd`.

## Scope and ownership

Candidate package/location: `@g-group/process-tools`, `packages/process-tools`, proposed layer `process`. This is an I/O utility below adapters, not domain/kernel, not a harness/session/pi/scheduling abstraction. CC one-shot and resident now delegate process stop requests and all-exit confirmation to it. A later Codex adapter will consume the same API. No Codex adapter or Host/start/G2 connection is claimed here.

Original `adapter-cc-compute/src/procgroup.ts` filename and every old runtime export remain a thin re-export. The moved process-table helpers are byte-identical to the base file. All seven original CC test files are byte-identical. The already-frozen first-slice source, runner and bundle are untouched.

## The stop boundary

`requestStop` is only a request: capture descendants before orphaning, SIGTERM the main, escalate to group SIGKILL after the caller's configured grace if the main has not exited. Existing CC `stopped` events still have their documented request-level meaning; they are not an all-exit receipt.

Only shared `quiesce` returns an all-exit receipt: actual main exit plus closure of captured descendants and currently discoverable group members, including setsid children whose parent chain was observable. Unreadable process enumeration fails closed. CC resident retains cleanup handles across its existing process replacements and delegates confirmation to the same implementation; its ordinary session/turn/model policy is not moved or replaced.

Existing scope limit remains explicit: already reparented double-fork/system-managed daemons that escaped the discoverable tree before capture cannot be found. The original negative CC fixture still demonstrates that limit and cleans its own daemon afterward. Windows tree confirmation is fail-closed, not advertised as implemented. No container/OS-wide process killing.

## G-LAYER change: separate review focus

Only one permission is added: `adapter -> process`. `process -> domain/kernel/adapter/plugin/app` is not granted; domain/kernel/plugin/app cannot import or declare process dependencies; adapter -> adapter, plugin -> plugin and relative cross-package prohibitions remain. Domain/kernel/Host/start/G2 source bytes are untouched.

Candidate G-LAYER has five direct direction controls and four real CLI selftest fixtures (new direction allowed; adapter->adapter, kernel->process, domain->process rejected). Trusted-main gate activation is a review/merge concern: candidate selftests do not claim that the old trusted-main G-LAYER accepts the new layer. Do not bypass or weaken CI.

## Observed thin proof

- Existing CC quiesce baseline: 5/5; candidate unchanged file: 5/5.
- Shared real cleanup: 6/6, including captured detached child, unexited-main refusal, SIGTERM refusal/escalation, invalid inputs, real unavailable ps/pgrep.
- New owning CC one-shot/resident integration: 2/2; total owning tests 15/15. The named three-child witness first proves all three children remain live after main exit 0, then requires all three actual exits before success.
- Moved pure helper controls: 2/2. Direct G-LAYER controls: 5/5.
- Original resident file: four selected named tests pass (same PID/session, fallback restart, stop, pending resume invalidated by stop). This is not the full original CC suite.
- Legacy export identity and resident detached-child bridge: 2/2.
- Nine pre-bound mutants killed by their exact named witnesses; zero survived, candidate unchanged during proof.
- Real CLI G-LAYER selftest: 4/4. Local typecheck/lint passed.

Retained executor events: two local shared-lock acquisition exits 75; initial typecheck exit 2 due incomplete local external dependency links. Rebinding missing external dependencies (workspace aliases remained candidate-local) fixed it, corrected typecheck exit 0. These failures are not erased or called product successes.

## Final same-body calibration and preserved correction

Final red commit `19139462faa651a5f35b39251c8ba8d1da2eb2dd` has 15 named ERR_ASSERTION failures, zero passes, no skip/cancel. The final green executes the exact same four test files (SHA sealed) and passes 15/15. This is retrospective red calibration of an already-observed green implementation, not a claim that every witness was written before implementation. Earlier 1-name, 12-name and 15-name intermediate reds remain history, not final acceptance evidence.

The added CC tests initially caused TypeScript exit 2 (TS2339): `assert.equal(result.ok, true)` had already narrowed a later failure guard to never. Only its fallback error text was corrected; no assertion was weakened, no compiler option changed. Final red was rerun after that change; final typecheck and lint exit 0. Nine exact named mutation failures were independently checked to contain ERR_ASSERTION, not just nonzero exits.

Self-contained local logs: `thin-proof-v4.tar.gz`, SHA256 `1751a3db0f92a3b42e861acd1628876bea341b1fb0265d30b47e813b0c964171`. The parser selftest passed its positive and negative controls only; it did not launch cloud work.

## Actual mechanical failure and corrected owning fixtures

The first full native mechanical command exited 1; its original output is retained. Seven green witnesses failed because their test-only OS liveness helper invoked setuid `ps`, denied by macOS seatbelt (EPERM). Production already had a pgrep fallback. The two new test files now perform an independent OS pid listing with pgrep only when ps is unavailable; unavailable pgrep throws, never means empty. Original seven CC files are unchanged.

S-PROC-05 originally ran a subprocess-only oracle, not visible to in-process G-STUB arming/static G-TAUTO. It now directly invokes the real shared cleanup API on an exited owned child while PATH makes both enumeration tools unavailable, restores PATH in finally, and asserts refusal/reason/remaining. No assertion deletion, skip, gate suppression or sandbox weakening. The real gate-owned `runNodeTests` seatbelt path now runs all 15 names green. Final RED also stubs both owning CC factories, so a snapshot cannot accidentally get the current green shared package through workspace aliases. Final formal gate output is kept outside the frozen source; the command result, not this paragraph, is authoritative.

## Pending, not accepted

All seven original CC tests on baseline and candidate, cloud full/type/lint, ordinary pre-push/push/draft PR, independent review and true provenance remain pending. AC-23 whole product acceptance remains untested. No cloud process has started. Root owns admission after Q14 -> Q04 -> Q12 -> Q05 -> Q08.

Prepared frozen runner (outputs must be outside source):

```sh
node packages/process-tools/proof/cloud.mjs OUTPUT_DIR BASELINE_CHECKOUT CANDIDATE_HEAD
```

The runner verifies checkout identities and candidate-local workspace links, requires all original CC test bytes unchanged, preserves every command exit/output, and verifies the full tracked source seal after execution. Its parser-only selftest does not launch cloud work.
