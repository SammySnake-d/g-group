# Gates and Autonomy

`scripts/` owns the fast docs, contract, and structure checks, the advisory suite lock, the protected gate runner, and the merge entry. `.githooks/` runs the fast check before commits, checks large commit trailers, and serializes the pre-push suite. Enable the hooks with `git config core.hooksPath .githooks`.

Run `npm run check` before the full test suite. Use `npm run gates:selftest` and `npm run gates:mutation` when changing gate behavior. The repository test runner includes `scripts/gates/*.test.ts`. The branch replay, stub, and tautology selectors use package tests, so governance test evidence is recorded directly. The [receipt format](../RECEIPT.md) and independent review govern protected merges through [merge.sh](../../scripts/merge.sh).
