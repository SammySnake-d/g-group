# Antigravity 后端进度清单

本清单记录 process 分层门禁前置切片与随后 P1-B 的依赖顺序，不替代其他后端切片的验收记录。

## Step 2A — `chore/agy-gates-process-layer`（Q08 / AC-23 前置）

- [x] `G-LAYER` 识别 `process` 层：`process: []`，仅 `adapter` 新增向 `process` 的依赖许可。
- [x] 保留 `domain/kernel/plugin/app -> process`、`adapter -> adapter` 及相对路径跨包禁令。
- [x] `AGY_MODEL_RE` 识别 `gemini-3.8-flash-s` / `gemini-3.8-flash-high`；数据库回归拒绝畸形和未知名称。
- [x] 测试先红后绿提交，类型检查、lint、全量测试、门禁自检与变异校验通过；证据见 `scripts/gates/proof/process-layer.txt`。
- [x] 收据 `receipts/chore-agy-gates-process-layer.json` 保留 `review: null` / `waiver: null`，AC-23 运行时部分标为未测。
- [ ] 独立跨厂商审查及合入 `dev/agy-backend`，使可信 `$JUDGE` 识别 `process`。

## Step 2B — Priority Slice P1-B（D 层完成，真实二进制 S+X 留 P3）

- [x] 移植 @g-group/process-tools（process 层），Claude 一次性/常驻与 Codex 共用；保留 B1 停止确认、租约隔离和启动身份核验。
- [x] Codex app-server 0.169.0 wire 协议、每槽 CODEX_HOME / 真实 HOME 分离、启动并发限制、RPC 超时与结构化错误。
- [x] AC-51 ⑦ 双向轮边界换 Harness：在途轮次不打断，确认旧执行器停止后同任务/worktree 起新会话，实例与跨厂商模型账本只追加。
- [x] **已验证完成边界**：确定性 fake/native-wire、真实自有进程树与 git worktree；PR #91/#93 回归、A1/A6/A7/A10/A12/A13、57 条新增红测试、2079 全量绿、255 门禁自检、21/21 故障变异；缺失 Harness 和停止未确认均阻止后继启动。
- [x] **关键文件/测试/PR**：packages/process-tools/src/*.test.ts、packages/adapter-codex-compute/src/protocol.test.ts、packages/server/src/harness-switch.test.ts、既有 resident-stop/B1 回归；来源 PR #91（41dace26）、PR #93（a73cff64）；分支 feat/agy-priority-codex-protocol。证据：[P1-B proof](../packages/server/proof/p1b-codex-protocol.txt)；收据：[P1-B receipt](../receipts/feat-agy-priority-codex-protocol.json)。
- [ ] **未完成/待测边界**：独立跨厂商审查；真实 codex-cli 0.169.0 二进制 E2E、真实网关和模型 S+X、真实能力配置叠加及 Windows 留 P3。AC-23 / AC-51 / V-02 整体 D+X 保持“未测”。任意 Claude 工具子集与 skill 插件不冒充已映射，明确拒收。

P1-B 不替代 B1 已有证明，也不把 wire 实验提升为真实 Codex 或模型验收。
