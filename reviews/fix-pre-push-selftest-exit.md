# PR #94 第 1 轮独立审查

结论：**APPROVE**。在冻结版本上未发现推送钩子退出码转发的产品缺陷；此结论不替代尚待会话落盘的 G-PROVENANCE，也不代表允许合并。

## 固定版本与来源

- PR：#94，`fix/pre-push-selftest-exit` → `dev/integration`。
- reviewed HEAD：`868b2a3049b8a7d3040dccc72be27c774b1c3cf2`；base：`4efdee0be6d161060099b5ce488e3344c70305ee`。
- reviewed_hash：`5a5d5ed3fc4108609ef97a6bfade463ee41dcecc29b842521018f618bca26983`，审查宿主亲自单独执行 `node scripts/gates/run-all.ts --hash --branch=fix/pre-push-selftest-exit --base=origin/dev/integration`，与作者一致。
- 作者 Claude Code：`claude:484c2330-2f15-49ae-9f7a-145e467cedb1`，`group/opus`（Anthropic）。审查人 Codex：`codex:60035fe9-26d8-47e0-a381-566b28322cce`，原生 turn_context 实际模型 `chatflows/gpt-6.1-sol`（OpenAI），原生线程 `01a1d98a-7796-74b0-ac57-7910d994edd6`。未换模型。
- 独立 clone；审查覆盖本 PR 四个文件的正确性、可读性、性能、敏感输出、测试与既有门禁分层。实现不改动；只提交本报告和收据 review。
- 对照最新 `origin/docs/dev-handbook` `90226df5ffd17656f2654ab8555f7e71a93639de` 原则 37/40/41/68/71，以及本分支验收 R-05、R-18。作者资料仅用作复跑线索。

## 独立实测

原始日志与可执行探针：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-backend-review-codex-20261114/pr94/`。

| 项目 | 亲自观察到的结果 | 原件 |
|---|---|---|
| box4 Ubuntu / Node v24.21.0 | npm ci、typecheck、lint 均 exit 0 | `cloud/{npm-ci,typecheck,lint}.log` |
| 全量 | `1477/1477`，fail/cancelled/skipped/todo 全 0，exit 0 | `cloud/full.log` |
| 新测试绿 | 4/4，Node v22.22.0 本机和 Node v24.21.0 云端都 exit 0 | `green-hook.tap`、`cloud/unit.log` |
| 作者红提交 `72fa0f3a` | 4 tests / 1 pass / 3 具名失败，exit 1，未把那条碰巧已通过的阴性对照算成红 | `red-hook.tap` |
| 独立输入矩阵 | 111 项全部符合预期：三个本机可用 shell，状态码 0/1/2/3/42/126/127/130/255 × 空/纯对勾/纯失败/混合输出，以及 typecheck 提前失败；检查精确退出码和过滤后的输出 | `independent-hook-probes.{py,json}` |
| 真 git push + 故障门禁自检 | 同一隔离副本、同一故障：旧钩子 push exit 0 且裸远端分支已建；新钩子 push exit 1 且分支未建 | `old-fault.log`、`new-fault.log`、`real-push-e2e.json` |
| 真 git push 阴性对照 | 还原故障，新钩子对子集及完整自检均 push exit 0，远端 refs 实际存在 | `new-clean.log`、`new-full.log` |
| 完整门禁自检 | macOS seatbelt，Node v22.22.0，219/219 结构化用例全部 pass，112 秒，真实 selftest exit 0 | `new-full.log` |
| 各分支真实门禁 | 初始 --local 7 绿、G-REVIEW 还没有独立审查。填 review 后的最终结果另见下节 | `final-gates.log` |

端到端夹具仅包装未改动的 typecheck/lint/test 三项，门禁自检仍交真实 npm 执行；这三项由上述冻结 HEAD 云端全量分别核实。本测试使用本地裸仓库，不把它称为 GitHub 推送。

## 审查人自构单点故障

正对照 4/4。M01 强制退出 0 被 3 条具名测试杀死；M02 去掉对勾过滤被 2 条杀死；M03 把失败码写成 0 被 3 条杀死。三者均完整执行 4 条，0 skip/todo/cancelled；不是依赖装载或语法错误。

M04 去掉自检进程的 `3>&- 4>&-`，现有 4 条全绿。独立生命周期探针让自检留下一个只继承状态通道、标准输出已关闭的 3 秒后台进程：原树返回约 538ms，M04 约 3032ms。这证明**只缺这条子进程生命周期测试**；冻结实现已正确关闭 fd，没有观察到当前产品挂住。该边界不改变本 PR 的核心“selftest 退出码决定 push”判据，列为非阻塞补测建议，不编造产品缺陷。原件 `M04-drop-fd-close.tap`、`fd-lifetime-probe-3s.json`。

## 门禁与范围限制

- box4 第一次自检在未配置 Linux 容器沙箱时 exit 1：219 条执行、165 条 pass，54 条因无可用沙箱等环境原因未通过；完整原件 `cloud/selftest.log` 保留。这个结果没有被称为通过。随后在正式支持的 macOS seatbelt 入口完整复跑 219/219。
- 通用 `npm run gates:mutation` 未运行。本 PR 不改门禁框架源码，已完整复跑目标 hook 的独立故障；不将二者混称同一项。
- `scripts/gates/*.test.ts` 不在当前 G-RED 的 `packages/**/*.test.ts` 统计内，所以 G-RED ✓ 不能证明本片红绿；上面 3 个具名红与 4 个绿为人工独立运行证据。
- 本轮不合并、不修改产品代码。GitHub 推送与远端回读以交付收据记录为准；此报告没有声称已推送。

最终 `--local --pr=94`：exit 1。G-TRACE、G-REVIEW、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 七项 ✓；**G-PROVENANCE ✗**：`审查会话不可信:会话记录不存在:codex:60035fe9-26d8-47e0-a381-566b28322cce`。当前宿主轮次未结束，因此 turns.jsonl 尚未落盘；须会话落盘后由既有门禁再验，未伪造或豁免。CONTENT_HASH 仍为 `5a5d5ed3fc4108609ef97a6bfade463ee41dcecc29b842521018f618bca26983`。
