# U08/U09 创建个人与群临时额度：作者候选（云行为已完成，官方 Docker 沙箱阻断）

基线为PR #84冻结3cfabba2978e3b617a07c86b962eba5fd8e4d411，在独立feat/create-quota副本实现。产品3文件与c371b712897596aff6c89ef143f20809678ab5e0逐字节一致；当前测试加强后的产品绿为8c3d078e22e566b9fb743f43180a0a9703c01dbd。

## 当前已实际观察

- 修改前：service接受但静默丢弃contacts.create.computeSlots和rooms.createGroup.tempComputeSlots；个人文档无额度（走宿主默认），群默认0。同动作号重投会创建新实体。baseline-before.json保留完整返回。
- 修改后：创建与更新复用同一schema范围（个人null/1..64，群0..64）。联系人配置、首版历史与动作结果同一SQLite事务；群、成员、额度与动作结果同一事务。沿用recordAction；重投返回原响应，种类隔离，改参数冲突；通知只在首创提交后发送。
- Host.createContact的putDoc+recordContactConfig仍同事务；没改QuotaTable、释放算法、G4或C/C2，也没改前端。个人回调仍用computeSlots??宿主默认，群仍用本群room-slots。
- 首个CQ01修改前具名ERR_ASSERTION红；冻结13项原实现全红。第一次绿12/13，唯一剩余错误为测试误假定既有成员排序。校准为实测contact-before-user顺序，不删额度/成员断言；全部当前测试体在红0b5bd6c9db5ccd72bb3da7f72ade51b86ca0be55重跑13个具名ERR_ASSERTION，再绿13/13，skip/cancel/todo0。失败原件保留。
- 本机typecheck/lint exit0；create-quota-real.ts真Host/service/SQLite（无模型）exit0：创建额度2/3、非法额度拒绝、动作插入故障不残默认实体、任务/消息/游标保留、配置历史[3回滚2,2修改1,1创建2]、跨重启返回原创建结果、不同参数conflict、重放不覆盖后来群额度0。
- CQ12/CQ13走实际Host/QuotaTable/任务取消路径，受控scripted适配器只控制停止确认时序：新额度驱动个人/本群租约，不借别群，下调保留在途，T9仍持有，停止确认后T10才释放；未证明真实CLI/子进程停止或模型质量。

## box4 已完成的七个行为阶段

冻结 HEAD 为 `e1b91fc123148d637ddfd5db0db64ba6efdba4bf`，Node `v24.21.0`，本线私有缓存和固定 package-lock；七个 `@g-group/*` 依赖 realpath 均在本线 repo/packages。共享 `/workspace/.heavy.lock` 中依次实际执行，结果均 exit 0：

1. 原样 CQ01-CQ13：13/13，skip/cancel/todo 为 0。
2. 17 个预登记变异：17/17 被各自指定 CQ 具名 `ERR_ASSERTION` 杀死，survivedOrInvalid=0；每轮完整执行13项。没有把超时、加载或解析失败算成杀死。
3. `create-quota-real.ts`：真实 Host/service/SQLite 无模型 proof 通过。
4. 继承 Q03 `contact-config-history-real.ts`：真实 md 记忆、索引、任务、消息和游标保留及配置回滚/跨重启回归通过；脑子为控制时序的 scripted 适配器。
5. typecheck exit 0。
6. lint exit 0。
7. 全量1498/1498，fail/skip/cancel/todo 均为0。

原始行为归档 `cloud-behavior-raw.tar.gz` 为133130字节，SHA256 `76303e174c05ddb49fa25ef8b46d78f7ac978d198109406acba02dfedb297930`；45个成员逐一做大小/SHA256校验。里面包含完整绿色和1498项TAP、17项变异各自原始TAP、JSON登记、source-freeze、依赖身份、生产proof及实际命令回执。`cloud-behavior-analysis.json`逐项核验具名断言并保留所有 collateral，不能把“指定判据被杀死”写成“只影响一个判据”。

| 变异 | 指定判据 | 具名 ERR_ASSERTION | 其他判据失败数 |
| --- | --- | --- | --- |
| M01 | CQ01 | 是 | 6 |
| M02 | CQ01 | 是 | 5 |
| M03 | CQ02 | 是 | 5 |
| M04 | CQ02 | 是 | 6 |
| M05 | CQ02 | 是 | 4 |
| M06 | CQ03 | 是 | 0 |
| M07 | CQ04 | 是 | 0 |
| M08 | CQ05 | 是 | 1 |
| M09 | CQ06 | 是 | 1 |
| M10 | CQ07 | 是 | 2 |
| M11 | CQ08 | 是 | 1 |
| M12 | CQ09 | 是 | 1 |
| M13 | CQ10 | 是 | 1 |
| M14 | CQ07 | 是 | 0 |
| M15 | CQ08 | 是 | 0 |
| M16 | CQ12 | 是 | 1 |
| M17 | CQ13 | 是 | 0 |

## 官方 Docker 门禁：真实失败，未豁免

同一 e1b91fc1 冻结输入在行为阶段后执行原样 `scripts/gates/run-all.ts --hash/--local`。CONTENT_HASH 为 `956800445b0db1a2b6fd2eee75f73529ce62ec385b548fa5255ed31389570774`。G-TRACE、G-WORKFLOW、G-LAYER 输出通过；G-REVIEW 缺独立审查；G-RED、G-STUB、G-TAUTO 输出失败。G-PROVENANCE虽显示通过，但 review=null 提前返回，不能算来源实核。

随后原样调用门禁导出的 `runNodeTests`，实际输出 `exitOk=false, passed=[], failed=[]`：Docker daemon 在 overlay snapshot 挂载返回 `err: invalid argument`，因此官方沙箱中0项测试启动。三项机械门禁仍保持失败；不能用本机门禁绿或云上直接Node行为绿代替它，也不能把0执行声称为产品断言失败。没有修改共享daemon、存储驱动、能力或门禁参数；共同基础设施由根协调。

先前镜像拉取曾在daemon DNS路径报 `network is unreachable`，原exit1保留。通过用户网络获取官方registry索引/manifest/config（临时公用token不持久化），逐字节验证已有image导出config及所有rootfs diff_ids相同，才导入官方内容并复用 `node:22.22.0-slim`。官方config SHA为 `e894118949319b479bfc3e16e545cb2f85b7a2194aa86ea9cd4e29538f2b13c3`。v2执行器曾把Docker containerd的目标manifest Id误当config digest做比较而停止；原失败保留，v3改用实际导出config原字节与rootfs核验，没有放松或改动任何门禁/测试断言。最终仍如上记录Docker overlay运行失败。

官方门禁原始归档和成员校验见 `cloud-official-gates-verification.json`；它保留原拉取失败、v2执行器错误、v3真实门禁及 `runNodeTests` 原始诊断。最后的证据/收据提交不改3产品文件与测试/变异/production输入；其新CONTENT_HASH及本机最终门禁单独在交付包实录，不将旧e1b91fc1 hash冒充最终hash。

## 范围和未完成项，不提升完整AC-23

HelperDesk当前仅context/note/history/post，没有创建入口；登记#64/Q13前置，不混入本片。ContactView既有投影不含computeSlots，本片只扩创建入参及持久配置，不另造UI；可由已有contacts.history核对配置版本。

CQ12/CQ13仅为真实Host/QuotaTable路径配合scripted适配器的停止时序证明；未证明真实CLI/子进程停止或模型质量。AC-23其他子项、前端用户操作和Helper创建前置未完成。review=null，作者未自签、不合并、不发布、不自派审。官方Docker运行阻断仍需解决；最终包由根发Mira Bot并协调独立跨厂商审查。

## 机械门禁校准失败与修复（原始失败保留）

本机初次机械门禁exit1：G-TRACE因README尚未纳入Git；G-RED报告CQ03/CQ04未红；G-REVIEW仍缺。实际复现表明继承门禁snapshot/node_modules/@g-group/api-contract的realpath指向绿候选，而不是红快照（gate-inherited-api-identity.json）：13项中11红、范围拒绝2项碰巧通过，不能冒称原门禁通过。未修改门禁、未删测试或断言、未动3产品文件。

CQ03/CQ04保留全部非法值拒绝及零残留断言，补上同项合法边界必须真的在Host持久化的正向判据。加强测试的同体红069bbd20b7ef925e9043a54b94b4276760e09a59在3cfabba原产品上13个具名ERR_ASSERTION，绿8c3d078e22e566b9fb743f43180a0a9703c01dbd 13/13。加强部分的红控制发生在原产品patch之后，属于明确的回溯校准，不能冒称这部分先于原patch；最初具名红及17项预登记保留在原历史。测试SHA256为92173f61eb60c74c411711068828a9b67176e09569c44fdafb56c9275670283c。17项变异定义JSON规范化SHA256仍90aaaa7ae173faa1effd082af01c2b6d92d2ede39d2e0adf565f199f80b6f5f2，定义未改。

既有门禁的跨工作区包重绑定缺陷未在本片修改；本片单独红/绿与云变异runner需绑定全部@g-group依赖到被测副本。将来的机械G-RED通过也不替代该身份检查。

Git文本副本只清理行尾空格与尾部空白行；原始字节保存在raw-log-whitespace-originals.zip，前后SHA映射见log-byte-provenance.json。原始执行结果未改判。
