#!/bin/sh
# 先红后绿的证据(R-02):同一份测试文件,先放到红提交的实现上跑(新增与改动的测试按名字失败),再放到绿提交上跑(全过)。
# 红与绿之间只有三处源码不同(contact-actions.ts、tools.ts、assemble.ts),测试文件两次逐字相同。并发 1。
#   sh packages/server/proof/contact-actions-red-green.sh <红提交> <绿提交>
set -u
RED=$1
GREEN=$2
F="packages/server/src/contact-actions.test.ts packages/adapter-pi-contact/src/claim-tool.test.ts packages/adapter-pi-contact/src/mind.test.ts"
SRC=$(git diff --name-only "$RED" "$GREEN" -- packages | grep -v '\.test\.ts$' | grep -v '/proof/')
echo "# node $(node --version);红 $(git rev-parse --short "$RED") / 绿 $(git rev-parse --short "$GREEN");两者之间的源码差异:$(echo $SRC | tr '\n' ' ')"
echo "# 测试文件红绿是否逐字相同:$(git diff --quiet "$RED" "$GREEN" -- $F && echo 相同 || echo 不同)"
for f in $F; do echo "#   $f sha256 $(git show "$GREEN:$f" | sha256sum | cut -c1-16)"; done
run() {
  node --test --test-concurrency=1 --test-reporter=tap $F 2>/dev/null | grep -E '^(not ok|ok) [0-9]+ - |^# (tests|pass|fail|cancelled|skipped|todo) '
}
echo "## 红:$SRC 取红提交的版本"
git checkout "$RED" -- $SRC
run
echo "## 绿:$SRC 取绿提交的版本"
git checkout "$GREEN" -- $SRC
run
git status --short -- packages
