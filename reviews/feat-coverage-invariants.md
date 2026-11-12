# PR #86 · Q02 测试专片（coverage-invariants）独立审查

## 第 1 轮

### 结论：reject

本片「只加测试」这一点成立，作者报的数字全部复现一致。拒绝的原因有两类：四组新测试里有三处标题声称守住、实际没守住的行为（R1-01、R1-02、R1-03，均由审查方单点故障在生产代码上实测存活）；收据里的作者会话号是 Codex 原生子线程号，门禁按它读不到任何记录（R1-04）。审查人没有改产品代码、测试和收据的作者字段。

- 对象：`feat/coverage-invariants` `943302320f3b49fe429fba79f3c3e7d0e2a24197`（开工前、写结论前两次回读远端，未变）。
- 基线：`origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`（与 merge-base 相同）。
- 审查人：Claude；会话 `claude:89762718-8de0-48ba-8531-1f6f3ee30739`；本会话原始记录里的模型为 `group/opus`（Anthropic）。作者为 Codex / `gpt-6.1-sol`（OpenAI），跨厂商，不使用豁免。
- hy4 辅审因线路 403 未产出，本轮无辅审。
- 合同：`origin/docs/dev-handbook` `ff5bd712`（需求文档 v3.31、验收文档 v0.1）；候选条目不作依据；输入合同按 g-group#2662。
- 在自己的会话、独立克隆 `/tmp/gg-pr86-r1-claude/repo` 根目录运行：

```sh
node scripts/gates/run-all.ts --hash --branch=feat/coverage-invariants --base=origin/dev/integration
```

原样输出（与作者报的门禁哈希一致）：

```text
2efdba77c1e8120c4f32506e130d0a4cb1837e477d433d733cc2c759705947c6
```

### 1. 生产代码确实没变

- `git diff 4efdee0b 9433023 -- packages apps scripts package.json package-lock.json .githooks .github`，排除新测试文件与 `packages/server/proof/` 后为空；`host.ts` SHA256 `744317ce…a9d1` 与证据 `source-identity.json` 一致。
- 12 个变更全是新增：1 个测试、2 个 `packages/server/proof/` 下的脚本（变异执行器 `.mjs`、缺口探针 `.ts`）、8 个 `docs/proof/` 证据、1 份收据。两份 proof 脚本不被任何生产代码引用，不匹配 `*.test.ts`，不进测试套件；探针 `.ts` 会被 `tsc` 检查（typecheck 通过）。

### 2. 红是怎么红的

- 红提交 `a9c0ffef` 相对基线改了两个文件：测试文件（只补类型标注）和 **`packages/server/src/host.ts` 4 处**——`afterAppend` 里 `if (direct) this.loop.notify(...)`、`answerTask` 开头直接返回、`progress` 开头 `return []`、`identityOf` 返回固定字符串。下一提交 `5cf70481` 把 `host.ts` 还原成基线原字节。更早的一对 `c250f5f`/`5e438f4` 是同一做法的首轮（typecheck 失败后重做，失败证据保留）。
- 也就是说：红是**把生产代码改坏造出来的**，不是先写测试、实现尚不存在的那种红。被测行为在基线上本来就成立，这四处错误返回等于 4 个单点变异，其中三个与作者 8 变异里的 M01、M03、M07 相同。它证明的是「每条测试至少有一条断言对一个明显故障敏感」，不证明测试先于实现。
- G-RED 判通过的依据（`scripts/gates/gates.ts` 409–451）：收据有 `red.commit`、该提交在 base 之后 HEAD 之前、红提交上 4 条测试体与现在逐条相同、把现在的测试文件放到红提交的实现上 4 条按名字失败、现在 4 条按名字各通过一次。门禁不区分「实现还没写」和「实现被故意改坏」。本机沙箱里实测 G-RED ✓；把 `red.commit` 换成 `5cf70481`（实现正确）后 G-RED 判 4 条「没有按名字失败」。
- 判断：作者在提交说明、README、收据里都写明了这是校准用的错误返回，没有冒充基线缺陷，如实。此前仓库已有同样做法的先例（B-F11 回归保护测试）。它算不算 pstack 的有效先红后绿，规则没写，见「需拍板」。本轮不以此项拒绝。

### 3. 亲自复现的结果

重活在 box2 `/workspace/pr86-r1/`（Node v24.21.0，走 `/workspace/.heavy.lock` 排队，变异并发 2）；`--hash`、沙箱门禁、推送钩子在本机。

| 操作 | 实测 |
|---|---|
| `npm ci` | exit 0 |
| 红提交 `a9c0ffef` 跑新测试 | exit 1；4/4 `not ok`，4 条全是 `ERR_ASSERTION`（业务断言失败，不是加载失败） |
| HEAD 跑新测试 | exit 0；4/4 |
| `npm run typecheck` / `npm run lint` | 0 / 0（biome 200 文件） |
| `npm test`（HEAD） | exit 0；1477/1477，fail/cancelled/skipped/todo 全 0 |
| `npm test`（基线 `4efdee0b`） | exit 0；1473/1473。1473 + 本片 4 条 = 1477，数对得上；另一片报的 1480 是它自己加的条数不同 |
| 作者 `coverage-invariants-mutations.mjs` | exit 0；解析器校准通过，原样副本 4/4，8/8 被预绑定的具名测试以 `ERR_ASSERTION` 杀死，存活 0 |
| `coverage-invariants-replying-gap.ts` | exit 1 `ERR_ASSERTION`；回复已提交，活动只有 `thinking(room)` → `idle(null)`，没有 `replying` |
| `run-all.ts --local`（审查前，本机沙箱） | exit 1：G-PROVENANCE ✓（review 为空直接返回）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓ |
| `run-all.ts --local`（box2） | G-RED/G-STUB/G-TAUTO 报「没有可用沙箱…拒绝在宿主上执行 PR 代码」，属门禁设计，不是本片问题；这三项以本机沙箱结果为准 |
| GitHub `self-check` | SUCCESS（2026-11-12T15:55:29Z），PR 仍是 draft |
| 推送钩子（试推送时本机实跑） | 通过，门禁自检 219/219 |

作者保留的缺口，核对结果：

- **replying 探针**：放在 `packages/server/proof/`，文件名不是 `*.test.ts`，全量 1477 的日志里没有它的任何一条（搜 0 处）；新测试文件里没有 `skip`/`todo`/`only`。它没有被藏进套件，也没有被算成通过；收据 `knownGaps` 标「失败」、`verification.knownReplyingGapExit: 1`。`replying` 是合同里已有的活动值（`api-contract/src/entities.ts:65`），需求 U83「正在回复」状态卡为已定。这是真实的产品缺口，归活动生命周期的负责人（G 线）。
- **`tasks.progress.afterAt`**：合同声明了该参数（`api.ts:199`），`service.ts:84–87` 只读 `taskId`、`limit`。收据标「未测」，如实。同样是真实缺口，本片不修是合理的，但要有人接。
- **AC-01 / AC-43 / AC-44** 三条都标「未测」并写了已覆盖的子项与没覆盖的部分；AC-01 的 INVARIANTS、换 Compute，AC-43 的台账五类单元、孤儿、重跑、卡死，AC-44 的截图、`@用户`、拒绝、迟到回答都不在本片。标注如实，没有把子项绿升格成整条通过。G-TRACE 的应失败输入（把 AC-01 改成「通过」且不写证据）门禁判失败。

### 4. 测试是否真在守行为

四条测试用的是真实 `Host` + SQLite 文件 + `createService`；替身只有脑子（按消息文本返回动作，并记录宿主交给它的 `RoundInput`）和 `scriptedCompute`（记录宿主对适配器的 spawn/resume 调用）。断言对象是服务返回值、存储读回、宿主装配后交给脑子的请求块、宿主对 Compute 适配器的调用，都是宿主一侧的可观察结果，没有断自己搭的桩，没有恒真断言（G-TAUTO、G-STUB ✓；写了「只断自己的对象」「恒真 + skip」两个应失败输入，门禁都判失败）。

审查方另构 9 个单点故障打在生产代码上（`host.ts` 7 个、`service.ts` 2 个，各在独立副本里跑）：

| 故障 | 结果 |
|---|---|
| R2 换 harness 时把人设清空 | 具名杀死（身份记忆） |
| R3 群普通消息只送到第一位联系人 | 具名杀死（群普通消息） |
| R4 `tasks.progress` 未知任务不报错 | 具名杀死（tasks.progress） |
| R7 群里无关插话被当成回答提交 | 具名杀死（无关插话） |
| R8 恢复时丢掉回答原文 | 具名杀死（无关插话） |
| R9 `limit` 多取一条 | 具名杀死（tasks.progress） |
| **R1 装配本轮记忆时把同名联系人的记忆一起读进来** | **存活**，新测试 4/4；server 包其余 289 条也全过 |
| **R5 `progress` 查询不按 `task_id` 过滤** | **存活**，新测试 4/4；server 包其余 289 条也全过 |
| **R6 `questionCard` 不核对 `qId`** | **存活**于新测试；server 包既有 2 条测试能发现 |

6/9 被具名杀死，3 个存活。三个存活的故障各写了一条探针测试（原实现上 3/3 通过，注入后各自按名 `ERR_ASSERTION`），说明行为可观察、原实现正确，缺的是断言。

### 5. 问题清单

#### R1-01 · 必须返修：同名隔离只看了存储列表，没看装配进本轮的内容

- 位置：`packages/server/src/coverage-invariants.test.ts:57–59`。
- 现状：同名新联系人 `other` 建出来后只断 `h.listMemories(other.id)` 为空、ID 不同。`other` 从没参加过一轮，脑子收到的请求块没有被检查。标题写的是「同名新建记忆隔离」。
- 复现：`host.ts` `memoryForRound` 第一行改成按名字汇总所有同名联系人的记忆（`this.liveContacts().filter(c => c.name === 本人名字).flatMap(c => this.memory.list(c.id))`）。新测试 4/4 通过，server 包全部 293 条通过——整个仓库没有任何测试能发现「记忆串到同名的另一个联系人」。
- 返修：让同名的第二位联系人真的跑一轮（同一个房间或各自私聊都行），断它收到的请求块里没有前一位的记忆正文和人设原文、有自己的人设；前一位仍读到自己的。审查方探针 A 可作参照（证据目录 `scripts/reviewer-probe.test.ts`）。把这个故障加进作者的预绑定变异清单。

#### R1-02 · 必须返修：tasks.progress 没有「只返回本任务」的断言

- 位置：同文件 `:92–108`。
- 现状：全程只有一个任务、一个 Compute，「准确字段」里的 `taskId` 是查询参数原样回填的（`host.ts:1669`），库里别的任务的行混进来也看不出。
- 复现：`host.ts:1666` 的 `WHERE task_id = ?` 改成 `WHERE (task_id = ? OR 1)`。新测试 4/4，server 包 293 条全过。
- 返修：同一房间起第二个任务并各发一条 milestone，断两个任务的进度互不包含（`computeId`、`summary` 都对上）。参照探针 B。加进变异清单。

#### R1-03 · 必须返修：「按原问题恢复」没有核对 qId

- 位置：同文件 `:120–123`。
- 现状：只用正确的 `qId` 回答了一次。问题号不核对时这条测试照样通过。
- 复现：`host.ts:1567` 的 `json_extract(meta, '$.qId') = ?` 改成恒真。新测试 4/4；既有的「AC-44 ⑤ 换了新问题后…」「tasks.answer:不存在的问题号 not_found…」两条能发现，所以仓库整体不漏，但本片标题声称的「原问题」没有被本片守住。
- 返修：在回答原问题之前，先用一个不存在的 `qId` 回答，断 `not_found`、任务状态与待回答问题不变、Compute 没有被恢复。参照探针 C。加进变异清单。

#### R1-04 · 必须返修：收据的作者会话号是 Codex 原生子线程号，门禁读不到

- 位置：`receipts/feat-coverage-invariants.json` `author.session`、`contributingSessions`。
- 核对结果：`01a1d043-1042-7e61-9981-968868c25de1` 是 Codex 原生线程号（`~/.codex/sessions/2026/11/12/rollout-2026-11-12T22-56-58-01a1d043-….jsonl`），来源是子代理：`thread_spawn`，父线程 `01a1cfc8-db89-7400-b3de-876bd8478982`，路径 `/root/coverage_invariants_tests`，昵称 Noether。父线程 `01a1cfc8…` 是宿主会话 **`codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`** 的 `nativeSessionId`（该会话 `record.json`）。`~/.mirasim/sessions/codex/` 下没有以 `01a1d043…` 或 `01a1cfc8…` 命名的目录。
- 门禁实测（把 review 填上后）：`G-PROVENANCE … 作者会话不可信:会话记录不存在:codex:01a1d043-1042-7e61-9981-968868c25de1`。
- 返修：`author.session` 写宿主会话 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`，子代理原生线程号写进 notes（仓库此前的约定：收据会话号不带子代理后缀，子代理在 notes 里标）；`contributingSessions` 同样用宿主会话号。改完以后门禁能不能过，还取决于宿主那一轮结束后写出的 `turns.jsonl` 里有没有子代理的工具调用，见「需拍板」。

#### R1-05 · 建议（不阻塞）

- `check()` 用下标 `blocks[0]`、`blocks[4]` 取人设块和记忆块，块顺序一变就会误报；能按块的种类取就按种类取。
- 群普通消息一条断了「在途时不 resume」，没断「T4b 阻塞时普通消息不 resume」——第四条测试覆盖了，这里只是提示两条互补，不需要改。

### 6. 来源核验核到哪一步

门禁读的是宿主 `~/.mirasim/sessions/<harness>/<id>/turns.jsonl`。作者收据里的会话号在那里不存在；真正的宿主会话 `codex:76d2c467…` 的 `turns.jsonl` 目前只有 1 轮（更新于本片开工之前），不含本片任何提交号——该会话还在跑，这一轮没结束。所以**门禁现在核不了作者来源**，这一点如实记为未通过，不改门禁。

替代核验：直接读 Codex 原生记录 `rollout-…01a1d043….jsonl`（204 次工具调用，`turn_context.model` 6 次全是 `gpt-6.1-sol`，分叉后自己的操作从 14:57 UTC 起，工作目录 `/private/tmp/gg-req-invariants-resume-20261112`）。逐项对到的：

| 作者声称 | 原生记录里的命令与输出 |
|---|---|
| 8 个提交 | 8 次 `git commit` 的输出里依次出现 `c250f5f0`、`5e438f49`、`46e339ca`、`a9c0ffef`、`5cf70481`、`b4a9683a`、`9f429cba`、`94330232`，与远端历史逐个相同 |
| 红 4 → 绿 4 | 首轮红 `# pass 0 / # fail 4`、绿 4/4 的 TAP 原文在输出里；第二轮 `a9c0ffef`→`5cf70481` 的 `sameTestSha256 ac7f6d85…` 与现在的测试文件 SHA 相同 |
| 首轮 typecheck 失败后重做 | 首轮云端结果 `typecheck exit_code 2`（HEAD `46e339ca`），第二轮 `exit_code 0`；失败包保留在仓库 `initial-typecheck-failure.tar.gz` |
| 云端 1477、8/8 变异 | box3 取回的 `result.json` 尾部 `# tests 1477 / # pass 1477 / fail·cancelled·skipped·todo 0`，head `5cf70481`、red `a9c0ffef`；取回后脚本断言 `killed==8 and survived==0` |
| 证据包 | 仓库内 `cloud-proof.tar.gz` SHA256 `74f11a35…702a`、`initial-typecheck-failure.tar.gz` `8accdb64…7b9e96`，与 README、交接 ZIP 里的两份逐字节相同；包内 `full.log` 1477/1477、`red.log` 4 条 `ERR_ASSERTION`、`mutations/result.json` 8/0 |
| 门禁哈希 | `--local` 输出 `CONTENT_HASH=2efdba77…47c6`，与我算的相同 |
| 推送未绕过钩子 | 第一次推送的包装脚本在按 UTF-8 解码钩子输出时崩了（`UnicodeDecodeError`），作者记成「push 结果未观察到，不算数」，随后查远端无此分支；第二次 `git push -u origin feat/coverage-invariants`（没有 `--no-verify`）钩子跑完 `# pass 1477`、`自检…用例 219/219`，输出 `* [new branch]`，exit 0 |
| 开 PR | `gh pr create` 返回 `pull/86`，回读 `headRefOid 94330232…`、`isDraft true` |
| 云端清理 | 清理脚本因 box3 `No space left on device` 失败，作者如实记录，没有声称清完 |

交接 ZIP（SHA256 `0ad7a09f…af4e9`，11 成员）解到空目录只读核对：bundle 头是 `94330232`，钩子日志与上表一致。

没核到的：box3 上的原始运行我没有登录去看（磁盘已满，按要求不去），云端数字是用「原生记录里取回的输出 + 证据包 + 我在 box2 的独立重跑结果一致」三者互证的。

填了 review 之后 `run-all.ts --local --base=origin/dev/integration` 的原样结果见本节末尾「审后门禁」。

### 7. 门禁应失败输入（本机沙箱，各在一次性副本里提交，不推送）

| 门禁 | 输入 | 判定 |
|---|---|---|
| G-TRACE | AC-01 改「通过」不写证据；加不存在的 AC-9999 | ✗ 两条都报 |
| G-REVIEW | 审查人写 codex、模型同为 OpenAI、hash 全 0 | ✗ 同一人、同厂商、hash 不符 |
| G-RED | `red.commit` 指向实现正确的 `5cf70481` | ✗ 4 条「没有按名字失败」 |
| G-STUB | 加一条只断自己对象的测试 | ✗「换成空桩后没有按名字失败」 |
| G-TAUTO | 加 `assert.equal(c.id, c.id)`、`assert.ok(true)`、`test.skip` | ✗ 自比较、恒真、skip 都报 |
| G-WORKFLOW | 新 workflow 用 `pull_request_target`、`write-all`、job 名 `self-check` | ✗ 三条都报 |
| G-LAYER | `domain` 里 `import "@g-group/server"` | ✗ domain 不能依赖 app 层 |
| G-PROVENANCE | review 填一个不存在的 claude 会话 | ✗ 作者会话、审查会话记录都不存在 |

### 8. 证据与清理

证据：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr86-r1-claude/`（云端结果包 `cloud/evidence.tgz` SHA256 `5c8719b6…b366`、审查方变异脚本与结果、三条探针及其 TAP、八个门禁应失败输入的日志、作者原生记录的命令时间线）。

### 审后门禁

填入本轮 review 后在本机克隆运行 `node scripts/gates/run-all.ts --local --base=origin/dev/integration`，原样结果：

```text
base=origin/dev/integration branch=feat/coverage-invariants HEAD=943302320f3b49fe429fba79f3c3e7d0e2a24197 受检文件 12 个 收据=receipts/feat-coverage-invariants.json 门禁 8 个
✗ G-PROVENANCE  R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是仓库所有者对这个 PR 这一版的结构化批准
    - 作者会话不可信:会话记录不存在:codex:01a1d043-1042-7e61-9981-968868c25de1
    - 审查会话不可信:会话记录不存在:claude:89762718-8de0-48ba-8531-1f6f3ee30739
✓ G-TRACE  R-06 R-08 R-15:受管改动必须有收据,条目对上验收文档,状态四选一,通过要有证据
✗ G-REVIEW  R-01:审查人限 Codex/Astra/Claude/Argon(g-group#1531、g-group#2943、g-group#3199 原则 68,默认 Codex;Claude 审 Codex 写的 PR,Argon 备用),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)
    - 审查结论是 reject
✓ G-RED  R-02:先红后绿,红提交上的测试与现在相同,现在的测试放到红提交实现上按名字失败、现在按名字通过
✓ G-STUB  R-03 R-04:空实现红基线 + 返回值变异校准,桩下或错值下仍通过、没执行、加载失败的测试都判无效
✓ G-TAUTO  R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、自比较、恒真、不可达、不判源码结果、skip/only;运行时与静态逐条计数一致)
✓ G-WORKFLOW  R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限、不得写提交状态、不得用 pull_request_target
✓ G-LAYER  插件化:包分层只能向下依赖,插件互不依赖,禁止相对路径跨包(import 与依赖声明都查)
CONTENT_HASH=2efdba77c1e8120c4f32506e130d0a4cb1837e477d433d733cc2c759705947c6
exit=1
```

说明：G-REVIEW 因结论是 reject 按预期失败。G-PROVENANCE 两条：作者会话那条就是 R1-04；审查会话那条是因为宿主的 `turns.jsonl` 要到本轮结束才写出（现在该目录只有 `record.json`），本轮结束后才能由门禁核对审查会话里的 `--hash` 调用，现在如实记为未通过。没有为了变绿改门禁或收据的作者字段。
