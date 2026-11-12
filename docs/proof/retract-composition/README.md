# Q12 撤回组合补证：缺口复现，未验收

固定依赖 PR73 feat/memory-hygiene，base c56dae7e3e3f564a4f5080712bfdde92081789d2。
本片只新增独立组合测试与原始证据；生产源码、#73 与其他工作树不改，不推送、不合并、不签审。

## 本次实际执行

`nice -n 10 lockf /tmp/gg-cov-local.lock node --test packages/server/src/retract-composition.test.ts`

- RC01：真实 service messages.retract 在联系人草稿在途时撤回来源；放行旧草稿后未上屏，绿。
- RC02：不撤回的阳性对照，同类来源真的能产生并发布回复，绿，排除空实现碰巧通过。
- RC03：Compute 为确定性协议夹具（非真实模型/CLI），但先真实写入磁盘工件，Host/SQLite 已记录 completed。之后真实 service 撤回来源：工件仍在、内容不变、写入仍仅1次，均通过；**返回值与聊天缺少明确“已发生、无法撤回”披露，ERR_ASSERTION 红**。当前只有“收到:(撤回了 #1)”，任务仍 T5_InReview。不是声称工件被撤销，也不是声称完整 AC-08 失败。
- RC04：删除 K（不是 rewind）保留 K 后独立 N 的状态笔记与下一轮上下文，重启后仍保留 N、所有装配块均不含 K，绿。此项不是 task follow-up 重放/R-Rule 全链证明。

最终同体4项：3绿/1红，0 skip/cancel/todo；typecheck exit0、目标文件lint exit0。本机不足1秒的窄组合定位，不是云全量替跑。未做变异、云全量、机械门禁、独立审查或前端；无绿色PR可交付。

## 必须保留的执行器错误

首版证据还包括 TaskView.result 不存在的 typecheck2 与 optional chain lint1，均已保留。最终改为实际 recentProgress.completed 作为不可空的持久完成前提，产品实现/AC-08 提示断言未变；最终仍在 RC03 的缺披露断言失败。源码路径/命令猜测错误另见根目录执行器错误记录，均不计为产品缺陷。

## 交接写点

messages.retract → Host.retractMessage → appendUserEvent；当前只追加撤回/更新索引/通知，没有对关联已发生 Compute 的面向用户披露。相关 Host 写点属于共享 G4/CM 线，按既定边界停在测试，不擅改。同文件 runRound 也不改。
请 Mira Bot 指定原 owner 修复，或明确授权本片的精确接线；修后在固定新提交重跑相同4项与对应阴性/重启证明，再决定后续门禁。
