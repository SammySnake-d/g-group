# T-177 C · 插件外发跨宿主重启：范围、条件对照与未覆盖

- 分支 `feat/t177-c-plugin-outbox`，按用户要求叠在 A（PR #57，`feat/t177-a-recovery@6e756bdb`）上并行开发。与 A **没有文件交集**（A 改 `domain/followups.ts`、`server/host.ts`、`server/recovery*.ts`、`server/worktree.ts` 及其测试与收据；C 只改下表文件）；C 的改动以 A 为合并基、直接合到 `origin/dev/integration@4efdee0` 无冲突（`git merge-tree --write-tree --merge-base=origin/feat/t177-a-recovery origin/dev/integration HEAD` 退出 0）。叠加只是为了并行，不依赖 A 的代码。
- 方案：`t177-backend-resume-20261110.md` §C；审查条件：`t177-backend-resume-review.md` §C 十一条（以审查条件为准）。
- 设计真源：`origin/docs/dev-handbook@f4963a08`（需求 v3.28）。§2.0「做 / 不做的标准」：外发的持久化、幂等、重启后不自动重发是代码能核对的事实与状态，在 harness 外面，提示词办不到——属于软件做的「隔离与持久化」。插件合同仍是软件内部的自有类型接口（v3.23「插件合同不等于工具接入协议」），本片不改成 MCP。
- 已定合同：需求 §8.1 已定第 17 条（插件交回的值内核只判定、不处理）、D29 第 4、5 条、验收第 9 节；内核 `packages/kernel/` 本片**未改一行**（`git diff origin/feat/t177-a-recovery..HEAD -- packages/kernel` 为空）。
- 作者：Claude Code 主会话 `claude:b36ab234-0cba-4b89-929e-d21a46a35eea` 派出的子代理实现（fnqtz 线路，`claude-opus-5-5`）。

## 做了什么

| 件 | 位置 |
|---|---|
| 外发权威表 `gg_plugin_outbox`：认领、落结果、启动转未知、PRAGMA 读回 | `packages/server/src/plugin-outbox.ts`（新） |
| `PluginRuntime.send` 加同步闸门：进程就绪、渠道自述确定之后、交内核之前同步认领；认领到才投递 | `packages/server/src/plugin-runtime.ts` |
| `PluginStore.send` 先查表再走运行时；`gg_plugins.install_id`（每次安装新生成，旧库补列）；`installId / delivery / durability` | `packages/server/src/plugins.ts` |
| `plugins.send` 合同说明补「B1 只在同一次启动内重试；重启、重装、更新后不自动重发」（只改注释，形状不变） | `packages/api-contract/src/api.ts` |
| 13 条具名测试 C01–C13（真实隔离插件进程；同一数据文件上再开宿主模拟宕机；两个 SQLite 连接验认领竞争） | `packages/server/src/plugin-outbox.test.ts`（新） |
| 定点变异脚本 | `scripts/t177/c-mutations.mjs` |

## 审查条件 §C 十一条逐条

| # | 条件 | 做法 | 具名测试 / 变异 |
|---|---|---|---|
| 1 | 权威状态放宿主 SQLite 新表；内核注册表照旧当进程内执行器；不改内核与 Promise 判定合同 | 新表；内核未改；宿主在调 `runtime.send` 前后读写表（闸门同步执行，与投递之间没有 await） | 全部；`git diff -- packages/kernel` 为空 |
| 2 | 唯一键 `(plugin_id, action_id)`，不含安装身份；install_id、包版本、endpoint、idempotency、windowMs、payload_sha256 作绑定列 | 主键即此；绑定列全在 | C01、C07、C08；C01-bytes、C07-install-id-reused |
| 3 | 写前日志：in_flight 提交成功才外发；写失败不外发、直接报错 | 闸门里先 INSERT，成功才交内核；写库出错转 `unavailable`「没有外发」 | C01、C02；C02-send-before-record、C02-swallow-write-error |
| 4 | confirmed 存 receipt_id；超时、插件进程退出、delivery-unknown 都存 unknown 和原因 | 结果写回同一行（仅当仍是本次认领的 in_flight） | C01、C03；C01-receipt、C03-unknown-reason |
| 5 | 重启把 in_flight 改 `delivery_unknown(host-restarted)`；confirmed 直接返回存下的回执、不调插件；unknown 一律不自动重发（B2 按合同，B1 等同 `clock-untrusted`） | 启动按启动编号转未知；这些判断在起插件进程之前做完 | C04、C05、C06；C04-no-restart-sweep、C05-b1-across-restart、C06-confirmed-reuse |
| 6 | 同 action 换 payload → payload-mismatch；install_id、endpoint 或版本对不上 → 不发、提示人工对账 | `payload-mismatch`；安装/版本对不上 `channel-changed`；接收端变了 `channel-changed` | C06、C08、C09；C06-payload-mismatch、C08-install-binding、C09-version-binding；接收端一项见「等价变异」 |
| 7 | 并发：`INSERT … ON CONFLICT DO NOTHING`，插入成功的才有外发权；另一个照内核 in-flight 拒绝 | 认领先 INSERT；同进程第二个在闸门里读到在途 | C10（同进程两次）、C13（两个连接）；C10-in-flight、C13-claim-conflict |
| 8 | 插件进程按请求 id 丢弃迟到回执（现有）；表里已是 unknown 的不被迟到结果改写 | 落结果的 UPDATE 带 `state='in_flight' AND attempt=<认领凭据>`；没改到就按表里状态返回 `host-restarted` | C04；C04-late-overwrites |
| 9 | 卸载只删安装行和包目录，不删外发记录；重装得到新 install_id | 卸载不碰外发表；install_id 每次安装新生成，更新/启停/改配置不动 | C07、C08；C08-uninstall-drops-outbox、C07-install-id-reused |
| 10 | WAL，synchronous 不显式设；只承诺宿主进程崩溃边界；测试读回 PRAGMA 写进收据 | `durability()` 读回 | C12；C12-durability。读回值：macOS Node 22.22 与 box3 Linux Node 24.21 都是 `journal_mode=wal synchronous=2`（FULL） |
| 11 | 不存 payload 原文，只存 sha256 和长度；回执 id 原样存；未发生投递的拒绝不留 in_flight | 表无载荷列；内核拒收（如 `clock-invalid`）时删掉本次新插入的行 | C01、C11；C11-release-fresh |

方案与审查追加的验收：中性接收端计数（插件进程内 `seen` 列表随回执带出）；「实际接收后、确认前宕机」恢复后接收次数仍为一（C04）；重复成功复用回执（C06、C08）；旧迟到响应不覆盖 unknown（C04）；存储失败不外发（C02）；并发认领（C10、C13）；重装边界（C07、C08、C09）；重启后 B1 不自动重试（C05）；未投递拒绝不卡在途（C11）；PRAGMA 读回（C12）。只在每个用例自己的临时数据目录里测。

同一次启动里结果未知的 B1 仍交内核按服务商保留期判（C05 前半段：同一启动内第二次照常投递并确认），没有因为加了宿主表把已有 B1 合同收窄。

## 等价变异（如实登记，不计入判据）

- `EQ-endpoint-same-boot`：去掉闸门里「同一次启动、接收端变了」的宿主判断。此时内核注册表已因自述改变而 reregister，内核按 `channel-changed` 拒发，对外结果与宿主拦截相同（都不投递、都记结果未知），测试区分不了，存活。重启或重装之后，宿主表先按 `clock-untrusted` / `channel-changed` 拒发，不依赖这一项。

## 不在本片、未覆盖（不冒充）

- 断电、系统崩溃、文件系统损坏：只承诺宿主进程崩溃这一边界；synchronous 取库默认，未显式设。
- 真正的多进程并发宿主：C13 用同一进程里两个 SQLite 连接验证认领原子性，没有起两个宿主进程同时外发。
- 宕机用「同一数据文件上再开一个宿主」模拟，旧宿主对象仍在；没有 SIGKILL 宿主进程本身。
- D29 第 5 条「迟到的应答按请求 id 丢弃并留记录」：插件进程层的丢弃是现有实现（本片未改，也未补记录）；宿主层在重启后才到的迟到结果按表里的未知返回，没有另存迟到回执 id（候选，见 PR「需拍板」）。
- 结果未知动作的人工对账入口（列出、人工标记已送达或放弃）：没有；`plugins.send` 只返回 `retry-refused` / `clock-untrusted` / `channel-changed` 与说明，`PluginStore.delivery()` 只在宿主内部可读，未进 API 合同（候选）。
- 外发记录卸载后永久保留，没有清理策略（候选）。
- 网络隔离、堆外内存、外部事件投递进联系人上下文：照方案保留为未覆盖。AC-35 ①②③、④ 的六元组预授权与 OAuth 阻断、⑤ 阶段 II 真实 Telegram/Gmail 不在本片。
- AC-58（插件隔离）在本分支的验收文档副本（v3.19）里还没有条目，门禁不认，收据不单列；本片是它「插件崩溃重启后同一外发不被自动重发」在宿主重启/重装后的延伸。
