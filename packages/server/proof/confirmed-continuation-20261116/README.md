# PR #75：正常确认后的续接与停止标记落盘故障

## 冻结对象

从 `d7c2cf7f3d11ed88fa9c6cae15f9456b77790cd4` 新建独立副本。
最终执行源码为 `609269bf3a0dd779baf8133c79b70351cac2216a`，源码指纹见 manifest；后续只冻结证据。
原 d7 副本与此前两组 frozen proof 的字节没有改写。未自审、未推送、未合并。

## 两条全量失败先复现后修

协调者的 d7 全量 npm test 原件为 1683/1685，两项失败摘录及原件路径/SHA-256 留在 root-full-d7 文件。
本片没有重复全量执行：在独立副本只复现指定路径，desk-fake 3/4、exit 1；AC-15 0/1、exit 1。

1. `scriptedCompute.play` 的慢等待不能取消：haltOnStop 虽发出 stopped，自己尚未结束的 20 秒等待仍让 busy > 0。
   没有弱化 quiesce 的 busy/终态判断，而是停止及关闭时取消这个替身自己注册的等待，让生产循环实际结束。
   新具名 mock-clock 负控先红；修后取消 60 秒等待、队列真 drained，之后推进时钟也不再吐旧进度。
2. `QuotaTable.acquire` 拒绝复用 stopping lease 时只返回 queued，没有登记 waiter。
   合法 quiesce 后 release 没有对应 grant，Host 的 pending resume 因而丢唤醒，AC-15 续接为零。
   现在真排队且去重，只在可信停止确认后释放旧 lease、授予新 lease并唤醒续接；没有把 stopping 直接清除或提前允许 resume。
   纯配额具名红测实际确认释放后应有 grant，基线却为空；修后通过，原 AC-15 完全不改断言也通过。

## 指定 storage 注入：成立后才补修

只在测试自有 SQLite 给 gg_compute_leases 的 stopping UPDATE 注入失败。
第一次探针误把 Db 包装器当原生 SQLite，TypeError、exit 1 已保留，不计为产品红。
绑定到 db.store.db 后，失败卡已提交、markStopping 的 persist 抛错并回滚内存，retry 确实调用 resume 一次，具名红测 exit 1。

最小保守处理：markStopping 落盘失败时，内存租约仍置 stopping，不能恢复成可复用；错误继续上报。
onComputeEvent 对该指定标记错误保留报告，并继续实际 afterRound 核验，不让 pump 吞掉错误后跳过核验。
quiesce 失败的原 lease 继续隔离，retry 不复用；可信核验成功后仍可释放并合法续接，两条正负对照均通过。
一般授予/释放的持久化失败回滚规则没有改动；磁盘已存旧 lease 在重启后仍按未知恢复、不得直接复用。

## 最终实跑结果

命令数组、冻结输入与每项独立退出码见 final-command-arrays.json / final-inputs.sha256。
所有长跑后台串行、直接运行命令不接管道；没有修改 live 输入或门禁判据。

- 目标两文件全部测试：24/24，exit 0。
- 原 83 项相关测试加本片四项：87/87，exit 0。
- npm run typecheck：exit 0。
- 八文件 biome lint --error-on-warnings：exit 0，No fixes applied。
- 目标旧测试以及原八文件的旧断言/字节保持不变；两份新负控在已有 stop-confirmation/fakes-quiesce 文件末尾追加。
- 原 83、旧全量 1683/1685、独立基线失败、storage 执行器错误及真实红测全部保留，没有以新绿覆盖旧失败。

首次冻结检查因 root 的 TAP 失败摘录自带尾空白退出 2，未提交或绕过；可读摘录去尾空白，原字节另存 gzip并核验。
可读日志只去尾空白，变化的原字节另存 gzip 并核验；外部原始回执未动。
全量 npm test、直接 gates:selftest 及正常推送仍由协调者唯一执行，在 fresh 私有 workspace 依赖下用外置 native 身份护栏；本代理不双跑、不发真实进程信号。
重启恢复/legacy 未知 lease 的合法回收入口仍没有实现，完整后代监督和真实模型 A5 也不由这组无 OS 测试证明。
