# P1 Compute 打包版验证（2026-11-15）

基线：从公告/置顶验证分支叠加，未改写 #101/#102。安装包使用当前分支重新打包；模型相关真实验收不使用 hy4，本片 Compute 走查使用规则替身宿主，只判断桌面到真实 Compute 合同的显示和生命周期。

- 私聊派活 → 联系人交付 → Compute 行挂在交付消息下：通过。
- Compute 过程/会话只读、停止/继续、失败重试/换模型/跳过、人工接手、文件来处：既有 Electron 走查覆盖；本轮打包版至少复现完成过程并打开活动页，结果：`PACKAGED_COMPUTE_OK`。
- 真实合同来源：`tasks.list/task.updated/tasks.progress`、`runs.list/get/rerun`、`tasks.cancel/tasks.answer`、`cards.act`；没有新增假步骤、假文件或假费用。

联系人工作台仍是下一片缺口，按下一分支移植 `feat/dbp-wb` 的 live wiring；群分工、单独停滞阈值、记忆继续保持关闭并说明后端接口缺口。
