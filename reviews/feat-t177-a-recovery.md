# PR #57 · T-177 A / AC-15 按交付版本恢复：独立复现审查

## 第 1 轮（5503e89）· REJECT

- 审查人：`claude`（Anthropic），跨厂商审 Astra（OpenAI）写的 PR。mirasim 会话 `claude:d0818a09-6c43-480f-9320-7138615ca097`，本轮模型 `fnqtz/claude-opus-5-5`。
- 作者：`astra`，会话 `codex:63240562-6769-4e58-afdd-835948217589`。会话 `turns.jsonl` 里实际模型是 `shayu/gpt-6-astra`（3 轮），收据里却写着 `unknown-runtime-metadata-pending`，见 R1-05。
- 被审：`feat/t177-a-recovery@5503e8940c00faaed1d79b339ec4b3da988febf4` → `dev/integration@4efdee0`。开工前和推审查前都用 `git ls-remote` 回读过，HEAD 没变，分支上也没有别的 REVIEW 提交。
- 批准范围：我在线程 #2191 写的方案审查 `t177-a-g-review-20261111.md`，A 段的 A-1…A-5 五条条件；方案原文是 `t177-a-revision-20261111.md`。作者在 SCOPE.md「不伪称覆盖」里已经列为未测的内容，不作为拒审理由。
- hy4 本轮没有参加辅审：它的额度 22:19 才恢复。Codex 主验收不在本次派活范围内。
- 本会话在独立克隆 `/tmp/pr57-r1-claude` 里单独执行了一次：

  ```sh
  node /tmp/pr57-r1-claude/scripts/gates/run-all.ts --hash --repo=/tmp/pr57-r1-claude --branch=feat/t177-a-recovery --base=origin/dev/integration
  ```

  原样输出：

  ```text
  34e9434fd116f465e2735ee39e48c4e228f5aa751b94516ca702778af54f8129
  ```

  和作者自报的 hash 一致。

### 结论：REJECT

五处接口、A-1…A-5 都已经落到代码里，32 条具名测试、32 个定点变异和红提交都能复现（数字见下表），门禁除 G-REVIEW 外全过，8 个门禁负例都被各自的门禁拦下。驳回原因是我另外做的真实路径探针找到 4 个行为缺陷，加上收据里一个会挡住门禁的字段：

1. **R1-01**：已合入、已验收的任务改挂后，被退回「运行中」，没有执行器接手，任务卡死。我在 A-2 里写的「版本照常 +1」也是诱因之一，这次一并更正。
2. **R1-02**：恢复后的重放被适配器明确拒收（这一轮没有发出）时，被记成「送达未知」并永久阻塞任务，唯一出口是取消任务。
3. **R1-03**：恢复通知一直挂在 `waitingFor` 上，任务重新交付以后还在，并且排在配额等待和停止未确认前面。
4. **R1-04**：备份完成、恢复失败停住时，用户在这段时间做的新改动，会在重试时被删掉，而且没有进任何备份。
5. **R1-05**：收据 `author.model` 是 `unknown-runtime-metadata-pending`，G-REVIEW 会直接判失败。

### 复现数字

重活都在 box3 的 `/workspace/pr57-r1-claude/` 上跑，用 `flock /workspace/.heavy.lock` 排队，并发 1，跑之前去掉了 `*_proxy` 环境变量。`--local` 门禁和探针在本机 `/tmp` 克隆里跑，因为要用 macOS 的 sandbox-exec。原始输出压缩在 `deliverables/g-group-pr57-58-r1-claude/pr57/box3-evidence.tgz`，sha256 `ce2f3a06…14c4`。

| 项 | 结果 |
|---|---|
| 检出 | box3 克隆 `5503e8940c00…`，拿锁时再核一次，仍是这个提交 |
| npm ci | exit 0 |
| typecheck | exit 0 |
| lint | 检查 202 个文件，exit 0 |
| npm test | 1505 tests：通过 1505，失败 0，跳过 0，todo 0，取消 0（耗时 346 秒） |
| 作者 32 个定点变异（`scripts/t177/a-mutations.mjs`） | 原样对照 32/32 通过 → 32/32 都被各自点名的那条测试杀死 → 结束后对照 32/32 通过；跑完 `git status` 干净，源码已还原 |
| 红提交 `77ba6af` | 32 条测试：0 通过，32 条按名失败，失败类型全是 `testCodeFailure`，没有文件加载失败。红提交和 HEAD 上的测试文件逐字相同 |
| `--local --base=origin/dev/integration`（审查前） | G-PROVENANCE ✓（还没有审查，按规则跳过）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓；CONTENT_HASH 与上面的 hash 相同 |

### 审查条件逐条核对

| 条件 | 判断 | 依据 |
|---|---|---|
| A-1 重放文字 | 达到 | 宿主恢复路径的文字是「宿主已把工作区回到 vK 交付之前（备份 ref …）」，按「仍在工作区里的 / 要重做的」分两组；没配代码仓的路径保留原文字，并加上「宿主未核验」。A01H 断言文字里没有「撤掉为」，并配了变异 |
| A-2 W6 / 不核验接口 | 接口达到，行为有缺陷 | `rebindFollowUp` 新增 `recoveryMode`（host / merged / unverified），由宿主预校验后传入；A18、A19 在领域层有断言。但 merged 下源任务会被重新打开，见 R1-01 |
| A-3 去掉旧数据导入 | 达到 | 缺历史时走「宿主未核验」（A07L、A19L）；只有历史在但对不上（产物不属于本任务、目标提交不可达）才报 `checkpoint-unavailable` |
| A-4 签名配置 | 达到 | `commit-tree --no-gpg-sign`，同时有 `-c commit.gpgsign=false`；临时 index 放在任务自己的 git 目录下，用完删除。A11 覆盖仓库级配置；我另外用全局 gitconfig（`gpgsign=true`、签名程序不存在）做探针 P57-3，备份照常完成 |
| A-5 恢复不动分支 | 达到 | 不 reset、不移动分支；A08 断言 HEAD 不变，A16 断言下一次 pin 仍在原分支上往前提交 |
| 方案 §4 崩溃边界 | 达到 | A12I/B/P/D 用独立子进程分别在四个点退出，重启后目标和备份都不变，重放只发一次 |
| 方案 §5 W4 / W6 / 非代码任务 | W4 和非代码任务达到；W6 有缺陷 | 见 R1-01 |

### 审查人自构的故障

**真实路径探针**（`pr57/probe57.test.ts`，原始输出 `probe57.tap`；第 9 行的 `not ok` 是探针自己清理临时目录时碰到 git 后台维护写文件、报 ENOTEMPTY，和被测代码无关）：

| 探针 | 场景 | 结果 |
|---|---|---|
| P57-1 | 已合入并验收后改挂 | **缺陷**，见 R1-01 |
| P57-2 | 停止确认前，任务分支被挪到一个无关的孤立提交 | 改挂被拒（`checkpoint-unavailable: 目标提交不可达`），文件没动。行为正确，但没有任何测试钉住它（F2、F3）；另外抛出的是普通 Error，接口层会映射成 `internal`，不是 `conflict`（非阻塞） |
| P57-3 | 全局 gitconfig 打开签名，签名程序不存在 | 备份和恢复都完成，A-4 成立 |
| P57-4 | 预先放一个同名但不是本次备份的 ref | 拒绝复用（「backup-ref 归属不符」），文件没动。行为正确，但没有测试（F1） |
| P57-5 | 备份完成后恢复失败，期间用户手改，再重试 | **缺陷**，见 R1-04 |
| P57-6 | 恢复后的重放被适配器明确拒收 | **缺陷**，见 R1-02 |
| P57-7 | 恢复、重放完成并重新交付后看 `waitingFor` | **缺陷**，见 R1-03 |
| P57-8 | 重放被判送达未知后取消任务 | 取消可用；这是现在唯一的出口 |

**单点故障，看现有测试能不能发现**（`pr57/faults.mjs` 在 box3 上跑，每次只改一处，跑 A 的三个测试文件；改前改后的原样对照都通过）：

| 故障 | 现有 32 条测试 |
|---|---|
| F1 去掉备份 ref 的归属核对（提交说明比对） | 全过，没发现 |
| F2 去掉「目标提交必须是 HEAD 的祖先」 | 全过，没发现 |
| F3 去掉「工作树 HEAD 必须在任务分支上」 | 全过，没发现 |
| F4 去掉恢复期间禁止交付的守卫 | 全过，没发现 |
| F5 恢复栅栏里去掉「等停止确认期间（pendingRollback）」这一项 | 全过，没发现 |
| F6 merged 下仍发「已改挂」续接 | 全过。这是等价变异：领域层在 merged 下已经把 `taskEffects` 清空，宿主这一层的守卫本来就是多余的。不计为缺口 |

F1–F5 改动的都是方案 §4「备份归属不符时显式阻塞」和 A15「恢复期间只有一方拿到写权」覆盖的分支。现在的行为是对的（P57-2、P57-4 证明了），只是没有测试钉住它们，见 R1-06。

**门禁负例**（`pr57/gate-negatives.txt`，脚本是 `gate-negatives.sh` 和 `edit-receipt.mjs`；在隔离 worktree 里配假会话目录，经真实的 `run-all.ts --local` 运行）：

| 负例 | 目标门禁 | 结果 |
|---|---|---|
| AC-15 状态写成「部分通过」 | G-TRACE | ✗「不是 通过/失败/未测/不适用」 |
| 让作者自己审（astra 审 astra） | G-REVIEW | ✗「审查人与作者是同一个」，同时报「作者模型厂商认不出」 |
| 红提交改指旧的 `6182225` | G-RED | ✗「在红提交上的测试体和现在不同」 |
| 加一条只看加载期常量的测试 | G-STUB | ✗「全部换成空桩后没有按名字失败」 |
| 加一条 `assert.equal(1, 1)` | G-TAUTO | ✗「恒真/恒定断言」 |
| workflow 申请 `write-all` 权限 | G-WORKFLOW | ✗ |
| domain 包用相对路径引用 scripts | G-LAYER | ✗「跨出了包」 |
| 审查会话的 `--hash` 输出和 reviewed_hash 不同 | G-PROVENANCE | ✗「没有一次 run-all.ts --hash 的输出等于 reviewed_hash」 |
| 同一组假会话，`--hash` 输出相同（合规对照） | G-PROVENANCE | ✓ 放行 |

门禁的厂商识别接受 claude 当审查人：`policy.json` 的 `allowedReviewers` 里有 claude，对应的 harness 是 claude，`vendorOf("…claude-opus…")` 判成 anthropic，跟作者的 openai 不同厂商。

### 必须返修

**P57-R1-01（P1）已合入并验收的任务，改挂后被退回「运行中」，没有任何执行器接手。**

- 复现（探针 P57-1，走真实路径）：派活 → 交付 → 用户 `taskDecision(accept)` → 受控合入，任务到 `T8_Accepted`、工作树到 `W6_Merged` → 改挂 #m。结果：源任务 `T3_Running`，`constraintVer` 2→3，`badge: none`，`delivery: null`，`launch: null`，`computeId` 仍是早已结束的 `cp-1`，源任务的 Compute 收到 0 次续接。任务停在「运行中」，原来的验收被清掉，之后不会有任何进展，只能取消。
- 原因：merged 模式下 `rebindFollowUp` 照常 `bump`，`T8_Accepted` 的 `Amend` 走 `amendRework`（回到 T3 并发 `resume-compute`），宿主随后把 `taskEffects` 清空（`followups.ts` merged 分支、`host.ts` rebind）。
- 现有测试漏掉的原因：A18 用的是 `T3_Running` 的任务；A18H 在 `T5_InReview` 的任务上手工把工作树写成 W6，两者都不是真实的已合入状态。
- 这条源头在我的方案审查：A-2 写了「已合入：…版本照常 +1」，没想到 +1 会经 `Amend` 把已验收的任务重新打开。更正：**W6 时源任务的状态和条件版本都不动**，只把 #m 标 Rebound、关联版本 +1、通知「已合入，撤回要另开任务」。
- 要求：从真实合入路径到 W6/T8_Accepted 的具名测试，断言改挂后任务仍是 `T8_Accepted`、`constraintVer`/`badge`/`delivery` 不变、源任务 Compute 收到 0 次输入、没有新的启动请求；配一个去掉该守卫的定点变异。

**P57-R1-02（P1）恢复后的重放被明确拒收时，被记成「送达结果未知」并永久阻塞任务。**

- 复现（探针 P57-6）：恢复成功后，适配器对重放的 `resume` 返回 `{ ok: false }`（`computeTurn` 的语义是「这一轮没有发出」）。重放记录被写成 `blocked`「重放未确认，禁止自动重复发送」；`waitingFor` 显示「工作区恢复失败：…」，可文件恢复其实已经成功；用户随后再补的要求（#11）停在 Received，送不到 Compute（0 次续接）；`integrateTask` 被拒。之后交付、合入、改挂、任何续接都被 `assertRecoveryReady` 拦下，唯一出口是取消任务（探针 P57-8：取消可用）。
- AC-51 已有的修复路径（换模型失败 → 用户指定兼容模型后重试）在这里也走不通，因为重试同样被拦。
- 原因：`finishRecoveryReplay(id, false)` 把「明确没发出」（`computeTurn` 返回 false、`spawn` 的 `fail()`）和「发出后结果未知」混成同一个 `blocked`；`recoveryBlocked` 把任何非 done 的重放当成永久栅栏。
- 要求：
  1. 明确没发出的重放不进 `blocked`：回到可重试状态，交给现有失败卡 / AC-51 的重试路径，用户修好后能再发；
  2. 真正「结果未知」（重启时仍是 `sending`）保持不自动重发，但要给用户一个出口：在任务卡上确认重发，或确认已收到后标 done。只有取消这一条路不够；
  3. 通知里分开写「文件已恢复」和「重放待确认」，不要写成「工作区恢复失败」；
  4. 两种情况各一条具名测试和定点变异。

**P57-R1-03（P2）恢复通知一直挂在 `waitingFor` 上，还盖住配额等待和「停止未确认」。**

- 复现（探针 P57-7）：恢复完成、重放成功、Compute 重做并重新交付后（任务 `T5_InReview`，工作树 `W3_Pinned`），`waitingFor` 仍是「宿主已把工作区回到 v2 交付之前……旧候选和审查已作废，完成后重新交付」。「宿主未核验」「已合入」两种通知也一样，永不清除。
- 原因：`restore-notice:<task>` 只写不清；`recoveryStatus` 在 `waitingFor` 里排第一，排在 `quota.waitingReason` 和 `stopUnconfirmed` 前面。
- 要求：通知只在相关阶段算「等待」（恢复未完成，或重放待确认）；之后只留在任务卡和消息里，不再占 `waitingFor`，也不能遮住配额等待和停止未确认。补一条重新交付后 `waitingFor` 不再是恢复通知的测试。

**P57-R1-04（P2）备份完成、恢复失败停住时，用户的新改动会在重试中被删掉，而且没进任何备份。**

- 复现（探针 P57-5）：备份成功后让 `restoreTo` 失败，任务停在「恢复未完成」，期间用户在工作树新建 `late-user`，然后重试恢复（等同重启后 `recoverWorkspaces`）。结果：`late-user` 被删除，`refs/gg/backup/...` 里也没有它。
- 这违反方案 §3「不能『没备份却删了』」和「备份保护恢复前可见文件内容（含用户手改）」。§4 的「ref 已在就复用」只考虑了崩溃重入，没考虑停住期间有人手改，我审方案时也没指出。
- 要求：复用已有 ref 之前，先比较当前可见内容的树和已有备份的树：一样就复用；不一样就另建一个备份 ref（新名字，不覆盖原 ref）再恢复，通知里列出全部备份 ref。补具名测试和变异。

**P57-R1-05（门禁阻塞）收据 `author.model` 是 `unknown-runtime-metadata-pending`。**

- G-REVIEW 会判「作者模型厂商认不出」（门禁负例 review 那一行原样输出了这句）；补上审查后，G-PROVENANCE 也会判自报模型与会话实际厂商对不上。
- 作者会话 `codex:63240562-…/turns.jsonl` 现在已经有实际模型：`shayu/gpt-6-astra`，3 轮全是这个模型。返修时照会话记录填写。author 栏我不代填。

**P57-R1-06（补测）上表 F1–F5 五个守卫分支要有具名测试和定点变异。**

具体是：任务分支被移动或 HEAD 脱离分支时，改挂和恢复都显式阻塞、文件不动；同名外来 ref 不复用；恢复期间（包括等停止确认期间）交付、改挂、合入和续接都被拒。不需要改产品代码。

### 不阻塞（建议）

- `validateRecovery` 抛的是普通 `Error`，`rebindFollowUp` 被拒时接口层返回 `internal`；建议和 `target()` 一样改用 `HostError("conflict", "checkpoint-unavailable: …")`。
- IDENTITY 里已经有 `-c commit.gpgsign=false`，`--no-gpg-sign` 是多余的一层；保留没问题，作者在 SCOPE 里也如实写了。
- `restoreTo` 里又调用了一次 `backup`（会复用已有 ref），没有坏处。
- 备份 ref 只建不删、跨进程送达不保证恰好一次、断电等情况，作者都已在 SCOPE 里列为未覆盖，不计入本轮。

### 返修完成判据

1. R1-01 到 R1-04 每条都有一条具名红测：在 `5503e89` 上按名失败，修复后通过，并配定点变异。R1-01 的测试必须走真实合入路径（`taskDecision(accept)` → `integrateTask`），不能手工把工作树写成 W6。
2. R1-06 的五个守卫各有一条具名测试和一个变异；审查人的 `pr57/faults.mjs` 在新 HEAD 上复跑，F1–F5 都要被发现。
3. 收据 `author.model` 照会话记录填写；`--local` 除 G-REVIEW 外全过。
4. 审查人的 `pr57/probe57.test.ts` 在新 HEAD 上复跑：P57-1、P57-5、P57-6、P57-7 的期望改成修复后的行为，其余四条仍成立。

### 审后 `--local`（审查提交在本地，推送前）

- CONTENT_HASH 仍是 `34e9434f…8129`，审查提交没有动受管内容。
- G-REVIEW ✗：「审查结论是 reject」「作者模型厂商认不出:unknown-runtime-metadata-pending」。这两条都是预期结果。
- G-PROVENANCE ✗：
  - 「作者自报 unknown-runtime-metadata-pending,会话里实际产出厂商是 openai」，即 R1-05；
  - 「审查会话记录不存在」：mirasim 要等本轮结束才写 `turns.jsonl`，届时可以复核。
- 其余 6 个门禁 ✓。
