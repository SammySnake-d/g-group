# Delete comments

Use this playbook to reduce comments in a bounded repository slice.

## Scope

1. Bind the repository and the exact base revision before reading or editing source.
2. Enumerate code comments with file, line, span, and physical line count.
3. Record files touched by active worktrees, open PRs, or handoff freezes. Skip those files and include their existing counts in the ratchet baseline.
4. Classify each comment as redundant, hack-enabling, stale, decision record, or functional directive.

## Disposition

- Delete redundant and stale comments.
- Delete a comment that documents a hack or bypass, then open one issue for the underlying implementation. Include the original wording, source location, and why the behavior is a hack.
- Move each decision record to an ADR that retains the original wording and source location, then delete it from source.
- Preserve functional directives. The default allowlist includes shebangs, `@ts-expect-error`, `@ts-ignore`, `eslint-disable` and `eslint-enable`, `stylelint-disable` and `stylelint-enable`, Prettier directives, triple-slash references, `@vitest-environment`, bundler magic comments such as `webpackChunkName`, `@vite-ignore`, `#__PURE__`, `@__PURE__`, `@__NO_SIDE_EFFECTS__`, Biome ignore directives, license and generated markers, `istanbul ignore`, `c8 ignore`, `noqa`, `nolint`, and `type: ignore`.

When the classification is uncertain, preserve the information as a decision record and move it to an ADR. Do not alter implementation behavior while removing comments.

## Ratchet

1. Store a per-file disallowed-comment count from the bound base revision.
2. Fail lint when an existing file exceeds its baseline count.
3. Require zero disallowed comments in a new code file.
4. Keep the allowlist in the policy file beside the baseline so the rule and its exceptions are reviewable.
5. Run the repository lint entry point and the CI copy of the same rule.

## Active-work exclusion

Skip every file listed by an active worktree, open PR, or handoff freeze. Do not restore or rewrite those files while applying the cleanup. Their comments stay in the baseline and can be handled by a later run.

## Verification

1. Compare the base and candidate after stripping only comments and whitespace. The comparison must show identical code tokens.
2. Run typecheck, the repository check command, lint, and the full test suite.
3. Report deleted comment blocks and physical lines, remaining baseline comments, ADR paths, issue links, allowlisted directives, and any known test failure such as the `http-ws.test.ts:242` timeout.
