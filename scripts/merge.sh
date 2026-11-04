#!/bin/bash
# 唯一的合并入口:本机跑全部门禁(含 G-PROVENANCE 会话来源核对),CI 绿,才 squash 合并。
# 用法: scripts/merge.sh <PR号>
set -euo pipefail
PR="$1"
BR=$(gh pr view "$PR" --json headRefName -q .headRefName)
git fetch -q origin
git checkout -q "$BR" && git pull -q --ff-only
node scripts/gates/run-all.ts --base origin/main --branch "$BR" --local
gh pr checks "$PR" --required --watch --fail-fast >/dev/null 2>&1 || gh pr checks "$PR" --watch --fail-fast
gh pr merge "$PR" --squash --delete-branch
git checkout -q main && git pull -q --ff-only
