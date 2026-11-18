# Backend Engineering Lessons (Seen 3× Rule)

Log real regressions and their repair here. When a pattern appears three times, encode it in [code standards](docs/code-standards.md) or a mechanical check. Existing project rules apply from the first occurrence.

| # | What went wrong | Rule and evidence |
| --- | --- | --- |
| 1 | Node I/O in pure domain or kernel couples decisions to the host. | Move `node:fs`, `node:child_process`, networking, and worker I/O into process helpers or adapters as the layer rules allow. [Structure gate](scripts/check-structure.ts) |
| 2 | `.test.mjs`, `.test.cjs`, and `.spec.ts` silently fall outside package test discovery. | Name package tests `*.test.ts` and confirm the runner executed them. [Test runner](scripts/gates/test-runner.ts) |
| 3 | A stale cherry-pick or stale-tree revert restores old files over landed work. | Compare the fresh target and your slice with `git diff --stat`, then inspect unexpected changes before staging. |
| 4 | A mutable row identity undermines append-only SQLite history. | Use stable explicit primary keys and `WITHOUT ROWID` for new append-only tables. [Contact config history](packages/server/src/contact-config-history.ts) |
| 5 | Removing or renaming a shared RPC or event breaks the frontend mirror. | Preserve the 1:1 `@g-group/api-contract` surface. Additive backend entries may land ahead of frontend wiring. [Contract gate](scripts/check-contracts.ts) |
| 6 | A throwing `Host` constructor can bypass cleanup registered afterward. | Register `t.after` for the temp directory before calling `new Host`. Register closing the Host after it exists, with teardown ordered so the Host closes before directory removal. |
| 7 | Shell globs in zsh can miss scratch cleanup, and leftover test processes keep using temp files. | Stop and await owned child processes and remove the exact scratch path with Python `shutil.rmtree`. Keep `/tmp` clear of slice artifacts. |
| 8 | Treating a synthetic cache fixture as a product limit would drop global rules and could fall below provider prompt-cache minimums. | AC-42 ⑥ and #2391 constrain Block 1 admission and byte stability only. Block 1 has no character or token truncation limit. The `< 4000B` assertion checks the synthetic 3,997B prefix while 11.4KB of `query_history` output leaves `wirePrefix` unchanged. [Recall regression](packages/adapter-pi-contact/src/recall.test.ts) |
