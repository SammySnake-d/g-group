# PR #98 第 1 轮独立审查：REJECT

冻结 HEAD：`8d0b644052813ed089fb5ba662ee56aea2994238`；分支 `feat/q06-1-count-trigger`；base `feat/chat-admin` @ `c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29`。

`reviewed_hash = a62d6ada558d685f499b1c9d4083c93d61006fa7f641353df859e427909edc09`，独立计算与作者相同。审查只覆盖这棵树的 13 个差异文件；产品源码未改。

结论：1 项已复现的生命周期缺陷、2 项自构单点故障暴露的测试缺口。全量和作者变异通过，不能抵消原树上已出现的反例。下述必修项完成后再审，不合并。

## 来源核验与范围

- 作者：`claude:484c2330-2f15-49ae-9f7a-145e467cedb1`，`group/opus`，Anthropic。审查：Codex 宿主 `codex:60035fe9-26d8-47e0-a381-566b28322cce`，实际模型 `chatflows/gpt-6.1-sol`，OpenAI；宿主原生线程 `01a1d98a-7796-74b0-ac57-7910d994edd6`。同模型子代理 `/root/review_pr98`（原生线程 `01a1d990-32e2-7381-bd6a-a65322be8e33`）执行本片代码通读、box1 复跑、探针和报告；宿主独立核 PR/ref 与 hash 并负责推送。不是作者自审，未换模型。来源门禁结果另列，不能用自报身份代替。
- 最新设计真源：`origin/docs/dev-handbook` @ `90226df5ffd17656f2654ab8555f7e71a93639de`，需求文档 §2.0、U80、D21.2–4、D05；验收 AC-31/AC-35/AC-49；开发手册原则 37–41、67、71。作者的文档和数字仅作待核线索。
- 用户可见时间轴、来源跳转、真实模型是否恰当登记承诺不在本片独立交付范围；Q06-1 独立合入后窗口 pending 且没有消费方是这次明确的切片设计，未当缺陷。
- 正确性、安全、性能、可读性、测试与分层均通读；未发现需要另立的依赖、权限或分层问题。每条消息从日志重算的成本随历史增长，本轮未做性能负载测量，不声称性能验收通过。

## 必修：已复现产品缺陷

### CORR-001（High）：移出后立即拉回，会恢复原本应关闭的旧计数触发

位置：`packages/server/src/count-triggers.ts:178`、`:188`、`:238`；宿主成员变化接线缺口位于 `packages/server/src/host.ts:1294`、`:1319`、`:1329`。

本片明写「联系人移出或正在移出 → 触发关闭并写明原因，pending 窗口取消」（模块开头、作者 PR 与收据）。实现却只在下一次 `onAppendTx/reconcileTx` 才把动态不满足条件持久化成 `closed`。`removeMember` 只删成员行；`viewOf` 暂时显示 `active=false`，触发行仍是 `active`。在下一条消息之前重加入，`closedWhy` 又返回 null，旧计数与旧窗口都继续生效。

冻结原树、真实 service API 的独立复现：

1. 登记 N=2，随后发 3 条。SQL：触发 `active`，`covered_seq=3`，1 个 `pending` 窗口 `(1,3]`，下一段 count=1。
2. `rooms.removeMember {member: contact}` 成功。成员列表中该联系人已消失；SQL 仍 `active`，原因 null；窗口仍 `pending`；仅读取视图变 `active=false`。
3. 不发新消息，立即 `rooms.addMembers` 拉回。旧视图恢复 `active=true,count=1`。
4. 再发一条，第 2 个窗口 `(3,5]` 被旧承诺冻结，旧 pending 窗口也没有取消。

证据：外部证据目录的 `rejoin-probe.mjs` / `rejoin-probe.log`；原样日志包含各步骤 SQL、窗口、视图和 `room.updated/commitment.updated` 事件。命令退出 0 是“反例被稳定复现”的探针断言通过，不是产品符合关闭合同。

这是 contact 被 `rooms.removeMember` 移出后重入的路径；未混为用户本人离群。现合同没有独立 `rooms.leave` 方法，本轮没声称验证用户本人离群。最新真源 U80/D21 要求消息数触发、D05/AC-49 规定成员边界，但没有逐字指定“离群永久关闭每 N 触发”；本条缺陷依据是本片已经选择且对外声明的关闭/取消语义与实现相矛盾，未把助手推论伪装成用户原话。

**必修**：在导致关闭的成员/离开状态写入点，同事务持久关闭该房间该联系人的触发、取消 pending，提交后推一致的承诺更新；立即拉回不得复活旧触发，需要新承诺才能新开。补具名回归：移出后无新消息立即拉回、已有 pending 被取消、移出中与最终移出、跨重启保持关闭；别的房间触发与已结算窗口保持原值。应先在当前树按业务断言变红。

## 必修：仅缺测试，未声称当前产品行为有错

自构故障均在隔离快照，每个只替换一个源码位置；实际跑同一份 17 条相关测试。原样正对照 17 绿/0 红、独立业务探针 exit=0。所有受检文件与 live runner 在运行期间固定。

| 自构单点故障 | 现有 17 条结果 | 独立业务探针 | 判定 |
|---|---|---|---|
| `chat-range.ts` 把 Helper 与 system 一起排除 | 17/17 全绿，exit=0 | N=2 的用户发言 + 真实 `helper.post` 应冻结却未冻结，exit=1 | TEST-001：仅缺 Helper 计数断言 |
| `count-triggers.ts:viewOf` 窗口数量查询去掉 trigger 过滤（保留参数数量） | 17/17 全绿，exit=0 | 一房已有 1 窗口，二房新触发应报 0 却报 1，exit=1 | TEST-002：仅缺窗口计数作用域断言 |
| `windows(triggerId)` 去掉 trigger 过滤（保留参数数量） | 16 绿/1 具名红，exit=1 | 本探针不覆盖该列表，exit=0 | 现有「撤销承诺后不再触发…另一条没撤销的照常」杀死；防线成立 |

TEST-001（Medium），位置 `packages/server/src/count-triggers.test.ts:131`：补从 `helper.post` 真实入口到窗口冻结的断言，明确 Helper 发言照常计数。TEST-002（Medium），位置 `packages/server/src/count-triggers.test.ts:224` / `count-triggers.ts:179`：补两个不同 trigger/room 的不等窗口数，并逐个核 `CommitmentView.trigger.windows`。将两个存活故障只增入本片变异清单，用同名断言杀死；无须为测试缺口虚构产品代码修复。

证据：`cloud/independent/results.json`、`clean.tap`、`omit-helper.tap`、`global-window-count.tap`、`global-window-list.tap` 及每项 `*-probe.log`；脚本 `independent-run.py` 与 `count-probe.mjs` 保留 exact from/to。

## 产品取舍核对：联系人自己的发言计入 N

U80 的原话和 D21.4.1 写的是“每 100 条消息”，不是“每 100 条用户消息”；D21.2 的对象是群聊发言。没有找到排除承诺所属联系人的普通发言的条款。因此“用户/联系人/Helper 普通发言照算，system 与任务事实卡不算”是有字面依据的实现选择，本轮不据此打回。文档也没有逐字列出每种 sender 的口径，收据应继续把它写为解释选择，不能提升成用户已逐字批准。

摘要自身不计数、不循环触发要由 Q06-2 的独立存储/消费合同验证；不能用“联系人不会被自己唤醒”代替摘要输出不触发的证明。N=1 可能因普通联系人回复多出窗口，属于已披露的该口径效果，不是无限自触发的证据。

## 独立复跑

运行点固定为最终冻结 HEAD；box1 Ubuntu / Node `v24.21.0`，独占本任务目录并经 `/workspace/.heavy.lock` 串行。原始命令、cwd、起止和退出码在 `cloud/logs/results.jsonl`。

| 检查 | 亲自观察结果 |
|---|---|
| `npm ci --no-audit --no-fund` | 本机与 box1 exit=0 |
| `npm run typecheck` / `npm run lint` | box1 各 exit=0 |
| `npm test` | box1 exit=0；1502/1502，fail/cancelled/skipped/todo 全 0 |
| 当前具名两文件 | box1 exit=0；17/17，fail/cancelled/skipped/todo 全 0 |
| `5579bc7` 红提交相同两文件 | exit=1；17 条全部按名字失败，pass=0，无跳过/取消/todo；测试体对最终 HEAD diff 为空，见 `red-test-diff.log` |
| 作者 `q06-count-trigger-mutations.mjs` | 46 注入点全匹配；正对照17绿；46杀死/0存活，每项均17条合计且指定业务测试失败 |
| 审查人自构故障 | 3项全完成；2存活/1杀死，详见上表 |
| Linux `npm run gates:selftest` | **exit=1，失败**；219/219被调用但 Linux 未配置沙箱，含169处沙箱文字。保留该环境失败，不当产品失败或自检通过 |
| 同字节框架的 macOS 完整自检 | 宿主在 PR #94 真实 push E2E 入口复核219/219、exit=0，112秒、Node22.22.0。本片 `run-all/lib/gates/selftest` 与#94字节相同；scripts/gates唯一差异是#94新增pre-push-hook.test.ts，见 `shared-gates-diff.log`。复用该框架证据，不谎称本片又独立跑了一次。证据总目录 `pr94/new-full.log` / `real-push-e2e.json` |
| 通用 `gates:mutation` | 未跑；本片未改框架，未用作者行为变异冒充通用门禁变异 |

各片自己的 macOS `run-all.ts --local --branch=feat/q06-1-count-trigger --base=origin/feat/chat-admin --pr=98` 已跑：写 review 前 G-PROVENANCE/TRACE/RED/STUB/TAUTO/WORKFLOW/LAYER 7绿，G-REVIEW“还没有独立审查”，exit=1。写 review 后的原样结果见下节；不是“所有门禁通过”。

## 门禁签审后复核、交付与清理

签审后真实复核 exit=1：G-PROVENANCE 失败「审查会话不可信:会话记录不存在:codex:60035fe9-26d8-47e0-a381-566b28322cce」（宿主本轮尚未结束，turns 未落盘，未伪造或补写）；G-REVIEW 失败「审查结论是 reject」；G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 六项通过。hash 仍为 `a62d6ada…9edc09`。原样日志 `gates-after-review.log`、退出记录 `gates-after-review-exit.json`。审查提交仅 `reviews/feat-q06-1-count-trigger.md` 与 receipt 的 `review` 区块，`review_status` 保留作者原值，避免偷偷改变受审内容。

外部完整证据：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-backend-review-codex-20261114/pr98/`。云端原包 `cloud-evidence.tgz` 的 SHA-256 为 `7ebe52af3ce0a4e590ec4ea0d1d919473be6ba0476f5c4af0de2ab4c8d9020fc`，分片取回核一致并解包；最终 MANIFEST 另列各文件 SHA-256。box1 自建目录已删除，23581 文件；df 可用空间增加 718438400 字节，归属进程残留 0，原记录 `cleanup-cloud.json`。本机 clone 留给宿主正常推送后清理。没有合并或改产品代码。
