# G4off 新增两条 K5 的独立核定

结论：**R1、E1 两条均为 K5 判据误报**，但实测后续不同：R1 补查成功；E1 确实补查、再次失败并保留欠账，**不能称为补查成功**。本附件只核定这两条，不宣告全部 K5、AC-42 或 G6 通过。

只读核对时间：`2026-11-12T11:11:35.223649+00:00`。两份被测提交均为 `3218bc7dcc59465146cc9455595d81a470a618ff`，模型 `workbuddy-ai/hy4free`，原运行 `status=timeout` 保留。

## 原始输入

| 文件 | SHA-256 |
| --- | --- |
| `g4off__workbuddy-ai_hy4free/R1-r1.json` | `85c9dad5e127c06a744887bd8e0424b4fa99d216e6865b4815abd36e80f8e549` |
| `g4off__workbuddy-ai_hy4free/E1-r1.json` | `db7e4df368a72f9fda2fd21648652c4769d173604801cf5fd964982e9abeb429` |

根目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-t177-execution/G6/runs/real/raw/`。原始哈希核对前后不变。

## R1：call 6 失败，call 11 成功

- `ops`：`2026-11-12T09:22:58.902+00:00`，撤回消息 #1，通知事件编号为 #3。
- call **6**：`2026-11-12T09:23:57.042+00:00 → 2026-11-12T09:25:54.158+00:00`，empty。输入呈现 `(撤回了 #1)`、编号 #3；冻结 `sources=[]`。
- 原失败报告：`2026-11-12T09:25:54.166+00:00`，coverage ID `3786ff8e25b20bc13ef878fd36f1aa9f00134f2e4f3e16edf9dc56e4422e7f95`。
- call **11**：`2026-11-12T09:29:44.908+00:00 → 2026-11-12T09:30:36.545+00:00`，**ok**；sources 仍为 `[]`。按固定 `MemoryCoverage.begin` 公式重建，得到同一 coverage ID；返回 `{"note":null,"memories":[],"personaSuggestion":null}`。
- 最终 hostDebt 为 `ok=4, failed=1`，唯一 failed 引用是旧消息 #1。后面 call 12、15、25 分别成功检查 #5、#6、#9，不能混为 call 11 的撤回补查。
- 历史 K5 仍要求 `(撤回了 #1)` 文本在后来成功检查的材料里再次出现；空 sources 重建材料不带该通知文本，所以误报。数据重放确认该记录恰好产生 **call 6 / #3** 这一条 K5 失败。

## E1：call 6 与 call 14 均失败，欠账仍在

- `ops`：`2026-11-12T09:42:21.472+00:00`，编辑消息 #1；呈现事件编号 #3。
- call **6**：`2026-11-12T09:42:47.323+00:00 → 2026-11-12T09:44:47.625+00:00`，empty。冻结 source 为 **#1/revision 3**，与呈现的 #3 不同。
- call **14**：`2026-11-12T09:48:36.099+00:00 → 2026-11-12T09:50:38.413+00:00`，empty。sources 与 call 6 完全相同；这是该新版本的真实补查尝试。
- 两次原失败报告时间：`2026-11-12T09:44:47.634+00:00`、`2026-11-12T09:50:38.420+00:00`；两次 coverage ID 均为 `666cdd10ff6bc00b345199fd841c1b8f6fce88e4ed2fe8fdf1828c96035c865d`，与 sources 重建 hash 一致。
- 最终 hostDebt：`ok=2, failed=2, pending=1`，保留两条 #1 failed 引用。后续没有成功检查 #1/rev3；call 23 成功的是 #5，call 24 成功的是 #6 与 #8，**不能当作 #1/rev3 恢复成功**。
- 历史 K5 用呈现编号 #3 查询台账 canonical 来源编号 #1，因而仍报没有欠账。数据重放确认唯一 K5 失败是 **call 6 / #3**；call 14 的材料已用 canonical #1/rev3 呈现，能够命中欠账。

## 固定源码与证据边界

只读 `git show 3218bc7...` 已核对：

- `host.ts:2253–2269`：非 message 事件映射到 target，来源附当前 revision；被撤回的消息不进入 sources。
- `host.ts:2271–2281`：补查重新读取当前可见来源，旧版本失效不等于新版本免责。
- `host.ts:2712–2721`：先补到期欠账，再检查本轮新输入。
- `memory-coverage.ts:37–43`：coverage 身份为 `sha256(JSON.stringify([contactId, sortedRefs, sortedInboxIds, sortedRooms]))`。
- `memory-coverage.ts:89–93`：失败写 failed 和重试信息，due 排除 disposition/blocked。

原 hostDebt 采集仍缺 coverage ID、revision、disposition。本附件把 reconstructed ID 标为 `derivedCoverageId`；不能仅靠最终 #1 引用判断每个版本全部状态。两份原记录仍有 `remember sourceSeq=3` 被拒，不能因 K5 误报将其判成正常或已修复。

本次执行的是原 raw 的读取、哈希、字段比较和冻结判据的数据重放；**未执行真实模型、宿主或测试套件，未改 runner**。2/2 个别记录核对成立。完整 source metadata、精确 call 时间、原失败报告、hostDebt 和记忆写入拒绝见 `g4off-addendum.json`。原四例脚本与输出均未修改，其前后 SHA-256 一致并记入 JSON 的 `originalAttachmentHashesPreserved`。
