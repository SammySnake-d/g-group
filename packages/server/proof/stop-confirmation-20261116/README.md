# PR #75：停止未确认后的重试与空核验守卫

## 固定对象与范围

基线 `371582432454d26e2e3bb4818fe1aac507afdc2d`；执行源码头 `84ce2a3170afba08d5f240b518b84d4572cdfcb4`。
这是此前重启租约片的独立后继，不替换旧证据、不推送、不合并。
生产仅改 `host.ts` / `quota.ts`；统一无 OS 进程替身的调整已获明确授权。
原八文件的 74 条测试字节和断言全部保持不变，无 skip，无门禁/钩子改动。

## 真实反例来源与修改

只读来源为内部固定基线探针 `internal-probe-371582.mjs.txt` / `internal-probe-371582.json`：
停止核验返回 false 后，失败卡 retry 会复用 stopping lease；续接拒绝会错误归还原 lease 并启动后继；
重启未接回原适配器时点击不重试会虚构 StoppedConfirmed、转 T11，尽管恢复租约还被保留。
探针没有 OS 进程或真实模型，其 PID 字段是替身数据；原探针和结果没有重新执行或改写。

- `QuotaTable.acquire` 在没有 Host 状态表时也拒绝复用 `held.stopping` 租约。
- `Host.giveBack` 不得在停止未确认时归还原租约。
- `afterRound` 缺少原适配器，或 failed/stopped 缺少 quiesce，均保持停止未确认，不以空观察/轮次 settled 虚构确认。
- 任务视图优先展示具体停止核验失败原因，不让泛化的配额等待说明盖住它。
- completed 且有适配器仍沿既有 settled 合同；没有声称其等价于全部后代退出，没有改变其正常完成路径。

## 红绿、合法对照及失败历史

三个初版具名测试均先实跑预期红，再改对应生产守卫；精确测试/修复提交见 manifest。
初版第一条随后加强为执行零延时重试计时器、排空微任务后再断言，避免用点击前已有等待说明提前判绿。
固定基线上的加强版六项同字节重放为 **1/6、exit 1**：五条真反例失败，合法停止确认后同会话 retry 对照通过；
这是实现后的校准，不冒充全部新增断言都严格先红。
候选的六条产品/配额测试与三条替身合同测试共 **9/9、exit 0**。

完整相关第一次实跑为 **63/77、exit 1**，旧替身只有 settled、没有明确完整停止核验，却期待终态/续接；失败全部保留。
另一次初版三项检查为 **2/3、exit 1**，新增泛化配额等待说明盖住具体失败原因，第三条等待超时；原输出也保留。
首次 typecheck **exit 2** 是共享 node_modules 指回旧副本、造成 GGroupBridge 两套声明的执行器错误。
已改为本副本私有 @g-group workspace 链接，外部依赖复用既有安装；没有改 tsconfig 或隐藏错误。

## 获授权的替身合同校准

`scriptedCompute` 默认 quiesce 从当前轮终态和 `settled` 的事件/退出门推导：
未知实例、仍运行/受阻、忙碌生产队列、空 settled、续接后过期终态都不能成功，不是 always true。
明确 `quiesce: false` 仍模拟无完整核验；该产品负控继续保持 T9。
三条替身测试分别核未知/运行/真正 stopped 与续接、失败终态的 settled 退出门、历史 failed 但当前 settled 为空。
一次性与常驻真实适配器在基线均已有 quiesce（adapter.ts:488 / resident.ts:683）；没有改它们或对真实进程发送任何信号。

## 最终执行结果

冻结输入，后台依次直接运行以下命令，不接管道掩盖退出码；每项都有独立退出码与完整输出：

```sh
node --test --test-concurrency=1 packages/server/src/quota.test.ts packages/server/src/lease.test.ts packages/server/src/retry.test.ts packages/server/src/runs.test.ts packages/server/src/compute.test.ts packages/server/src/delivery-plain.test.ts packages/server/src/delivery-t8a.test.ts packages/server/src/members-lifecycle.test.ts packages/server/src/stop-confirmation.test.ts packages/server/src/fakes-quiesce.test.ts
npm run typecheck
./node_modules/.bin/biome lint --error-on-warnings packages/server/src/quota.ts packages/server/src/host.ts packages/server/src/fakes.ts packages/server/src/stop-confirmation.test.ts packages/server/src/fakes-quiesce.test.ts packages/server/src/db.ts packages/server/src/quota.test.ts packages/server/src/lease.test.ts packages/server/src/runs.test.ts
```

- `regression-83.txt` / `.exit`：**83/83，exit 0**。
- `typecheck-v2.txt` / `.exit`：**exit 0**。
- `lint-v2.txt` / `.exit`：九文件 **exit 0**，No fixes applied。
- 来源、命令数组、执行输入指纹、逐字节原始输出哈希见 manifest 与 verify-v2 文件。
- 可读日志仅去尾空白，变化的原字节另存 gzip；原始外部回执未动。旧 63/77、类型错误及超时不被覆盖。

## 未完成边界与需拍板

重启恢复的精确 lease 在 recovered 集合中持续阻断，release 返回 false，当前没有可信核验后解锁/回收的正常产品入口；
legacy uncertain 同样没有在线清除入口，对相关联系人的个人范围、原群的群临时范围保守阻断，无关群不被全局阻断。
这不是可正常恢复运行的完整闭环。恢复/回收需后续独立合同与可信观察机制，本片没有扩架构实现。
没有验证完整 OS 后代监督、全量 npm test、gates:selftest、G-RED/G-STUB/G-TAUTO 或真实模型 A5；83 条窄测不能代替它们。
后续完整门禁由协调者接收冻结头后唯一启动，真实进程检查必须使用外置身份护栏，不能双跑或对真实系统进程发危险信号。
