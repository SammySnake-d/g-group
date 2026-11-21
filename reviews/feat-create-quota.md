# PR #87 · Q04 / U08–U09 创建时持久化个人与群临时额度（create-quota）独立审查

## 第 1 轮

### 结论：reject

作者报的数字全部复现一致，产品行为在审查方实测里也都对：创建额度同事务落盘、重启不丢、同号改参冲突、失败不发通知。拒绝的原因是本片标题和 README 声称守住的四类行为，测试实际守不住：审查方 15 个单点故障里有 8 个在本片 13 条测试下存活，跑全量（1490 条包测试）也存活（R1-01 到 R1-04 要返修）。只需补测试，不需要改产品代码。审查人没有改产品代码、测试，也没有改收据的作者字段。

- 对象：`feat/create-quota` `852e0f89357caa5b2ab0caf1c910069e621837bd`（开工时与 11-13 23:21 续审时两次回读远端，未变）。PR 仍为 draft，GitHub `self-check` SUCCESS。
- 基线：开工时 `origin/feat/contact-config-history` 为 `3cfabba2978e3b617a07c86b962eba5fd8e4d411`。续审时它已前移到 #84 第 2 轮返修 `cd5c3f4d5e91a1eedce5780d86d3567d8acfbcd3`（`3cfabba2` 的后代，另有审查）。merge-base 仍是 `3cfabba2`，所以内容 hash 不变。本轮只审 `852e0f89`，返修对本片的影响见第 7 节。
- 审查人：Claude；会话 `claude:225d4b4a-0b47-4cfa-bbeb-3460d6f8db1c`；本会话原始记录（`turns.jsonl`）里的模型是 `group/opus`（Anthropic）。作者是 Codex / `gpt-6.1-sol`（OpenAI），属跨厂商审查，不使用豁免。
- hy4 辅审因线路 403 未产出，本轮无辅审。
- 合同：`origin/docs/dev-handbook` `ff5bd712`（需求文档、验收文档 v0.1）；标「候选」的条目不作依据；输入合同按 g-group#2662。
- 我在自己的会话里，于独立克隆 `/tmp/pr87-r1-claude/repo` 运行：

```sh
node /tmp/pr87-r1-claude/repo/scripts/gates/run-all.ts --hash --repo /tmp/pr87-r1-claude/repo --branch feat/create-quota --base origin/feat/contact-config-history
```

原样输出如下，与作者报的 CONTENT_HASH 一致：

```text
43b9409e768583b0094a9da19c14e6d4a4f96313bced53392ef82194cf19faeb
```

### 1. 范围与改动构成

32 个文件，+4131/−35，构成如下：

| 类别 | 文件数 | 行数 |
|---|---|---|
| `docs/proof/create-quota/` 证据（含 3 个二进制归档） | 24 | +3516 |
| `packages/server/proof/` 脚本：变异执行器、变异登记、真实 SQLite proof；不进套件 | 3 | +236 |
| 新测试 `create-quota.test.ts`（CQ01–CQ13） | 1 | +293 |
| 收据 | 1 | +27 |
| 产品：`api-contract/src/api.ts`、`server/src/host.ts`、`server/src/service.ts` | 3 | +59/−35 |

产品改动只有三处：
- 合同：`contacts.create.computeSlots` 与 `rooms.createGroup.tempComputeSlots` 复用更新接口的范围（个人 null 或 1..64，群 0..64）。
- 宿主：新增 `createOnce`，把实体、额度、首版历史和动作结果放进同一个 SQLite 事务，通知在提交后发出。
- service：建群把 options 转给宿主。

没有改 QuotaTable、释放算法和前端，未越界。顺带的行为变化有两条，作者都写明了：两个创建接口开始按 `clientActionId` 幂等（以前同号会建出第二个实体）；建群时总会写一份 `room-slots` 文档（缺省 0）。

需求核对（`docs/spec/需求文档.md` 第 191–192、303–304 行；`验收文档-v0.1.md` 第 139 行）：
- U08「创建联系人时定 compute 额度，可手动或经 helper 改」：创建时设定已做到。手动修改走既有的更新接口。经 helper 改不在本片，作者写明 Helper 没有创建入口（依赖 #64/Q13），如实。
- U09「群可设临时 compute，用完必须归还」：建群时设定已做到。归还语义沿用既有租约，CQ12/CQ13 用受控适配器验证。
- 收据里 AC-23 标「未测」，理由写明完整链未闭合（真实 CLI 子进程、前端、Helper 前置均未测），没有被说成整项通过，如实。R-02 标「通过」，核对见第 2 节。

### 2. 先红后绿

在原生记录里核对了时间（UTC，见第 6 节）：
- 最初的红先于产品补丁。`3829905`（15:23:22）CQ01 单条红，`undefined !== 2`，`ERR_ASSERTION`。`52ae81a`（15:26:30）冻结 13 条，全红。`0b5bd6c`（15:28:37）是成员顺序校准后的同体红，13 条都是具名断言失败。
- 产品补丁 `7fee2c5`（15:29:07）落地后 13/13 绿。
- 收据登记的红 `069bbd2` 是加强 CQ03/CQ04「合法边界真的落盘」之后的回溯红：这个提交把三个产品文件还原成基线原字节，下一个提交 `8c3d078` 再原样恢复。作者在提交说明、README 和收据里都写明它是回溯校准，没有冒充先于实现，如实。

我在 box1 上用 `069bbd2` 的工作树复跑：
- `@g-group/api-contract` 的 realpath 落在红工作树本身，测试文件 SHA256 `92173f61…` 与 HEAD 相同。
- 结果 exit 1，13/13 `not ok`，13 个都是 `ERR_ASSERTION`，没有加载错误或语法错误。
- HEAD 上 13/13 通过。

### 3. 亲自复现的结果

重活都在 box1 的 `/workspace/pr87-r1/` 跑（Node v24.21.0，走 `/workspace/.heavy.lock` 排队，变异串行）。`--hash`、seatbelt 门禁和应失败输入在本机跑（Node v22.22.0）。

| 项目 | 实测 |
|---|---|
| `npm ci` | exit 0 |
| `npm run typecheck` / `npm run lint` | 0 / 0（biome 检查 203 个文件） |
| CQ01–CQ13（HEAD） | 13/13；fail/cancelled/skipped/todo 全为 0 |
| `npm test`（HEAD） | exit 0；1498/1498，fail/cancelled/skipped/todo 全为 0 |
| `npm test`（基线 `3cfabba2`） | exit 0；1485/1485。1485 加本片 13 条等于 1498，数对得上 |
| 作者 `create-quota-mutations.mjs` | exit 0；原样副本 13/13；17/17 被预登记的具名测试以 `ERR_ASSERTION` 杀死，存活或无效 0 |
| 作者 `create-quota-real.ts`（真实 Host/service/SQLite，无模型） | exit 0 |
| `run-all.ts --local`（本机 seatbelt，审查前） | exit 1。G-PROVENANCE ✓（review 为空，直接返回）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓ |
| 门禁自检 `gates:selftest`（本机） | 219/219，exit 0 |
| 门禁自检（box1） | exit 1：box1 既没有 `GATE_SANDBOX_IMAGE` 也没有 sandbox-exec，需要沙箱的用例报「没有可用沙箱」。这是环境原因，不是本片问题 |

**G-RED、G-STUB、G-TAUTO 的第一次有效结果**：上表本机 seatbelt 那一行，三项都实际执行了测试，均判通过。作者私聊 #3108 报的 seatbelt 结果与此一致。作者原生记录里还有 17:02Z 的一次本机 `--local`，日志 sha `b70fb3cb…` 与 #3108 附件相同，结论也相同。box4 Docker 那条线（overlay 挂载 `invalid argument`、0 项测试启动）是基础设施问题，我没有碰。

### 4. 每个门禁一个应失败输入

都在一次性副本 `/tmp/pr87-r1-claude/neg` 里提交，不推送。每个输入跑一次本机 seatbelt `--local`。

| 门禁 | 输入 | 判定 |
|---|---|---|
| G-TRACE | 收据里「通过」条目的证据指向不存在的文件 | ✗「R-02 的证据 … 不在仓库里」 |
| G-REVIEW | 审查人与作者同为 codex | ✗「审查人与作者是同一个」 |
| G-PROVENANCE | 审查会话 `claude:00000000-…` 不存在 | ✗「会话记录不存在」 |
| G-RED | `red.commit` 改指向绿提交 `8c3d078` | ✗ 13 条「放到红提交的实现上没有按名字失败」 |
| G-TAUTO | 加一条 `assert.equal(1, 1)` | ✗ 恒真断言、自比较、没有判被测源码结果 |
| G-STUB | 加一条只调用本地假对象的测试 | ✗「换成空桩后没有按名字失败」 |
| G-WORKFLOW | 加一个 `pull_request_target` 工作流 | ✗ |
| G-LAYER | 让 domain 层 import `@g-group/server` | ✗「domain 层 … 不能依赖 app 层」 |

另有一条门禁观察，不算本片问题：一条只断言 `typeof (await svc.handle(...)) === "object"` 的新测试，G-STUB 和 G-TAUTO 都没有判失败，只有 G-RED 因为它在红提交上不红而判失败。见第 8 节。

### 5. 审查方单点故障

每个故障只改变异副本里的产品代码，`@g-group/*` 依赖都指到副本本身。原样副本 13/13，探针跑完后恢复原样，再跑仍是 13/13。本片测试没发现的故障，再跑全量包测试（`packages/**/*.test.ts`，1490 条）和作者的 `create-quota-real.ts`。脚本是 `reviewer-probes.mjs`，结果见证据目录。

| 编号 | 故障 | CQ01–13 | 全量包测试 | 作者 proof |
|---|---|---|---|---|
| P01 | 群额度文档在创建事务提交后才写 | 杀死（CQ02/04/06/11） | — | — |
| P02 | 联系人首版历史在创建事务提交后才写 | **存活** | **存活**（1490/1490） | 通过 |
| P03 | 宿主启动时把所有群临时额度重置为 0 | **存活** | **存活** | 通过 |
| P04 | 宿主启动时把所有个人额度重置为默认 | 杀死（CQ07） | — | — |
| P05 | 建群重放不比对群名 | **存活** | **存活** | 通过 |
| P06 | 建联系人重放只比对名字和额度 | **存活** | **存活** | 通过 |
| P07 | 联系人通知在事务提交前发出（失败也通知） | **存活** | **存活** | 通过 |
| P08 | 建群通知在事务提交前发出（失败也通知） | **存活** | **存活** | 通过 |
| P09 | 群额度取所有群里的最大值（串群） | 杀死（CQ12） | — | — |
| P10 | 群额度为 0 时按 1 算 | 杀死（CQ12） | — | — |
| P11 | 配置回滚不带回个人额度 | 存活 | 存活 | **失败**（`create-quota-real.ts:41`，`1 !== 2`） |
| P12 | 建群不再核对联系人成员是否存在 | **存活** | **存活** | 通过 |
| P13 | service 建群不转发动作号 | 杀死（CQ08/09） | — | — |
| P14 | 联系人创建重放时再发通知 | 杀死（CQ07） | — | — |
| P15 | 首次创建成功后不发任何通知 | 存活 | 被发现（见下） | — |
| P16 | 建群重放把当前群额度写回创建时的值 | 杀死（CQ08） | — | — |
| P17 | 建联系人重放把当前个人额度写回创建时的值 | 杀死（CQ07） | — | — |

P15：全量跑出 exit 1，但输出在第 562 条处截断，两次都是这样。我推测是 `test-runner.ts` 失败时先写管道、随即 `process.exit` 导致截断，没有单独验证。在本机单文件复核：`start.test.ts`（「startServer(fake) + bindIpc…」）和 `announcements.test.ts`（「两条公告并存…」）都按名字失败。所以 P15 已被既有测试守住，不算缺口。

我在 HEAD 上（不改代码）用 `reviewer-behavior.ts` 观察了真实行为，结果写在 `behavior.json`：
- 首版历史插入失败（触发器注入）时：联系人、历史、动作都是 0 条残留，没有通知；修复后同号重试成功，只发一次通知。
- 建群额度落盘失败时：没有通知；首建发一次通知，重放不再发。
- 重启后，个人额度 5 和群额度 7 都原样保留。
- 同号改人设、简介、名字、额度、说话模型、群名，都返回 `conflict`。
- 成员不存在时返回 `not_found`，没有残留。

**结论**：存活的故障对应的产品行为本身都是对的，问题出在测试没有守住它们。

### 6. 来源核验

**G-PROVENANCE 在填审查前后判什么**
- 审查前，review 为 null，门禁直接返回 ✓，等于没有核。
- 在一次性副本里填上本收据的 review 字段（agent claude、本会话、`group/opus`、reject、`43b9409e…`）后再跑 `--local`（基线已是 `cd5c3f4d`）：G-PROVENANCE ✓，G-REVIEW ✗「审查结论是 reject」，其余六项 ✓。填 review 不改变内容 hash（仍是 `43b9409e…`）。
- 它实际核到的范围：
  - 作者会话按收据 `author.session` 读 `~/.mirasim/sessions/codex/76d2c467-…/turns.jsonl`（2 轮、638 次工具调用，模型都是 `gpt-6.1-sol`），只确认其中有 OpenAI 模型对本仓库的操作。
  - 审查会话里有一次干净的 `run-all.ts --hash`，输出等于 reviewed_hash，那一轮的模型是 Anthropic。
- 它不核对的：红、绿、变异、推送这些命令是否真的跑过；也不读 Codex 原生记录和子线程链。

**我用原生记录替代核到的部分**
- 接手链：`codex:534f3614`（原生 `01a1cfc5`，接手自 `claude:dd154965`）→ `codex:76d2c467`（`record.json` 中 `nativeSessionId=01a1cfc8-db89-7400-b3de-876bd8478982`）。
- 真正跑出本片的会话是 `01a1cfc8` 派生的子线程 `01a1d035-2076-7443-bb9f-062b74f98187`：
  - 首行 `session_meta.source.subagent.thread_spawn.parent_thread_id=01a1cfc8…`，`agent_nickname` 为 Euler，开始于 14:41:45Z。
  - 76 个 `turn_context` 的模型全是 `gpt-6.1-sol`，与收据 `author.model` 一致。
  - 交接里举的 `01a1d03a`、`01a1d043` 是同一父线程下做其他片的子线程，只引用过本片的提交号。
- 在 `01a1d035` 里按 `call_id` 配对 `function_call` 和 `function_call_output`，逐项对到下表。

| 作者声称 | 原生记录中的命令与输出（UTC） |
|---|---|
| 10 个提交 | `git commit` 输出依次出现 `3829905`（#126 15:23:22）、`52ae81a`（#128）、`2a22fd4`（#129）、`0b5bd6c`（#132）、`7fee2c5`（#133 15:29:07）、`c371b71`（#144）、`069bbd2` 与 `8c3d078`（#177 15:48:59）、`e1b91fc`（#179）、`852e0f8`（#263 17:00:07），与远端历史逐个相同；提交时间（+08:00）也对得上 |
| 红 → 绿 | CQ01 红 `exit=1`、`undefined !== 2`、`ERR_ASSERTION`；13 条冻结红；首绿 12/13（CQ02 成员顺序）；校准后 13 条具名断言失败；绿 13/13。原文都在输出里 |
| box4 云端 | #198 准备回执：`head e1b91fc…`、bundle sha `508d2a39…`，等于 `cloud-source-freeze.json`。#228 归档 sha `76303e17…`，等于仓库内 `cloud-behavior-raw.tar.gz` 的实测 sha。冻结输入的 8 个文件 SHA256 与 HEAD 逐个相同，`e1b91fc` 到 `852e0f8` 之间只改了证据和收据 |
| 17/17 变异与 1498 | #241/#242 读回的变异报告是 17/17；各变异波及其他判据的数量与 README 表逐项一致；full 1498/1498。我解开仓库里的归档复核，结果相同 |
| Docker 阻断 | #256 读回 `runNodeTests` 返回 `exitOk:false`、overlay `invalid argument` |
| 正常推送，钩子未绕过 | #272/#274：`git push -u origin feat/create-quota` exit 0；`GIT_TRACE` 中有 `run_command: .githooks/pre-push`；219 个门禁用例全部通过、1498；`* [new branch]`。全部命令里没有 `--no-verify`（只出现在技能说明文字里），也没有 `--force` |
| 内容 hash | #265 17:02 与 #278 的输出都是 `43b9409e…` |

### 7. #84 第 2 轮返修（`cd5c3f4d`）对本片的影响

- `3cfabba2..cd5c3f4d` 共 10 个提交。产品只改了 `contact-config-history.ts`，加了一个禁止覆盖已有历史版本的触发器；其余是测试、变异脚本和证据。
- 在一次性副本里把 `852e0f89` 与 `cd5c3f4d` 试合并：无冲突。合并树上 `create-quota.test.ts` 13/13，`contact-config-history.test.ts` 16/16。本片创建时写的历史版本号恒为 1，新触发器不影响它。
- 合并后，P11（回滚不带回额度）被 #84 的 `CFG15 R1-03 回滚恢复每个白名单字段…` 按名字杀死。见 R1-05。
- 内容 hash 与门禁结论不受基线前移影响（merge-base 仍是 `3cfabba2`）。合并前要按最新基线重跑。

### 问题清单

**R1-01（需返修）联系人首版历史与创建同事务，没有测试守住**
- 位置：`create-quota.test.ts` 的 CQ01/CQ10；`host.ts` 第 602–603 行。
- 复现：把 `recordContactConfig` 挪到事务提交后执行（P02）。CQ01–13、全量 1490 条、作者 proof 全部通过。CQ10 的故障注入点是 `actions` 插入，排在历史写入之后，所以测不到历史写入失败时的回滚。
- 返修要求：加一条具名测试，在 `gg_contact_config_versions` 插入处注入失败。断言联系人、额度、历史、动作都是 0 条残留，且没有 `contact.updated`；修复后同号重试只建出 1 个联系人、1 个历史版本。

**R1-02（需返修）群临时额度跨重启不被重置，没有测试守住**
- 位置：`create-quota.test.ts:138` 的 CQ08。
- 复现：宿主启动时把所有 `room-slots` 重置为 0（P03），全部存活。原因是 CQ08 在重启前已经把群额度改成 0，作者 proof 也停在 0，所以「重置成 0」和「正确保留」区分不开。个人额度有 CQ07 守住（P04 被杀死）。
- 返修要求：创建非零群额度（例如 3），不改动，重启后断言 `roomView().tempComputeSlots` 和 `room-slots` 文档仍是 3。

**R1-03（需返修）同号改参冲突只覆盖部分字段**
- 位置：CQ07、CQ08。
- 复现：建群重放不比对群名（P05）、建联系人重放只比对名字和额度（P06），都存活。CQ07 只改了额度和名字，CQ08 只改了额度和成员。
- 返修要求：CQ08 加改群名的冲突用例。CQ07 至少加人设、简介、`speakingModel`、`computeModel` 各一个冲突用例，或者对请求的每个字段逐一改值断言 `conflict`。每个用例都断言实体数不变。

**R1-04（需返修）「通知只在首次创建提交后发出」没有测试守住**
- 位置：CQ10、CQ11。
- 复现：把 `contact.updated` 或 `room.updated` 移进事务里发（P07、P08），失败回滚时也会发出通知，全部存活。CQ10 和 CQ11 没有订阅事件。
- 返修要求：CQ10 和 CQ11 订阅事件流。失败时断言 0 条对应通知；修复后同号重试成功，断言恰好 1 条。

**R1-05（随 #84 返修消除）回滚带回个人额度，只有 proof 脚本断言**
- 在 `852e0f89`（基线 `3cfabba2`）上，P11 只被 `packages/server/proof/create-quota-real.ts:41` 发现。这个脚本不在 `npm test` 里，也不在门禁里。
- 与 `cd5c3f4d` 合并后，#84 的 CFG15 按名字守住了它。
- 返修要求：rebase 到 #84 最新版后，重跑 create-quota、contact-config-history 和变异。不需要另加测试。

**R1-06（建议）建群时联系人成员存在性校验，全仓库没有测试**
- P12 在全量下存活。这是基线就有的缺口，本片把这段校验挪进了 `createOnce`。真实行为正确（`not_found`，无残留）。
- 建议在 CQ04 或 CQ11 加一个成员不存在的用例，并断言无残留。单凭这一条不拒绝。

**R1-07（需改文字）README 与 HANDOFF 说「ContactView 既有投影不含 computeSlots」，与实测不符**
- 实测 `contacts.create` 和 `contacts.get` 返回的 ContactView 都带 `computeSlots: 2`；缺省时带 `null`。见 `packages/api-contract/src/entities.ts:78` 与 `host.ts:668` 的 `contactView`。
- 返修要求：改正 README 这句话。

**观察（不作返修要求）**
- 直接调用 `Host.createContact` / `createGroup` 不校验额度：0、−1、999、1.5 都会原样存下。只有 service 层合同校验；现有内部调用方（cli、drive）不传额度。
- 等价写法被判为不同请求：建群时省略 `tempComputeSlots` 与显式写 0，同号会判 `conflict`。客户端原样重发不受影响。
- 删除联系人后，用同号重放创建会返回原响应（已删除的那个联系人）。这符合幂等语义。

### 8. 门禁观察（不算本片，供门禁负责人参考）

- G-PROVENANCE 只读收据 `author.session` 的宿主 `turns.jsonl`，不读 Codex 原生记录和子线程链，也不核对红、绿、变异、推送是否真的跑过（见第 6 节）。
- G-RED 的红快照把 `node_modules` 链回仓库根目录（`scripts/gates/lib.ts` 第 324–325 行）。`@g-group/*` 的相对链接会解析回当前 HEAD 的 `packages/`，所以跨包导入在红快照上读到的是绿实现。作者的 `gate-inherited-api-identity.json` 记录了这一点，我读代码确认一致。
- 第 4 节那条「只断言 `typeof` 为 object」的测试，G-STUB 和 G-TAUTO 都没有判失败。

### 需拍板

1. G-PROVENANCE 是否改为沿「宿主会话 → `nativeSessionId` → 派生子线程」读 Codex 原生记录，并核对红、绿和推送命令。改门禁要用户点头，本轮没有改。
2. G-RED 跨包解析、G-STUB 对 `typeof` 断言漏判，是否另开门禁修复片。

### 证据

本机 `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr87-r1-claude/`，包括：box1 全部原始日志（`box1/ev.tgz` sha `d7344873…`、`box1-pass2/ev2.tgz` sha `09e5746e…`）、seatbelt 门禁日志、8 个应失败输入的日志、探针脚本与 `behavior.json`、P15 单文件复核、试合并结果、原生记录配对摘要。
