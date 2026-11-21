# 重启后退回交接新开与 `@Helper` 公告/群规注入验收：2026-11-21

## 确定性对照

- 目标分支基线：`origin/dev/agy-backend`（`930800e932ea792dc743fac18ffaac3f1d34704a`）；Red：`a338c0f2730a4c95707a643c4d780a7c86e17932`；Green：`587c59e0101321f9f3a19933f783c5fc0aa9dce7`。Red 与 Green 之间的 2 组验收测试文件逐字一致，Green 仅改动 `packages/server/src/host.ts`（`6034` 行，未超基线）和 `packages/server/src/helper-replies.ts`（零新增注释）。
- 在 Red 提交 `a338c0f2` 上运行 `node --test --test-reporter=tap packages/server/src/direct-task-completion.test.ts packages/server/src/helper-intents.test.ts`：退出 1，共 9 条测试中 **7 条通过、2 条具名失败**，零跳过/取消：
  1. `重启宿主后退回已交付或已验收任务时新开 Compute 并携交接完成返工`（`packages/server/src/direct-task-completion.test.ts`）：在 `Host` 重启后对 `T8a_Delivered` 与 `T8_Accepted` 调用 `tasks.reject`，宿主尝试对已不在内存的旧 `computeId` 调用 `resume()` 并失败，未新开 Compute，任务滞留 `T3_Running`。
  2. `聊天里 @Helper 能读到当前群的有效公告和群规，不读取已撤下的公告`（`packages/server/src/helper-intents.test.ts`）：发送 `@Helper` 时，请求提示里仅包含 `{history, tasks, question}`，缺失当前群有效公告 `ORBIT-77` 与群规 `规则Alpha：必须核对最新公告`。
- 在 Green 提交 `587c59e0` 上验证：
  - `npm run lint`（`scripts/check-comments.mjs` + `biome lint --error-on-warnings`）：通过（退出 0，零新增不合规范注释，`packages/server/src/host.ts` 保持 `6034` 行）。
  - `npm run check`（`check:docs`、`check:contracts`、`check:structure`、`typecheck`）：通过（退出 0）。
  - `npm test`：`2200/2200` 条后端与门禁测试通过（0 失败/取消/跳过）。
  - `npm run gates:selftest`：`255/255` 用例通过。

## 真实模型与网关复验（CLI serve + Magpie + Codex）

- 使用 `packages/server/src/cli.ts serve --mind pi --magpie --api openai-responses --compute codex --model blueloon-gpt/gpt-6.1-terra` 实跑隔离状态目录：
  1. 设置群规 `暗号是 KILO-9` 与群公告 `ORBIT-77` 后发送 `@Helper 用一句话分别说出本群公告正文和群规暗号是什么`：`@Helper` 回复 `本群公告正文是“ORBIT-77”，群规暗号是“KILO-9”。`。
  2. 将任务分别推进至 `T8a_Delivered` 与 `T8_Accepted`，重启进程并在同一状态目录调用 `tasks.reject`：重启后无 `resume-failed` 错误，两项任务均新开第二轮 Compute（`computeRuns.length === 2`）并在修订交付后回到 `T8a_Delivered`（`constraintVersion === 1`）。

## 行为核对要点

- **重启后 Compute 可恢复判定（`packages/server/src/host.ts`）**：`computeResumable` 检查 `this.computeRuns.has(computeId)`；进程重启后历史 `completed` 实例不在当前宿主的 `computeRuns` 内存映射中，`computeResumable` 如实返回 `false`，使 `tasks.reject` / `verdict(revise)` / 审查打回改走 `spawn-compute` 并携带上次结果与退回意见交接重启新实例，而不再尝试 `resume()` 已失效的内存会话并卡死在 `T3_Running`。
- **`@Helper` 群公告与群规上下文（`packages/server/src/helper-replies.ts`）**：`startHelperReplies` 在构造请求提示时通过 `host.announcementViews(message.roomId)`（不含已撤下公告，私聊自动为空）与 `host.roomView(message.roomId).rules` 注入当前会话公告和群规，并更新系统提示与 `docs/subsystems/contact-and-gateway.md`。

## 边界与未测说明

- 本证明覆盖后端确定性 D 层（先红后绿、门禁自检、`2200/2200` 单测）与真实 `cli.ts serve` + Magpie/Codex RPC 联调；Electron UI 前端渲染与全套 Playwright X 层端到端交互留待 E2E 联合验收，故收据中 `AC-28`、`AC-52`、`AC-55` 整体保持 `"未测"`。
- 本阶段遵循 2026-11-20 授权闭环自测合入 `dev/agy-backend`，收据诚实记录 `review: null, waiver: null`。
