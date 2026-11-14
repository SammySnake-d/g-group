# PR #97 Q06-2 群聊动向摘要后端：第 1 轮独立审查

## 结论：REJECT

三个可复现的实现缺陷必须返修：撤回后 `failed.error` 仍泄露原文；多份摘要同 `toSeqInclusive` 时分页丢项；摘要调用绕过注意循环，导致同一联系人推理并发。另有两项只缺测试：生成时点的真实值、历史摘要的模型快照。原实现这两项行为正确，不要求为补测改生产逻辑。作者测试和 130 个变异全部通过，不能抵消下述反例。

## 审查对象与来源

- PR：https://github.com/SammySnake-d/g-group/pull/97，分支 `feat/q06-2-trend-summary`，冻结 HEAD `0ccc2d9a1a11473da151cb7574eea7231e69d80d`。
- 固定底座：`feat/q06-1-count-trigger` @ `8d0b644052813ed089fb5ba662ee56aea2994238`。本轮期间底座上的审查提交不改变这个受检产品版本。
- `reviewed_hash`：`8a854b818436cab8cd9167e3ad36d5952ae729e9e4b5249bb4c8f52037cd0e07`，与作者报告一致；父会话亲自以单独一条 `run-all.ts --hash --branch=feat/q06-2-trend-summary --base=origin/feat/q06-1-count-trigger` 算出。
- 审查人：Codex，mirasim 宿主 `codex:60035fe9-26d8-47e0-a381-566b28322cce`，实际模型 `chatflows/gpt-6.1-sol`（OpenAI）。独立复现由同模型子代理原生线程 `01a1d990-bf3c-7320-b307-ca086c0b1809` 执行；父原生线程 `01a1d98a-7796-74b0-ac57-7910d994edd6` 复核 hash 并统一交付。作者 `claude:484c2330-2f15-49ae-9f7a-145e467cedb1`，`group/opus`（Anthropic），厂商不同。
- 需求真源：`origin/docs/dev-handbook` @ `90226df5ffd17656f2654ab8555f7e71a93639de`，需求 v3.31、验收文档、开发手册；冻结副本在证据目录。
- 只改本审查文档与本片收据 `review`；没有修产品代码、没有合并。故障注入只发生在独立复制品。

## 必修：真实实现缺陷

### Q06-R1-01（高，敏感信息）撤回只清 `items`，错误字段继续暴露被撤回原文

位置：`packages/server/src/trend-summary-format.ts:96`、`packages/server/src/trend-summaries.ts:290`、`:314`、`:144`。

模型把一条输入原文输出成未带来源的要点时，解析失败原因直接拼入正文前 80 字，随后存入 `gg_summaries.error`。撤回路径只失效 `status='ok'` 的行，假设 `failed` 没有原文；读取视图又直接返回 `r.error`。

独立复现：消息 #2 为 `NEUTRAL_PRIVATE_MARKER_PR97`，模型返回无来源的 `- NEUTRAL_PRIVATE_MARKER_PR97`。结果为 `failed`，错误 `有要点没带来源:NEUTRAL_PRIVATE_MARKER_PR97`。撤回 #2 后，摘要仍为 `failed`、`error` 原样返回；关闭宿主并重新打开同库后仍然返回这段内容。对照组的合法带来源摘要在撤回后确实变为 `stale` 且 `items=[]`。

这违反 D21.3 第 15 项「摘要不能比原文活得久」与 AC-08 删除后派生读取不得返回原文。不是模型引用错误本身，而是宿主把错误中的原文作为可持久读取的摘要字段保留下来。

返修要求：错误输出不要保存来源正文；所有可能含来源内容的持久字段都须纳入撤回/隐藏可见性校验及清除。补「解析失败含原文 → 撤回/重启 → get/list 不再泄露」具名测试与对应故障；生成期间已撤回后才走解析失败的分支也要验证。

### Q06-R1-02（高，正确性）分页只使用 `toSeq`，同序号余项永久丢失

位置：`packages/server/src/trend-summaries.ts:156`、`:161`，合同 `packages/api-contract/src/api.ts:278`。

数据库允许不同联系人在同一区间生成摘要，也允许同一区间多个版本。排序包含 `to_seq DESC, contact_id, version DESC`，游标却只有 `beforeToSeq`，下一页使用 `to_seq < cursor`。

独立复现：同群两个联系人都登记每 1 条触发，消息 #2 生成两份 `toSeqInclusive=2` 的摘要。`limit=200` 返回两份；`limit=1` 第一页返回一份且 `hasMore=true`；按合同用该份 `toSeqInclusive=2` 翻页，第二页却返回空且 `hasMore=false`。第二联系人那一份永远取不到。`includeSuperseded=true` 的多版本同序号也有同一结构问题。

返修要求：分页游标覆盖稳定的完整排序键，或保证同序号分组不被截断；合同和消费侧一起调整。补多联系人同终点、历史多版本同终点的跨页无丢失/无重复测试与故障。

### Q06-R1-03（高，架构/正确性）摘要绕过注意循环，同联系人出现并行推理

位置：`packages/server/src/trend-summaries.ts:277`，接线 `packages/server/src/host.ts:466`。

摘要有自己的全局 Promise 队列，但直接调用 `who.mind.round`，没有进入同联系人的注意循环串行队列。独立探针把摘要轮保持在途，同时让同一联系人处理触发消息的普通轮，观测到 `summary active=1` 后 `normal active=2`，最大同时推理数为 2。

这与 AC-31②「同联系人推理期间新事件排队不并发」直接冲突。摘要只读能避免它执行任务动作，并不能豁免同联系人的推理串行合同。作者 PR.md 已披露并行现象，披露本身不构成已批准的例外。

返修要求：摘要请求复用同联系人推理串行入口，保留固定窗口与只读动作限制；补普通轮/摘要轮两个方向的竞争、同联系人不同会话、不同联系人可并行的具名测试和故障。

## 必修：只缺测试，原实现已正确

### Q06-R1-04（中，测试）生成时点与历史模型快照未被现有断言钉住

审查方分别构造两个单点故障：

1. 成功摘要的 `generated_at` 固定成 `2000-01-01T00:00:00.000Z`。
2. 读取摘要时用联系人的当前 `speakingModel` 代替已存的生成时模型快照。

原样副本 36/36 通过；两个故障也各自 36/36 通过，退出码 0、无 skip/todo/cancelled，均存活。现有主测试把 `generatedAt` 先替换为空串再比较，模型只在未改配置的静态场景检查。

独立业务对照：注入可控 `now=2026-11-14T10:00:00.000Z`，断言 `generatedAt` 正是该时点；生成后经 `updateContact` 把说话模型改为 `review-current-model`，断言历史摘要仍保留原模型。原实现通过；两个故障分别因「生成时点必须是真实生成的时间」「历史摘要必须保留生成时模型」业务断言失败。没有加载失败冒充杀死。

返修只需把这些业务断言与故障纳入长期测试和变异清单，生产代码不用改。

## 需求取舍核对

- **只因撤回失效**：U80 与 D21.4 第 5 步明确要求撤回失效。编辑导致失效没有明确已定条款；D05:750 的 rewind 摘要失效仍是建议，U26 还保留引用副本边界未决。本轮实测编辑/rewind 后旧摘要仍 `ok` 且保留旧解读，作为开放边界记录，不仅凭这两项 REJECT。AC-48 当前只要求撤下内容不再进入联系人有效上下文；本片没有把历史摘要装入该上下文。
- **本端删除**：已有 U23 只隐藏本人端；这片按 viewer 隐藏来源，没有把它扩大成全群过期，方向有依据。但 Q06-R1-01 表明错误字段也必须遵守派生可见性。
- **联系人自己的发言计 N**：D21 的字面是「每 N 条消息」，没有仅数用户或排除承诺所属联系人的规定；仅凭此口径不拒审。摘要自己的记录不是消息、不会自触发，测试与实现一致。
- **同联系人并行**：存在 AC-31 明确合同，所以此项和编辑/rewind 的未决边界不同，必须返修或由用户明确修改合同。
- **产品边界**：本片为后端与前端读取合同，真实时间轴/跳转未测且不属于本片；全量绿不表示用户已能看到完整产品。未重跑真实 `group/opus` 模型样本，不把作者样本冒充审查方运行。

## 独立复跑数字

所有重活在 box4，Node v24.21.0，固定 HEAD；box2 最初因他人占共享锁排队，取消的只有自己的 pending flock，没有执行测试；按父会话授权转 box4。未占用 box3。共享锁与运行器输入保持冻结。

| 项目 | 实际结果 | 原件 |
|---|---|---|
| typecheck / lint | 均 exit 0 | `cloud/logs/typecheck.log`、`lint.log` |
| npm test | 1523/1523，exit 0，无 fail/cancelled/skipped/todo | `cloud/logs/full-test.log` |
| 具名绿 | 38/38，exit 0（本片21＋前片17） | `cloud/logs/named-green.log` |
| 红提交 `6946ccf` | 21/21 按名失败，exit 1；测试体与最终 HEAD 无 diff | `cloud/logs/named-red.log` |
| 本片作者变异 | 原样副本36/36；84杀死、0存活 | `cloud/logs/q06-trend-summary-mutations.log` 及逐项TAP |
| 前片作者变异在本树复跑 | 原样副本17/17；46杀死、0存活 | `cloud/logs/q06-count-trigger-mutations.log` 及逐项TAP |
| 自构单点故障 | 原样36绿；2个故障各36绿，均存活；新增业务对照各自杀死 | `cloud/logs/independent-faults/`、`snapshot-controls/` |
| 独立实现探针 | 三真缺陷及编辑/rewind观察；正常撤回清正文正对照通过 | `independent-probes.mjs`、`independent-probes-result.json` |
| 签审前 `--local` | 七项通过；G-REVIEW「还没有独立审查」，exit 1 | `gates-local.log` |
| 签审后 `--local` | 六项通过；G-PROVENANCE「审查会话记录不存在」、G-REVIEW「审查结论是 reject」，exit 1；hash 不变 | `gates-after-review.log` |
| 共同框架自检 | 父会话在 #94 实跑 219/219；五个门禁核心文件与本片逐字节相同，只引用共同框架验证 | 总证据目录 `pr94/new-full.log`、本片 `source-seal.json` |
| 通用 `gates:mutation` | 未跑；本片不改门禁框架，本轮不重复 175 个通用变异 | 不冒充通过 |

作者报告的全量 1523、本片 84、前片 46、绿 38、红 21 均在最终冻结版重新执行，未沿用作者较早提交的数字。变异脚本只加旁路原始 TAP/stderr 留存，注入清单、测试、判杀逻辑未改。每个变异的完整测试数与指定测试名另在 `validated-results.json` 核验；不把超时、加载失败或部分执行算杀死。

## 门禁、交付与清理

`review` 写入后再次实跑完整 `--local`：六项通过；G-REVIEW 因 `reject` 拦截，G-PROVENANCE 报「审查会话不可信:会话记录不存在:codex:60035fe9-26d8-47e0-a381-566b28322cce」。活跃宿主记录未落盘，不伪造、不宣称来源门禁已完成；原样结果见 `gates-after-review.log`。

受检 20 文件、底座、文档版本与门禁框架比较封存在 `source-seal.json`。审查代码未改受检产品；云端受管 diff 为空。云端证据回收并核验归档 SHA-256 后，已只清自己在 box4/box2 的目录，分别释放 721457152 / 8192 字节，自己剩余进程 0；本机克隆保留供父会话推送，收尾由父清理。审查提交及远端回读由父会话统一执行，不合并 PR。

证据：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-backend-review-codex-20261114/pr97/`。原始云端归档 `cloud-evidence.tar.gz`，解包 `cloud/`；需求与验收文档快照、运行脚本、故障与对照、source seal 均在此目录。

我为什么相信这些绿：固定 HEAD 上 1523 条全量、21 条真实红及130个作者故障逐项复现；它仍被「error里有正文却只清items」这条具体反例骗过，所以结论是 REJECT。
