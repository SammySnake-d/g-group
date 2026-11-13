# Shared Compute port extraction (stack 1/2)

Base: `272b1b5d77bd95f34467a5aa04d0bf5891355887` (`feat/runtime-config`, PR #77).
Owning-kernel red: `ec4610e1ea58fe785148775f1b46cd5cfe87e15a` (same S-PORT-02 body, named `ERR_ASSERTION`, neutral implementation absent). The earlier legacy-alias red `37c697d52aabf3882e6797154c09fb09a1aff025` and its results remain in history/evidence.

## Ownership and compatibility

`@g-group/kernel/compute` owns the existing Compute port shapes and effect-free input validators, following kernel `runtime-ports.ts`'s existing `ContactMind` placement. Domain's entity/CAS/log shapes remain unchanged. The root kernel `plainData` has different undefined-property semantics and is NOT substituted.

CC `types.ts`, `plain.ts`, `brief.ts`, package root and resident exports stay available. `ClaudeRunner`/`AdapterOptions` and the unchanged `CC_BUILTIN_TOOLS` policy stay in CC; the shared validator receives an explicit harness-owned tool list. No Host/start/G2 integration and no Codex implementation in this PR.

`procgroup.ts` remains byte-identical in the adapter: `signalGroup` has OS effects while kernel explicitly does no I/O. No layer or gate changes. PR #74 at `21ac0887b271779a012054f50e61586f59e2e3be` changes `adapter.ts`/`resident.ts` and adds isolation/stop-confirm modules, but does not change the moved type/plain/brief files; those changed lifecycle sites are untouched here.

## Observed narrow proof

- All original 7 CC test files are byte-identical (no edits or weakened assertions).
- All moved port type declarations compare AST-identical; the original pure-data module is byte-identical.
- Original and extracted CC brief/snapshot/pure-data outputs, undefined-field shape, frozen flags and zero getter/Proxy invocation counts compare byte-identical using the same before/after observer.
- Owning-kernel S-PORT-02 witness: named assertion RED -> 1/1 GREEN. The complete legacy-alias S-PORT-01 assertions are retained in `shared-port-legacy.test.mjs`, explicitly executed by the invariant proof (1/1 GREEN); they are not silently replaced by type-only or same-alias comparisons.
- Eight prebound wrong implementations: 8 assertion kills, zero survivors; passing, TypeError and cancelled controls are not counted as kills. Mutants use disposable copies with checkout-local workspace links; source seals stay unchanged.
- Local typecheck and lint after the ownership correction both exit 0, under `nice -n 10 lockf /tmp/gg-cov-local.lock`.

`thin-proof.tar.gz` preserves the actual narrow logs, all red rounds, both initial mechanical failures and final `thin-proof-v3/` source seals. These observations are NOT a replacement for original CC/full-suite cloud acceptance.

### Retained mechanical failure and correction

The first mechanical run at `cf6cb4a8798e5807da972d6096aec08ba404d6f4` failed G-STUB: `freshCopy` in the unchanged gate library links `node_modules` to its source checkout, so cross-package kernel imports do not execute the transformed kernel copy. No gate, production behavior or original CC test was changed to force a pass. The new default test now lives beside the owning kernel implementation and uses relative imports, so return mutations exercise that copy. All legacy alias/policy assertions remain in the independent process proof, whose disposable copies explicitly bind workspace links to their own copied kernel source. This distinguishes test ownership from runtime alias compatibility and records the failed gate instead of suppressing it.

A second run at `87bb063675cbadd92a7c058bb2fed99c3d052b4f` passed G-STUB but failed G-TAUTO because the static lineage checker does not recognize dynamic-import results. The original owning assertions were retained, and a directly imported, real kernel-root negative control was added: its existing validator drops `undefined`, while the extracted Compute validator must preserve the field. This checks the actual alternative implementation that must not be silently substituted; it is not a fabricated model or weakened assertion. The strengthened same-body red above is reachable from the candidate history. Gates and all original CC tests remain unchanged.

## Pending cloud acceptance

Not started: cloud original 7 CC tests on baseline and candidate, candidate type/lint/full. Box4 shared-lock queue is owned by the parent; Q08 must wait until after loop-CA2, contact quota, AC-08 disclosure and Q05. No cloud job, normal push, PR, independent review or Host connection is claimed yet.

Once the parent admits this slice, provision clean, separate baseline/candidate checkouts with their own `node_modules/@g-group` workspace links, then invoke under the existing shared flock:

```sh
node packages/adapter-cc-compute/proof/shared-port-cloud.mjs OUT BASELINE_CHECKOUT FIXED_CANDIDATE_HEAD
```

The runner validates the fixed identities, exact original test bytes, local workspace links and full tracked-source seal, records every command's exit plus raw stdout/stderr, and preserves a failed result rather than treating an executor failure as acceptance.
