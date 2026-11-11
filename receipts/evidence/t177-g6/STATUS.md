# T-177 G6 运行状态(2026-11-12 04:05 CST)

- 组①–④(含预取消融)的**规则替身**跑批完成:5 组 × 17 题 × 1 次,原始记录在 `raw.tgz`,报告在 `report.md`。
- **真实模型**:用户 dm#2822 批准强 `fnqtz/claude-opus-5-5`、弱 `workbuddy-ai/hy4free`(本机 mirasim 网关)。
  - 强模型:上游不可用 —— 每次请求 ~36 秒后网关回 `fnqtz: No available accounts: no available accounts (503: you can retry your request)`(HTTP 200 + SSE error 事件)。
    已按 15 分钟一次探测最多 12 次等待恢复(记录见 `probe-strong.log`);恢复即自动开跑。
  - 弱模型:`hy4free` 可跑,正在跑(一次一个调用);记录落在 `runs/real/`,逐题落盘,断了可续。
- 事故与处置:
  1. 强模型第一次开跑时 17 题全被这条上游错误打红(每道 4 次调用),按「网关/上游不可用不算测量结果」处理:记录移入 `incident/` 并保留原始日志,不进分母;
     runner 相应加了「探测按正文判定」与「失败调用记下上游原文」。
  2. runner 的网关判活一度因一次连接失败停掉整批:已改成收到任何 HTTP 回复就算在、连试两次才判不在(变异 RU12)。
  3. box4 重活首次因 DNS 解析失败拿到空检出:改成从 bundle 取对象并核对 HEAD 后才跑。
