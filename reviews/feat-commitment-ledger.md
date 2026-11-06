# PR #8 D23 承诺账本最小闭环：独立复现审查

## 第 1 轮（6a2b85e）

- 审查人：`claude`（跨厂商审 Codex 写的 PR，开发手册原则 68）；mirasim 会话：`claude:68161be7-5085-463b-90f9-7700266c3f56`，本轮模型 `ai-iisbo/[鸿运按量]claude-opus-5-5`（Anthropic）。作者 `codex:2e5b967e-007c-43fe-84b4-58374f144f9a`（OpenAI gpt-6.1-terra）。
- 复现由本会话派出的子代理在独立 /tmp 克隆完成（Node v22.22.0），原始日志与脚本保存在 `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr8-r1/`；本会话亲自在独立克隆执行：

  ```sh
  node scripts/gates/run-all.ts --hash --branch=feat/commitment-ledger --base=origin/feat/domain-core
  ```

  原样输出：

  ```text
  b5ec02032d53e8fee02ad8b4c1e6ee845acf3ee0b60342f444a0ed922a715ae2
  ```

- 基线 feat/domain-core 上的 policy.json 尚未含 claude（等 PR #1 合入），本轮结论为 reject，G-REVIEW 本就应拦截；不宣称 G-PROVENANCE 已认证本轮。

### 结论建议：reject（请求返修）

实现本身在所有探针上行为正确（输入合同 37 项探针全部符合预期，见 `11-contract-probe.json`），作者的 19 个变异全部按名杀死、红提交成立、门禁除 G-REVIEW 外全过。驳回理由有两条：

1. 用户已拍板、AC-40 列为当前必过的「Compute 只回报对应条目」（需求文档 D23 第 1940 行，用户 `#1711`）在领域入口没有被约束：任意 Compute 只要在命令里写上承诺所属任务号，就能给这个承诺记进展，还能让轮末对账判为就绪（D23-R1-01）。
2. 判别力不足：审查方另外构造了 20 个单点故障，现有 22 条测试一个都没发现（发现 0 / 存活 20；正对照 C00 能被发现，说明夹具有效）。实现中 18 种拒绝原因里有 5 种在测试中一次都没出现。收据把 R-05「双侧标定（每条判据都要有阳性埋雷）」记为通过，这与实际覆盖不符（D23-R1-02 至 R1-09）。

除 R1-01 以外，其余问题都只需要补测试和变异，产品代码不用改，因为探针证明这些拒绝分支现在的行为是对的，只是没有被任何测试钉住。

### 复现数字

| 项 | 结果 | 证据 |
|---|---|---|
| npm ci | exit 0，0 vulnerabilities | `01-npm-ci.log` |
| typecheck | exit 0 | `02-typecheck.log` |
| lint（biome --error-on-warnings） | 检查 16 个文件，exit 0 | `03-lint.log` |
| npm test | 45 tests / pass 45 / fail 0 / skipped 0 / todo 0 / cancelled 0；其中本 PR 新增 22 条，从基线继承 23 条 | `04-test.log` |
| 作者 19 个变异复跑 | 对照组 22 通过 / 0 失败；19/19 KILLED，每个都被声明的那条具名测试杀死；输出与 `proof/commitment-ledger-mutations.txt` 逐行一致 | `05-mutations.log` |
| 红提交 ff0255c | 22 个测试，0 通过 / 22 按名失败，无文件级失败；提交内容只有测试文件、空壳（`not-implemented`）和 index 导出 | `06-red-ff0255c.tap`、`06-red-summary.log` |
| 补充红 ba5fa58 | 21 通过 / 1 失败（「同一消息 id 重投不重复,但内容冲突不得覆盖」），只改了测试；对应的绿提交 de6256d 22/22 通过 | `06-red-ba5fa58.tap` |
| 补充红 82c3215 | 21 通过 / 1 失败（「用户交办并接下的多个承诺同时登记并保留来源」），只改了测试；对应的绿提交 2291e2b 22/22 通过 | `06-red-82c3215.tap` |
| 绿提交 eb296c4 | 22/22 | `06-red-eb296c4.tap` |
| `run-all.ts --local --branch=feat/commitment-ledger --base=origin/feat/domain-core` | G-TRACE ✓、G-REVIEW ✗（还没有独立审查）、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓、G-PROVENANCE ✓；exit 1；CONTENT_HASH=b5ec02032d53e8fee02ad8b4c1e6ee845acf3ee0b60342f444a0ed922a715ae2（仅供参考，以调度会话亲自跑的 `--hash` 为准） | `08-gates-local.log` |
| 门禁负例矩阵（合成仓库，每个门禁一个应失败的输入，外加 1 个对照） | 对照 exit 0、无失败；8 个门禁各自只判它自己失败（exact=true，exit 1） | `12-gate-negative-matrix.log`、`12-gate-negative/` |
| 本 PR 分支上的门禁负例 | red.commit 改成绿提交 eb296c4 → G-RED 对 22 条逐条判失败；收据条目 id 改成 R-99 → G-TRACE 判「R-99 不在验收文档里」 | `13-pr-negative-*.log` |
| 审查方单点故障 | 正对照 C00 被发现；F01–F20 发现 0 / 存活 20 / 无效 0 | `09-reviewer-mutations.log`，脚本 `reviewer-mutations.mjs` |
| 拒绝原因覆盖 | 代码里 18 种拒绝原因，测试中零引用的有 already-processed、commitment-not-found、reply-not-found、resolution-required、seq-conflict | `10-reason-coverage.txt` |
| 输入合同探针 | 37 项，实际行为全部符合预期 | `11-contract-probe.json`，脚本 `contract-probe.ts` |
| 运行变异前后 $TMPDIR 目录数 | 1344 → 1342，没有增加 | `05-mutations.log` 末行 |

### 验收文档核对（v3.17）

- PR 里的 `docs/spec/验收文档-v0.1.md` 与 `origin/docs/dev-handbook` 的 v3.17 逐字节相同（`07-spec-diff-handbook-vs-pr.txt` 为空）。基线 feat/domain-core 上是「同步主稿 v2.7 定稿版」，没有 AC-40（`07b-spec-diff-base-vs-v317.txt`，48 行差异）。所以同步提交 a174629 是 G-TRACE 能找到 AC-40 的前提，内容与权威快照一致。
- 收据中 AC-40 和 AC-16 都记为「未测」，原因是还没接运行时，这与 AC-40 末列一致：②⑥⑧⑨ 属于当前必过，但需要端到端验证。候选项（处置枚举、补 1 次、步骤边界、唤醒、短名）只有 `CandidatePolicy` 类型形状，收据标了「候选」，符合 brief。
- R-02、R-03、R-04 记为「通过」，复现成立（G-RED、G-STUB、G-TAUTO 全绿，红提交成立）。R-05 记为「通过」不成立，见 R1-09。
- AC-40 末列当前必过项与本片的对应：②承诺登记，有测试；⑥不自动失效，有测试；⑧Compute 不在群里发言，有测试；⑨补充串到另一件任务，有测试（引用的父消息任务不同就拒绝）；「承诺账本归联系人、Compute 只回报对应条目（`#1711`）」，后半没有被约束（R1-01）。

### 输入合同（用户 g-group#2662）

| 条款 | 实现行为（探针） | 测试是否钉住 |
|---|---|---|
| 外部输入带 getter、setter 或 Proxy 一律拒收、不调用 | 嵌套 getter、只有 setter、嵌套 Proxy、数组下标 getter、账本快照 Proxy、boundIds Proxy、Proxy 包装的解析器：全部拒绝，调用次数 0 | 只测了顶层 getter 和顶层 Proxy（测试第 189 行）。其余都没测（R1-07） |
| 类实例 / 非普通原型 | 拒绝 | 未测，F14 存活（R1-07） |
| 合法 JSON null 不抛错 | 账本、版本、命令、reconcileRound 三个参数、emptyLedger 传 null 都返回 invalid-input，不抛；taskId 和 replyToSeq 为 null 时正常接收 | applyLedger 的命令参数和 emptyLedger 测了；账本参数、版本参数、reconcileRound 没测（并入 R1-07） |
| 导出策略对象不可改 | 只导出 3 个函数，没有导出任何策略对象（`CandidatePolicy` 只是类型）；返回的账本深冻结；模块命名空间赋值抛 TypeError；调用方传入的对象没有被冻结或改写 | 本条对本片基本不适用；返回值冻结没有测试（并入 R1-07，建议补） |
| 撤回 / 幂等 / 版本 | 用户撤回不带原因被拒、用户直接记 done 被拒、其他联系人撤回被拒、撤回后再记进展被拒；同载荷换键序重试判为重复；未来版本号返回 version-conflict | 只有撤回的正路径有测试；拒绝分支和键序无关性都没测（R1-02/03/04） |
| 内置原型被改写的环境 | 不在合同内，未考察 | — |

### 问题清单

#### D23-R1-01（必须返修）Compute 进展不校验是否为「对应条目」
- 位置：`packages/domain/src/commitment-ledger.ts:196-197`（progress 分支只排除 user 和非主人联系人）；测试 `commitment-ledger.test.ts:156`「Compute 只可报告绑定任务的承诺进展,不能了结承诺」。
- 复现：`11-contract-probe.json` 的「Compute（任意 id）声明同任务即可记进展」一项，`compute/worker-b` 对 task-a 的承诺 k1 记进展，返回 `ok v=3`。之后 `reconcileRound(…, "r1", ["k1"])` 就会判为就绪，也就是说一个与这件任务无关的 Compute 可以让对账通过。测试里的 `task-mismatch` 只比较了同一条命令里调用方自己填的 taskId 和承诺的 taskId，属于自洽性检查，账本里根本没有「哪个 Compute 绑定哪件任务」的数据。
- 对照：需求文档 D23 第 1918 行、第 1940 行（用户 `#1711` 已拍板：「Compute 只回报对应条目的进展」）；AC-40 末列当前必过：「承诺账本归联系人、Compute 只回报对应条目」。
- 返修要求（二选一，需调度拍板）：
  - (a) 推荐：领域层引入绑定，例如承诺或账本记录 `computeId → taskId/commitmentId`，由联系人通过一条命令建立绑定；progress 校验 `actor.id` 已绑定到该承诺。补测试：未绑定的 Compute 记进展返回 actor-not-allowed，且对账仍然 pending；绑定的 Compute 可以记。补对应变异。
  - (b) 如果判定绑定属于运行时接线（brief 把联系人运行时接线排除在本片外），就把测试名改成不声称「绑定」，在收据 unverifiable 里点名「Compute 与条目的对应由宿主保证，领域层未校验」，AC-40 保持未测。

#### D23-R1-02（必须返修）身份与权限分支没有测试
- 位置：`commitment-ledger.ts:184`（非主人联系人的消息登记承诺）、`:197`（progress 的 user / 非主人联系人）、`:199-200`（close 的非主人联系人，以及 user 做撤回以外的了结）。
- 复现：`09-reviewer-mutations.log` 中 F01、F02、F03、F04、F05 全部 SURVIVED（exit 0、失败列表为空）。`actor-not-allowed` 在测试里只出现 1 次，测的是 Compute 了结承诺。
- 对照：AC-40「承诺账本归联系人」；D23「只记承诺。承诺来自助手自己说出口的…」。
- 返修要求：每个分支补一条应失败输入的测试，断言具体 reason；把 F01–F05 加进作者的变异清单，必须被具名测试杀死。

#### D23-R1-03（必须返修）状态转移与了结信息的拒绝分支没有测试
- 位置：`:182`（already-processed）、`:195`（commitment-closed 对 progress 也生效）、`:205`（resolution-required）。
- 复现：F18（同一条消息可以重复处理）、F07（已了结的承诺仍能记进展）、F16（撤销、替代、阻塞不要求原因）都 SURVIVED。探针显示实现本身对这三种情况都拒绝。
- 对照：AC-40 ⑥「只能被完成、撤销、替代、报阻塞了结」，了结必须明确记录；撤回检查（#2662）。
- 返修要求：补「重复处理同一 seq → already-processed」、「撤回后记进展 → commitment-closed」、「revoked/superseded/blocked 缺 detail 或带 artifact → resolution-required」三条测试，并加入对应变异。

#### D23-R1-04（必须返修）投递、幂等和版本的边界没有测试
- 位置：`:172`（seq-conflict）、`:175`（reply-not-found）、`:138`（canonical 排序键）、`:157`（版本必须相等）。
- 复现：F20（复用已有 seq 的新消息被接收）、F17（引用不存在的消息被接收）、F13（幂等载荷比较依赖键顺序）、F15（未来版本号被接受）都 SURVIVED。
- 对照：brief「消息带 seq，先持久记录再处理，按稳定 id 去重」；#2662「撤回/幂等/版本检查照做」。
- 返修要求：补「seq 冲突」「引用不存在」「同载荷不同键序判为重复」「expectedVersion 大于当前版本返回 version-conflict」四条测试，并加入对应变异。

#### D23-R1-05（必须返修）产物解析器只认严格 true、抛错按未完成处理，都没有测试
- 位置：`:203-204`。
- 复现：F08（解析器返回任何非 false 值都算存在，例如 "yes"）、F09（解析器抛错直接外泄）都 SURVIVED。探针显示实现对这两种情况都返回 artifact-not-found、不抛。
- 对照：AC-16「完成必须指向产物」；AC-40 坏实现③「done 链接指向不存在的提交 → 红」。
- 返修要求：补「解析器返回非布尔真值 → artifact-not-found」「解析器抛错 → artifact-not-found 且不抛」两条测试，并加入变异。

#### D23-R1-06（必须返修）轮末对账的两个分支没有测试
- 位置：`:224`（只有 active 状态才可能 pending）、`:221`（未知承诺 id）。
- 复现：F10（已了结的承诺仍然挂起）、F19（未知 id 不被拒绝）都 SURVIVED。
- 对照：AC-40 ③完成判定（候选，但本片已实现）；坏实现⑩「纯闲聊轮被在途承诺判为未完成 → 红」（本片测了这一条的正路径）。
- 返修要求：补「绑定的承诺已在别轮 done，本轮对账 ready」「未知 id → commitment-not-found」两条测试，并加入变异。

#### D23-R1-07（必须返修）输入合同和快照校验只测了表层
- 位置：`:52-74`（jsonCopy：原型、描述符）、`:116-120`（isLedger：承诺原文必须来自来源消息，终态必须带了结信息）、测试 `:189`。
- 复现：F14（去掉原型校验后类实例可以进入）、F11（外部账本快照不校验承诺原文来源）、F12（快照不校验终态必须带了结信息）都 SURVIVED。嵌套 getter、只有 setter、数组下标 getter、账本 Proxy、boundIds Proxy、Proxy 解析器这些情况，实现都正确拒绝，但没有任何测试。
- 对照：#2662「外部输入带 getter/setter/Proxy 不调用即拒收；合法 JSON null 不抛错」。
- 返修要求：把 #2662 的每一条做成测试，覆盖嵌套位置和三个入口（applyLedger 的账本参数和命令参数、reconcileRound 的 boundIds），并断言调用次数为 0；加一条类实例的测试；加两条篡改过的账本快照测试（承诺原文不在来源消息里、done 没有 artifact），都应返回 invalid-input；加一条返回值深冻结的测试。F11、F12、F14 加入变异。

#### D23-R1-08（必须返修）process 阶段的任务隔离没有测试
- 位置：`:185`。
- 复现：F06（承诺可以绑到与来源消息不同的任务）SURVIVED。现有的任务隔离测试只覆盖接收阶段的引用（测试 `:166`）。
- 对照：AC-40 ⑨「补充不串到另一件任务」。
- 返修要求：补「来源消息属于 task-a，提议的承诺写 task-b → task-mismatch」测试，并加入变异。

#### D23-R1-09（必须返修）收据把 R-05 记为通过与实际不符
- 位置：`receipts/feat-commitment-ledger.json`，R-05 条目。
- 复现：上面 R1-02 至 R1-08 共 20 个单点故障全部存活；5 种拒绝原因在测试中零引用（`10-reason-coverage.txt`）。
- 对照：验收文档 R-05「每条判据至少一个阳性埋雷和一个阴性对照…缺一边，这条判据不算已标定」。收据 unverifiable 写了「R-05 只覆盖声明的 19 个变异，不是穷尽」，但这句话改变不了 R-05 的定义：代码里实现了的判据，就要有阳性埋雷。
- 返修要求：R1-02 至 R1-08 补完之后，作者的变异清单要覆盖代码里每一种拒绝原因（建议至少把 F01–F20 全部吸收进去），并且全部被具名测试杀死，再维持「通过」；否则把 R-05 改成「未测」并写明原因。重新生成 proof 文件。

### 观察项（不阻塞）

- O-1：feature 分支带了 docs/spec 同步提交（a174629）。内容与 v3.17 逐字节相同，而且是 G-TRACE 识别 AC-40 的前提。合并顺序上要留意：其它 PR 也同步 v3.17 时内容一致，不会冲突。
- O-2：来源原文校验只做子串判断，单个字（如「文」）也算来源（探针「单字承诺文本也算原文」返回 ok）。收据 unverifiable 已经点明「原文子串校验只能证明字面来源」，这里只记录。
- O-3：taskId 为 null 的消息上可以登记任意 taskId 的承诺（探针返回 ok）。对「闲聊里接下一件新事」这种情况是合理的，但需求文档里没有明确依据，建议在收据里写一句语义说明。
- O-4：作者的变异判杀标准是「声明的那条测试名失败、没有文件级失败」，没有核对失败原因文字。现有测试都用 deepEqual 断言具体 reason，实际效果等价，这里只记录。
- O-5：与 PR #4 contact.ts 中 commitments 的对齐点已经写进收据 unverifiable，符合 brief。

### 证据目录

`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr8-r1/`：01–13 日志、`reviewer-mutations.mjs`、`contract-probe.ts`、`gate-negative-matrix.mjs`（沿用 PR3 第 14 轮负例矩阵的写法，夹具建在 /tmp，只把日志拷回）、`12-gate-negative/`。
