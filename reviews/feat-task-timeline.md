# PR #92 · 任务时间线（只追加任务事件记录）独立审查

## 第 1 轮

### 结论：reject

本轮是跨厂商独立审查（作者 Codex `gpt-6.1-sol` / OpenAI，审查 Claude `group/opus` / Anthropic），**不是 D21 第 1 项验收通过**。作者报的数字我在独立克隆和云电脑上全部复现成立，事务边界、只读、分页、重启、不倒推旧历史这几条也站得住；拒的原因是两件：一处「谁发起」实际记错（R1-01），以及现有 13 条测试对「状态变化」「谁发起」的大部分写点没有判别力（R1-02），自构 21 个单点故障里 13 个存活。

- 对象：`origin/feat/task-timeline` `e85396d6130cffb5c03d42c15cbb48e27aad6879`（开工与写审查前两次回读远端均未变）。
- 基线：`origin/feat/runtime-config` `272b1b5d77bd95f34467a5aa04d0bf5891355887`（PR #77 分支，不是 dev/integration）。只审 #92 相对 #77 的差异，#77 自身问题不在本片。
- 合同：`origin/docs/dev-handbook` `ff5bd71` 的 `docs/spec/需求文档.md` U80、D21 第 2 节、第 3 节表第 1 项（「任务事件记录：谁发起、派给谁、接续、状态变化，只追加」，内置 P0，对应 AC-05/07/16/28）、第 6 小节（P0 只做底座数据，不做视图）。
- 审查会话：`claude:c33bfa6f-8807-43b2-a0f6-a7fa1fd4b64a`，原生记录模型 `group/opus`。hy4 辅审因线路 403 未产出，本轮无辅审。
- 在本会话单独运行（第二次用门禁可识别的 `--repo` 形式，见第 6 节）：

```sh
node /tmp/gg-pr92-r1/scripts/gates/run-all.ts --hash --repo /tmp/gg-pr92-r1 --branch=feat/task-timeline --base=origin/feat/runtime-config
```

原样输出（与作者报的 CONTENT_HASH 一致）：

```text
5b27ebe6ceb16782df0520dfedc89935b74ac1c0a884a45e41f24cff1b6e0a91
```

### 1. 复现结果（全部亲自运行）

重活在云电脑 box1（`/workspace/pr92-r1/`，走 `/workspace/.heavy.lock` 排队，跑测试时去掉代理变量，Node v24.21.0）；本机只做 git、`--hash`、seatbelt 下的 `--local` 和门禁负例。

| 项 | 实测 |
|---|---|
| `npm ci`（HEAD / 红 49cd32c / 真实缺陷红 f8fac8d 三个工作树） | 均 exit 0 |
| `npm run -s typecheck` / `npm run -s lint` | exit 0 / exit 0（Checked 206 files） |
| 13 条（task-timeline + task-timeline-origin）在 HEAD | 13/13 通过，fail/cancelled/skipped/todo 0 |
| 同 13 条在红提交 `49cd32c` | 13/13 失败，13 条全是 `ERR_ASSERTION` 业务断言失败；红提交上两份测试文件 SHA256 与 HEAD 逐字节相同（`15318477…`、`60380048…`） |
| TT12/TT13 在 v1 产品 `f8fac8d` | 2/2 按名 `ERR_ASSERTION` 失败（真在修复前红） |
| 依赖回归 manual-task / intent / model-turns | 33/33 |
| 全量 `npm test --silent` | 1499/1499，skip/cancel/todo 0，exit 0 |
| 作者 24 个具名变异（`task-timeline-mutations.py` 原样） | 24/24 被预绑定的具名测试以 `ERR_ASSERTION` 杀死，源码封存不变 |
| 门禁自检 `node scripts/gates/run-all.ts --self-test`（不经管道） | exit 0，219/219，「自检通过」 |
| 本机 seatbelt `--local --base=origin/feat/runtime-config`（填审查前） | G-PROVENANCE ✓（review=null 短路）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓，exit 1 |
| GitHub `self-check`（只查一次） | COMPLETED / SUCCESS（run 43284020454，2026-11-12T19:00:47Z） |

**G-RED 实际怎么判**：门禁只核「红提交上的测试与现在相同、放到红提交实现上按名失败、现在按名通过」。收据 `red.commit=49cd32c` 是实现完成、actor 修复之后另开副本、在空流实现上放入终版 13 条测试造出的**回溯**红祖先，再用内容不变的普通 merge（`f25a1df`）挂进历史。门禁分不出回溯红与先红后绿，所以 G-RED ✓ 不能当 TDD 顺序的证据。作者在收据 notes 与 `docs/proof/task-timeline-v3/README.md` 里如实写明「13 条最终红是事后回溯校准，只有 TT12/TT13 两条真在修复前红」，与原生记录一致（见第 4 节），这一点不算问题。

**v2 那次真实 G-TAUTO 失败**：v2（`55dcef2`）在受支持的 seatbelt 下 G-TAUTO 判 TT01/TT03/TT04/TT05/TT07/TT08「没有一条断言判的是被测源码的结果」，原因是这六条经 `scene()` 帮手里的 `s.svc` 取结果，门禁的数据流看不穿。v3（`c785265`）在这六条里各加一行 `const svc = createService(s.host)` 并把 `s.svc` 换成 `svc`。我把该提交的测试差异把 `s.svc` 归一成 `svc` 后，删除行与新增行全部一一配对，只剩每条新增的那行构造和一行注释；断言、期望值、具名测试都没动。原来的 `s.svc` 本来就是同一个真实 Host 上的 `createService`，所以这是让门禁看见已有的真实数据流，不是补假断言，也不是削弱。

### 2. 逐条核对作者边界

| 边界 | 结论 | 依据 |
|---|---|---|
| 事件与状态写入同一事务、只在现有写点接 | 守住 | 唯一 INSERT 在 `task-timeline.ts:25`；调用点：`stepTaskTx`（applyTask→putDoc 之后一行）、新建任务初始 putDoc（ManualCreate / ContactDispatch / RerunCreate 各一行）、`recordTurnTx`、`saveTaskTx`、`putFollowTx`。事务探针：在副本里给 `append` 加「不在事务中就记一行」，跑 `packages/server/src/*.test.ts` 共 312/312，1668 次追加全部 `isTransaction=true`，0 次在事务外 |
| host.ts +42/−24 有没有超出「加一行调用」 | 行为上守住，接缝比要求宽（R1-06） | 24 行删除全部是同一行加参数后重写：`claimForTx` 加 `cause`、`stepTaskTx` 加 `origin`、`putFollowTx`/`saveTaskTx` 改成必填 `cause`，因而 14 个既有调用点每处改一行；`recordTurnTx` 把一行 putDoc 拆成两行。没有改状态迁移、没有挪事务边界、没有新开旁路，也没有触发器 |
| 不从当前任务文档倒推历史 | 守住 | 读取接口无写（TT06 用 `total_changes()` 钉住）；旧任务读出空页，第一条是新发生的动作（TT09、M22） |
| 只读接口、权限、keyset 分页、重启 | 守住 | 只读 + 当前成员校验（TT07/M16）；游标绑定任务 id、规范 base64url；同时间戳多条按 id 分页无漏无重（探针 P7 页 [1,2]/[3,4]）；`AUTOINCREMENT` 删尾行后重启不复用序号（探针 P6：删 id 2 后新事件取 3） |
| 「谁发起」取自真实账本、不写死 | **未守住一处**（R1-01） | 见下表 |
| 只追加：无改写/删除路径 | 代码路径守住；存储层无保护（R1-05） | 全仓除 INSERT/SELECT 外没有任何语句碰 `gg_task_events`；没有任务删除路径（无 `DELETE FROM docs`）；回滚只会连同状态一起回滚未提交的事件（TT08/TT11）。但表上没有 BEFORE UPDATE/DELETE 保护，裸 `UPDATE`、`INSERT OR REPLACE`、`DELETE` 都能成功（探针 P6） |
| 界面不在本片、未闭合项标注如实 | 如实 | 收据 AC-02「未测」，unverifiable 写明完整 AC-02、真实模型/CLI/UI、摘要插件、外部 resume 后 DB 故障未证明；Mind/Compute 为受控替身、Host/service/SQLite 为真 |

各写点 actor 实际来源（逐个读代码并用探针核对）：

| 动作 | 记成 | 判断 |
|---|---|---|
| 用户手动新建 ManualCreate / 新建并指派 ManualCreateClaim / 指派 ManualAssign | user（本机用户） | 对 |
| 联系人派活 ContactDispatch 与其 Claim | contact | 对 |
| 手工重跑 RerunCreate/RerunClaim | user；自动重跑复用 `plan.event.initiator`（contact） | 对（v2 已修，TT13） |
| 用户停止（/stop、卡片取消、tasks.cancel、回退、移出群时停任务） | user | 对 |
| 联系人停止 | contact（显式 origin） | 对（v2 已修，TT12） |
| 用户通过/退回 UserAccept/UserReject/Amend | user（`event.by`） | 对 |
| **用户本人豁免审查 Review（`waiverBy` 有值）** | **`{kind:"contact", id:<用户号>}`** | **错，R1-01** |
| 真实审查联系人 Review | contact | 对 |
| HumanReply（卡片、授权本人答复、联系人转达提出者答复） | user=requester | 可接受（答复人确是提出者） |
| 联系人交付 SubmitForReview | null | 丢了发起者，R1-03 |
| Dispatch / ExecFailed / StoppedConfirmed / NeedHuman / DeliveredCard / ProducerModelAdded（系统迁移：超时、失败、恢复、确认） | null | 对（系统触发，没有写死成用户） |
| 改条件 FollowUpAmend、改挂 RebindTaskOut/In（saveTaskTx） | 本机用户 | 可接受（单用户宿主）；FollowUpReceived 用 `src.sender.id`，两处取法不一致 |

### 3. 问题清单

#### R1-01（阻断）用户本人豁免审查被记成「联系人」，id 是用户号

- 位置：`packages/server/src/task-timeline.ts:39` `eventActor` 对 `Review` 一律返回 `{ kind: "contact", id: event.reviewerId }`；而 `host.ts` 的 `decideDeliveryTx`（3861 行附近，T5 下用户通过）与 `acceptCodeTaskTx`（2071 行附近）都以 `reviewerId: by, waiverBy: by` 发出 Review，`by` 是用户号。联系人转达的验收结论（`verdict` 动作，`src.sender.id`）走同一条路。
- 复现：`probes/zz-probe.test.ts` P1——带负责人新建 → Compute completed → 联系人 deliver → `tasks.accept`。时间线第 8 条 `cause:"Review"` 的 actor 为 `{"kind":"contact","id":"probe-user-1"}`（`probe-user-1` 是本机用户号），断言「用户豁免审查应记成用户」以 `ERR_ASSERTION` 失败。这是 v1 TT-RO-01（联系人记成用户）的反向同类错误：时间线里凭空出现一个 id 等于用户号的「联系人」。
- 返修要求：`waiverBy` 有值时 actor 记 `{kind:"user", id: waiverBy}`，没有时仍记审查联系人；补具名测试覆盖交付卡通过、`tasks.accept`、联系人转达的验收结论三条入口，以及真实审查联系人通过/退回的对照。

#### R1-02（阻断）13 条测试对「状态变化」「谁发起」的多数写点没有判别力

需求第 1 项要的四样里，「状态变化」和「谁发起」是主体；作者的 24 个变异全杀，但它们只覆盖作者自选的写点。我在 HEAD 的 `git archive` 副本上逐个注入 21 个单点故障，只跑作者的 13 条（脚本 `scripts/faults.py`、`scripts/sweep.py`，box1 实跑，前后对照 13/13 绿）：

| 编号 | 故障 | 结果 |
|---|---|---|
| F01 | `saveTaskTx` 不记任务事实（改条件、改挂两侧都丢） | 存活 |
| F02 | 同上 actor 改成 null | 存活 |
| F03 | 用户通过/退回/改条件（UserAccept/UserReject/Amend）记成联系人 | 存活 |
| F04 | HumanReply actor 丢成 null | 存活 |
| F05 | 联系人自己认领（Claim）记成提出者用户 | 存活 |
| F06 | 每次状态迁移写出两条相同事件 | 存活 |
| F12 | 用户补充 FollowUpReceived actor 丢成 null | 存活 |
| F13 | 游标改成含边界（`id >= ?`，页间重复） | 只靠 TT06 的 `while (cursor)` 死循环挂到 120 秒超时才暴露，没有具名断言 |
| F15 | 新一轮开始 RoundStarted 不记 | 存活 |
| F16 | 系统判定的执行失败 ExecFailed 不记 | 存活（TT02/TT09 的 `every(...)` 对空数组恒真） |
| F17 | 交付验收链 SubmitForReview/Review/DeliveredCard/UserAccept/UserReject/Amend 整段不记 | 存活 |
| F18 | 受阻提问与答复 NeedHuman/HumanReply 不记 | 存活 |
| F19 | Dispatch/ExecFailed/StoppedConfirmed 的 actor 写死成用户 | 存活 |
| F20 | 补充事实的前态 before 写成 null | 存活 |
| F07 F08 F09 F10 F11 F14 F21 | 旧尝试重复补记、联系人派活创建漏记、只把 RerunClaim 写死成用户、重跑创建漏记、续接轮次模型账本漏记、游标取多读的那条、只在带游标时校验成员 | 被 TT02/TT04/TT06/TT07/TT09/TT13 具名断言发现 |

也就是说：交付、验收、退回、受阻、答复、执行失败这些 P0 状态变化整类不记录，测试照样全绿；同一操作写两条事件、系统迁移被写死成用户，测试也发现不了——后者正是本片 v1 被查出过的那类错误。

- 返修要求：为每一类状态变化补具名测试，按顺序断言 `cause`、`before.state→after.state`、`actor` 和条数（不只是 `some(...)`/`find(...)`）：交付验收链（含 R1-01 的豁免与真实审查人两种）、受阻→答复（卡片与授权本人答复两条入口）、执行失败与停止确认（actor 为 null）、联系人自己认领、改条件与改挂的任务事实及 actor、每个动作恰好一条事件；分页循环加上界，让游标错误以具名断言失败而不是挂死。
- 完成判据：在返修 HEAD 上原样复跑 `scripts/sweep.py`（故障清单 `scripts/faults.py`，路径见第 5 节），21 个全部被具名 `ERR_ASSERTION` 杀死；作者 24 个变异照旧全杀。这些新测试放新文件或现有两份时间线测试文件均可，不要碰 `host.test.ts`。

#### R1-03（非阻断，建议同轮修）联系人交付 SubmitForReview 的 actor 记成 null

联系人 `deliver` 是联系人主动发起的状态变化，时间线却记 null（与系统迁移不可区分）。建议在 `deliver` 写点像联系人停止一样显式传 `{kind:"contact", id: contactId}`。另 FollowUpAmend 取本机用户号、FollowUpReceived 取 `src.sender.id`，同一次补充的两条事实取法不一致，建议统一。

#### R1-04（如实记录，非阻断）外部 resume 成功后数据库故障

作者在 unverifiable 里承认未覆盖，表述准确。我用探针 P5 实测（`probes/zz-probe2.test.ts`，临时 BEFORE INSERT 触发器只作故障注入）：

- `ResumeAccepted` 事实写失败：`afterResume` 的事务连同 follow 文档的 rounds 一起回滚，错误被 `report("follow-round")` 吞掉；但外部 Compute 已收到续接（`resumed=1`），随后另一事务里的模型账本 `turn` 尝试及其事件照常写入。
- `ComputeAttempt`（turn）事实写失败：follow 的 rounds 已推进且 `ResumeAccepted` 事件在，任务文档的模型账本没有 `turn`，对应事件也没有。

结论：每个文档与它的事件始终同提交同回滚，**不会出现「事件说发生了、状态没变」或反过来**；会出现的是「外部已经发生、库里两边都没记」，以及续接与模型账本这两份事实因为本来就在两个事务里而一份有一份无。两个事务的拆分是 PR 之前就有的结构，不是本片引入。

#### R1-05（非阻断）「只追加」只靠代码约定

代码里没有任何改写或删除事件的路径，`AUTOINCREMENT` 保证重启不复用序号；但存储层没有保护，裸 SQL 的 `UPDATE`、`INSERT OR REPLACE`、`DELETE` 都能成功（探针 P6）。brief 说的「不用触发器」针对的是记录事件；要不要加 BEFORE UPDATE/DELETE 的拒绝触发器做存储层保护，列入「需拍板」，本轮不作要求。

#### R1-06（非阻断）接缝比「每处一行调用」宽

行为没变，但 `putFollowTx`/`saveTaskTx` 改成必填 `cause`，14 个既有调用点各改一行，`claimForTx`/`stepTaskTx` 签名也变了；#52/#53/#57/#76/#77 都改过这一段，合并冲突面因此变大。建议 `cause` 给默认值（例如沿用事件名），只在需要区分的调用点传参。

### 4. 来源核验（核到哪一步）

- 收据 `author.session` 是宿主会话 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`（不是 Codex 原生子线程号）；其 `record.json` 的 `nativeSessionId` 为 `01a1cfc8-db89-7400-b3de-876bd8478982`，原生记录 `~/.codex/sessions/2026/11/12/rollout-2026-11-12T20-43-29-01a1cfc8-….jsonl`，`turn_context.model` 全程 `gpt-6.1-sol`，与收据 `model` 一致。接手链：`codex:534f3614`（原生 `01a1cfc5`，runState incomplete，422「gpt-6-astra not supported」）→ 更早 `claude:dd154965`（已停）。本片的产出全部在 `01a1cfc8` 根线程及其子线程 Euler（原生 `01a1d035-2076-7443-bb9f-062b74f98187`，`agent_path=/root/contact_history_finish`，模型 `gpt-6.1-sol`）里；收据 notes 写的「V2 follow-up by /root/contact_history_finish」与此对得上。同父的 Parfit、Noether 只在各自任务里引用过本片提交号，没有产出本片。11/13 目录下没有本片记录。
- 提交号对命令输出（时间为 UTC）：根线程 `b8b31c8`（17:09 `git commit -m "test: pin task time…"`）、`2d2c57e`（17:23）、`6a32eec`（17:34:22 `[feat/task-timeline 6a32eec]`）、`5192c37`、`fbf62de`（17:34:43 `ok fbf62de`）、`c785265` 与 `49cd32c`（18:10:18 同一命令）、`f25a1df`（18:27）、`3d92212`（18:12:16）、`e85396d`（18:33:12）；Euler 子线程 `f8fac8d`（17:44:22）、`56b95cd`（17:46:16，3 行修复）、`3709deb` 与 `63c8c4e` 检出（17:46:43）、`12da04f` 合并（17:47:25「Merge made by the 'ort' strategy」）、`a2603da`（17:48:56）、`55dcef2`（17:50:27）。顺序与作者自述一致：v1 实现后才写 TT12/TT13 并先红（f8fac8d）再修（56b95cd），13 条空流红都是修复之后造的。
- 云端（box4）三个冻结点在原生输出里都有：v1 `fbf62de` 队列 643120，runner exit 1（全量 1497/1497、22/22 变异，Docker 层门禁 G-RED/G-STUB/G-TAUTO 失败）；v2 `55dcef23` 队列 663511 / runner 663513，finished exit 0（1499/1499、24/24、33/33、13 红）；v3 `3d92212` 队列 676763 / runner 680935，finished exit 0。交接 ZIP（SHA256 `12b1d5ee…2ece7790` 核对一致，只读解出小文件）里 `cloud/v1|v2/parent-verification.json` 的数字与上面一致。仓库内 proof 只收了 v3 的队列号，v1/v2 只在 ZIP 和原生记录里。
- 推送：根线程 18:42:08 `nice -n 10 lockf … git push --set-upstream origin feat/task-timeline` exit 0，日志里有 `.githooks/pre-push` 的执行痕迹、全量 1499/1499、自检 219 行。作者第一版读日志的脚本把 3 条「预期失败且判对」的自检行当成失败、断言报错，改用 v2 读取脚本后得到 219/219 无失败——这是读取脚本的错，不是自检失败；且钩子第 7 行管道会吞掉自检退出码，我另外不经管道实跑自检 exit 0、219/219。
- 门禁本身：G-PROVENANCE 只核 `author.session` 那个宿主会话（模型/厂商与 turns 写过仓库），不读 Codex 原生子线程、不查接手链、不核提交号与数字。上面这些是我用原生 rollout（`response_item` 的 function_call / function_call_output 按 call_id 配对）手工核到的，脚本与抽取结果在证据目录 `provenance/`。填审查后 G-PROVENANCE 的实际判定见第 6 节。

### 5. 门禁负例（每个门禁一个应失败的输入，均在 /tmp 副本里提交、不推送）

| 门禁 | 输入 | 实际 |
|---|---|---|
| G-TRACE | R-02 删证据路径并加不存在的 AC-9999 | ✗「R-02 标了通过但没写证据路径」「AC-9999 不在验收文档里」 |
| G-REVIEW | review 填 codex、hash 全 0 | ✗ 同一作者、同为 openai、hash ≠ 当前 |
| G-RED | red.commit 改成 base | ✗「红提交不属于本 PR」 |
| G-STUB | 加一条只断自己搭的桩的测试 | ✗ 空桩下仍通过 |
| G-TAUTO | 加恒真与 `.skip` 测试 | ✗ 恒真、自比较、不许 skip |
| G-WORKFLOW | `pull_request_target` + `write-all` + 冒名 self-check | ✗ 三条全报 |
| G-LAYER | domain 引 `@g-group/server` | ✗ 向上依赖 |
| G-PROVENANCE | review 填不存在的 claude 会话 | ✗「会话记录不存在」 |

### 6. 填审查后的门禁（本机 seatbelt，`--local --base=origin/feat/runtime-config`）

审查提交后在本机 /tmp 克隆复跑（原始输出 `local/gates-after-review.log`，exit 1）：

```text
✗ G-PROVENANCE
    - 审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash,无法证明审的是这一版
    - 审查那一轮的厂商认不出
✓ G-TRACE
✗ G-REVIEW
    - 审查结论是 reject
✓ G-RED
✓ G-STUB
✓ G-TAUTO
✓ G-WORKFLOW
✓ G-LAYER
CONTENT_HASH=5b27ebe6ceb16782df0520dfedc89935b74ac1c0a884a45e41f24cff1b6e0a91
```

G-REVIEW ✗ 是本轮结论 reject 的应有结果。G-PROVENANCE ✗ 的原因已查清，是我这一侧的记录形式，不是作者来源问题：本会话上一段（11-13 05:09 因线路 502 中断）算 hash 的那次调用写成了 `cd /tmp/gg-pr92-r1 && node scripts/gates/run-all.ts --hash …`，宿主记录里结果确为 `5b27ebe6…`，但门禁 `isHashCall`（`scripts/gates/gates.ts:163`）遇到 `&` 等 shell 元字符就不认这次调用；「厂商认不出」是没有命中时的连带结果（该段记录的模型是 `group/opus`，`vendor.ts` 认作 anthropic）。本段已按门禁可识别的形式单独再算一次：`node /tmp/gg-pr92-r1/scripts/gates/run-all.ts --hash --repo /tmp/gg-pr92-r1 --branch=feat/task-timeline --base=origin/feat/runtime-config`，输出同为 `5b27ebe6…`；这一段的 turns 要到本段结束才落盘，所以在提交前无法让门禁看到，下一次任何人跑 `--local` 时应转为只剩作者侧判定。作者侧：G-PROVENANCE 没有报作者会话的任何问题（宿主会话存在、写过本仓库、实际厂商 openai 与自报一致）。门禁不改。

### 7. 证据位置

本机 `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr92-r1-claude/`：`cloud/`（box1 两阶段原始输出：typecheck/lint/13 绿/红/依赖/全量/24 变异 TAP、自构故障扫描 `out2/sweep/`、事务探针日志）、`probes/`（P1–P7 探针与 TAP）、`scripts/`（`faults.py`、`sweep.py`、`gate-negatives.sh`、原生记录抽取脚本）、`gate-negatives/`、`local/`、`provenance/`。

### 8. 需拍板（不影响本轮结论）

1. 「只追加」要不要加存储层保护（`gg_task_events` 上 BEFORE UPDATE / BEFORE DELETE 直接 RAISE 的拒绝触发器）。brief 写的「不用触发器」针对记录事件；加保护触发器能让任何未来代码或裸 SQL 都改不动历史，代价是与那句话字面冲突。建议：加，只拦 UPDATE/DELETE，不用于写事件。
2. 门禁 G-PROVENANCE 不读 Codex 原生子线程、不查接手链、不核提交号——本轮来源是人工核到的。要不要让门禁也核这些，需要改门禁，按规矩等用户点头；本轮未改。
