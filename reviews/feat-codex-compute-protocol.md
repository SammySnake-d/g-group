# PR #93 Q08 Codex 原生协议薄片(feat/codex-compute-protocol)审查记录

## 第 1 轮

**结论:REJECT,交回作者返修。** 作者报的数字全部复现,范围没有越界(不造 session manager、不搬 CC 工具表、不注册 Host/start/G2、拒收非空 tools、请求的模型与 steer 回执都没有冒充成实际模型或语义遵从),真实 Codex 0.167.2 上的 resume 同线程、错 turn 拒收、steer 回执、interrupted 终态和进程表确认的 quiesce 也由审查人独立复现。驳回原因:简报点名的几项协议判定(interrupt 终态种类、steer 回执的 turn、resume 回来的线程号)和启动时写死的 sandbox/approvalPolicy/HOME 在 17 条测试里都没有守住——审查人自构 15 个单点故障 15 个全部存活(R1-01);HOME、只读沙箱、never 审批三项启动决定没有完整写进合同(R1-02);逐行同步 `ps` 捕获加只增不减的进程表,把 #91 R1-02 的 pid 复用误杀窗口放大到 app-server 整个生命周期(R1-03);收据会话号与状态问题与 #91 R1-04 相同(R1-04)。

### 一、身份、范围、固定版本

- 被审:`origin/feat/codex-compute-protocol` HEAD `4ea651ceb57af71381a39a738e7702a1f8250294`(draft,PR base 分支 `feat/shared-process-cleanup`);冻结逻辑 base 用 PR #91 的 `229fb95a1ea26ce16d12ca1cf253442c865dfe80`(收据没有 base 字段,按 README「Frozen prerequisite: PR91 229fb95a」与简报)。远端 `feat/shared-process-cleanup` 现在是 #91 的审查提交 `2ec80a5d`,本轮只审 #93 相对 `229fb95a` 的 34 个提交、12 个文件(+977/−0)。开工与定稿前各回读一次远端,HEAD 未变。
- 审查人 `claude`,会话 `claude:fd6da05b-4f12-4778-9e76-fc2d1b792365`,模型 `group/opus`(宿主报的模型标识)。hy4 辅审因线路 403 未产出,本轮无辅审。
- `node scripts/gates/run-all.ts --hash --branch=feat/codex-compute-protocol --base=229fb95a1ea26ce16d12ca1cf253442c865dfe80` 单独一条命令原样输出 `2c949f116e17b72ce1da0ee091b1b44305b15464aaaade1db7fc1ef7eab74fd9`,与作者报的 CONTENT_HASH 一致。
- 环境:本机独立克隆 `/tmp/pr93-r1-claude/repo`(Node v22.22.0,只做 git、`--hash`、seatbelt 下 `--local`、门禁自检、红提交单文件、小探针与真实 Codex 驱动);重活在云电脑 box1 `/workspace/pr93-r1/`(经 `heavy.lock` 排队,变异串行)。未改产品代码与测试。本克隆 `core.hooksPath` 为空,审查提交的推送不经 pre-push 钩子。
- 合同:`origin/docs/dev-handbook`(`90226df5`)需求文档 §2.0「做 / 不做」判据 4、7(不做 harness、Compute 层不做审批/权限拦截、按联系人授权白名单启动)、§8.1 已定第 16、21 条,开发手册原则 71(收据写宿主会话号);用户 11-13 定的边界(Compute 的 harness 归 Codex/Claude Code,接入层只是启动/停止外部程序的薄壳,停止清理用 #91 的共用 process-tools)。

### 二、复现数字(全部与作者一致)

| 项 | 结果 | 位置 |
|---|---|---|
| 原 CC 七个测试文件,base `229fb95a` | 139/139,fail/cancel/skip/todo 0 | box1 |
| 原 CC 七个测试文件,HEAD | 139/139,同上 | box1 |
| 本片 `protocol.test.ts` | 17/17,同上 | box1 |
| typecheck / lint | exit 0 / exit 0(218 文件,1 info) | box1 |
| 全量 `npm test` | 1519/1519,skip/cancel/todo 0,exit 0 | box1 |
| 作者 17 个具名变异(`mutation-check.py` 原样) | killed 17,每个都由指定的 CXP 测试 `ERR_ASSERTION` 杀死,无超时,源码未变 | box1 |
| 原版 M10(`turns.values().next().value`) | CXP-12 按名失败后整套挂起,120 s 被执行器杀掉 —— 与作者说的「两次 90 秒超时不计 kill」一致 | box1 |
| 红提交 `0bbacb05` 上同一测试文件(sha256 `f1d42f58…`,与 HEAD 逐字节相同) | 17/17 按名失败,全部 `ERR_ASSERTION`/`testCodeFailure`,无加载错误 | 本机 |
| 门禁自检(不经管道 `npm run -s gates:selftest`) | 用例 223/223,真实 exit 0 | 本机 |
| `run-all.ts --local --base=229fb95a`(review 为空时) | TRACE/RED/STUB/TAUTO/WORKFLOW/LAYER 绿,G-REVIEW「还没有独立审查」,G-PROVENANCE 短路显示 ✓,exit 1 | 本机 seatbelt |
| GitHub self-check | COMPLETED / SUCCESS(2026-11-12T19:58:10Z,对 4ea651ce) | — |

逐项核对:

- 红:`0bbacb05` 把 `protocol.ts` 换成全部返回 `not implemented` 的空壳,`e6c354aa` 还原;README 与收据 `redIsRetrospectiveCalibration: true` 如实写明是回溯校准、不是测试先于实现。空壳红只证明每条测试对「整个组件不存在」敏感——CXP-05/06/07 在空壳上是在第一句 `initialize().ok` 处失败,不是在拒收断言处;具体判定靠作者 17 个变异校准。
- `4ea651c` 只改 `mutation-check.py` 一行(把 M10 收窄成「按 id 找不到才退回第一个 turn」);`e6c354a` 到 `4ea651c` 生产代码与测试逐字节相同。作者实驱用的 `f5587177` 与 HEAD 的 `protocol.ts` 只差 `send()` 的返回类型标注。
- 交接附件(ZIP sha256 `5d18a456…`,229 个成员)解到新空目录只读,`MANIFEST.json` 列的 228 个成员 sha256 与字节数逐一相符、无清单外文件。

### 三、边界核对(简报点名的几项)

| 简报要核的 | 结论 | 依据 |
|---|---|---|
| 是否自造 harness / session manager | 没有。线程、历史、持久化都交给原生 `thread/start`、`thread/resume`;组件只记请求 id 与 turn id 的对应 | `protocol.ts:55-57,84-101` |
| 是否搬 CC 工具表 / 造权限拦截 | 没有搬工具表;非空 tools 一律拒收(`:37`)。服务器发来的任何请求(含审批)一律回 `-32601`(`:113-114`),不接审批通道、不放行——在 `approvalPolicy:"never"` 下这条路径本不该被走到,属兜底拒绝,不算 Compute 层审批 | §2.0 判据 7 |
| 空 tools / read-only 是否如实写明「不等于禁掉全部 native builtins」 | README 与收据 `unverifiable` 都写了「Empty tools is NOT asserted to disable native built-ins」「read-only sandbox is NOT treated as per-tool authorization」。但没写「每个线程都被强制只读、覆盖 owner 配置」与 HOME 被改写,见 R1-02 | README「Contract and scope」 |
| 错 turn 拒收 | 本地先拒(`:194`),错 id 不上线(CXP-04 断言请求里没有 `foreign-turn`);真实 Codex 复现 | 实驱 B-steer-wrong |
| steer ack 不冒充语义遵从 | 只回 `{turnId}`,README 写明;但「回执里的 turn 是不是我要的那个」这条检查没有测试,见 R1-01 F03 | `:197` |
| interrupt 终态 | 要等到同一 turn 的 `interrupted` 终态才回 `interrupted`(`:206-208`),只有回执不算(CXP-13 守住);但「等到的是 completed/failed 也照样报 interrupted」没有测试,见 F01 | 实驱 B-interrupt |
| resume 同 thread | 发 `thread/resume`、核对回来的 id(`:169-171`);真实 Codex 换新进程后接回同一线程(新 pid,`started.resumed:true`)。「回来的是另一个线程」与 `ephemeral` 都没有测试,见 F02、F23 | 实驱 B-resume |
| quiesce 以进程表确认而非主进程 exit 0 | 是。走 #91 的 `cleanup.quiesce`,主进程退出后还要按进程表确认后代都退出(CXP-11 + M12 守住);主进程 exit 0 而没有终态 → `failed`(CXP-08 + M11 守住,真实网关 403 那次也是这样收尾) | `:222-227` |
| requested model 不冒充实际模型 | 是。`started`/`completed` 不带 `model`/`models`,实驱结果写 `observedActualModelClaimed:false` | `:66,81` |

### 四、问题

#### R1-01 [P1] 简报点名的协议判定和启动参数没有测试:自构 15 个单点故障全部存活

box1 上逐个注入(每个只改 `protocol.ts` 一处,跑同一份 17 条测试;未改动的对照 17/17 通过):

| 故障 | 改了什么 | 结果 |
|---|---|---|
| F01 | interrupt 等到任何终态都报 `interrupted`(`:208` 去掉 `kind === "stopped"`) | **存活** |
| F02 | resume 不核对回来的线程号(`:171`) | **存活** |
| F03 | steer 不核对回执里的 turn(`:197` 删掉) | **存活** |
| F09 / F10 | `startTurn` / `settled` 不核对 thread(`:177`、`:211`) | **存活** / **存活** |
| F06 | resume 后不置 `resumed`(`started.resumed` 恒为 false) | **存活** |
| F23 | `thread/start` 改成 `ephemeral: true`(真实 Codex 上这样的线程接不回来) | **存活** |
| F04 | `sandbox: "read-only"` 改成 `"danger-full-access"`(start 与 resume 两处) | **存活** |
| F05 | `approvalPolicy: "never"` 改成 `"on-request"`(两处) | **存活** |
| F18 | 不再把 HOME 改成 configDir | **存活** |
| F08 | 进程关闭时不清掉在途请求(只能等 timeout) | **存活** |
| F14 | quiesce 不先关 stdin(全套从 3.6 s 变 21.5 s,仍全绿) | **存活** |
| F28 | quiesce 到时不升级为 SIGTERM/组 SIGKILL(原生进程不理 EOF 时永远等不到) | **存活** |
| F07 | 早期事件缓冲去掉 64 条上限 | **存活** |
| F13 | 不再逐行捕获进程表 | **存活**(见 R1-03,这条机制本身没有测试依据) |

原因很一致:假线协议(`test-support/native-wire.mjs`)只会给「正确」的回应——resume 永远回同一个 id、steer 不匹配就报错、interrupt 永远回 `interrupted`、收到 EOF 就退出、不看 `sandbox`/`approvalPolicy`/`ephemeral`。真实 Codex 实驱也只走到这些正常分支。README 自己说「This component's same-body tests are the executable contract for this bounded slice」,那么这几条判定目前不在合同里。

另:测试没有逐测试超时,原版 M10 这种「让下一个 turn 永远不落定」的故障只能靠执行器 90/120 s 超时发现,不按名失败。

返修要求:先补红——假线协议加对应的错误回应(interrupt 后回 `completed`、resume 回别的 id、steer 回执带别的 turn、收到 EOF 不退出、关闭时有在途请求、超过 64 条早期事件),并断言 `thread/start`/`thread/resume` 实际发出的 `sandbox`、`approvalPolicy`、`ephemeral:false`、子进程环境(HOME/CODEX_HOME)、resume 后 `started.resumed === true`;每个上表故障都要有一条按名杀死它的测试。测试加 `timeout`,让挂起类故障按名失败。

#### R1-02 [P2] 启动时三项写死的决定(HOME、只读沙箱、never 审批)没有完整写进合同

位置:`protocol.ts:104`(`HOME: options.configDir`)、`:160`、`:169`(`approvalPolicy: "never", sandbox: "read-only"`)。

- **HOME 被改成联系人配置目录**:Codex 进程和它替模型跑的每条命令都拿到 `HOME=<configDir>`。CC 适配器保留真实 HOME(`adapter-cc-compute/src/cli.ts:178`),隔离只靠 `CLAUDE_CONFIG_DIR`。后果:命令里的 `~`、git/ssh/npm 的用户配置都找不到,工具缓存写进联系人配置目录(AC-29 说这个目录只放设置与会话记录)。实驱里模型跑的 `/bin/zsh -c echo HOME_IS=$HOME; sleep 4` 就在这个环境里。README、收据都没提。
- **每个线程强制只读 + 不审批**:覆盖 owner 配置(本机 owner `~/.codex/config.toml` 是 `danger-full-access`)。README 只说「read-only 不等于逐工具授权」,没说「本组件起的线程一律不能写工作区」——接上之后 Codex Compute 不能改任何文件。§2.0 判据 7 的说法是「Compute 维持按联系人授权白名单启动」,启动范围应来自联系人授权,不是适配器写死;作为未接线的薄片先用最严的默认可以,但要写明是占位。

返修要求:README 与收据把这三项写成合同条款(写死了什么、覆盖了什么、对接入后的影响);HOME 要么与 CC 一致保留真实 HOME,要么写明理由;三项都要有 R1-01 里的测试守住。启动范围怎么定见「需拍板」。

#### R1-03 [P2] 逐行同步 `ps` 捕获 + 只增不减的已知进程表:阻塞宿主事件循环,并把 #91 R1-02 的误杀窗口放大到 app-server 整个生命周期

位置:`protocol.ts:109`(每读一行 native 输出就 `cleanup.capture()`);`process-tools/src/cleanup.ts:17`(`capture` 是一次同步 `execFileSync("ps -A …")`)、`:42-48`(`known` 只 `set` 不删)、`:81-89`(quiesce 对 `known` 里 pid 与进程组都对得上的行连同其后代 SIGKILL)。

- 阻塞:组件会跑在宿主进程里,每行输出都同步执行一次 `ps -A`。审查人实驱计数(只计组件自己的 `ps`/`pgrep`):第三次 89 次共 1876 ms(均 21 ms,最大 48 ms),第一次 16 次共 1468 ms(均 92 ms,最大 348 ms);一轮短回复 13–19 行。长任务、流式增量越多,阻塞越长。
- 误杀:`known` 记下 app-server 一生中出现过的每个后代,永不清理。实测 Codex 替模型跑的命令自成进程组(`/bin/zsh -c …` pid = pgid = 99658,子进程 `sleep 4` 同组)。这样一行在命令结束后一直留着;等这个 pid 被另一个自成一组的无关进程复用(任何 detached/setsid 启动、任何有作业控制的 shell 起的进程),下一次 `quiesce` 的 `stillAlive`(只比 pid 与进程组)判它「还活着」,连同它的后代一起 SIGKILL。#91 的窗口是「常驻会话里历次 CLI 进程的句柄」,这里是「app-server 跑过的每一条命令」。
- 复现(探针 `p-reuse/probe.mjs`,只用探针自己起的进程:无关进程组 U = `sh` 组长 + 1 个 `sleep` 子进程;假 `ps` 在第一轮期间多报一行「U 是 app-server 的子进程、自成一组」,模拟该 pid 之后被 U 复用,之后恢复真实进程表):

```text
settled → completed;quiesce(1500) → {"ok":true,"killed":2};U 与它的子进程 quiesce 前都活着,之后都被杀
```

返修要求:这一条的根在 #91(R1-02),修法跟随 #91 的返修(确认过的行不再按 pid 发信号、能排除「不是当时那个进程」)。#93 自己:不要逐行捕获(改为在 `turn/started`、命令开始等少数时点捕获,或低频定时),每次捕获剔除已不存在的行;#91 修完后 rebase 到新 base,补「已退出命令的 pid 被无关进程组复用后 quiesce 不碰它」的具名测试(只用替换掉的进程表或自己起的进程)。

#### R1-04 [P2] 收据 `author.session` 写的是 Codex 原生子线程号;仓库内收据与 README 仍是推送前的 pending 状态

位置:`receipts/feat-codex-compute-protocol.json` 的 `author.session`、`verification.cloud`、`verification.namedMutants`;`docs/proof/codex-compute-protocol/README.md`「Cloud full/type/lint/17 owning … remain pending」。

- `author.session` = `codex:01a1d043-1042-7e61-9981-968868c25de1`,是原生子线程号;宿主会话是 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`(其 `record.json` 的 `nativeSessionId` 为 `01a1cfc8-db89-…`,即 `01a1d043` 的父线程)。开发手册原则 71(11-13 23:26 新增,晚于本 PR 的推送)要求写宿主会话号,子线程号放 notes。G-PROVENANCE 填 review 后的实际判定见下面「来源核验」。
- 收据 `cloud: "pending"`、`namedMutants: "pending"`,README 也写这些「remain pending」;交接包里已有 e6 的云端全量、原 CC 基线与 17 变异结果(本轮在 4ea 上独立重跑,数字一致)。PR 说明与交接 README 写明源码里的是冻结快照,不算隐瞒,但仓库是长期记录。

返修要求:`author.session` 改为宿主会话,原生线程号写进 `contributingSessions`/notes;返修提交时把收据与 README 的云端、变异状态更新成实际结果。

#### R1-05 [P3] 记录项(不单独阻塞)

- `stopped` 事件的 `scope: "main-then-group"` 不实(`:70`):这是轮级 interrupt,组件没有发任何信号。实测确认 interrupted 后 app-server 主进程仍在运行、还带着 4 个后代;内核合同里这个字段描述的是 CC 的「主进程 SIGTERM → 到期组 SIGKILL」。内核类型只有这一个取值,是类型逼出来的;至少在 README 写明这里的 `stopped` 是轮级、`scope` 无意义,扩内核取值另做。
- RPC 错误原因被丢掉(`:128` 一律 `no("native RPC rejected")`):宿主分不清「模型不可用」「线程不存在」「参数被拒」。
- 停止升级窗口 50 ms(`:119,129,225`):其余路径照 mirasim 是 `reapForceMs`(默认 10 s);quiesce 先等 EOF 再 SIGTERM,影响小,但要写明。
- `quiesce` 的语义与 CC 常驻不同:这里是「关 stdin → 到时 SIGTERM/组 SIGKILL → 进程表确认」,即停止并确认;#91 的常驻 CC 是只等不关。接 Host 前要按 #91「需拍板 2」统一。

### 五、#91 的两处问题会不会经由 #93 暴露或加重

- **#91 R1-01(一轮 failed 后宿主误报「停止未确认」并占槽位)**:#93 没有注册到 Host,目前不暴露。#93 的 `quiesce` 会主动关掉 app-server,所以不会出现「常驻进程还在、quiesce 返回未确认」;但如果日后照 #91 的宿主接线在每个 failed 轮后调 `quiesce`,Codex 的常驻 app-server 会在每次失败后被关掉(线程能 resume,进程不再常驻)。两家同名 `quiesce` 语义不同,要等 #91「需拍板 2」定了再统一。
- **#91 R1-02(旧捕获按 pid 重新枚举并 SIGKILL,pid 复用误杀)**:**加重**,见 R1-03。#93 每行输出都捕获、表永不清理,Codex 跑的命令又自成进程组,误杀窗口覆盖 app-server 的整个生命周期。另一个 Codex 会话(`01a1d582`,子线程 `/root/pr91_rework`)正在返修 #91,#93 要在其后 rebase 复核。

### 六、审查人真实驱动 Codex 0.167.2(本机)

经导出的 `createCodexComputeProtocol` 跑,临时 `CODEX_HOME`(用完删除)、凭据只进子进程环境不落盘不打印、生产 `~/.codex/config.toml` 与 `auth.json` 前后 sha256 不变。脚本 `scripts/real-codex.mjs`,结果 `probes/real-codex-*.json`。

- 第 1 次(`chatflows/gpt-6.1-sol`,作者用的线路):本机网关对该线路直连返回 403「blocked … browser's signature」,首轮 180 s 无终态;quiesce 后该轮落成 `failed`「native process exited before matching turn/completed」、code 0——主进程 exit 0 不冒充成功,在真实进程上成立。
- 第 2 次(`xingchiapi/gpt-6.1-sol`):暗号轮 139 s 完成;命令轮 180 s 无终态。
- 第 3 次(`fengshao1227/deepseek-v4.1-flash`,effort low),完整走完:
  - 暗号 A 精确完成;命令轮里模型确实跑了 `/bin/zsh -c echo HOME_IS=$HOME; sleep 4; …`(pid = pgid,见 R1-03),240 s 无终态后 interrupt 在 111 ms 内拿到 `interrupted` 终态。
  - quiesce `{ok:true}`;换新进程(新 pid)`thread/resume` 接回同一线程,`started.resumed:true`,暗号 B 精确完成。
  - 错 turn 的 steer 本地拒收;匹配的 steer 只回 turn id;interrupt → `stopped`;此后主进程仍在运行、带 4 个后代(R1-05);非空 tools 拒收。
  - 最后 quiesce `{ok:true, killed:4}`——被杀的是 Codex 在新 `CODEX_HOME` 里自己 `git clone https://github.com/openai/plugins.git` 的进程(作者实驱里 quiesce 的 `killed:3/4` 很可能也是它们,作者结果没有记进程名)。审查人自己按进程表核对:运行中见过的所有 pid 结束时都不在,残留 0。
- 作者的实驱结果只独立核对了两个主进程 pid(`remainingOwnNativeProcesses` 只查 `nativePids`),后代的退出靠的是 quiesce 自己的判定;本轮补上了后代的独立核对。

### 七、来源核验(核到哪一步)

门禁读不了 Codex 原生记录,以下是人工核的。

- 定位:34 个提交都出自原生子线程 `01a1d043-1042-7e61-9981-968868c25de1`(`~/.codex/sessions/2026/11/12/rollout-2026-11-12T22-56-58-01a1d043-….jsonl`;这个线程 11-12 22:56 起,提交发生在 11-13 02:51–03:29 本地时间,所以记录在 11/12 目录,11/13 目录里没有它)。`session_meta` 显示它由 `01a1cfc8-db89-…` 派生(`agent_path: /root/coverage_invariants_tests`,与 #91 第 1 轮核到的是同一个子线程);`turn_context.model` 19 处全是 `gpt-6.1-sol`,与收据一致。父线程 `01a1cfc8-…` 对应宿主会话 `codex:76d2c467-…`(其 `turns.jsonl` 只有 2 行)。
- 提交:34 个提交号在该线程的工具输出里首次出现的时间都在 git 提交时间之后 0.2–135 s(逐条见 `provenance/01a1d043-first-mention.txt`),最早 `f7fe33c` 18:51:44Z,最后 `4ea651c` 19:29:41Z。
- 11/13 目录里另有 4 个 23:24–23:28 起的原生会话提到这些提交号,是另一条 Codex 线(父 `01a1d582-…`,子线程 `/root/pr85_rework`、`/root/pr91_rework`、`/root/t177_candidates`),晚于本片,不是作者。
- 填上 review 后本机 seatbelt `run-all.ts --local --base=229fb95a`(HEAD 为审查提交)原样结果:

```text
✗ G-PROVENANCE
    - 作者会话不可信:会话记录不存在:codex:01a1d043-1042-7e61-9981-968868c25de1
    - 审查会话不可信:会话记录不存在:claude:fd6da05b-4f12-4778-9e76-fc2d1b792365
✗ G-REVIEW
    - 审查结论是 reject
其余六项 ✓,CONTENT_HASH=2c949f11…74fd9(与审查前相同),exit 1
```

  第二条是审查会话的 `turns.jsonl` 要到本轮结束才写出,属已知时序;第一条即 R1-04。
- 没核到的:云端那几次运行发生在哪台机器(交接包里有队列回执,未逐条对机器);父线程里的调度命令没有逐条看。

### 八、其它记录(不算本片问题)

- 本机网关今晚多条 GPT 线路不可用(chatflows 403、shayu 401、agentrouter 502、fnqtz 403),只有 `xingchiapi/gpt-6.1-sol` 能答;作者凌晨跑的 chatflows 线路现在复现不了。
- box1 上同时排着另一件任务(`claude-author-t177-closeout`)的全量测试,本轮变异在它之后执行,未受影响(对照组 17/17)。
- 本机有 3 个别人的 `codex app-server` 进程(父进程 91027 等),不是本审查起的,未动。

### 九、需拍板

1. **Codex Compute 的启动范围**。现在每个线程写死 `sandbox: read-only` + `approvalPolicy: never`,接上之后 Codex 不能改工作区。建议:本片保留只读作为未接线前的默认并写明是占位;接 Host 时 sandbox 由联系人授权决定(例如工作区可写),不在适配器写死。
2. **HOME**。建议与 CC 一致保留真实 HOME,只用 `CODEX_HOME` 隔离配置与会话记录。
3. **返修顺序**。R1-03 的根在 #91。建议 #91 先按第 1 轮返修(另一条 Codex 线已在做),#93 在新 base 上 rebase 后一起返修。

### 十、清理

见审查提交后的回报(本机 `/tmp/pr93-r1-claude`、云端 `/workspace/pr93-r1/` 清理量与残留进程数)。证据留在 `deliverables/g-group-pr93-r1-claude/`。
