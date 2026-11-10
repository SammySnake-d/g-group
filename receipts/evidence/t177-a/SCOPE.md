# A / AC-15 实测范围与未覆盖项

作者 astra；会话 codex:63240562-6769-4e58-afdd-835948217589。仅 feat/t177-a-recovery → dev/integration，不合 main。

## 接口与审查条件

- A-1：宿主恢复后用「宿主已把工作区回到 vK 交付之前」通知；分「仍在工作区里的」与「要重做的」。无代码仓保留文字撤改并标宿主未核验。
- A-2：领域输入 recoveryMode = host / merged / unverified。merged 只改挂升版，不回退其他 Applied、不重放源任务。
- A-3：不做旧数据导入。无历史降级到明确未核验；历史存在但 fromArtifact 不匹配或提交不可达才拒绝。
- A-4：Git 临时 index 在任务 git 目录；commit-tree 明确 --no-gpg-sign；原 index 不变。
- A-5：restore 不移动 HEAD/任务分支；重新 pin 在原分支向前提交。

交付历史 delivery-history:<task> 只追加，以 deliveryId 幂等。同版本多交付保留 ordinal；前驱为 resultVer 严格更小且 ordinal 最大的已确认交付。记录与 ws、Applied 由宿主原交付事务一起提交。

恢复先经停止确认，再登记 restore:<task>:<ver>；targetSha/backupRef 固定。backup → restore 在 DB 事务之外，完成、W2 与待重放记录同事务。备份 ref 存在时核验归属并复用，不以 phase 决定重新备份。restore-plan 与 pendingRollback 在改挂事务保存；恢复期间阻止再改挂、交付、合入及 Compute 写入。

## 证据解释

- 红阶段：6182225 是初始 24 项红测；宿主夹具最初未实际完成交付，在 eeffaf0 修正后重跑 7 项均具名失败，不沿用初版宿主红作因果证据。
- 6545d87 补入 4 个真实子进程退出边界；8819f7c 是 28 项红锚点；4a6d8a9 增加真实停止确认/配额两项；10091aa 为显式注入生产构造器后的最终 30 项红锚点（断言未弱化）。最后追加的删除文件、两文件半恢复与严格前驱强化在首次绿实现后补红，如实属于追加验收的空壳红对照，不声称它们先于首次实现。原需求的 24 项红与实现保持原始顺序。
- 59766f6 是第一轮增强快照（云端 1501/1501）。随后以 A04H/A15Q 两条真实红复现 stopped 早于 quiesce 与遗漏配额，64c16f6 是两处修复后的实现快照。真实 Git 仓、工作树、文件字节和 SQLite；Compute 使用确定性替身，不将其宣称为真实 Claude/Codex 模型端验收。
- A12I/B/P/D 在独立 Node 子进程分别于意图后、备份后、恢复一半、文件恢复完但完成事务前退出；重开宿主核对 target、backup、两文件字节及重放次数，再重启观察不重复发送。
- typecheck/lint、全量与变异在 box3 独占 heavy.lock 串行运行。本机仅逐文件快验和需要 macOS sandbox-exec 的 --local 门禁。无浏览器。

## 不伪称覆盖

AC-15 的无 codeRepo、升级缺历史任务明确「宿主未核验」，不能算宿主文件撤回通过；已合入任务撤回另开任务；网络外发等非文件副作用不在恢复能力内；系统断电/文件系统损坏未测。AC-45 原 resultVer 推断沿用，未在本片修复。

**重放发送结果未知窗口**：现有 Compute.resume 没有持久幂等 actionId/送达查询。恢复重放发送前记 sending，收到成功才记 done；进程在外部接收与本地确认之间退出时，重启把 sending 标为 blocked，提示「送达结果未知」，不自动重复发送。文件恢复仍已完成，但不能承诺外部 harness 恰好执行一次；此边界未达“任意退出点自动恢复”意义下的端到端保证，保留为审查关注项，不靠本地 action 去重假装解决跨进程送达。

备份 ref 只建不删；本片不实现产品备份 GC。开发时临时克隆/证据副本的清理不影响产品备份保留合同。

静态 G-TAUTO 不追踪返回对象内的生产实例；测试夹具改为显式接受并使用 Host/Worktrees/RecoveryStore 构造器，保留所有行为断言；没有修改门禁。原签名变异只打开 commit.gpgsign，在 box3 的 commit-tree 上没有开启签名，实际存活。最终定点变异改为 -S 真正开启签名，不把无效变异当已杀死。
