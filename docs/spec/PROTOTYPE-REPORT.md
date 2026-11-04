# Prototype 实测报告(S-1 / S-4,2026-11-05)

环境:pi-agent-core / pi-ai 1.5.0(`@earendil-works/*`,即原 `@mariozechner/pi-*` 改名后的版本);Claude Code 2.1.316;codex-cli 0.166.0;Node 22.22。联系人模型走本机 Anthropic 兼容中转(claude-opus-5-5)。

## 1. pi 能否接管每一轮上下文 —— 通过
- 脚本:`t1-context-takeover.mjs`,原始请求:`out/t1-requests.json`,结论:`out/t1-result.json`。
- 机制:`Agent({ prepareRequest })` 在**每次**发给 provider 的请求前(包括同一轮里工具往返后的第二次请求)回调,返回的 `context.messages` 整体替换本次请求内容。
- 实测:agent 内部历史里埋入旧事实 BANANA,宿主拼装的三段式(系统+记忆 / 本轮窗口 / 当前输入)写 KIWI。3 轮 4 次真实请求,provider 收到的 messages 与宿主拼装逐字节一致(去掉 timestamp 后比对),BANANA 0 次泄漏,模型 3 次都答 KIWI。
- 注意:pi 1.5 的系统提示和工具声明放在 transcript 的 system 消息里(`toolsAdded`),宿主拼装时要自己带上工具声明。

## 2. pi 能否注册自定义工具并接收异步回填 —— 通过
- 脚本:`t2-async-tool.mjs`,结论:`out/t2-result.json`。
- 机制:`dispatch_compute` 作为普通 AgentTool 注册,`execute` 立即返回 job id;后台事件进宿主收件箱后按 agent 状态分两路:
  - agent 空闲 → `agent.prompt(<compute_event>)` 唤醒发言;
  - agent 正在说话 → `agent.steer(<compute_event>)`,当前回答结束后自动注入下一次请求。
- 实测两件活、4 个事件(阶段完成 + 完成各 2):空闲唤醒 1 次、说话中 steer 3 次,4 个事件都被联系人转述出来,且没有打断正在输出的回答。
- 注意:回填消息以 user 角色进上下文,正式实现要在宿主拼装时把它归到段 3 的"事件"区并去重。

## 3. Compute 能否通过汇报工具产出结构化"阶段完成"事件 —— 通过(带条件)
- 脚本:`t3-report-progress.sh` + 宿主汇报 MCP `report-mcp.mjs`(只暴露 `report_progress`,schema 校验后写 JSONL)。原始记录:`out/t3/<run>/events.jsonl`、`stream.jsonl`。
- 场景与结果(每条事件都通过 schema 校验,0 条被拒收):

| Harness | 正常三阶段(4 次) | 需授权受阻(1 次) |
|---|---|---|
| Claude Code | 4/4 有 started 和 completed;milestone 报了 2,1,2,2 次(第 3 阶段都并进 completed) | 报 blocked 并停下,带 needs |
| Codex | 4/4 有 started 和 completed;milestone 报了 3,3,3,2 次 | 报 blocked 并停下,带 needs |

- 结论:开始 / 受阻 / 完成三类事件 10/10 可靠;"阶段完成"会被模型漏报(最后一个阶段常被并进 completed,偶尔中间阶段也合并)。正式实现不能把 milestone 次数当进度真值:宿主应以 completed 为准补齐未报阶段,或在 completed 时校验计划阶段数并标"阶段未逐一汇报"。
- 开销:CC 每次约 14k 输入 token、$0.36–0.54、27–145 秒;Codex 每次 18 万–124 万输入 token(大部分命中缓存)、126–474 秒。汇报工具本身每次调用只多一个很小的工具往返。

## 结论
三项都实测跑通,技术栈可以定案:联系人层用 pi-agent-core(prepareRequest 接管上下文 + 自定义工具 + steer/prompt 回填);Compute 层用 CC / Codex 并挂宿主 MCP `report_progress` 产生语义事件。正式实现需要处理的两点:回填事件的分段去重、milestone 漏报的补齐规则。
