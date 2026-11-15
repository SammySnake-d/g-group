# 群聊 B1：用户确认发言边界后的作者证据

- 集成基线：`45976fca3c1311451acf17c915509d724bf719f1`；本次被测源码：`06a5ca7f822fa35b71874dd165eafb1b2fe7c79f`。最终收据提交只添加证据和收据，未改变被测源码；哈希见 `source-hashes-06a5.txt`。
- 用户在 2026-11-15 通过 DM#3786 确认：未被点名者有新信息时可以直接补充。U69/D15.1 要求每位联系人收到并处理消息；D19.3 保留纠错与独立观点；D07.0 要求同因果链自动互唤有界，阈值和恢复策略待实测。D15.2 要求发送前对新消息复核；本片不宣称实现了完整语义快筛。
- 远端 PR #109 的 `d739da7` 机械拒绝所有未被点名的直接回复，错误且已经撤回这一判断，见 PR 作者更正评论。它在混合批次和 Compute 进度上也出现误拦。用户确认后撤销该限制，而不是把内容是否有价值硬编码为一个拦截条件。

## 先红后绿与预算回归

| 证据 | 结果和范围 |
| --- | --- |
| `red-meaningful-supplement.txt` / `green-meaningful-supplement.txt` | `bf0c6b96` 在旧候选上按名失败，`dc9a46b3` 撤掉机械拒答后通过。红是对先前错误候选的回归，不是对 `45976fca` 原基线的红。 |
| `red-context-guidance.txt` | `b3383680` 的联系人上下文缺少区分重复与补充的指引，按名失败；只证明指引是否装进模型上下文，不证明模型遵守。 |
| `red-concurrent-snapshot.txt.gz` / `green-concurrent-snapshot.txt` | `39b04ba7` 中其他联系人在状态笔记整理期间先发言，旧草稿仍提交；`06a5ca7f` 在同一消息提交事务内发现快照变化，回到注意循环复核。测试同时断言重复草稿不发及有新信息可补充，使用确定性替身。 |
| `recall-base-45976.txt` / `recall-regressed-4df7.txt` / `recall-and-group-green.txt` | 追加提示词造成 4000 字节预算下的私聊重试测试失败；压缩既有指引而非抬高预算后，相关 14/14 通过。云端第一次全量 1671/1672 的失败详情在 `cloud-failure-4df7.json`。 |
| `initial-runner-syntax-error.txt` | 实现首试使用 Node strip-only 不支持的 TS 参数属性，退出 1；改为普通字段后重跑。保留执行器错误，不作为行为红测。 |
| `green-related-48.txt` | `group-supplement / group-claim / host / recall / retry` 共 48/48。 |

## 全仓和真实包

- 云节点 `pentest-1`，源码文件哈希逐项等于本地 `06a5ca7f`（`cloud-source-06a5.json`）；`npm test` 1673/1673，fail/skip/todo/cancel 均 0；`npm run typecheck` 0；对四个改动文件直接执行 Biome lint 0。原始输出分别为 `cloud-test.tap.gz`、`typecheck-output.txt.gz`、`biome-output.txt` 和 `*.exit`；`cloud-status-06a5.json` 是远端回执。首次候选云命令 TLS 中断后读取远端退出结果，没有把中断当成功。
- `live-4df7-result.json` / `live-4df7-repeated.txt`：仅提示词、无快照复核的旧候选，真实模型让小林和小克各回了一次同样的 `GRP_OK_2`；脚本退出 0 不等于场景通过。
- `live-06a5-result.json` / `live-06a5-db-summary.json` / `live-06a5-final.png`：用同一 `group-walk.mjs`、`fengshao1227/deepseek-v4.1-flash` 及隔离包重跑，消息只 @ 小林；UI 可见小林唯一一条回复，2 条消息、3 个已结束的联系人回合，245 秒时脚本观察不到正在回复。SQLite `gg_effects` 无拒答。单次实测不能证明所有模型输出或因果互唤均受限。
- 包以 PR #101 的前端和本候选后端组合，构建和源码哈希见 `package-06a5.txt`；为了让走查令牌不落盘，仅隔离包中的 `AppConfig` 改为内存态，Compute 使用 fake。没有改动 PR #101 分支或原打包应用。

## 未完成及依赖

`#88` 的持久因果根限额与自动互唤直接相关，但 Claude R1 为 REJECT：因果根在 Compute/代发等边界重置、跨会话误合并、待处理丢失和已放行唤醒作废等仍需返修。应先修 #88、审查其 #76 → #79 及 #71 依赖，再基于最新集成头合流、针对真实因果链复验；本片未重造限额、不能声称完整解决互唤。正式机械门禁和 Claude 独立审查尚未在本候选完成；AC-27/AC-31 不以局部绿测冒充完整通过。

- 证据提交前 `git diff --cached --check` 因原始 TAP 空白行末尾空格退出 2（`evidence-diff-check-error.txt.gz`）；第一次压缩后错误回执和 typecheck 原文也触发同类检查（`evidence-diff-check-error-2.txt.gz`，退出 2）；均以 gzip 无损保存后复查，不改写原始日志。
