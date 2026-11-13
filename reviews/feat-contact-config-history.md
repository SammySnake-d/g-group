# PR #84 · 联系人配置历史与回滚（U07 后端候选）独立审查

## 第 1 轮

### 结论：reject

本轮是独立跨厂商审查，**不是 U07 验收通过，也不是 AC-01 / AC-32 验收**。5 项必须返修（R1-01 ～ R1-05）。审查人没有改产品代码、测试或门禁。

- 对象：`feat/contact-config-history`，HEAD `3cfabba2978e3b617a07c86b962eba5fd8e4d411`（开工前与提交前两次回读远端，未变）。
- 基线：`origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`。
- 审查人：Claude；会话 `claude:a32c9f77-01be-405f-b2a8-1097160e10aa`；宿主记录的模型名 `group/opus`（Anthropic Claude 的线路组，门禁 `vendorOf` 判为 anthropic）。
- 辅审：hy4 辅审因线路 403 未产出，本轮无辅审。
- 合同依据：`origin/docs/dev-handbook` `ff5bd712` 的 `docs/spec/`（需求文档 v3.31、验收文档 v0.1）。U07 已定部分只有「版本快照、调教坏时可回滚配置」（用户 `#50`）；导出导入、Soul 自修改是未定或候选，不作依据。输入合同按 g-group#2662「只保证内置原型未被改的环境」。
- 环境：本机 macOS、Node v22.22.0，独立克隆 `/tmp/pr84-r1-claude/repo`；重活在云电脑 box2（Ubuntu 24.04、Node v24.21.0）`/workspace/pr84-r1/`，走 `.heavy.lock` 排队。

在本会话里运行：

```sh
node /tmp/pr84-r1-claude/repo/scripts/gates/run-all.ts --hash --repo=/tmp/pr84-r1-claude/repo --branch=feat/contact-config-history --base=origin/dev/integration
```

原样输出（= reviewed_hash，与作者报的 CONTENT_HASH 相同）：

```text
123bb4c606a44b02b98637b48c3a7e0b949ad76bca6b814dda16ddd4e6b077ca
```

### 一、亲自运行的结果

| 操作 | 在哪 | 实测结果 |
|---|---|---|
| `npm ci` | 本机、box2 | exit 0 |
| `npm run -s typecheck` | box2 | exit 0 |
| `npm run -s lint` | box2 | exit 0，`Checked 201 files` |
| `npm test` | box2 | exit 0，1485 条，pass 1485，fail/cancelled/skipped/todo 均为 0 |
| 新测试文件单跑（TAP） | box2 | 12/12 通过 |
| 红提交 `93e8cf92` 上跑同一文件 | box2 | exit 1，0 通过、12 失败；12 条都是 `ERR_ASSERTION` / `AssertionError` / `testCodeFailure`，失败行落在各用例的业务断言上（如 CFG05 第 101 行 `2 !== 3`），不是语法或导入错 |
| 更早的红提交 `0eb6ad3b`、`03d5e954` | 本机 | 各 12/12 失败，全部 `ERR_ASSERTION` |
| 红提交与 HEAD 的测试文件 | 本机 | 逐字相同；实现文件 `c8449f69` 与 HEAD 逐字相同 |
| 作者变异脚本 `contact-config-history-mutations.mjs` | box2 | 原样 12/12；15 项 15/15 被杀，每项都由脚本指定的 CFG 用例以 `ERR_ASSERTION` 失败，存活/无效 0。逐项结果与仓库里的 `contact-config-history-mutations.json` 一致 |
| 作者 proof `contact-config-history-real.ts` | box2 | exit 0，输出与作者归档一致 |
| `run-all.ts --local --base=origin/dev/integration`（审查前） | 本机 | G-PROVENANCE ✓（review 为空时直接返回，不是已核）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓；exit 1 |
| 同一命令（填了本轮 review 之后） | 本机 | G-PROVENANCE ✗「审查会话不可信:会话记录不存在:claude:a32c9f77-…」；G-REVIEW ✗「审查结论是 reject」；其余 6 项 ✓；CONTENT_HASH 不变；exit 1 |
| `npm run -s gates:selftest` | box2 | 失败，165/219：机器没有沙箱（无 `sandbox-exec`、未设 `GATE_SANDBOX_IMAGE`），门禁按设计拒绝在宿主上执行 PR 代码。属环境，不算本 PR 的问题 |
| `GATE_SELFTEST_JOBS=2 npm run -s gates:selftest` | 本机 | exit 0，`自检通过`，用例 219/219 |
| GitHub `self-check` | — | 本轮回读为 COMPLETED / SUCCESS（HEAD `3cfabba2`） |

作者报的数字逐条对上：红 12 → 绿 12/12、变异 15/15、typecheck/lint = 0、全量 1485/1485 且 skip/cancel/todo = 0、六项机械门禁通过、G-REVIEW 未过。

### 二、必须返修

#### R1-01 · 高：历史可以被原位改写，「历史拒绝原位修改」不成立

- 位置：`packages/server/src/contact-config-history.ts:20-26`。只建了 BEFORE UPDATE / BEFORE DELETE 两个触发器。
- 复现（HEAD 原样，真 Host / SQLite）：

  ```sql
  INSERT OR REPLACE INTO gg_contact_config_versions (contact_id, version, config, kind, restored_from, at)
  VALUES (<已有联系人>, 1, <另一份配置>, 'create', NULL, '2026-01-01T00:00:00.000Z');
  ```

  不报错；表里仍是 1 行，但版本 1 的人设、工具和时间都换成了新值；`contacts.history` 返回被改写后的内容；随后 `contacts.rollback` 到版本 1 把被改写的人设和工具（探针里是 `NEUTRAL_INJECTED_TOOL`）写回了联系人。
- 原因：SQLite 的 `recursive_triggers` 默认关闭（实测为 0），REPLACE 删旧行时不触发 DELETE 触发器。本仓库 `packages/adapter-sqlite/src/store.ts:25-26` 的注释已经写明这一点，`events` 表因此用 BEFORE INSERT 拦覆盖写；本片没有照做。
- 现有测试：CFG11 只试了 `UPDATE` 和 `DELETE` 两条语句，发现不了。
- 返修要求：加一道对已存在 `(contact_id, version)` 的插入拒绝（BEFORE INSERT 触发器，做法同 `events` 表），并在 CFG11 或新用例里断言 `INSERT OR REPLACE` 被拒、原值保留。先红后绿。

#### R1-02 · 高：回滚的原子性没有测试保护

- 位置：`packages/server/src/host.ts:625-643`（`rollbackContact`）。HEAD 的行为是对的（探针：回滚途中历史写入失败 → 联系人版本仍是 2、名字仍是「新」、无通知）。
- 复现：把 `rollbackContact` 的 `tx(this.db, () => {…})` 换成直接执行（单点故障 F6）。12 条新测试 12/12 通过，全量 1485/1485 通过，作者 proof 通过。此时同一探针的结果是：接口返回 `internal`，但联系人已被改成版本 3、名字「原」，历史表仍只有 2 行——配置落了盘、历史没有、通知没发。
- 现有测试：作者的 M07 与 CFG07 只覆盖 `contacts.update`；CFG06 只覆盖「模型预检失败不写」，那一步在任何写入之前。
- 返修要求：补一条回滚路径的原子性用例（历史写入失败时联系人版本、内容、历史行数、通知数都不变；去掉故障后用同一 `clientActionId` 重试成功且只追加一个版本）。

#### R1-03 · 高：回滚只被验证恢复了名字、人设和 Compute 模型

- 位置：`packages/server/src/host.ts:633`。HEAD 的行为是对的（探针：`tools`、`computeAssets`、`computeSlots`、`bio`、`avatar` 都恢复）。
- 复现：把该行改成回滚时保留当前的 `tools`、`computeAssets`、`computeSlots`、`bio`、`avatar`（单点故障 F8）。12/12、1485/1485、作者 proof 全部通过。此时回滚到版本 2 后，联系人仍带着后来加的 `NEUTRAL_EXTRA_TOOL`、槽位仍是 9、简介仍是「改坏」。
- 影响：`tools` 与 `computeAssets` 是联系人能用什么的授权配置。回滚后界面显示已回到旧版本，实际授权没有收回，现有测试不会报。
- 返修要求：回滚用例对白名单里的每个字段都断言恢复（至少 `tools`、`computeAssets`、`computeSlots`、`bio`、`avatar`、`speakingModel`、`harness`）。

#### R1-04 · 中：落盘的白名单没有测试保护

- 位置：`packages/server/src/contact-config-history.ts:41`。HEAD 的行为是对的（探针：表里的 `config` 只有 10 个白名单键）。
- 复现：把 `JSON.stringify(contactConfigOf(value))` 改成 `JSON.stringify(value)`（单点故障 F2）。12/12、1485/1485、作者 proof 全部通过。此时表里的 `config` 含 `id`、`createdAt`，旧数据带的 `NEUTRAL_PRIVATE_MEMORY`、`NEUTRAL_FIXTURE_NO_CREDENTIALS` 两个标记也进了历史表；接口输出里没有，因为读出时又投影了一次（`:45`）。
- 现有测试：CFG10 只查接口返回，看不到表里的内容。历史表不可改不可删，白名单外的内容一旦写进去就清不掉。
- 返修要求：CFG10（或新用例）直接读 `gg_contact_config_versions.config`，断言键集合恰为白名单、不含两个标记；`create`、`update`、`batch`、`rollback`、`baseline` 五种写入各至少覆盖一次。

#### R1-05 · 中：收据的作者来源不完整

- 位置：`receipts/feat-contact-config-history.json` 的 `author` 与 `unverifiable`。
- 核到的事实（Codex 原生记录，见第四节）：提交 `0eb6ad3b`、`03d5e954`、`c8449f69`、`93e8cf92`、`badd24e5`——即全部产品代码、测试与红提交——由 `codex:534f3614-21cd-43eb-9db6-3cd1673d2b62`（原生会话 `01a1cf01-…`）派出的子代理 `01a1cf62-…`（`/root/implement_contact_history`）写出，模型 `chatflows/gpt-6-astra`。收据登记的 `codex:76d2c467-…`（原生 `01a1cfc8-…`，`gpt-6.1-sol`）的子代理 `01a1d035-…`（`/root/contact_history_finish`）只做了 `126c42ae` 起的变异脚本、proof 脚本、证据、收据和推送，产品代码一行没动（`c8449f69` 与 HEAD 的实现文件逐字相同）。
- 影响：两段都是 OpenAI 模型，跨厂商结论不受影响。但收据写的是 `gpt-6.1-sol`，而产品代码是 `gpt-6-astra` 写的，R-07 / R-10 要求以会话原始记录为准。另外，宿主 `turns.jsonl` 里 `codex:76d2c467` 目前只有 1 轮，结束于本片开工之前，内容是另一片的工作；门禁的作者一侧会因为那一轮动过同一仓库而通过，证明不了本片的来源。
- 返修要求：在收据里写明上述两段会话各自产出了哪些提交、各用什么模型（`author.session` 不能带后缀，写进 `unverifiable`）；`author` 填谁由作者按实际产出决定并说明理由。不要为此改门禁。

### 三、审查人自构的单点故障

在 box2 的独立工作树里一次改一处，各跑新测试文件（12 条）、作者 proof、全量 `npm test`；原样对照 12/12、proof exit 0、1485/1485。全量一栏的「失败」只按退出码 1 判：这几次的全量日志都在第 562 条处被截断、看不到失败用例名（`scripts/gates/test-runner.ts` 失败退出时输出没写完，基线上就有，不是本 PR 引入），具名失败以 12 条单跑的结果为准。

| 编号 | 故障 | 12 条新测试 | 作者 proof | 全量 | 结论 |
|---|---|---|---|---|---|
| F1 | 回滚不追加新版本 | CFG02、CFG05 断言失败 | 失败 | 失败 | 被发现 |
| F2 | 快照落盘整份联系人文档 | 12/12 | 通过 | 1485/1485 | **存活** → R1-04 |
| F3 | 回滚连带清掉该联系人的游标 | CFG02 断言失败 | 失败 | 失败 | 被发现 |
| F4 | 修改路径跳过版本校验 | CFG04 断言失败 | 通过 | 失败 | 被发现 |
| F5 | 动作幂等表不持久（重启后丢） | CFG05 断言失败 | 失败 | 失败 | 被发现 |
| F6 | 回滚的配置与历史不在同一事务 | 12/12 | 通过 | 1485/1485 | **存活** → R1-02 |
| F7 | 批量替换不在同一事务 | CFG08 断言失败 | 通过 | 失败 | 被发现 |
| F8 | 回滚不恢复工具/能力/槽位/简介/头像 | 12/12 | 通过 | 1485/1485 | **存活** → R1-03 |

8 个里 5 个被发现、3 个存活。三个存活故障的可观察后果都用探针对照过 HEAD（HEAD 行为正确，故障树行为错误而测试不报）。另有 R1-01 是 HEAD 本身的缺陷，不是变异。

为每个门禁写了一个应当失败的输入（独立工作树，未推送），门禁都判了失败：

| 输入 | 门禁输出 |
|---|---|
| AC-01 改成「通过」不写证据 | G-TRACE ✗「AC-01 标了通过但没写证据路径」 |
| 收据加一条 AC-999 | G-TRACE ✗「AC-999 不在验收文档里」 |
| review 填作者自己的会话并写 APPROVE | G-REVIEW ✗「审查人与作者是同一个」「同为 openai,且没有用户豁免」；G-PROVENANCE ✗「作者和审查用的是同一个会话」 |
| review 的 reviewed_hash 填全 0 | G-REVIEW ✗「审查对应的内容 000000000000 ≠ 当前 123bb4c606a4」 |
| review 填一个不存在的会话 | G-PROVENANCE ✗「会话记录不存在」 |
| `red.commit` 指向绿提交 `badd24e5` | G-RED ✗ 12 条「放到红提交的实现上没有按名字失败」 |
| 加一条不判实现结果的测试 | G-TAUTO ✗、G-RED ✗ |
| 加一条 `assert.equal(1, 1)` | G-STUB ✗、G-TAUTO ✗、G-RED ✗ |
| 加一个 `pull_request_target` + `write-all` 的 workflow | G-WORKFLOW ✗ |
| domain 包用相对路径引 server | G-LAYER ✗ |

### 四、来源核验

**填了 review 之后 G-PROVENANCE 实际判的是：** `✗ 审查会话不可信:会话记录不存在:claude:a32c9f77-01be-405f-b2a8-1097160e10aa`。原因是宿主的 `turns.jsonl` 只在一轮结束时写入，本审查会话的这一轮还没结束；这不是门禁读不了记录，本轮结束后同一命令的结果会变。由于门禁在审查一侧先报错，作者一侧在这次运行里没有单独的输出行。

用门禁自己导出的 `loadSession` / `turnTouchesRepo` / `vendorOf` 单独算作者一侧：`codex:76d2c467` 1 轮、`gpt-6.1-sol`、动过本仓库 → 产出厂商集合 `{openai}`，与自报相符；`codex:534f3614` 第 1 轮 `chatflows/gpt-6-astra`、动过本仓库 → `{openai}`。审查厂商 anthropic 不在集合里。

门禁读的是宿主记录，读不到 Codex 子代理的原生记录；而这一片的实际工作全在子代理里（见 R1-05）。所以另用 `~/.codex/sessions/2026/11/12/` 的原生 rollout 逐条核对，核到以下各步：

| 作者自述 | 原生记录里对应的调用与输出 | 结果 |
|---|---|---|
| 最初的红 `0eb6ad3b`、`03d5e954` | 子代理 `01a1cf62`，11-12 11:21 / 11:28 UTC 的提交命令；输出 12 条 `ERR_ASSERTION`、`RED_EXIT 1` | 一致 |
| 实现 `c8449f69` | 同上，11:34 UTC，`GREEN c8449f69…`，2 个文件 +126/−25 | 一致 |
| 校准红 `93e8cf92`、恢复绿 `badd24e5` | 同上，12:05 UTC；`RED_EXIT 1`、0/12；`GREEN_EXIT 0`、12/12 | 一致 |
| box3 全量 1485/1485（`c8449f69`） | 同上，12:18 UTC 取回的日志尾：tests 1485、pass 1485、fail/cancelled/skipped/todo 0 | 一致 |
| 变异脚本提交 `126c42ae` | 子代理 `01a1d035`，14:43 UTC | 一致 |
| 首次云端 fetch 分支名失败 exit 128 | 同上，14:45 UTC，`couldn't find remote ref feat/contact-config-history` | 一致（失败如实保留） |
| box3 变异 15/15（`126c42ae`） | 同上，14:46 UTC，`head 126c42ae…`、green exit 0、mutations exit 0，逐项 `killed:true` | 一致 |
| proof 提交 `13774dd4`；box3 typecheck/lint/proof exit 0 | 同上，14:50 / 14:52 UTC，`head 13774dd4…`，三项 exit 0 | 一致 |
| 首次机械门禁（`13774dd4`） | 同上，14:56 UTC，六项 ✓、G-REVIEW ✗、`CONTENT_HASH=2b6c37e0…` | 一致 |
| 证据提交 `80ba4186`、`773dafd8`；最终门禁 | 同上，14:58–15:00 UTC，HEAD `773dafd8`、`CONTENT_HASH=123bb4c6…` | 一致 |
| `3cfabba2` 提交与正常推送 | 同上，15:00 UTC 起；推送日志 `contact-history-push-hook.txt` SHA256 `1b73209f…`（本机文件、交接 ZIP 内文件、`push-result.json` 三处相同），含 tests 1485 / pass 1485、`自检耗时 159s:用例 219/219`、`* [new branch] feat/contact-config-history` | 一致，未见 `--no-verify` |
| 云端清理 | 同上，15:01 UTC，RAM 目录已删、自有进程 0 | 一致 |

原生记录里的模型：`01a1cf01` 与 `01a1cf62` 的 `turn_context.model` 是 `chatflows/gpt-6-astra`；`01a1cfc8` 与 `01a1d035` 是 `gpt-6.1-sol`。父子关系按 `session_meta.parent_thread_id` 与父会话里 `spawn_agent` 的返回值核对。

仓库内 `cloud-proof.tar.gz`：125974 字节、SHA256 `1949fdcb…`，manifest 36 项全部核对一致。交接 ZIP：429492 字节、SHA256 `c1f45438…`，22 个成员，bundle 校验通过且 HEAD 为 `3cfabba2`。

**没有核到的：** 云电脑 box3 上的原始日志没有再去读（作者已清 RAM 区，只核了取回本机后的输出与归档哈希）；Codex 原生记录本身的真伪只能按文件内部一致性判断（时间、提交号、哈希互相对得上）。

### 五、范围与收据标注

- 范围：改动限于 `packages/api-contract`（两个方法、两个实体）、`packages/server`（`host.ts`、`service.ts`、新模块、测试、两个 proof 脚本）、`docs/proof`、收据和 `reviews/` 下一个门禁输出文件。前端未改，没有导出导入，没有 Soul 自修改。未见越界。
- `R-02 通过`：属实。提名的红提交 `93e8cf92` 是实现写完之后把实现退回空壳重新提交的（为了让测试写法过 G-TAUTO）；真正写在实现之前的红是 `0eb6ad3b` / `03d5e954`，断言相同，只有 `createService` 的调用位置不同，三个提交都实测 12/12 断言失败。README 已说明。
- `AC-01 未测`、`AC-32 未测`：属实，README 与 PR 正文也都写了「不把子项绿提升为整项验收」。本片不能被说成 AC-01 / AC-32 通过。
- `reviews/contact-config-history-final-gates.txt`：是门禁输出，里面 G-REVIEW 为 ✗「还没有独立审查」，没有冒充审查结论。两点提醒：它记的 HEAD 是 `773dafd8` 而不是最终的 `3cfabba2`（`reviews/` 不进内容 hash，所以 hash 相同）；里面的 `✓ G-PROVENANCE` 是 review 为空时的直接返回。建议返修时挪到 `docs/proof/` 下，`reviews/` 只放审查记录。

### 六、观察项（不要求本轮返修，作者说明或顺手处理）

- O-1：回滚无论模型字段变没变都跑模型预检，`contacts.update` 只在补丁里带模型字段时才跑。探针：联系人当前已与目录不兼容时，只改简介的 `update` 成功，而回滚到模型相同、只有人设不同的旧版本被 `model-incompatible` 拦下，要带 `confirmAffected` 才行。偏保守，不算错，但两条路径不一致，请在收据里写明是有意的。
- O-2：空修改、与当前值相同的修改、回滚到当前版本，都会追加一个新版本。需求没有规定，记录在案。
- O-3：升级登记基线在 `Host` 构造函数里对每个未删除的联系人调用 `contactConfigOf`；文档缺 `tools` 时抛 `TypeError: value.tools is not iterable`，宿主起不来。产品自建仓以来写出的联系人文档都带这两个字段，所以只是提醒。
- O-4：「在途轮次用旧配置」目前只有 proof 脚本里的一条断言，判的是修改前已经取到手的那份轮次输入对象没有变；「更新后下一轮新、回滚后下一轮旧」也只在 proof 脚本里，`npm test` 不跑它。返修时建议把下一轮生效的断言放进测试文件。
- O-5：`contacts.create` 收 `clientActionId` 但不做幂等（基线上就是这样，不在本片范围）。

### 七、返修与重新送审

返修由作者一方做，先红后绿；改了受管文件后内容 hash 会变，本轮结论作废，需要重新送审。R1-01 ～ R1-04 各自的新用例请配一个对应的单点变异（即本文的 INSERT OR REPLACE、F6、F8、F2），确认由具名断言杀死。

### 证据

本机：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr84-r1-claude/`（box2 日志包、自构故障脚本与逐项结果、产品探针与输出、门禁负例输出、审查前后两次 `--local` 输出、原生记录调用索引）。

## 第 2 轮

### 结论：reject

只剩 1 项必须返修（R2-01）：返修加的 BEFORE INSERT 触发器挡住了同主键的 `INSERT OR REPLACE`，但带上已有行 `rowid` 的 `INSERT OR REPLACE` 仍能把历史原位改掉，回滚会把伪造的配置写回联系人。R1-02 ～ R1-05 已解决；返修新加的 4 条测试没有发现新的必修问题。本轮不是 U07 验收，也不是 AC-01 / AC-32 验收。审查人没有改产品代码、测试或门禁。

需要说明：R2-01 的根子在我第 1 轮的返修要求。R1-01 要求「做法同 `events` 表」，作者照做了；但 `events` 表在基线上有同样的缺口（见第五节），我第 1 轮没有查到。作者这一轮的实现完全符合 R1-01 的字面要求，问题出在要求本身不完整。

- 对象：`feat/contact-config-history`，HEAD `cd5c3f4d5e91a1eedce5780d86d3567d8acfbcd3`；开工前与提交前两次回读远端，未变。
- 基线：`origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`，未变。
- 返修叠加方式：在第 1 轮审查提交 `6d812334` 之上快进 9 个提交（`fcde7046` → `cd5c3f4d`），没有合并提交。第 1 轮审查记录在 `6d812334` 与 HEAD 上逐字相同（SHA256 `20a4edf3…`，与审查人留底副本一致）。
- 改动范围（相对 `6d812334`）：产品代码只有 `contact-config-history.ts` 加了 3 行触发器；测试文件只追加 CFG13–CFG16，旧 12 条一字未改（只把 import 多引一个类型）；变异脚本的旧 M01–M15 定义逐字未变，新增 M16–M19；其余是 `docs/proof` 和收据。`scripts/`、`.githooks/`、`.github/` 未改。
- 审查人：Claude；会话 `claude:e4f44e54-3c17-49b2-9cb8-cace64ed0b43`；宿主模型名 `group/opus`。
- 辅审：hy4 辅审因线路 403 未产出，本轮无辅审。
- 环境：本机 macOS、Node v22.22.0，独立克隆 `/tmp/pr84-r2-claude/repo`；重活在云电脑 box1（Ubuntu、Node v24.21.0）`/workspace/pr84-r2/`，走 `.heavy.lock` 排队。

在本会话里运行：

```sh
node /tmp/pr84-r2-claude/repo/scripts/gates/run-all.ts --hash --repo=/tmp/pr84-r2-claude/repo --branch=feat/contact-config-history --base=origin/dev/integration
```

原样输出（= reviewed_hash，与作者报的 CONTENT_HASH 相同）：

```text
e7c1566c4b56c0841f70ffb5188161f8573b80c98c75225f02486d018c13115e
```

### R1 核销

| R1 | 核销 | 依据 |
|---|---|---|
| R1-01 历史可被原位改写 | **部分解决** | 同主键 `INSERT OR REPLACE`、文本或实数版本号的 REPLACE、`ON CONFLICT DO UPDATE`、`UPDATE OR REPLACE`、单行与整表 `DELETE` 都被拒、表内容不变（本机 Node 22 与 box1 Node 24 结果相同）。CFG13 真红 `fcde7046`、`af3bf6f1`（13 条里只有 CFG13 以 `ERR_ASSERTION` 失败）→ 绿 `b2e8070d`（13/13）复现；删掉新触发器（F9 = M16）被 CFG13 杀死。**未解决的部分**：带 `rowid` 的 `INSERT OR REPLACE` 照样改写历史，见 R2-01 |
| R1-02 回滚原子性无测试 | 已解决 | CFG14 用真 SQLite 触发器让回滚的历史写入失败，断言联系人整份文档、历史行、动作表、通知数都不变，去掉故障后同一动作号重试只追加一版，再重放不写。F6（= M17）、N2（吞掉历史写入错误照样提交）、N6（重放也发通知）都被 CFG14 杀死 |
| R1-03 回滚只验了部分字段 | 已解决 | CFG15 改全 10 个白名单字段（前后值都不同），回滚后逐字段断言。F8、M18 被 CFG15 杀死（F8 同时让 CFG13 失败）。另有两处更细的空当（N1、N5）作为建议，见第四节 |
| R1-04 落盘白名单无测试 | 已解决 | CFG16 直接读 `gg_contact_config_versions.config`，create / update / batch / rollback / baseline 五种写入都实际经过（6 行），逐行断言键集合恰为 10 个、两个中性标记不落盘、`computeAssets` 与 `computeModel` 的子键也受限。F2（= M19）、N3（只让升级基线一条路径落盘整份文档）、N7（`computeAssets` 保留全部键）都被 CFG16 杀死 |
| R1-05 收据作者来源不完整 | 已解决 | 收据 `unverifiable` 写明两段历史产出各自的会话、原生子代理与模型，以及本轮由谁改了什么；`author.session` 为宿主号、无后缀；作者选本轮直接修改者并写了理由。审查人按原生记录逐项核对一致（第六节） |

第 1 轮的观察项：O-1（回滚总做模型预检）、O-2（空修改也追加版本）、O-3（缺 `tools` 的旧文档）、O-4（下一轮生效只在 proof 里）作者已在 `docs/proof/contact-config-history/r2/README.md` 写明保留现状、不在本轮改；O-5 未动。都不阻塞。

### 一、亲自运行的结果

| 操作 | 在哪 | 实测结果 |
|---|---|---|
| `npm ci` | 本机、box1 | exit 0 |
| `npm run -s typecheck` | box1 | exit 0 |
| `npm run -s lint` | box1 | exit 0，`Checked 201 files` |
| `npm test` | box1 | exit 0，1489 条，pass 1489，fail / cancelled / skipped / todo 均为 0（第 1 轮 1485 + 新增 4） |
| 新测试文件单跑（TAP） | box1 | 16/16 |
| 收据红提交 `b92c857b` 上跑同一文件 | box1 | exit 1，0 通过、16 失败，16 条全是 `ERR_ASSERTION`。该提交只把 `recordContactConfig` 换成空操作；这是实现之后的同体回溯校准，作者已写明不是历史 TDD |
| CFG13 的真红 `fcde7046`、`af3bf6f1` | box1 | 各 13 条里 12 过、CFG13 以 `ERR_ASSERTION` 失败（`fcde7046` 为 `Missing expected exception`） |
| `b2e8070d`（触发器修复）、`f73a2d27`（恢复绿） | box1 | 13/13、16/16 |
| 作者变异脚本（M01–M19，完整 16 条判定） | box1 | 原样 16/16；19/19 被各自指定的 CFG 用例以 `ERR_ASSERTION` + `testCodeFailure` 杀死，存活 / 无效 0；源文件变异前后哈希不变 |
| 作者 proof `contact-config-history-real.ts` | box1 | exit 0，`PASS:真实Host/SQLite/service…` |
| 绕过探针 `bypass.ts` | 本机、box1 | 两地结果相同，见 R2-01 |
| `run-all.ts --local --base=origin/dev/integration`（审查前） | 本机 seatbelt | G-PROVENANCE ✓、G-TRACE ✓、G-REVIEW ✗（「审查结论是 reject」「审查对应的内容 123bb4c606a4 ≠ 当前 e7c1566c4b56」）、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓；`CONTENT_HASH=e7c1566c…`；exit 1 |
| 同一命令（填了本轮 review 之后） | 本机 seatbelt | 见第六节 |
| `GATE_SELFTEST_JOBS=2 npm run -s gates:selftest`（不经管道，直接取退出码） | 本机 | exit 0，`自检通过`，用例 219/219 |
| GitHub `self-check` | — | `cd5c3f4d` 上 COMPLETED / SUCCESS |

作者报的数字逐条对上：16 同体红 → 16 绿、19/19 变异、typecheck / lint = 0、全量 1489/1489 且 skip / cancel / todo = 0、六项机械门禁通过、G-REVIEW 待审。作者的「依赖 46/46」没有单独复跑，全量已包含这些文件。作者在 box4 用 Node 22，审查人在 box1 用 Node 24，结果相同。

### 二、必须返修

#### R2-01 · 高：带 rowid 的 INSERT OR REPLACE 仍能原位改写历史（R1-01 未解决的部分）

- 位置：`packages/server/src/contact-config-history.ts:20-27`。表的主键是 `(contact_id, version)`，但它是普通 rowid 表，另有一个隐藏的 `rowid`，也是唯一约束。新触发器只查 `(contact_id, version)` 是否已存在。
- 复现（HEAD 原样，真 Host / SQLite，`recursive_triggers` 默认 0）：

  ```sql
  -- 第 1 步：主键 ('__trash__', 1) 不存在，触发器放行；rowid 与版本 1 冲突，REPLACE 删掉版本 1，删除触发器不触发
  INSERT OR REPLACE INTO gg_contact_config_versions (rowid, contact_id, version, config, kind, restored_from, at)
  VALUES (<版本 1 的 rowid>, '__trash__', 1, '{}', 'create', NULL, '2026-01-01T00:00:00.000Z');
  -- 第 2 步：版本 1 已不存在，普通 INSERT 写入伪造的版本 1
  INSERT INTO gg_contact_config_versions (contact_id, version, config, kind, restored_from, at)
  VALUES (<联系人>, 1, <伪造配置>, 'create', NULL, '2026-01-01T00:00:00.000Z');
  ```

  两步都不报错。随后 `contacts.history` 返回的版本 1 是「伪造的版本1」、工具 `NEUTRAL_INJECTED_TOOL`；`contacts.rollback` 到版本 1 返回成功，联系人被写成伪造的名字和工具。该联系人的历史上看不出痕迹，表里只多出一行别的联系人号 `__trash__`。另开一个不经宿主的连接做第 1 步，结果相同（版本 2 被替换成版本 2000）。
- 只在 `recursive_triggers` 打开时会被删除触发器挡住（探针 G）；它默认关闭，所以和 R1-01 一样不能依赖。
- 现有测试：CFG13 只试了不带 rowid 的同主键 REPLACE，发现不了。
- 返修要求：让带 rowid 的覆盖写也被拒。两种做法审查人都实测过：（a）表改成 `WITHOUT ROWID`，此时带 rowid 的语句直接报「没有 rowid 列」，正常写入不受影响；（b）触发器条件加上 `OR rowid = NEW.rowid`，rowid 冲突时报 immutable，不带 rowid 的正常插入不受影响。用（b）时请换一个新的触发器名，或先删旧的再建：`CREATE TRIGGER IF NOT EXISTS` 不会更新已经用旧定义建好的库。在 CFG13 或新用例里断言：带 rowid 的 REPLACE 被拒；版本 1 的原行字节不变；`history` 和 `rollback` 仍用原配置。配一个对应的单点变异（换回现在的触发器），确认由具名断言杀死。先红后绿。

### 三、审查人自构的单点故障

在 box1 的独立工作树里一次改一处，跑 16 条新测试文件和作者 proof；16 条没有抓到的再跑全量 `npm test`。原样对照 16/16、proof exit 0。

| 编号 | 故障 | 16 条 | proof | 全量 | 结论 |
|---|---|---|---|---|---|
| F1 | 回滚不追加新版本（R1 原样） | CFG02、05、14、15、16 失败 | 失败 | — | 被发现 |
| F2 | 快照落盘整份联系人文档（R1 存活） | CFG16 失败 | 通过 | — | **被发现**（R1-04） |
| F3 | 回滚连带清掉游标（R1 原样） | CFG02 失败 | 失败 | — | 被发现 |
| F4 | 修改跳过版本校验（R1 原样） | CFG04 失败 | 通过 | — | 被发现 |
| F5 | 动作幂等表不持久（R1 原样） | CFG05 失败 | 失败 | — | 被发现 |
| F6 | 回滚不在同一事务（R1 存活） | CFG14 失败 | 通过 | — | **被发现**（R1-02） |
| F7 | 批量替换不在同一事务（R1 原样） | CFG08 失败 | 通过 | — | 被发现 |
| F8 | 回滚不恢复工具 / 能力 / 槽位 / 简介 / 头像（R1 存活） | CFG13、CFG15 失败 | 通过 | — | **被发现**（R1-03） |
| F9 | 删掉新加的覆盖插入触发器（R1-01 原缺陷） | CFG13 失败 | 通过 | — | **被发现**（R1-01） |
| N1 | 快照投影丢掉 `computeModel.effort` | 16/16 | 通过 | 1489/1489 | **存活** → 建议 S-1 |
| N2 | 回滚吞掉历史写入错误照样提交 | CFG14 失败 | 通过 | — | 被发现 |
| N3 | 只让升级基线一条路径落盘整份文档 | CFG16 失败 | 通过 | — | 被发现 |
| N4 | 删掉触发器、改为连接级 `PRAGMA recursive_triggers = ON` | CFG13 失败 | 通过 | — | 被发现（CFG13 显式关掉了递归触发器，所以不依赖默认值） |
| N5 | 回滚时跳过值为 `null` 的字段 | 16/16 | 通过 | 1489/1489 | **存活** → 建议 S-2 |
| N6 | 重放同一回滚也再发通知 | CFG14 失败 | 通过 | — | 被发现 |
| N7 | 快照保留 `computeAssets` 的全部键 | CFG16 失败 | 通过 | — | 被发现 |

所有「失败」都是 `ERR_ASSERTION`。第 1 轮存活的 3 个（F2、F6、F8）和 R1-01 原缺陷（F9）都被新测试具名杀死。专打新断言的 7 个里 5 个被发现、2 个存活；存活的两个 HEAD 行为都是对的，只是没有测试守住，不阻塞。

### 四、建议（不阻塞，可随 R2-01 一起补）

- S-1：没有任何测试在历史或回滚里用到 `computeModel.effort`。投影丢掉它（N1）时全量照过，后果是回滚到带 effort 的版本会丢掉 effort。建议 CFG15 的期望配置带上 `effort`。
- S-2：CFG15 回滚到的版本里 `avatar`、`computeSlots` 都是非空值，没有覆盖「回滚到一个字段为 `null` 的旧版本，要把当前值清空」。实现若跳过 `null`（N5），回滚后头像和槽位留着改坏后的值，全量照过。建议加一个回滚到 `avatar: null` / `computeSlots: null` 版本的断言。
- S-3：`reviews/contact-config-history-final-gates.txt` 是作者侧门禁输出，仍在 `reviews/` 下；第 1 轮建议挪到 `docs/proof/`，本轮未处理。

### 五、范围外的发现

`packages/adapter-sqlite/src/store.ts:28-37` 的 `events` 表（基线代码，本 PR 未改）有同样的缺口：主键 `(session, seq)`、普通 rowid 表、只有同主键的 BEFORE INSERT。审查人用同一份建表语句实测：同主键 REPLACE 被拒，但带 rowid 的 REPLACE 删掉第 1 条后，普通 INSERT 能写入伪造的第 1 条（探针 `events-rowid.ts`）。`events` 有 `prev` / `hash` 链，改写后读出时校验能发现，但写入本身不被拦。不在本 PR 范围，不作为本 PR 的返修条件，见「需拍板」。

### 六、来源核验

**填了本轮 review 之后 G-PROVENANCE 的实际输出**：`✗ 审查会话不可信:会话记录不存在:claude:e4f44e54-3c17-49b2-9cb8-cace64ed0b43`（完整输出见本节末）。原因是宿主的 `turns.jsonl` 只在一轮结束时写入，本审查会话这一轮还没结束；本轮结束后同一命令的结果会变。门禁在审查一侧先报错，作者一侧这次没有单独的输出行。

作者一侧：宿主 `codex:76d2c467` 的 `turns.jsonl` 现在有 2 轮，第 2 轮开始于 11-12 14:31 UTC，模型 `gpt-6.1-sol`；`record.json` 的 `nativeSessionId` 是 `01a1cfc8-db89-…`。门禁不读子代理的原生记录，所以另用 `~/.codex/sessions/2026/11/12/` 下的原生 rollout 逐条核（返修全部发生在这个日期的文件里，`2026/11/13/` 下与本 PR 有关的只有今晚别的审查会话读到这些提交号，不是作者）：

| 作者自述 | 原生记录里对应的调用与输出 | 结果 |
|---|---|---|
| CFG13 首红 `fcde7046` | 根会话 `01a1cfc8-db89`（`gpt-6.1-sol`），第 5596 行，18:54:50 UTC：12 条基线 12/12、13 条 exit 1（12 过 1 败），提交 `fcde7046` | 一致 |
| 夹具纠正红 `af3bf6f1`、触发器修复 `b2e8070d` | 同上，第 5611 行，18:55:37 UTC：红 13/12/1、绿 13/13，`only_three_trigger_product_lines: true` | 一致 |
| CFG14–16 `d387bef1`、校准红 `b92c857b`、恢复绿 `f73a2d27` | 同上，第 5692 行，19:00:18 UTC：红 0/16、绿 16/16、`all16_named_ERR_ASSERTION: true` | 一致 |
| 来源说明 `0131d50c` | 同上，第 5754 行，19:03:57 UTC | 一致 |
| 变异 runner `3dca25e9`，本机 M16–M19 4/4 | 同上，第 5889 行（runner 首次因 macOS `/var` 路径别名 exit 1，原样留着）、第 5937 行提交 | 一致（失败如实保留） |
| 冻结前本机门禁 | 同上，第 5971 行：六项 ✓、G-REVIEW ✗、`CONTENT_HASH=ea4eab3d…`（`3dca25e9`） | 一致 |
| box4 云端 19/19、1489/1489 | 子代理 `01a1d035-2076`（`/root/contact_history_finish`，`gpt-6.1-sol`），第 3785–3795 行下载与核验；本 PR `cloud-r2-proof.tar.gz` 归档。审查人没有登 box4（作者队列），以 box1 独立复跑为准 | 数字与复跑一致 |
| proof 提交 `cd5c3f4d` | 子代理 `01a1d035`，第 3804 行，19:35:33 UTC | 一致 |
| 最终 hash、门禁、正常推送 | 子代理 `01a1d035`，第 3811–3823 行：hash `e7c1566c…`；门禁 exit 1（只有 G-REVIEW ✗）；推送日志 `final-normal-push.log`（SHA256 `69c52f05…`）含 tests 1489 / pass 1489、`自检耗时 123s:用例 219/219`、`6d812334..cd5c3f4d  HEAD -> feat/contact-config-history`（快进），未见 `--no-verify` | 一致 |
| 交接包 | ZIP SHA256 `602189fa…`，33 个文件，`MANIFEST.json` 登记的 32 个逐一核对一致；其中 `candidate.bundle` 校验通过，两个引用为 `cd5c3f4d` / `4efdee0b`；包内 R1 审查副本与审查人留底逐字相同 | 一致 |

模型：根会话与两个子代理（`01a1d035` 收尾、`01a1d03a` `/root/loop_proof_finish` 只读定位）的 `turn_context.model` 全程都是 `gpt-6.1-sol`；父子关系按 `session_meta.source.subagent.thread_spawn.parent_thread_id` 核对。作者厂商 openai，审查厂商 anthropic。

**没有核到的：** box4 上的原始运行（作者队列，按分工不登，只核了归档与作者核验文件，并在 box1 独立复跑）；Codex 原生记录本身的真伪只能按文件内部一致性判断。

填了本轮 review（提交前）后在本机 seatbelt 跑 `node scripts/gates/run-all.ts --local --base=origin/dev/integration` 的原样输出：

```text
base=origin/dev/integration branch=feat/contact-config-history HEAD=cd5c3f4d5e91a1eedce5780d86d3567d8acfbcd3 受检文件 52 个 收据=receipts/feat-contact-config-history.json 门禁 8 个
✗ G-PROVENANCE  R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是仓库所有者对这个 PR 这一版的结构化批准
    - 审查会话不可信:会话记录不存在:claude:e4f44e54-3c17-49b2-9cb8-cace64ed0b43
✓ G-TRACE  R-06 R-08 R-15:受管改动必须有收据,条目对上验收文档,状态四选一,通过要有证据
✗ G-REVIEW  R-01:审查人限 Codex/Astra/Claude/Argon(g-group#1531、g-group#2943、g-group#3199 原则 68,默认 Codex;Claude 审 Codex 写的 PR,Argon 备用),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)
    - 审查结论是 reject
✓ G-RED  R-02:先红后绿,红提交上的测试与现在相同,现在的测试放到红提交实现上按名字失败、现在按名字通过
✓ G-STUB  R-03 R-04:空实现红基线 + 返回值变异校准,桩下或错值下仍通过、没执行、加载失败的测试都判无效
✓ G-TAUTO  R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、自比较、恒真、不可达、不判源码结果、skip/only;运行时与静态逐条计数一致)
✓ G-WORKFLOW  R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限、不得写提交状态、不得用 pull_request_target
✓ G-LAYER  插件化:包分层只能向下依赖,插件互不依赖,禁止相对路径跨包(import 与依赖声明都查)
CONTENT_HASH=e7c1566c4b56c0841f70ffb5188161f8573b80c98c75225f02486d018c13115e
exit=1
```

除 G-PROVENANCE（本轮会话记录尚未写出）与 G-REVIEW（结论 reject）外，其余 6 项通过；`CONTENT_HASH` 与审查前相同。收据里第 1 轮的 review 原样保留在 `review.history`（门禁只把 `review` 整个排除在内容 hash 外，放在顶层会改变 hash）。

### 七、需拍板

- `events` 表的同类缺口（第五节）是否另开一个小片修。建议另开：改法与 R2-01 相同、改动很小，但它动的是基线的存储适配层，不该混进 U07 这一片。不修的话，「事件只追加」在有库写权限的代码面前同样不成立（读出时哈希链能发现，写入不拦）。

### 八、返修与重新送审

只需修 R2-01（S-1、S-2 可顺手补）。改了受管文件后内容 hash 会变，本轮结论作废，需要第 3 轮审查。第 3 轮只核 R2-01 和随之改动的测试，R1 已解决的各项不再重开，除非返修改动波及。

### 证据

本机：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr84-r2-claude/`（box1 日志包、自构故障脚本与逐项结果、绕过探针与两地输出、两种修法的验证、`events` 表探针、审查前后两次 `--local` 输出、本机自检日志、原生记录调用索引）。
