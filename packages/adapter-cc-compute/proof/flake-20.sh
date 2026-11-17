#!/bin/bash
# F-03 稳定性证据:在负载下把本包测试连跑 20 次,每次都必须全绿。
# 负载:同时在另一份仓库副本里循环跑 npm test(全仓测试),直到 20 次跑完。
# 用法: bash packages/adapter-cc-compute/proof/flake-20.sh > packages/adapter-cc-compute/proof/flake-20.txt 2>&1
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOAD="$(mktemp -d /tmp/cc-flake-load-XXXX)"
rsync -a --exclude node_modules --exclude .git "$ROOT/" "$LOAD/repo/"
ln -s "$ROOT/node_modules" "$LOAD/repo/node_modules"
( cd "$LOAD/repo" && while [ ! -f "$LOAD/stop" ]; do npm test > /dev/null 2>&1; echo x >> "$LOAD/load-runs"; done ) &
LOADER=$!
echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) HEAD=$(git -C "$ROOT" rev-parse --short HEAD) node=$(node --version) cpus=$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
echo "# 负载:另一份副本 $LOAD/repo 循环跑 npm test(pid $LOADER)"
fails=0
for i in $(seq 1 20); do
  out="$LOAD/run-$i.txt"
  ( cd "$ROOT" && node --test --test-reporter=tap packages/adapter-cc-compute/src/adapter.test.ts > "$out" 2>&1 )
  code=$?
  pass=$(grep -E '^# pass' "$out" | awk '{print $3}')
  fail=$(grep -E '^# fail' "$out" | awk '{print $3}')
  f03=$(grep -E '^(ok|not ok) [0-9]+ - F-03' "$out" | sed -E 's/ - .*//' | tr '\n' ' ')
  load=$(uptime | sed -E 's/.*load averages?: //')
  echo "run $i: exit=$code pass=$pass fail=$fail F-03=[$f03] load=[$load]"
  if [ "$code" -ne 0 ]; then fails=$((fails + 1)); grep -E '^not ok' "$out"; fi
done
touch "$LOAD/stop"
wait "$LOADER" 2>/dev/null
echo "# 负载副本在这期间跑完 npm test $(wc -l < "$LOAD/load-runs" 2>/dev/null || echo 0) 次"
echo "# 20 次中失败 $fails 次"
rm -rf "$LOAD"
exit "$fails"
