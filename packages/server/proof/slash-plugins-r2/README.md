# P7 · 第 2 轮返修（PR #85 第 1 轮 REJECT 之后）

基底不变：PR #71 `feat/chat-admin` c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29。返修叠在审查提交 230ed1c98fe13d5a532c3d94fd725f36b2216ddc 之后，没有改写它之前的任何提交。
受测源码：156d4840ef1a00bbda62c9892174c2450ada62fc（之后的提交只加本目录与收据）。第 1 轮证据在 `../slash-plugins-v3/`，原样保留、未改。

## 提交与两种红

| 提交 | 内容 |
|---|---|
| 15fa0b78 | **真实红**：只加 `src/slash-commands-boundaries.test.ts`（15 条），实现仍是 230ed1c9。7 条按名以 ERR_ASSERTION 失败（R1-01 一条、R1-02 三条、R1-03 一条、R1-04 两条），其余 8 条通过 |
| 5ada028e | 修复（R1-01…R1-04） |
| 472eaed1 | **变异校准红**（收据 `red.commit`）：两份测试文件与现在逐字相同，只把 `src/slash-commands.ts` 换成直通桩（`send` 一律 `host.send`、`assertCommandNames` 空函数、不建执行账本，与第 1 轮 e0b53915 同一形态），31 条全部按名失败 |
| 917d2183 | 还原：`src/slash-commands.ts` 与 5ada028e 逐字节相同 |
| 156d4840 | 变异清单只增不改 |

通过的那 8 条（S03、S05、S06、S07/S14、S09、S10、S11、S12）钉的是 230ed1c9 上本来就对、但没有测试保证的行为（审查方自构故障存活处）。它们对真实实现从来是绿的，红只在直通桩和对应的单点变异下成立。
校准红的 31 条里 29 条是 ERR_ASSERTION；另 2 条（R1-02 的前两条）是测试读执行账本时 `no such table: gg_plugin_commands`（直通桩不建表），按名失败但不是断言失败。这两条的断言失败见真实红。

第 1 轮「红 16」同理：e0b53915 也是实现写完后换回直通桩得到的；16 条里只有「P7 参数和权限…」一条对修复前的真实实现（ff0c1edf、11aa677c）是红的，其余 15 条的红只对空桩成立，不是先于实现而红。

## 云端复跑（box2，Node v24.21.0）

`run-r2.py` 在 `/workspace/claude-author-pr85-r2` 经共享锁 `/workspace/.heavy.lock` 排队，八步全部按预期退出，`out/result.json` 记每步命令、退出码与原始输出的 SHA256。

| 步 | 结果 |
|---|---|
| green（两份测试文件） | 31/31，exit 0 |
| calibration-red（472eaed1） | 31 条按名失败，0 通过，exit 1 |
| real-red（15fa0b78） | 7 条按名 ERR_ASSERTION 失败、8 条通过，exit 1 |
| 变异 | 38 个（原 18 + 追加 20），原样副本 31 绿 0 红作正对照，杀死 38、存活 0；每个都由清单预先绑定的那条具名测试以 ERR_ASSERTION 失败。见 `out/mutations.txt` |
| 生产路径 proof | PASS（`重启重放: same seq 3`）。见 `out/production.txt` |
| typecheck / lint | exit 0（输出为空）/ exit 0（`Checked 205 files … No fixes applied.`） |
| 全量 `npm test` | 1516/1516，fail 0、cancelled 0、skipped 0、todo 0（第 1 轮 1501 + 本轮 15） |

`out/red-green.json` 逐条列出三次运行的测试名与是否断言失败。全量日志（9107 行）、38 份变异 TAP 与 `mutations.json` 不进仓库，留在作者交接目录；它们的 SHA256 在 `out/result.json`。

## 逐条改了什么

**R1-01 已有插件的命令保持原路由。** `PluginStore.commandOwner` 只把清单声明 `ui-extension` 且有 `entry` 的插件认作命令执行者。`catalog/rss-reader`（数据源）、`catalog/webhook-out`（输出渠道）声明的 `/rss`、`/push` 返回 null，照 #71 作为带 command 的用户消息发给联系人，不拉起插件进程、不留账本行。这是保持 base 行为，没有替用户定「需拍板」第 4 条。测试用真实市场包安装；变异 R01。

**R1-02 插件命令过发送的前置校验。** 执行前 `Host.assertCanPost`：不是成员 `forbidden`，群解散中/已解散 `conflict`——与 `Host.send` 同口径；被拒时不执行插件、不落账本、不写消息。发布时 `Host.postPluginResult` 再核一次：执行期间群被解散或用户被移出，结果不发布、账本记 `failed`。结果留在发起命令的话题（`threadRootSeq`）；带 `draftVer` 时与写入同一事务结算那一版草稿，失败不动草稿（前端输入框里的命令还在，可改了再发）。变异 R02a–R02e。

**R1-03 插件输出不再冒用宿主身份。** 发言者从 `system:host` 改为 `system:plugin:<插件 id>`，联系人输入里显示 `插件 <id>(system:plugin:<id>)`；`MessageView` 增加可选 `pluginCommand { pluginId, command, clientActionId }`（合同只增），来源写表 `gg_msg_plugin`，与消息同一事务。变异 R03a–R03c。
**是否进入联系人上下文卡在「需拍板」第 1 条，本轮没有定**：当前行为与第 1 轮相同——插件输出仍作为只读上下文进入同群联系人的下一轮输入、不主动唤醒联系人；变的只是身份和来源标记。

**R1-04 `/ketchup` 的边界取自已读序号本身。** `boundaryAt` 改为读已读那条事件自己的时刻（`events.at`），不再依赖它在可见列表里；已读停在摘要、撤回或本端删掉的消息上都一样。两条测试用可推进的宿主时钟（固定时钟下所有时间戳相等，这一支从未真正执行过）。变异 R04、S08。

**R1-05 判别力。** S03、S05–S12、S14 各有一条业务断言并进了变异清单；S12 钉的是「撤回的消息不计入新消息条数，也不进快照消息」。

## 没做的与边界

- **另记 N-1（宿主重启后 system 消息唤醒联系人）仍然存在**：重启后同群联系人会被叫起一轮，这一轮的新输入就是那条插件输出（探针：无消息 0 轮、宿主通知 1 轮、`/ketchup` 1 轮）。原因在基线 `hasPendingInput` 只比较 `lastSeq > cursor`、不区分只作上下文的发言者，改身份不影响它；所以没有加「重启不唤醒」的测试（加了会是红的）。根因修复不归本片。
- `/ketchup` 不在 `catalog/catalog.json`，宿主启动也不会装它，入口没有接通：只能按本地路径手动安装。
- 撤回消息的原文仍会经任务标题进入快照（任务标题是联系人派活时生成的派生数据）；「撤回不进入」只对消息正文成立。
- 命令带的 `attachments`、`mentions`、`quotedSeqs` 仍被丢弃，也不进幂等指纹；`gg_plugin_commands` 每次存一份结果正文、没有清理；未读为 0 时仍整群翻页（R1-07，未改）。
- 表 `gg_plugin_commands` 加了 `plugin_id` 列，没有写迁移：本分支从未合入，只有用第 1 轮代码跑出过该表的本地数据目录会受影响（删表即可）。
- 同一命令重放（`done`）时不再重复结算草稿；`Host.send` 的重放会再结算一次。没有测试钉这一处差别。
- 「需拍板」第 2 条（网络隔离前是否允许把会话快照交给第三方插件）、第 3 条（G-PROVENANCE）没有动。
- 没有改前端；没有真实模型、真实 CLI Compute 的运行；不是完整 C-US25 / AC-35 通过。
