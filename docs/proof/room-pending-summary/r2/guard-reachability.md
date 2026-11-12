# R1-04：三道过滤逐条处置（当前 Host 合同，不泛化到任意手写数据库）

审查给出两种合法路线：独立可达反例，或者证明当前宿主不可达并删除冗余判定。本轮不伪造非法任务快照来杀变异。

## 1. state !== T4b：不可独立触发，删除冗余条件

要只让原 state 条件拦住，必须同时有：当前 pendingQ、该 qId 的 open 卡、任务却已不是 T4b。当前 Host 的稳定事务边界到不了这个组合：

- 三个任务创建点 createTask、rerun、dispatch 均基于 newTask，pendingQ 初始 null。
- 常规转换由 stepTaskTx 写入任务后，在同一事务调用 expireQuestionsTx：不是 T4b 时 live=null，所有仍 open 的 question 卡标 expired。包括 Cancel/ExecFailed/停止确认。发布 room/task 事件在此之后。
- 另一写入路径 recordTurnTx 只记 ProducerModelAdded，不改变状态/pendingQ。
- saveTaskTx 的三个调用点仅由 follow-up amend/rebind 的领域组合产生。非终态 bump 用 Amend：T3/T4b 的 amendLive 和 T5/T7/T8 的 rework 都清 pendingQ；停止中/终态不改状态。不会产生「非T4b + 当前pendingQ + open卡」新组合。
- 源码核对所有 putDoc(task:...) 写点，未添加旁路写入。本片没有修改这些生命周期方法。

因此 roomView 只保留 pendingQ + open 卡判定，删除 state !== T4b 这一冗余条件；不是保留一条没有判别测试的条件。R2-04b 在真实 stopTask 立即返回后观察 T9、保留的 pendingQ、expired 卡与仍可见原消息，摘要为 null；此时去掉剩余 open 条件会产生错误摘要，交云端指定具名变异验证。

本证明限定当前 Host 正常 API、其事务提交后的稳定状态；不声称任意手工改库或外来迁移脏数据都满足它。将来若新增绕过上述生命周期的入口，必须重新建立不变量，而不是引用本证明。

## 2. card.state !== open：保留，真实独立反例

R2-04b 由正常 blocked → stopTask 产生，不手写状态：pendingQ 留在 T9，原问题仍可见，只有卡已过期。state 冗余条件已移除，所以 open 条件是唯一阻止旧摘要的判定。变异「R3丢open过滤」仅去掉此条件，目标就是该用例；不拿双点故障当单点证明。

## 3. visible.some(question seq)：当前 Host 不可独立触发，删除冗余条件

当前普通人工问题与授权问题只有 onComputeEvent(blocked) 和 raiseAuthorizationTx 两个写入点：均由 contact 发言者调用 appendMessageTx(doc.roomId)，卡与消息使用同一 roomId、同一 append 返回的 seq、同一事务。该函数没有「提问落到 DM、任务仍在群」回退逻辑。任务创建后当前宿主没有更改其 roomId 的入口。

roomView 的 visible 只排除 retracted，不排除 rewound。公开 messages.retract 总是以 user 身份追加，domain/adapter 要求原作者；不能撤回 contact 的问题。联系人 MindAction 没有撤回入口，rewind 留原消息并标 rewound，不等于 retract。R2-04c 走真实 service 拒绝用户撤回联系人问题（forbidden），同时确认任务仍 T4b、卡 open、消息仍可见、摘要不变。没有把受拒请求伪称成成功撤回。

故对有效当前卡，原 visible.some 恒真；本轮删除该冗余条件。审查举的 DM 回退是可能的未来入口，不是这份冻结 Host 当前存在的路径。任意直接 adapter 追加 contact-retract 虽可构造日志，但不等于当前 Host 提供该 API，本轮不把它当「宿主可达」来报。

## 排除而不冒充 kill

原 R2(state)、R4(visible)、R12(open+visible) 已不存在同样的两个冗余注入点；只保留并独立校准剩余 open 条件。R8 同房间同 seq 的 taskId 定序为等价故障，未计 kill。原始审查 REJECT、12 故障及历史数字保留于原报告、原证据，不重写为本轮通过。
