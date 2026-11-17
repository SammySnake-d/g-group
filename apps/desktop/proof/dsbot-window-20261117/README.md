# DS-Bot 原版窗口接入 g-group：本轮验收

## 结论与交付

原版窗口和聊天/附件接线已落地；**真实 fengshao 回复的 P0 硬门仍未通过**。
没有使用其他供应商，没有把接线替身当真实模型，没有修改后端。

- 工作分支：`feat/ds-bot-frontend-20261116`，接手基线 `4c569c0d`。
- PR：<https://github.com/SammySnake-d/g-group/pull/118>，本轮不合并、不转 ready。
- 安装 ZIP：`apps/desktop/release/g-group-0.1.0-dsbot.20261117.7-arm64-mac.zip`。
- macOS **Apple Silicon / arm64**；99,127,635 bytes，小于 100 MB 附件上限。
- ZIP SHA-256：`12c6af56fcd1e354d6ed8b188fb06729b0eba9d42604e2e5c74b7add65799f92`。
- ASAR SHA-256：`0f8c9852a0a68130a9da7259119c72b9961264980fe7d9afa9ecb5264c785b76`。
- 从实际 ZIP 解出应用后验证，非仅运行工作目录里的 `.app`。
- `codesign --verify --deep --strict` 通过；临时签名，**未公证**，不宣称已消除 Gatekeeper 提示。
- 包内 LICENSE、NOTICE、SOURCE-MANIFEST、UPSTREAM 已与源树逐字节核对，见 `release.json`。

## 原版外观硬门

基准是实际跑起来的冻结上游 `a66cc737cfb6c3d8a2597e748cded6cab1206dd3`，
不是文档截图或凭记忆重画。原样导入的 120 个文件通过 SHA-256 检查，完整
`app/ui/src/main.js`、11 组样式、窗口 primitives 和四份宿主 CSS 进入真实入口。
旧 `DsBotApp.tsx`、手写 `styles.css`、简化 Markdown 与 Astryx/AnimateUI 包装不在渲染路径。

同一 **1200×800、中文、亮色、固定视觉数据**：一位主联系人、两位联系人、一个群，
含列表、代码和 Markdown 图片。`visual/side-by-side.png` 左原版、右候选。
最终 R7 并排图与已人工看过的 R6 图逐字节一致；最终附件/错误截图也已人工看过。

逐项结果：侧栏、主卡、列表行、头像、标题胶囊、单条时间线、双方气泡底色/字色、
Markdown 列表、输入区按钮、中文文案，在这组夹具下未见非品牌差异。
品牌替换为 g-group；图片待发区、文件/音频展示是明确增量，不冒称原版窗口已有。
这不证明深色、所有尺寸和全部设置面板均已视觉验收。

## 能用 / 已有实点

| 能力 | 实际证据与限制 |
|---|---|
| 配置 API、获取目录、选择并保存模型 | 实际安装包原版 Providers 页面，从本机真实网关目录选 `fengshao1227/deepseek-v4.1-flash`；同一窗口接入宿主，重启后保留；token 仅进既有 AppConfig，权限 600 |
| 加联系人、私聊、建群、群聊 @ | 原版表单与真实 IPC/宿主/SQLite；回复**仅 GG_MIND=fake 接线控制**，不算真模型 P0。群成员平等，没有虚构管理员；主卡联系人不重复 |
| 粘贴图片 | macOS 原生剪贴板 + Command+V → 待发 → 发送 → 原版 ImageLightbox → Escape；发送后乐观行清零、只留一张图片 |
| 文件卡片与下载 | 使用原版 Attachments；原生 Electron 下载完成事件，43 字节逐字/SHA 核对，不以“点了按钮”代替成功 |
| 语音条 | 1 秒 WAV，真实播放/暂停、duration=1；当前是原生 audio controls，未实现录音 |
| Markdown/代码 | 实际列表与代码块；点原版复制按钮后读取原生剪贴板比对；页面读取剪贴板仍被拒绝 |
| 持久化 | 重启实际交付包后联系人、群与聊天记录仍可读取；所有测试使用隔离 profile，不改用户现有数据 |
| 错误原因 | 本地 SSE error → 打包 pi → 真实宿主 → IPC → 原版气泡，11102 原文可见，台账 failed，联系人 idle；这不是在线模型可用性测试 |

`packaged/receipt.json` 的 13 项检查全部完成，`errors=[]`；
`sse/packaged-receipt.json` 同一 ASAR，`errors=[]`。
临时 profile 的真实网关凭据已在 finally 删除并再次检查，不写入证据/仓库。

## 明确还关着 / 未验收

1. **真模型私聊与群聊回复。** 本机配置目录查实的唯一指定 ID 是
   `fengshao1227/deepseek-v4.1-flash`。本轮唯一生成探针 HTTP 200、1 条 keepalive、
   4.5 秒结束无文字，见 `model-probe.json`。
   协调者在本线程 #4091 补充其直连三次实测：12–20 秒后 SSE `model_unavailable`、
   上游 code 11102 / `model [hy4-flash-free] service info not found`。
   这是协调者提供的在线证据，不是本轮新测；错误里的 hy4 是上游原文，**未把所选模型换成 hy4**。
2. 失败卡按钮、自动重试进度，群成员增删；部分联系人/群设置仅合同接线，尚未逐项 UI 实点。
   不支持的写操作明确拒绝，不显示伪保存成功。
3. DSH 专属 Agent/能力、手机连接、secret、计划任务、用量、文件夹/工作空间、Compute 工作台等；
   能力目录为空或明确拒绝，不拿演示内容填充。这轮不是全量 DSH 功能移植。
4. 原型中的自主消息折叠「message from xxx」尚未开始：按用户顺序等真实 P0 过门，
   不在本轮先加新产品语义。
5. 单文件 **16 MiB**：上传端虽更大，但既有 files.read 只能完整读取 16 MiB；
   超限明确拒绝，truncated 拒绝打开/下载。音频 MIME 未识别时仅浏览器展示层按标准扩展名解码。
6. 未执行旧重画界面的全量 Playwright 套件，不宣称旧 UI/全部功能回归通过。
   本轮采用下面的原版窗口/真实打包版专项证据。没有独立代码审查通过结论。

## 240 秒 running 的调查边界（交协调者转后端线）

- 实际发现并修复前端漏投影 `message.card.body`：旧 .5 同样收到 11102，后端台账已 failed，
  界面却只显示笼统标题；新 .7 能看见完整错误。前后证据在 `regression/` 与 `sse/`。
- 当前 `@earendil-works/pi-ai` 1.5.0 的 SSE 读取器显式对 `event: error` 抛错；
  联系人适配器对 error stopReason 抛 provider-error；
  `packages/server/src/host.ts` 的 round catch 会写 failed、清 activity 并走失败卡路径。
- **离线回放**经当前依赖和 Host/SQLite，79 ms 内 failed + 卡 + idle；
  **真实安装包本地 SSE 回放**124 ms 内可见原文、failed + idle。
  两个夹具都立即给 error，未模拟线上 12–20 秒延迟；它们不能解释或否定旧包真实 running 240 秒。
- 后端未配置请求级 timeout 的缺口保留；没有加前端计时器或修改后端来绕过。
- 回放还发现后端把 model_unavailable 文案归为“请求被拒/鉴权或额度”，
  该分类措辞可能误导；前端保留原文，不擅自重写分类。后端需对照旧安装包版本、请求日志和 run ID 继续定位。

## 验证命令与前后结果

在 `apps/desktop` 执行：

```sh
node verify/dsbot-source-integrity.mjs
npm run verify:structure
node --test src/dsbot/bridge.test.ts verify/dsbot-visual-fixture.test.mjs electron/renderer-permissions.test.ts
npm run typecheck
node verify/dsbot-packaged.mjs --app /PATH/TO/g-group.app --attachments --out /WRITABLE/OUT
node verify/dsbot-packaged-error.mjs --app /PATH/TO/g-group.app --out /WRITABLE/ERROR-OUT
node verify/dsbot-sse-error-control.mjs /WRITABLE/HOST-OUT
node verify/dsbot-reference.mjs --candidate http://127.0.0.1:5219 --out /WRITABLE/VISUAL-OUT
```

- 120 个原始文件 SHA 与完整入口/11 组样式通过。
- 18/18 专项单测，0 skip；typecheck、构建、签名检查通过。
- 结构门曾实际失败：bridge 421 行；仅提取纯消息投影到 chat-message.ts，
  现 bridge 394 行，结构门通过，没有调高阈值或改基线。
- 图片乐观行：旧 .4 严格回归 observed pending=1 失败；新版 observed pending=0。
- 代码复制：旧 .5 actual permission denied；新版实际复制成功，读取权限仍拒绝。
- 失败正文：旧 .5 本地 11102 已 failed 但界面缺原因；新版实际可见。
- 最初本地 SSE 验证器漏处理 `?beta=true`，导致自身 404：已修 URL pathname 匹配。
  `regression/executor-query-404-invalid-replay.json` 保留该执行器错误，**不算产品缺陷或有效 SSE 回放**。

## 首个未完成操作

待 fengshao 恢复，或用户经协调者明确批准其他线路后，再对**同一项目/同一原版窗口**
做真实模型私聊与群聊 P0 实点，保留本轮已经完成的外观和附件结果，不重画、不重跑探针等待。
PR #118 保持 draft；本轮不请求合并。不触碰后端分支、用户自己的前端线或 PR #101–#105。
