#!/bin/sh
# 跑全部 TLC 配置(AC-10)。需要 java 与 tla2tools.jar(TLA2TOOLS 指向它)。CI 不跑本脚本:测试只读仓库里存下的反例。
# 每个配置的原始输出(含命令行、TLC 版本、状态数、结果、退出码)写到 ../proof/tlc-<配置>.txt,
# 有反例(或见证配置的探针被违反)时 JSON trace 写到 traces/<配置>.json(供 src/trace-replay.ts 的回归测试回放)。
# 用法: TLA2TOOLS=/path/to/tla2tools.jar sh packages/domain/tla/run-tlc.sh
set -u
cd "$(dirname "$0")"
JAR="${TLA2TOOLS:?TLA2TOOLS 未设置}"
META="$(mktemp -d "${TMPDIR:-/tmp}/gg-tlc-meta.XXXXXX")"
for cfg in Publish Publish-nocas Publish-nocas-double Publish-single Publish-witness Claim Claim-nocas Claim-single Claim-witness Lease Lease-nocas Lease-noorder Lease-noorder-reverse Lease-single Lease-witness; do
  spec="${cfg%%-*}.tla"
  out="../proof/tlc-${cfg}.txt"
  trace="traces/${cfg}.json"
  rm -f "$trace"
  cmd="java -cp tla2tools.jar tlc2.TLC -workers 1 -cleanup -noGenerateSpecTE -metadir <tmp> -config ${cfg}.cfg -dumpTrace json ${trace} ${spec}"
  {
    echo "# 命令: $cmd"
    echo "# java: $(java -version 2>&1 | head -1)"
    echo "# 时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    java -XX:+UseSerialGC -cp "$JAR" tlc2.TLC -workers 1 -cleanup -noGenerateSpecTE -metadir "$META/$cfg" -config "${cfg}.cfg" -dumpTrace json "$trace" "$spec" 2>&1
    echo "# 退出码: $?"
  } > "$out"
  echo "$cfg: $(grep -E '^# 退出码' "$out") $(grep -E 'distinct states found' "$out" | head -1)"
done
rm -rf "$META"
