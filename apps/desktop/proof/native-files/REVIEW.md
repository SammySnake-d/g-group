# PR #75 收尾审查说明（T-186）

PR #75 仍叠在 PR #59 的 `feat/desktop-files-provenance` 上；未合并 dev/integration、未发布 Release。PR #59 不因本轮作者验证自动通过。

原作者 Claude；本轮实现与作者侧验证由 Astra/Codex 接手。按本轮任务安排，交回 Claude 方向审查与 hy4 独立审 PR；作者不写 approve，不代独立审查人跑 reviewed_hash。

## 实现变化

1. 已合入聊天、群资料/群管理、Compute/失败卡/文件列表三块原型对照分支。
2. `ggApp.getPathForFile(File)` 由 preload 的 Electron webUtils 提供；只返回 File 的原路径，内存 File 返回空串。磁盘文件走已有 `attachments.add`，内存文件走已有 `attachments.upload`。
3. `window.capture` 只截发起调用的应用主窗口。当前窗口截图成为真实 PNG File，沿用附件发送，不枚举桌面，不引入系统录屏权限。
4. 同引用连续回复不重复头像；原来的完成回合、待答回合、作者变化和时间分界仍在。
5. 大截图在真机暴露 IPC 限额冲突。仅附件上传按 API schema 的限额放行，普通方法仍限制 256 KiB。来源、纯 JSON、方法白名单、后端 schema 都保留。

## 验证与审查重点

- `RESULT.md` 是按提交归属的结果索引；原先的 app-shell/merged-green.txt 对应更旧提交，不代表本轮。
- `red.txt` / `grouping-red.txt` / `budget-red.txt` / `packaged-upload-red.txt` 为实际失败证据；`green.txt` / `remaining-green.txt` / `budget-green.txt` 为分层通过结果。
- `packaged/` 保存最终包清单、真机步骤、截图与原型并排图，不提交验收凭据、用户数据库或安装包大文件。
- 重点复核：上传专属限额是否只作用于附件；跨来源与普通消息限额是否保持；File 获取及截图失败路径；连续引用的回合分界；打包结果是否绑定同一份源码与构建摘要。
- 真实模型最小闭环已在前一包完成，两次任务的结果不重跑；限额修复后的最终包继续验证启动、历史任务/成员/交付持久化、大截图与磁盘文件发送。首次截图失败记录保留，不把那次整体运行写成通过。
- 自动更新 0.1.0→0.1.1 原本机通过记录沿用。未进行 GitHub Release 发布、Developer ID 公证、dmg 内直接更新分支的真机验收。

## 验收边界

这里只完成已授权最小闭环范围。资产、插件市场接线、记忆、Helper 与进展全景尚未全部接真实数据；AC-34 全量仍未测。AC-01/AC-03 的正式判据与埋雷标定未补全，不借这次成功改成全部通过。

需求基线已核对远端 `docs/dev-handbook` 的 v3.31 审查稿；该稿最后新增的是 D30/U102/AC-59 安装与自动更新，未改变本次闭环职责和原型边界。
