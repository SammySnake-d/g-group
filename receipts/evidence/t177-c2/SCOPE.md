# T-177 C2 · 迟到应答留记录：范围、条件对照与未覆盖

- 分支 `feat/t177-c2-late-receipt`，叠在 C（`feat/t177-c-plugin-outbox`，#63，HEAD `2189fa19`）上。与 C 有文件交集（见下），所以必须先等 C 合入再改基。
- 依据：需求 D29 第 5 条「每次调用带请求 id 与超时；迟到的应答按请求 id 丢弃并留记录，不改已经落地的账本状态」（`origin/docs/dev-handbook@6109485e`，v3.29）。§2.0「做 / 不做的标准」：这次只做**能核对的事实记录**——谁在什么时候回了什么、和哪一次认领对上；不改外发判定，不加界面，也不加硬门禁。
- 用户 2026-11-11（dm-ai-matrix#2822）答复「都按你的推荐来」，即 C 的 PR 里三条候选的头一条：迟到回执另存一份备查。另外两条（对账入口、清理策略）明确不做：对账入口等 AC-35 阶段 II，记录一直保留、不加清理。
- 作者：Claude Code 主会话 `claude:b36ab234-0cba-4b89-929e-d21a46a35eea` 派出的子代理实现（fnqz 线路，`claude-opus-5-5`）。

## 做了什么

| 件 | 位置 |
|---|---|
| 新表 `gg_plugin_late_receipts`（只追加）、`recordLate`、`lateReceipts`、`LateReceiptView` | `packages/server/src/plugin-outbox.ts` |
| `PluginRuntime.send` 多收一个 `RawSink`：内核在 `reg.send` 的同步段里调用插件委托，把这一次的原始调用交给调用方；同步段一结束就清掉接收者 | `packages/server/src/plugin-runtime.ts` |
| `PluginStore.send` 在内核记超时、或这一行已被重启后的宿主记为未知时，监听原始调用；之后才到的应答记进表，并在 `close()` 前不再改动外发状态 | `packages/server/src/plugins.ts`；`PluginStore.lateReceipts(id, actionId)` 只读 |
| 5 条具名测试 L01–L05 | `packages/server/src/plugin-late-receipt.test.ts`（新） |
| 定点变异脚本 | `scripts/t177/c2-mutations.mjs` |

记录里有什么（全部来自可核对的事实）：

| 列 | 含义 |
|---|---|
| `plugin_id` / `action_id` / `attempt` | 哪个插件、哪个动作、哪一次认领（和 C 的在途行凭据对得上） |
| `cause` | 宿主当时为什么不再等：`timeout`（内核超时）或 `host-restarted`（这一行已被重启后的宿主记为未知） |
| `state_at_arrival` / `reason_at_arrival` | 应答到达时外发表里这一行的状态与原因（**只抄下来，不改它**） |
| `install_id` / `version` / `endpoint` | 当时绑定的安装身份、包版本与接收端，方便人工对账 |
| `boot` / `received_at` | 收到这条应答的宿主启动编号与时间 |
| `receipt_id` | 应答里的回执 id，字符串才记、原样存 |
| `action_matches` | 应答里的 `action_id` 与这个动作是否一致 |
| `reply_sha256` / `reply_bytes` | 整条应答（JSON）的 sha256 与字节数 |

**不存应答全文**：插件很可能把载荷原文回显进来（示例 webhook 插件就回显 `text`），所以只留指纹和回执 id。这一条有具名断言：库里搜不到 `late:900` 这段原样字符串（变异 `L01-stores-full-reply` 把它记成全文本，被 L01 杀死）。

## 明确不做的三件事（用户已定）

1. **不改外发状态**：迟到的应答不会把 `delivery_unknown` 改成 `confirmed`，也不会改这次返回给调用方的结果（L02、L03 有断言；变异 `L02-late-confirms-row` 被杀死）。
2. **不触发重发**：记录之后同一动作照原规则拒发（L02 断言之后的 `retry-refused`，并核对接收端没有收到第二次）。
3. **没有对账入口**：不加 API、不加界面、不能人工标记已送达/放弃。`lateReceipts` 只在宿主内部可读。

另外：记录一直保留，卸载插件、重启宿主都不删（L05；变异 `L05-uninstall-drops-late`、`L05-overwrites-prior` 都被杀死）。

## 判定「迟到」的口径（可机械核对）

只在两个条件下开监听：

- 内核这一次的结果是 `delivery-unknown` 且原因是 `timeout`——宿主已经不等了；
- 或者外发表里这一行已经被重启后的宿主记成结果未知（宿主返回 `host-restarted`）——上一个宿主进程已经不在了。

其余情况（按时确认、插件进程报错、按时回了对不上的应答、超出宽限被结束进程）都不记（L04，带一条同一进程里的真迟到做阳性对照）。

## 实测数字（只列真跑出来的）

| 项 | 结果 |
|---|---|
| 红 `ed3e93d8f0a88b9fdddbe9cd9be38d0d72b110f1` | box4 Node 24.21：新增 5 条测试按名字失败 5/5，加载错误 0 |
| 绿 `0ef0269d1782af81c0e444ce50ac7eae3d3a2cd4` | box4：npm ci / typecheck / lint 退出码都是 0；全量 1523/1523，fail、cancelled、skipped、todo 都是 0 |
| 变异 | 11 个定点变异 11/11 被对应的具名测试杀死；变异前后各跑一次原样对照，都是 5/5，并发 1；没有等价变异 |
| 本机 `run-all.ts --local` | 除 G-REVIEW（还没有审）外全过，最终 HEAD 的原样输出与内容 hash 见收据与 `receipts/evidence/t177-c2/local-gates.txt` |

## 与 C 的文件交集（为什么必须先等 C 合入）

C2 改的三个源码文件 C 也改：`plugin-outbox.ts`、`plugin-runtime.ts`、`plugins.ts`。C2 的绿提交直接在 C 的 HEAD 上改这三个文件，所以 C 返修时这两片会互相打架。C 合入 `dev/integration` 之后，C2 要 rebase 到 C 的新 HEAD（或 `dev/integration`）上，并重排 `red.commit`。

## 不在本片、未覆盖（不冒充）

- 只是「记下来备查」：没有验证过任何人真的用它对过账；对账入口按用户决定等 AC-35 阶段 II。
- 记录不覆盖「插件进程按请求 id 丢弃的**内核之外**的迟到应答」——插件协议层本来就只认在途请求 id，那些应答连宿主都到不了，本片管不到（D29 第 3、5 条，属插件侧）。
- 宿主崩溃在「应答已到、还没写进库」这一刻：这条记录会丢。不改外发状态是硬要求，记录只是备查，所以没有为它加事务或重放。
- 记录会一直增长，没有清理和上限。
- 断电与系统崩溃、两个宿主进程真并发，同 C，本片也未测。
