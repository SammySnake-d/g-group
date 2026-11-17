#!/bin/bash
# 唯一的合并入口。用基座分支上的门禁(裁判)检查 PR 当前 head:
#   1. 钉住 head SHA,在隔离 worktree 里跑全部门禁,含 G-PROVENANCE(本机会话与群聊原始记录)
#   2. 通过后在这个 SHA 上写 provenance 提交状态(描述里带内容 hash);分支保护要求这个状态
#   3. 等远端检查在同一个 SHA 上变绿,用 --match-head-commit 合并并读回 state=MERGED
# PR 有新提交,状态自动不再对新 head 生效,必须重跑本脚本。
# 用法: scripts/merge.sh <PR号>
set -euo pipefail
PR="$1"
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || { echo "PR 号必须是正整数"; exit 1; }
# 剥掉 hook 可能注入的 GIT_* 环境,避免写到别的仓库
for v in $(env | sed -n 's/^\(GIT_[A-Za-z_]*\)=.*/\1/p'); do unset "$v"; done
REPO_ROOT=$(git rev-parse --show-toplevel)
PR_META=$(gh pr view "$PR" --json headRefName,headRefOid,baseRefName -q '.headRefName + " " + .headRefOid + " " + .baseRefName')
read -r BR SHA BASE_REF <<< "$PR_META"
git -C "$REPO_ROOT" fetch -q origin "+refs/heads/$BR:refs/remotes/origin/$BR" "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF"
TMP=$(mktemp -d)
cleanup() { git -C "$REPO_ROOT" worktree remove --force "$TMP/pr" >/dev/null 2>&1 || true; git -C "$REPO_ROOT" worktree remove --force "$TMP/judge" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$REPO_ROOT" worktree add -q --detach "$TMP/pr" "$SHA"
if git -C "$REPO_ROOT" cat-file -e "origin/$BASE_REF:scripts/gates/run-all.ts" 2>/dev/null; then
  git -C "$REPO_ROOT" worktree add -q --detach "$TMP/judge" "origin/$BASE_REF"
  JUDGE="$TMP/judge"
else
  echo "!! $BASE_REF 上还没有门禁(引导期,只有建仓 PR 会走到这里),用 PR 自己的门禁当裁判"
  JUDGE="$TMP/pr"
fi
(cd "$JUDGE" && npm ci --silent)
(cd "$TMP/pr" && npm ci --silent --ignore-scripts)
if OUT=$(node "$JUDGE/scripts/gates/run-all.ts" --repo="$TMP/pr" --base="origin/$BASE_REF" --branch="$BR" --pr="$PR" --local); then
  printf '%s\n' "$OUT" >&2
else
  GATE_RC=$?
  [ -z "$OUT" ] || printf '%s\n' "$OUT" >&2
  exit "$GATE_RC"
fi
HASH=$(printf '%s\n' "$OUT" | sed -n 's/^CONTENT_HASH=//p')
[ -n "$HASH" ] || { echo "门禁没有给出内容 hash"; exit 1; }
gh api -X POST "repos/{owner}/{repo}/statuses/$SHA" -f state=success -f context=provenance \
  -f description="content=${HASH:0:40}" >/dev/null
echo "已在 $SHA 上写 provenance 状态"
if PROT_OUT=$(gh api -i "repos/{owner}/{repo}/branches/$BASE_REF/protection" 2>&1); then
  PROT_RC=0
else
  PROT_RC=$?
fi
PROT_CODE=$(printf '%s\n' "$PROT_OUT" | sed -n '1s/^HTTP\/[^ ]* \([0-9][0-9][0-9]\).*/\1/p')
if [ "$PROT_RC" -eq 0 ] && [ "$PROT_CODE" = "200" ]; then
  gh pr checks "$PR" --watch --fail-fast --required
elif [ "$PROT_CODE" = "404" ] && printf '%s\n' "$PROT_OUT" | grep -q '"message"[[:space:]]*:[[:space:]]*"Branch not protected"'; then
  echo "!! $BASE_REF 未配置分支保护规则(HTTP 404 Branch not protected),改用 --watch --fail-fast(不带 --required)"
  gh pr checks "$PR" --watch --fail-fast
else
  echo "查询分支 $BASE_REF 保护规则失败(rc=$PROT_RC, status=${PROT_CODE:-unknown}),拒绝继续合并:" >&2
  printf '%s\n' "$PROT_OUT" >&2
  exit 1
fi
gh pr merge "$PR" --squash --delete-branch --match-head-commit "$SHA"
STATE=$(gh pr view "$PR" --json state -q '.state')
[ "$STATE" = "MERGED" ] || { echo "合并后状态不是 MERGED,实际 $STATE"; exit 1; }
