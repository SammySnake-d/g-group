# 第十七轮：同步观察与混合点名单开关

## 身份与合同

基线 ee1b1f4，base afd0256；规范 origin/docs/dev-handbook f12aa3b 的需求 §8.1 已定 17、验收 §9。内核只判定插件交回值；拒收不执行插件代码、不改写对象。内置原型预先被修改不在合同内。本轮没有以冻结内置对象构造新的拒审理由。

红提交 8dab2f4：保留全部既有测试，加 R17-01/02/03，源码恢复已有红壳。box2 实跑 225 条具名失败、0 pass/skip/todo；这是对既有实现的后补红对照，不能证明旧实现最初遵守 TDD 时间顺序。绿提交 896baa3 恢复内核实现并修 copyTree；8f2f862/6f201a8 只修测试体外 lint 注释范围，断言/测试体不变。

Node 24.21.0 与实际 Docker Node 22.22.0 全仓各 248 通过，其中内核 225。所有旧用例保留。R17 的数量是有限校准范围，不是完整产品验收。

## 沿用与重做

Claude 未提交 plugins.ts / returned.ts 不采用；原件留到推送确认后归档清理。其结构重构以可调试性为目标，但 throwOnSideEffect 会把仅创建 Promise 异步事件也判为副作用，无法分辨“有事件但无对象写入”阴性对照。本轮在 box2 自行复现，而非信任其结论。

改用 node:inspector Debugger 的实际源码可停点：每次暂停与预先独立保存的描述符比较。测试进程不改写或冻结受检对象/内置方法。内置对象从本 realm 原生构造器经数据描述符闭包取得，包含 Map/WeakMap.prototype；不是把两个名字追加到旧手列清单。

同一观察器实际校准：已有值赋值、defineProperty、Reflect.set；Map.prototype defineProperty/删除；WeakMap.prototype Reflect.defineProperty/删除。每种都做无事件、有 Promise 事件两侧；不写的两侧都不误报；返回后快照恢复不影响暂停期写入的检出。产品路径覆盖 send/pull × then/constructor × async_hooks 开关。

边界：V8 调试停点不是逐机器指令；本测试不声称可观察没有可停位置的任意原生操作。动态对象闭包不声称涵盖所有跨 realm 对象、符号属性闭包或宿主扩展；这些边界必须保留。K250/K251 来自审查的两个存活单点故障；K252 来自混合点名条件删除；K253–K257 扩充写法/事件。新 8 项要求各自指定 R17-01/02/03 发现者，不以文件级失败或别的测试误伤代替。

## 扫描线索与待厘清

Claude box1 扫描归档：classify 120 个机械改动，95 killed/25 survived。只作候选线索；前置 plainData、slice 对索引的语义等会使部分条件删除等价或受前置条件屏蔽，25 不等于 25 个产品缺陷。本轮独立锁定 R16-02，未把其他未分类存活项冒称解决。

纯 U+200B/U+0085 撤回文本规范化为空，仍可存在于 volatile；普通中性正文命中拒收，去掉文本后放行，见 r17-invisible-boundary.txt。这是实测边界、待厘清项，不在此擅自修改合同或升格成已确认违约。

## 沙箱复制链

中性假 HOME 的原始路径在 Docker 内读不到；旧 copyTree 解引用链接后却能读到被复制的内容（r17-isolation-before.txt）。现在在变换副本前拒绝非普通文件或 realpath 越出仓库；普通仓库内文件继续复制。R17-04 正/反夹具与 linked-copy 单点故障实际在 Docker 中标定。

R15-03/04/05 分别在真实容器校验工作区依赖解析到副本、依赖目录只读、基线逐文件加载/执行计数。容器定点变异 5 项全杀，不用“无容器报错”作为负例成功。全门禁自检原样通过，完整日志位于 scripts/gates/proof/r17-selftest.txt。

作者 astra / codex:5593bcd9-26ef-4286-92ec-0a8c25bcce2a / shayu/gpt-6-astra；历史作者 Claude、DeepSeek、Astra。review 字段保留第十六轮原样。写审分离：本文件是返修证据，不是 APPROVE。

仓库内文本证据仅去行尾空白以满足 Git 检查；完整原始 TAP/状态码保留在 evidence-r17.tgz（SHA-256 38e6ace70c271a72827cc4254c6be48250eda016c0fa124198698c5066fece1d），不改测试结果。

## 最终门禁阻塞

最终 `--local` 使用 `flock -w 3600 /workspace/.heavy.lock` 排队；锁持续由另一 PR 审查持有。超过等待窗口后队列进程已退出，CLI 输出及状态文件未创建，因此八门都没有本候选的最终运行结果，不能把 118 条门禁自检代替它。R-03/R-04 如实改为未测。不跳过门禁强推：尚未推送、未更新 pipeline；既有远端仍 ee1b1f4。原始证据、独立克隆及 bundle 保留以供继续，Claude 原克隆按用户条件只在推送回读成功后清理。

最终门禁随后已拿到锁并完成：314a33e 上六门通过，G-PROVENANCE 因云端无会话目录失败，G-REVIEW 保留原 reject/同源/旧 hash 失败；前一节“未执行”仅保留为中间过程，不是最新状态。R-03/R-04 已凭实跑改为通过。没有为了满足“除审查外全绿”去伪造来源或降门禁。
