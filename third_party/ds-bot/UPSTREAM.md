# DS-Bot 桌面窗口来源与修改说明

- 上游：<https://github.com/Fei2411/DS-Bot>
- 冻结提交：`a66cc737cfb6c3d8a2597e748cded6cab1206dd3`
- 许可：Apache-2.0；原版 `LICENSE`、`NOTICE` 完整保留并随安装包分发。
- 原样导入：`apps/desktop/src/dsbot-base/upstream/app/ui/`、
  `ds-bot/src/client/`、`ds-bot/src/shared/`，以及宿主 `app/src/` 的
  fonts / macos / material / page-card 四份 CSS。
- `SOURCE-MANIFEST.json` 记录全部 120 个源文件的原始 SHA-256。
  `node apps/desktop/verify/dsbot-source-integrity.mjs` 核对原始字节。

2026-11-17，g-group 贡献者重新接入完整上游窗口，不再使用旧版重写的
`DsBotApp.tsx`、自写 `styles.css`、简化的 Markdown/用户消息/widget 替身。
这些上游文件已恢复为原始字节；旧实现留在 Git 历史与源码中，不在运行入口。

所有运行时修改显式集中在 `apps/desktop/vite.config.ts`：

1. 按上游 `app/vite.config.js` 的方式，将 `./dsh-primitives.js` 替为
   窗口自身的 `app/ui/src/primitives.js`，使用原版 react-markdown + remark-gfm。
2. `ds-bot/src/client/api.js` 的 `call` 与 `app/ui/src/api.js` 的 `openFeed`
   只接到 `src/dsbot/bridge.ts`；业务数据、配置和令牌仍由 g-group 宿主持有。
3. 产品名 `DS Bot` 替为 `g-group`；默认鲸鱼品牌替为原版几何 ring，
   avatar picker 不提供鲸鱼品牌。供应商/模型名称作为真实配置元数据保留。
4. 原版独立窗口 `Chat` 的 history owner 从 `bot?.id` 扩展为
   `bot?.id ?? roster.roomsById[sessionId]?.id`，使真实群房间也能读取历史。
   不将群塞进联系人表，不新增虚构“总管”。
5. 保留原版 composer/ChatRows，只插入附件待发区、隐藏 file input、粘贴处理
   和附件参数传递。文件卡片复用原版 `user-message.js` 的 `Attachments` 与
   `USER_MESSAGE_CSS`；图片查看复用上游依赖的 `ImageLightbox`。
   音频条是新增的原生 `<audio controls>`。接缝从同一文件导出未公开的
   `Attachments`，但磁盘上的上游源文件不变。
6. 保留原版 NewChat 的选人器、token 和建群按钮；选择普通成员，移除
   admin-first 流程，不发送 admin/greet 参数，不给任何联系人虚构管理权限。

`src/dsbot/attachments.js` 是上述最小附件增量，空待发区不改变原版布局。
单文件目前限制 16 MiB，因为既有 `files.read` 最多完整读取 16 MiB；
超过时拒绝添加，读取返回 truncated 时拒绝打开或下载，避免交付截断文件。
后端暂未识别的 WAV 等音频 MIME 只在浏览器展示层按标准扩展名选择解码器，
不更改后端附件元数据。`index.html` CSP 允许本地 blob 音频与上游同样的
HTTPS Markdown 图片，不开放脚本执行或任意文件路径。

`src/main.tsx` 只加载这套窗口和上游宿主 CSS；不加载旧 g-group UI 全局样式、
Astryx 或 AnimateUI wrapper。Electron 沙箱、IPC、真实后端及合同继续沿用
g-group，不引入 DS-Bot/DSH 后端引擎。

`src/dsbot/chat-message.ts` 负责纯消息投影：失败卡 `title/body` 留在原版
Markdown 气泡，不丢弃错误原文；不以界面超时推定后端轮次失败。失败卡动作
与重试进度尚未接入，不能将正文可见当作按钮可用。

原 g-group Electron 壳一并拒绝了原版代码块的 `navigator.clipboard.writeText`。
`electron/renderer-permissions.ts` 只允许聚焦的本应用主页面进行
`clipboard-sanitized-write`；剪贴板读取、子框架、外部页面、后台窗口和其他
系统权限仍拒绝。上游窗口 primitives 原始字节不变。

视觉基准使用运行中的未修改上游窗口，测试数据只存在 `verify/` 截图夹具；
不进入产品运行路径。原版窗口本身只有文本 composer，附件待发与原生音频条
是本轮明确新增的接缝，不冒称为上游已有的窗口能力。
