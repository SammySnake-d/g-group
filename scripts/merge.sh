#!/bin/bash
# 唯一的合并入口。用 main 上的门禁(裁判)检查 PR 当前 head:
#   1. 钉住 head SHA,在隔离 worktree 里跑全部门禁,含 G-PROVENANCE(本机会话与群聊原始记录)
#   2. 通过后在这个 SHA 上写 provenance 提交状态(描述里带内容 hash);分支保护要求这个状态
#   3. 等 trusted-gates / self-check 在同一个 SHA 上变绿,用 --match-head-commit 合并
# PR 有新提交,状态自动不再对新 head 生效,必须重跑本脚本。
# 用法: scripts/merge.sh <PR号>
set -euo pipefail
PR="$1"
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || { echo "PR 号必须是正整数"; exit 1; }
# 剥掉 hook 可能注入的 GIT_* 环境,避免写到别的仓库
for v in $(env | sed -n 's/^\(GIT_[A-Za-z_]*\)=.*/\1/p'); do unset "$v"; done
REPO_ROOT=$(git rev-parse --show-toplevel)
read -r BR SHA < <(gh pr view "$PR" --json headRefName,headRefOid -q '.headRefName + " " + .headRefOid')
git -C "$REPO_ROOT" fetch -q origin "$BR" main
TMP=$(mktemp -d)
cleanup() { git -C "$REPO_ROOT" worktree remove --force "$TMP/pr" >/dev/null 2>&1 || true; git -C "$REPO_ROOT" worktree remove --force "$TMP/judge" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$REPO_ROOT" worktree add -q --detach "$TMP/pr" "$SHA"
if git -C "$REPO_ROOT" cat-file -e origin/main:scripts/gates/run-all.ts 2>/dev/null; then
  git -C "$REPO_ROOT" worktree add -q --detach "$TMP/judge" origin/main
  JUDGE="$TMP/judge"
else
  echo "!! main 上还没有门禁(引导期,只有建仓 PR 会走到这里),用 PR 自己的门禁当裁判"
  JUDGE="$TMP/pr"
fi
(cd "$JUDGE" && npm ci --silent)
(cd "$TMP/pr" && npm ci --silent --ignore-scripts)
OUT=$(node "$JUDGE/scripts/gates/run-all.ts" --repo="$TMP/pr" --base=origin/main --branch="$BR" --pr="$PR" --local | tee /dev/stderr)
HASH=$(printf '%s\n' "$OUT" | sed -n 's/^CONTENT_HASH=//p')
[ -n "$HASH" ] || { echo "门禁没有给出内容 hash"; exit 1; }
gh api -X POST "repos/{owner}/{repo}/statuses/$SHA" -f state=success -f context=provenance \
  -f description="content=${HASH:0:40}" >/dev/null
echo "已在 $SHA 上写 provenance 状态"
gh pr checks "$PR" --watch --fail-fast --required
gh pr merge "$PR" --squash --delete-branch --match-head-commit "$SHA"
