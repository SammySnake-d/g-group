# Q08 middle slice: one shared OS process cleanup implementation

Base: `3216bb1eeff5d1f0229b610cd37cb90e92db48c5` (the frozen pure Compute port slice). Initial primary semantic red: `3091ca6d29cdfdb36150cf7dea3c2e3b44a95fd9`. Complete same-body 12-name red: `9cae32b6d535d85433d08b8736a7d9b802386abd`.

## Scope and ownership

Candidate package/location: `@g-group/process-tools`, `packages/process-tools`, proposed layer `process`. This is an I/O utility below adapters, not domain/kernel, not a harness/session/pi/scheduling abstraction. CC one-shot and resident now delegate process stop requests and all-exit confirmation to it. A later Codex adapter will consume the same API. No Codex adapter or Host/start/G2 connection is claimed here.

Original `adapter-cc-compute/src/procgroup.ts` filename and every old runtime export remain a thin re-export. The moved process-table helpers are byte-identical to the base file. All seven original CC test files are byte-identical. The already-frozen first-slice source, runner and bundle are untouched.

## The stop boundary

`requestStop` is only a request: capture descendants before orphaning, SIGTERM the main, escalate to group SIGKILL after the caller's configured grace if the main has not exited. Existing CC `stopped` events still have their documented request-level meaning; they are not an all-exit receipt.

Only shared `quiesce` returns an all-exit receipt: actual main exit plus closure of captured descendants and currently discoverable group members, including setsid children whose parent chain was observable. Unreadable process enumeration fails closed. CC resident retains cleanup handles across its existing process replacements and delegates confirmation to the same implementation; its ordinary session/turn/model policy is not moved or replaced. (Round 2: confirmation is only required after `stop`, and a confirmed handle is dropped; see "Review round 2".)

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

## Status after review round 1 (replaces the earlier "Pending" list)

The first version of this section said: "All seven original CC tests on baseline and candidate, cloud full/type/lint, ordinary pre-push/push/draft PR, independent review and true provenance remain pending ... No cloud process has started." That was the state when the round-1 source was frozen and was never updated in the repository; the later round-1 cloud runs were only written into the PR description (R1-04). What actually happened since:

- Round-1 cloud numbers, reproduced independently by the round-1 reviewer on box2 against `229fb95a` (source: `reviews/feat-shared-process-cleanup.md`, section 2): original CC seven files 139/139 on base and on HEAD, new package + CC additions 15/15, bridge 2/2, typecheck/lint exit 0, full `npm test` 1502/1502, the nine named mutants killed.
- Independent review round 1: REJECT (`2ec80a5d`), four findings R1-01..R1-04. Round 2 below answers them.
- Still not done: AC-23 whole-product acceptance; real CLI; a real Windows run; the Codex adapter; trusted-main activation of the gate change. The round-2 commits are local at the time of writing (no push in this round), so the pre-push hook and GitHub self-check have not run on them.

## Review round 2 (rework on top of `2ec80a5d`)

Authorship: the nine commits up to `229fb95a` came from Codex (host session `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`, native sub-thread `01a1d043-1042-7e61-9981-968868c25de1`, gpt-6.1-sol). The round-2 commits after `2ec80a5d` come from host session `claude:484c2330-2f15-49ae-9f7a-145e467cedb1` (group/opus), written by a subagent of that session. The PR therefore has output from two vendors.

### What changed

R1-01 (a resident Compute whose turn failed was reported "stop unconfirmed" and kept its slot). `resident.ts` `quiesce`: when the Compute has not been stopped, an ended turn returns `{ok: true, killed: 0}` and touches nothing; the resident process stays, as in base where the Host fell back to `settled`. After `stop`, every handle of that Compute must still be confirmed. "End the resident process when a turn fails" was not done (review "needs a decision" item 2 recommends keeping base behaviour; this keeps it).

R1-02 (a kept handle re-enumerated by pid long after its main exited and could SIGKILL whoever held that pid). `cleanup.ts`:

- a confirmed handle remembers its receipt; later calls return it without enumerating or signalling. The resident adapter drops a handle from its list once confirmed.
- by the main's pid, the tree is only looked up (a) while the main is still unreaped (`capture`), and (b) once in the exit event, right after it was reaped, to record who is left in its group. If that pid is already listed again at that moment, nothing is adopted. There is no later lookup by the old pid.
- after the exit, other members of the old group are added, and the group is signalled, only while a member recorded as ours still holds that group id.
- a recorded process counts as "still that process" only while pid, group and, when both sides have one, start time (`ps lstart`, 2 s slack) match. A retired resident process's handle is kept until `stop`, possibly for hours, so pid + group alone is not enough for its recorded leftovers.
- if neither `ps` nor `pgrep` could be read in the exit event, the handle does not confirm.

R1-03 (eight of the reviewer's eighteen faults survived). New named tests, all in new files: `process-tools/src/cleanup-confirm.test.ts` (S-PROC-07..18), `adapter-cc-compute/src/shared-process-r2.test.ts` (S-PROC-CC-03..05), `server/src/resident-stop.test.ts` (S-PROC-HOST-01/02: real `Host` + real resident adapter + the repository's resident fake CLI). No test signals a process the test did not start: "unrelated" processes are groups the test starts itself, pid reuse is modelled with a stub child or a scripted `ps` table, and where a signal must not be sent `process.kill` is replaced by a recorder. Reviewer fault → witness → mutant:

| Reviewer fault | Named witness | Mutant in `proof/mutations.mjs` |
|---|---|---|
| A6 resident confirms only the last handle | S-PROC-CC-03 | M-CC-02 |
| A7 retire (fallback restart / idle reclaim) without capture | S-PROC-CC-03 | M-CC-03 |
| A1 no refresh of new descendants | S-PROC-10 (ps, pgrep only, ps only) | M-PROC-13, M-PROC-14, M-PROC-22 (the reviewer's literal form) |
| A10 one-shot stop without capture (frozen round) | S-PROC-CC-04 | M-CC-05 |
| A12 earlier capture accepted when unreadable after exit | S-PROC-11 | M-PROC-15 |
| A13 `requestStop` not idempotent | S-PROC-12 | M-PROC-16 |
| A16 resident `quiesce` does not wait for the main | S-PROC-CC-05 | M-CC-06 |
| A11 Windows reports success | S-PROC-13 (injected platform; no real Windows run) | M-PROC-17 |

The mutation list was only appended to: the nine round-1 cases are byte-identical, 26 round-2 cases follow (35 in total). The harness gained `--control` (same copies, no injection, every named witness must pass) and per-case copy scope so that cross-package mutants run against the mutated copy.

S-PROC-CC-02 and the bridge test S-PROC-CC-RESIDENT-01 previously expected "turn ended, process alive → `quiesce` false", which was the R1-01 defect written down as an expectation; both now expect `{ok: true, killed: 0}` with the process and its child still alive.

### Red

- Real red: `1199e03` — the new tests on the unchanged `2ec80a5d` implementation. S-PROC-HOST-01, S-PROC-CC-02, S-PROC-CC-03, S-PROC-07, -08, -09, -10, -13 failed by name. S-PROC-11, -12, -14 and S-PROC-CC-04 passed there: they are regression protection (the reviewed code already behaved that way; nothing pinned it).
- G-RED calibration red: `0b2440eaa05c14a627f75a7b1ae548be5d0eaa77` (development handbook principle 71). Same tests as the final tree; six production files replaced by red forms (`cleanup.ts` scaffold; `procgroup.ts` and `gates.ts` in their `19139462` forms; `resident.ts`, `adapter.ts` `quiesce` always unconfirmed; `host.ts` treats every confirmation as unconfirmed). The next commit restores all six byte for byte; `host.ts` and the seven original CC test files are identical to base in the final tree. `19139462` (round 1), `2366dc2` and `98b2788` (round 2, earlier test bodies) are previous calibration reds kept as history.
- Tests added after `1199e03` (S-PROC-15..18, S-PROC-CC-05, S-PROC-HOST-02) have no separate real-red commit; they are judged by the mutants and the calibration red.

### Observed results (box2, 4 cores, Node v24.21.0, HEAD `de400ae3b39bd370f1ad552b3015dbe31c9fb2ab`)

These are the round-2 author's own runs. `de400ae3b39bd370f1ad552b3015dbe31c9fb2ab` is the last commit that changes code or tests; the commit after it only updates this file and the receipt.

| Item | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | exit 0 / exit 0 |
| Original CC seven test files, base `3216bb1e` | 139/139, fail/cancelled/skipped/todo 0 |
| Original CC seven test files, HEAD | 139/139, same |
| This slice's seven test files (process-tools 3, gates layer 1, CC 2, server 1) | 32/32 |
| Legacy export + resident bridge (`proof/shared-process-bridge.test.mjs`) | 2/2 |
| Full `npm test` | 1519/1519, fail/cancelled/skipped/todo 0, exit 0 (round 1: 1502; +17 named tests) |
| Mutation list, positive control (`--control`, no injection) | 35/35 named witnesses pass, sources unchanged |
| Mutation list | 35 killed, 0 survived, sources unchanged. 34 by `ERR_ASSERTION` on the intended assertion; M-CC-01 by the named wait "等不到:failed 之后归还槽位" |
| The four round-2 test files repeated 30 times | 30/30 |
| Reviewer's 18 round-1 faults, re-anchored to this code (19 forms) | see "Sweeps" |
| Local macOS seatbelt `run-all.ts --local` | recorded in the PR description (run after this file was written) |

An earlier run on `8d347d1` gave 9/10 on the repeat; the failure was S-PROC-CC-03 resuming inside the window described below, fixed in the test (`3845cec`). The run on `983a3da` gave 30/30 and the numbers above except: 30/30 own tests, 1517 full, 31 mutants.

Sweeps (author's own, on `983a3da`, scripts kept with the hand-over evidence, not in the repository): the reviewer's 18 round-1 faults with anchors moved to the round-2 text, 19 forms: 18 killed by named tests (A8 also by the type checker); the literal A1 form (`if (snap)` → `if (false)`) survived because the `pgrep` refresh branch carried the `ps` case. 23 mechanical `if`-negations on `cleanup.ts`: 21 killed, 2 survived (failed-spawn resolve; `pgrep`-path exit record). All three are closed in `715a2bd` (S-PROC-10 "ps only", S-PROC-17, S-PROC-14 with `pgrep` only; mutants M-PROC-22..24). The same sweeps were started again on `de400ae3b39bd370f1ad552b3015dbe31c9fb2ab`; their result is in the PR description, not here.

### Found on the way, not changed here

A `resume` that reaches the resident adapter while it is still handling the exit of an idle-reclaimed process is not relaunched: the turn ends `failed` ("CLI 进程不在,输入没有写进去"). Probe with tight polling, 50 iterations each: base `3216bb1e` 21 lost, reviewed `2ec80a5d` 17, this branch 19; every lost resume arrived inside that window. It is base behaviour of the resident turn logic, outside R1-01..R1-04, and is left as is; S-PROC-CC-03 waits for the adapter to finish handling the exit before resuming. The original test "空闲回收后下一轮用同一会话 id…恢复" in `resident.test.ts` resumes without that wait and can hit the same window.

### Limits that remain

- Pid reuse cannot be produced for real in a test; S-PROC-08/09/15/16 model it (see above). Real kernel timing is untested.
- Start time comes from `ps` with one-second resolution; without `ps` (restricted sandbox, `pgrep` only) there is no start time and liveness is by pid.
- Windows: only the injected-platform refusal is tested. Round 1 changed Windows from base's "report success" to "refuse to confirm"; that is unchanged here and is one of the open decisions.
- Double-fork / system-managed daemons that left the parent chain before capture are not found (unchanged, original scope limit).

## Prepared frozen runner (round 1)

Round 2 did not use this runner (it ran the same commands from its own scripts). Outputs must be outside source:

```sh
node packages/process-tools/proof/cloud.mjs OUTPUT_DIR BASELINE_CHECKOUT CANDIDATE_HEAD
```

The runner verifies checkout identities and candidate-local workspace links, requires all original CC test bytes unchanged, preserves every command exit/output, and verifies the full tracked source seal after execution. Its parser-only selftest does not launch cloud work.
