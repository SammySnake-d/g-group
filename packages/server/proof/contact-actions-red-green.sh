#!/bin/sh
# 先红后绿的证据(R-02):同一份测试文件,先放到红提交的实现上跑(新增与改动的测试按名字失败),再放到绿提交上跑(全过)。
# 红与绿之间的源码差异由 git diff 算出并列在输出第一行;两次跑同一份(当前)测试文件。并发 1。
#   sh packages/server/proof/contact-actions-red-green.sh <红提交> <绿提交>
set -u
RED=$1
GREEN=$2
F="packages/server/src/contact-actions.test.ts packages/adapter-pi-contact/src/claim-tool.test.ts packages/adapter-pi-contact/src/mind.test.ts"
SRC=$(git diff --name-only "$RED" "$GREEN" -- packages | grep -v '\.test\.ts$' | grep -v '/proof/')
echo "# node $(node --version);红 $(git rev-parse --short "$RED") / 绿 $(git rev-parse --short "$GREEN");两者之间的源码差异:$(echo $SRC | tr '\n' ' ')"
echo "# 跑的是当前工作树(HEAD $(git rev-parse --short HEAD))的测试文件;与红提交相比:$(git diff --quiet "$RED" HEAD -- $F && echo 逐字相同 || echo "有差异(下面列出文件;G-RED 按每条测试的测试体比对)")"
git diff --stat "$RED" HEAD -- $F | sed 's/^/#   /'
for f in $F; do echo "#   $f sha256 $(shasum -a 256 "$f" | cut -c1-16)(当前工作树)"; done
echo "# 其余源码(含 host.ts)两次都用当前工作树 HEAD 的版本;只有上面列出的源码差异在红、绿之间切换"
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
