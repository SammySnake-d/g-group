# 群清单认领验收：2026-11-21

## 确定性对照

- 目标分支基线：`d5c9d7be`（已合入 #132/#133）；Red：`a071788b5bde1d8e8dd88c5b57aacff10ffbc618`；Green：`e2a527355954788c40572bdcccb4a207999c4e5d`。Red 与 Green 的四个验收文件逐字相同。
- 在 Red 上用 `node --test --test-concurrency=1` 运行 `mind.test.ts`、`task.test.ts`、`group-claim.test.ts`、`manual-task.test.ts`：退出 1，199 条通过、7 条具名失败，未跳过、未取消、无文件加载失败。原六处失败为请求缺认领工具、AC-09 转移格缺新事件、AC-28 已交付的释放拒绝不符、R13 释放格缺失、已有项未被认领、`tasks.reassign` 未注册。追加的「同一轮处理同一条接手消息」用例在修复前的重基候选上实际建出两件，修后只保留原任务，从另一条消息仍能新建。
- 同七条用例在 Green 通过。状态表断言覆盖 `Release`、`Reassign` 的状态、负责人及副作用；真实 RPC 配合确定性 Compute 替身，验证过期版本不改消息流水、未回绑的旧启动被收回，新负责人进入执行中。复用 AC-28 的普通回复退回测试验证可恢复续接、不可恢复携交接新开。
- Green 的 `npm run check`、`npm run lint` 退出 0。单并发运行 `node --test --test-reporter=tap --test-concurrency=1 "packages/**/*.test.ts" "scripts/gates/*.test.ts"`：2203 条通过，0 失败、取消、跳过或 todo。前端 `69215aa` 钉住 Green；契约文件哈希未变，前端检查、40 条单测和构建均通过。

## 真模型浏览器实跑（重基候选）

`run-11` 只见组合版成功。第一次重基复跑 `run-12-rebased` 查到 Terra 在同一轮先 `claim` 再针对同一条接手消息发 `dispatch`；原任务虽已确认，面板出现第二件任务，显示 `已完成 1/2`，该轮失败。宿主现在拒绝这一条消息的重复派发，不将对已有任务的认领变成整条消息的排他锁。

- `run-13-single-task` 使用 Green `e2a52735` 的运行代码和前端 `69215aa`。联系人与原生 Codex Compute 只用 `blueloon-gpt/gpt-6.1-terra`：联系人 40 次请求、Compute 2 次请求均 HTTP 200。
- 浏览器经 `tasks.create` 创建 `t-mwpz14c9-4`。邀请后，两份真模型提案在脚本中汇合；沈禾先认领，林舟收到并消费「任务已由 沈禾 认领」的私有回执，没有第二条认领成功消息。
- 脚本暂缓第一个真实 Compute 的响应以便放弃；`ContactRelease` 先进入 `T9_StopRequested`，`StoppedConfirmed` 后清除负责人。林舟接手，通过原有 Compute 和交付流程在群内交付 `17 × 23 = 391`。
- HTTP、浏览器收到的 WS、SQLite 和面板一致：`T1_Open` v1（WS 7）→ `T3_Running` v3（WS 38）→ `T1_Open` v5（WS 62）→ `T8a_Delivered` v10（WS 101）。先留待确认截图，再点原复选框，`tasks.accept` 到 `T8_Accepted` v11（WS 114），面板显示 `已完成 1/1`。
- 脱敏记录和 1440×900 对照在交付目录 `evidence/taskboard-live-20261121/run-13-single-task/`。`backend-records.json` SHA-256 `aea04bfdf8ce592b5e356be541bb7afb911e4476d1237f417782e5d7000cbc5b`；`browser-acceptance.json` SHA-256 `9b9125103163ede49dffa48785128e56c993a8ae2a8785691074f60e3a92f079`。

## 边界与文档差异

- ExclusiveClaim 按任务 ID 和版本，不锁整条来源消息；保留普通消息和现有 @ 路由，不增发「在看」表情、灰字通知或新通知通道。未测同源清单导入，未跑 AC-10 的 TLA+/TLC 检查，也不把有意组织的并发和提示当成无引导认领证明。
- 改派只限群用户、`T2_Claimed` 等待开工时的 RPC，无新面板入口，真模型下未测改派。已运行的任务须放弃并等停止后再领；已交付后沿用用户退回返工，不回到开放抢领。用户自然回复验收与返工未用真模型复跑；点击走的是既有复选框，没有新增验收卡。
- 前端保留原布局与样式，真实数据接通后可见状态和负责人。外观由用户看同尺寸对照后再合。冻结范围不加依赖、写入范围、自动释放计时、次数限制或 Helper 导入。
