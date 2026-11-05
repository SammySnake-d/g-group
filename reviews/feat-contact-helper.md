# PR #4 联系人与 Helper：独立复现审查

**结论：reject。** 本轮审查结束不等于功能验收通过。Helper 三入口的路由语义、定时归联系人的归属正确；但联系人授权集合、专职锁、承诺回收存在领域合同缺口，且独立构造的 26 个变异中有 **14 个存活**。交回 Claude Code 原开发任务修正，修正后仍须跨厂商重审。本轮不修改产品代码或作者测试。

## 1. 审查对象、版本与来源

| 项目 | 固定值 |
|---|---|
| 时间 | 2026-11-05，Asia/Shanghai |
| PR | https://github.com/SammySnake-d/g-group/pull/4 |
| 分支 / 被审 HEAD | `feat/contact-helper` / `4ddf9615844790389ca692d7ceca05e72338f128` |
| 基线 | `origin/feat/task-lifecycle` / `c6ca6941bff01f289136299d1e8039a6ee5aef0f` |
| 红提交 | `257933acacd9d0d553b78a2fda12c4965744974a` |
| 作者 | Claude Code；`claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` |
| 实际生产模型 | 作者 `turns.jsonl` 中触及 g-group 的轮次为 `ai-iisbo-2/[kiro企业优化]claude-opus-5-5`、`ai-iisbo/[鸿运按量]claude-opus-5-5`；原生厂商均为 Anthropic |
| 独立审查 | Astra；`codex:ca507fd7-9fc8-4431-a218-fb29ca3ca577`；实际 `gpt-6-astra`，原生厂商 OpenAI |
| 模型核验 | 原生记录 `rollout-2026-11-05T15-41-27-01a1aaa7-d328-78c3-850d-ed5ebbf69e93.jsonl` 的 `turn_context.model`；不是拿联系人名称当厂商证明 |
| 豁免 | 无；没有使用同厂商豁免 |
| 执行环境 | macOS；Node `v22.22.0`；npm `10.9.4`；普通独立 clone，`.git` 与 common dir 均为本 clone 的 `.git` |

被审内容 hash：

```text
9736f7091d1e67e2da2304b6a5d51b52dc84e6583fbc3a4207c93e84c83868eb
```

这是在仓库根目录实际执行以下命令的原样 stdout，收据仅在 `review` 字段引用它：

```sh
node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle
```

范围是本 PR 增量，不把 PR #3 的独立验收混入本轮。对照来源：用户 `g-group#1353/#1365` 原文、概念卡 v2 第 1/3/11 张、仓库 `docs/spec/验收文档-v0.1.md` 的 AC-01、AC-31⑤、AC-33、AC-35①、R-02、R-05，以及 `docs/spec/需求文档.md:74-79` 对授权集合的明确区分。

证据根目录（下文 `$E`）：

```text
/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-review-20261105-KYxuQl/evidence
```

`snapshot.json` 固定文件 SHA-256 与模型来源；概念卡副本为 `概念卡-v2.snapshot.md`，SHA-256 为 `5b2b0ae48c86e85af60c1711cbeb82d7f0c6570073ec91c190a9961cf2adb23e`。原始源码、测试和作者收据非 review 部分保持原样。所有变异只写入兄弟目录 `mutants/` 的独立副本。

## 2. 亲自复现的基线、红提交与作者校准

| 操作 | 实测结果 | 证据 |
|---|---|---|
| `npm ci` | exit 0；安装 5 个包，audit 0 vulnerabilities（仅安装器该次结果，不代表安全审计） | `baseline-npm-ci.txt` |
| `npm run typecheck` | exit 0 | `baseline-typecheck.txt` |
| `npm run lint` | exit 0；22 files，无修复 | `baseline-lint.txt` |
| `npm test` | exit 0；78/78，0 skip/todo | `baseline-test.txt` |
| 普通副本检出红提交，再跑 `npm ci`、`npm test` | 安装 exit 0，测试 exit 1；新增 22 项红，原有 56 项绿 | `red-npm-ci.txt`、`red-test.txt` |
| 对红提交的两个新测试文件逐文件运行 TAP | `contact.test.ts` 17/17、`helper.test.ts` 5/5 按准确测试名失败，均为 `未实现`，不是导入/依赖错误 | `red-names.json`、`red-contact.test.ts.tap`、`red-helper.test.ts.tap` |
| `node packages/domain/proof/mutations.mjs` | exit 0；原样 78 绿，52/52 变异有具名测试红 | `author-mutations.txt` |

红名字核对用 `node --test --test-reporter=tap <file>`；第一次给 npm 脚本尾部追加 reporter 参数仍输出 spec 格式，导致首轮 TAP 解析无名字。已保留首轮输出并更正参数位置重跑，不把解析空集算通过。`red-names.json` 的两组 `exact_match` 均为 true。

**R-02 在本 PR 的 22 个新增行为测试上通过复现。** 作者 52 个变异的结果可重现，但只说明那 52 个变异被杀，不足以证明 R-05 每条判据均已双侧标定。

## 3. 对用户原意的核对

### Helper：三入口建模正确，不回退为两入口

概念卡第 3 张写的是较早的“两种入口”；最新用户 `#1365` 明确增加独立全局入口，`#1353` 明确 @Helper 的回复应在聊天中。这里以最新原话为准。

| 入口 | 回复位置 | 作为聊天消息 | 自动携带的会话上下文 | 实测 |
|---|---|---|---|---|
| global | global-panel | 否 | null | 符合 |
| mention | conversation | 是 | 指定 conversationId，引用 seq | 符合 |
| sidebar | sidebar | 否 | 指定 conversationId，不引用消息 | 符合 |

另用与作者不同的 `PRIVATE-2`、seq 42，做三入口 × 本人 / 他人 / 同 ID 的 contact 共 9 格检查：本人路由正确，其余均拒绝；Helper 不认领任务。**这是路由纯函数通过，不是消息表隔离、真实软件操作或确认卡接线已验收。** 测试对此的防回归充分性仍见 CH-04。

### 定时：归属正确，调度闭环未交付

`Contact.commitments[].schedule` 保存 cron、tz、toleranceSec，定时不是插件；当前任务结束不会回收重复定时承诺。符合概念卡第 1/11 张及第 4 张“不含定时”的归属。未实现真实到点唤醒、最新群规注入、DST 触发、多会话定时总览；本片也没有承诺的会话维度字段，不能把纯字段校验等同于第 11 张三入口过滤视图已经成立。

## 4. 必须修复项

### CH-01 [High] 把“拥有并可授给 Compute 的能力”收窄成“联系人可直接调用的工具”

位置：`packages/domain/src/contact.ts:7,26,93-97,138-144`。

母规格 `docs/spec/需求文档.md:75-78` 明确分开两种集合：联系人名下的可授权能力资产，和本体直接暴露的具名有界工具。当前只有 `Contact.tools: NamedTool[]`，`grantTool` 禁止通用命令 MCP，`briefFor` 又仅从同一个 `c.tools` 计算授权集合。因此**已获授权但仅准 Compute 使用的 MCP/脚本类能力没有可表达的位置**。

原实现实测：`grantTool(c,{name:'run_command',bounded:true})` 返回“是通用能力，只能在 Compute 里用”；请求 `briefFor(c,{...,tools:['run_command']})` 又返回“超出联系人白名单”。当前公开模型没有先把该能力登记为 Compute-only 授权资产的路径。不能以把它塞回本体直接列表来解决，否则反过来违反 AC-33①。

这不是说 Harness 原生 shell 必须经该字段继承；原生 shell 与这里的**附加 MCP/Skill 授权资产**应分别对待。必须拆开两个概念，并补三联测试：已授权 Compute-only 能力可派给 Compute、仍不能直接调用、未授权能力仍拒绝。当前只测“全部拒绝通用工具”和“超集拒绝”，没有合法 Compute-only 子集的阴性对照。

### CH-02 [High] 专职锁变成拒绝一切工作，且可残留对已结束承诺的锁

位置：`contact.ts:53-56,115-135`；`contact.test.ts:116-132`。

`work` 只有 text，没有目标承诺/职责关系；`decideUnderFocus` 完全不看 text 或 `onlyCommitmentId`，加锁后所有 work 都是 `decline-focused`。用锁定承诺原文“总结 Telegram G1”作为工作请求，原实现仍拒绝；同一输入只移除 focus 后为 `handle`。控制命令为 `handle`，这部分正确，但“只做这件事”不是“不做任何工作”。

另从有效非定时承诺设置专职锁后运行 `settleTask`：承诺变为 done，`focus.onlyCommitmentId` 仍指向它，随后新任务仍被拒绝。这与 `setFocus` 要求“有效承诺”的不变量、AC-31⑤不污染后续任务不一致。

必须用明确职责/承诺关联表达职责内工作，不要求本纯函数做自然语言理解；测试同一工作仅切换职责归属，以及锁定承诺结束/撤销后的政策。控制穿透不能当作把职责内工作伪装成 control 的替代方案。作者第 7 栏关于“意图由上游分类”的声明没有覆盖这个缺口：现有类型中根本没有职责内/外的区分。

### CH-03 [High] AC-31⑤ 漏掉“末次汇报已发出”这一回收条件

位置：`contact.ts:15,115-123`；`contact.test.ts:101-107`。

AC-31⑤明确要求**所有绑定任务终态且末次汇报发出后**才回收。当前注释是“一个任务进入终态时调用”，`settleTask(c,'T1')` 对最后一个任务立即清空剩余绑定并置 done；模型与入参都没有末次汇报发送确认。

独立调用中没有发送任何汇报、没有提供发送确认，结果已经是 `status:'done', boundTaskIds:[]`；无关任务终态的阴性对照仍是 active。这是领域生命周期丢条件，不是要求本 PR 现在实现 Outbox/网络发送器。真实“丢最后一条消息”的端到端效果尚未测，本次不作该外推；已证实的是当前纯函数无法区分“待最后汇报”和“已汇报”。

必须为回收提供可验证的“任务终态 + 末次汇报确认”前提或相应事件契约，补“最后汇报仍待发 → active / 同一状态仅发送确认改变 → done”的双侧测试，并实际派新任务检查旧承诺不再生效。现测试名写“不污染后续任务”，但并未创建后续任务，也没有检查末次汇报。

### CH-04 [High，验收门禁] R-05 有真实测试盲区，14 个行为错误仍三项全绿

位置：`contact.test.ts:40-81,84-107,131-132`、`helper.test.ts:25-30`、`packages/domain/proof/mutations.mjs`。

所有 26 个独立变异都通过 typecheck 和 lint；其中 14 个连现有 78 项测试也全部通过。独立 oracle 在原样实现上 **26/26 绿**，在各自变异上 **26/26 红**，确认这些是可观测行为差异，而不是等价变异、语法错误或只测 mock。

必须补齐的盲区：

- **禁项测试与实现同源**：测试从实现的 `FORBIDDEN_DIRECT_TOOLS` 枚举样本，只独立固定了 bash；单独删 shell、write_file、browser 后对应能力放行，测试连同样本一起消失。必须从规格独立声明样本，不能拿被测列表当判据全集。
- **只测记忆，没测 SOUL**：fixture 的 soul 为空，也没断言说明字段集合；给 brief 增加 `soul:c.soul` 仍全绿。以非空 SOUL、非空 memory 分开校准禁止复制。
- **合法输出被静默丢掉也绿**：task 清空、合法 tools 清空、credentialRefs 清空、显式 placement 改回 local，均存活。必须对合法非空输入精确断言输出，不能只验 ok。
- **另有字段/状态盲区**：sourceSeq 清零；专职锁放行已结束承诺；允许 NaN/Infinity 误差；Helper 移除 kind 检查（同 ID contact 被放行）或只跳过 global 鉴权；拒绝 bash 却给“时区不认识”的错误原因，均存活。

这些是现有测试的缺陷，不是声称原实现已经泄露 SOUL、丢失凭据或放行 Helper 越权。原实现对上述独立 oracle 均正确；R-05 要求的是对应能力被破坏后也必须检测到，且红的原因正确。应修测试和校准脚本，不能把存活项简单追加到第 7 栏便继续标通过。

## 5. AC 四栏独立对照

| 条目 | 必须 | 禁止 | 阳性埋雷 / 实测 | 阴性对照 / 实测 |
|---|---|---|---|---|
| AC-01 子集 | 同 ID 拒覆盖；改名换模型保留身份记忆 | 用新建重置原联系人 | I13 放行重复 ID → 具名测试红 | 原样同输入拒绝；原有改名换模型用例绿；重启存储未测 |
| AC-33 直接工具 | 有界工具可直接用 | shell/任意写文件/浏览器直用 | I02–04 删禁项 → 78 绿但独立 oracle 红；I20 错拒合法有界工具 → 原测试红 | 原样具名工具通过、禁项被拒；Compute-only 合法授权路径缺失，CH-01 |
| AC-33 Compute brief | 任务/群规/合法工具和引用完整，位置不被改写 | MEMORY/SOUL 复制、越权和明文 | I01 泄露 SOUL、I05–08 丢合法字段 → 存活；I14 泄露 memory → 红 | 非空合法输入的独立 oracle 原样全绿；明文和超集拒绝仍绿 |
| AC-31⑤ | 终态且最后汇报确认后 GC，不污染新任务 | 提前 GC、无限残留、回收周期定时 | I18 永不 GC → 红；原实现提前 GC 的条件缺失见 CH-03 | 定时不回收、无关 task 不改变承诺为绿；等待最后汇报的合法 pending 状态无法表达 |
| AC-35① | 职责内接活、越界拒绝、控制穿透；显式时区有限误差 | 全拒绝工作、阻断控制、非法误差 | I15 阻断控制、I24 无锁拒接 → 红；I19 非有限误差 → 存活；CH-02 是现存行为错误 | 同请求移除 focus → handle；合法时区/误差绿；I21 错拒合法时区 → 红；DST 触发未测 |
| Helper 用户原话 | global/mention/sidebar 区分；只响应本人 | 侧边栏写消息、@ 回复不写消息、跨身份调用 | I16/17/22/23 路由破坏均红；I11/12 身份/全局鉴权破坏存活 | 9 格独立输入矩阵原样符合；同 entry 只切 caller 的身份/ID，结果正确 |

## 6. 独立变异清单与重跑方法

实现副本是固定 HEAD 的单点变更，**未修改测试**。每个副本都跑 typecheck、lint、全包 TAP 测试，再跑独立 oracle；C00 原样控制也完整执行。以下“存活”均指三项 exit 0 且 78/78 绿；“杀死”均有准确测试名和断言/运行失败，非加载失败。

| ID | 注入变化（精确替换对见 JSON） | 现有测试 |
|---|---|---|
| I01 | brief 增加 `soul:c.soul` | 存活 |
| I02 | 禁项删除 `shell` | 存活 |
| I03 | 禁项删除 `write_file` | 存活 |
| I04 | 禁项删除 `browser` | 存活 |
| I05 | brief 合法工具输出改为空数组 | 存活 |
| I06 | brief 凭据引用输出改为空数组 | 存活 |
| I07 | brief.task 改为空字符串 | 存活 |
| I08 | brief.placement 一律 local | 存活 |
| I09 | 承诺 sourceSeq 一律 0 | 存活 |
| I10 | setFocus 去掉 active 状态检查 | 存活 |
| I11 | Helper 只核对 ID，移除 caller.kind 守卫 | 存活 |
| I12 | Helper 全局入口跳过鉴权 | 存活 |
| I13 | 重复 ID 检查错查另一键 | 杀死，77 绿 / 1 红 |
| I14 | brief 增加 memory | 杀死，77 / 1 |
| I15 | 控制指令返回 ignore | 杀死，77 / 1 |
| I16 | sidebar becomesMessage=true | 杀死，77 / 1 |
| I17 | global.contextConversation 非 null | 杀死，77 / 1 |
| I18 | 最后任务结束仍 active | 杀死，77 / 1 |
| I19 | 删除 toleranceSec 有限数检查，保留负数检查 | 存活 |
| I20 | 有界检查反转，拒绝合法有界工具 | 杀死，75 / 3 |
| I21 | 时区非空即拒绝 | 杀死，75 / 3 |
| I22 | mention becomesMessage=false | 杀死，77 / 1 |
| I23 | mention.replyToSeq=null | 杀死，77 / 1 |
| I24 | 未加锁也拒绝工作 | 杀死，77 / 1 |
| I25 | commit 原地改输入承诺数组 | 杀死，73 / 5 |
| I26 | bash 拒绝 reason 改成“时区不认识” | 存活 |

共 26：12 杀死、14 存活。原样 C00：78/78，全部 26 个 oracle 绿。

- `$E/independent-mutations.py`：独立注入和逐项执行器；`independent-mutations.json` 保存每项 before/after、三条退出码、失败测试名与 oracle 退出码。
- `$E/mutation-oracles.mjs`：与原实现独立声明的行为判据；`Ixx-{typecheck,lint,test,oracle}.txt` 为原始执行结果。
- `$E/behavior-probes.mjs`、`behavior-results.json`：原实现的领域缺陷、Helper 矩阵与声明边界复现。

复查原实现（在仓库根目录；只读代码）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-review-20261105-KYxuQl/evidence
node "$E/mutation-oracles.mjs" "$PWD" C00
node "$E/behavior-probes.mjs" "$PWD"
```

重建某个变异无需信任作者脚本：取 JSON 的单个 before/after，在新的独立副本中断言 before 恰好出现一次，仅替换该实现字符串；运行 `npm run typecheck`、`npm run lint`、`node --test --test-reporter=tap 'packages/**/*.test.ts'`，再运行 `node "$E/mutation-oracles.mjs" <副本根> Ixx`。该 oracle 对原样应绿、变异应红。保留现有副本，不覆盖冻结的本轮证据。

## 7. 收据第 7 栏核实与未测边界

| 作者边界声明 | 核实结果 / 本轮判断 |
|---|---|
| Helper 只有路由，没有内核写消息接线 | 属实；函数只返回路由对象。不能报消息表隔离和 @ 消息写入 E2E 通过 |
| 通用工具名字表可被改名绕过；bounded 依赖宿主注册 | 属实；`arbitrary_terminal + bounded:true` 被接受。未做宿主注册真实性与执行器工具 Schema 验证 |
| 引用仅校验形状；`sk://abc` 可伪装 | 实测接受；未做 Vault 存在性、授权、启动参数/env 校验 |
| cron 只校验形状、不验证范围 | 实测 `0 99 * * *`、`*/0 8 * * *` 均接受；本轮不将已声明的范围外校验包装成新发现 |
| DST 真实触发未测 | 属实；没有下一触发时刻计算器；120 秒只是测试输入，不是用户阈值定案 |
| 意图由上游给出 | 分类器确实未测，但不足以覆盖 CH-02：现有 work 类型无法承载职责匹配 |
| R-05 覆盖作者列出的 52 种故障 | 数量及杀死结果复现；但不是每条判据已充分标定，14 个独立存活见 CH-04 |

AC-01/31/33/35 整项保留“未测”是诚实的分层边界，不要求这一 PR 交付存储、调度器或真实插件。但是第 7 栏**遗漏了 CH-01、CH-02、CH-03 的纯领域合同缺口**，不能用未来适配器接线笼统兜底。R-05 当前“通过”只能描述作者枚举的有限集合，不能作为本切片双侧标定全部通过的合入依据。

本轮没有新发现可据实断言的性能或代码风格阻塞项；主要缺陷在正确性、领域边界和测试判别力。没有运行持久化重启、真实 Compute 启动、外发插件、调度时刻或 UI 用户体验验收，也未对 PR #3 重新作独立审查结论。

## 8. 回交与门禁状态

Claude Code 在原开发任务中修 CH-01–CH-04，保留正确的 Helper 三入口、联系人定时归属和控制穿透；新增判据须留下先红后绿与独立双侧校准证据，之后交回跨厂商审查。**reject 期间 PR #4 不得标为功能验收完成。**

本轮只允许提交 `reviews/feat-contact-helper.md` 与 `receipts/feat-contact-helper.json` 的 review 字段。完整门禁执行结果、普通 clone 的钩子推送结果在对应外部证据中保留；不能把提交/推送成功解释成 reject 已被解除。

实际运行 `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle`：exit 1。G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 报当前审查会话 `turns.jsonl` 尚不存在。原生 rollout 已能读到 gpt-6-astra，但这不能冒充该门禁已通过。没有伪造会话记录、没有豁免或改门禁；会话正式落盘后仍须由既有合入流程重新核验来源。原始结果是 `$E/gates-local.txt`。
