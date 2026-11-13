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

## 第 2 轮

### 结论：approve

第 1 轮四条必修（R1-01…R1-04）都已真解决，R1-05 建议也已采纳。第 1 轮存活的三个单点故障，现在都被作者自己的具名测试按名杀死（不靠审查方探针）。本轮新构的 7 个故障专打返修新加的断言，杀死 6 个；存活的 1 个（N7，只让「全局前缀记忆」串到同名联系人）超出 R1-01 的要求，记为建议 R2-01，不阻塞。只加测试这一点没有破：生产代码仍与 base 逐字节相同。审查人没有改产品代码、测试和收据的作者字段。

- 对象：`feat/coverage-invariants` `0633572e854148088f0da972064b8aa1e304a128`（开工前、写结论前回读远端都没变）；PR #86 仍是 draft。
- 基线：`origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`（与 merge-base 相同）。
- 审查人：Claude；会话 `claude:4e0a71e2-55f2-4eb1-ab93-ce65d14aa6d9`；本会话原始记录里的模型为 `group/opus`（Anthropic）。作者为 Codex / `gpt-6.1-sol`（OpenAI），跨厂商，不使用豁免。
- hy4 辅审因线路 403 未产出，本轮无辅审。
- 合同：`origin/docs/dev-handbook` `ff5bd712`（与第 1 轮相同，未变）；候选条目不作依据。
- 在自己的会话、独立克隆 `/tmp/pr86-r2/repo` 运行（不经管道）：

```sh
node /tmp/pr86-r2/repo/scripts/gates/run-all.ts --hash --branch=feat/coverage-invariants --base=origin/dev/integration --repo=/tmp/pr86-r2/repo
```

原样输出（与作者报的 CONTENT_HASH 一致）：

```text
8d04a717a7ce677a47ac87d70c27acd53a5abb61dfe67abc9305a9bd98dcb55c
```

### 1. 历史与只加测试

- 返修是叠在第 1 轮审查提交 `c908939d` 之后的正常快进：`c908939d` 与第 1 轮被审 HEAD `94330232` 都是现 HEAD 的祖先；作者推送日志原文 `c908939d..0633572e  HEAD -> feat/coverage-invariants`，没有 force。第 1 轮之后的 5 个提交：`121a145f`（新红，挂在旧红 `a9c0ffef` 上的旁支）、`e20b04ad`（返修测试、变异执行器、收据、证据）、`97b15ddd`（`merge --no-ff 121a145f`，把新红并成祖先）、`2fccaabd`、`0633572e`（只收证据）。
- 本文件「第 1 轮」一节原文未动：`git diff c908939d 0633572e -- reviews/feat-coverage-invariants.md` 为空。
- base..HEAD 全部 52 个变更都是新增；`packages`、`apps`、`scripts`、`.githooks`、`.github`、`third_party`、根 `package*.json`/`tsconfig*.json` 里，除新测试文件和 `packages/server/proof/` 两个脚本外没有任何改动。`host.ts` SHA256 `744317ce…a9d1` 在 base、`e20b04ad`、`97b15ddd`、HEAD 四处相同（合入新红后生产树仍正确）。
- 新红 `121a145f` 相对 base 改的 `host.ts` 仍是第 1 轮那 4 处错误返回（`afterAppend` 只通知被直接点名的人、`answerTask` 开头直接返回、`progress` 开头 `return []`、`identityOf` 返回固定串），没有为新断言另造故障；测试文件与 HEAD 逐字节相同（blob `5edc6ec9`）。新加的三处断言在红上是否「各自」变红看不出来（每条测试第一处断言就已失败），所以新断言的判别力以下面的变异结果为准，不以红为准。

### 2. 复现结果

重活在 box2 `/workspace/pr86-r2/`（Node v24.21.0，`/workspace/.heavy.lock` 排队，2026-11-12 20:03:54Z–20:10:50Z UTC，变异并发 2）；`--hash`、沙箱门禁、门禁自检、应失败输入在本机 `/tmp` 克隆。

| 操作 | 实测 |
|---|---|
| `npm ci` | 0 |
| 红 `121a145f` 跑新测试 | exit 1；0/4，4 条 `not ok` 全是 `ERR_ASSERTION`（业务断言，不是加载失败） |
| HEAD 跑新测试 | exit 0；4/4。另连续重跑 15 次，15 次都是 4/4 |
| `npm run typecheck` / `npm run lint` | 0 / 0（biome 200 文件） |
| 依赖回归（host/memory/group-claim/help 四个文件） | 37/37 |
| `npm test` | exit 0；1477/1477，fail/cancelled/skipped/todo 全 0；日志里 `replying` 出现 0 次 |
| 作者 `coverage-invariants-mutations.mjs` | exit 0；解析器校准通过、原样副本 4/4；11/11 被预绑定的具名测试以 `ERR_ASSERTION` 杀死，`complete:true`、`sourceUnchanged`、`testUnchanged` |
| `coverage-invariants-replying-gap.ts` | exit 1 `ERR_ASSERTION`；回复已提交，活动只有 `thinking(dm)` → `idle(null)` |
| `run-all.ts --local`（本机沙箱，审查前） | exit 1：G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER ✓；G-PROVENANCE ✗ 只剩审查侧两条（第 1 轮审查会话里没有等于新 hash 的 `--hash` 输出、因此认不出审查厂商）；G-REVIEW ✗（第 1 轮 reject、hash 不符）。**作者侧没有任何问题**，见第 5 节 |
| `run-all.ts --self-test`（不经管道，本机） | exit 0；「自检通过」，219/219，Node v22.22.0 |
| GitHub `self-check`（HEAD `0633572e`） | 只查一次：COMPLETED / SUCCESS，2026-11-12T19:08:48Z |

关于「补了断言总条数仍是 1477」：是在原 4 条测试里加断言，没有新增用例。1477 = base 1473 + 本片 4，与第 1 轮一致。四条标题没改；身份记忆那条的新增部分仍在标题「同名新建记忆隔离」之内，tasks.progress 的「跨任务不串」与无关插话的「错 qId 不生效」分别落在「准确字段」「原问题仍可回答」之下，标题对得上但没有点名，见 R2-02。

作者自述逐条对照：新云全量 1477/1477、依赖 37/37、11 个具名变异全杀、同体四红四绿——我在 box2 独立重跑，数字全部一致；538 份源码冻结、本机 seatbelt 六项绿、自检 219/219 exit 0——六项绿与 219/219 我在本机独立复现；冻结清单是作者云档里的 `out/freeze.json`，我没有逐份重算，用「我的克隆生产代码与 base 逐字节相同 + 作者云档 SHA 与仓库内副本一致」代替。

### 3. R1 核销表

| 编号 | 结果 | 依据 |
|---|---|---|
| R1-01 同名记忆串读（必修） | 已解决 | 第二位同名联系人（自己的人设）与第一位同在一个群、共享 `room:` 锚点，真的跑了一轮（`:67` 断它收到了那条消息）；`:71` 断它的身份块是自己的 id 与人设，`:73` 断它整份请求里没有第一位的记忆正文和人设原文，`:68` 断第一位仍读到自己的记忆。第 1 轮存活的故障（审查方 R1 ＝作者 M09）现在被「Q02 身份记忆…」按名杀死于 `:73` |
| R1-02 进度不按任务过滤（必修） | 已解决 | 同房间起真实第二任务（第二个 computeId，`:122` 断不同），各有独有进度；`:124` 断第一个任务的进度与之前逐项相同，`:127` 断第二个任务只有自己的两条（computeId、summary 一起核，不靠参数回填的 taskId），`:133–134` 重启后两边仍各自相同。第 1 轮存活的 R5（≈ M10）现在被「Q02 tasks.progress…」按名杀死于 `:124` |
| R1-03 不核对 qId（必修） | 已解决 | 回答原问题之前先用错 qId 调 `tasks.answer`：`:150` 断 `not_found`，`:151` 断整份任务视图不变，`:153` 断原问题卡仍是同一张、仍 open，`:154` 断 Compute 仍是起 1 次、续 0 次；随后正确 qId 仍能恢复原 Compute。第 1 轮存活的 R6（≈ M11）现在被「Q02 无关插话…」按名杀死于 `:150` |
| R1-04 作者会话号（必修） | 已解决 | `author.session` 与 `contributingSessions` 改为宿主会话 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`，第 1 轮的原生父线程 `01a1cfc8…`、子线程 `01a1d043…` 写进 `author.notes`。门禁实测：本轮所有 `--local` 运行（含 8 个应失败输入）G-PROVENANCE 都没有作者侧问题。返修所在的子线程 `01a1d035…` 没写进 notes，见 R2-03 |
| R1-05 按下标取块（建议） | 已解决 | `check()` 改为 `blocks.find(b => b.block === 1 / 5)`，并先断两块都存在 |

### 4. 自构故障（打在生产代码上，各在独立副本里跑完整 4 条）

第 1 轮的 9 个原样重跑，另新构 7 个专打返修新断言：

| 故障 | 结果（被哪条具名测试、断在哪行） |
|---|---|
| R1 装配本轮记忆时连同名联系人的一起读 | 杀死：身份记忆 `:73` |
| R2 换 harness 时清空人设 | 杀死：身份记忆 `:45` |
| R3 群普通消息只送第一位联系人 | 杀死：群普通消息 `:98`（身份记忆 `:67` 连带失败） |
| R4 `tasks.progress` 未知任务不报错 | 杀死：tasks.progress `:118` |
| R5 进度不按 `task_id` 过滤 | 杀死：tasks.progress `:124` |
| R6 `questionCard` 不核对 qId | 杀死：无关插话 `:150` |
| R7 群里无关插话被当成回答 | 杀死：无关插话 `:146` |
| R8 恢复时丢掉回答原文 | 杀死：无关插话 `:157` |
| R9 `limit` 多取一条 | 杀死：tasks.progress `:117` |
| N1 第二位同名联系人拿到最早那位的人设（记忆不串） | 杀死：身份记忆 `:71` |
| N2 进度单向串：全库最新一行（第二任务的）漏进别的任务 | 杀死：tasks.progress `:124` |
| N3 进度单向串：全库最早一行（第一任务的）漏进别的任务 | 杀死：tasks.progress `:127` |
| N4 错 qId 照样回 `not_found`、任务不变，但 Compute 被续接 | 杀死：无关插话 `:154` |
| N5 错 qId 回 `not_found`，但原问题卡被置为过期 | 杀死：无关插话 `:153` |
| N6 记忆写入时同时写给同名联系人（写侧串） | 杀死：身份记忆 `:65` |
| **N7 只有全局（前缀）记忆串到同名联系人** | **存活**：新测试 4/4，server 包其余 289 条也全过 |

16 个里 15 个被具名杀死，没有一个是加载失败或超时。N7 存活的原因：测试里第一位联系人只有挂在 `room:` 锚点上的记忆，没有全局记忆，前缀路径上没东西可串。另写一条探针（第一位用「以后都…」原话记一条全局记忆，第二位同名联系人在自己的私聊跑一轮）：原实现通过，注入 N7 后按名 `ERR_ASSERTION`——行为可观察、原实现正确，缺的是这一类记忆的断言。见 R2-01。

### 5. 来源核验核到哪一步

**门禁实测（第 1 轮需拍板第 2 项要的数据）**：收据改成宿主会话号以后，G-PROVENANCE 读得到作者来源。宿主 `~/.mirasim/sessions/codex/76d2c467…/turns.jsonl` 现有 2 轮，第 2 轮 554 次工具调用、模型 `gpt-6.1-sol`，里面有 `121a145f`、`e20b04ad`、`97b15ddd`、`0633572e` 的提交输出——宿主把子线程的工具调用也记进了父会话这一轮。门禁据此认出产出厂商是 openai，与自报相符，作者侧不再报错。第 1 轮时读不到，一是收据写的是子线程号，二是宿主那一轮还没结束、`turns.jsonl` 还没写出。

**原生记录逐项核对**：宿主 `record.json` 的 `nativeSessionId` 是 `01a1cfc8-db89-7400-b3de-876bd8478982`；返修出自它的子线程 `01a1d035-2076-7443-bb9f-062b74f98187`（`thread_spawn`、depth 1、昵称 Euler、`agent_path /root/contact_history_finish`——这个子线程原本派去做别的片，同一轮里也做了 PR #84 的返修），`turn_context.model` 18 次全是 `gpt-6.1-sol`。Q02 部分在 17:54–18:54 UTC，工作目录 `/private/tmp/gg-req-invariants-r2-resume-20261113`：

| 作者声称 | 原生记录里的命令与输出 |
|---|---|
| 从 `c908939d` 起返修 | 17:54:31 从 R1 克隆复制并断言 HEAD 为 `c908939d…` |
| 原测试下三个反例先存活、增强后 3 pass / 1 具名失败 | 18:06–18:07 窄校准的原始 TAP 计数在输出里，与仓库内 `original-*.tap`、`final-*.tap` 一致 |
| 新红 `121a145f` 0/4 | 18:09:39 在 `/private/tmp/gg-q02-r2-samebody-red-…` 提交 `[calibration/q02-r2-samebody-red 121a145f]`，紧接 TAP |
| `e20b04ad`、合并、`2fccaabd`、`0633572e` | 18:13:24 `[feat/coverage-invariants e20b04ad]`；`git merge --no-ff 121a145f…` → `Merge made by the 'ort' strategy`，之后 `merge-base --is-ancestor` 0、`git diff --exit-code c908939d -- host.ts reviews/…` 0；18:14:06 `[… 2fccaabd]`；18:42:28 `[… 0633572e]` |
| 云端 13 阶段 | 18:32 box4 排队，queue PID 686285 / runner PID 686287，18:36 `exit.code 0`；取回的 `cloud-results-2fccaabd.tar.gz` SHA256 `776693b4…d0fd` 与仓库内、交接 ZIP 内的副本相同；包内 13 条命令、11/11、37/37、1477/1477 与我在 box2 的独立重跑一致 |
| 正常推送、钩子未绕过 | 18:46–18:50 `git push origin HEAD:refs/heads/feat/coverage-invariants`（无 `--force`、无 `--no-verify`），exit 0、196 秒；推送日志（SHA256 `7ce1e9ef…7c0d`，与交接 ZIP 内相同）里钩子跑了 `# pass 1477`、`自检耗时 129s:用例 219/219`，结尾 `c908939d..0633572e` |

交接 ZIP（SHA256 `d233592a…74944c52`）解到新空目录只读核对：`candidate.bundle` SHA256 `08b7110e…16c9`，头是 `0633572e`；`final-hash.log` 为 `8d04a717…cb55c`；`final-gates.log` 与我审查前的 `--local` 结果相同。

没核到的：box4 上的原始运行我没去看（作者的重活队列，按要求不去），云端数字用「原生记录里的输出 + 证据包 + 我在 box2 的独立重跑」三者互证。

### 6. 门禁应失败输入（本机沙箱，各在一次性副本里提交，不推送）

| 门禁 | 输入 | 判定 |
|---|---|---|
| G-TRACE | AC-01 改「通过」不写证据；加不存在的 AC-9999 | ✗ 两条都报 |
| G-REVIEW | 审查人写 codex、模型同为 OpenAI、hash 全 0 | ✗ 同一人、同厂商、hash 不符 |
| G-RED | `red.commit` 指向实现正确的 `e20b04ad` | ✗ 4 条「没有按名字失败」 |
| G-STUB | 加一条只断自己对象的测试 | ✗「换成空桩后没有按名字失败」 |
| G-TAUTO | 加 `assert.equal(c.id, c.id)`、`assert.ok(true)`、`test.skip` | ✗ 自比较、恒真、skip 都报 |
| G-WORKFLOW | 新 workflow 用 `pull_request_target`、`write-all`、job 名 `self-check` | ✗ 三条都报 |
| G-LAYER | `domain` 里 `import "@g-group/server"` | ✗ domain 不能依赖 app 层 |
| G-PROVENANCE | review 填一个不存在的 claude 会话 | ✗ 审查会话记录不存在（作者侧仍无问题） |

### 7. 作者保留的缺口

- replying 探针仍在 `packages/server/proof/`，不是 `*.test.ts`，不进套件（全量日志 0 处），实测仍 exit 1；新测试文件没有 `skip`/`todo`/`only`。收据 `knownGaps` 仍标 U83「失败」、`tasks.progress.afterAt`「未测」。
- AC-01、AC-43、AC-44 仍是「未测」，`waiver` 为 null，`overallAcceptance` 写明未完成；没有把子项绿升格成整条通过。真实 harness/CLI/界面/复合 AC 不在本片，与收据一致。

### 8. 问题清单

#### R2-01 · 建议（不阻塞）：同名隔离只覆盖了挂在房间锚点上的记忆

- 位置：`coverage-invariants.test.ts:59–74`。
- 现状：第一位联系人只有 `room:` 锚点的记忆。宿主把全局记忆另走一条前缀路径（`memoryForRound` 里的 `prefixMemories`），这条路径串到同名联系人时（N7）新测试和 server 包都发现不了。
- 为什么不阻塞：R1-01 要的是「第二位真的跑一轮、收到的内容里没有前一位的记忆和人设」，已做到；全局记忆是另一条路径，第 1 轮没有要求。
- 建议：第一位再记一条全局记忆（原话含「以后都」），断第二位的第 1 块和整份请求里都没有它。探针 `probe-n7.test.ts` 在审查证据目录，可直接参照。

#### R2-02 · 建议：测试越加越长，标题没点名新加的性质

- 身份记忆一条 44 行、tasks.progress 31 行。新加的「跨任务不串」「错 qId 不生效」在标题里没有点名，多数断言没写失败说明，出错时要靠行号判断是哪条性质坏了（变异结果显示各故障落在不同行，能定位，只是不直观）。
- 建议：后续拆成独立具名测试，或至少给新断言加失败说明。

#### R2-03 · 建议：收据 notes 没写返修所在的子线程

- `author.notes` 只写了第 1 轮的原生父线程与子线程 `01a1d043…`；第 2 轮返修出自子线程 `01a1d035-2076-7443-bb9f-062b74f98187`，没写。门禁按宿主会话核，不影响通过；补上便于以后人工核对。

### 9. 需拍板

1. **（第 1 轮第 1 项，仍待定）只加测试的片子，把生产代码改坏造出来的红算不算有效的先红后绿。** 本轮照第 1 轮口径不以此拒绝；G-RED 实际判 ✓。补充：本轮作者用 `merge --no-ff` 把新红并成祖先，PR 若按普通合并进 `dev/integration`，主线历史里会带上几个 `host.ts` 被故意改坏的提交（`c250f5f0`、`a9c0ffef`、`121a145f`），二分查找时会踩到；用压缩合并就没有这个问题。
2. **（第 1 轮第 2 项，有了实测）Codex 子代理写的片子，门禁怎么核作者。** 实测：收据写宿主会话号、宿主那一轮结束后，宿主 `turns.jsonl` 会带上子线程的工具调用，G-PROVENANCE 作者侧能过。建议定为规则：`author.session` 写宿主会话号，子线程原生号写进 notes。剩下的限制：门禁只看厂商，分不出是哪个子线程、哪一轮写的这片。

### 10. 证据与清理

证据：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr86-r2-claude/`（云端结果包 `cloud/evidence.tgz` SHA256 `6bb5db63…0b3d`；审查方 16 个故障的脚本与结果、云端运行脚本、N7 探针及两份 TAP、8 个应失败输入的日志、审查前 `--local` 与自检原文、原生记录 `01a1d035` 的命令时间线）。

### 审后门禁

填入本轮 review 并在本机提交后，于本机沙箱运行 `node scripts/gates/run-all.ts --local --base=origin/dev/integration`，原样结果：

```text
✓ G-PROVENANCE  ✓ G-TRACE  ✓ G-REVIEW  ✓ G-RED  ✓ G-STUB  ✓ G-TAUTO  ✓ G-WORKFLOW  ✓ G-LAYER
CONTENT_HASH=8d04a717a7ce677a47ac87d70c27acd53a5abb61dfe67abc9305a9bd98dcb55c
exit=0
```

8 个门禁全过。G-PROVENANCE 两侧都核上了：作者侧按宿主会话 `codex:76d2c467…` 的 `turns.jsonl` 认出 openai；审查侧在本会话已写出的那一轮记录里找到一次不经管道的 `run-all.ts --hash`，输出等于 `reviewed_hash`，那一轮模型 `group/opus` 认作 anthropic。完整日志 `gates-local-after.log` 在证据目录。本克隆没有配 `core.hooksPath`，推送时用 `-c core.hooksPath=.githooks` 让仓库的 pre-push 钩子照常运行（钩子自检接了管道的问题另开一片修，自检以上面不经管道的 219/219 为准）。
