# Q02：既有 Host 行为的独立服务回归（测试专片，仍未整体验收）

## 固定对象与边界

- 分支 `feat/coverage-invariants`，固定集成基线 `4efdee0be6d161060099b5ce488e3344c70305ee`。
- 受测源码 HEAD `5cf70481c19c3d052e1da6822ac33919c3a2e1a0`；有效红提交 `a9c0ffef997b5f364fb6b725031357b4dcf93d74`。
- 最终 delta 只有独立测试、证明 runner、已知缺口探针、文档及收据；生产代码与基线逐字节一致。红提交中的错误返回仅用于校准测试敏感性，不代表基线产品原本有这些缺陷。
- Host、SQLite、service 为真实生产边界；Mind/Compute 使用项目现有确定性替身，不是模型或真实 CLI 端到端证明。

## 四组已知行为的直接断言

1. **持久身份/记忆**：真实联系人建立记忆；改头像、合法换 harness、关闭 Host 再打开后，ID/createdAt/persona 和记忆条目不变；实际输入块仍含原身份和记忆。同名新联系人有不同 ID 且无旧记忆。
2. **群普通消息**：两位联系人在无任务和 Compute 已 started 仍在途时均收到真实 fresh 消息；普通消息不会直接 spawn/resume Compute。不是“没有活跃任务所以自然不会 resume”的弱阴性。
3. **tasks.progress**：真实 started 与两条 milestone 先发事件并持久化，再经 service 查询；比对字段、顺序、limit=1、未知任务 not_found 和重启读回。它只是摘要进度，不是完整原始工具转写。
4. **无关插话**：T4b 问题、约束版本、问题卡、Compute 全不变；用原 qId 回答后回到 T3，只有原 Compute 获得一次恢复输入，卡变 done，无额外 spawn。

测试：`packages/server/src/coverage-invariants.test.ts`。

## 红/绿与错误行为变异

- 相同测试体在四个可加载的错误返回点下，四个预定测试按名字以 `ERR_ASSERTION` 失败；恢复生产实现后 4/4 绿。
- `packages/server/proof/coverage-invariants-mutations.mjs` 事先给 8 个单点故障绑定具体测试：错误身份、丢记忆、丢群注意输入、群消息错直送 Compute、忽略 limit、逆序进度、忽略回答、插话使卡过期。
- 解析器先对真实断言/TypeError/timeout/module-load 分别做阳阴性；只有预绑定具名 `ERR_ASSERTION` 才算杀死。变异只写自己临时副本，第三方依赖可复用，工作区包链接必须指向副本自己，结束清理自己副本。

## 明确未通过的产品项

- **U83 实际 replying→idle 生命周期缺失**。单独执行 `node packages/server/proof/coverage-invariants-replying-gap.ts`，真实回复已提交，但仅观察到 thinking→idle，断言预期失败 exit 1。此负结果保留在完整原始证据中，不能以这四组回归绿抵消；它不作为 `.test.ts` 混入绿套件，不抢 CA2/G owner 的公共写点。
- `tasks.progress.afterAt` 不在本专片断言范围；基线服务接收但忽略它。未修复、未声称通过。
- 不证明真实模型/CLI、前端、截图、完整 INVARIANTS 协议、完整 AC-43 运行台账及卡住重跑闭环。
- 收据将复合 AC 标为未测并精确列出已测子项；Q02 只补回归证明，整体验收仍未完成。
- 独立 G-REVIEW 与真实 G-PROVENANCE 由 Mira Bot 安排；作者不自签，也不生成伪造会话/来源。

## 可复现命令

```sh
node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit --test-reporter=tap packages/server/src/coverage-invariants.test.ts
MUT_OUT=/path/to/owned-output node packages/server/proof/coverage-invariants-mutations.mjs
node packages/server/proof/coverage-invariants-replying-gap.ts # 当前预期 exit 1，真实产品缺口
```

## 证据与环境

box3，Node v24.21.0；独占 RAM 根与 `flock -w 3600 /workspace/.heavy.lock` 串行执行。源码、runner、配置冻结；不清理共享文件。仓库内 `cloud-proof.tar.gz`、`result.json`、`mutations.json` 与 `source-freeze.json` 在实际运行完成后保留原始结果。

首轮已经取得四红四绿与 8/8 变异，但类型检查暴露测试 fixture 类型问题（元组推断为可能 undefined，重开 Host 缺少必需 mind）。不把该轮报作全部通过：仅显式 fixture 类型与重启替身，断言没有弱化，再做新红提交和完整云验证。旧轮完整结果另行保留。

收据追踪说明：固定基线门禁的 spec ID 提取器不识别主文档现有 `AC-P1-02`，首次 G-TRACE 如实失败。未修改门禁/需求或添加豁免；该子项保留在 `additionalCoverageNotes`，其 T4b 原题/原 Compute 路径同时映射到可识别的 AC-44，复合验收仍未测。
