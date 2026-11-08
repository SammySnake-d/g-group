# @g-group/server — 本地服务层(P0 闭环)

把领域状态机、SQLite 存储、联系人注意循环、Compute 适配器和承诺账本拼成一个宿主,按 `@g-group/api-contract` 对外。
不依赖 Electron 窗口:CLI、测试、Electron 主进程(或 UtilityProcess)都直接用它。

## 闭环

用户在私聊/群里发消息 → 机械送达每位成员联系人的注意循环(`kernel/attention.ts` 单飞调度)→ 一轮:内核 `assembleRound` 五块重拼 → `ContactMind` 提出动作 → 宿主校验、分配 action_id,与游标/账本/任务同一 SQLite 事务落盘 → 起 Compute(`adapter-cc-compute`)→ 语义事件回到联系人 → 汇报/交付回聊天 → 交付卡 → 用户确认。

## 接到 Electron

```ts
import { Host, createService, bindIpc } from "@g-group/server";
const host = new Host({ file: path.join(app.getPath("userData"), "gg.db"), mind, compute, catalogFile });
bindIpc(ipcMain, createService(host)); // gg:invoke / gg:subscribe / gg:unsubscribe / gg:event
```

preload 只暴露 `window.gg.invoke(method, params)` 与 `window.gg.subscribe(listener, { sinceEventSeq })`,类型见 `@g-group/api-contract` 的 `GGroupBridge`。

## CLI

```sh
# 规则替身脑子 + 假 Compute(不连模型)
node packages/server/src/cli.ts dm --db /tmp/gg.db "帮我写 hello.txt"
# 真实 Claude Code Compute(网关与模型走 ANTHROPIC_* 环境变量)
node packages/server/src/cli.ts dm --db /tmp/gg.db --compute claude --cwd /tmp/gg-work "帮我在当前目录写 hello.txt"
# 真实联系人脑子(需 @g-group/adapter-pi-contact)
node packages/server/src/cli.ts dm --db /tmp/gg.db --mind pi --compute claude --cwd /tmp/gg-work "..."
node packages/server/src/cli.ts log --db /tmp/gg.db
```

## 验收编号对照(收据均为「未测·待审」,测试在 src/*.test.ts)

| 能力 | AC | 测试 |
|---|---|---|
| 私聊派活 → Compute → 进度 → 交付 → 确认 | AC-30 | host.test.ts、proof/e2e-claude-compute.txt |
| 全员送达、单飞攒批、入库去重、发送前撤销重跑 | AC-31 ①–④ | host.test.ts、kernel/attention.test.ts |
| 接走即已读、群名单含联系人、表情不改已读 | AC-46 | host.test.ts、chat-ops.test.ts |
| 无跨厂商审查人时用户豁免、如实记 waived-by-user | AC-26 ⑤ | host.test.ts |
| 承诺随来源登记、验收后以产物了结、用户撤销 | AC-40 ② | host.test.ts、chat-ops.test.ts |
| 五块重拼、前缀稳定、旧消息不进第 4 块 | AC-39、AC-40 ⑪ | host.test.ts、kernel/rounds.test.ts |
| 编辑撤回只追加、撤回原文不再出现 | AC-05、AC-08 | chat-ops.test.ts |
| cron + 时区定时、夏令时、错过只补一次 | AC-35 ① 宿主部分 | schedules.test.ts、kernel/cron.test.ts |
| 插件市场/安装/版本更新 | AC-35 ⑤ | plugins.test.ts |
| slash 命令唤醒能力 | AC-34 | slash.test.ts |

## 还没接的

- `tasks.answer`(Compute 受阻提问 T4b)、跨厂商审查联系人自动送审、退回时恢复原 Compute 的条件 A/B 判定
- 插件代码执行(要进程隔离)、从 URL 安装
- 关窗口/退出时在途任务的去留(技术栈文档要求先由用户确认)
