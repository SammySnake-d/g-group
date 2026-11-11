# B-F11 第 1 轮独立主审（Codex）

## 结论：REJECT

已复现一项需要返修的构造失败资源释放问题（BF11-R1-01，P2）。功能接线与本片批准范围 1–5 的主要行为成立，但不能以功能测试通过替代构造失败路径的资源验收。本审查不修改产品代码，不撤回已合并的提交，不执行合并。

## 冻结对象与来源

- PR #55：`feat/run-wake-f11 → dev/integration`；GitHub 回读 `MERGED`，合并提交 `4efdee0be6d161060099b5ce488e3344c70305ee`。
- 待审 HEAD：`5f825878c0f61bb23b4d6954002451436eee34d7`。开始前 `git ls-remote`、独立克隆及 GitHub PR 元数据均相符。
- 真实切片比较基线：`1f6543444f8211a096fc33e4f8ecadbf6e29b4ff`。远端 `origin/dev/integration` 为 `4efdee0…`，已包含待审 HEAD，不能拿零差异门禁当本片验收。
- 红 `15ba848`；绿 `9dc4bf3`；变异脚本 `f9f4299`；变异结果 `5f82587`；作者收据 `15359db`。
- 合同已读：`origin/docs/dev-handbook@f12aa3b25ab6ef2dd193180c1111181c753b464f` 的《验收文档》§9、《需求文档》§8.1 已定；范围按任务提供的 `t177-backend-resume-review.md` §B，不扩展为整个 AC-36 验收。
- 作者按真实收据保留 Claude Code / `claude:a2a925fa-da86-4354-83c7-0c217a13e607` / `claude-opus-5-5`；不改写为其他实现者。
- 审查：`codex:54e2b511-80ef-4c96-a314-154750c9e30b`。起始及首次 hash 轮为 `shayu/gpt-6.1-terra`，继续完成使用 `shayu/gpt-6.1-sol`，均为 OpenAI；来源以宿主原始记录为准。
- reviewed_hash（本会话单独执行指定命令的原样输出；以起点重算亦相同）：

```text
c99501043f1c62400906db9b074f4148ecc6f4aacf1e3809bb4ac31d89494ce1
```

## BF11-R1-01 · P2 · 非法休眠参数在打开数据库后才拒绝，失败对象无法关闭

- **位置**：`packages/server/src/host.ts:450`；此前 `:438` 已 `openDb(opts.file)`，`:441` 已执行搜索索引初始化。`packages/server/src/runs.ts:81` 的注释声称宿主校验会在打开其他资源前拒绝，与实际顺序不符。
- **复现**：在本人的冻结克隆上，使用全新中性临时数据库，连续三次调用 `new Host({ file, mind, runWakePolicy: { jumpMs: 0 } })` 并捕获异常。每次均得到预期的 `invalid_params`，但第一次已经创建数据库；进程中该临时数据库的打开句柄数依次为 **3、5、7**。同一脚本先执行三次合法构造并 `await close()`，句柄数为 **0**。
- **证据**：`deliverables/g-group-t177-bf11-codex/probe-invalid-host.mjs` 与 `invalid-host-control.txt`（本机 Node v25.8.1；原始中性临时文件在探针结束即删除）。复现脚本接受冻结克隆绝对路径作为参数，不依赖真实账户数据。
- **影响**：调用方按 API 捕获配置错误后并未取得可调用 `close()` 的 Host，却已经承担数据库创建/初始化副作用和未显式释放的 SQLite 句柄。重复校验/重试构造会累积资源，至少依赖不可控的 GC 或进程退出回收。这里不声称永久泄漏，也不把既有重试策略校验的相似路径扩大成本片返修范围。
- **返修要求**：把这次新增的休眠参数与核对周期校验放到 `openDb` 等资源获取前，或保证本条失败路径完整释放已获取资源；优先前置纯校验。新增具名行为测试，覆盖新文件不被创建、已有中性数据库不被改写、重复拒绝无句柄增长；先红后绿，保留现有断言。再加能区分“抛对错误”与“抛错前已开资源”的单点故障校准。

## 批准范围 1–5 的逐项核对

| 范围 | 观察与判定 |
|---|---|
| 1 唯一检测器、构造采样 | `runs.ts:126` 从 `WAKE_INITIAL` 采样；`:347` 每拍调用 `wakeTick`；旧内联阈值已删。R1 与第一拍 120 秒的具名用例红→绿；没有叠第二套检测器。 |
| 2 唯一宽限消费者 | `tick`、`liveCheck` 分别在 `:352/:389` 调 `stallCheck`，共用 `sleep()` 的 `{awakeSince, graceMs}`。server 没有 `mayJudgeStale/judgeRunner` 调用。独立探针在醒来拍后、两拍之间查询得到 `sleep_grace/0`。 |
| 3 接口与透传 | `RunStoreOptions.wake?: WakePolicy` 取代 `sleepGraceMs`；内核导出 `checkWakePolicy` 并由 `checkWake` 复用；`HostOptions.runWakePolicy?: Partial<WakePolicy>` 透传。差异清单确认 `startServer` 未改。 |
| 4 构造校验 | 非法 policy、`jumpMs < 2×checkMs` 确实抛 `invalid_params`；恰好两倍可启动。非法构造的资源时序不合格，见 BF11-R1-01。 |
| 5 单一默认值 | `run-ledger.ts:39` 为 `DEFAULT_SLEEP_GRACE_MS = DEFAULT_WAKE_POLICY.graceMs`，默认宽限只来自内核 policy。 |

六维审查覆盖：正确性（采样、宽限、阈值边界）、错误与资源路径（上述问题）、测试（红绿、变异、门禁双侧输入）、架构（内核复用与唯一消费者）、可读性（早期校验注释失实并入同一问题）、性能（未新增定时器，每拍纯数据校验；未声称做性能 benchmark）。不把架构外的输入环境、PID 重复判定或真实合盖提升为本片拒审理由。

## 红绿与独立行为对照

- 独立红 worktree 检出 `15ba848`；第三方依赖复用，`@g-group/*` 重映射到红副本自己的包，避免跨包取到绿源码。
- 红：两份新增测试文件共 **8 条，0 通过 / 8 失败，cancelled/skip/todo 均 0**。不是只看作者 proof。
- R1 的失败实际值是 `no_response@175s/120s`；“构造即采样”的失败实际值是 `no_response@120s/120s`，均为行为断言失败，不是空壳抛错。
- 绿：冻结 HEAD 同样 **8/8 通过，cancelled/skip/todo 均 0**，本机 Node v25.8.1。
- R4 的两条红确实在 `inGrace` 的前置断言失败：自定义 10 分钟宽限在红实现不生效，轮次已经 failed；不能把它们叙述为 401 分类或用户停止规则原来错误。收据对此已如实区分。
- 原样独立探针：恰等于 `jumpMs` 的拍不打开宽限、正常判 `stalled`；`graceMs:0` 按零宽限执行；返回 policy 为冻结副本；访问器输入拒收且调用次数 0。

## 变异与 hy4 逐条复核

box2 / Node v24.21.0，单 CPU、文件与变异均串行。仓库原脚本实际退出 0、报告 13/13，但不把其顶层 TAP 计数当成完整性证据。本人按原脚本的 13 个确切替换点再次执行；每个注入点都恰好命中 1 次；跨包链接只指向本人的变异副本。

- 原样对照 **91/91 通过**。五份测试文件的具名声明数依次为 6、2、14、45、24；逐文件核对静态测试全集与实际事件，不能少名、不能只有文件级失败。
- 作者 13 个变异 **13 杀死 / 0 存活 / 0 不完整**。每个副本都实际执行 **91 条**，cancelled/skip/todo 均 0，至少一条原样对照通过的同名测试失败；没有以超时或信号终止计杀死。
- 第一版独立采集器错误沿用了“83 条”预期，并使用多文件与 force-exit 组合；它退出 1。回读事件只有 78 条（retry-policy 只报 32/45）。该次结果作废并保留，未计为产品失败或完整校准。第二版去掉 force-exit、逐文件采集，并从冻结测试源码解析出具名全集 91 条校验。只以第二版的完整结果判决。

| 变异 | 执行 / 失败 | 一条实际杀死它的具名测试 |
|---|---:|---|
| W01 | 91 / 5 | F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器 |
| W02 | 91 / 8 | F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器 |
| W03 | 91 / 1 | F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动 |
| W04 | 91 / 5 | F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器 |
| W05 | 91 / 3 | F11 时钟跳变 +10 分钟、宽限按给的参数 5 分钟:宽限期内不判卡死、显示休眠宽限,宽限过后真停滞按阈值判 stalled |
| W06 | 91 / 1 | F11 宿主刚启动、第一拍核对前就合盖:构造时刻也算一次采样,第一拍(120 秒)就检出醒来,不判首字节超时 |
| W07 | 91 / 5 | F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器 |
| W08 | 91 / 3 | F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动 |
| W09 | 91 / 3 | F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动 |
| W10 | 91 / 2 | F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动 |
| W11 | 91 / 2 | F11 休眠门参数构造即校验:jumpMs 小于核对周期 2 倍、jumpMs 不是正数、graceMs 不是非负整数,台账和宿主都拒绝启动并说明原因;合法参数照常启动 |
| W12 | 91 / 6 | F11 等首字节时合盖约 85 秒:醒来那一拍不判上游没回应、画板显示休眠宽限,宽限过后仍没回应照常判 no_response;同样的调用不合盖照常在首字节窗口后判;停核对后不留计时器 |
| W13 | 91 / 1 | F11 宽限期内 harness 报 401:不等宽限,当场停这一轮并记 auth_or_quota,任务走 ExecFailed |

### 另外 5 个单点故障

| 编号 | 故障 | 91 条现有测试结果 | 独立行为对照与判定 |
|---|---|---|---|
| C01 | `wakeTick` 的 `>` 改 `>=` | 91 绿，存活 | t=60s 恰等于 jumpMs：干净副本判 stalled；变异副本无判定且显示 sleep_grace。**hy4 发现、Codex 复现**。 |
| C02 | 宿主早期校验错用默认 checkMs | 91 绿，存活 | 两侧给 runCheckMs=40000、jumpMs=70000 都被 RunStore 第二次校验以相同 invalid_params 拒绝。不是产品缺陷，不把冗余防护的生存当追加拒审理由。 |
| C03 | `graceMs` 经 `|| 180000` 把 0 改成默认值 | 91 绿，存活 | 配置 graceMs=0，t=100s 检醒、t=130s：干净副本判 stalled；变异副本仍 sleep_grace，无判定。Codex 独立补充的测试边界缺口。 |
| C04 | `jumpMs < 2×checkMs` 改 `<=` | 87 绿 / 4 红，杀死 | “休眠门参数构造即校验”等四条具名测试发现恰好两倍被误拒。 |
| C05 | `checkWakePolicy` 返回副本不冻结 | 90 绿 / 1 红，杀死 | “不给取默认值，只给一项时另一项取默认，返回冻结副本”的具名测试失败；独立探针同时读到 frozen=false。 |

新增 5 个中 **2 杀死、3 存活**；存活者不是“三个现存产品缺陷”：其中两个是测试缺口，一个是仍由第二道校验保护的情形。

### BF11-R1-02 · 建议补测（不单独拒审）

- 位置：`packages/server/src/run-wake.test.ts:87–225`、`packages/kernel/src/wake-policy.test.ts:17`；现有 graceMs=0 断言只检查参数或能构造，没有验证台账的零宽限行为；jumpMs 相等边界也未被现有 91 条测试覆盖到。
- 补测建议：给相邻采样恰好等于 jumpMs 的阴性对照、graceMs=0 的实际 tick/liveCheck 断言，各配相应单点故障。当前干净实现两项都正确；批准范围只要求至少四个指定变异且已有 13 个完整被杀，因此不把边界穷尽程度自行升级为本片额外硬合同。
- hy4 H-BF11-01：上述 C01 已在本人的冻结克隆副本复现，按“hy4 发现、Codex 复现”并入本条。
- hy4 H-BF11-02：C02 已复现，但不采纳为缺陷，理由是实际非法配置仍被台账拒绝；“不打开资源”的表述不能成立，因为干净实现本就先打开 DB，此事已经单列 BF11-R1-01，不重复计数。

完整明细：`cloud/results/independent-v2/summary.json`、每个 `Wxx-fileN.jsonl` 的具名结果，以及 `clean/C01/C02/C03/C05-probes.jsonl` 的前后实际输出。原样、变异、探针、超时标志和正常退出码均保留。

## 门禁双侧与已合并基线陷阱

1. 指定的 `node scripts/gates/run-all.ts --base origin/dev/integration --local` 在原始 HEAD 上真实退出 0、八项显示通过，但标题明确 **受检文件 0 个**。其中多个门禁因没有受管差异而早退；这不是本次产品改动的有效通过证据。
2. 用冻结起点 `--base 1f65434 --local` 补测，实际受检 **9 个文件**；签审前 G-REVIEW 以“还没有独立审查”拒绝。填入本会话 review 后再次实际运行，**G-PROVENANCE、TRACE、RED、STUB、TAUTO、WORKFLOW、LAYER 全过，仅 G-REVIEW 因 verdict=reject 按预期拒绝**；退出 1。来源门禁通过取的是实际记录，不是空 review 的早退。
3. 独立编写了九个 `/tmp` 中性 Git 夹具，通过真实 CLI 运行：合规对照八项全通过；八个应失败输入分别由 G-TRACE / G-REVIEW / G-PROVENANCE / G-RED / G-STUB / G-TAUTO / G-WORKFLOW / G-LAYER 拦下。每条均退出 1，目标门禁明确为失败。夹具来源记录只位于该次临时目录，不是补造真实作者或审查会话记录。
4. 精确输入与原样输出：`gate-negative-probes.mjs`、`gate-negative-summary.json`、`gate-*.txt`。第一次夹具遗漏 trusted workflow 且空提交未允许，作为执行器错误保留于 `gate-fixture-attempt1.txt`；修正夹具后重新运行，未把执行器错误当产品缺陷。

## 环境、未测与交付边界

- box2 已唤醒；Docker API socket 权限拒绝，此后不再试 Docker。Docker 容器沙箱路径 **未测**；本机 macOS 的实际门禁沙箱另行验收。
- 早先云端全量只留下启动头，没有完成收据，不计通过。全局重任务锁排队未进入验证阶段；后续按 box2 四核配置限制到单一 CPU，保持测试与变异串行，不修改其他任务的目录或进程。**本轮 typecheck=0、lint=0、npm test=0，1473/1473 通过，fail/cancelled/skip/todo 均 0**；完整 stdout、独立退出收据、Node 版本、干净 source-status 与冻结 HEAD 均已取回并核验归档 SHA-256。
- 明确不在本片：`judgeRunner/reconcileOrphans` 重复判定、F8/F10 数值、`firstByteMs ≤ jumpMs` 的短休眠、Compute 内部计时、Electron 唤醒事件、真机合盖。没有把这些已声明未覆盖项当作本轮拒审理由。
- 只允许审查文件与收据 review 区域进入审查提交；产品源码、测试、proof 与作者收据内容均保留。不更新其他 PR/分支，不发群消息。
- 完成后交给 Claude Code 读本记录终审；后续实现者由调度按用户指定分工决定，本任务没有另派助手。

## 交付约束

- 审查提交只含本文和收据的 `review` 字段；原收据的 author/red/acceptance/unverifiable/review_status/notes 等全部保持与被审 HEAD 一致，避免改动被审内容 hash。机器判定以 `review.verdict=reject` 为准，未把作者“待审”资料改成自报验收通过。
- 正常 pre-push 钩子、推送回读及清理的最终可变收据见本机 `deliverables/g-group-t177-bf11-codex/delivery.json` 与 `cleanup.json`；不以“已启动”冒充“已完成”。本片需 Claude Code 阅读本审查记录终审，并由调度安排 BF11-R1-01 返修。

## 原样门禁输出

### 指定基线（已合并，零差异）

```text
base=origin/dev/integration branch=feat/run-wake-f11 HEAD=5f825878c0f61bb23b4d6954002451436eee34d7 受检文件 0 个 收据=receipts/feat-run-wake-f11.json 门禁 8 个
✓ G-PROVENANCE  R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是仓库所有者对这个 PR 这一版的结构化批准
✓ G-TRACE  R-06 R-08 R-15:受管改动必须有收据,条目对上验收文档,状态四选一,通过要有证据
✓ G-REVIEW  R-01:审查人限 Codex/Astra/Claude/Argon(g-group#1531、g-group#2943、g-group#3199 原则 68,默认 Codex;Claude 审 Codex 写的 PR,Argon 备用),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)
✓ G-RED  R-02:先红后绿,红提交上的测试与现在相同,现在的测试放到红提交实现上按名字失败、现在按名字通过
✓ G-STUB  R-03 R-04:空实现红基线 + 返回值变异校准,桩下或错值下仍通过、没执行、加载失败的测试都判无效
✓ G-TAUTO  R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、自比较、恒真、不可达、不判源码结果、skip/only;运行时与静态逐条计数一致)
✓ G-WORKFLOW  R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限、不得写提交状态、不得用 pull_request_target
✓ G-LAYER  插件化:包分层只能向下依赖,插件互不依赖,禁止相对路径跨包(import 与依赖声明都查)
CONTENT_HASH=c99501043f1c62400906db9b074f4148ecc6f4aacf1e3809bb4ac31d89494ce1
```

### 冻结起点，已填真实 review

```text
base=1f65434 branch=feat/run-wake-f11 HEAD=5f825878c0f61bb23b4d6954002451436eee34d7 受检文件 9 个 收据=receipts/feat-run-wake-f11.json 门禁 8 个
✓ G-PROVENANCE  R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是仓库所有者对这个 PR 这一版的结构化批准
✓ G-TRACE  R-06 R-08 R-15:受管改动必须有收据,条目对上验收文档,状态四选一,通过要有证据
✗ G-REVIEW  R-01:审查人限 Codex/Astra/Claude/Argon(g-group#1531、g-group#2943、g-group#3199 原则 68,默认 Codex;Claude 审 Codex 写的 PR,Argon 备用),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)
    - 审查结论是 reject
✓ G-RED  R-02:先红后绿,红提交上的测试与现在相同,现在的测试放到红提交实现上按名字失败、现在按名字通过
✓ G-STUB  R-03 R-04:空实现红基线 + 返回值变异校准,桩下或错值下仍通过、没执行、加载失败的测试都判无效
✓ G-TAUTO  R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、自比较、恒真、不可达、不判源码结果、skip/only;运行时与静态逐条计数一致)
✓ G-WORKFLOW  R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限、不得写提交状态、不得用 pull_request_target
✓ G-LAYER  插件化:包分层只能向下依赖,插件互不依赖,禁止相对路径跨包(import 与依赖声明都查)
CONTENT_HASH=c99501043f1c62400906db9b074f4148ecc6f4aacf1e3809bb4ac31d89494ce1
```
