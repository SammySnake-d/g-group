# P1 联系人工作台与模型恢复验收

候选在 `feat/desktop-p1-workbench-20261115`，叠在 `feat/desktop-p1-compute-20261115` 上。#101 冻结头 `143f72d1` 未改写。原 `feat/dbp-wb` 工作树保持原状；仅移植其工作台合同接线与行为用例。

## 新增可用

- 职责 / 预设走 `contacts.update`、`contacts.profile`；能力开关从 `capabilities.list` 读并写 `computeAssets`；目录为空明确显示空。
- 联系人 / 全局模型、槽位、批量替换走真合同。异步成功才确认；保存失败不清除 dirty、不关闭替换对话框。目录外模型遵循宿主策略，标明未声明；不声称其厂商或 Harness 能力已确认。
- 过程页读 `runs.list`，订阅 `run.updated`。清除旧联系人数据，以请求版本排除迟到响应；加载 / 空 / 读取失败分开显示。
- failure 卡展示宿主 `body`，联系人失败可进入模型设置；用户改好再点击卡上的重试。任务失败的主动作继续在 Compute 行，不增加重复重试按钮。
- API / 令牌变化清除旧目录和模型选择；请求响应绑定配置版本。保存的令牌只对同一个规范 API 根地址复用，切换地址必须重新填写。

## 已观察结果

- 桌面类型检查与重新构建通过。
- 工作台 Electron 5 项通过：职责 / 预设、能力库、模型 / 槽位 / 默认、明确关闭项 / 运行台账、批量替换，包含同数据目录重启。
- 应用壳与恢复 Electron 5 项通过：首次接入、真实目录形状、更新校验、旧请求隔离 / 凭据归属、故障卡原因 / 保存拒绝 / 新填模型 follow-speaking / 手动重试。
- preview.2 打包版职责与预设保存重启通过；preview.3 为最终后续包。
- preview.3 真实目录读取并明确选择 feishao，真实私聊 / 群聊 @ 回复、联系人台账、公告与置顶通过。模型始终是 `fengshao1227/deepseek-v4.1-flash`；没有用 hy4 或 workbuddy 模型做本轮真实请求。
- preview.3 用规则联系人刺激派活、真实 Claude Code Compute 跑 feishao 模型的独立打包验收通过：文件逐字吻合，界面 `done`，过程页可读。另一次真实联系人 + 真实 feishao 派活中，模型确实写完同内容，`gg_compute.status=completed`、Compute run completed、`tasks.progress` 收到真实 `completed`，尝试账本也是指定 feishao ID；但 **父任务仍 `T3_Running`、无交付序号、UI 仍 running**。这条真实联系人后的状态闭环尚未通过，需后端线核对任务结束/交付协议；不把子运行完成误记成父任务完成。
- `real-preview3` 首次验收脚本在 setup 保存触发页面重载时过早点了添加联系人，超时；`real-preview3-r2` 等待实际 load 后重跑完整链路通过。初次失败证据保留，不把它当作产品成功。

复跑脚本与截图 / result.json 在 `../proof/p1-workbench-20261115/`。凭据从本机 `.claude/settings.json` 读取到内存，只写本轮临时 AppConfig（0600），退出后删除；证据不含令牌。真实计算回执仅保留任务 / run 状态、尝试模型和中性测试文件。

## 仍关闭

群级职责、联系人单独停滞设置、逐句内部会话、长期记忆，详见《前端开发优先级》。P2 不开发。独立审查与发布门禁状态独立记录，不把作者验证当作审签。
