# U08/U09 创建个人与群临时额度：作者候选（尚未完成云验收）

基线为PR #84冻结3cfabba2978e3b617a07c86b962eba5fd8e4d411，在独立feat/create-quota副本实现。产品3文件与c371b712897596aff6c89ef143f20809678ab5e0逐字节一致；当前测试加强后的产品绿为8c3d078e22e566b9fb743f43180a0a9703c01dbd。

## 当前已实际观察

- 修改前：service接受但静默丢弃contacts.create.computeSlots和rooms.createGroup.tempComputeSlots；个人文档无额度（走宿主默认），群默认0。同动作号重投会创建新实体。baseline-before.json保留完整返回。
- 修改后：创建与更新复用同一schema范围（个人null/1..64，群0..64）。联系人配置、首版历史与动作结果同一SQLite事务；群、成员、额度与动作结果同一事务。沿用recordAction；重投返回原响应，种类隔离，改参数冲突；通知只在首创提交后发送。
- Host.createContact的putDoc+recordContactConfig仍同事务；没改QuotaTable、释放算法、G4或C/C2，也没改前端。个人回调仍用computeSlots??宿主默认，群仍用本群room-slots。
- 首个CQ01修改前具名ERR_ASSERTION红；冻结13项原实现全红。第一次绿12/13，唯一剩余错误为测试误假定既有成员排序。校准为实测contact-before-user顺序，不删额度/成员断言；全部当前测试体在红0b5bd6c9db5ccd72bb3da7f72ade51b86ca0be55重跑13个具名ERR_ASSERTION，再绿13/13，skip/cancel/todo0。失败原件保留。
- 本机typecheck/lint exit0；create-quota-real.ts真Host/service/SQLite（无模型）exit0：创建额度2/3、非法额度拒绝、动作插入故障不残默认实体、任务/消息/游标保留、配置历史[3回滚2,2修改1,1创建2]、跨重启返回原创建结果、不同参数conflict、重放不覆盖后来群额度0。
- CQ12/CQ13走实际Host/QuotaTable/任务取消路径，受控scripted适配器只控制停止确认时序：新额度驱动个人/本群租约，不借别群，下调保留在途，T9仍持有，停止确认后T10才释放；未证明真实CLI/子进程停止或模型质量。

## 未完成，不提升结论

17项具名故障已在产品patch前登记，runner绑定登记且显式TAP、验证每个@g-group依赖realpath；**云变异尚未运行**。box3启动器在创建/tmp/cocoonbox-shell脚本前ENOSPC，尚无本片云进程，也没有占共享锁。已遵根指令停止新云尝试，等根恢复；不清共享盘、不动别人runner。云全量/变异/继承Q03真实md记忆回归、最终正常push与PR均待完成。

HelperDesk当前仅context/note/history/post，没有创建入口；登记#64/Q13前置，不混入本片。ContactView既有投影不含computeSlots，本片只扩创建入参及持久配置，不另造UI；可由已有contacts.history核对配置版本。

review=null，作者未自签。G-PROVENANCE的null短路不是来源已实核；仍需Mira Bot安排独立跨厂商审查。完整AC-23的其他子项与真实进程验收不在本片已证明范围。

## 机械门禁校准失败与修复（原始失败保留）

本机初次机械门禁exit1：G-TRACE因README尚未纳入Git；G-RED报告CQ03/CQ04未红；G-REVIEW仍缺。实际复现表明继承门禁snapshot/node_modules/@g-group/api-contract的realpath指向绿候选，而不是红快照（gate-inherited-api-identity.json）：13项中11红、范围拒绝2项碰巧通过，不能冒称原门禁通过。未修改门禁、未删测试或断言、未动3产品文件。

CQ03/CQ04保留全部非法值拒绝及零残留断言，补上同项合法边界必须真的在Host持久化的正向判据。加强测试的同体红069bbd20b7ef925e9043a54b94b4276760e09a59在3cfabba原产品上13个具名ERR_ASSERTION，绿8c3d078e22e566b9fb743f43180a0a9703c01dbd 13/13。加强部分的红控制发生在原产品patch之后，属于明确的回溯校准，不能冒称这部分先于原patch；最初具名红及17项预登记保留在原历史。测试SHA256为92173f61eb60c74c411711068828a9b67176e09569c44fdafb56c9275670283c。17项变异定义JSON规范化SHA256仍90aaaa7ae173faa1effd082af01c2b6d92d2ede39d2e0adf565f199f80b6f5f2，定义未改。

既有门禁的跨工作区包重绑定缺陷未在本片修改；本片单独红/绿与云变异runner需绑定全部@g-group依赖到被测副本。将来的机械G-RED通过也不替代该身份检查。

Git文本副本只清理行尾空格与尾部空白行；原始字节保存在raw-log-whitespace-originals.zip，前后SHA映射见log-byte-provenance.json。原始执行结果未改判。
