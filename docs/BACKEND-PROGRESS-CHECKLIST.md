# 后端优先级进度与验证边界

本清单跟随 `dev/agy-backend` 切片同步。`[x]` 表示该后端切片的已列 D 层边界落地，不表示对应 AC 的 D+X 或 X 层整体验收完成。真实模型、界面与跨进程链路须另有运行证据。

- [x] B0 #119：门禁、来源与合并入口。
- [x] B1 #120：Compute 停止确认、租约及运行台账。
- [x] B2 #121：注意力、检索、压缩与授权护栏。
- [x] B3 #122：配置历史回滚、时间线与回执。
- [x] B4 #123：Magpie 多协议、缓存用量与说话模型热替换。
- [x] P1-A #124（0683b560，已合入）：不可变轮次配置、长期记忆卫生/证据/覆盖台账、协作观察及净室群克隆（后端候选实现）。
- [x] P1-B #126（76dd7ce4，已合入）：D 层 Codex `app-server` Compute 适配与双向轮边界 handoff；真实二进制/模型 S+X 留 P3。
- [x] P1-C #127：HTTP + WS Bridge（已列 D 层边界）；CLI serve 已接通 P1-B Codex Compute。
- [ ] P2-A：Admin / Quota / Helper；C-US09 撤回取消在途任务。
- [ ] P2-B：Plugins / Outbox / Commitments。
- [ ] P3：完整 D+X 验收矩阵、真实模型 S+X 评测与前端联调。

| 已完成切片 | 已验证完成边界 | 关键文件/测试/PR | 未完成/待测边界 |
|---|---|---|---|
| B0 | D 层来源解析、逐轮模型绑定、隔离工作区及合并入口校验；既有收据保留独立评审记录 | #119；`scripts/gates/`；`receipts/feat-agy-gates-provenance.json` | 不表示任意未来提交的独立审查已通过；D+X 产品验收留 P3 |
| B1 | D 层物理停止确认前不释放持久租约，Harness 路由与孤儿核对 | #120；`packages/server/src/host.ts`；`receipts/feat-agy-p0-compute-stop.json` | Codex app-server 已在 P1-B 完成 D 层装配，真实二进制与模型留 P3；全部 X 层停止/恢复体验留 P3 |
| B2 | D 层混合检索、撤回/权限过滤、注意力因果护栏、失败保留原文、授权重新核验 | #121；`history.ts`、`a5-fresh-auth-races.test.ts`；`receipts/feat-agy-p0-attention-compaction-guard.json` | 真实模型压缩质量、性能与 D+X 任务全链仍待测 |
| B3 | D 层配置 CAS 历史与回滚预检、只追加任务时间线、撤回副作用披露及回执兼容 | #122；`host.ts`；`receipts/feat-agy-p0-config-provenance-receipts.json` | 真实模型与 UI 的回滚体验、全部 AC-08/AC-20/AC-32/AC-46 D+X 判定未完成 |
| B4 | D 层四协议发现、提交前故障转移、推理输出 8192 floor、用量 sink、下一轮模型替换 | #123；`pi-runtime.ts`、`b4-hotswap-speaking.test.ts`；`packages/server/proof/b4-magpie-protocols-cache.txt` | 既有 live Magpie/ling-jing 上游错误（502 故障背景）尚未形成成功闭环；该 proof 最终只记录 upstream-error，不把 HTTP 外层 200 当模型成功；X 层留 P3 |
| P1-A | D 层同轮 round/reflect/compact/shrink 配置冻结、下一轮替换保留笔记/记忆；逐字证据核验、覆盖写入恢复、md/SQLite 启动对账；撤回/回退清洗；memory.* 与 profile 概览；邻域标题/正文/数量/相关度；playbook 与公告分离，Block 5 注入，净室 clone | `speaking-snapshot.test.ts`、`speaking-endpoint.test.ts`、`memory-capture.test.ts`、`memory-coverage.test.ts`、`memory-hygiene.test.ts`、`memory-api.test.ts`、`memory-write-neighbors.test.ts`、`playbook.test.ts`；`packages/server/proof/p1a-context-memory-playbook.txt` | D08.3 已定目标：默契可沉淀、可复制、群公告≠协作手册。DM#2103 的手册载体与具体机制仍属候选；本片 team/pair 观察 API 是本次授权的后端候选，不宣称已定产品方案。AC-42 真实模型 S+X、AC-32 X 层、AC-54 前端渲染、AC-08 在途任务取消及 P3 总体验收未测；G5 两阶段不纳入 |
| P1-C | D 层真实 HTTP/WS 合同：RPC/health、近 35 MB base64 上传及 413、JSON 错误、恒时令牌比较、CORS 白名单、游标补发/窗口溢出 resync、ping/pong、背压断开与订阅清理；CLI 双信号关闭 HTTP+WS+Host，`cli.ts serve --compute codex` 已接通 P1-B 装配 | `packages/server/src/http-ws.ts`、`http-ws.test.ts`、`cli.ts`、`bus.ts`；`packages/server/proof/p1c-http-ws-bridge.txt`；`receipts/feat-agy-http-ws-bridge.json`；PR #127 | 真实 Electron 前端端到端手动 UI smoke 等待前端启动/P3；AC-05/AC-31/AC-46/AC-51 整体验收仍未测；真实模型与网关联调未测，留 P3；独立审查待完成 |

P1-A 无 R-Rule 审批链、BlockerRate 自动路由或多人 CRDT 编辑。净室克隆不复制聊天消息、任务、承诺、共享文档、关联群、Compute 或处理游标；复制观察使用新群模板来源标记，不开放旧群聊天。独立审查未完成前不作发布/合入结论。

## Step 2A — `chore/agy-gates-process-layer`（Q08 / AC-23 前置，PR #125 已合入：`618fb79a`）

- [x] `G-LAYER` 识别 `process` 层：`process: []`，仅 `adapter` 新增向 `process` 的依赖许可。
- [x] 保留 `domain/kernel/plugin/app -> process`、`adapter -> adapter` 及相对路径跨包禁令。
- [x] `AGY_MODEL_RE` 识别 `gemini-3.8-flash-s` / `gemini-3.8-flash-high`；数据库回归拒绝畸形和未知名称。
- [x] 测试先红后绿提交，类型检查、lint、全量测试、门禁自检与变异校验通过；证据见 `scripts/gates/proof/process-layer.txt`。
- [x] 收据 `receipts/chore-agy-gates-process-layer.json` 保留 `review: null` / `waiver: null`，AC-23 运行时部分标为未测。
- [x] PR #125 已合入 `dev/agy-backend`，使可信 `$JUDGE` 识别 `process`。

## Step 2B — Priority Slice P1-B（D 层完成，真实二进制 S+X 留 P3）

- [x] 移植 @g-group/process-tools（process 层），Claude 一次性/常驻与 Codex 共用；保留 B1 停止确认、租约隔离和启动身份核验。
- [x] Codex app-server 0.169.0 wire 协议、每槽 CODEX_HOME / 真实 HOME 分离、启动并发限制、RPC 超时与结构化错误。
- [x] AC-51 ⑦ 双向轮边界换 Harness：在途轮次不打断，确认旧执行器停止后同任务/worktree 起新会话，实例与跨厂商模型账本只追加。
- [x] **已验证完成边界**：确定性 fake/native-wire、真实自有进程树与 git worktree；PR #91/#93 回归、A1/A6/A7/A10/A12/A13、合并 Red 67/67 用例失败，Green 全量 2158 条通过，门禁自检 255/255。R2 的 4/4 个故障变异均被捕获。缺失 Harness 和停止未确认均阻止后继启动。后继启动失败后可重新启动已退出的 Harness，或取消任务并释放租约。
- [x] **关键文件/测试/PR**：packages/process-tools/src/*.test.ts、packages/adapter-codex-compute/src/{protocol,adapter}.test.ts、packages/server/src/harness-switch.test.ts、既有 resident-stop/B1 回归；来源 PR #91（41dace26）、PR #93（a73cff64）；分支 feat/agy-priority-codex-protocol。后端合入 PR #126；证据：[P1-B proof](../packages/server/proof/p1b-codex-protocol.txt)；收据：[P1-B receipt](../receipts/feat-agy-priority-codex-protocol.json)。
- [ ] **未完成/待测边界**：真实 codex-cli 0.169.0 二进制 E2E、真实网关和模型 S+X、真实能力配置叠加及 Windows 留 P3。AC-23 / AC-51 / V-02 整体 D+X 保持“未测”。任意 Claude 工具子集与 skill 插件不冒充已映射，明确拒收。

P1-B 不替代 B1 已有证明，也不把 wire 实验提升为真实 Codex 或模型验收。
