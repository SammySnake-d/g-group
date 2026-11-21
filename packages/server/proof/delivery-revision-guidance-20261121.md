# 第 5 块交付序号与通用认领/返工工具指引验收：2026-11-21

## 确定性对照

- 目标分支基线：`origin/dev/agy-backend`（`07983df40cf89195c96c0870b68cf7e52d5faab7`）；Red：`cf5ef15f24f7f3695723ee809396b146bcd6ee40`；Green：`215dafb5dc036c966a4276126453a9d07615e30c`。Red 与 Green 之间的 2 组验收测试文件逐字一致，Green 仅改动 `packages/server/src/host.ts`（`6034` 行，未超基线）、`packages/server/src/assemble.ts` 及 `packages/adapter-pi-contact/src/tools.ts`（零新增不合规范注释，未改 `@g-group/api-contract` 或 `@g-group/domain`）。
- 在 Red 提交 `cf5ef15f` 上运行 `node --test --test-reporter=tap packages/server/src/direct-task-completion.test.ts packages/adapter-pi-contact/src/mind.test.ts`：退出 1，共 30 条测试中 **28 条通过、2 条具名失败**，零跳过/取消：
  1. `verdict 工具:通过与修改意见都登记成 verdict 动作,修改意见可省略`（`packages/adapter-pi-contact/src/mind.test.ts`）：原 `verdict` 工具描述缺少 `禁止只用 reply` 与 `重新打开任务交给 Compute 修订` 指引。
  2. `第 5 块在途任务在交付前不含交付序号、交付后附带交付序号，且系统提示与工具清单明确认领与返工规则`（`packages/server/src/direct-task-completion.test.ts`）：交付后第 5 块在途任务未附带 `, 交付 #<deliveredSeq>`，且 `CONTACT_SYSTEM` / `CONTACT_TOOLS` 缺少 `read_task`/`claim_task`/`release_task` 及禁止仅用 `reply` 替代 `verdict(revise)` 的说明。
- 在 Green 提交 `215dafb5` 上验证：
  - `npm run lint`（`scripts/check-comments.mjs` + `biome lint --error-on-warnings`）：通过（退出 0，零新增不合规范注释，`packages/server/src/host.ts` 保持 `6034` 行）。
  - `npm run check`（`check:docs`、`check:contracts`、`check:structure`、`typecheck`）：通过（退出 0，`@g-group/api-contract` 与 `@g-group/domain` 无变动）。
  - `npm test`：`2201/2201` 条后端与门禁测试通过（0 失败/取消/跳过；含 `recall.test.ts` 4000 字节上限与 `group-claim.test.ts` 回归）。
  - `npm run gates:selftest`：`255/255` 用例通过。

## 行为核对要点

- **第 5 块任务行附带交付消息序号（`packages/server/src/host.ts:3128`）**：未交付前（`t.deliveredSeq == null`）保持 `(会话 <roomId> #<sourceSeq>)`，交付后附带 `, 交付 #<deliveredSeq>`，让联系人收到对交付消息的引用/回复（`回复 #<seq>`）时可确定性反查对应 `taskId`。
- **通用系统提示与工具清单（`packages/server/src/assemble.ts`）**：在 `CONTACT_SYSTEM` 与 `CONTACT_TOOLS` 中补充清单待认领任务的 `read_task` / `claim_task` / `release_task` 路径，保留 `deliver 即完成,无需等通过`、`交付即完成`、`不要再用 reply 重复`、`提问卡` 及 `STATE_NOTE_GUIDE`，明确要求交付后修改必须先走 `verdict(revise)` 交给 Compute 返工而不得仅用 `reply` 改写文字；同时精简冗余表述使 `CONTACT_SYSTEM + CONTACT_TOOLS` 净缩减字节，维持 `recall.test.ts` 4000 字节预算余量。
- **Pi `verdict` 工具说明（`packages/adapter-pi-contact/src/tools.ts:117`）**：保持 `SPECS.verdict.fields` 与 `不需要等用户说通过` 逐字不变，明确交付后提出者要求修改/改格式/补充/重做时必须调用 `verdict(verdict='revise', taskId, sourceSeq, feedback)` 重新打开任务交给 Compute 修订后再 `deliver`，禁止只用 `reply` 替代。

## 边界与未测说明

- 本证明覆盖后端确定性 D 层（先红后绿、门禁自检、`2201/2201` 全量单测）；真实 `blueloon-gpt/gpt-6.1-terra` 零剧透人设下的 E2E `C9/C10` 闭环留待下游 `e2e-inspector` 在 X 层实跑验证，故收据中 `AC-28` 与 `AC-56` 整体保持 `"未测"`。
- 本阶段遵循 2026-11-20 授权闭环自测合入 `dev/agy-backend`，收据诚实记录 `review: null, waiver: null`。
