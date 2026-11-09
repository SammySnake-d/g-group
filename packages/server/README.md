# @g-group/server — 本地服务层(P0 闭环)

把领域状态机、SQLite 存储、联系人注意循环、Compute 适配器和承诺账本拼成一个宿主,按 `@g-group/api-contract` 对外。
不依赖 Electron 窗口:CLI、测试、Electron 主进程(或 UtilityProcess)都直接用它。

## 闭环

用户在私聊/群里发消息 → 机械送达每位成员联系人的注意循环(`kernel/attention.ts` 单飞调度)→ 一轮:内核 `assembleRound` 五块重拼 → `ContactMind` 提出动作 → 宿主校验、分配 action_id,与游标/账本/任务同一 SQLite 事务落盘 → 起 Compute(`adapter-cc-compute`)→ 语义事件回到联系人 → 汇报/交付回聊天 → 交付卡 → 用户确认。

## 接到 Electron

```ts
import { startServer } from "@g-group/server";
// mind: "fake" 规则替身 | "pi" 真实联系人;compute: "fake" 剧本 | "claude" 真实 Claude Code
const s = await startServer({ dataDir: app.getPath("userData"), mind: "fake", compute: "fake" });
s.bind(ipcMain); // gg:invoke / gg:subscribe / gg:unsubscribe / gg:event
app.on("before-quit", () => s.close());
```

更细的控制直接用 `new Host({...})` + `createService(host)` + `bindIpc(ipcMain, service)`。

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
# 群聊:建(或复用)群「项目群」,@ 小克派活,结束时打印群记录与 AC-03 发言者核对
node packages/server/src/cli.ts group --db /tmp/gg.db --mind pi --compute claude --cwd /tmp/gg-work --members 小克,小研 --to 小克 "@小克 帮我…"
# 代码任务(AC-22):每个任务一个 worktree,交付钉候选提交;--accept 豁免审查并验收,随即受控合入 main(主线已推进时跑 --verify 重验)
node packages/server/src/cli.ts dm --db /tmp/gg.db --compute claude --repo /path/repo.git --target main --verify "npm test" --accept "..."
```

## 验收编号对照(收据均为「未测·待审」,测试在 src/*.test.ts)

| 能力 | AC | 测试 |
|---|---|---|
| 私聊派活 → Compute → 进度 → 交付 → 确认 | AC-30 | host.test.ts、proof/e2e-claude-compute.txt |
| 群里 @ 联系人派活 → Compute → 联系人在群里转述;Compute 不上群公屏;没被 @ 的不接、同一条只一人接 | AC-03、AC-30 | drive.test.ts、group-claim.test.ts、proof/e2e-group-pi-claude.txt(修复前 run1) |
| 全员送达、单飞攒批、入库去重、发送前撤销重跑 | AC-31 ①–④ | host.test.ts、kernel/attention.test.ts |
| 接走即已读、群名单含联系人、表情不改已读 | AC-46 | host.test.ts、chat-ops.test.ts |
| 无跨厂商审查人时用户豁免、如实记 waived-by-user | AC-26 ⑤ | host.test.ts |
| 交付是普通消息并 @ 提出者;用户普通回复由联系人转成 verdict;沉默不通过;退回恢复原实例或携交接新开 | AC-56、AC-28 | delivery-plain.test.ts、proof/e2e-delivery-plain-pi-claude.txt |
| 承诺随来源登记、验收后以产物了结、用户撤销 | AC-40 ② | host.test.ts、chat-ops.test.ts |
| 五块重拼、前缀稳定、旧消息不进第 4 块 | AC-39、AC-40 ⑪ | host.test.ts、kernel/rounds.test.ts |
| 编辑撤回只追加、撤回原文不再出现 | AC-05、AC-08 | chat-ops.test.ts |
| cron + 时区定时、夏令时、错过只补一次 | AC-35 ① 宿主部分 | schedules.test.ts、kernel/cron.test.ts |
| 插件市场/安装/版本更新 | AC-35 ⑤ | plugins.test.ts |
| slash 命令唤醒能力 | AC-34 | slash.test.ts |
| 代码任务独立 worktree、交付钉候选提交、验收后受控合入(主线未变快进,已推进则合并重验,冲突/重验失败不动主线) | AC-22 | worktree.test.ts、proof/worktree-merge.txt |
| 交付时可读工件按 sha256 快照、卡片钉 hash、artifacts.get 点开 hash 一致、改工作区不改卡片、重发不生成第二个文件 | AC-04 | artifacts.test.ts、proof/artifacts.txt |

## 还没接的

- `tasks.answer`(Compute 受阻提问 T4b)、跨厂商审查联系人自动送审、退回时恢复原 Compute 的条件 A/B 判定
- 插件代码执行(要进程隔离)、从 URL 安装
- 工件:没配代码仓时按「Compute 启动后改过的可读文件」收集,工作目录被别的任务同时写会混进来;Computer Use 缩略图未接
- 代码任务的合入状态在 R-Worktree 资源上(W2–W6),任务状态机还没有 T6 Integrating:审查豁免后任务先到 T8a,合入成功才记 T8 验收;任务取消/失败时工作树不自动归档
- 关窗口/退出时在途任务的去留(技术栈文档要求先由用户确认)
