# 直接交付即完成与追问重开验收（#4386）：2026-11-21

## 确定性对照

- 目标分支基线：`origin/dev/agy-backend`（`cc2298b3`，已合入 PR #134）；Red：`4bac546e9d0674d5e57ea3a2032744daabe3cfc6`；Green：`c5ddd855b5df3ab13d682e34ec60e38734338bb2`。Red 与 Green 之间的 7 组验收测试文件逐字一致，Green 仅改动 `packages/server/src/host.ts`、`packages/server/src/views.ts`、`packages/server/src/assemble.ts`、`packages/adapter-pi-contact/src/tools.ts` 及 `scripts/gates/lib.ts`（`runNodeTests` TAP 描述 `\#` 反转义）。
- 在 Red 提交 `4bac546e` 上运行 `node --test --test-reporter=tap packages/server/src/delivery-plain.test.ts packages/server/src/delivery-t8a.test.ts packages/server/src/host.test.ts packages/server/src/chat-ops.test.ts packages/adapter-pi-contact/src/mind.test.ts packages/server/src/views.test.ts packages/server/src/direct-task-completion.test.ts`：退出 1，共 58 条测试中 **47 条通过、11 条具名失败**，零跳过/取消：
  1. `verdict 工具:通过与修改意见都登记成 verdict 动作,修改意见可省略`（`packages/adapter-pi-contact/src/mind.test.ts`）
  2. `任务显式入口:tasks.accept 等同点交付卡;没有待确认交付时如实拒绝;用户撤销承诺`（`packages/server/src/chat-ops.test.ts`）
  3. `交付是普通消息:联系人 @ 提出者汇报结果,不挂交付卡;沉默不算通过,一直待确认`（`packages/server/src/delivery-plain.test.ts`）
  4. `Q09 A0 私聊没有审查人:交付后经 service 读到 T8a 待确认、门禁 none、交付消息已钉住;沉默不通过`（`packages/server/src/delivery-t8a.test.ts`）
  5. `Q09 A2 本人普通回复「通过」:联系人提交结论,service 读到 T8_Accepted,如实记本人豁免;任务卡收口`（`packages/server/src/delivery-t8a.test.ts`）
  6. `Q09 A2 显式入口 tasks.accept:T8a 直接验到 T8;已验收后再点被拒`（`packages/server/src/delivery-t8a.test.ts`）
  7. `非代码仓交付即自完成: 立即了结承诺、关闭 task-status 卡片、pendingForUser 归零、进入 doneTasks 并使用非催促交付文案`（`packages/server/src/direct-task-completion.test.ts`）
  8. `交付后与验收后对话追问都可重开修订: verdict(revise) 与 tasks.reject 将 T8a_Delivered 和 T8_Accepted 退回 T3_Running 并干净再交付,轮次装配最多带最近 10 条 T8_Accepted`（`packages/server/src/direct-task-completion.test.ts`）
  9. `配了 codeRepo 时工作树交付仍需人工确认与合入,未配工作树则直接自完成`（`packages/server/src/direct-task-completion.test.ts`）
  10. `私聊派活闭环:接任务 → Compute 进度回聊天 → 普通消息交付并 @ 提出者 → 用户通过 → T8 已验收(用户豁免),承诺了结`（`packages/server/src/host.test.ts`）
  11. `contacts.profile: 非代码仓与已合入 T8a_Delivered 归入 duties.doneTasks, 未合入代码仓 T8a_Delivered 保留在 duties.tasks`（`packages/server/src/views.test.ts`）
- 在最终提交上验证：
  - `npm run lint`（含 `check-comments.mjs` 注释增量棘轮与 `biome lint --error-on-warnings`）：通过（退出 0，新增测试与源码注释均合乎基线，其中 `host.ts` 保持 6034 行不越界）。
  - `npm run check`（`check:docs`、`check:contracts`、`check:structure`、`typecheck`）：通过（退出 0，`@g-group/api-contract` 保持 `107` methods / `21` events 不变）。
  - `npm test`：全量后端与门禁测试通过（0 失败/取消/跳过/todo）。
  - `npm run gates:selftest`：255/255 用例通过。
  - `node scripts/gates/run-all.ts --base=origin/dev/agy-backend --branch=feat/agy-direct-task-completion`：`G-TRACE`、`G-RED`、`G-STUB`、`G-TAUTO`、`G-WORKFLOW`、`G-LAYER` 全部通过（✓），仅 `G-REVIEW` 因未做独立审查报告 `还没有独立审查`（符合本阶段自测合入政策）。

## 行为核对要点

- **非代码仓 `deliver` 即自完成**：`deliverUnreviewedTx`、跨厂商审查通过路径以及 `reviewFallback` 在 `!needsCodeIntegration(taskId)` 时调用 `settleDeliveredTx`，在事务内将对应任务承诺标记为 `"done"`、将开放 `task-status` 卡片更新为 `"done"`；`roomView` 对无需代码合入的任务不再计入 `pendingForUser`；`contacts.profile` 将无工作树或 `W6_Merged` 状态的 `T8a_Delivered` 归入 `duties.doneTasks`；非代码仓审查与兜底交付改用非催促文案（`如需调整直接说。` / `已按当前结果交付;如需修改直接说。`）。
- **后交付/后验收追问重开（`T8a_Delivered` & `T8_Accepted` → `T3_Running`）**：`taskDecision("reject")`、`verdict("revise")`、`decideDeliveryTx("reject")` 同时接受 `T5_InReview`、`T8a_Delivered` 与带 `delivery` 的 `T8_Accepted`，重开为 `T3_Running` 时把 `task-status` 卡片从 `"done"` 恢复为 `"open"`；当历史 `compute-session` 已在 `T8_Accepted` 收口为 `"done"` 时，`ledgerResume` 启动新的活动 `compute-session` 承接修订；联系人轮次装配除 `!TERMINAL` 外附带最近最多 10 条本人名下 `T8_Accepted` 任务，确保提出者在聊天追问修改时联系人可直接定位 `taskId` 调用 `verdict(revise)`。
- **`codeRepo` 安全边界保持**：配了 `codeRepo` 且工作树尚未 `W6_Merged` 时，`needsCodeIntegration` 为真，`pendingForUser`、未合入 `duties.tasks`、明确等待确认文案以及 `accept`/`integrateTask` 合入保护均原样保留。

## 边界与未测说明

- 本证明仅覆盖后端确定性 D 层（含契约与状态机/门禁隔离测试）；真实模型（Pi/Codex/Claude）对话行为与 Electron 前端 X 层端到端走查尚未运行，故收据中 `AC-28` 与 `AC-56` 保持 `"未测"`。
- 本阶段遵循 2026-11-20 用户闭环自测合入 `dev/agy-backend` 授权，未请求跨厂商独立审查（收据 `review: null, waiver: null`，不伪造审查）。
