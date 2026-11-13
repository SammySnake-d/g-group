# Q05 / U80 / D21 任务只追加时间线（作者候选）

## 范围与真实入口

固定 base 为 #77 / feat/runtime-config `272b1b5d77bd95f34467a5aa04d0bf5891355887`，本片新增内置 P0 的任务事实流 `tasks.timeline`。原副本和待审分支不改。不做前端、摘要插件或旧历史重建。

真实基线 service 请求为 `unknown_method`，见 `baseline-runtime.log`。空桩红基线随后只提供可加载 API/schema/table，返回空事件。

唯一记录模块 `packages/server/src/task-timeline.ts` 由现有初始 TaskDoc、中央 stepTaskTx、模型 attempt 直接写点、真实 follow-up 持久事务调用。状态 CAS 与事实 INSERT 在同一现存 SQLite 事务内；没有生产 SQL trigger、bus 重放或定时倒推器。测试中的 TEMP TRIGGER 仅做故障注入。

事实区分手工/联系人发起、手工指派、重跑来源、状态变更与停止确认、实际新增模型 attempt，以及补充 Received、queued/dequeued、resume Accepted、轮结束、Applied、双边 Rebound。只保存标识/状态/版本/来源序号，不复制可撤回的补充正文。主表只 INSERT，以持久全局 id 在 task 内正序 keyset 分页；游标绑定 task，严格 canonical base64url；当前房间成员才能读。读路径只 SELECT；旧任务可没有历史。

## 已实际运行的本机证明（不是完整产品验收）

- 最终同体 11 项在空桩红提交上全部以具名 ERR_ASSERTION 失败；候选 11/11 绿，skip/cancel/todo 均 0。
- 真实 SQLite 重开保留旧 payload 字节及继续游标；startup recovery 可追加真实失败/停止事实。旧任务第一次真实新指派只记新事实，绝不编造 Created。
- 事务插入故障使创建/状态写一起回滚且无持久/总线幽灵；目标侧改挂事实失败时，双 TaskDoc、双 FollowDoc、时间线和 action receipt 一起回滚，可用同 key 成功重试。
- 同时间戳并发追加后 keyset 无重复/遗漏，跨 task 和 noncanonical 游标被拒；当前成员权限；读取 total_changes 不变且无总线事件。
- 目标 lint / 项目 typecheck 实际 exit0。完整红/绿日志与命令的原始错误留在接手状态目录，不能将旧夹具/执行器错误当产品红。

## 时间顺序声明

初始9项先于实现真实红（`b8b31c88`）；后续修正了重跑/重启会追加真实新事实、既有终态取消为 conflict、legacy T1 不可取消的错误夹具假设。TT10/TT11、canonical 编码和零写入控制属于实现后扩充。最终同体11项在独立红副本回放，见 `same-eleven-final-red-receipt.json`。不宣称最终11项全部先于产品补丁编写；保留原始红证据。变异清单同样明确为实现后登记。

## 尚未完成与验收边界

22 项具名变异清单已登记且逐锚点唯一性已验证，但本文件这一版本尚未运行云变异或全量。下一步 box4 持久盘、共享 `/workspace/.heavy.lock`，沿 Q14→Q04→Q12→Q05→Q08 顺序运行最终红/绿、变异、依赖回归、type/lint/full 和原版官方门禁。不能把准备/入队当云通过。

正式 Docker 沙箱在 Q14/Q04/Q12 遇到 overlayfs mount invalid argument，尚无已验证共享执行器修复；不得绕沙箱或将零运行计数算产品失败/变异杀死。G-REVIEW 未签、G-PROVENANCE review=null 短路不是来源实核。本片使用受控 Mind/Compute，不是真模型、真CLI或完整AC-02/全U80验收。外部 resume 成功后再遇数据库故障的更强原子语义未证明。本片不改现有继续/取消协议以掩盖该边界。
