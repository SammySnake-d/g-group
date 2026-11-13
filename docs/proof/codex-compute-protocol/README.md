# Q08 Codex native Compute protocol component (author proof)

Frozen prerequisite: PR91 `229fb95a1ea26ce16d12ca1cf253442c865dfe80`. This independent branch changes neither PR90/91 nor Host/start/G2 or production config.

## Contract and scope

`createCodexComputeProtocol` is a thin native app-server wire component, NOT a full `ComputeAdapter`. It reuses kernel `TurnModel`/`ComputeEvent`/`QuiesceResult`, plain-data validation, and process-tools cleanup. Native Codex owns thread/session persistence, history and turns. Only wire correlation and semantic terminals are held here; no replacement runtime/session manager, no CC tool table and no Host approval authority.

Initialize/initialized; thread/start and native thread/resume; turn/start with explicit model+effort; expectedTurnId steer; interrupt requires matching interrupted terminal; exit0 without terminal is failure; quiescence requires shared all-exit proof. Foreign IDs and unrelated notifications do not settle work. Early lifecycle buffering is bounded and concurrent turn admission is refused. Invalid native JSON converges to failure and missing config owner refuses without throwing.

Native generated ThreadStart/TurnStart schemas do not expose a verified arbitrary built-in per-turn tool allowlist. This component rejects every nonempty requested tools capability. Empty tools is NOT asserted to disable native built-ins, and read-only sandbox is NOT treated as per-tool authorization. Full ComputeAdapter capability isolation, Host registration, gateway-observed actual model switching and product AC-23/AC-51 are untested. Steer ack is not a semantic compliance claim.

## Observed at this source snapshot

17 owning tests pass, local typecheck/lint exit0. Sequential true red/green logs for CXP01-10/14/16/17 are retained externally; CXP11-13 were existing-code green controls, CXP15 was a green control. The final 17-body empty-protocol red calibration is RETROSPECTIVE, not a claim all tests preceded implementation. Red `0bbacb050b423a7efe0e53f987a3d1b9e89629f7`, identical test file SHA is in calibration.json.

Real Codex 0.167.2 was driven through this exported component (not only the previous raw probe): two exact marker completions, process restart/resume of the same thread, wrong-turn refusal, native matching steer acknowledgement and interrupted terminal. Both native clients quiesced, production config bytes stayed unchanged, credentials were not logged/written, isolated temporary config was removed, and no recorded native PID remained. Requested owner model/effort are recorded; no actual-model gateway attribution is claimed.

Cloud full/type/lint/17 owning, original CC baseline/candidate and 17 named mutants remain pending at this commit. Frozen subsequent output and push/native-gate logs will be in the self-contained review ZIP, rather than falsifying this snapshot as a post-hoc pass. Each mutant runs the complete 17-test suite and counts only its prebound named ERR_ASSERTION with no cancellations/skips/todos; executor failures/survivors remain reported.

Six original mechanical gates, ordinary pre-push, draft PR, independent review/provenance and actual Mira Bot delivery remain pending at this snapshot. No review signature or merge is supplied by the author.

## Exact sources

Codex CLI 0.167.2 generated TypeScript schema observed locally, ThreadStartParams/ThreadResumeParams/TurnStartParams/TurnSteerParams/TurnInterruptParams/UserInput; official app-server documentation at `https://learn.chatgpt.com/docs/app-server`. This component's same-body tests are the executable contract for this bounded slice.

The first original seatbelt gate run failed (CXP11 ps EPERM; return-value calibration typing; `test.after` mistaken as test registration). Originals are retained. The test now independently enumerates with ps/pgrep, never treats enumeration errors as absence, imports the after hook explicitly, and production send has an explicit boolean return type. No gate or sandbox/assertion was weakened. Final full-body red calibration was repeated after those body changes.
