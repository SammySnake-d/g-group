# PR #89 撤回时披露已发生的副作用(feat/retract-side-effect-disclosure)审查记录

## 第 1 轮

**结论:REJECT,交回作者返修。** 作者报的数字全部复现,生产改动确实只有 `appendUserEvent` 撤回分支内 18 行,事实来源本身是对的:审查人探针证实披露只取宿主记的任务出处(room + sourceSeq)和宿主写的 Compute 完成台账,联系人交付里说什么、说不说都不影响。拒绝有两条:

- **R1-01 测试守不住这个事实来源。** 授权时特意强调的「不能是联系人自述」「无副作用不披露」「不串任务」,审查人各改一处共 8 个单点故障,本片 8 项测试一个没杀,全部产品包测试 1495 条也一个没杀。
- **R1-02 本片自己的 4 项测试在红提交上不失败**,官方门禁 G-RED 红(另 12 项来自整支并入的 #71,单独定性,见「七」)。

另有 R1-04(「已发生」只认完成记录,比已合入的 rewind 口径窄,Compute 失败或还在跑时撤回一句不说)列为返修必修但不是本轮拒绝理由,R1-03 是收据陈旧。原「需拍板」三项按用户 DM#3361「我要你自己决策,对照文档和需求还有聊天记录这些」由审查人对照文档定了,见「七」,本轮没有留给用户的项。

### 一、身份、范围、固定版本

- 被审:`origin/feat/retract-side-effect-disclosure` HEAD `692ce6b207deb29fbded37982bb14a8ebe37acd3`,base `origin/feat/memory-hygiene`(#73)`c56dae7e3e3f564a4f5080712bfdde92081789d2`;整支并入 #71 `c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29`(是 HEAD 的祖先)。PR 是 draft。
- 审查人 `claude`,会话 `claude:618640cf-092c-44c3-8b19-306bb572d0d0`,模型 `group/opus`(宿主报的模型标识)。hy4 辅审因线路 403 未产出,本轮无辅审。
- 本轮在同一会话里被打断两次(11-14 00:24 线路 429、14:35 宿主升级),每次续做前都回读远端:三条分支(#89、#73、#71)的 HEAD 始终未变,本机克隆工作区干净。
- `node scripts/gates/run-all.ts --hash --branch=feat/retract-side-effect-disclosure --base=origin/feat/memory-hygiene` 原样输出 `2e914a990a3944c56975e9811296dc720df8dbbe3bf359cf39bac9e7b05e6d99`,与作者报的 CONTENT_HASH 一致;审查提交后复算不变。base 参数与作者交接包 `final-head/hash-command.json` 相同(收据本身不写 base)。这条命令在审查会话里跑过三次,输出相同:开工时带 `cd 克隆 &&` 前缀一次,审查提交后同样形式一次,最后用不带任何 shell 符号的形式 `node <克隆>/scripts/gates/run-all.ts --hash --repo=<克隆> --branch=… --base=…` 单独一次(门禁只认这种形式,见「八」)。
- 环境:本机独立克隆 `/tmp/pr89-r1-claude/repo`(Node v22.22.0:git、`--hash`、seatbelt 下 `--local`、门禁自检、单文件探针、本片 8 项下的审查人变异);重活在 box2 `/workspace/pr89-r1/`(Node v24.21.0,经 `heavy.lock` 排队,变异并发 2)。未改产品代码与测试。本克隆 `core.hooksPath` 为空,审查提交的推送不经 pre-push 钩子。
- 范围:本片相对 #73 + #71 的改动——`1c37721f` 的 `host.ts`(+18/−1)、两份新测试文件(RC01–RC04、RD01–RD04)、变异脚本与 proof/收据。合并提交 `1cb27157` 用 `--remerge-diff` 核过:冲突只在 import 行,留 #73 的 memory-hygiene 与 #71 的 chat-admin 两行,去掉 #71 一侧已被 #73 的 `HygienicMemoryStore` 取代的 `MemoryStore` 导入,没有夹带别的改动。#71 的 1181 行与 #73 的实现**不在本轮审查范围**。
- 合同:`origin/docs/dev-handbook`(`90226df5`)验收文档 AC-08、需求文档 C-US09 / C-US21、开发手册原则 71;授权边界 Mira Bot DM#3038 / #3042 / #3046。

### 二、复现数字(全部与作者一致)

| 项 | 作者报 | 本轮复现 | 位置 |
|---|---|---|---|
| typecheck / lint | 0 / 0 | exit 0 / exit 0 | box2 |
| 同体 8 项,HEAD | 8/8 | 8/8,fail/cancelled/skipped/todo 0 | box2 |
| 同体 8 项,红提交 `98da21c0` | 4 过 / 4 具名 ERR_ASSERTION | 4 过 / 4 红:RC03、RD01、RD03、RD04,4 条都是 `ERR_ASSERTION` | box2 |
| 依赖回归(#73 memory-hygiene + #71 chat-admin 服务端测试) | 14/14 | 14/14 | box2 |
| 全量 `npm test` | 1503/1503 | 1503/1503,skipped/todo/cancelled 0,exit 0(= 产品包 1495 + 门禁自测 8) | box2 |
| 作者 12 个具名变异 | 12 全杀 | killed 12 / survived 0,每个变异 4 项跑全,都由指定的具名测试以断言失败杀死 | box2 |
| 门禁自检(不经管道 `npm run -s gates:selftest`) | 219/219 | 用例 219/219,真实 exit 0 | 本机 |
| `run-all.ts --local`(review 为空时) | exit 1,RED 16、REVIEW 1 | exit 1;TRACE/STUB/TAUTO/WORKFLOW/LAYER 绿;G-REVIEW「还没有独立审查」;G-RED 16 项,与作者 `final-head/seatbelt/official-eight-gates.log` 逐字相同;G-PROVENANCE 短路显示 ✓ | 本机 seatbelt |
| GitHub self-check | 单次观察 QUEUED | 对 `692ce6b2`:completed / success(2026-11-12T17:58:09Z) | — |

逐项核对:

- 红提交 `98da21c0` 的父提交是 `dbb9744f`,不含修复 `1c37721f`;红提交上两份测试与 HEAD 逐字相同(`git diff` 为空)。4 条红都是业务断言:RC03「must explicitly disclose already-happened, cannot-retract effects」;RD01 系统通知条数期望 1 实际 0;RD03 同;RD04「do not return success after a failed disclosure append」期望 false 实际 true。
- `retract-composition.test.ts` 的 sha256 仍是 `fa590076…49dd3d`,从 `a03f1ac5` 起一字未改。
- 生产改动:`git diff 98da21c0 80aa646b -- packages` 只有 `host.ts` 19 行与变异脚本;`80aa646b..HEAD` 在 `packages/` 下无改动;没有碰 `scripts/`、`.github/`、`.githooks/`(没改门禁)。
- 收据 `red_snapshot_chronology` 如实:RD03/RD04 首次出现在修复之后的 `be2d3e58`,再放回不含修复的 `98da21c0` 回放,没有写成先于实现。
- 表述边界如实:收据 AC-08 状态「未测」,`unverifiable` 写明 Compute 是确定性替身、未上报副作用无法推断、follow-up 来源链与 R-Rule 和整套前端没证明;PR 说明同。本轮不把它升成通过。

### 三、生产改动核对(事实来源)

`packages/server/src/host.ts:1178-1205`(撤回分支):

1. 与撤回事件**同一事务**内,`listDocs("task:")` 找 `roomId === 本房间 && sourceSeq === 被撤回的 seq` 的任务。任务的 `sourceSeq` 只在宿主建任务时写:联系人 dispatch 时宿主校验来源必须是本轮新到的消息、不是系统通知、没被回退、没被手建任务占用(`host.ts:2780-2788`);用户手建任务是宿主替用户发的那条消息(`:1615-1622`);重跑继承原任务来源(`:1959`)。
2. 每个任务读 `gg_progress WHERE kind='completed'`。这张表只在 `onComputeEvent` 按适配器事件写(`host.ts:3236`;另一处 `:3474` 只写 `blocked`),联系人动作写不进去;联系人交付文字落在 `TaskDoc.result`(`:2907`),披露不读它。
3. 结果文字经 #73 既有 `scrubRetracted` 清掉撤回原文后写成 system 消息;`appendMessageTx` 失败整个撤回回滚;`afterAppend` 在提交后发布。system 发言者在已解散群照写(`:968`)、只作上下文不唤醒联系人(`:1020`)。

审查人探针(`scripts/zz-review-pr89.test.ts`,真实 Host + SQLite + service 撤回入口,确定性 Compute;不提交到被审分支)在 HEAD 上 9/9:

| 探针 | 场景 | HEAD 上的结果 |
|---|---|---|
| P1 | 联系人交付一句与台账不同的话,台账是 `LEDGER_FACT` | 披露只含台账,不含联系人那句 |
| P2 | Compute 已完成,联系人始终不交付 | 照样按台账披露 1 条 |
| P3 | 来源任务的 Compute 以 failed 结束 | 没有「已报告完成」 |
| P4 | 先发一条闲聊,再发一条派活并完成;撤回较早的闲聊 | 无披露 |
| P5 | 撤回后回读任务进度 | 完成台账原样;披露里的时间 = 台账完成时刻 |
| P6(观测) | 撤回时 Compute 还在跑,之后完成并写了文件 | 撤回时 0 条,完成后也 0 条;任务照常走到 T5 |
| P7(观测) | Compute 写了文件后以 failed 结束,再撤回来源 | 0 条 |
| P8(对照) | 与 P7 同一场景,先看 rewind 预览再撤回 | rewind 的 sideEffects = `[{compute, failed}]`;撤回 0 条 |
| P9(观测) | 同一任务台账里有两条完成记录 | 发 2 条通知 |

P1–P5 说明作者对事实来源的实现是对的;P6–P8 见 R1-04;P9 见「六」。

### 四、问题

#### R1-01 [P1] 测试守不住披露的事实来源:自构 8 个单点故障全部存活

授权的核心要求是「披露必须是宿主按任务出处 + 持久台账得出的事实,不能是联系人自述」「无副作用不披露」。审查人按这几类在 `host.ts` 撤回分支各改一处(脚本 `scripts/reviewer-mutants.mjs`;原样副本两路都是 1495/1495):

| 变异 | 改法 | 本片 8 项 | 全部产品包测试(box2) | 审查人探针 |
|---|---|---|---|---|
| R01 | 结果文字取联系人交付 `doc.result` | 存活 | 存活 1495/1495 | P1 红 |
| R02 | 有没有披露由联系人交付决定,不读完成台账 | 存活 | 存活 1495/1495 | P1、P2、P5 红 |
| R03 | failed / stopped 的 Compute 也说「已报告完成」 | 存活 | 存活 1495/1495 | P3 红 |
| R04 | 撤回较早消息时,把它之后的消息派生的任务也算进来(`!==` → `<`) | 存活 | 存活 1495/1495 | P4 红 |
| R05 | 披露后删掉该任务的完成台账 | 存活 | 存活 1495/1495 | P5 红 |
| R06 | 同一来源只看第一个任务(重跑任务与原任务共用来源) | 存活 | 存活 1495/1495 | 未构造探针 |
| R07 | 每个任务只披露第一条完成记录 | 存活 | 存活 1495/1495 | 未构造探针 |
| R08 | 披露时间写撤回时刻而不是台账完成时刻 | 存活 | 存活 1495/1495 | P5 红 |

根因:

- RD01 的夹具用 `scriptedMind`,它在 Compute 完成时交付「做完了:<台账 summary>」(`fakes.ts:36`),联系人自述里**原样包含**台账结果,`notice.text.includes(completed.summary)` 区分不了两种来源。断言消息「the outcome comes from the persisted ledger」和标题里的「completed ledger outcome」说守住了,实际没守住。
- RD02 的阴性对照只有「来源根本没派任务」一种;没有「来源派了任务但 Compute 失败」,也没有「来源之后另有任务」。作者变异 D01 只测了「把 completed 换成 failed」(漏报),没测反方向(把失败也报成完成)。
- 没有一条测试在撤回后回读完成台账,也没有对披露时间的断言。

完成判据:R01–R05、R08 各被一条具名断言杀死(P1–P5 可直接参考:夹具里让联系人交付与台账不同的话、或不交付);R06、R07 补用例,或在收据里写明「多任务同源、同任务多次完成未覆盖」。按 R1-04 改了取数口径后,R03 的期望相应调整(失败的运行要披露,但不能说成「已报告完成」)。

#### R1-02 [P1 / 门禁] G-RED:本片 4 项在红提交上不失败

本片 4 项逐条核过原因,**都是「这个行为在红提交上本来就成立」,不是红提交没改到**:

| 测试 | 在红上为什么通过 | 证据 |
|---|---|---|
| RC01 在途草稿不上屏 | 基线(#73 或更早)已有的行为 | 在 `a03f1ac5`(= #73 + 这份测试)上本机跑 3 过 1 红,只有 RC03 红 |
| RC02 阳性对照 | 不撤回时回复照常发布,哪个版本都成立 | 同上 |
| RC04 删 K 留 N | 基线(#73 或更早)已有的行为 | 同上 |
| RD02 无副作用不披露 | 红上根本没有披露功能,自然没有通知 | box2 红提交 8 项里 RD02 通过 |

补法(不改门禁、不弱化断言):按开发手册原则 71 做**变异校准红**——在红提交里把被钉住的生产行为临时改成错误形态,下一个提交还原成原字节,收据和提交说明写明改了哪个文件、改成什么、哪个提交还原。RD02 最自然的错误形态是「同屋任何已完成任务都披露」(作者变异 D02 的形态);RC01、RC04 要临时关掉基线上对应的级联;RC02 是纯阳性对照,可以并进 RC01(先断言不撤回时能发布,再断言撤回后不发布),也可以照原则 71 校准。另一条路是把 RC01、RC02、RC04 这三条见证基线已有行为的测试挪到只补测试的片子里,本片只留 RC03 与 RD01–RD04。原则 71 在本片冻结之后(11-13 23:26)才落档,这里引它是给补法,不算作者违规。

#### R1-03 [P3] 仓库内证据与收据有两处没跟上

1. `receipts/feat-retract-side-effect-disclosure.json` 的 `acceptance[0].reason` 写「官方门禁exit1，runtime计数0」,`docs/proof/retract-disclosure/coverage-index.json` 的 `official_gates.red` 列了 G-STUB、G-TAUTO、`runtime_named_test_counts: 0`——这是 box4 容器起不来那一轮。之后本机 seatbelt 的正式结果 STUB、TAUTO 是绿的,PR 说明和交接包已更新,仓库里这两处还是旧的。
2. 最后一个提交 `692ce6b2`、推送和 seatbelt 门禁实际由子代理完成(原生线程 `01a1d03a-add3-7a02-92d2-92e9791196ee`,`/root/loop_proof_finish`,gpt-6.1-sol);收据 notes 只写了父会话的原生号。按原则 71 把子代理线程号补进 notes,作为查记录的线索。

#### R1-04 [P2,返修必修,不是本轮拒绝理由] 「已发生」只认完成记录,比已合入的 rewind 口径窄

- rewind(AC-48,已合入)对同一个问题的做法:`rewind.ts:60-70` 把受影响任务在 `gg_compute` 里的**每一次运行**连同状态列为 sideEffects,回退说明写「有 N 项已经发生的外部操作(已运行过的 Compute 及其产出)不会被撤销」(`rewind.ts:82`,测试 `rewind.test.ts:215`);文件头注释是「已发生的外部副作用(起过的 Compute、已产出的结果)只如实列出」(`rewind.ts:4`)。
- 撤回(本片)只读 `gg_progress` 里 `kind='completed'` 的行。
- 实测差别:Compute 写了文件后以 failed 结束,rewind 把这次运行列为已发生,撤回 0 条披露,文件还在(P8);撤回时 Compute 正在运行,撤回时 0 条,之后它完成并写了文件,仍然 0 条(P6)。
- 这两种情况宿主台账里都有事实(`gg_compute` 记着这次运行和它的状态),不属于收据说的「无法推断的未上报副作用」。宿主不说话,用户会当成什么都没发生,和 AC-08「已发生副作用只标已发生、无法撤回」以及产品已有的说法(重跑说明 `host.ts:1952`「副作用做没做完不清楚」)不一致。
- 要求(仍在 `appendUserEvent` 一处,仍只读宿主台账,不动任务状态):对来源任务的每次 Compute 运行按台账状态如实披露。completed 报台账结果(现状);failed、stopped、还在运行的,只说运行过或还在运行、状态是什么,不声称结果,也不声称已经停下。取数直接复用 rewind 用的 `computeRuns`(`host.ts:1511`),两条路径一个口径。
- 阴性对照不变:来源没有派生任务,或任务从没起过 Compute,不披露。
- 为什么不算越权:授权原话(DM#3038)是「宿主按台账得出的事实(哪件任务、发生了什么)」,`gg_compute` 同样是宿主台账;「完成台账」是作者在 DM#3042 的提法。

### 五、来源核验

- 作者宿主会话 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`,`record.json` 的 `nativeSessionId` 是 `01a1cfc8-db89-7400-b3de-876bd8478982`。原生记录在 `~/.codex/sessions/2026/11/12/rollout-2026-11-12T20-43-29-01a1cfc8-db89-….jsonl`(会话 11-12 20:43 开始,所以在 11/12 目录;11/13 目录里只有当晚接手的两个新会话提到这些提交号)。`turn_context.model` 全程 `gpt-6.1-sol`。
- 父会话里按命令输出逐个核到提交(UTC):`a03f1ac5` 16:10:57、`ceaa3535` 16:11:29、合并 `1cb27157` 16:25:49、红 `dbb9744f` 16:28:04、修复 `1c37721f` 16:29:29、同体红 `98da21c0` 16:33:40(在 `dbb9744f` 的独立工作树上)、`be2d3e58` 16:34:20、`24f2f259` 16:37:19,合并 `80aa646b` 随后。
- box4 云端运行:父会话 16:46:37 的输出里有 `DISPATCH_PID=636890`,经 `/workspace/.heavy.lock` 排队跑 `run.py`;结果在 `docs/proof/retract-disclosure/cloud-out/`。
- 最后一个提交 `692ce6b2` 与推送:子代理(原生线程 `01a1d03a-…`,`parent_thread_id` 指向父会话,`gpt-6.1-sol`)17:34:28 输出 `[feat/retract-side-effect-disclosure 692ce6b2]`;17:37:10 执行 `git push --set-upstream origin HEAD:refs/heads/feat/retract-side-effect-disclosure`,推之前断言了 `core.hooksPath=.githooks`、工作区干净、#71 与 #73 远端 HEAD 未变;本机 seatbelt 门禁由同一子代理在 17:53:19 起运行(与交接包记的 01:53:19 北京时间一致)。父子同一模型。
- 交接附件 SHA256 `db3cc0bc…57760` 与派活说明一致,解到新的空目录只读:`manifest.json` 57 个成员逐个 SHA 一致;`candidate-complete.bundle` 里 `feat/retract-side-effect-disclosure` 的头是 `692ce6b2`、`proof/retract-disclosure-red` 的头是 `98da21c0`。
- 核到的程度:提交、模型、云端派发、推送、门禁运行都在原生记录里对上了时间和输出。没有核的:box4 上那次运行的机器侧日志(只看了仓库里留的结果与本轮在 box2 的独立复现)。

### 六、未列为问题的观察

- 同一任务台账里有几条完成记录就发几条通知(P9:两条完成记录发 2 条)。任务被审查打回或补充条件后再次完成时会出现。条数和措辞按授权是候选;按 R1-04 改取数时可以合并成每个任务一条。
- 披露把 Compute 的完成摘要写进聊天、搜索索引和联系人下一轮上下文。`scrubRetracted` 只清**整段**撤回原文(4 字以上);摘要里如果只引了撤回原文的一部分,披露会在撤回之后把这一部分重新写出来。这是 #73 清洗契约的既有语义(授权不改清洗实现),RD03 只测了整段,标题「never copies withdrawn source text」比断言宽,返修时可把标题收窄到「整段原文」。
- 每次撤回都扫一遍全部任务文档(`listDocs("task:")`),任务多时是线性开销;不影响正确性。
- 披露的 `message.appended` 先于被撤回消息的 `message.updated` 发出,界面上会先看到通知、再看到原消息变成已撤回。

### 七、按文档定的处置(原「需拍板」)

用户 DM#3361:「我要你自己决策,对照文档和需求还有聊天记录这些」。下面三项审查人对照文档定了,不再留给用户。

1. **整支并入未审依赖 #71 时 G-RED 的 12 项:不改门禁,不出豁免,#71 先独立审完合入,#89 返修后落到含 #71 的基线上重跑。** 这 12 项不是本片缺陷:本片红提交上 #71 的实现已经在,它的测试当然不会按名失败。但 `reviewed_hash` 覆盖的是整个分支相对 #73 的内容,含 #71 的 1181 行,本轮只审了本片,**不替 #71 背书**。依据:DM#3085「G-RED 判什么就记什么」、不为变绿改门禁、PR #88 第 1 轮对同一情况的同一口径。#71 的收据 `review` 仍是空的,作者是 Claude(`claude:dd154965-…`),按原则 68 要由 Codex 或 Astra 审,Claude 不能审。
2. **撤回源消息时任务还在跑(P6):按需求 C-US09 另开一片,不挂在 #89 上。** 需求原文:「用户说『先别弄了』(或撤回源消息)…收到 E4 把任务转成取消中(T9)…宿主运行时再强制执行一次取消并确认进程确实停了,才转到已取消(T10)」。rewind 已经这样做(`rewind.test.ts:215` 任务取消并等停止确认);撤回现在不停任务,任务照常跑完并把交付回复到已撤回的消息上。这要动任务状态机,超出本片授权(DM#3038「只动 retractMessage / appendUserEvent」「T5 不改」)。在那一片落地前,R1-04 让撤回时至少如实说出「还在运行」。
3. **Compute 运行过但没完成(P7、P8):定为要披露,口径对齐 rewind,列为 R1-04。** 理由见 R1-04。

没有需要用户定的项。要协调者安排的两件:派 #71 的独立审查(Codex 或 Astra);把第 2 项排进后端作者线。

### 八、写入审查后的门禁(本机 seatbelt,原样)

`node scripts/gates/run-all.ts --local --branch=feat/retract-side-effect-disclosure --base=origin/feat/memory-hygiene`,真实 exit 1:

```text
受检文件 90 个 收据=receipts/feat-retract-side-effect-disclosure.json 门禁 8 个
✗ G-PROVENANCE
    - 审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash,无法证明审的是这一版
    - 审查那一轮的厂商认不出
✓ G-TRACE
✗ G-REVIEW
    - 审查结论是 reject
✗ G-RED   (16 项,与审前逐字相同:#71 的 chat-admin 测试 12 项 + 本片 RC01、RC02、RC04、RD02)
✓ G-STUB
✓ G-TAUTO
✓ G-WORKFLOW
✓ G-LAYER
CONTENT_HASH=2e914a990a3944c56975e9811296dc720df8dbbe3bf359cf39bac9e7b05e6d99
```

- G-PROVENANCE 的两条是同一个原因,出在审查会话的记录形式上,不是来源有问题:跑这次门禁时,宿主已落盘的是前两轮(被 429 和宿主升级打断的那两轮),里面的 `--hash` 调用带 `cd 克隆 &&` 前缀,`isHashCall`(`scripts/gates/gates.ts:163-171`)见到 shell 符号就不认;没有命中,厂商也就取不出。不带 shell 符号的那次调用在当前这一轮,宿主要到本轮结束才写记录。所以本轮结束后这两条应当消失,但这一点本轮没法自己验证,原样记在这里。
- G-PROVENANCE 对作者一侧没有报问题(宿主会话 `codex:76d2c467-…` 里有对本仓库的操作,产出厂商与收据一致)。它不核对提交号,真正的核对见「五」。
- G-REVIEW 红是因为结论是 reject,符合预期。
