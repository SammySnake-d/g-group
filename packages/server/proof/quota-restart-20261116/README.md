# PR #75：重启丢失未确认 Compute 槽位

## 范围与结果

基线为 `31082df234b2b59af260d02e70f6b91ba5104bdd`；源码冻结提交见 `manifest.json`。
本片只修重启遗忘租约及相关未确认终态语义，不宣称修复 macOS 全后代监督。
未推送、未合并，未跑真实模型或重型门禁；测试仅用 `scriptedCompute`，没有对 OS 进程发信号。

- 原反例：第一个任务 `T9_StopRequested` 且停止未确认，重启后 lease 消失，第二个任务占用同一个人的唯一槽位。
- 保存并恢复精确 `lease_id / task_id / contact_id / room_id / scope / stopping`。停止或失败通知不等于可删除租约。
- 持久化保存失败时，授予/释放及内存排队状态一并回滚。
- 已恢复但未核对的租约不允许同任务复用或仅凭旧 lease_id 释放。
- 历史库没有精确租约时，对相关联系人的个人槽与原群临时槽保守保留，不占用无关群。
- 原任务仍有执行占用时，不允许由重跑入口虚构停止确认；取消/不重试通过已有停止确认流程处理。

## T11、台账与物理占用并非同一状态

旧 `recoverRuns()` 的 T11 并非独立 crash-failure 事件：它调用 `ExecFailed`，随后伪造 `StoppedConfirmed`。
领域 `task.ts:435–441` 清除 `computeId`、加入 `retired`、产生 `release-slot`，最后转 T11。
但宿主 `stepTaskTx()` 只保存状态并返回 effects，旧 `recoverRuns()` 丢弃 effects，**并未在此直接调用 `giveBack()`**。
旧重启后的物理槽位丢失是 `QuotaTable` 用空数组重建所致，不能把两条因果混为一谈。

现场同体观测见 `semantics-baseline.json` 与 `semantics-candidate.json`：

| 观测 | 基线 | 候选 |
|---|---|---|
| 逻辑任务 | T11_Failed | T9_StopRequested |
| computeId | 被清除 | 保留 |
| retired | 加入原实例 | 未加入 |
| 物理租约 | 丢失 | 原样保留 |
| 运行台账 | orphaned，无 running | orphaned，无 running |

最新需求来自 `origin/docs/dev-handbook`，版本 `90226df5ffd17656f2654ab8555f7e71a93639de`，原文片段保存在 `latest-stop-contract.txt`：

- 需求 §D16.1 第 1431–1436 行要求逻辑任务、归档、物理占用三分离，未确认停止不得归还。
- 需求 §D20.3 第 1805 行明确：未收到确认/进程失联保持 T9；ExecFail 只有收到 StoppedConfirmed 后才转 T11。
- 验收 AC-43 第 164 行只要求运行台账变为 orphaned、不遗留 running；没有要求逻辑任务直接 T11。

因此只把旧测试改成 T11＋未知 lease、继续沿用 StoppedConfirmed，并不满足当前状态机合同。
真正另立逻辑 crash-failure T11＋未知资源状态属于后续合同/领域改动，而不是本片的最小修复。

## 保留的红绿与历史

- 修改前基线：`baseline-quota.tap`，10/10。
- 修改前具名重启红：`red-restart.tap`，个人槽与群临时槽两个失败，正常已停止对照通过；测试提交 `fab8de85`。
- 修改前旧库红：`red-legacy.tap`；测试提交 `e704d826`。
- 修改前存储失败红：`red-storage.tap`；测试提交 `3fe8c7bd`。
- `red-crash.tap`、`red-cancel-calibration.tap` 是实现后在独立生产基线副本重放的**事后校准**。
- `red-give-up.tap`、`red-recovered-release.tap` 是相关守卫修改前实跑的红；不表示全部实现都是先红后绿。
- 原旧 runs.test 断言 T11 导致的 **54/55、exit 1** 完整保留在 `final-regression.tap`，没有覆盖原失败。
- 经协调者明确授权，按最新 T9 合同强化旧断言，并保留原 orphaned、无 running、主动报卡点断言。
  新增精确原租约保留、同任务不可复用、新任务排队不开工；
  `runs-contract-calibration-red.tap` / `runs-contract-calibration-green.tap` 是同字节测试在生产基线红/候选绿的**事后校准**。
- 最终相关八文件串行回归 `contract-full-regression.tap`：**74/74，exit 0**；类型检查与六文件 lint 均 exit 0。
- 所有执行结果均留独立 `.exit`；输入指纹、完整命令数组见 `manifest.json`。
- 首次冻结时 `git diff --cached --check` 因 TAP 输出中的行末空白退出 2，未执行提交。
  为保留精确证据，受影响日志另存逐字节 `.tap.raw.gz` 并解压核验；可读 `.tap` 副本只去行末空白。
  原始日志仍在隔离证据目录，原字节 SHA-256 见 manifest，未改变测试结果或门禁判据。
- 补齐三个被 `*.log` 忽略的类型检查/lint 日志时，`git diff --cached --check` 再因日志尾空白退出 2。
  只对可读副本去行末空白及末尾空行，受影响原字节保存在 `.log.raw.gz`，并核对外部原始日志与 manifest；没有改忽略规则、门禁或钩子。
  外部原始 `lint.log` 在冻结目录中命名为 `initial-lint.log`；补齐时一次误按新名读取外部文件的执行器错误已纠正，未重跑或改写测试结果。

## 完整复验命令

在本工作树根目录直接执行，不接管道：

```sh
node --test --test-concurrency=1 packages/server/src/quota.test.ts packages/server/src/lease.test.ts packages/server/src/retry.test.ts packages/server/src/runs.test.ts packages/server/src/compute.test.ts packages/server/src/delivery-plain.test.ts packages/server/src/delivery-t8a.test.ts packages/server/src/members-lifecycle.test.ts
npm run typecheck
./node_modules/.bin/biome lint --error-on-warnings packages/server/src/db.ts packages/server/src/host.ts packages/server/src/quota.ts packages/server/src/quota.test.ts packages/server/src/lease.test.ts packages/server/src/runs.test.ts
```

## 已知边界

- 原停止候选 `b9418b78` 仍有采样间脱组过继反例；本片不提升它的停止证明。
- 重启后未核实的租约保持阻断，本片不实现自动观察/核验/回收，因此可能长期占槽。
- 不证明历史库所有中间状态的完整迁移、等待队列持久化或多宿主同时写同一库。
- 已确认停止但在归还落盘前崩溃时，保守残留租约仍需后续可信回收机制；不会据逻辑终态猜测安全释放。
