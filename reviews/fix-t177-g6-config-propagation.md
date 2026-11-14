# PR #96 · G6 配置穿透 · 第 1 轮复核

**REJECT `900fb4aeca20a9eb47ea490a212b54d8683db0e5ae33cf1a2811ba2238ff77c7`。** 本片新增测试漏守关键回归；本轮实际审查模型与核心实现原作者同属 OpenAI，不能构成跨厂商放行。当前实现通过独立正向探针，未确认本片现存实现缺陷。以下把实现事实、测试缺口和来源门禁分开记录。

## 冻结对象与审查范围

| 项目 | 固定值 |
|---|---|
| PR / 分支 | #96 / `fix/t177-g6-config-propagation`；维持 draft |
| 冻结 HEAD | `c8275dd35dd681b9c9cbef9ab995443881bf982c` |
| 底座 | `origin/proof/t177-g6-g2-merge` @ `4f0958064ec072b552543461e649f62ac4228640` |
| reviewed_hash | `900fb4aeca20a9eb47ea490a212b54d8683db0e5ae33cf1a2811ba2238ff77c7`；独立 `run-all.ts --hash` 与作者报值一致 |
| 审查会话 / 实际模型 | `codex:1571dbff-578e-42af-b33c-ebaa0328f3e0` / `chatflows/gpt-6.1-sol` |
| 原生审查线程 | `01a1da65-51d1-79a0-987e-5fb6857999b0`；只作定位，不冒充宿主会话 |
| 需求真源 | `origin/docs/dev-handbook` @ `90226df5ffd17656f2654ab8555f7e71a93639de`；`docs/spec/需求文档.md`、`验收文档-v0.1.md`、`docs/开发手册.md` |
| 原始证据 | `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr95-96-r1-codex/pr96/`；云端压缩包已按字节数与 SHA-256 验证 |

只审本片相对各自底座的差异，所有门禁都显式带上述 `--base`。不以 `dev/integration` 作底座，不把底座既有问题算成本片。需求中标候选的内容没有用作新增验收要求。本轮只改本报告及对应收据的 `review` 字段；产品代码、测试、门禁、作者、AC 状态、红提交与 `review_status` 保持原样。

## 决定性复现

box2、Node v24.21.0，所有重活串行持有 `/workspace/.heavy.lock`。先用本机冻结源码 bundle 传入，远端 SHA-256 一致，再在任务自有克隆运行；没有继承作者的 pass 收据。

| 检查 | 独立观察结果 |
|---|---|
| `npm run typecheck` / `npm run lint` | 均退出 0 |
| 全量测试，`test-runner.ts --test-concurrency=1` | 1576/1576，失败/取消/跳过/todo 均 0，退出 0 |
| 作者具名变异 | 8/8 被指定测试按名杀死；无加载失败、无信号退出、无跳过；前后原样对照均 4/4 |
| 真实红 `52c8da44` | 本片 4 条新增测试均为具名业务断言失败 |
| 校准红 `428f760b1f7cc4dceac8025f5f7e825eaa7c7faa` | 本片 4 条新增测试均为具名业务断言失败；红提交测试文件与最终版本逐字相同 |
| 冻结 HEAD 的绿 | 新增测试 4/4；变异还原后 `git diff --exit-code HEAD` 退出 0 |
| 独立探针原样对照 | 5/5 通过，另有真实 CLI/loopback HTTP 对照（见下） |
| 自构单点故障 | 5/5 绕过本片新增测试；其中 5/5 也绕过整个全量测试。每个故障都被独立探针按名打红 |
| 全量故障后还原 | `sourceRestored=true`，源码逐字恢复，无测试或断言改动 |

对应 `cloud/attempt2/core-results/summary.json`、`author-mutations/results.json`、`independent-results/summary.json`、`cloud-full/full-mutant-results/summary.json`；每个命令/变异均保留完整 TAP 与 SHA-256。

## 自构单点故障

每次只替换一个唯一命中点，再原样还原。先在冻结实现跑独立探针作正对照，再执行故障。完整 `before` / `after` 在交付目录 `independent-cases.json`；实现未被永久修改。存活只说明测试没有守住相应行为，不能倒推当前实现已经有这些错误。

| 故障 | 行为改坏 | 本片新增测试 | 整个全量测试 | 行为差异验证 |
|---|---|---|---|---|
| C96-01 | API_KEY-only 配置不传入 | 4/4 通过，存活 | 1576/1576；survived | 独立探针按名打红 |
| C96-02 | 只配 context 时丢失 | 4/4 通过，存活 | 1576/1576；survived | 独立探针按名打红 |
| C96-03 | 大于 16384 时静默截断 | 4/4 通过，存活 | 1576/1576；survived | 独立探针按名打红 |
| C96-04 | 替身续跑身份被无效配置污染 | 4/4 通过，存活 | 1576/1576；survived | 独立探针按名打红 |
| C96-05 | 实际 runner 调用点仍丢预算 | 4/4 通过，存活 | 1576/1576；survived | 独立探针按名打红 |

## 必修项：测试缺口

### T96-R1-01 · 唯一真实请求测试绕过 runner CLI 的子进程调用点

位置：`packages/server/proof/g6/runtime-config.test.ts:42`–`:54`；实际接线 `run.ts:405`。

G6CFG-04 直接调用 `driveItem`，把 helper 的返回值传进去。C96-05 只在真正 main 的调用点剥掉两项 `GG_SPEAKING_*`，四条新增测试仍 4/4。独立探针启动真实 `run.ts --mode=real`，loopback HTTP 只用中性凭据与规则响应器：冻结实现发出 9 次请求，全部 `max_tokens=65536`；同一个探针在 C96-05 上观察到 9 次全部回到 4096，并按业务断言失败。这就是本次修复根因的入口退化形态。

要求：把真正 CLI→子进程→driver→被测宿主→HTTP 的具名回归测试加入本片，核实请求与 manifest 中的配置一致；必须杀死 C96-05。探针可复用交付的 `pr96-cli-probe.mjs` 结构，加入仓库时按既有测试清理临时目录。无需真实网关或付费模型。

### T96-R1-02 · 配置矩阵只覆盖 token 认证且两个预算同时存在

位置：`runtime-config.test.ts:13`、`:15`–`:28`；实现 `run.ts:293`、`driver.ts:78`。

C96-01 让 runner 只在存在 AUTH_TOKEN 时传配置；API_KEY-only 失效。C96-02 让 driver 只在设置 output 时传配置；context-only 失效。四条新增测试仍全部通过。独立配置链矩阵在冻结实现通过，在故障上分别按名失败。

要求：覆盖 AUTH_TOKEN / API_KEY-only、只设 output / 只设 context / 两者都设 / 都不设；校验未设置项沿用宿主默认、非法值交给宿主拒绝、无关环境仍不透传。空字符串在当前宿主表示默认值，不应改写成新的产品限制。

### T96-R1-03 · 只用 9216，漏守本次实际 65536 档的原样穿透

位置：`runtime-config.test.ts:13`；实现 `manifest.ts:42`–`:45`。

C96-03 在 `speakingEnv` 对大于 16384 的 output 静默钳制为 16384，四条新增测试仍 4/4。独立 `65536/983010` 探针在冻结实现通过，故障被明确打红。

要求：至少加入本次实际档案的 `65536/983010`，断言两个阶段、manifest、实际请求均保留精确值，并杀死 C96-03。它是测试边界，不是要把该数硬编码成产品默认或 G6 默认。

### T96-R1-04 · standin 的续跑身份缺少“忽略真实预算”对照

位置：`runtime-config.test.ts:30`–`:40`；实现 `manifest.ts:54`。

C96-04 给替身 `ModelConfig.speaking` 混入真实预算，四条新增测试仍 4/4；但替身实际不使用这些参数，身份不应随它们改变。独立对照校验 speaking 为空、fingerprint/reuseKey 不变，当前实现通过，故障失败。

要求：加入替身模式环境预算改变而指纹/续跑身份不变的对照，并杀死 C96-04；保持现有真实模式改变预算后身份变化、凭据不入指纹的断言。

## 其余维度与边界

- 正确性：当前 runner→driver→宿主的原样配置链与真实 CLI HTTP 对照都正确；本轮没有确认本片现存实现缺陷。
- 安全：白名单只增加两项公开预算；无关环境不透传，凭据不进 ModelConfig/摘要，现有正负对照通过。
- 架构/可读性：共享 `speakingEnv`、使用宿主的正整数校验与默认值，没有另造 G6 的产品上限。
- 性能：不作真实模型质量、延迟或成本结论。
- 底座另记：raw 文件路径按 group/model/item/rep 命名，配置改变可能覆盖同输出目录里的旧记录。这一行为在底座已经存在，不计本片缺陷。真实运行须为旧 4096 与新预算分开输出目录，旧失败记录留在各自分母。
- 本片的校准红/真实红一起跑了 report.test.ts；6 条既有 report 测试仍通过，失败的是新增 4 条配置测试。本片对 report 的变动只补 `speaking: {}` 夹具形状，没有放宽断言。
- AC-42 与 G6 整体仍未测。loopback 的 9 次请求只是确定性配置证据，不代表原生 Hy4、强模型、提炼质量、延迟和成本已验收；没有触碰原生批次、锁或定时续跑。

## 来源核验与完整门禁

已读作者原生记录，不能把 Claude 的移植身份替代核心实现来源：

- 原生产实现、原测试与变异清单：`codex:3e47edad-c6be-45fd-be1e-5d2f90a51145`，原生线程 `01a1cfc8-8ac3-78b0-b74a-9d0711d6502f`。相关提交输出确实存在，模型 `gpt-6.1-sol`；具名真实红、绿、旧底座全量与变异输出也存在。旧底座 1730/1734 没有移作本片数字。
- 移植与测试适配：`claude:484c2330-2f15-49ae-9f7a-145e467cedb1` / `group/opus`；子代理原生 `agent-a6a2e88cef321dd98`。记录中有适配、校准红、还原、新底座全量 1576 与变异；母会话有正常推送与远端回读。摘录的来源路径、行号、时间及原文件 SHA-256 在交付目录 `provenance-*.json`。
- 当前复核 `codex:1571dbff-578e-42af-b33c-ebaa0328f3e0`，原生 turn_context 明确是 `chatflows/gpt-6.1-sol`。不同会话没有改变同为 OpenAI 这一事实；Claude 也参与过测试适配。未自授豁免，未改作者身份，未换模型。

本机 macOS/Node v22.22.0，使用真实 seatbelt，命令直接运行并记录真实退出码，无 `tee` 或管道：

```
node scripts/gates/run-all.ts --local --pr=96 --branch=fix/t177-g6-config-propagation --base=origin/proof/t177-g6-g2-merge
```

| 门禁 | 写入本轮 review 后的结果 |
|---|---|
| G-PROVENANCE | 失败：`审查厂商 openai 在作者的产出厂商集合 {openai} 里` |
| G-REVIEW | 失败：reject；agent 同为 codex；作者与审查同为 openai、无用户豁免 |
| G-TRACE / G-RED / G-STUB / G-TAUTO / G-WORKFLOW / G-LAYER | 六项通过 |
| 完整命令退出码 | 1 |
| 门禁自检 | 219/219，退出 0；两片门禁目录的 17 个文件 SHA-256 完全一致，因此共享一次直接自检原始证据（没有冒充每片各跑一次） |

写入 review 前的 G-PROVENANCE 勾号是 `review:null` 的提前返回，不算来源通过；本轮已在真实 review 下重新执行，明确报同厂商。没有“来源记录未落盘，先算通过”的替代结论。G-PROVENANCE 的 {openai} 来自原 author.session；Claude 移植部分另外作了原生人工核验。

## 复核完成条件

补齐上述具名测试，将审查人的单点故障加入清单并逐个杀死，保留正对照及还原证据，再跑原全量与完整门禁。不要为了绿去改当前正确的生产行为、弱化断言、删测试、加 skip 或改门禁。本轮 REJECT 不要求把本片扩成完整 G6/AC-42 项目。

## 需拍板

无新增产品定义需要用户定。本轮不能跨厂商签 APPROVE：建议测试补齐后由未参与 OpenAI/Anthropic 产出的可用第三厂商审查人独立放行；当前会话继续保留 reject，不请求或伪造同厂商豁免，不替用户换模型或派活。两片保持 draft、未合并，也不转 ready。

## 证据与执行限制

本片首次云端 clone 退出 128，原错 `Could not resolve host: github.com`；大请求上传出现 `EPIPE`，部分 Node TLS 初始化出现 `ECONNRESET`。全部错误保留，改为冻结 bundle 分片传输与相同 MCP 的持久 HTTPS 连接后，才得到上述实际执行结果；没有把失败尝试算测试通过。

本轮没有另跑 Linux Docker 门禁或门禁自身 `gates:mutation` 全套：两片均未改门禁源码，本机按请求执行真实 seatbelt 完整门禁，并复跑共同的 219 项门禁自检；本片业务变异则已逐项执行，数字如上。

主要证据：`verified-cloud-summary.json`、`cloud-evidence.tar.gz`、`full-mutant-evidence.tar.gz`、`local-gates-reviewed.log`、`receipt-unchanged-outside-review.json`，以及交付根目录的独立探针、故障清单、原生来源摘录与 `MANIFEST.json`。最终推送回读、GitHub self-check 单次状态和清理结果以交付目录 `DELIVERY.json` / `CLEANUP.json` 为准。
