# P1 公告与置顶打包版验证（2026-11-15）

基线：本分支从 `feat/desktop-model-onboarding` 叠加；安装包为本分支最近一次 `npm run pack:mac` 产出的 arm64 包。验证使用后端规则替身与替身 Compute，只验证桌面前端到真实宿主合同的生命周期，不把替身模型回复当成真实模型证据。

- 公告：打包版建两位 agent、建群、发布公告，顶栏出现公告和装配计数；公告路径可读回、版本变化和撤下路径由宿主持久化。结果：`PACKAGED_NOTICE_OK`。
- 置顶：同一群发消息后右键置顶，公告/置顶轮换条切到置顶消息；重启打包版后置顶仍可读回。结果：`PACKAGED_PIN_OK`、`PACKAGED_PIN_RESTART_OK`。

现有真实接线与合同：`announcements.list/add/update/remove`、`messages.pin`；本片没有新增前端代码或伪数据。既有 Electron 走查仍覆盖完整公告/置顶交互，详情见 `e2e/group-side.electron.spec.ts` 与 `e2e/parity-chat.electron.spec.ts`。
