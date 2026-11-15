# PR #95 · G35 写邻域 · 第 1 轮复核

**REJECT `c8f6fae9e9c6eb31b0923a31b6d19cf5e08db6082a2f27fba7a676ba80a04410`。** 本片新增测试漏守关键回归；本轮实际审查模型与核心实现原作者同属 OpenAI，不能构成跨厂商放行。当前实现通过独立正向探针，未确认本片现存实现缺陷。以下把实现事实、测试缺口和来源门禁分开记录。

## 冻结对象与审查范围

| 项目 | 固定值 |
|---|---|
| PR / 分支 | #95 / `fix/t177-g35-memory-neighbors`；维持 draft |
| 冻结 HEAD | `3250bc0c4cdf7165350600a4d13c9d3155a212b7` |
| 底座 | `origin/proof/t177-g6-g3-merge` @ `122e0d4f1f8b0415cf0c413db28fa827f1d4067b` |
| reviewed_hash | `c8f6fae9e9c6eb31b0923a31b6d19cf5e08db6082a2f27fba7a676ba80a04410`；独立 `run-all.ts --hash` 与作者报值一致 |
| 审查会话 / 实际模型 | `codex:1571dbff-578e-42af-b33c-ebaa0328f3e0` / `chatflows/gpt-6.1-sol` |
| 原生审查线程 | `01a1da65-51d1-79a0-987e-5fb6857999b0`；只作定位，不冒充宿主会话 |
| 需求真源 | `origin/docs/dev-handbook` @ `90226df5ffd17656f2654ab8555f7e71a93639de`；`docs/spec/需求文档.md`、`验收文档-v0.1.md`、`docs/开发手册.md` |
| 原始证据 | `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr95-96-r1-codex/pr95/`；云端压缩包已按字节数与 SHA-256 验证 |

只审本片相对各自底座的差异，所有门禁都显式带上述 `--base`。不以 `dev/integration` 作底座，不把底座既有问题算成本片。需求中标候选的内容没有用作新增验收要求。本轮只改本报告及对应收据的 `review` 字段；产品代码、测试、门禁、作者、AC 状态、红提交与 `review_status` 保持原样。

## 决定性复现

box1、Node v24.21.0，所有重活串行持有 `/workspace/.heavy.lock`。先用本机冻结源码 bundle 传入，远端 SHA-256 一致，再在任务自有克隆运行；没有继承作者的 pass 收据。

| 检查 | 独立观察结果 |
|---|---|
| `npm run typecheck` / `npm run lint` | 均退出 0 |
| 全量测试，`test-runner.ts --test-concurrency=1` | 1571/1571，失败/取消/跳过/todo 均 0，退出 0 |
| 作者具名变异 | 12/12 被指定测试按名杀死；无加载失败、无信号退出、无跳过；前后原样对照均 3/3 |
| 真实红 `051b655f` | 本片 3 条新增测试均为具名业务断言失败 |
| 校准红 `dc973b367c001fa4de1f5b5b09be4967761eede6` | 本片 3 条新增测试均为具名业务断言失败；红提交测试文件与最终版本逐字相同 |
| 冻结 HEAD 的绿 | 新增测试 3/3；变异还原后 `git diff --exit-code HEAD` 退出 0 |
| 独立探针原样对照 | 5/5 通过 |
| 自构单点故障 | 5/5 绕过本片新增测试；其中 5/5 也绕过整个全量测试。每个故障都被独立探针按名打红 |
| 全量故障后还原 | `sourceRestored=true`，源码逐字恢复，无测试或断言改动 |

对应 `cloud/attempt2/core-results/summary.json`、`author-mutations/results.json`、`independent-results/summary.json`、`cloud-full/full-mutant-results/summary.json`；每个命令/变异均保留完整 TAP 与 SHA-256。

## 自构单点故障

每次只替换一个唯一命中点，再原样还原。先在冻结实现跑独立探针作正对照，再执行故障。完整 `before` / `after` 在交付目录 `independent-cases.json`；实现未被永久修改。存活只说明测试没有守住相应行为，不能倒推当前实现已经有这些错误。

| 故障 | 行为改坏 | 本片新增测试 | 整个全量测试 | 行为差异验证 |
|---|---|---|---|---|
| C95-01 | 检索丢正文，只搜标题 | 3/3 通过，存活 | 1571/1571；survived | 独立探针按名打红 |
| C95-02 | 检索丢标题，只搜正文 | 3/3 通过，存活 | 1571/1571；survived | 独立探针按名打红 |
| C95-03 | 命中项标题丢失 | 3/3 通过，存活 | 1571/1571；survived | 独立探针按名打红 |
| C95-04 | 新增无依据的两条上限 | 3/3 通过，存活 | 1571/1571；survived | 独立探针按名打红 |
| C95-05 | 相关度逆序但同分不变 | 3/3 通过，存活 | 1571/1571；survived | 独立探针按名打红 |

## 必修项：测试缺口

### T95-R1-01 · 标题和正文使用同一夹具，漏守两条检索输入与标题输出

位置：`packages/server/src/memory-write-neighbors.test.ts:56`、`:67`、`:75`；受影响实现 `host.ts:2382`、`:2383`。

现有夹具把标题与正文都设为同一 NEEDLE，断言只判 id/body。C95-01 去掉正文、C95-02 去掉标题、C95-03 把命中标题变成空串，本片新增测试仍 3/3。独立探针分别用“只在正文命中”“只在标题命中”“标题与正文不同”三种数据，在当前实现全部通过，在各故障上按名失败。

要求：补互相独立的标题/正文夹具，分别走粗筛、精筛入口，断言返回 id/title/body；把三个故障加入具名变异清单。当前实现已有正确行为，本项只需补回归保护，不要求凭空改产品代码。

### T95-R1-02 · 最多只有两个匹配项，守不住静默截断

位置：`memory-write-neighbors.test.ts:52`–`:74`；受影响实现 `host.ts:2382`。

C95-04 把 `visible.length` 改成 `Math.min(2, visible.length)`，新增测试仍 3/3。独立五项同分命中探针确认：当前实现返回五个，故障只返回两个。

要求：新增至少三项的匹配夹具，经粗筛、精筛断言完整结果；杀死 C95-04。不在本片擅自定邻域的产品上限，需求仍将邻域大小列待实测。

### T95-R1-03 · 只验同分 id 稳定顺序，漏守相关度优先

位置：`memory-write-neighbors.test.ts:52`–`:65`；受影响实现 `host.ts:2382`–`:2383`。

C95-05 只把不同分数的命中倒序，同分顺序不动，新增测试仍 3/3。独立探针用低分 m-a 与高分 m-z，当前实现顺序 m-z、m-a，故障颠倒。

要求：在已有同分稳定性对照外，加不同相关度且 id 与分数顺序相反的具名业务断言，覆盖粗筛与精筛；用 C95-05 校准。不要把期望值设成被测检索函数自身的输出。

## 其余维度与边界

- 正确性：当前 `Host.memoryNeighbors` 在既有联系人/状态/人格/锚点硬筛后调用 G3 `searchHistory`，粗筛与精筛复用；独立正向探针未发现现存实现反例。
- 安全：本片没有引入新凭据、权限入口或外部依赖；既有联系人、会话、状态、人格边界在原测试和作者变异中通过。本片没有证明全部记忆权限路径。
- 架构/可读性：复用既有 kernel 检索接缝，不依赖 G4；没有为本次复核引入新的实现层。
- 性能：没有测生产规模下的写延迟、提炼质量或总成本，因此不作性能改善承诺。
- 底座：有效期、G5 两段式取舍等不在这 15 行的改动中；本轮不据底座缺口驳回本片。真源 §8.1 已定第 23 条与待决第 14 条要求 G5 保持草稿、等 G6 同题数据，仍适用。
- AC-42 继续是未测。确定性接线与测试绿不能替代原生强弱模型、写入延迟、成本和 G6 整体验收。

## 来源核验与完整门禁

已读作者原生记录，不能把 Claude 的移植身份替代核心实现来源：

- 原生产实现、原测试与变异清单：`codex:3e47edad-c6be-45fd-be1e-5d2f90a51145`，原生线程 `01a1cfc8-8ac3-78b0-b74a-9d0711d6502f`。相关提交输出确实存在，模型 `gpt-6.1-sol`；具名真实红、绿、旧底座全量与变异输出也存在。旧底座 1730/1734 没有移作本片数字。
- 移植与测试适配：`claude:484c2330-2f15-49ae-9f7a-145e467cedb1` / `group/opus`；子代理原生 `agent-a6a2e88cef321dd98`。记录中有适配、校准红、还原、新底座全量 1571 与变异；母会话有正常推送与远端回读。摘录的来源路径、行号、时间及原文件 SHA-256 在交付目录 `provenance-*.json`。
- 当前复核 `codex:1571dbff-578e-42af-b33c-ebaa0328f3e0`，原生 turn_context 明确是 `chatflows/gpt-6.1-sol`。不同会话没有改变同为 OpenAI 这一事实；Claude 也参与过测试适配。未自授豁免，未改作者身份，未换模型。

本机 macOS/Node v22.22.0，使用真实 seatbelt，命令直接运行并记录真实退出码，无 `tee` 或管道：

```
node scripts/gates/run-all.ts --local --pr=95 --branch=fix/t177-g35-memory-neighbors --base=origin/proof/t177-g6-g3-merge
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
