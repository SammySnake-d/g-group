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

---

## 第二轮：返修后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务返修。** 原先的能力集合分离、职责内接活和等待末次汇报在常见顺序上有明显改善，但仍存在可重现的领域缺陷：确认先于终态时承诺与旧锁残留；已登记为 Compute 专用的脚本可被同名登记为联系人直接工具；空名称也可作为直接工具。另有 5 个本轮独立变异在原测试中全部存活，收据第 7 栏的变异数也与可执行清单不符。不得把审查结束或后续推送成功当成功能验收。

### 复审范围和来源

- 对象：PR #4 `feat/contact-helper`，被审 HEAD `4f6ed39db6dbddf36a75aadaee62ab1566dc9d86`；本轮基线 `origin/feat/task-lifecycle` 为 `75a76cdee568137d96683d3807643a8683183347`。PR #3 的单独审查不在本轮范围。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`，相关会话记录中的生产模型为 `claude-opus-5-5`（Anthropic，渠道前缀不改变原生厂商）。审查者 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，原生 rollout `turn_context.model` 实录为 `gpt-6.1-terra`（OpenAI）。两者跨厂商、无豁免；这不等于 G-PROVENANCE 已通过。
- 仓库根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 的原样 stdout：`0e4fb7f13a2bfd1b5856e37d392e45ccea013adec935e3c340b977aabb46dafa`。本轮只提交本报告和收据 `review` 字段，不改产品实现、测试或第 7 栏。
- 本轮证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round2-exyigB`；此前 Astra 证据保留在第一轮报告所列目录。副本、反例和日志均在仓库以外；`$E/repo` 是普通独立 clone，`git-dir` 与 `git-common-dir` 均为该 clone 的 `.git`。

### 必须修复

**CH-05 [High，AC-31⑤ / AC-35①] 末次汇报确认先到时被静默丢弃，随后终态不能回收。** `packages/domain/src/contact.ts:147-166` 的 `confirmFinalReport` 只处理已在 `awaitingReport` 的任务；若宿主收到真实末次汇报入库确认时任务仍在 `boundTaskIds`，调用静默返回，之后 `settleTask` 又把它加入 `awaitingReport`，没有记住已确认事实。独立实测同一 `T1`：先确认、后终态 → `active`、`awaitingReport=[T1]`、旧 `focus=k1`；先终态、后确认 → `done`、无等待项、`focus=null`。两个条件最终都已成立，第一种顺序却永不自动回收，越界新活仍被旧锁拒绝。规格要求两项条件均满足，未规定确认必须后到；任务生命周期也区分先交付、后用户验收终态。这里不是声称已经实测宿主消息链，只证明纯函数接口丢失了一个合法先到事件。应记录/对账确认事实并防乱序与重放；若设计上必须禁止先到，须有可观察拒绝和可靠重试契约，而不是静默吞掉。加两种顺序的单开关回归与跨任务负对照。

**CH-06 [High，AC-33①，CH-01 未完全闭合] 已标为 Compute 专用脚本的同名资产仍能变成直接工具。** `contact.ts:105-109,121-131`：对新联系人先 `grantComputeAsset({name:"workspace_script",kind:"script"})`，此时 `canCallDirectly` 为 false；随后 `grantTool({name:"workspace_script",bounded:true})` 返回成功，`canCallDirectly` 变为 true，`tools` 与 `computeAssets` 同时出现该名字。反方向（已有直接工具后再登记资产）反而被拒。这里测试的是**同一已知资产名和已登记的脚本类别**，不是单纯改名绕过黑名单；纯函数自己已持有冲突信息。第 7 栏说真实挂载要等适配器核验是对的，但不能证明这条领域决策正确，也不能把本反例说成真实进程已执行了脚本。应对 Compute-only 身份/类别做不可绕过的互斥校验，或引入可区分同名不同能力的权威身份；同时保留合法具名有界工具可供两侧使用的需求。

**CH-07 [Medium，AC-33①] 空名被接受为“具名有界工具”。** `contact.ts:105-109,129-131,191-196` 中 `grantTool({name:"",bounded:true})` 返回成功，`canCallDirectly("")` 返回 true，`briefFor(...tools:[""])` 也成功。即使宿主需保证工具 Schema 真实性，本层也应拒绝空名称（包括仅空白的名称），并对有效命名工具做阴性对照。`grantComputeAsset` 已检查空字符串，但直接工具入口没有。

**CH-08 [High，R-05 / CH-04] 新测试仍漏掉多个不同的真实契约破坏。** 这是**测试判别力缺陷**，不等于原实现已出现以下五种变异行为。每个变异只改隔离副本的一处实现，不改测试；原样对照 typecheck/lint/83 项测试及 5 条独立 oracle 均 exit 0，每个变异 typecheck/lint/83 项测试仍全部 exit 0，但对应独立 oracle exit 1：

| ID | 单点变异 | 原测试漏掉的具体行为 |
|---|---|---|
| N01 | 回收条件只看 `awaitingReport.length === 0`，不看 `boundTaskIds` | A 先终态且已汇报，B 仍运行时承诺过早回收并解锁；现有双任务测试先把两个任务都置终态再确认 |
| N02 | brief 的 `rules` 保留第一条 | 多条生效群规被静默删减，违反需求文档第 78 行不丢约束 |
| N03 | brief 的 `credentialRefs` 保留第一项 | 两个合法凭据引用传入后第二项丢失 |
| N04 | 合法容差由 `< 0` 改为 `<= 0` 拒绝 | 非负数中的 0 被错误拒绝 |
| N05 | 任一承诺回收或撤销时无条件清空 focus | 撤销未被锁定的承诺会错误解除另一条仍有效承诺的专职锁 |

精确替换、退出码和执行器在 `$E/independent-mutations-round2.json`、`$E/independent-mutations-round2.py`；原样及各变异日志为 `$E/{clean,N01..N05}-{typecheck,lint,test,oracle}.log`，判据源码为 `$E/oracles-round2.mjs`。应补上述对应行为测试及阳性/单开关阴性校准，不要只把变异追加为第 7 栏局限仍声称判据已标定。对于 CH-05–07 的真实缺陷，独立回归 `$E/regressions-round2.test.mjs`、`$E/regressions-round2-v2.tap` 为 1 绿 3 红（先终态后确认的对照绿）；修复应先针对真实旧实现留缺陷复现红，再实现。

### 四项旧问题及未回退行为

| 项 | 本轮独立判断 |
|---|---|
| CH-01 | 已增加 `computeAssets`，未登记 `run_command` 不可派、登记后可派且默认不可直调；但同名再次注册绕过隔离，仍须修 CH-06。空名另见 CH-07。 |
| CH-02 | 显式职责 `commitmentId` 使职责内接活、越界拒绝；正常顺序下完成/撤销对应承诺会解锁。但 CH-05 乱序导致旧锁残留，未完全闭合。 |
| CH-03 | 终态先到时会等汇报确认，确认后才回收；确认先到会被吞，仍须修 CH-05。真实入库回执尚未接线或验证。 |
| CH-04 | 作者此前 14 个存活项已加入新清单并在本轮测试中被杀，但新的 5 个独立变异仍存活；其余整体覆盖不能由有限变异数推断。 |

原 Astra oracle 的 **I10、I18 两条原样判据确实过时**：二者仅 `settleTask` 后、没有末次汇报确认，就分别要求旧承诺不可锁定和状态 `done`，与 AC-31⑤ 相反。实跑旧 oracle 于新 HEAD：仅这两项失败、其余 24 项通过（`$E/old-oracles-on-new-head.log`）；不能把这两个失败当新实现错误。但**确认后**已结束承诺不能再加锁、确认后应回收的抽象判据仍适用：本轮作者改写的 I10 及 C02 变异均被杀。这一结论不消除 CH-05 的另一个事件顺序缺口。

独立九格验证 Helper 的 global / mention / sidebar 对本人位置与上下文正确，对非本人用户和同 ID 联系人均拒绝；只证明纯路由，不证明真实消息表写入或隔离。定时仍存在联系人自身 `commitments[].schedule`，不会随无关任务终态回收；控制 stop/revoke/reschedule 均穿透锁；职责内/外判定分别为 handle/decline-focused。见 `$E/behavior-round2.json`。

### 亲自复现与第 7 栏核验

- `npm ci` exit 0；Node v25.8.1 下 `npm run typecheck`、`npm run lint`、`npm test` 均 exit 0，83/83 绿，0 skip/todo；Node v22.22.0 下三项也全部 exit 0。日志 `$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`。
- 普通独立副本检出 `6613c816731f3ef6b23ce23b0a3e24e3be932a19` 并执行 `npm ci`：全量 `npm test` exit 1，56 绿 / 27 红；单独 TAP 核对 27 条均按名字失败（`$E/red-tests.tap`、`$E/red-all-tests.log`）。**但 27 条原因全部为 `未实现`**：红提交把之前已有的 contact/Helper 函数也替换成空壳，因此它证明按名空壳红，不单独证明返修 bug 在旧实现上按预期失败。另在隔离副本把旧实现叠加该红测试、仅给四个旧版不存在的导出加加载占位，得到 18 绿 / 9 红；其中职责内工作有实际断言差异、末次汇报有状态差异，但 Compute-only 用例先因旧错误文案不同失败；该对照不是作者当时留下的历史红记录（`$E/red-prior-overlay.tap`）。
- 作者 `node packages/domain/proof/mutations.mjs` exit 0：**76/76** 个具体变异被具名测试杀死，原样 83 绿（`$E/author-mutations.log`）。源数组为原有 M 系列 52 + I 系列 14 + C 系列 10 = 76。日志共 78 行是“原样对照 1 + 变异 76 + 最终结论 1”，**不是 78 个变异**。收据第 7 栏写“78 种故障”不实，须由作者修正；其中旧 oracle I10/I18 的时序说明则如上所述属实。
- 第 7 栏其余已声称边界基本属实：纯路由无内核消息接线；`arbitrary_terminal + bounded:true` 可绕开名字表；`sk://abc` 通过引用形状检查；`0 99 * * *` 通过 cron 形状检查；未实现 DST 触发、宿主职责分类或真实回执认证。实测见 `$E/behavior-round2.json`；这些不是对应端到端能力通过的证据。除变异数错误，还遗漏 CH-05–07 和本轮变异存活；AC-01/31/33/35 整项保持未测的分层标注是恰当的。

**回交条件：** Claude Code 在原开发任务中修 CH-05–08、修正收据第 7 栏数量并补真实缺陷红测；保留三入口、定时归联系人、控制穿透和合法工具重叠。修复后重新交不同厂商独立复现；当前 reject 不是 PR 已完成。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 实测 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 提示当前审查 `turns.jsonl` 尚不存在。原生 rollout 的模型记录不能冒充此门禁通过；会话结束落盘后由既有流程重核，不伪造记录或豁免。原始输出 `$E/gates-local-rerun.log`。

---

## 第三轮：第二轮返修后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务。** 第二轮 CH-05–08 的具体反例已得到修复，作者所列 91 个变异也均被本轮复现杀死；但本轮发现同一任务关联多条承诺时，单个任务级汇报确认会越过承诺边界，另有无法使用的空白名 Compute 资产，以及与新增时序语义相关的测试盲区。PR #4 仍未通过功能验收。

### 固定对象、来源和可复现结果

- PR #4 `feat/contact-helper`：受审实现 `075961edfcc5c2f8b2c04cc405ee9fbdd173fdd9`；开始复现时指定的 `origin/feat/task-lifecycle` 为 `75a76cdee568137d96683d3807643a8683183347`。审查进行中远端该分支前移到 `96d48dd3fa8e9cc053950d313ce9d344b7408ef6`；本轮不审 PR #3 的返修，基线同步和合并后须重新核对。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的近期生产轮次为 `claude-opus-5-5`（Anthropic）；本轮独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，原生当前 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）。两者跨厂商，无豁免；本机来源门禁仍须等本轮会话记录正式落盘后重核。
- 在仓库根目录亲自运行 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle`，原样 stdout：`23d5df660dd0235d0e80c188e0e86679f4dd20b02f2f7e8c4f68e6a6a74f4417`。
- 本轮证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round3-8kumsV`；`$E/repo` 为普通独立 clone，`.git` 与 common dir 均为该 clone 自己的 `.git`。原实现与测试未修改；变异只在 `$E/mutants/` 的隔离副本。
- `npm ci` exit 0；Node v25.8.1 下 `npm run typecheck`、`npm run lint`、`npm test` 均 exit 0，**93/93**，无 skip/todo；Node v22.22.0 下三项也均 exit 0。日志 `$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`。
- 独立检出红提交 `e7b6bdaf3920166ef1a0cc157b73dc73a5b1a112` 并 `npm ci`；全量测试 56 绿 / 37 红，目标文件 TAP 的 37 项按名字失败，均为 `未实现`，不是加载失败（`$E/red-tests.tap`、`$E/red-all-tests.log`）。红提交仍把既有 contact/Helper 实现替为空壳；它证明空壳按名红，单独不能证明旧缺陷按预期复现。补做隔离对照：只把红提交的两个源码文件换回其父提交真实实现，保留红提交测试，得到 29 绿 / 8 红；CH-05、CH-06、CH-07 的关键用例均出现实际断言差异（`$E/red-prior-overlay.tap`）。这是本轮独立对照，不冒称作者当时留下的历史红记录。
- 亲自执行作者 `node packages/domain/proof/mutations.mjs`：exit 0，原样 93 绿，**91/91** 具体变异被具名测试杀死；源数组计数为 M 52 + I 14 + C 20 + N 5 = 91（`$E/author-mutations.log`）。第二轮独立 `oracles-round2.mjs` 的 N01–N05 原样全部 PASS；`regressions-round2.test.mjs` 4/4 绿（`$E/previous-oracles.log`、`$E/previous-regressions.tap`）。

### 必须修复

**CH-09 [High，AC-31⑤ / AC-35①] 同任务的多条承诺共享一个确认，无法防止回执越过承诺作用域。** `packages/domain/src/contact.ts:172-180` 的 `confirmFinalReport(c, taskId)` 只有任务 ID，逐项扫描并确认**所有**绑定该任务的 active 承诺，既没有承诺 ID，也没有可用于判别报告依据范围的动作/来源位置。`docs/spec/需求文档.md:1043-1046` 则把每条承诺的 `source_seq` 和绑定范围视为独立记录，并要求该承诺的末次汇报确认后才回收。

独立反例（`$E/behavior-round3.json`、`$E/cross-commitment-focus.log`）：`kA(sourceSeq=100)` 要求 T1 在群 A 汇报，随后 `kB(sourceSeq=200)` 要求同一 T1 在群 B 汇报，且 focus 指向 kB。假设群 A 报告已发、其回执在 kB 建立后才到，而群 B 报告尚未发；宿主即使知道该回执只属于 kA，公开接口也只能调用 `confirmFinalReport(c,"T1")`。实测 kA 和 kB 都记录 `reportedTaskIds=["T1"]`；再把 T1 置终态，两条都变 `done`，kB 的锁被清空，职责外新活返回 `handle`。一条确认若**明确覆盖**两条承诺当然可以同时生效；问题是这里无法表达“只覆盖 kA”，也不能依据 `source_seq`/动作信息阻止旧确认替新承诺放行。 若宿主约定等所有同任务承诺的报告都确认后才调用，可避免此例早退，但也无法在 kA 已满足而 kB 仍等待时独立回收 kA；这一额外先决条件及其回收延迟均未由本片契约表达或验证。此处是纯函数接口与状态反例，不声称真实内核、消息库或群 B 已发生实际发送。第 7 栏只说宿主验证回执真实性、未绑定任务不记录，并未覆盖**同一已绑定任务上的不同承诺及迟到旧回执**；仅把真实性交给宿主无法弥补缺失的选择接口。

应让确认事件带可验证的承诺/动作作用域（或由宿主显式传入确已被该报告覆盖的承诺集合及必要因果版本），只更新匹配的承诺，兼容一条报告经明确判定覆盖多条承诺；为先确认/后终态、先终态/后确认、同任务多承诺、旧回执迟到和真实同报告覆盖两条设置正反对照与重放测试。独立回归 `$E/regressions-round3.test.mjs` 的首项在当前实现失败，单承诺对照通过；执行输出 `$E/regressions-round3.tap`。

**CH-10 [Medium，AC-33 / 具名资产一致性] 仅空白的 Compute 资产名可登记但永远无法派出。** `contact.ts:125-130` 的 `grantComputeAsset` 只判断 `!a.name`，所以 `{name:"   ",kind:"script"}` 返回成功并保存；`briefFor` 的 `contact.ts:206` 随后拒绝该名称为“工具名不能为空”。它不是上轮已经修好的 `grantTool` 空名问题，而是同一能力生命周期的另一入口：登记成功产生不可使用的资产。`$E/behavior-round3.json` 和 `$E/regressions-round3.tap` 实测空格/制表符负例，合法非空名称是正例。建议资产登记也以空白检查拒绝无效名，并保留合法具名资产的授予、派出和互斥对照。

**CH-11 [High，回归测试判别力] 5 个独立单点变异存活。** 以下不是说当前实现已有这些变异行为：原样副本的 typecheck/lint/93 项测试和五个独立 oracle 均通过；每个变异仅改一处实现，typecheck/lint 和 93 项现有测试仍全绿，且其独立 oracle 精确失败。应为实际涉及的撤销后迟到事件、多工具、双任务乱序增加行为测试和阳性/阴性校准：

| ID | 单点变异 | 测试未发现的行为 |
|---|---|---|
| P01 | 汇报确认不再检查承诺是否 active | 对已撤销承诺的迟到确认仍写入 `reportedTaskIds` |
| P02 | 任务终态不再检查承诺是否 active | 承诺在确认先到后已撤销，迟到终态把它由 revoked 错改为 done |
| P03 | Compute brief 只保留第一项合法工具 | 两个均已授权的工具中第二项被静默丢失 |
| P04 | 收到终态后汇报确认时，丢弃等待表第一项而非当前 taskId | 先终态 A、B，再先确认 B，会错误移除 A，无法按各自回执回收 |
| P05 | 终态消耗预先确认记录时，丢弃第一项而非当前 taskId | A、B 均已提前确认而 B 先终态时，会消耗 A 的确认，最终可能错误等待 |

`$E/independent-mutations-round3.json` 记录准确替换与四条退出码；`$E/independent-mutations-round3.py` 是独立执行器，`$E/oracles-round3.mjs` 是与之分开的判据，原始日志为 `$E/{clean,P01..P05}-{typecheck,lint,test,oracle}.log`。作者 91 个列举项确实被杀；五个存活反例说明这些新增边界的测试不充分，**不是**声称有限变异清单必须覆盖所有可能故障，也不是否认已复现的 91 项结果。

### 旧项及第 7 栏核对

| 项目 | 本轮判断 |
|---|---|
| CH-05 | 对**单条承诺**，确认先到或终态先到均可回收；重复确认、无关任务和原先专职锁反例已通过。跨承诺作用域仍有 CH-09。 |
| CH-06 | 相同名称的 Compute 专用资产与直接工具双向互斥；不同名但同一底层能力的识别仍依赖宿主，如第 7 栏所披露。 |
| CH-07 | 直接工具及 Compute brief 的空名/空白名已拒；新增发现 Compute 资产登记入口仍放行空白名，见 CH-10。 |
| CH-08 | 第二轮 N01–N05 原样注入均被现有测试杀死，上轮独立 oracle 和回归也全绿；本轮新增独立盲区见 CH-11。 |

独立验证了 Helper global / mention / sidebar 的三入口 × 本人 / 他人 / 同 ID 联系人 9 格、定时承诺归联系人且其绑定任务终态不回收、职责内接活、职责外拒绝、stop/revoke/reschedule 穿透以及撤销目标承诺解锁（`$E/safeguards-round3.log`）。这些都是纯函数结果，不代表真实消息表、DST 调度或插件端到端通过。

第 7 栏的 91 个数及 M/I/C/N 构成现已纠正；名字表可改名绕过、同能力不同名不可识别、`bounded` 信任宿主、凭据仅验证引用形状、cron 不验范围、职责归属上游判断、无真实入库回执认证和 Helper 无内核接线等边界与现有实现一致。AC-01/31/33/35 保持整项未测是合理分层；但第 7 栏没有披露 CH-09 的同任务跨承诺回执作用域缺口或 CH-10 的空白资产名。Astra 旧 I10/I18 仅在终态即回收的旧语义下成立，第二轮已独立判为过时；确认之后的回收/不可再锁定判据仍有效。

**基线前移与整合阻塞：** 审查中只将远端最新基线取到独立 clone，未修改或合并产品代码。`75a76cd` 和新 `96d48dd` 与受审 HEAD 的共同祖先均为 `c6ca694`；在两种本地基线下运行指定 `--hash`，输出同为上述 `23d5…4417`，但这只固定当前 PR 内容，不证明与新基线可以合并。对 `075961e` 和新基线运行不改工作区的 `git merge-tree --write-tree`，exit 1，`packages/domain/proof/mutations.mjs` 和 `packages/domain/proof/mutations.txt` 存在内容冲突（`$E/base-advance-merge-tree.log`）。两条产品线按既有负责人整合并重跑测试、变异和门禁后，再重新审查整合结果；不能因哈希没变就声称新基线已验收。

**回交条件：** Claude Code 在原开发任务修 CH-09–11，补针对真实旧实现的缺陷红测和上述变异/单开关对照，保留此前已验证的三个 Helper 入口、定时归属、控制穿透及允许的安全工具重叠；修复后再次交跨厂商独立复现。不要因报告提交或预推送测试通过而标记 PR 已验收。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 实测 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 拦下；G-PROVENANCE 找不到与本轮 `reviewed_hash` 相同的审查工具输出，且无法识别该审查轮厂商。检查时该会话 `turns.jsonl` 只有上一轮，当前轮尚未落盘；原生 rollout 中可观察到本轮模型，但不能冒充 G-PROVENANCE 通过。应待本轮落盘后由既有流程重核，不伪造记录或豁免。原始输出 `$E/gates-local.log`。拉取新基线后重跑同一命令仍 exit 1，结果和内容哈希相同（`$E/gates-local-live-base.log`）；这也不替代上面的实际合并冲突检查。

---

## 第四轮：第三轮返修后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务继续返修。** 第三轮 CH-09–11 的具体反例已修，101 个作者变异均被复现杀死；独立模型也覆盖了 720 个有效事件排列。但新增回执来源位置的比较对非有限 `number` 失效，可能在纯函数中提前回收并解锁；此外独立变异显示若干作用域/重放测试盲区。当前 PR 也与最新 PR #3 基线有实际合并冲突。不得把本轮结束或推送成功视为功能验收完成。

### 固定对象与独立复现

- PR #4 `feat/contact-helper`，受审 HEAD `792067761bc9e164b7d3555d36a9a8d2a17e0119`；本轮基线 `origin/feat/task-lifecycle` 为 `44c5ab6f67c9528ac47132f6384d1152f64d05ac`。本轮不替 PR #3 返修作审查结论。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`，生产模型 `claude-opus-5-5`（Anthropic）；独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，本轮原生 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI），无豁免。实际模型记录不等同于本地 G-PROVENANCE 已通过。
- 仓库根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle`，原样 stdout：`677bed266beaea0696b7a7da8e4a367d570e539819dd65a6c537e4289962dbbd`。
- 证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round4-Ea3pen`。`$E/repo` 为普通独立 clone，`.git` 与 common dir 均为该 clone 自己的 `.git`；被审实现与测试没有修改，独立变异只写 `$E/mutants/` 副本。
- `npm ci` exit 0；Node v25.8.1 下 typecheck、lint、test 均 exit 0，**101/101**，无 skip/todo；Node v22.22.0 下三项也均 exit 0（`$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`）。
- 检出红提交 `fc3980daf56103868639b76a59bbe8c3d84e4b01` 并 `npm ci`：全量测试 56 绿 / 45 红；目标文件 TAP 45 项均按名字失败、均为 `未实现`，不是加载失败（`$E/red-tests.tap`、`$E/red-all-tests.log`）。它把已有实现置空，证明空壳按名红但不能单独证明旧缺陷复现。另在隔离副本叠加父提交真实源码，并**只桥接新回执对象到旧 taskId 参数，保留旧任务级语义**，新测试得到 41 绿 / 4 红，CH-09 作用域与 CH-10 空白资产断言实际失败（`$E/red-prior-overlay-retry.tap`）；这是本轮对照，不冒称作者的历史红输出。
- 作者 `node packages/domain/proof/mutations.mjs` exit 0：原样 101 绿、**101/101** 具体变异被具名测试杀死；源数组为 M 52 + I 14 + C 25 + N 5 + P 5（`$E/author-mutations.log`）。

### 上轮问题及不回退项

第三轮独立 `oracles-round3.mjs` 按新接口作本轮自己的适配：测试中的旧任务级确认对应现有承诺集合和合法依据位置，P01–P05 **5/5 PASS**。第三轮 `regressions-round3.test.mjs` 的适配保留“群 A 回执只点名 old、依据位置 100”语义，**3/3 绿**（`$E/oracles-round3-adapted.mjs`、`$E/adapted-oracles.log`、`$E/regressions-round3-adapted.test.mjs`、`$E/adapted-regressions.tap`）。不是原样调用已改变签名的旧测试，也不是直接采信作者 `/tmp` 结果。

CH-09：同任务分别点名、旧来源位置排除新承诺、明确一条回执覆盖两条、两种终态/确认顺序和重放，均在合法序号输入下成立；CH-10 的空/空白 Compute 资产名拒绝成立；CH-11 的 P01–P05 均被现有测试杀死。独立参考状态模型对两承诺、两任务、三个不同作用域/依据位置回执、终态与撤销的 **720 种排列、8,640 次状态检查**均通过，包含每步即时重放（`$E/state-matrix-round4.mjs`、`$E/state-matrix-round4.log`）；只代表这些枚举，不是端到端证明。

Helper 三入口 × 本人/他人/同 ID 联系人 9 格、定时归联系人且绑定任务终态不回收、职责内外判断、stop/revoke/reschedule 控制穿透、撤销解锁和能力同名双向互斥均经独立适配用例通过（`$E/safeguards-round4.log`）。`helper.ts` 在 f01a84c 与本轮 HEAD 的 Git blob 均为 `8c69b2b9d8162baff516325e89dfe804450bcebf`。这些是纯函数检查，不代表消息表、DST 或外部插件已交付。

### 必须修复

**CH-12 [Medium，AC-31⑤ 回执边界] 非有限序号绕过出处比较，错误确认和回收。** `packages/domain/src/contact.ts:138-141,172-187` 的 `sourceSeq`、`basedOnSeq` 都是 TypeScript `number`，没有有限性/整数校验；`k.sourceSeq > receipt.basedOnSeq` 对 `NaN` 返回 false，因此不能按承诺的“仅当 sourceSeq ≤ basedOnSeq”防止放行。独立实测，承诺出处为 200、专职锁指向它：合法依据 199 不确认、200 确认；`basedOnSeq=NaN` 和 `Infinity` 也会把任务记入 `reportedTaskIds`，随后 `settleTask` 将承诺置 `done` 并清锁（`$E/receipt-sequence-boundary.log`）。反方向 `commit` 也接受 `sourceSeq=NaN`，有限依据 100 的回执随后同样可确认并回收（`$E/invalid-source-corrected.log`）。`Number.NaN` 在该接口声明下确实通过静态类型检查（`$E/nan-static.ts`、`$E/nan-static-retry.log`）。

这是**畸形宿主输入**触发的纯函数边界反例；本片尚无真实宿主调用方，未观察到实际宿主产生 NaN 或消息真实丢失，也不把它宣称为远程利用。它仍是本片自己承诺的来源比较未能 fail closed：第 7 栏说明宿主判定回执作用域和真实性，但未说明序号非法时放行。群消息位置是单调序号（`packages/domain/src/log.ts:63`），并非 NaN/Infinity。建议按项目日志序号合同对承诺出处与回执依据位置做有限、整数及合法范围校验；无效值明确拒绝或保持状态不变，绝不能静默确认。补合法旧位置、相等位置、非法数值和无关承诺单开关对照。独立回归 `$E/receipt-sequence-regression.tap`：旧/相等两个对照通过，NaN 回执、Infinity 回执、NaN 出处三项失败。

**CH-13 [Medium，测试判别力] 作用域与重放仍有本轮独立盲区。** 本轮 5 个单点变异中，Q01–Q04 typecheck/lint/101 项现有测试均绿，但各自独立 oracle 红；Q05 被现有具名测试杀死。原样代码和 5 个 oracle 全绿。这些是**测试缺口**，不宣称原实现有 Q01–Q04 的变异行为，也不以“有限清单没有穷尽所有变异”否认作者 101 项的实际结果。

| ID | 单点变异 | 结果及缺失的边界 |
|---|---|---|
| Q01 | 空 `commitmentIds` 当成覆盖全部承诺 | 存活；空作用域应不确认任何承诺 |
| Q02 | 所有点名承诺共用第一条承诺的来源位置做比较 | 存活；同回执点名来源 100 和 200、依据 150 时应只确认前者 |
| Q03 | 只检查上一次报告，代替检查任务是否已经报告过 | 存活；先确认 T1、再 T2、重放 T1 应保持幂等 |
| Q04 | 资产空白校验只覆盖空格和制表符 | 存活；换行和非断行空格仍属于空白名 |
| Q05 | 来源等于依据位置也拒绝 | **被杀**；现有测试准确检测相等边界 |

应优先补 Q01–Q03 对应的有效输入/事件序列及各自故障的阳性和单开关阴性对照，Q04 补代表性空白字符；不要只追加变异计数。`$E/independent-mutations-round4.json` 保存精确替换和四条退出码，执行器与独立判据分别为 `$E/independent-mutations-round4.py`、`$E/oracles-round4.mjs`，原始日志 `$E/{clean,Q01..Q05}-{typecheck,lint,test,oracle}.log`。

### 基线、收据与交回

第 7 栏所述的宿主判定回执作用域及真实性、本层只比较来源位置、同一底层能力不同名无法识别、工具黑名单/凭据引用仅形状、cron 不验范围、无真实 DST/插件/Helper 内核接线等边界与本片实现一致；101 个变异数量和构成也已复现。它未覆盖 CH-12 的非有限序号放行。AC-01/31/33/35 整项保持未测是合理分层。

对受审 HEAD 和本轮 `44c5ab6` 基线运行不改工作区的 `git merge-tree --write-tree`：exit 1，`packages/domain/proof/mutations.mjs` 和 `packages/domain/proof/mutations.txt` 内容冲突（`$E/merge-tree.log`）。按既有负责人在 PR #3/PR #4 的集成阶段处理，不在本次审查里改代码；整合后重新跑测试、变异、哈希和门禁并再次跨厂商复审。

**回交条件：** Claude Code 在原开发任务修 CH-12、补 CH-13 中与来源作用域/幂等直接相关的正反对照，保留前三轮已通过的行为；然后处理基线冲突并重新交独立复现。用户要求的连续落地流程继续，不能把 reject 的审查轮当成项目完成。

**执行器纠错记录：** 首次独立 `tsc` 文件检查遇 TS5112、exit 1（`$E/nan-static.log`）；补 `--ignoreConfig` 后 exit 0（`$E/nan-static-retry.log`）。一次 shell heredoc 接到 `tee` 而非 Node，输出的是源码、退出码未单独记录，没有作为行为证据；改正重定向后才记录 `$E/invalid-source-corrected.log`。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 实测 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 未找到等于本轮 `reviewed_hash` 的审查工具输出，也无法识别该审查轮厂商。检查时 `turns.jsonl` 仅包含先前轮次，当前轮尚未落盘；原生 rollout 可观察当前模型，但不能冒充该门禁通过。会话落盘后由既有流程重核；不伪造记录、不使用豁免。原始输出 `$E/gates-local.log`。

**推送后基线变化（同日复核）：** 本轮报告推送完成后，远端 `feat/task-lifecycle` 由 `44c5ab6` 前移至 `cb3fba02725c37d8de3b2e066a04ce44c8019eda`。只读取最新基线并对当前审查提交做 `git merge-tree --write-tree`：仍 exit 1，冲突仍为 `packages/domain/proof/mutations.mjs`、`packages/domain/proof/mutations.txt`（`$E/merge-tree-live.log`）。以新 `origin/feat/task-lifecycle` 再执行指定 `--hash`，输出仍为 `677bed266beaea0696b7a7da8e4a367d570e539819dd65a6c537e4289962dbbd`；共同祖先仍为 `c6ca694`。这不代表已合并或验收新基线，仍须由原开发任务整合冲突并重新复验。

---

## 第五轮：第四轮返修及最新基线合并后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务继续返修。** 上轮 CH-12/CH-13 的真实反例与独立判据已修复，作者列举的 182 个变异也全部复现杀死；但本轮发现 Compute 能力资产同名异类登记会静默丢掉后者并错误返回成功。另有独立变异揭示安全整数边界与已结束承诺状态的测试盲区。该审查轮结束不是整个后端、文档需求或用户故事已验收完成。

### 固定对象、来源与执行

- 按更正后的对象审查 PR #4 `feat/contact-helper`，受审 HEAD `884705194ce932a37638b6bdb696e71f83adc284`；更正复现开始时的 `origin/feat/task-lifecycle` 为 `b50c0e9f87d686bf72898b45deae3da54f3a72fb`，审查期间远端后续前移到 `3455da04b10f98ed4921be4b51f5f7406e2223d1`。合并提交 `7b1472a2b9f1bc29b6e9929abb37fea965d28729` 的父提交是 `635f154` 与 `b50c0e9`；`8847051` 相对该合并只修改收据。PR #3 本身另有独立审查，本轮不替它作结论。
- 第一次以 `635f154` 开始的草稿保留为本地证据、未提交；更正后重新普通 clone、测试和计算哈希。`contact.ts`、`helper.ts` 及其测试在 `635f154` 和 `8847051` 的 Git blob 逐一一致，但全仓测试和变异因合并重新执行。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的生产模型为 `claude-opus-5-5`（Anthropic）；本轮独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，原生当前 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI），无豁免。原生模型记录不等同于 G-PROVENANCE 已通过。
- 在仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 的原样 stdout：`11368d01517df2597deb843667bf9a2e61f01cf6c9653803e2b72aef5644fcfc`。旧 HEAD 的 `d290…78f3` 不用于本轮收据。
- 证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round5-corrected-GSFaDm`；`$E/repo` 是普通独立 clone，`.git` 与 common dir 均为该 clone 自己的 `.git`。先前执行证据根 `$E0=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round5-NqaK29`；产品实现与测试未修改，独立变异只写 `$E/mutants/`。
- `npm ci` exit 0；Node v25.8.1 下 typecheck、lint、test 均 exit 0，**149/149**、无 skip/todo；Node v22.22.0 下三项也均 exit 0（`$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`）。
- 红提交仍为 `5c244deea7ac35bf43ea63126af03caf529289ca`，已验证为当前 HEAD 祖先；复用先前独立红 clone 的 `npm ci` 和全量测试证据（`$E0/red-npm-ci.log`、`$E0/red-all-tests.log`，该历史快照 85 绿 / 51 红），又复跑目标文件 TAP，51 项均按名字失败、错误均为 `未实现`（`$E/red-tests.tap`）。红提交把已有 contact/Helper 实现置为空壳，不是导入失败，但单靠它不能证明旧缺陷红。此前隔离副本保留该红测试、仅换回红提交父提交真实源码，得 49 绿 / 2 红；两条 CH-12 用例对旧行为断言失败（`$E0/red-prior-overlay.tap`）。这是独立对照，不冒称作者历史红输出。
- 自己运行作者 `node packages/domain/proof/mutations.mjs`：exit 0，原样 149 绿、**182/182** 变异被具名测试杀死（`$E/author-mutations.log`）。实际数组 M52 + A14 + N14 + B9 + R11 + C9 + S14 + I14 + K30 + CN5 + P5 + Q5 = 182，无重复编号；任务侧实际 C01–C09 共 9 项，收据的 C9 计数正确。对照两个合并父提交，PR #4 侧 159 项及基线侧 105 项均有对应编号/描述，contact 旧 C01–C30 映射为 K01–K30（`$E/merge-mutation-id-audit.log`）。

### 上轮问题和保留行为

原样执行第四轮独立 `oracles-round4.mjs`，Q01–Q05 **5/5 PASS**；非有限序号旧回归 **5/5 绿**（`$E/previous-oracles.log`、`$E/previous-sequence-regression.tap`）。源码中的 CN01–CN05 与原始第二轮 N01–N05 替换前后字符串完全一致；Q01–Q04 与第四轮替换完全一致，Q05 把注入上下文扩到整条 guard，但实际仍是原来的 `>` → `>=`（`$E/mutation-origin-audit.log`）：故障语义保留，文本注入范围并非逐字相同。

上轮独立 **720 个事件排列/8,640 次检查**全部通过；本轮再跑独立参考状态模型 **1,000 个固定种子场景、30,000 次逐步状态检查、4,856 次重放**，覆盖三承诺/三任务、空和混合作用域、旧依据位置、未知 ID、终态与撤销，均通过（`$E/state-matrix.log`、`$E/state-random.log`；模型脚本保留在 `$E0/state-random-round5.mjs`）。这些只证明列举和采样的纯函数行为。

Helper 三入口 × 本人/他人/同 ID 联系人 9 格、定时归联系人且绑定任务终态不回收、职责内外判断、控制指令穿透、撤销解锁以及直接工具与 Compute 资产同名双向互斥均通过（`$E/safeguards.log`）；`helper.ts` 在 `8227ef4`、`635f154` 和本轮 HEAD 的 Git blob 均为 `8c69b2b9d8162baff516325e89dfe804450bcebf`。这些不代表消息表、DST 或真实插件已验收。

### 必须修复

**CH-14 [High，AC-33 / U66 能力白名单] 不同类型同名资产第二次登记返回成功却静默丢失。** `packages/domain/src/contact.ts:127-132` 的 `grantComputeAsset` 以 `x.name === a.name` 判重，命中后不管 `kind` 是否相同都返回 `ok:true`、原 contact。独立实测：先登记 `{name:"research",kind:"mcp"}`、再登记 `{name:"research",kind:"skill"}`，第二次返回成功，但 `computeAssets` 仍只有 MCP；顺序反过来，第二次也返回成功但只保留 Skill。`briefFor` 的工具表示只有名字（`contact.ts:215-225`），返回的 `research` 不能自行区分两个被请求的类别（`$E/asset-kind-conflict.json`；该探针源保留于 `$E0/asset-kind-conflict.mjs`）。

母规格 `docs/spec/需求文档.md:668-670` 要求从全局库分别勾选联系人所需 Skill 子集与 MCP 子集，未规定两类显示名必须跨类全局唯一；这里测试的是两类显示名相同的情形。不声称真实适配器已经挂错工具——适配器尚未交付——而是纯函数已对未实际登记的第二个请求报告成功。即便将名称规定为全局唯一，代码也已有信息检测 `kind` 冲突，不应返回假成功。应明确资产身份/命名空间：使不同类资产能可靠区分和传递，或在明确宿主全局唯一标识约束时拒绝冲突并给可操作原因；同时保留同名同类幂等和合法安全工具重叠。独立回归 `$E/asset-kind-regression.tap`：两种登记顺序都红，同名同类/不同名对照绿；测试源码保留于 `$E0/asset-kind-regression.test.mjs`。

**CH-15 [Medium，R-05 覆盖] 安全整数边界与已结束承诺状态的变异存活。** 原样副本 typecheck/lint/149 项测试和五个独立 oracle 均绿；每个变异只改一个注入点，Z01–Z04 的三项项目检查和全部测试仍绿、独立 oracle 红；Z05 被现有具名测试杀死。这些是测试判别力缺口，**不意味着原实现已有这些变异行为**，也不否认作者 182 项的结果：

| ID | 单点变异 | 未被现有测试发现的后果 |
|---|---|---|
| Z01 | `Number.isSafeInteger` 改为 `Number.isInteger` | 超过 `MAX_SAFE_INTEGER` 的不安全位置被接受，非负安全整数判据丢失 |
| Z02 | 额外拒绝 `Number.MAX_SAFE_INTEGER` | 最大合法安全整数被拒 |
| Z03 | 加锁允许任何非 `done` 状态 | `revoked` 承诺可被重新锁定，违背只锁 active 的边界 |
| Z04 | 撤销允许任何非 `revoked` 状态 | 已 `done` 承诺可被改写为 revoked |
| Z05 | 拒绝序号 0 | **被杀**；现有用例覆盖 0 边界 |

建议至少补 Z01 的不安全值/最大安全值对照，以及 Z03/Z04 的 revoked/done 区分和对应阳性埋雷；这些针对已声明的安全整数及已结束承诺状态，而非要求有限清单穷尽所有故障。`$E/independent-mutations-round5.json` 保存精确替换与退出码；执行器、独立判据和原始日志分别为 `$E/independent-mutations-round5.py`、`$E/oracles-round5.mjs`、`$E/{clean,Z01..Z05}-{typecheck,lint,test,oracle}.log`。

### 基线、收据边界与交回

受审时 `b50c0e9` 已为 HEAD 祖先，不改工作区的 `git merge-tree --write-tree` exit 0（`$E/merge-tree.log`）；本轮不把先前 `a35b78e` 对 `b50c0e9` 的冲突错误套到已合并的 `8847051` 上。审查期间远端基线又前移至 `3455da0`，新增提交只改 PR #3 的审查报告和收据；共同祖先仍为 `b50c0e9`，不改工作区的试合并 exit 0（`$E/merge-tree-live.log`）。以更新后的 `origin/feat/task-lifecycle` 重跑指定 `--hash`，输出仍为 `11368d01517df2597deb843667bf9a2e61f01cf6c9653803e2b72aef5644fcfc`。这不是对 PR #3 审查结论的替代；若产品基线再次前移，须重新检查合并、哈希、测试与门禁。

第 7 栏如实声明非法回执静默不改状态、宿主看不到理由，位置只检查非负安全整数而不检查日志存在/末尾、回执作用域真实性由宿主负责；也声明工具名字表/同能力不同名、凭据仅形状、cron 不验范围、DST/Helper 内核/真实插件未完成。这些边界没有被纯函数结果取代。第 7 栏未披露 CH-14 的**同名不同类型假成功**；AC-01/31/33/35 整项继续标未测是正确的分层。

**回交条件：** Claude Code 在原开发任务处理 CH-14、补 CH-15 的关键正反对照，并按最新 PR #3 基线重新运行相关验收与门禁，再交跨厂商独立复审。用户要求的后端持续实现与验收流程继续，不能把审查轮或 PR 单片测试绿当成全部文档/用户故事完成。

**执行器纠错：** 先前独立清单审计脚本放在仓库外，首次从脚本目录解析 `typescript` 报 `ERR_MODULE_NOT_FOUND`、exit 1（`$E0/mutation-origin-initial.log`）；改为从被审仓库 `node_modules` 解析后 exit 0，并在更正 HEAD 上重跑（`$E/mutation-origin-audit.log`）。平台曾返回 422 设备验证错误导致上次尝试未完成；本轮复用现存证据并继续，未据此推断更广泛网络故障或宣布目标完成。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 在 `8847051` / `b50c0e9` 上实测 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 和 **G-PROVENANCE 均通过**；G-REVIEW 因本轮 reject 正确拦下。经检查，已落盘审查轮中确有一次指定哈希工具输出与本轮 `reviewed_hash` 完全一致，模型为 `gpt-6.1-terra`。原始输出 `$E/gates-local.log`；在远端更新至 `3455da0` 后重跑本地门禁仍 exit 1，G-PROVENANCE 等七项通过、G-REVIEW 因 reject 拦下（`$E/gates-local-live-base.log`）。来源门禁通过不等于产品审查或用户故事验收通过。

---

## 第六轮：第五轮返修及最新基线合并后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务补齐资产规则的行为测试与双侧校准。** 上轮 CH-14/CH-15 的具体反例在当前实现中均已修复；本轮未复现同名异类假成功或其他必须修的资产实现错误。拒绝依据是现有自动测试对同名类别组合、同类多资产等已声明规则的判别力不足，而不是把独立变异中的故障冒充当前代码故障。建议一次加入完整类型组合表驱动用例，再继续后端其他切片，避免逐变异零碎返修；本轮结束不是整个后端或用户故事已验收完成。

### 固定对象、来源与独立复现

- 按更正后的对象审查 PR #4 `feat/contact-helper`，受审 HEAD `2aff4ca068f8dcb18a35163165f68b8dac88f23e`；基线 `origin/feat/task-lifecycle` 为 `fdfecb13f48262b85610cbf62fb7d3a84cd8badb`。合并提交 `a263f2f3a6de9ed1e7914d4e1fe0fdf08c0e36dd` 的父提交是 `1bd870c` 与 `fdfecb1`；`2aff4ca` 相对该合并只修改收据。基线是 HEAD 祖先，不改工作区的试合并 exit 0（`$E/merge-tree.log`）。PR #3 本身另有独立审查，本轮不替它作结论。
- 本轮先按 `1bd870c` 取证，期间接到更正后重新普通 clone、重新跑全仓测试和变异；`contact.ts`、`helper.ts` 及其测试在 `1bd870c` 与 `2aff4ca` 的 Git blob 逐一一致。旧 HEAD 的本地审查提交未采用；旧普通非强推在钩子完成后被远端以 `fetch first` 拒绝、exit 1，没有覆盖新分支。旧证据保留在 `$E0`。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的生产模型为 `claude-opus-5-5`（Anthropic）；本轮独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，当前原生 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI），无豁免。实际模型记录不等于 G-PROVENANCE 已通过。
- 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 的原样 stdout：`b2b5f7a7af8488b43eb1210e2fe13f71e2fd29714abfb175ac70cd1d79500fd5`。旧 HEAD 的 `a6d8…d4ee` 不用于本轮收据。
- 本轮证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round6-corrected-Du4tIb`，先前固定 `1bd870c` 的证据根 `$E0=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round6-1eG5kn`。`$E/repo` 为普通独立 clone，`.git` 与 common dir 均为本 clone 的 `.git`；被审实现和测试未改，独立变异只写 `$E/mutants/`。
- `npm ci` exit 0；Node v25.8.1 下 typecheck、lint、test 均 exit 0，**172/172**、无 skip/todo；Node v22.22.0 下三项也均 exit 0（`$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`）。
- 红提交仍为 `708b7fea3b02340c94ed838a4f35609339df4475`；复用先前独立红 clone 的安装和全量测试证据（`$E0/red-npm-ci.log`、`$E0/red-all-tests.log`，历史快照 98 绿 / 57 红），再复跑目标文件 TAP，57 项均按名字失败、错误均为 `未实现`（`$E/red-tests.tap`）。红提交把已有实现置为空壳，不是加载失败，但单靠它不能证明旧缺陷红。此前隔离副本保留红测试、仅换回其父提交真实源码，得 56 绿 / 1 红；CH-14 同名异类用例对旧行为实际断言失败（`$E0/red-prior-overlay.tap`）。这是本轮独立对照，不冒称作者历史红记录。
- 自己运行作者 `node packages/domain/proof/mutations.mjs`：exit 0，原样 172 绿、**216/216** 变异被具名测试杀死（`$E/author-mutations.log`）。源码数组 contact/helper 85、其他 131，编号无重复；对照两个合并父提交，PR #4 侧 190 项和基线侧 131 项均保留编号/描述，D01–D11、T01–T15 无撞名（`$E/merge-mutation-id-audit.log`）。原始第五轮 Z01–Z05 注入前后字符串与本轮清单逐一一致（`$E/mutation-origin-audit.log`）。
- 对 `a263f2f` 的 Git 重合并差异核对：`mutations.mjs` 的冲突位于头部注释，`mutations.txt` 也有内容冲突并已重生成；`contact-helper-tests.txt` 有重生成差异但重合并输出未标为冲突。两侧条目和实际运行数如上复核，不把已处理的证明文件冲突当作当前未解决冲突。

### 上轮修复与独立实际行为

原样执行第五轮独立 `oracles-round5.mjs`，Z01–Z05 **5/5 PASS**；第五轮同名异类回归 **3/3 绿**；第四轮非法序号回归 **5/5 绿**（`$E/previous-oracles.log`、`$E/previous-asset-regression.tap`、`$E/sequence-regression.tap`）。新代码对同名异类返回带两种类型的拒绝理由、保留旧资产；同名同类幂等、不同名可并存。第 7 栏明确声明宿主若需同名 MCP 与 Skill 并存，必须采用不同名称；适配器如何保留真实身份、并能否按用户选择加载，仍是后续跨层验收边界，不得算作本轮端到端通过。

本轮在更正 HEAD 上独立运行 **3×3 同名类别顺序/幂等矩阵 + 3 类双资产授予、派发及直接调用隔离**，共 12 格全部通过（`$E/asset-matrix.log`；脚本 `$E0/asset-matrix-round6.mjs`）。先前独立状态模型 1,000 个固定种子场景、30,000 次逐步检查、4,856 次重放仍通过；Helper 三入口 × 本人/他人/同 ID 联系人、定时归联系人、职责内外、控制穿透、撤销解锁及能力互斥也通过（`$E/state-random.log`、`$E/safeguards.log`）。`helper.ts` 在 `1bd870c` 与本轮 HEAD 的 Git blob 都为 `8c69b2b9d8162baff516325e89dfe804450bcebf`。这些都是纯函数结果。

### 必须补齐的测试门禁

**CH-16 [Medium，R-05 / AC-33、U66] 同名类别组合和同类多资产的回归测试不充分。** 更正 HEAD 的原样实现、typecheck/lint/172 项现有测试以及五个独立 oracle 均绿；在隔离副本分别注入以下故障后，W01–W04 的 typecheck/lint/172 项原有测试仍全绿，但对应 oracle 红。W05 为已能杀死的对照。这里的 W 行是**人为注入的故障**，不是当前实现已坏；当前实现的相应 12 格外部矩阵均通过。

| ID | 单点变异 | 现有测试漏掉的后果 |
|---|---|---|
| W01 | 只在其中一类为 MCP 时拒绝同名异类 | Skill→Script 或 Script→Skill 会恢复同名异类假成功 |
| W02 | 同名同类幂等只对 MCP 生效 | Skill 或 Script 的重复登记产生重复项 |
| W03 | 把精确名称匹配改成前缀匹配 | `research-news` 与 `research` 两个不同资产被混成一个 |
| W04 | 按“名称相同**或类别相同**”判重 | 同类的第二个不同名 MCP/Skill/Script 返回成功却被静默丢失 |
| W05 | 删除同名异类拒绝 guard | **被杀**；现有 CH-14 用例能发现 |

这不是要求有限变异清单穷尽所有故障。W01/W02 覆盖 `ComputeAsset.kind` 现有三类的不同/相同组合，W04 覆盖母规格 `docs/spec/需求文档.md:668-671` 明确给出的同一联系人选择多个 Skill 的基本场景；若当前测试不能阻挡这些故障，就不能仅凭 216 项通过断言这些具体边界已被持续回归保护。建议一次性把上述 **3×3 同名类型表 + 每类两个不同名称并验证派发**纳入仓库测试，按 R-05 增加对应阳性埋雷与单开关阴性对照；精确名称前缀用例一并覆盖 W03。这样以有限数据表覆盖已知类别，而不是逐项追加零碎补丁。

`$E/independent-mutations-round6.json` 保存精确替换和四条退出码；执行器、独立判据及原始日志为 `$E/independent-mutations-round6.py`、`$E/oracles-round6.mjs`、`$E/{clean,W01..W05}-{typecheck,lint,test,oracle}.log`。作者 216 项被杀的记录真实，不能由此推断其他未列故障也会被检测。

### 收据边界与交回

第 7 栏关于同名异类只允许一种、需宿主改名、同能力不同名不可识别、工具黑名单/凭据仅形状、cron 不验范围、回执作用域由宿主判定、非法回执静默不改状态及缺真实 DST/Helper 内核/插件接线等声明，与本片实现边界一致；216 个变异数量和 85/131 分组也已复现。它没有声称 216 项穷尽所有故障；本轮 W01–W04 是额外发现的测试盲区。AC-01/31/33/35 整项继续标未测，是合理分层。

**回交条件：** Claude Code 在原开发任务将有限资产类别矩阵和同类多资产正反对照纳入项目测试与校准，保留现有实现及先前已验证的 Helper、定时和控制行为；按最新 PR #3 基线重新运行相关门禁并交跨厂商独立复审。用户要求的后端持续实现、验收清单及用户故事闭环仍在原开发流程中推进；本审查不创建或冒称完成该全局目标。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 在 `2aff4ca` / `fdfecb1` 下 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 未找到等于本轮 `reviewed_hash` 的审查工具输出，也未识别该审查轮厂商。当前轮尚未完整写入会话 `turns.jsonl`；原生 rollout 可观察本轮模型，但不能冒充该门禁通过。会话落盘后由既有流程重核，不伪造记录或豁免（`$E/gates-local.log`）。

---

## 第七轮：第六轮测试返修后的跨厂商独立复审（2026-11-05）

**结论：reject，交回 Claude Code 原开发任务补齐 Compute 说明的验证后快照测试和校准。** CH-16 已闭合：当前实现不变，有限资产类别矩阵正确，原 W01–W05 均被现有测试杀死。本轮未复现当前实现泄露凭据、越权授工具或丢群规；拒绝依据是独立变异证实现有测试不能检测**验证通过后调用方修改原数组**使这些安全边界失效的回归。建议一次表驱动补齐三个输入数组的快照对照，不把每个变异拆成零碎实现任务。本轮结束不是整个后端或用户故事已验收完成。

### 固定对象、来源与独立复现

- 按用户明确要求审查 PR #4 `feat/contact-helper` 的 HEAD `fe69b70a609b8bc01fc55742f04e091ee560f943` 与固定基线 `356d012cdc3cc0dc22ee0c6923600465ba06c524`。普通独立 clone 初始看到远端 `origin/feat/task-lifecycle=78cecbb5463dbafe8fe89775d163a3ee964a3b68`；仅在该 clone 中将 `refs/remotes/origin/feat/task-lifecycle` 固定到用户指定的 `356d012` 供本轮命令使用，**没有修改远端分支**。固定基线已包含于受审 HEAD，不改工作区的试合并 exit 0（`$E/merge-tree-pinned.log`）。
- 用户已说明较新 PR #3 基线稍后合入。仅作提示：对克隆时的 `78cecbb` 不改工作区试合并 exit 1，`packages/domain/proof/mutations.mjs` 与 `packages/domain/proof/mutations.txt` 冲突（`$E/merge-tree-remote.log`）；不把该新基线混进本轮 CH-16 判断，等原负责人整合后重跑测试、变异、哈希与跨厂商审查。
- 红提交 `94e4babf9fe05c58ad412b2cc5af30bc19c282af`、绿提交 `b5adcceaf912e4bf8524323a9a41b9c6336f5918`；合并 `05cb8cdfd42e3efb6297931a1f6f84b8e2a9797b` 的父提交是 `b5adcce` 与 `356d012`；`fe69b70` 相对合并只改收据基线号。`contact.ts`、`helper.ts` 在 `39a849a` 与本轮 HEAD 的 Git blob 分别均为 `c3909ab78bf83385ede39703f4c73045d29dd083`、`8c69b2b9d8162baff516325e89dfe804450bcebf`，实现未改。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的生产模型为 `claude-opus-5-5`（Anthropic）；独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，原生当前 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI），无豁免。实际模型记录不等同于 G-PROVENANCE 已通过。
- 仓库根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 的原样 stdout：`87d31162b015053b890602ca075aa284484f6402bbc75ff22e50a5fca0b47ceb`，该 `origin` 本地引用按上面的用户指令固定为 356d012。
- 本轮证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round7-gCtuI8`；`$E/repo` 为普通独立 clone，`.git` 与 common dir 均为该 clone 的 `.git`。被审源码与测试未改；独立变异只写 `$E/mutants/`。
- `npm ci` exit 0；Node v25.8.1 下 typecheck、lint、test 均 exit 0，**176/176**、无 skip/todo；Node v22.22.0 下三项也均 exit 0（`$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`）。
- 独立检出红提交并 `npm ci`：全量测试 115 绿 / 61 红；目标文件 TAP 的 61 项均按名字失败、原因均为 `未实现`，不是加载失败（`$E/red-tests.tap`、`$E/red-all-tests.log`）。红提交把既有实现置空；隔离副本保留红测试、仅恢复其父提交真实源码，**61/61 绿**（`$E/red-prior-overlay.tap`），符合本轮实际是给正确实现补测试、而非修源码缺陷。故不能单凭空壳红声称旧实现存在 CH-16 运行错误；旧的 W01–W04 故障变异在新测试下被杀才是针对测试缺口的有效正向证据。
- 自己运行作者 `node packages/domain/proof/mutations.mjs`：exit 0，原样 176 绿、**224/224** 变异被具名测试杀死（`$E/author-mutations.log`）。源码数组 contact/helper 93、其他 131，编号无重复；原第六轮 W01–W05 的注入前后字符串与本轮清单逐一一致（`$E/mutation-origin-audit.log`）。

### CH-16 已闭合及保留行为

原样运行第六轮独立 `oracles-round6.mjs`，W01–W05 **5/5 PASS**；之前的 12 格资产矩阵、第五轮 Z01–Z05、三承诺三任务的 1,000 个固定种子场景/30,000 次状态检查，以及 Helper 三入口、定时归属、职责内外与控制穿透等纯函数探针均通过（`$E/previous-oracles.log`、`$E/asset-matrix.log`、`$E/earlier-oracles.log`、`$E/state-random.log`、`$E/safeguards.log`）。新增仓库测试独立声明三类，逐格检查 3×3 同名组合、每类两个不同名资产及派出、前缀顺序和直接工具双向互斥。第 7 栏关于同名异类需宿主采用不同名称的限制仍属待集成边界，不把它说成真实适配器或整项 AC-33 已通过。

### 必须补齐的测试门禁

**CH-17 [High，R-05 / AC-33④] Compute 说明的授权与凭据检查缺少验证后快照回归。** `packages/domain/src/contact.ts:215-225` 当前将 `rules`、`tools`、`credentialRefs` 都复制并冻结；本轮实际探针先传入合法可变数组，再修改调用方数组，原实现返回的说明保持不变（`$E/clean-snapshot.json`）。因此**当前实现没有观察到规则丢失、越权工具进入或明文凭据进入**。

但在隔离副本分别把三个字段的复制替换为原数组引用，仅改一处源码、不改测试，typecheck/lint 和 **176 项现有测试仍全绿**，独立 oracle 红：

| ID | 单点变异 | 验证后修改调用方数组的实测后果 |
|---|---|---|
| V06 | `rules` 不复制 | 删除输入规则后，说明丢失已生效的硬约束 |
| V07 | `tools` 不复制 | 原本只授权 `get_weather`，随后调用方追加未授权 `run_command`，说明也出现它 |
| V08 | `credentialRefs` 不复制 | 原本只有 `vault://mail/1`，随后调用方追加 `plaintext-secret`，说明也出现明文 |

这些后果只发生于相应**人为变异副本**，不是当前源码或真实 Compute 进程的实测泄露。它们分别直接触及母规格 `docs/spec/需求文档.md:75-78,106` 的授权子集、凭据引用和生效约束不静默丢失；现有静态输入检查能被“校验后改调用方数组”绕过的变异骗过，不能作为这些具体边界已持续校准的依据。建议一次表驱动测试：传入合法可变数组、生成说明、分别修改原 `rules/tools/credentialRefs`，断言说明仍保持原规则、授权子集与引用；再将 V06–V08 的正向故障纳入 R-05。可用复制、持有权约束等满足安全合同，不必把 `Object.freeze` 的实现形式本身当验收目标。

本轮另有 V01–V04 被现有测试杀死（互斥、混合授权和已结束承诺）；V05 将同名异类错误理由的名字硬编码为 `research` 后存活，属于错误诊断覆盖，建议顺手以非 `research` 名称补对照，不作为本轮安全门禁的独立阻塞项。精确替换、typecheck/lint/test/oracle 退出码在 `$E/independent-mutations-round7.json`；执行器、独立判据、原始日志为 `$E/independent-mutations-round7.py`、`$E/oracles-round7.mjs`、`$E/{clean,V01..V08}-{typecheck,lint,test,oracle}.log`，三字段的实际前后快照为 `$E/{clean,V06,V07,V08}-snapshot.json`。224 个作者变异被杀的结果真实，但不意味着未列的快照故障也被持续测试捕获。

### 收据边界与交回

第 7 栏关于同名异类需宿主改名、不同名同能力不可识别、工具黑名单和凭据引用仅形状、cron 不验范围、回执作用域由宿主判定、非法回执静默不改状态及无真实 DST/Helper 内核/插件接线等边界，与本片实现一致；224 个变异数量及 93/131 分组已复现。它没有声称 224 项穷尽所有故障；本轮 CH-17 是额外发现的**测试盲区**。AC-01/31/33/35 整项继续标未测是合理分层。

**回交条件：** Claude Code 在原开发任务一次补齐三个可变入参的快照/授权表驱动测试和对应正反校准，保留现有正确实现及已验证的 Helper、定时和控制行为；按用户所说在 PR #3 最新基线整合后重新运行门禁并交跨厂商独立复审。用户要求的后端持续实现、验收清单和用户故事闭环仍由原开发流程推进，本审查不创建或冒称完成该全局目标。

**本轮本地门禁：** 在用户指定并于本 clone 固定的 `fe69b70` / `356d012` 下，`node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 实测 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 未找到等于本轮 `reviewed_hash` 的审查工具输出，也未识别该审查轮厂商。当前轮尚未完整写入会话 `turns.jsonl`；原生 rollout 可观察模型，但不能冒充该门禁通过。会话落盘后由既有流程重核，不伪造记录或豁免（`$E/gates-local-pinned.log`）。

---

## 第八轮：第七轮快照测试返修后的跨厂商独立复审（2026-11-06）

**结论：reject，交回 Claude Code 原开发任务返修。** 第七轮 CH-17 对普通可变数组的快照反例已闭合；但本轮发现当前 `briefFor` 对同一个输入属性多次读取，若进程内调用方传入会变化的 getter，校验的是一组值而成功结果携带另一组值，能在纯函数结果中出现未授权工具或明文凭据。另有混合凭据与引用形状的独立变异存活。此处没有验证真实宿主会构造 getter，也没有证明远程利用或真实凭据外泄。

### 固定对象、来源与独立复现

- PR #4 `feat/contact-helper`：受审 HEAD `0b40600e9f90fdc0ed4bb15451b0c0b9dc8d0258`，开始时基线 `origin/feat/task-lifecycle=a425387bc9781f53a44f48892dfb041cd8f7f3e4`。合并提交 `177370a09a08aa9feca23399b02e79784f79e19d` 的父提交为 `9b0a201` 与 `a425387`；`0b40600` 相对该合并只改收据。`contact.ts`、`helper.ts` 与 `02f87d3` 的 Git blob 分别均为 `c3909ab78bf83385ede39703f4c73045d29dd083`、`8c69b2b9d8162baff516325e89dfe804450bcebf`，本轮实现未改。
- 作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的生产模型为 `claude-opus-5-5`（Anthropic）；独立审查 `codex:4d37f5a5-0839-4adc-8afc-9b481602df5a`，当前原生 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI），无豁免。原生模型记录不等于 G-PROVENANCE 已通过。
- 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 的原样 stdout：`750d642523c5222c1e770cdf95928bfe597cbe399daf8fef6c4911a68aa0c3b1`。
- 本轮证据根 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr4-round8-YN2ljl`；`$E/repo` 为普通独立 clone，`.git` 与 common dir 均为该 clone 的 `.git`。被审实现和测试未改；独立变异只写 `$E/mutants/`。
- `npm ci` exit 0；Node v25.8.1 下 typecheck、lint、test 均 exit 0，**202/202**、无 skip/todo；Node v22.22.0 下三项也均 exit 0（`$E/npm-ci.log`、`$E/{typecheck,lint,test}.log`、`$E/node22-*.log`）。
- 独立检出红提交 `25139cb2bdda3f25e5117834a97a11763f085cd7` 并安装依赖：红提交历史快照全量测试 115 绿 / 64 红；目标文件 TAP 64 项均按名字失败、原因均为 `未实现`，不是加载失败（`$E/red-tests.tap`、`$E/red-all-tests.log`）。红提交把已有实现置空；隔离副本保留红测试、仅恢复其父提交真实源码，**64/64 绿**（`$E/red-prior-overlay.tap`），符合本轮给已有正确快照行为补测试而非改源码。上轮 V06–V08 别名故障在新测试下被杀，才是针对原测试缺口的正向证据。
- 自己运行作者 `node packages/domain/proof/mutations.mjs`：exit 0，原样 202 绿、**273/273** 变异被具名测试杀死（`$E/author-mutations.log`）。源码数组 contact/helper 104、其他 169，编号无重复；独立解析 273 项并逐一核对，每个注入点在对应源码中均恰好出现一次（`$E/injection-count-audit.log`）；对照合并父提交，PR #4 侧 235 项、基线侧 169 项均保留编号/描述，上轮 V01–V08 映射 CV01–CV08，注入前后字符串逐一一致（`$E/merge-mutation-id-audit.log`、`$E/mutation-origin-audit.log`）。

### 上轮修复与保留行为

原样运行第七轮独立 `oracles-round7.mjs`，V01–V08 **8/8 PASS**；调用方在 `briefFor` 返回后修改规则、工具和凭据数组，当前说明保持原样（`$E/previous-oracles.log`、`$E/brief-snapshot.json`）。作者新增测试还逐个及同时修改入参，并反向检查说明数组与入参不相同、数组 push/赋值失败、双方内容不变；K37–K39 与 CV01–CV08 的记录已复现。

此前 W01–W05、12 格资产矩阵、1,000 个固定种子场景/30,000 次状态检查，以及 Helper 三入口、定时归属、职责内外与控制穿透等纯函数探针均通过（`$E/earlier-oracles.log`、`$E/asset-matrix.log`、`$E/state-random.log`、`$E/safeguards.log`）。这些不代表真实消息表、Compute 进程、DST 或插件端到端已验收。

### 必须修复

**CH-18 [High，AC-33④ 函数合同] 校验与输出多次读取同一输入属性，变化的 getter 可让成功结果越过授权与凭据检查。** `packages/domain/src/contact.ts:218-227` 中，`r.tools` 依次被读取用于空名检查、白名单检查、输出拷贝；`r.credentialRefs` 分别被读取用于形状检查和输出拷贝。`readonly string[]` 类型限制数组使用方式，但不保证外层属性是稳定数据属性；`$E/getter-static.ts` 的 getter 形式输入通过 TypeScript 静态检查（`$E/getter-static.log`，exit 0）。

独立实测（`$E/getter-boundary-probe.json`）：联系人只授权 `get_weather`；进程内测试对象的 `tools` getter 前两次返回 `["get_weather"]`、第三次返回 `["run_command"]`，`credentialRefs` getter 第一次返回 `["vault://mail/1"]`、第二次返回 `["plaintext-secret"]`。`briefFor` 返回 **`ok:true`**，说明中却包含未授权 `run_command` 和无引用形状的 `plaintext-secret`。两项分开的负向回归均失败，稳定数据对象正向对照通过（`$E/getter-regression.test.mjs`、`$E/getter-regression.tap`）。

这是特殊**进程内 JavaScript 对象**的已观察函数合同反例；目前仓库内除测试外没有 `briefFor` 实际调用方，未证明真实宿主会接受 getter、远程攻击、实际启动 Compute 或泄露真实凭据。第 7 栏只声明凭据按形状校验、宿主负责真实挂载等，没有声明或强制输入必须为无 accessor 的稳定数据对象。建议先对每个待验证数组读取并拷贝成一次性快照，随后只对同一快照校验并输出；或者在真实宿主入口明确强制并测试“无 accessor/Proxy、稳定数据”的输入契约。补两种 getter 单独负向与稳定输入正向测试，并保持上轮返回后输入变更的快照防护。

**CH-19 [Medium，R-05 / AC-33④] 多项凭据的非法后项与引用形状边界未被现有测试持续保护。** 当前源码对 `["vault://mail/1","plaintext-secret"]`、`["vault://"]`、`["vault://mail/1 space"]` 均拒绝。独立单点变异 H05 只校验第一项，H06 只校验 scheme 前缀；两者 typecheck/lint 和 **202 项现有测试均绿**，各自独立 oracle 红：H05 放行合法引用后跟明文，H06 放行空路径和含空白路径。`$E/{clean,H05,H06}-credential-boundary.json` 保存原样与变异结果，`$E/{H05,H06}-{typecheck,lint,test,oracle}-recheck.log` 为直接复核。

本轮其他独立 H01–H04、H07–H08 均被现有测试杀死；原样副本及 8 个独立 oracle 均绿。上述 H05/H06 后果仅发生于**人为变异副本**，不是声称当前源码会接受这些普通数组。建议在 CH-18 的同一批回归中补多项引用逐项校验、空路径/空白路径与合法引用对照，并纳入 R-05，而非声称有限 273 个变异穷尽所有故障。精确替换与各项退出码在 `$E/independent-mutations-round8.json`，执行器、oracle 和原始日志为 `$E/independent-mutations-round8.py`、`$E/oracles-round8.mjs`、`$E/{clean,H01..H08}-{typecheck,lint,test,oracle}.log`。

### 基线、收据与交回

审查期间远端 `feat/task-lifecycle` 从 `a425387` 前移至 `f2e6ec297379687efe8788b4bf7bb127273937b5`；新增提交仅改 PR #3 的审查报告和收据。将新基线取到独立审查引用而不更改本 clone 的固定 `origin/feat/task-lifecycle`，共同祖先仍是 `a425387`，不改工作区试合并 exit 0（`$E/merge-tree-live.log`）。这不替代 PR #3 自身审查；如果产品基线再次前移，整合后须重算哈希并重验。

第 7 栏关于同名异类需宿主改名、名字表/凭据仅形状、cron 不验范围、回执作用域由宿主判定、非法回执静默不改状态，以及无真实 DST/Helper 内核/插件接线的边界与本片一致；273 个变异数量及 104/169 分组已复现。但它未披露 CH-18 的**校验与输出重复读取同一属性**，也不能以“仅校验形状”覆盖实际 `ok:true` 返回不符合形状的结果。AC-01/31/33/35 整项继续标未测是合理分层。

**回交条件：** Claude Code 在原开发任务修复 CH-18 的校验/输出快照一致性，并一次补 CH-19 的多项及引用形状正反对照；保留此前已验证的数组快照、资产矩阵、Helper、定时和控制行为。之后按最新 PR #3 基线重跑门禁并交跨厂商独立复审；后端持续实现、验收清单及用户故事闭环仍在原开发流程中推进，本审查不冒称完成全局目标。

**执行器纠错：** 等候独立变异进程的旧会话号时工具返回 `Unknown process id 11077`，不是产品测试失败；完整逐项 JSON/日志已保留，但不声称未观察到的整脚本退出码。H05/H06 已在各自副本直接重跑 typecheck、lint、test 及 oracle，退出码逐项记录。初次查看 getter 联合探针时查错证据目录，随后已在 `$E/repo` 上重跑并写入 `$E/getter-boundary-probe.json`。

**本轮本地门禁：** `node scripts/gates/run-all.ts --local --branch=feat/contact-helper --base=origin/feat/task-lifecycle` 在 `0b40600` / `a425387` 下 exit 1：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 因本轮 reject 正确拦下；G-PROVENANCE 未找到等于本轮 `reviewed_hash` 的审查工具输出，也未识别该审查轮厂商。当前轮尚未完整写入会话 `turns.jsonl`；原生 rollout 可观察模型，但不能冒充该门禁通过。会话落盘后由既有流程重核，不伪造记录或豁免（`$E/gates-local.log`）。
