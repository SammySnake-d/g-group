# PR #97 R1 返修证据与边界

- 依赖 #98 `f4533f77`，#97 第1轮审查提交 `250527e6`；不覆盖审查、不合并。
- 真缺陷先红提交 `5e32f07f`（上一会话已执行六条具名红）；本轮另有 `legacy-and-queue-true-red.tap`、`queue-retraction-true-red.tap`、`fairness-true-red.tap`。`retry-timer` 先跑即绿，**不能**称先红。
- 独立审查 Q06-R1-04 是测试缺口：真实生成时刻、历史模型快照原实现本来正确。两个指定单点故障 `snapshot-time.tap`、`snapshot-model.tap` 各经具体业务断言杀死，不得称产品修复或先红。
- 为门禁把最终同体测试放到事后受控红提交 `b4b865a213b0acb3a7024a199364d46f3a0dee12`：先复用原作者摘要空壳，再逆转三个单飞改动及撤销依赖移出接线。这是产品已有实现后的**事后校准**，不是历史先红。`red-cal-attempt1.tap` 为首次 35 红缺4；`red-cal.tap` 56条中17绿39红，39条受门禁约束的新/变更测试逐名恰好失败，无 skip/cancel/todo。恢复提交 `08cc5735e4f093582da1b5a94e58066520aaec4c` 恢复到校准前 `c8551df` 的相同源码及测试。
- `green.tap` 在恢复源码与最终测试下 67/67；不代表全量、正式门禁或真实模型通过。`tauto-static.log` 仅是测试静态规则检查，不是完整 G-TAUTO。
- `r1-mutations.log` 和各 mutant TAP：隔离副本上8个隐私/分页/时间及模型快照单点故障，各自完整16条测试、指定测试按名失败，无 skip/cancel/todo；此批执行时的产品源码是 `15bcd0f`，之后只修改测试可见性、未修改产品源码。
- `inherited-dry.log` 仅核对原84项注入点；`inherited-selected.log` 首跑17项16杀1存活，G18 因快照实际写点变更而无效；保持相同单点故障改到真实写点后 `g18-retest.log` 通过。其余67项及依赖46项本轮均未完整重跑。
- 叠加 #98 后旧测试冲突日志 `fixed-tests.log` / `fixed-tests2.log` / `fixed-tests5.log`：#98 一审 `206c8ac7` CORR-001 明定成员移出关闭触发、取消 pending，`f4533f77` 已实装；旧摘要测试改为断言取消而不是错误地要求 failed 摘要。#98 原测试的 idle 在接上摘要消费方后会先消费 pending，所以改同一发送拍检查、移出及拉回，完整保留 pending→cancelled、closed 与不复活断言。

原始 TAP 保留 /tmp/gg97-resume.xas2Qd/；仓库内 TAP 仅去行尾空白，断言内容不变。

原先红的逐条完整记录补入 `r1-initial-true-red.tap`（6红1绿）与 `r1-extra-true-red.tap`（8红1绿），绿项均为 R1-04。
