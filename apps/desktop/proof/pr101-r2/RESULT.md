# PR #101 R2 作者返修与打包实点

桌面返修已实现，等待独立第二轮审查；打包 P0 指定群聊回执仍未通过，不能声明整链完成。未改 packages，未接触 /private/tmp/gg-loop，未合并。

## 版本

- 返修起点：90284d7c（R1 审查提交，报告保持原样）。
- 首轮红提交：928e4ff9。
- 校准后红提交：8316654b（只提交最终测试，产品仍是原实现）。最终七个 P0 测试体与绿色版本一致；补做对照明确不证明历史先后。
- 实现：33b517f5；打包运行源码：bdde490c。之后证据、文档和实点脚本变化不改 src / electron 的字节，package-manifest.json 逐文件绑定。

## 完成的桌面变化

1. 设置页使用真实网关 /v1/models，保留当前默认/联系人模型；错误时保留当前值、禁用选择并显示原因。复用 #102 的 setup.models IPC，未把 #102 整支或其他 P1 并入。
2. 说话模型独立保存，成功回包后再显示已保存；正常重启恢复 SQLite 里已保存的默认值。网关目录不声明 Harness 兼容性时 Compute 保留当前设置，不把演示能力当真能力。
3. 粘贴、选图、截图进入可逐张删除的待发区；按会话存于客户端 profile，切会话/重启不丢；图文一次发送，纯图也可发送。失败保留草稿，回包只清本次提交内容。
4. 聊天显示真缩略图，点击 Astryx Dialog 原地放大并关闭返回；使用 FileInput / AspectRatio / ClickableCard / Selector / Dialog / IconButton；预览无入退场动画。
5. 原 cron 菜单遗漏宿主内置命令，已合并原始合同并经结构化 command 执行 /remind。原 pano 用例要求宿主没有提供的步骤计划，改为严格断言实际摘要“最后进展「已开始」”，并保留停滞态、时长与全景断言。

## 直接观察

| 检查 | 结果 | 原始文件 |
|---|---|---|
| R1 两条 Electron 原失败复现 | 2/2 失败 | baseline-d02.txt |
| 最终 P0 同体原实现对照 | 7/7 失败，退出1 | final-red.txt |
| 最终 P0 + 原D02 + 原截图/文件回归 | 15/15，退出0 | p0-green.txt |
| 完整桌面首跑 | 173/182；全部36条Electron通过；退出1 | desktop-regression.txt |
| 原实现渲染定点 | 6/7；头像一项失败 | inherited-baseline.txt |
| 最终受影响渲染定点 | 20/21；一项Chrome页面关闭 | renderer-recheck.txt |
| 上一项单独重跑 | 1/1，退出0 | renderer-last-recheck.txt |
| 结构 / 类型 / 构建 | 退出0 | structure-final.txt / build-package.txt |
| 图片定点变异 | 4/4按行为断言检出 | mutants/result.json |
| 打包 | 首次下载中断；复用匹配的本地39.8.10后退出0 | pack.txt / pack-local.txt |
| 打包P0实点（最终口径） | 7/8，指定对象群聊未通过；页面错误0 | packaged-target/result.json |

完整套件里的失败含 macOS Chrome CVDisplayLink / 页面关闭、头像跟随光标的不稳定断言。定点补跑不能抹去首跑非零，也不作“全量绿”签字。没有删测试、加skip或降低时长/状态断言。

## 打包真实模型与边界

真实推理始终使用 fengshao1227/deepseek-v4.1-flash，经127.0.0.1:3425，未使用hy4。私聊实点约64秒收到DM_OK1。图片待发、删除、切会话/重启、图文一次发送、2640×1690原图放大均通过，图片打开截图在 packaged-target/07a-聊天原地放大.png。

网关目录首读55、打包时62项；同供应方只有用户指定的一个ID。另一个模型的保存/重启/新联系人路径以受控网关测过；未生成其他真实模型回复。

初版群聊步骤只等待任意回复，未被@的小克先回复GRP_OK_2，因此该8/8是错误的成功口径。已修脚本为校验小林contactId，保留原结果，复用同一profile与前七步补验：用户只@小林，360秒后没有小林的TARGET_OK_3，只有小克回复；SQLite显示小林回合已done。最终记7/8，详见 packaged-target/database-summary.json 与 gg.db（独立测试数据，无令牌，完整性校验通过）。

后端事项已各建一件：#106群聊点名/唤醒优先、#107计时分解、#108模型收图。本PR只改桌面，图片可见不等于模型已收到原图。

## 复跑

在 apps/desktop 目录：

```sh
npm run build
node verify/serial.mjs npx playwright test --project=electron e2e/pr101-p0.electron.spec.ts e2e/native-files.electron.spec.ts e2e/parity-r2-cron.electron.spec.ts e2e/parity-r2-pano.electron.spec.ts
node verify/serial.mjs node scripts/pack-mac.mjs --skip-build
node verify/serial.mjs node scripts/pr101-p0-walk.mjs <打包二进制> <输出目录> <现有gg-config.json>
```

实点令牌只从既有本地配置所有者读入隔离profile，进程结束删除本脚本生成的含令牌配置。脚本/日志/截图/脱敏数据库随分支提交，安装包路径与SHA-256见package-manifest.json。
