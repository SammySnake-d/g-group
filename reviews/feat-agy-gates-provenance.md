# PR #119 — independent review

## Round 1 — REJECT

**Reviewed HEAD:** `932ce94a6ca08fe58ba7ccf585ae0d132ade64c6`  
**Base:** `origin/dev/agy-backend` at `1ec576d5217d2a6301014c8479b111560dc4abec`  
**Content hash:** `ed5a4eba45fd6f002b1e7a093bd6d12f1793ba2081e9c0181bc96040cb70a7b4`

The reviewer was `codex-cli:01a1eb39-2d56-7e40-b55f-4605bc163b1e` (`shayu/gpt-6.2-sol`, OpenAI). The local rollout's first record confirms `originator=codex_exec`, the same session ID, and `cwd=/tmp/gg-agy-rev-119` (the filesystem resolves it to `/private/tmp/gg-agy-rev-119`). Its tool call and output records independently confirm the exact standalone command below, process exit 0, and the hash at the top of this report. The author receipt is `carbon` / `gemini-4-carbon-high`; the original session's SQLite model selector returned `gemini-4-carbon`, which maps to Google, consistent with the receipt's **vendor**. The actual reviewer tool turn has model `shayu/gpt-6.2-sol`, which maps to OpenAI (`scripts/gates/vendor.ts:4–17`). This observed vendor difference is not proof that every contributing Antigravity turn was Google.

### Blocking findings

1. **P1 — The only merge entry point selects a judge that cannot accept these harnesses (R-01, R-07, R-18).** `scripts/merge.sh:14–29` takes the judge from `origin/$BASE_REF` whenever that ref has a runner. The exact target base does have a runner, but its `scripts/gates/gates.ts:83–95` only recognizes `claude/codex/pi`, and that base's `scripts/gates/policy.json:1` does not recognize `codex-cli` as a reviewer. Independently ran the runner extracted from the pinned base against the pinned review checkout and the real receipt, with `--pr=119 --local`. It returned exit 1: `作者会话不可信:harness "antigravity" 不在白名单 claude/codex/pi 里`; the reviewer was rejected both by policy and by the old session regex (`格式必须是 <harness>:<id>…`). The same hash and receipt pass provenance under candidate code. Changing the verdict cannot resolve either base-judge incompatibility. Bootstrap the new judge through a separately trusted release/review path before relying on it for this branch; do not replace the trusted judge with PR-supplied code.
2. **P1 — Antigravity session-wide fallback does not attest the cumulative producer vendors (R-01 / AC-26).** `agyRecoverModel` returns only one latest compact model (`scripts/gates/gates.ts:145–160`); `loadSession` assigns it to *every* model-less tool turn (`:271–276`). `G-PROVENANCE` then treats those backfilled values as each turn's actual model (`:519–525, :545–555`). The author's real transcript contained 76 planner records with tools, all lacking a `model` field. No actual model switch was established in this session. The defect is representational: a session that did switch vendor loses the earlier vendor labels; the gate cannot enforce the cumulative set, and a historical review hash likewise inherits a later model. Recover and bind authoritative per-turn model evidence, or reject ambiguous turn attribution. Keep the existing WAL and compact-row controls; add a regression that distinguishes a stable session from a switched session.
3. **P1 — Alternate Antigravity roots do not get the same provenance-data isolation (R-07 / R-18).** The reader derives the database root as `../conversations` from the configured real brain directory (`scripts/gates/gates.ts:148–155, :255–275`). Seatbelt denies the fixed default conversations path, but adds only `AGY_BRAIN_ROOT` itself for an override (`scripts/gates/lib.ts:120, :146–157`). When the configured store is outside HOME, the derived conversations root is not covered by either rule. This is a static containment finding; no reads from any private directory were attempted in an isolation test. Derive both policies from the same canonical set of trusted roots and verify coverage for non-default roots with a neutral fixture.

### Review notes

- `scripts/gates/gates.ts:250–301` checks the canonical transcript/rollout path; the suite exercises out-of-root link rejection for both. The Codex parser pairs results by call ID and inherits the logged tool turn's model/cwd (`:191–245`); Antigravity relies on planner/result positions (`:104–136`). Wrapper stripping accepts the observed successful host output; exact stdout is compared at `:545`. For future hardening, retain and validate host exit status rather than discarding it, and bind rollout payload identity to the requested session rather than relying only on a filename suffix (`:173–188, :220–231, :279–301`).
- Reviewed write recognition, including `edit_file`, `run_command`, `Path` and `TargetFile` (`scripts/gates/gates.ts:331–359`). Reviewed policy mappings, `vendorOf`'s ambiguous/unknown handling, and the owner/PR/hash checks for waiver (`:480–500, :557–563`). `waiver` remained `null`; no merge or status write was attempted (R-10).
- `.githooks/pre-push:7`: `sh -n` passed; a neutral stub of npm gave hook exits **0 → 0** even when all successful output was filtered, and **7 → 7** with the diagnostic retained. `bash -n scripts/merge.sh` passed. The actual read-only protection lookup returned HTTP 404 with `Branch not protected` for `dev/agy-backend`, matching the no-`--required` branch at `scripts/merge.sh:35–40`. The script currently groups other API errors into the same branch; distinguish an explicit unprotected result from an indeterminate lookup rather than treating them alike.
- `scripts/gates/lib.ts:232–345, :432–456`: `@g-group/*` workspace links are rebound to snapshot copies rather than live packages, and dependency origins are carried across copies. The test controls cover ordinary/Red/mutated trees, missing workspaces, nested copies, and dependency origin replacement (`scripts/gates/workspace-isolation.test.ts:73–335`). macOS seatbelt was exercised; no live Linux Docker or GitHub merge was exercised.
- `G-RED`, `G-STUB`, and `G-TAUTO` use the `packages/` source/test predicates (`scripts/gates/lib.ts:66–68`); their green status is not proof of R-02/R-03/R-04 for the new gate tests. The independent Red replay and R-18 fault controls below provide that evidence for the changed gate behavior.

### Commands and evidence

```sh
git -C /tmp/gg-agy-rev-119 rev-parse HEAD
git diff origin/dev/agy-backend..HEAD --stat
node scripts/gates/run-all.ts --hash --branch=feat/agy-gates-provenance --base=origin/dev/agy-backend
npm run typecheck
npm run lint
npm test
npm run gates:selftest
GATE_MUTATION_JOBS=2 npm run gates:mutation
node scripts/gates/run-all.ts --local --base=origin/dev/agy-backend --branch=feat/agy-gates-provenance
node /tmp/gg-agy-fault-119/judge/scripts/gates/run-all.ts --repo=/tmp/gg-agy-rev-119 --base=origin/dev/agy-backend --branch=feat/agy-gates-provenance --pr=119 --local
```

- Typecheck and lint exited 0. `npm test` exited 0 with **1693/1693** passed, zero cancelled, skipped or todo.
- Candidate `npm run gates:selftest` completed all **243/243** cases and printed `自检通过` (Node 22.22.0, 302 s). The shell supervising the initial batch was stopped after selftest had completed to avoid launching a duplicate mutation run outside the isolated tree.
- Isolated Red tree at `af32b6353d4b035b09d8d803072d19f239cb110b`; `git diff <red> <head> --exit-code -- scripts/gates/antigravity.test.ts scripts/gates/workspace-isolation.test.ts scripts/gates/selftest.ts` was empty. `node scripts/gates/test-runner.ts 'scripts/gates/antigravity.test.ts' 'scripts/gates/workspace-isolation.test.ts'` ran 26: **24 named failures** (7 Antigravity/Codex and 17 workspace), with 2 passing controls. Examples include `stripRunCommandWrapper` (duplicate header), `stripCodexExecWrapper`, `agyRecoverModel` (compact row + WAL), `红快照再复制后 workspace 别名只加载红源码`, and `变异副本再复制后 workspace 别名加载变异源码`.
- `GATE_SELFTEST_JOBS=2 npm run gates:selftest` on Red exited 1 after **243/243** cases. All **24/24 newly added cases** failed by name (including both harness loaders, positive/negative vendor cases, wrapper and SQLite behavior, and seatbelt); two updated policy/injection checks also failed (`R5-03` and `R5-04`). The other 217 cases passed. This was a completed run, not an import or timeout failure.
- Full `GATE_MUTATION_JOBS=2 npm run gates:mutation` ran from the restored isolated candidate, exit 0. Its unmodified control passed; all **145 unique mutants were detected, zero survived** (outer concurrency 2, inner 4; Node 25.8.1; mutant phase 494 s).
- Candidate local gate run: **7/8, exit 1**. `G-PROVENANCE`, `G-TRACE`, `G-RED`, `G-STUB`, `G-TAUTO`, `G-WORKFLOW`, and `G-LAYER` passed; `G-REVIEW` reported `审查结论是 reject`. The base judge ran **6/8, exit 1** with `G-PROVENANCE` and `G-REVIEW` red. Both printed the reviewed hash unchanged. The stipulated all-eight condition for commit/push was not met.

#### Four independent single-point faults

Each run used the same named selftest in an isolated candidate tree (`GATE_SELFTEST_ONLY=<anchored case-name regex> GATE_SELFTEST_JOBS=1 npm run gates:selftest`). The unmodified control exited 0; one substitution at a unique site yielded exit 1 with the named case and `G-PROVENANCE` both red. Original bytes were restored before the next experiment.

| Fault | Named selftest | Observed failure |
|---|---|---|
| Remove `agyRecoverModel` size filter (`gates.ts:155`) | `antigravity 大 prompt blob 与非占位符行不干扰 sqlite 模型识别` (`selftest.ts:1206`) | Producer model/vendor was misidentified as Anthropic; the case observed the vendor mismatch. |
| Omit output normalization when pairing Codex `exec_command` result (`gates.ts:242`) | `codex-cli 审 carbon(antigravity)作者放行(跨厂商 OpenAI/Google)` (`selftest.ts:1272`) | The hash no longer matched the normalized result. |
| Permit only one Antigravity wrapper header (`gates.ts:100`) | `antigravity run_command 双重 header 与 \r\n 被正确剥离` (`selftest.ts:1225`) | The double-header tool result no longer matched the hash. |
| Change `carbon-agy` reviewer harness from `antigravity` to `codex` (`policy.json:1`) | `carbon-agy 审 codex-cli(shayu/gpt-6.2-sol)作者放行(跨厂商 Google/OpenAI)` (`selftest.ts:1316`) | The candidate rejected the expected Antigravity session under the wrong policy mapping. |

The isolated fault directory was deleted after the runs. No review-owned runner processes remained. The final candidate rerun again returned 7/8. No commit was created or pushed.

## Round 2 — REJECT

**Reviewed HEAD:** `67ca055a837c84d225ff231143f3cec9a5ec9e76`  
**Base:** `origin/dev/agy-backend` at `1ec576d5217d2a6301014c8479b111560dc4abec`  
**Content hash:** `b284575af17f28a5201708dca3d38017815ecf67554eafc32c1a4320a4dd4f1d`  
**Reviewer:** `codex-cli:01a1eb6c-a103-7983-a19c-12192a8c0b7c` (`shayu/gpt-6.2-sol`, OpenAI)

The active native rollout's `session_meta` reports `originator=codex_exec` and literal `cwd=/tmp/gg-agy-rev-119-r2`. Its `turn_context` and the standalone `exec_command` call/result bind the reviewer model, exit 0, and exact `--hash` stdout to this review. The candidate loader attributed all 98 logged author tool turns to Google; its provenance check accepted the genuine Google/OpenAI session pair. No waiver was used.

### Blocking finding

**P1 — Codex CLI rollouts without an internal session ID are accepted (R-01/R-07).** `codexCliRolloutToTurns` (`scripts/gates/gates.ts:220–260`) reports a mismatch only when `metaId` is defined. It does not require a matching `session_meta` ID before returning `ok: true`; `loadSession` forwards that success (`:292–313`). In an isolated neutral fixture, the same loader returned **accepted** with a matching ID, **rejected** with a different ID, **accepted** with a `session_meta` record lacking an ID, and **accepted** with no `session_meta` record at all. Thus the new identity check is optional for incomplete or malformed rollouts. Require a nonempty matching native ID when `expectedId` is supplied and add negative tests for both omission cases. This does not invalidate the genuine Round 2 rollout, which contains the matching ID.

### Verified fixes and regression evidence

- Antigravity binds `s.step_index` to `last_step_index + 1` from the marked final 2 KiB of each SQLite metadata row, includes active WAL data, and leaves unmatched turns unknown. Named cases reject an Anthropic reviewer when authorship spans Anthropic and Google, and reject unknown producer turns.
- The loader and Seatbelt share the root resolvers in `lib.ts`. An actual Seatbelt run against neutral, non-HOME fixtures denied the symlinked brain's real store, its derived conversations and plugin-data siblings, and the Codex CLI session root (`EPERM` × 4); a work-directory control remained readable.
- Both wrappers leave recognized nonzero results unstripped. The merge-script test exercised HTTP 200 (`--required`), explicit 404 `Branch not protected` (ordinary checks), and HTTP 500 (no checks or merge). `scripts/merge.sh` still selects the existing runner from `origin/$BASE_REF`. Under Owner Decision A3, this is the authorized Day-0 bootstrap onto `dev/agy-backend`; the isolated pre-B0 judge returned **6/8**, with old harness/policy failures in `G-PROVENANCE` and `G-REVIEW` (plus the reject verdict). That expected incompatibility is not a Round 2 finding; do not substitute the candidate as the trusted judge.
- Node 22.22.0: typecheck exited 0; plain lint was intercepted by the RTK ESLint-output parser, then `rtk bypass npm run lint` exited 0 (Biome, 234 files); `npm test` passed **1,694/1,694**, no skip/todo/cancel; full selftest passed **249/249**. `GATE_MUTATION_JOBS=2 npm run gates:mutation` passed its unmodified control and detected **150/150 mutations**, zero survivors.
- Isolated Red `5e7b6922bdb4b4297fa6886ca6740f24a3c36459`: the three test sources are byte-identical to the candidate. The gate test batch ran 35 with **25 named failures** (8 Antigravity/Codex/merge and 17 workspace isolation), 10 passing controls and no skips. All **30/30** new selftests failed by name on Red.

| Isolated single-site fault | Named selftest(s) that failed |
|---|---|
| Fall back to the session's latest model | `antigravity 作者中途换模(先 anthropic 后 google)累积生产厂商被拦`; `antigravity 作者存在未匹配到 gen_metadata 的工具轮次按 unknown 拦下` |
| Omit the real derived conversations root | `R7-01 自定义非 HOME 的 AGY_BRAIN_ROOT 及其派生 conversations/plugin_data 与 CODEX_CLI_SESSIONS_ROOT 一并拒读` |
| Strip the Codex wrapper for nonzero exit codes | `codex-cli 审查 hash 命令退出码非零被拦` |
| Skip the explicit Codex ID mismatch check | `codex-cli rollout 内部 session_meta id 与文件名不一致被拦` |

The five corresponding unmodified selftests passed; four mutants exited 1 on the named cases. The isolated replay/fault directory was deleted. No live GitHub merge or Linux Docker execution was attempted.

Candidate `--local`: **7/8**, exit 1, content hash unchanged. Only `G-REVIEW` failed (`审查结论是 reject`); `G-PROVENANCE` passed on the genuine sessions.

## Round 3 — APPROVE

**Reviewed HEAD:** `1297737782e9e0a39ccdfcb718571bfdd6092c16`

**Base:** `origin/dev/agy-backend` at `1ec576d5217d2a6301014c8479b111560dc4abec`

**Content hash:** `30a051ca66cf1c65eeb725586dae4e7c0d6e98177160ad0e5cca8c3219525f7b`

**Reviewer:** `codex-cli:01a1eb91-53d5-76f3-9cd9-1bf752899a17` (`shayu/gpt-6.2-sol`, OpenAI)

**Round 2 P1 closed (R-01/R-07).** `codexCliRolloutToTurns` now requires `seenMatchingMeta` for a requested session. It trims `session_id`/`id`, explicitly rejects a missing identity and a mismatching ID, and rejects a rollout with no matching metadata before returning success. `loadSession` supplies the requested ID and preserves those rejections. A separate 12-case neutral runtime matrix exercised both entry points: absent metadata, omitted/empty/whitespace-only identity, and mismatched identity were rejected; matching `session_id`, matching `id`, and matching `id` with a blank `session_id` passed.

The active native rollout has `originator=codex_exec` and literal `cwd=/tmp/gg-agy-rev-119-r3`. Its `turn_context` and paired tool records bind the reviewer model to the exact standalone hash command, exit 0 and the stdout above. The candidate loader independently matched that real call/result pair. The author receipt remains `carbon` / Antigravity (Google); no waiver was requested or used.

### Independent evidence

- With byte-identical HEAD test sources, Red `3ed37c681c0782d31c6062122344c22c420b49aa` failed the named parser/loader unit test and both named provenance cases (`codex-cli rollout 缺少 session_meta 记录被拦`, `codex-cli rollout 的 session_meta 缺少 session_id/id 被拦`). Both Red selftests completed all eight gates but wrongly allowed the incomplete fixture. Green `b71e9371eb23b82d63784f2a64623d921d5285c0` passed the same unit and both selftests: `G-PROVENANCE` rejected each fixture with `缺少 session_meta 身份标识`. The gate-script replay is separate from `G-RED`, which selects package tests.
- Node 22.22.0: typecheck passed; lint passed via `rtk bypass npm run lint` (Biome, 234 files) after the RTK wrapper reported an ESLint JSON parse error. Full `npm test` passed **1,695/1,695** (zero skipped, todo or cancelled); full selftest passed **251/251**. `GATE_MUTATION_JOBS=2 npm run gates:mutation` passed the unmodified control and killed **152/152**, zero survivors. Both new Codex metadata mutants were killed by their designated `G-PROVENANCE` cases.
- The unchanged full suites covered bidirectional cross-vendor checks, Antigravity turn-model attribution and unknown/mixed-vendor rejection, wrapper exit status, workspace snapshot isolation, and merge protection responses (200, explicit unprotected 404, and fail-closed 500). A live macOS Seatbelt probe denied reads of all four neutral custom roots (brain, conversations, plugin_data, Codex); the worktree control was readable. `sh -n .githooks/pre-push` and `bash -n scripts/merge.sh` passed.

| Isolated single-site fault | Observed named failure |
|---|---|
| Remove the `!seenMatchingMeta` guard | Missing `session_meta` selftest exited 1; the inner `G-PROVENANCE` unexpectedly passed. |
| Accept an absent `metaId` | Missing `session_id/id` selftest exited 1; the inner `G-PROVENANCE` unexpectedly passed. |
| Omit `agyConversationsRoot()` from `canonicalProvenanceRoots` | `R7-01` exited 1 because the deny rule lost the real derived conversations directory. |

Each fault had a passing unmodified control; all three failed for the intended reason, not a crash or timeout. The isolated fault copy was deleted.

**Scope:** Owner-authorized Day-0 bootstrap onto `dev/agy-backend` at `1ec576d5`. The existing judge on `origin/$BASE_REF` remains authoritative in `scripts/merge.sh`; the expected pre-B0 harness incompatibility is not a rejection of the candidate and this review does not waive the trusted judge. No live Linux Docker test or GitHub merge was performed.

Candidate `--local`: **8/8 passed**, exit 0; 17 changed files inspected. `G-PROVENANCE` and `G-REVIEW` passed using the live sessions and the reviewed content hash stayed unchanged.
