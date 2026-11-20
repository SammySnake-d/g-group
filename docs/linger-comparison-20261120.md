# Linger 对照：联系人 @ 与等待

对照版本是 simplexai-labs/linger commit 45d0a98cf8ff95814bbfe968ff3cc77b7effe238，源码副本在 /tmp/gg-agy-linger-ref-20261120。

## 它如何让 @ 生效

- 消息创建时把结构化 mentioned_actor_ids 和 message.created 事件放进同一持久化路径。AppendMessageCreated 会把 Room 序号和被 @ 的 Actor 一起写入消息事件。
- agent_inbox_message_disposition 先处理取消消息、Agent 自己的消息和运行上下文，再按 message.mentioned 返回 notify。配置了 receives_all_messages 的 Agent 会收到非 Thread 的普通 Room 消息，Thread 仍按提及目标筛选。
- team.md 用 receive_from、report_to 描述团队关系。发布前 Validate 检查 orchestrator、成员和引用的 Actor 是否是当前 Room 成员。

## 它如何处理等待与死锁

- Agent 生命周期使用 ContextAdmission 串行化 admission 操作。注释明确要求不嵌套 Agent 或 runContext lifecycle lock，避免排队的 admission 和持锁的 stop 路径互相等待。
- Thread 发布按固定顺序锁父 Room 与 Thread，避免同一事务以不同顺序获取 Room 锁。
- 这次对照的提及、团队文档和生命周期路径没有发现类似本项目原先的“同一因果根最多 4 次”或“无人回复 5 分钟最多 2 条”的通用对话限额。这个结论只覆盖已读路径，不能替代对 Linger 其他运行时的全量证明。

## 对本片的取舍

本项目保留消息幂等、相同正文去重、单发送者短窗口和真实三方环回熔断。默认同根唤醒次数与无人回复条数不再设值。互 @ 是否自然结束由真实模型验收记录，出现停不下来后再新增针对性处理。
