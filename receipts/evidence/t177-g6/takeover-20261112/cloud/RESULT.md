# G6 G4b 修复后规则替身回归（box4）

已完成，34/34 次运行 status=ok；这只证明确定性宿主合同，不是强/弱真实模型效果。

- runner：`f5f3af097109025295249a6c391fcd78f7cff025`，Node v24.21.0 / linux-x64。
- 修复后组提交：`da066f5fee37d070785ec0ef9b2e7babebf13972`，包含 G4b `b2cda6eaf1e76c1873a3c7a3bf35152b27f04e49`。
- 修复前组提交：`3218bc7dcc59465146cc9455595d81a470a618ff`。
- 全批次：g4on、g4off 各 17 题 × 1 遍；另用同 runner、同 Node/平台、同题集跑修复前 R1 各 1 次，作为最小红对照。
- 修复后时间：2026-11-12 09:38:54Z–10:00:19Z；旧 R1 对照于 10:01:39Z 完成。
- `runner.exit=0`、`baseline-before.exit=0`、`source-integrity.exit=0`；源码逐文件 SHA-256 核验成功，运行前后 git status 一致（仅只读 node_modules 软链接未跟踪）。
- 重活持 `/workspace/.heavy.lock`。没有修改产品、runner 或题集；没有重复已有全量测试/变异。

| 对照 | R1 的 K1 | 运行状态 | 模型调用 |
|---|---|---|---|
| 修复前 g4on | fail，12 次检查中 2 次违例（调用 13/14，第 5 块） | ok | 15 |
| 修复后 g4on | pass，12 次检查、0 违例 | ok | 15 |
| 修复前 g4off | pass，12 次检查、0 违例 | ok | 15 |
| 修复后 g4off | pass，12 次检查、0 违例 | ok | 15 |

修复后全 17 题的合同结果：

| 合同 | g4on | g4off | 每组检查数 |
|---|---|---|---|
| K1 | pass | pass | 33 |
| K2 | pass | pass | 196 |
| K3 | pass | pass | 297 |
| K4 | pass | pass | 2 |
| K5 | pass | pass | 3 |
| K6 | pass | n/a（预取关闭） | 196 |
| K7 | pass | pass | 314 |

完整交付：`cloud-evidence.tgz`（116264 字节），SHA-256 `9427efaa110e86787088a2a13289377c679175df2e8a6d44744c8eb23d0d8009`。使用 box-get 取回后再次在本机核对。解包后的报告与原始 JSON 位于 `standin-post-g4b/`、`standin-before-R1/`；`comparison.json` 含机器可读合同与 R1 原始记录 SHA-256。

前置执行错误：云端首次 GitHub fetch 返回 exit 128：`Could not resolve host: github.com`。已改用本机 frozen bundle 分片传输并验证 SHA-256 `2606825afd869d0c38ef066db0e03b667acf4f5e16f4d46dad0238a97d17568e`；该错误没有混入验收结果。

按主代理要求保留云端固定源码/输入和证据：`/workspace/t177-g6-codex-20261112` 共 41M。最终 ps 未发现本任务 flock / bash / standin runner 进程，残留运行进程 0；未删除其他任务目录，未推送或编辑 PR。
