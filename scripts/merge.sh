#!/bin/bash
# 唯一的合并入口:钉住 PR 当前 head,本机对这个 head 跑全部门禁(含 G-PROVENANCE),
# CI 对同一 head 是绿的,合并时要求 head 仍是它(--match-head-commit),否则拒绝。
# 用法: scripts/merge.sh <PR号>
set -euo pipefail
PR="$1"
read -r BR SHA < <(gh pr view "$PR" --json headRefName,headRefOid -q '.headRefName + " " + .headRefOid')
git fetch -q origin "$BR" main
WT=$(mktemp -d); trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
git worktree add -q --detach "$WT" "$SHA"
ln -s "$(pwd)/node_modules" "$WT/node_modules"
(cd "$WT" && node scripts/gates/run-all.ts --base origin/main --branch "$BR" --local)
STATE=$(gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" -q '[.check_runs[] | select(.name=="gates")][0].conclusion')
[ "$STATE" = "success" ] || { echo "CI gates 在 $SHA 上不是 success($STATE)"; exit 1; }
gh pr merge "$PR" --squash --delete-branch --match-head-commit "$SHA"
