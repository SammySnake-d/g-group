# 后端优先级进度与验证边界

本清单跟随 `dev/agy-backend` 切片同步。`[x]` 表示该后端切片的已列 D 层边界落地，不表示对应 AC 的 D+X 或 X 层整体验收完成。真实模型、界面与跨进程链路须另有运行证据。

- [x] B0 #119：门禁、来源与合并入口。
- [x] B1 #120：Compute 停止确认、租约及运行台账。
- [x] B2 #121：注意力、检索、压缩与授权护栏。
- [x] B3 #122：配置历史回滚、时间线与回执。
- [x] B4 #123：Magpie 多协议、缓存用量与说话模型热替换。
- [x] P1-A：不可变轮次配置、长期记忆卫生/证据/覆盖台账、协作观察及净室群克隆（后端候选实现）。
- [ ] P1-B：Codex `app-server` Compute 适配与真实链路。
- [ ] P1-C：HTTP + WS Bridge。
- [ ] P2-A：Admin / Quota / Helper；C-US09 撤回取消在途任务。
- [x] Step 3A / P2-A1：Chat Admin、C-US09 retract cancellation、RoomView blocked summary（D 层边界已验证；X/P3 未测）。
- [ ] P2-B：Plugins / Outbox / Commitments。
- [ ] P3：完整 D+X 验收矩阵、真实模型 S+X 评测与前端联调。

| 已完成切片 | 已验证完成边界 | 关键文件/测试/PR | 未完成/待测边界 |
|---|---|---|---|
| B0 | D 层来源解析、逐轮模型绑定、隔离工作区及合并入口校验；既有收据保留独立评审记录 | #119；`scripts/gates/`；`receipts/feat-agy-gates-provenance.json` | 不表示任意未来提交的独立审查已通过；D+X 产品验收留 P3 |
| B1 | D 层物理停止确认前不释放持久租约，Harness 路由与孤儿核对 | #120；`packages/server/src/host.ts`；`receipts/feat-agy-p0-compute-stop.json` | Codex app-server 真实执行留 P1-B；全部 X 层停止/恢复体验留 P3 |
| B2 | D 层混合检索、撤回/权限过滤、注意力因果护栏、失败保留原文、授权重新核验 | #121；`history.ts`、`a5-fresh-auth-races.test.ts`；`receipts/feat-agy-p0-attention-compaction-guard.json` | 真实模型压缩质量、性能与 D+X 任务全链仍待测 |
| B3 | D 层配置 CAS 历史与回滚预检、只追加任务时间线、撤回副作用披露及回执兼容 | #122；`host.ts`；`receipts/feat-agy-p0-config-provenance-receipts.json` | 真实模型与 UI 的回滚体验、全部 AC-08/AC-20/AC-32/AC-46 D+X 判定未完成 |
| B4 | D 层四协议发现、提交前故障转移、推理输出 8192 floor、用量 sink、下一轮模型替换 | #123；`pi-runtime.ts`、`b4-hotswap-speaking.test.ts`；`packages/server/proof/b4-magpie-protocols-cache.txt` | 既有 live Magpie/ling-jing 上游错误（502 故障背景）尚未形成成功闭环；该 proof 最终只记录 upstream-error，不把 HTTP 外层 200 当模型成功；X 层留 P3 |
| P1-A | D 层同轮 round/reflect/compact/shrink 配置冻结、下一轮替换保留笔记/记忆；逐字证据核验、覆盖写入恢复、md/SQLite 启动对账；撤回/回退清洗；memory.* 与 profile 概览；邻域标题/正文/数量/相关度；playbook 与公告分离，Block 5 注入，净室 clone | `speaking-snapshot.test.ts`、`speaking-endpoint.test.ts`、`memory-capture.test.ts`、`memory-coverage.test.ts`、`memory-hygiene.test.ts`、`memory-api.test.ts`、`memory-write-neighbors.test.ts`、`playbook.test.ts`；`packages/server/proof/p1a-context-memory-playbook.txt` | D08.3 已定目标：默契可沉淀、可复制、群公告≠协作手册。DM#2103 的手册载体与具体机制仍属候选；本片 team/pair 观察 API 是本次授权的后端候选，不宣称已定产品方案。AC-42 真实模型 S+X、AC-32 X 层、AC-54 前端渲染、AC-08 在途任务取消及 P3 总体验收未测；G5 两阶段不纳入 |

P1-A 无 R-Rule 审批链、BlockerRate 自动路由或多人 CRDT 编辑。净室克隆不复制聊天消息、任务、承诺、共享文档、关联群、Compute 或处理游标；复制观察使用新群模板来源标记，不开放旧群聊天。独立审查未完成前不作发布/合入结论。

## Step 2A — `chore/agy-gates-process-layer`（Q08 / AC-23 前置，PR #125 已合入：`618fb79a`）

- [x] `G-LAYER` 识别 `process` 层：`process: []`，仅 `adapter` 新增向 `process` 的依赖许可。
- [x] 保留 `domain/kernel/plugin/app -> process`、`adapter -> adapter` 及相对路径跨包禁令。
- [x] `AGY_MODEL_RE` 识别 `gemini-3.8-flash-s` / `gemini-3.8-flash-high`；数据库回归拒绝畸形和未知名称。
- [x] 测试先红后绿提交，类型检查、lint、全量测试、门禁自检与变异校验通过；证据见 `scripts/gates/proof/process-layer.txt`。
- [x] 收据 `receipts/chore-agy-gates-process-layer.json` 保留 `review: null` / `waiver: null`，AC-23 运行时部分标为未测。
- [x] PR #125 已合入 `dev/agy-backend`，使可信 `$JUDGE` 识别 `process`。

## Step 2B — P1-B（Step 2A 已合入）

- [ ] 移植 `packages/process-tools` 与 `packages/adapter-codex-compute`。
- [ ] 实测 AC-23 的进程清理、停止确认后归还及冲突后继隔离；本前置切片不宣称这些运行时行为完成。


## Step 3A — P2-A1

- [x] Chat Admin 群主鉴权、禁言、移出/解散、转让与批量本端隐藏删除。
- [x] C-US09 撤回来源消息触发既有 Host stop 路径；RoomView 阻塞摘要按提问序、带尾注、500 字符上限。
- [x] D 层证据见 `packages/server/proof/p2a1-chat-admin-summary.txt`；R-02/R-05 通过。
- [ ] 真实 Compute、前端联调、X 层与完整 AC 留 P3。
