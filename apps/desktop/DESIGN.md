# g-group desktop visual memory

## Product job

This screen lets a user choose a contact or group, read the current conversation,
and send the next message or attachment.

## Direction

2026-11-17：以上用户任务不变，旧版“参考空间语言后重画”的路线作废。
直接运行冻结 DS-Bot 提交 `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`
的 `app/ui` 桌面窗口、完整 client、11 组样式、窗口 primitives/Markdown、
宿主字体与平台样式。`DsBotApp.tsx`、旧自写 `styles.css`、旧 Astryx/AnimateUI
包装均退出运行入口；不另画侧栏、主卡、聊天气泡、模型设置和输入区。

g-group 只在 `call` / `openFeed` 传输边界提供真实联系人、群、消息、附件与
单一模型网关数据。主卡绑定第一位真实联系人，原版 sidebar 按 ID 排重，
`mainBotIds=[]`，不引入“总管”权限或新的领域对象。产品名替为 g-group，
鲸鱼品牌默认替为上游几何 ring。普通消息和空输入区保留原版渲染树和布局样式；
只有附件待发/展示与去除不存在的群管理员语义是显式增量接缝，详见 UPSTREAM.md。

视觉门以同尺寸、中文、同一组数据的实际原版窗口为基准，逐项人工看并排图。
不以组件名、侧栏宽度、结构脚本或 mock 成功替代打包版真实模型闭环。

## Information depth

- **L0 overview:** list rows show the contact/group name, latest message and
  minimum unread/running state.
- **L1 focus:** selecting a row opens the same chat object; the title pill and
  side panel expose the current conversation's details without losing context.
- **L2 manage:** settings, contact workbench and group tabs remain page/drawer
  surfaces reached from explicit controls.
- **L3 execute:** the original composer is the primary action surface for text,
  @mentions and attachments. Unwired DSH/Compute controls refuse explicitly;
  their visible entry points are not evidence of completed integration.

## Interaction invariants

1. A real backend state or an honest loading/empty/error state is shown; no new
   visual seed data is introduced by this adaptation.
2. Every list row that represents a conversation remains selectable through the
   upstream `actions.openSession` path.
3. The centered title pill is still the existing chat/group details action.
4. The original composer and dialogs call the same g-group transport adapter;
   unsupported capabilities return an honest empty state or refusal, never a
   locally fabricated success.
5. Upstream attribution ships in third-party notices and the secondary About
   surface, outside the primary chat flow.

## 信息架构核对（本轮）

| 对象 | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| 联系人/群 | 原版 sidebar 摘要 | 同一路径打开聊天 | 原版设置/成员面板 | 同一输入区发送 |
| API/模型 | 缺配置时原版提示 | 模型选择 | 原版 Providers 页面 | 真实获取/保存 |
| 错误/证据 | 仅当前操作错误 | 可重试 toast | About/仓库验收记录 | 不占聊天主流程 |

新增附件动作仍留在 L3 同一 composer；待发可移除，失败保留草稿。已发送图片
在 L1 用原版 lightbox 打开并按 Escape 返回，文件卡点击完整下载，音频条就地播放。
同一会话的普通消息和附件继续由一次 ChatRows 分组，不能重新引入每条消息一条时间线。

首屏有后端时显示可操作联系人/群，无后端时保留诚实空态/错误；加载、失败与
缺模型态沿用原版。所有测试夹具仅在 verify 脚本，不进入产品运行时。

模型失败属于当前会话结果：后端 failure card 的标题与正文留在原版气泡里，
不隐藏错误原文，也不另外画报告卡。失败卡动作和 retry.updated 进度尚未接入；
不能把可见正文当作重试按钮可用。正在回复状态只读真实 contact.activity，
不以界面计时器推定后端轮次已失败。
