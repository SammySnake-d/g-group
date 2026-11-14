# PR #91 共享「停止并清理进程」(feat/shared-process-cleanup)审查记录

## 第 1 轮

**结论:REJECT,交回作者返修。** 作者报的数字全部复现,搬迁逐字节相同,分层门禁的放行规则没有比「适配器 → process 层」更宽的方向;但自构探针查出两处会改变现有 Claude Code 接入行为的实质问题(R1-01、R1-02),另有测试缺口(R1-03)和收据来源字段问题(R1-04)。本片的首要标准是「不破坏现有 Claude Code 接入的停止行为」,R1-01 直接违反。

### 一、身份、范围、固定版本

- 被审:`origin/feat/shared-process-cleanup` HEAD `229fb95a1ea26ce16d12ca1cf253442c865dfe80`;冻结 base 用提交号 `3216bb1eeff5d1f0229b610cd37cb90e92db48c5`。开工与定稿前各回读一次远端:`feat/compute-port-extract` 仍指向 `3216bb1e`(#90 的审查提交尚未追加),HEAD 未变。
- 审查人 `claude`,会话 `claude:16a18628-e644-4da6-9ce7-ca3a8ad65181`,模型 `group/opus`(宿主报的模型标识)。hy4 辅审因线路 403 未产出,本轮无辅审。
- `node scripts/gates/run-all.ts --hash --branch=feat/shared-process-cleanup --base=3216bb1eeff5d1f0229b610cd37cb90e92db48c5` 原样输出 `2a0d5ec2de53bbf912f2a1d399e0459199f98ba9251cbe97f8d7c0673d46542c`,与作者报的 CONTENT_HASH 一致;审查提交后复算不变。
- 环境:本机独立克隆 `/tmp/pr91-r1-claude/repo`(Node v22.22.0,只做 git、`--hash`、seatbelt 下 `--local`、门禁自检与小探针);重活在云电脑 box2 `/workspace/pr91-r1/`(4 核,经 `heavy.lock` 排队)。未改产品代码与测试。本克隆 `core.hooksPath` 为空,审查提交的推送不经 pre-push 钩子。
- 只审 #91 相对 `3216bb1e` 的 26 个文件(+920/−163)。合同:`origin/docs/dev-handbook`(`ff5bd712`,v3.31)需求文档 §8.1 已定第 16 条与验收文档 AC-23。

### 二、复现数字(全部与作者一致)

| 项 | 结果 | 位置 |
|---|---|---|
| 原 CC 七个测试文件,base `3216bb1e` | 139/139,fail/cancel/skip/todo 0 | box2 |
| 原 CC 七个测试文件,HEAD | 139/139,同上 | box2 |
| 新包自有 + CC 新增(4 文件) | 15/15 | box2 |
| 旧导出 / 常驻桥接 | 2/2 | box2 |
| typecheck / lint | exit 0 / exit 0 | box2 |
| 全量 `npm test` | 1502/1502,skip/cancel/todo 0,exit 0 | box2 |
| 作者 9 个具名变异 | killed 9,survived 0,源码未变 | box2(一次性副本内,只跑自己起的进程树) |
| 门禁自检(不经管道 `npm run -s gates:selftest`) | 用例 223/223,真实 exit 0 | 本机 |
| `run-all.ts --local --base=3216bb1e`(review 为空时) | TRACE/RED/STUB/TAUTO/WORKFLOW/LAYER 绿,G-REVIEW「还没有独立审查」,G-PROVENANCE 短路显示 ✓,exit 1 | 本机 seatbelt |
| GitHub self-check | COMPLETED / SUCCESS(2026-11-12T18:49:36Z,对 229fb95a) | — |

逐项核对:

- 搬迁:`3216bb1e:packages/adapter-cc-compute/src/procgroup.ts` 与 `packages/process-tools/src/procgroup.ts` sha256 同为 `f17a879b…a91bf4`,`diff` 无输出。CC 侧 `procgroup.ts` 现在只有 2 行转出,6 个运行时导出与 `ProcRow` 类型齐全(删掉其中一个导出:typecheck exit 2,桥接测试红)。
- 原 7 个 CC 测试文件 `git diff 3216bb1e..HEAD` 为空;新增的是 `shared-process.test.ts` 与 `proof/shared-process-bridge.test.mjs`。
- 一次性(`adapter.ts`)与常驻(`resident.ts`)两条路径的回收都改为 `cleanup.requestStop(...)`,确认都走 `cleanup.quiesce(...)`,没有留下第二份停止实现;一次性路径的 SIGTERM→到期组 SIGKILL→主进程先退清计时器的时序由原 F-03 测试钉住(去掉清计时器那行,F-03 红)。
- seatbelt 下 `ps` 被拒:改动只在两个新测试文件的 `live()` 观测函数里加了 pgrep 退路(pgrep 也不可用就抛错);产品里「读不到就拒绝确认」没有被削弱,反而比 base 更严(base 是停止时与此刻都读不到才拒绝,现在是主进程退出后那一次读不到就拒绝)。
- 红:收据 `redIsRetrospectiveCalibration: true`、README「retrospective red calibration … not a claim that every witness was written before implementation」如实写明 15 条红是事后回溯校准。G-RED 以 `red.commit = 19139462` 实际判绿;把 `red.commit` 换成已是绿的 `1cb9279d`,G-RED 对 10 个用例判「放到红提交的实现上没有按名字失败」。
- 历史失败原件仍在交接包里:`cloud-v1/npm-middle.log`(npm ci EUSAGE,缺 workspace lock)、`cloud-middle-v5/layer-cli-failure-observed.txt`(云端无沙箱 exit 1)、`middle-push-pr/normal-push.log`(旧一次推送自检「自检失败 … 222/223」被钩子管道掩盖)。ZIP SHA256 `8010752b…7a620d07`,146 个成员。
- 表述边界:收据 AC-23 状态「未测」,README 与 PR 说明都写明不是 Codex 接入、不是 Host 接线、不是真实 CLI 集成、不是 AC-23 整项验收;双 fork / 系统托管不在保证范围、Windows 整树 fail-closed 在 `procgroup.ts` 注释、README、PR 说明里如实写了。包名与位置在 README 标为 candidate。

### 三、门禁改了什么(单列,供用户过目)

1. `scripts/gates/gates.ts`(2 行):`LAYERS` 在 kernel 与 adapter 之间加 `"process"`;`ALLOWED` 加 `process: []`,`adapter` 由 `["domain","kernel"]` 变成 `["domain","kernel","process"]`。其余层的放行表一字未动。
2. `scripts/gates/selftest.ts`(+17/−1):R5-03 的冻结期望串由 `domain,kernel,adapter,plugin,app` 改为 `domain,kernel,process,adapter,plugin,app`(只多这一层,同一用例里其余期望未动);新增 4 个用例(1 正:adapter 依赖 process 放行;3 反:adapter→adapter、kernel→process、domain→process 判失败)。
3. 新增 `scripts/gates/process-layer.test.ts`(5 条直接调用 `layers.run` 的测试)。

审查人补的 12 个应失败输入全部判失败(`process→domain/kernel/adapter/app`、`plugin→process`(devDependencies 声明)、`app→process`(子路径 import)、`kernel→process`(动态 import)、`domain→process`(require)、adapter 经 `export *` 依赖 adapter、两个 process 包互相依赖、kernel 用相对路径进 process-tools、未知层名)。放行规则按包自己声明的 `gGroup.layer` 判,不按路径前缀,同名目录冒充不了别的层。

需要用户知道的两点:

- **口子按「层」开,不按「包」开。** 任何新包只要自己声明 `gGroup.layer: "process"`,所有适配器就可以依赖它(实测放行);两个适配器也可以经同一个自称 process 的包共用任意代码。门禁不检查 process 层的包里实际是什么。这与其它层的做法一致,但比「唯一一个带进程 I/O 的共享底层」宽。是否钉死到唯一包名见「需拍板」。
- **候选分支自检通过 ≠ 主干门禁已接受。** 可信门禁用主干自己的 `gates.ts`;在这次门禁改动进入可信分支之前,旧的五层名单会把 `packages/process-tools/package.json` 判为「缺合法的 gGroup.layer」。

各门禁应失败输入(一次性克隆里提交反例后跑候选分支的 `run-all.ts --local`):G-TRACE(标通过不写证据)、G-REVIEW(审查人=作者、同厂商、hash 不符)、G-RED(见上)、G-STUB 与 G-TAUTO(`assert.equal(1, 1)`、调了不判结果)、G-WORKFLOW(`pull_request_target`)、G-LAYER(kernel import process-tools)、G-PROVENANCE(会话不存在)均判失败。

### 四、问题

#### R1-01 [P1] 常驻适配器一轮 failed 后,宿主被判「停止未确认」且不归还槽位(base 没有这个行为)

位置:`packages/adapter-cc-compute/src/resident.ts:644-656`(新增的 `quiesce`),调用方 `packages/server/src/host.ts:3448-3459`。

base 的常驻适配器没有 `quiesce`,宿主 `afterRound` 对 failed/stopped 走 `settled()` 后归还槽位。本片给常驻适配器加了 `quiesce`,它要求这个 Compute 的每个清理句柄的主进程都已退出;但常驻进程在一轮以 failed 结束(CLI 报执行出错、Compute 汇报放弃、汇报被拒收且没有合规重报)后是按设计继续驻留的。宿主对 `failed` 调 `quiesce` → 等 `reapForceMs + 5000ms` → `{ok:false, reason:"CLI 主进程没有退出"}` → 任务挂上「停止未确认:CLI 主进程没有退出(pid …)」,`giveBack` 不执行,槽位一直占着。`server/src/compute.ts` 的正式接线用的就是常驻适配器。新测试 S-PROC-CC-02 还把「一轮结束、进程在 → `quiesce` 返回 false」写成了期望。

复现(探针 `p1-host-failed-turn.test.mjs`:真实 `Host` + 真实常驻适配器 + 仓库自带假 CLI,包一层把 result 改成执行出错;base 与 HEAD 各跑一次):

```text
base: run=failed 之后 9 秒 waitingFor 一直为 null,无 stop-unconfirmed 报告,adapter.quiesce 为 undefined
HEAD: run=failed 之后约 5 秒 waitingFor="停止未确认:CLI 主进程没有退出(pid 20599)",stop-unconfirmed 报告 3 次
```

原 CC 139 条与全量 1502 条都发现不了:宿主测试用的是脚本化假适配器。

返修要求:先补红——宿主 + 真实常驻适配器层面的具名测试,断言一轮 failed 后不出现 stop-unconfirmed、槽位归还(与 base 一致),且 `stop` 之后仍要真确认全部退出才算停止;再改实现。若想改成「失败即结束常驻进程」,那是行为变更,需用户点头(见「需拍板」)。

#### R1-02 [P1] 常驻保留的旧清理句柄会在主进程退出很久之后按 pid 重新枚举并发 SIGKILL,pid 被复用时杀掉无关进程

位置:`packages/process-tools/src/cleanup.ts:42-48, 62-91`;`packages/adapter-cc-compute/src/resident.ts:431`(每起一个进程就 `st.cleanups.push`,从不移除)、`:650`(每次 `quiesce` 遍历全部句柄)。

`quiesce` 每次调用都 `capture()` 并 `treeNow(pid)`:按 `ppid == pid` 与 `pgid == pid` 重新找「后代」,再对 `-pid` 发组 SIGKILL、逐个 SIGKILL。句柄不记「已确认过」,也不核对那个 pid 现在还是不是原来的进程。base 里这个窗口是「停止后几秒」(原注释写明忽略);本片让常驻会话把历次进程(空闲 10 分钟回收、换模型兜底重启都会产生)的句柄留到会话结束,窗口变成会话全程——数小时前退出的旧主进程的 pid 被别的程序占用后,下一次失败或停止的确认会把占用者的子进程和进程组杀掉。

复现(探针 `p2-pid-reuse.test.mjs`,全程只用测试自己起的进程:一个带 1 个子进程的进程组充当「后来占用同一 pid 的无关程序」,句柄的 child 是桩对象,pid 取它的 pid、`exitCode = 0`、`kill` 不发信号):

```text
quiesce(1500, 0) → {"ok":true,"killed":1};无关进程组长被 SIGKILL,它的子进程也被杀
```

返修要求:句柄确认成功后要记住结果,此后不再按 pid 枚举或发信号;常驻适配器把已确认的旧句柄移出列表;主进程退出后的那次枚举要能排除「不是这个主进程留下的」进程(例如只认捕获时记下的进程与当时的同组成员,或比对启动时间)。新增具名测试只用替换掉的 kill 函数或自己起的进程树验证,不对非自有进程发信号。

#### R1-03 [P2] 自构 18 个单点故障存活 8 个,作者自列的重点「常驻保留旧清理句柄」没有测试

box2 上逐个注入(只缩窄或推迟清理,不放宽信号目标),每个都跑新包 3 个测试文件 + 原 CC 七文件 + 桥接:

| 故障 | 结果 |
|---|---|
| 后代判定只看同组 / 只看父子链;僵尸算活(两处);`ps` 失败当空表;pgrep 失败当空表;强杀计时器在主进程先退时不清;转出口漏一个导出;`requestStop` 不先捕获;只杀组不逐个杀 | 均被具名测试杀死(10 个) |
| A6 常驻 `quiesce` 只确认最后一个句柄(丢掉旧进程的句柄) | **存活** |
| A7 常驻兜底重启 / 空闲回收前不捕获 | **存活** |
| A1 确认循环里不再刷新已知进程的新后代 | **存活** |
| A10 一次性 `stop` 前不捕获(冻结后直接组 SIGKILL 的那条路径) | **存活** |
| A12 主进程退出后读不到进程表、但早先捕获过 → 仍继续确认 | **存活** |
| A13 `requestStop` 不幂等(S-PROC-03 标题写「escalates once」,去掉幂等仍绿) | **存活** |
| A16 常驻 `quiesce` 不等主进程退出(等待时限改 0) | **存活** |
| A11 Windows 改回报成功 | **存活**(POSIX 上跑不到,`IS_WINDOWS` 是模块常量) |

返修要求:至少为 A6、A7(真实常驻适配器:重启或空闲回收一次后,旧进程留下的脱组子进程在 `stop` + `quiesce` 后必须退出)、A1、A12、A13 各补一条能被杀死的具名测试;A11 给一个可注入平台判断的测试或在收据里写明未测。A10 是 base 就有的缺口,顺带补。

#### R1-04 [P2] 收据 `author.session` 写的是 Codex 原生子线程号,G-PROVENANCE 判「会话记录不存在」;仓库内收据与 README 仍是推送前的旧状态

位置:`receipts/feat-shared-process-cleanup.json` 的 `author.session`、`verification.cloud`、`unverifiable`;`docs/proof/shared-process-cleanup/README.md`「Pending」一节。

填上 review 后 `run-all.ts --local` 原样结果:

```text
✗ G-PROVENANCE
    - 作者会话不可信:会话记录不存在:codex:01a1d043-1042-7e61-9981-968868c25de1
    - 审查会话不可信:会话记录不存在:claude:16a18628-e644-4da6-9ce7-ca3a8ad65181
✗ G-REVIEW
    - 审查结论是 reject
其余六项 ✓,CONTENT_HASH=2a0d5ec2…,exit 1
```

第二条是审查会话的 `turns.jsonl` 要到本轮结束才写出,属已知时序。第一条是真问题:门禁只认 `~/.mirasim/sessions/<harness>/<id>/turns.jsonl`,`01a1d043-…` 是 Codex 原生子线程号,不是宿主会话号。宿主会话是 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`(其 `record.json` 的 `nativeSessionId` 为 `01a1cfc8-…`,即 `01a1d043-…` 的父线程)。

另外,仓库里的收据仍写 `"cloud": "not started; root owns queue"`、云端全量与原 CC 基线「remain pending」,README 仍写「No cloud process has started」;这些已被后来的云端运行取代,只在 PR 说明里更新了。PR 说明自己写了「源码中的 proof/receipt 是先前冻结快照」,不算隐瞒,但仓库是长期记录。

返修要求:`author.session` 改为宿主会话 `codex:76d2c467-…`,原生线程号放 `contributingSessions` 或 notes;返修提交时把收据与 README 的云端、基线状态更新为实际结果。改完后 G-PROVENANCE 对宿主会话实际判什么,下一轮原样记录(宿主会话的 `turns.jsonl` 目前只有 2 行,提交都发生在子线程里,门禁能否认出来未验证)。

### 五、来源核验(核到哪一步)

门禁读不了 Codex 原生记录,也不查接手链;以下是用原生记录人工核的。

- 定位:9 个提交全部出自原生线程 `01a1d043-1042-7e61-9981-968868c25de1`(`~/.codex/sessions/2026/11/12/rollout-2026-11-12T22-56-58-01a1d043-….jsonl`)。它的 `session_meta` 显示是 `01a1cfc8-…` 派生的子线程(`agent_path: /root/coverage_invariants_tests`,最初为别的片子开的,后来接着做了多片);`turn_context.model` 全程 `gpt-6.1-sol`,与收据一致。父线程 `01a1cfc8-…` 对应宿主会话 `codex:76d2c467-…`。
- 提交:9 条 `git commit` 的输出都在该线程里,时间与 git 提交时间逐一对上(UTC):3091ca6 17:01:44、9cae32b 17:17:24、baa0f75 17:25:42、bccc9b9 17:29:03、7279aab 17:29:49、1913946 17:34:47、0f88b6e 17:35:19、1cb9279d 17:55:26、229fb95 18:20:02。
- 红:baa0f75 提交前的输出是 `# tests 15 / # pass 0 / # fail 15`。最终红提交 1913946 的 15 红输出没有逐条去找,改由本机 G-RED 以它为红提交实判绿来核。
- 冻结点与失败:0f88b6ec 云端 `npm ci` EUSAGE(17:53:57);1cb9279d 只改 `package-lock.json`;云端单体 runner 在门禁自检处「没有可用沙箱」exit 1(18:05–18:06);首次推送(新分支,1cb9279d)钩子日志里是「自检失败 … 223/223」加一条 R5-03 `✗ 放行`(18:17);229fb95 只改 `selftest.ts` 一行;第二次推送 `1cb9279..229fb95`(18:35:04)。
- 云端:基线与候选 CC 139/139(17:57–18:05)、9 变异 killed 9(18:11)、全量 1502(18:12)都早于 229fb95 的提交时间,是在 1cb9279d 上跑的;PR 说明写的是「继承结果已逐源码 seal 核相等」,与此相符(229fb95 相对 1cb9279d 只多 `selftest.ts` 一行)。本轮在 229fb95a 上独立重跑,数字相同。
- 本机门禁:19:15 的输出六项绿、`CONTENT_HASH=2a0d5ec2…`,与本轮一致。
- 没核到的:云端那几次运行确实发生在 box4(记录里只见「parent owns box4 admission」与队列回执,没有逐条对机器);父线程 `01a1cfc8-…` 里的调度命令没有逐条看;更早的两段会话(`codex:534f3614-…`、`claude:dd154965-…`)与本片 9 个提交无交集,未查。

### 六、其它记录(不算本片问题)

- `.githooks/pre-push:7` 的 `npm run -s gates:selftest | grep -v '^✓'` 在 `set -e` 下只看 grep 的退出码,base 上就有;本轮自检是不经管道跑的。
- 本机有 6 个 `codex-wire-test` 夹具进程(Node 25.8.1,03:19 与 03:30 起,工作目录在别人的 `gate-run-*` 下)和一批 11-12 上午的假 CLI 进程残留,都不是本审查起的,也不属本片,未动。
- #90、#77 未审完,本轮没有看它们的差异。

### 七、需拍板

1. process 层要不要钉死到唯一包名(只有 `@g-group/process-tools` 可以声明这一层)。现在任何包自称 process 层就能被所有适配器依赖。建议钉死;这要改门禁,需用户点头。
2. 一轮失败后常驻进程的去留(R1-01 的修法)。建议保持 base 行为:进程驻留、槽位归还,只有 `stop` 之后才要求确认全部退出。
3. Windows。本片把 Windows 上的确认从 base 的「报成功」改成「一律拒绝确认」,宿主在 Windows 上每次停止或失败都会停在「停止未确认」。Windows 不在范围就保持现状并写明;在范围就得另做。
4. 门禁改动进入可信分支的顺序:在此之前可信门禁会拒绝新包的层名。

### 八、清理

见审查提交后的回报(本机 `/tmp/pr91-r1-claude`、云端 `/workspace/pr91-r1/` 清理量与残留进程数)。证据留在 `deliverables/g-group-pr91-r1-claude/`。
