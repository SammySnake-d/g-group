# DS-Bot 前端底座 · g-group 第一版状态

更新：2026-11-16

当前入口已经切换为 DS-Bot 冻结提交 `a66cc737` 的实际 client 组件：
`TeamSidebar`、`HeaderPill`、`ChatRows`/`GroupMessage`、头像 marks、Composer
原语和上游 CSS 均从 `apps/desktop/src/dsbot-base/upstream/` 渲染；
`DsBotApp.tsx` 只做 g-group 数据映射和动作适配。旧的 g-group `Rail/ListPane/MainPane`
不再组装主对话面。

## 已落到真实 g-group 后端接线的能力

| 能力 | 状态 | 证据/入口 |
|---|---|---|
| 联系人列表、添加联系人、打开私聊 | 可用 | `contacts.*`、`rooms.openDm`；`e2e/backend.electron.spec.ts` 真实 Electron 宿主用例通过 |
| 建群、拉成员、群会话 | 可用 | `rooms.createGroup`、`rooms.addMembers`、`rooms.update`；桌面工作台和群侧栏仍走现有 wire |
| 文本消息、事件流、联系人回复、Compute 进度 | 可用 | `messages.send`、事件订阅；backend Electron 闭环用例通过（本用例使用 fake mind/compute，仅证明真实宿主链路） |
| API 配置、模型目录读取、保存模型配置 | 可用 | `SetupForm` 的 `setup.models`/`setup.save`；设置页和 `settings.*`/`models.*` 接线保留 |
| 文件/图片待发区、删除、点发送上传 | 可用 | `Composer` 待发区；`attachments.add`/`attachments.upload` → `messages.send`；`native-files.electron.spec.ts` 3/3 通过 |
| 发后附件卡、重启后仍可见 | 可用 | native-files 真实 Electron 用例覆盖本地路径、截图、重启回读 |
| 公告、置顶、群资料、联系人工作台、Compute 详情 | 可用/沿用 | 既有 `notices.ts`、`rooms.ts`、`Workbench`、`compute-actions.ts`；本轮只改聊天壳，不改领域协议 |

## 仍关着或本轮没有冒充通过的能力

| 能力 | 状态 | 原因 |
|---|---|---|
| fengshao 真实模型实点 | 本轮未执行 | 目标模型已冻结为 `fengshao1227/deepseek-v4.1-flash`（本机模型目录/能力配置）；本轮验证使用真实宿主但 `GG_MIND=fake`，没有把 fake 结果写成真实模型通过 |
| agent、多协议端点的完整目录适配 | 部分可用 | 设置层支持网关模型目录和模型 ID；不同协议的 provider 适配需在后端线继续，前端不自行改后端分支 |
| 记忆、Helper、进展全景的真实数据闭环 | 关着/待后端线 | 既有桌面实现保留入口，但不把演示数据当真实能力；按现有 receipts 的未测项继续收口 |
| DS-Bot 专属 DSH 插件/账户/浏览器/邮箱/手机连接 | 不带入 | 与 g-group 领域无关，已从底座裁掉 |

## 真实模型验收约束

真实模型验收只用 `fengshao1227/deepseek-v4.1-flash`。本轮没有读取或写出任何令牌；接入模型时从桌面“模型接入”读取目录并选择该 ID，不能静默替换成其他供应商或 `hy4`。
