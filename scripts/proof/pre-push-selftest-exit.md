# 推送钩子跟门禁自检真实退出码走(fix/pre-push-selftest-exit)

## 改了什么

只改 `.githooks/pre-push` 第 7 行:

```sh
# 改前
npm run -s gates:selftest | grep -v '^✓'
# 改后
{ st=$( { { npm run -s gates:selftest 3>&- 4>&- && echo 0 >&3 || echo $? >&3; } | grep -v '^✓' >&4 || :; } 3>&1 ); } 4>&1; exit "$st"
```

改前在 `set -e` 下钩子只看 `grep` 的退出码:自检失败但有非对勾行时**放行**;自检全过但输出全是对勾行时反而拦下。
改后自检退出码经 fd 3 带回(POSIX sh 没有 pipefail,Linux 的 dash 同样适用),`grep` 只做显示过滤(`|| :`),钩子最后 `exit` 自检的码。自检进程关掉 fd 3/4,它留下的子进程不会拖住命令替换。其余检查行未动。

## 反例一:单元测试(`scripts/gates/pre-push-hook.test.ts`,进 `npm test`)

PATH 上放假 `npm`(typecheck/lint/test 成功;`gates:selftest` 的输出与退出码由用例给),驱动真实钩子文件;每条在本机所有可用的 `/bin/sh`、`dash`、`bash` 上各跑一次。

| 用例 | 旧钩子(红提交 72fa0f3a) | 新钩子 |
|---|---|---|
| 自检失败一条(有 ✓ 行和 ✗ 行,退出 1)→ 拦下,对勾行仍滤掉 | 失败:钩子退出 0 放行 | 通过 |
| 自检失败但输出只有对勾行(退出 1)→ 拦下 | 通过(旧钩子碰巧拦下,作对照) | 通过 |
| 自检全过、输出全是对勾行(退出 0)→ 放行 | 失败:钩子退出 1 拦下 | 通过 |
| 自检退出 3 → 钩子退出 3 | 失败:钩子退出 0 | 通过 |

本机 macOS(Node v22.22.0,sh/dash/bash 三种):红提交上 `tests 4 / pass 1 / fail 3`,修复后 `tests 4 / pass 4 / fail 0`。

## 反例二:端到端(真实钩子 + 真实门禁自检 + 本地裸仓库远端,不连 GitHub)

`git -c core.hooksPath=<旧/新钩子目录> push <本地裸仓库> HEAD:refs/heads/<名>`;PATH 上的包装只把未改动的 typecheck/lint/test 三行跳过,`gates:selftest` 原样交给真实 npm。故障注入:在副本里把 `scripts/gates/gates.ts` 的第 7 栏检查改成 `if (false && …)`,让自检用例「第 7 栏没点到条目」从拦下变放行(副本内改,未提交)。

| # | 钩子 | 自检 | 自检结果 | push 退出码 | 远端分支 |
|---|---|---|---|---|---|
| 1 | 旧 | 3 条子集,注入故障 | `✗ 拦下:第 7 栏没点到条目`,打印「自检失败」 | **0(放行,漏洞)** | 已建 |
| 2 | 新 | 同上 | 同上 | **1(拦下)** | 未建 |
| 3 | 新 | 3 条子集,无故障 | 全过 | 0 | 已建 |
| 4 | 新 | 完整自检,无故障 | 「自检通过」219/219,284s | 0 | 已建 |

子集用 `GATE_SELFTEST_ONLY='^(合规:只改文档不需要收据|改了代码没收据|第 7 栏没点到条目)$'`(selftest.ts 注明的本机诊断与端到端夹具用法)。四次运行在本机 macOS、seatbelt 沙箱下串行执行。原始日志与脚本在作者证据目录 `deliverables/g-group-backend-claude-20261113/hook/`(logs/、run.sh、npm 包装)。
