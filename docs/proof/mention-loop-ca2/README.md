# Q14 / U15 防联系人无限互唤：CA2 叠加作者证明

本片是候选，不是完整需求文档验收，也未合并或发布。作者为 Codex 原生子会话 codex:01a1d03a-add3-7a02-92d2-92e9791196ee，模型 gpt-6.1-sol。review=null，独立跨厂商审查与真实来源核验由 Mira Bot 安排，作者不自签。

## 冻结对象与依赖

- 受测源码 e1e8ab02912a90335496c2172577ff72da57d46c；受测阶段 gate hash 93d79a180491033553d06c4e20310d6d7e22179636c06d3c6a33badecc6d4e93（此时尚未加本证明与收据，不是最终提交的 hash）。最终 HEAD 只增加证明和收据，526份受测文件必须保持原字节。
- 真正 PR base 为 feat/contact-call-check（#79），固定 3968d49756e93ed7f01545ae996290f1e86fc49b；完整 #71 feat/chat-admin 固定 c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29 由真实合并提交 37118a3dfb40c3d93ca9cecbbdd0165eaee3bf00 引入。两个原分支均未修改，不移植最小通知代替完整依赖。
- Mira Bot DM #3000/#3011 授权只在本叠加分支做三处并集：Host同时保留 rejections:RejectionFeed / chatAdmin:ChatAdmin 字段、两项构造初始化；pointers 精确保持 [...rejectionPointers(shownRejections), ...claimable, ...pointers, ...mem.pointers, ...this.chatAdmin.muteNotes(contactId)]。没有顺手改预算/装配方式/相对次序；G4 #69/#82 落地后必须再次对接。
- maxHops 默认4仍为候选参数，未获产品批准；仅 Host 构造选项可配，未声称 UI/持久设置已经做完。

## 变更行为

同根联系人派生唤醒共享持久次数和滚动一分钟频率。额度/频率触限后过滤自动唤醒，并复用 #71 的真实 postSystemNotice 给每根最多一条停止说明；同根消息重放、跨会话派生、重启待处理唤醒不能重置额度；用户新输入建立新根可续话。这是机械因果控制，不推断话题语义。

保留 CA2 的同轮拒绝完成声明过滤、非法逐个@校验、@everyone展开及去重。reply、dispatch卡、deliver、CA2 claim卡四类输出一并继承 causeRoots。新增具名接缝05实际装配验证同一轮同时有拒绝回告、可认领任务、禁言事实，不只是文字解冲突。

## 实际验证（本轮新组合，box4 Node v24.21.0）

- 回溯红 e520a78acff82db54407cf0231081450ee27aa20：旧10条+新5条均为具名 ERR_ASSERTION；同一测试体在候选绿15/15。红对照在已有实现后补跑，不证明历史先写规格。
- 原15项严格单点变异保留，新加7项CA2/并集接缝变异；22/22预定具名断言杀死，0存活。每个旧变异完整跑10条、每个新变异完整跑5条，退出1且无超时/skip/cancel/todo。解析器分别区分真断言、加载错误、普通ERR_ASSERTION字样异常与超时；后3者不能充当杀死。
- contact-call-check/contact-actions/chat-admin 回归24/24。
- 真实 createService / Host / SQLite / 注意循环 proof：配置2跳，首段3轮，用户续话后累计6轮；重启前确有1个待处理唤醒，重启额外0轮；@everyone保留，每根停止通知1条。scripted mind，不是真实模型质量、前端/UI或完整Compute验收。
- typecheck=0、lint=0；新全量1522/1522，无 fail/skip/cancel/todo，实际210.721秒。11个阶段全部有退出回执及日志SHA；源码冻结前后526份tracked文件逐项一致。
- 原始数据见 cloud-results.tar.gz，SHA256 1755461d1b1a12f08611082ea9c9fda2d93ebd549cf6d3035f21a1b1089f0439；cloud-summary.json逐项列目标名/失败名/完整数量；source-freeze.json列受测文件SHA。旧版#71基线1495结果没有算作本组合全量。

## 补齐R-05具名事务判据

原15+7变异虽然全部严格命中，事务回滚那条只曾附带失败，没有自己的预定目标。为避免把附带失败追认为指定判据，本次另排同一box4重锁，独立副本增加1个**外部证明夹具**：只在LoopGuard已有事务分支插入提前COMMIT/BEGIN。`earlyCommit=true` 完整10条中9绿1红，唯一目标在loop-guard.test.ts:126:10出现ERR_ASSERTION（中止事务后本应可唤醒，实际false）；同一注入代码仅切 `earlyCommit=false` 恢复完整10/10绿，原样对照也10/10绿。4类解析器对照全部正确，526份受测源码仍逐字节不变。

这是原22项之外的1个补充阳性/单开关阴性，不把原同run改称23项。r05-coverage.json映射本片全部15具名判据；不拿它代替整个#71、完整需求或独立审查。原始包 transaction-supplement.tar.gz SHA256 98ca7d0a2d880384e2921e89e956f4f2f160d58a8bb1b7459c6f5eefefe1c931。

## 机械门禁

本轮在 box4 对真实 CA2 base 执行未改动的 `node scripts/gates/run-all.ts --local --branch=feat/mention-loop-guard-ca2 --base=origin/feat/contact-call-check`，8门禁实际退出1，3.913秒。外层runner退出0只表示留存结果，不表示门禁通过。

- G-TRACE、G-WORKFLOW、G-LAYER 机械通过。
- G-REVIEW 红：没有独立审查。
- G-RED 红54项、G-STUB 红1项、G-TAUTO 红27项：官方Docker沙箱在Node启动前失败，具名运行计数为0。不能据此说产品测试失败、桩已杀死或真实测试同语反复；也不能宣称这些门禁通过。相对CA2还继承完整#71测试，环境恢复后必须连同继承范围如实重跑，不换假base。
- G-PROVENANCE打印绿是 `review=null` 的机械短路，**不是来源实核通过**；真实native作者元数据只是线索，独立审查会话尚不存在。

官方Node镜像不是改装诊断版。正常Docker pull退出1（daemon DNS network unreachable）；经官方crane发行包与checksums取得同一官方平台manifest7cc56ef2/confige8941189，加载后逐项确认Config/RootFS五层diff_ids/amd64/linux匹配。真实docker run退出125：containerd overlayfs mount invalid argument。没有改共享daemon、snapshotter、网络、组或socket；镜像声明NODE_VERSION=22.22.0不冒充实际容器Node版本运行成功。v3版本核验前置失败未跑门禁；v4只去掉自己执行器的成功前置，以便实际执行原官方门禁并记录失败。详见 mechanical-gates-v4.json / mechanical-gates-v4.tar.gz。

最终证明/收据提交之后另有一次final-HEAD官方门禁结果，随最终交付包提供；本受测源码阶段记录不冒充final-HEAD结果。

## 保留的执行器错误与边界

新7项runner最初把已注册5条误校准为10条。提交e1e8ab02只改这个计数守卫；窄校准实测原守卫误拒完整5条，修后接受完整5条，仍拒缺条/非零退出/有失败。没有改变产品断言或旧15项变异。记录见 runner-count-calibration.json。

box3 ENOSPC后未确认启动新长run，未将ECONNRESET视作产品结果；Bot #3019授权改box4持久自有/workspace/req-loop-ca2-20261113，所有重活正常使用/workspace/.heavy.lock。首次大上传因网关1MiB请求上限HTTP400、远端未执行；改分片传自足bundle后，核对远端SHA才运行。Docker普通用户连接权限失败，使用任务局部sudo wrapper，不改共享socket/daemon/用户组；官方node:22.22.0-slim拉取也进入同一队列。

AC-30/AC-31完整产品链、真实模型/CLI E2E及UI未验；默认4未定，G4接缝待后续重对。任何机械通过不代替跨厂商独立审查或真实来源核验。
