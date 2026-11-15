# PR #75 测试见证强化（后验校准）

- 分支：`fix/pr75-gate-witnesses-20261116`。
- 基础：`3efafc167a80f944a5cd7b839a3c7a9fc6ae3e53`（停止安全候选）。
- 实测源码：`c8456dced7814434105bafb5599b17f3757a9c17`。
- 正常 merge 保留原提交 `87a128964b86f60ff6b43cd484c357df079a2321`、`c5ce3bebf4803f9bc9304612e0c579f02eeb9f70`；不 cherry-pick、不重写作者历史。
- 只改五个测试文件并封存本证明。产品、停止安全实现、门禁源码、原审查结论和 receipt 均未改变；原工作树未改。

## 观察到的前后差异

| 范围 | 未改基线 | 强化后 |
| --- | --- | --- |
| 五文件原版静态 testlint | 8 项，exit 1 | 0 项，exit 0 |
| 两条 task 返回值变异 | 2 条命中变异仍通过，exit 0 | 2 条具名断言失败，exit 1，无取消/超时 |
| 两条 attention 返回值变异 | 第 1 条断言失败；第 2 条 2000ms 超时并取消，exit 1 | 2 条具名断言失败，exit 1，无取消/超时 |
| 正常定向测试 | attention 2/2 + task 2/2 + server 11/11 | attention 2/2 + task 2/2 + server 11/11 |
| typecheck、五测试 Biome lint | 本片未重复旧全量检查 | 均 exit 0 |
| 原 assert.* 调用保留 | 737 条 | 原 737 条全部保留，合计 749 条 |

两阶段调用候选原版 `mutateReturns` 算法。产品未变，生成的非测试源码变异字节和变异范围逐项相同；arm 标记证明两条 task、两条 attention 均实际触及被变异源码。本片没有调用正式 G-RED/G-STUB/G-TAUTO，也没有跑全量、真实模型或真实 Compute。

## 精确修补位置

1. `packages/domain/src/task.test.ts`：AC-28① 的 `AcceptTimeout`、R13 的未认领 `Dispatch` 拒绝，除原 `ok === false` 外校验完整返回值及正确业务原因，防止把入口误判为非法输入当成正确拒绝。
2. `packages/server/src/delivery-t8a.test.ts`：三条测试在回调内显式构造 Host 并直接检查宿主任务状态，原 service 断言全部保留。
3. `packages/server/src/desk-fake.test.ts`：四条测试在回调内显式调用生产 `startServer`，补宿主真实任务状态/身份断言，原替身 Compute 断言全部保留。
4. `packages/server/src/start.test.ts`：补 IPC 联系人实际保存和宿主交付状态断言。
5. `packages/kernel/src/attention-retry.test.ts`：在 `t.advance(200)` 后、`loop.idle()` 前断言假计时器已清空。正常策略照常通过，延迟被改错时立即具名失败而非永等。

## 执行器错误与纠正

未改基线及一次原子重放的 server-real 都是 exit 1：旧的外置 `forbid-os-signals.mjs` 禁止所有 child_process 接口，误挡生产 `Host.workspaceNote → spawnSync(git status)`，第九条测试变成 unhandledRejection。这两次失败完整保留，**不计产品红**。

纠正只在外置 `run-witnesses-safe.py`：去掉旧 import，按已验证绝对路径复用 `process-guard-v4.mjs` 与同目录 `native/table.node`；以进程局部 `NODE_OPTIONS` 加载，另建 chmod 700 的专有 `TMPDIR`/`GG_TEST_RUN_TMP` 和审计日志，不改产品、测试断言或门禁。正确接线后同一 server-real 11/11、exit 0。两次 safe 运行的源码、runner 和护栏哈希均在结束时复核不变，审计没有非零信号事件；全部验证未对真实系统进程发信号。

## 证据入口与复现命令

所有绝对命令、cwd、PID、退出码、耗时、冻结输入 sha256 和进程局部环境在 JSON 中，不用管道掩盖退出码。

- `summary.json`：结果聚合及明确未完成项。
- `raw/bound.json`、`raw/merge.execution.json`：基础、原树身份及正常 merge 事件。
- `raw/baseline-commands.json`、`raw/baseline-executions.json`：原基线冻结与原 guard 失败；原日志、exit 文件一并保留。
- `raw/resume-command-20261116T061601/command_execution.json`：一次同命令重放及 exit 1。
- `raw/baseline-pure-continuation-20261116T061830/command_executions.json`：原静态与两项变异的真实命令/退出码。
- `raw/baseline-safe/commands.json`、`executions.json`、`freeze-after.json`：只补跑失败接线，其他已完成基线结果没有重做或覆盖。
- `raw/strengthened-safe/commands.json`、`executions.json`、`freeze-after.json`：强化后的九步验证、日志、退出码与结束冻结。
- `raw/baseline-static.json`、`raw/strengthened-static.json`：原 8 项到 0 项的精确测试名及源码来源断言计数。
- `raw/baseline-mutation.json`、`raw/strengthened-mutation.json`：同算法变异、测试及 arm 哈希。
- `raw/assertion-preservation.execution.json`、`raw/assertion-preservation.json`：原断言 AST 匹配与产品/门禁不变核验。
- `raw/historical-review-summary.json`、`raw/historical-gates-local-before-review.{json,log.gz}`：只读抽取已有正式失败收据，不是本片新门禁。
- `manifest.json`：本证明包各文件 sha256。

已实际执行的完整强化命令：

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 /private/tmp/gg-pr75-gate-witnesses-dyugzcdc/evidence/run-witnesses-safe.py strengthened
```

该命令已结束、exit 0；不要在同输出目录直接重跑以覆盖本证据。需要复跑时建立新输出目录/运行身份并从 JSON 命令数组重放，保留所有冻结输入。

## 尚未闭合的边界

- 本片是**后验校准**，不证明累计 PR 首次先红，也不把旧红点 `4e7bc90b` 变成整个新增范围的历史红。
- 正式审查提交 `31082df234b2b59af260d02e70f6b91ba5104bdd` 的 run-all --local 用时 1316.2 秒正常结束、exit 1、非 timeout：原 G-RED 604 项、G-STUB 2 项、G-TAUTO 8 项。本片校准对应后两组原问题及 attention 超时，但未重跑新头完整门禁，**原 604 项尚未闭合**；不能声称新头仍恰好 604 项或正式门禁已通过。
- 进程沙箱 ps 能力、门禁复制树跨包软链回原树的执行器问题，以及 A5 真实成员移出/模型验收不属于本片；由父执行线继续。
- 未修改门禁判据、未删原断言、未加 skip、未签 APPROVE、未推送、未创建 PR。待父冻结最终证据提交后跑授权的完整门禁并决定投递。
