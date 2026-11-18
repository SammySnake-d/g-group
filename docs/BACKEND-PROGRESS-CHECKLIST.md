# Antigravity 后端进度清单

本清单记录 process 分层门禁前置切片与随后 P1-B 的依赖顺序，不替代其他后端切片的验收记录。

## Step 2A — `chore/agy-gates-process-layer`（Q08 / AC-23 前置）

- [x] `G-LAYER` 识别 `process` 层：`process: []`，仅 `adapter` 新增向 `process` 的依赖许可。
- [x] 保留 `domain/kernel/plugin/app -> process`、`adapter -> adapter` 及相对路径跨包禁令。
- [x] `AGY_MODEL_RE` 识别 `gemini-3.8-flash-s` / `gemini-3.8-flash-high`；数据库回归拒绝畸形和未知名称。
- [x] 测试先红后绿提交，类型检查、lint、全量测试、门禁自检与变异校验通过；证据见 `scripts/gates/proof/process-layer.txt`。
- [x] 收据 `receipts/chore-agy-gates-process-layer.json` 保留 `review: null` / `waiver: null`，AC-23 运行时部分标为未测。
- [ ] 独立跨厂商审查及合入 `dev/agy-backend`，使可信 `$JUDGE` 识别 `process`。

## Step 2B — P1-B（等待 Step 2A 合入）

- [ ] 移植 `packages/process-tools` 与 `packages/adapter-codex-compute`。
- [ ] 实测 AC-23 的进程清理、停止确认后归还及冲突后继隔离；本前置切片不宣称这些运行时行为完成。
