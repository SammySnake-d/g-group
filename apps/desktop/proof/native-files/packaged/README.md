# macOS 打包真机验收

最终产品源码：52412af151804e9a70110f0e2b388e55ab1cdaac。安装包摘要、签名及更新清单校验见 manifest.json。二进制由 dmg 挂载后 ditto 到独立 Applications 目录，未替换用户 /Applications 下的旧版。

真实模型使用既有网关配置 owner ~/.claude/settings.json；联系人与 Compute 使用 workbuddy-ai/deepseek-v4.1-flash-sg（Compute 为本机 Claude Code harness）。未提交凭据或 userdata。

1. first-model-loop-steps.txt：46abb343 打包版首次启动、界面接模型、建联系人、私聊派活、Compute完成/联系人交付、建群拉人、群里派活/完成，两份输出精确匹配。追加截图失败，因此该次整体不记通过。
2. 52412af1 修复附件 IPC 限额。final-resume-steps.txt：换最终 dmg 安装后，复用上轮真实任务数据的副本，确认两次任务/交付/文件与4人群完整保留；301159 字节 PNG 发送落盘且消息经后端确认；磁盘文件发送通过；页面错误0。
3. 最终续验第一次因测试 has 定位器错误未能选中已有 trail，不是产品失败。修正定位器后 r2 通过；原失败现场留在交付目录 accept-packaged-52412af1。
4. compare-*.png 左为既有原型、右为最终打包版实际画面，保留纸墨柿、消息优先、Compute 只读与当前交付样式。

已绿的自动更新原记录沿用；未声称最终包再跑 0.1.0→0.1.1。尚未发布 GitHub Release，临时签名未公证。
