# PR #90 · 抽取纯 Compute 端口并保留 CC 旧入口（Q08 第一片）独立审查

## 第 1 轮

### 结论：reject

本轮是跨厂商独立审查，只审 #90 相对 #77（`feat/runtime-config`）的差异；**不是 Q08 验收，也不是 AC-07 / AC-29 / AC-33 验收**。审查人没有改产品代码、测试或门禁。

「行为不变」这一核心复现属实：原 CC 七个测试文件字节未动，基线与 HEAD 上各 139/139 且用例名逐条相同；CC 各入口的导出名、值/类型种类、86 条类型严格相等全部一致，转出口与 `@g-group/kernel/compute` 是同一个函数对象；全量 1487/1487。范围也守住了：`scripts/gates` 无改动，`procgroup.ts` 逐字节未动，`packages/server` 未动，内核不依赖 CC。

退回是因为：中性合同里仍带着 Claude Code 的 CLI 参数和进程语义（R1-01）；本片声称守住的「转出口同一性」「CC 工具表不放宽」只在不进 npm test / CI / 推送钩子的 proof 脚本里守，默认检查下作者 8 个变异里 2 个存活（R1-02）；搬进内核当共享合同的校验器有 3 个拒收分支没有任何测试（R1-03）；与 #7 的撞车没有核（R1-04）；收据作者会话号不符合原则 71，门禁实判失败（R1-05）；红提交的来历写得不够直白（R1-06）。

- 对象：`feat/compute-port-extract`，HEAD `3216bb1eeff5d1f0229b610cd37cb90e92db48c5`（11-13 02:30 开工前、11-13 23:2x 续审前、提交前三次回读远端，均未变）。
- 基线：`origin/feat/runtime-config` `272b1b5d77bd95f34467a5aa04d0bf5891355887`（未变）。
- 审查人：Claude；会话 `claude:bed00d70-50b3-46c7-9227-da8304ad22f4`；宿主记录的模型名 `group/opus`（Anthropic Claude 的线路组，门禁 `vendorOf` 判为 anthropic）。本轮因线路 502 在 11-13 05:11 中断一次，11-13 23:21 在同一会话续上，已完成的步骤没有重跑。
- 辅审：hy4 辅审因线路 403 未产出，本轮无辅审。
- 合同依据：用户给作者定的本片边界（纯抽取、行为不变；跟随现有端口位置；不改分层门禁；`procgroup.ts` 原位；CC 原路径留转出口；CC 测试一行不改；不把 CC 专有概念漏进中性合同；本片不等于 Q08 完成）；`origin/docs/dev-handbook` `90226df5` 的 `docs/spec/` 与开发手册原则 71（11-13 23:26 落档）。
- 环境：本机 macOS、Node v22.22.0，独立克隆 `/tmp/pr90-r1-claude/repo`；重活在云电脑 box2（Ubuntu 24.04，下载并核过 SHA 的 Node v22.22.0，与 CI 同版本）`/workspace/pr90-r1/`，走 `.heavy.lock` 排队，并发不超过 2。

在本会话里单独运行：

```sh
node /tmp/pr90-r1-claude/repo/scripts/gates/run-all.ts --hash --repo=/tmp/pr90-r1-claude/repo --branch=feat/compute-port-extract --base=origin/feat/runtime-config
```

原样输出（= reviewed_hash，与作者报的 CONTENT_HASH 相同）：

```text
27c57735286835da9c4fad2802b0aceb780ca3cf089d901765b85cf0319b91b2
```

### 一、亲自运行的结果

| 操作 | 在哪 | 实测结果 |
|---|---|---|
| `npm ci` | 本机、box2（候选与基线两份检出） | exit 0 |
| `npm run -s typecheck` | box2 候选 / 基线 | 均 exit 0 |
| `npm run -s lint` | box2 候选 | exit 0，`Checked 208 files` |
| `npm test` | box2 候选 | exit 0，1487 条，pass 1487，fail/cancelled/skipped/todo 均为 0；全是顶层用例 |
| 原 CC 七个测试文件（`--test-concurrency=1 --test-timeout=120000 --test-force-exit`） | box2 基线 `272b1b5d` / 候选 `3216bb1e` | 各 139/139，0 失败；两边用例名（含顺序）逐条相同（名单 sha256 均为 `5365f0f2…`） |
| 七个测试文件是否改过 | 本机 `git diff` | 0 个文件有差异 |
| 与作者云端档比对 | 本机 | 作者 box4 档（`results.tar.gz`，sha256 `f7dacf4a…`，与 manifest 一致）里基线 139、候选 139、全量 1487 的用例名与我的逐条相同 |
| 新测试 S-PORT-02 / proof 里的 S-PORT-01 | box2 | 各 1/1 |
| 作者 `shared-port-invariants.mjs`（8 个具名变异） | box2 | exit 0；8 个都以 `not ok 1 - S-PORT-01…`、`ERR_ASSERTION`、`# fail 1` 被杀，存活 0。注意杀它们的是 proof 目录里的 S-PORT-01，见 R1-02 |
| 导出面比对（自写 `typeeq.mjs`，tsc 程序化检查） | 本机 | CC 的 `index.ts`、`resident-entry.ts`、`types.ts`、`plain.ts`、`brief.ts` 五个入口导出名一个不少、无新增、值/类型种类不变；86 条 `Eq<基线, 候选>` 类型严格相等断言 0 报错；负对照 2 条按预期报错 |
| 运行时导出与同一性（自写 `runtime-surface.mjs`） | 本机 | 五个入口运行时导出名与基线相同；`plainData`/`freezeDeep`/`isPlainRecord`/`checkSnapshot`/`isCredentialRef` 与 kernel/compute 是同一对象；`kernel/compute.plainData` 与 kernel 根 `plainData` 是两份不同合同 |
| 搬移前后源码比对 | 本机 | `kernel/compute/plain.ts` 与基线 CC `plain.ts` blob 相同（`712004c9`）；`ports.ts` 相对基线 `types.ts` 只改了文件头两行注释、移走 `ClaudeRunner`/`AdapterOptions`；`validate.ts` 相对基线 `brief.ts` 只把 `CC_BUILTIN_TOOLS` 换成参数 `supportedTools` |
| `run-all.ts --local --base=origin/feat/runtime-config`（审查前） | 本机 seatbelt | G-PROVENANCE ✓（review 为空时直接返回，不是已核）、G-TRACE ✓、G-REVIEW ✗「还没有独立审查」、G-RED ✓、G-STUB ✓、G-TAUTO ✓、G-WORKFLOW ✓、G-LAYER ✓；exit 1 |
| 同一命令（填了本轮 review 之后） | 本机 seatbelt | 见第四节 |
| GitHub `self-check` | — | 回读为 COMPLETED / SUCCESS（HEAD `3216bb1e`） |

作者报的数字逐条对上：CC 七文件 139/139 两边、全量 1487/1487、skip/cancel/todo = 0、typecheck/lint = 0、8 个具名变异全杀、六项机械门禁绿、G-REVIEW 未签、G-PROVENANCE 在 review 为空时短路。

### 二、自构单点故障（box2，每项单独施加，跑 typecheck + lint + 全量 npm test）

两个不施加故障的对照与故障项同机同时跑，都是 1487/1487。「存活」= typecheck、lint、全量测试都过。

| 故障 | 结果 |
|---|---|
| A1 作者：CC `plainData` 改成包一层的新函数（同一性断开） | **存活** |
| A2 作者：内核 plainData 丢掉值为 undefined 的字段 | 杀死（4 条，含 R5-01、S-PORT-02） |
| A3 作者：遇到 getter 先调用再拒 | 杀死（11 条 R4-01） |
| A4 作者：内核校验器写死 `["Bash"]` | 杀死（105 条） |
| A5 作者：快照不查 constraintVer | 杀死（3 条） |
| A6 作者：凭据只查是不是字符串 | 杀死（4 条；lint 也报 `CREDENTIAL_REF` 未用） |
| A7 作者：brief.tools 不冻结 | 杀死（只有 S-PORT-02 一条） |
| A8 作者：CC 工具表加进 `native_exec` | **存活** |
| F1 CC `types.ts` 少转出一个类型（`SnapshotResult`） | **存活**（typecheck 也过） |
| F2 值导出改成仅类型导出（`type freezeDeep`） | 杀死（typecheck TS1485；10 个测试文件加载失败） |
| F3a brief 不拒额外字段 | 杀死（4 条） |
| F3b 快照不拒额外字段 | 杀死（3 条） |
| F3c 快照接受负的 constraintVer | **存活** |
| F3d 凭据只查第一个 | 杀死（R4-04 一条） |
| F3e `rules` 只要是数组就收（元素可以不是字符串） | **存活** |
| F3f `placement` 多收一个 `"cloud"` | **存活** |
| F4 CC `plain.ts` 换回基线那份独立实现（两份副本） | **存活** |
| F4b CC `checkSnapshot` 改成包一层的新函数 | **存活** |
| F5 中性 `SpawnOptions` 加 `claudeSessionFile` 字段（CC 会话文件概念） | **存活** |
| F6 内核 `validate.ts` 引 `node:child_process` | **存活**（门禁也不拦，见第三节） |
| F7a CC 绕过包入口，用相对路径直引 `kernel/src/compute/validate.ts` | **存活**（测试层面；G-LAYER 拦，见第三节） |
| F7b CC 用包名深路径 `@g-group/kernel/src/compute/validate.ts` | 杀死（typecheck TS2307；10 个测试文件加载失败） |

### 三、为每个门禁写一个应失败的输入（本机 seatbelt，/tmp 副本里提交，不推送）

| 门禁 | 输入 | 结果 |
|---|---|---|
| G-TRACE | AC-07 标通过但不给证据；加一条不存在的 AC-9999 | ✗，两条都点名 |
| G-REVIEW | review 写 codex（与作者同人同厂商）、hash 全 0 | ✗：同一人、同为 openai、hash 不符 |
| G-RED | red.commit 指向已有实现的 `bcebff03` | ✗：S-PORT-02「放到红提交的实现上没有按名字失败」 |
| G-STUB | 追加只断言自建假对象的测试 | ✗（G-RED、G-TAUTO 同时 ✗） |
| G-TAUTO | 追加 `assert.equal(r, r)`、`assert.ok(true)` 与 `test.skip` | ✗，逐条点名 |
| G-WORKFLOW | 新 workflow 用 `pull_request_target`、`write-all`、冒充 `self-check` | ✗，三条都点名 |
| G-LAYER | CC 依赖声明加 `@g-group/adapter-sqlite`（适配器依赖适配器） | ✗ |
| G-LAYER | `kernel/compute/index.ts` 转出 `@g-group/adapter-cc-compute`（内核依赖适配器） | ✗ |
| G-LAYER | CC `brief.ts` 用相对路径直引内核内部文件 | ✗「跨出了包」 |
| **G-LAYER** | **内核 `validate.ts` 引 `node:child_process`、`node:fs`，并导出一个执行 `true`、读 `/etc/hosts` 的函数** | **✓ 放行**；除 G-REVIEW 外全部 ✓。G-LAYER 只查包与包之间的方向，不查 node 内置模块。这是门禁既有的缺口，不是本片引入的，列入「需拍板」第 1 条 |
| G-PROVENANCE | review 写 claude、会话号全 0 | ✗「审查会话不可信:会话记录不存在」 |

### 四、来源核验（核到哪一步）

收据 `author.session` 是 `codex:01a1d043-1042-7e61-9981-968868c25de1`。这不是 mirasim 宿主会话（`~/.mirasim/sessions/codex/` 下没有这个目录），是 Codex 原生子线程号。门禁读不了它，我改用原生记录核对：

1. **接手链**：宿主会话 `codex:76d2c467-…`（record.json 的 nativeSessionId = `01a1cfc8-db89-7400-b3de-876bd8478982`）接手自 `codex:534f3614-…`（原生 `01a1cfc5-…`），再往前是 `claude:dd154965-…`。后两个会话的记录里没有出现 `compute-port-extract` 或 `kernel/compute`，没有参与本片。
2. **真正跑出这一片的是子线程 `01a1d043`**：`~/.codex/sessions/2026/11/12/rollout-2026-11-12T22-56-58-01a1d043-….jsonl` 首行 `session_meta` 的 `parent_thread_id` = `01a1cfc8-…`、角色 worker（Noether）；全部 `turn_context.model` = `gpt-6.1-sol`（OpenAI），与收据自报一致。另外两个子线程 `01a1d03a`、`01a1d035` 只在输出里提到过一次 `3216bb1`，没有本片的提交。
3. **按提交号对上的命令与输出**（都在 `01a1d043`，时间为 UTC）：
   - 16:15:54 从 `272b1b5d` 建分支 `feat/compute-port-extract`，存基线行为快照；
   - 16:18:22 红 `37c697d`（CC 包内的旧 S-PORT-01，红输出为 `Package subpath './compute' is not defined by "exports"` 被 try/catch 转成 `ERR_ASSERTION`）；
   - 16:18:53 抽取，`EXTRACTED_PURE_PORTS 20 PROCESS_MODULE_UNCHANGED`；行为快照前后逐字节相同；16:20 typecheck/lint 0；16:23 八个变异全杀；
   - 16:28:14 `cf6cb4a`，随后本地 `--local` 实判 **G-STUB ✗**（「compute-port-compat.test.ts 的测试在被测函数返回错误值时全部仍通过」）；
   - 16:31:28 在 **从 base 另起的** `red/compute-port-extract-v2` 分支上提交 `f62f661`（只有新测试，没有实现），并 merge 回来（`3ad9c9b`）；
   - 16:33:59 `87bb063`（把 S-PORT-01 挪到 `proof/shared-port-legacy.test.mjs`），本地实判 **G-TAUTO ✗**；
   - 16:35:28 在侧分支上提交 `ec4610e` 并 merge 回来（`bcebff0`）；16:36:47 `3216bb1`；16:37 本地六项机械门禁绿；
   - 17:53:36–17:58:56 box4 云跑（`/workspace/req-q08-compute-shared-process-20261113/first-resume-v2`，exit 0），18:03:47 下载并核 sha256 `f7dacf4a…`，与附件 manifest 一致；
   - 18:01:19–18:04:20 正常推送：`GIT_TRACE` 里有 `run_command: .githooks/pre-push`，钩子里 1487/1487、门禁自检 219/219「自检通过」，`[new branch] feat/compute-port-extract`，推送后远端 = `3216bb1e`；18:06:39 建 draft PR #90。
   - 两个 merge 提交在输出里只显示「Merge made by the 'ort' strategy」，没有哈希；其余 6 个提交号都在输出里原样出现。
4. **附件**：ZIP sha256 `5be96a0e…160bc269` 与交接一致；manifest 13 个成员逐个核 bytes 与 sha256 全部相符。
5. **填了 review 之后门禁实际判什么**：见下方「审查后门禁」。作者部分报「作者会话不可信:会话记录不存在:codex:01a1d043-…」。我在本地探针提交里把 `author.session` 换成宿主会话 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`、review 填本会话，G-PROVENANCE **通过**（日志 `provenance/probe-author-host-session.log`）。按原则 71 已写明的局限：宿主 `turns.jsonl` 不含子线程的工具调用，门禁认的是父会话自己的操作；本片父子都是 `gpt-6.1-sol`，结果等价。

### 五、必须返修

#### R1-01 · 中：中性合同里带着 Claude Code 的 CLI 参数、工具名和进程语义

- 边界原文：「没有把 CC 专有的概念（Claude 的工具名、CLI 参数、会话文件格式）漏进中性合同」。
- 位置（`packages/kernel/src/compute/`）：
  - `ports.ts:22`「原样交给 CLI 的 `--mcp-config`」；`:37`「作为 `CLAUDE_CONFIG_DIR` 交给 CLI…不读写本机 `~/.claude`」；`:42-44`「经 `--plugin-dir` 交给 CLI。`--bare` 下 CLI 不读 `~/.claude/skills`…（真实 CLI 2.1.319 实测）」；`:47`「写进 `--mcp-config`…（`--strict-mcp-config`）」；`:64`「CLI init 自报」；`:82-86`「交给 CLI 的…」「`CLAUDE_CONFIG_DIR`;没给为 null」；`:109`「CLI 主进程 pid」；`:142-147` stopped 的语义写成「对照 mirasim 0.0.774 server-main.cjs 的 z2…SIGTERM 只发给 CLI 主进程…`MIRASIM_REAP_FORCE_MS`」；`:163-165`「CLI 的 system/status requesting」「background 是 Bash 后台命令,subagent 是 Task/Agent 子代理」；`:156`、`:193-202`「CLI 主进程」。
  - `plain.ts:6`「本包一律按没给处理」、`:8`「report_progress MCP 服务器进程经 report-schema.ts 直接 import」、`:69`「本包自己构造的值」——这是 CC 包的说法，搬进内核后不成立。
  - 类型层面：`ports.ts:149` `stopped.scope: "main-then-group"` 把 CC 的停止方式写死成共享事件类型的字面量。
- 影响：第二片的 Codex 适配器实现 `SpawnOptions.configDir` 时，合同写的是「作为 CLAUDE_CONFIG_DIR 交给 CLI」；`stopped` 事件要求 `scope: "main-then-group"`。中性合同的语义仍由 CC 定义。
- 返修要求：上述注释改成 harness 中立的说法（这个字段对 Host 意味着什么），CC 怎么映射（`CLAUDE_CONFIG_DIR`、`--plugin-dir`、`--mcp-config`、z2 停止顺序、Bash/Task 工具名）挪到 CC 包（`types.ts` 或 `cli.ts`/`adapter.ts` 的注释）。注释改动不影响行为；作者的 proof 比较 `plain.ts` 字节相同、类型声明去注释后 AST 相同，前者要改成同样去注释比较。`scope` 字面量本片不动类型（守住行为不变），在 README 列为「从 CC 继承、待第二片定」的字段（见需拍板第 3 条）。

#### R1-02 · 中：本片声称守住的「转出口同一性」「CC 工具表不放宽」只在不会自动运行的 proof 里守

- 位置：`packages/adapter-cc-compute/proof/shared-port-legacy.test.mjs`（S-PORT-01）。`npm test` 的 glob 是 `packages/**/*.test.ts`，不收 `.mjs`；CI self-check、pre-push 钩子、门禁都不跑它。它只在作者一次性的 `shared-port-invariants.mjs` 里被调用。
- 复现（第二节）：默认检查（typecheck + lint + 全量 1487）下，作者 8 个变异里 **A1（同一性断开）、A8（CC 工具表加进 `native_exec`）存活**；我自构的 F1（少转出一个类型）、F4（CC `plain.ts` 换回独立副本）、F4b（`checkSnapshot` 包一层）也全部存活。
- 收据和 PR 说明写「8 个预绑定具名变异全部断言杀死、0 survivor」，没写明杀它们的是 proof 里那条不进默认检查的测试；README 里只有一句「explicitly executed by the invariant proof」。
- 影响：A8 是 AC-33 的工具收窄——CC 接受另一个 harness 的工具名，合并后任何检查都发现不了；F4 正是 R1-04 里 #7 合入时最顺手的解冲突方式。
- 返修要求：
  1. 收据与 PR 说明如实写成「proof 里 8/8；默认检查下 6/8，A1、A8 存活」。
  2. 类型导出面加一个在 `npm run typecheck` 时生效的核对（例如逐个引用 CC `types.ts` 转出的 20 个类型），F1 这类遗漏要在 typecheck 失败。这不是测试文件，不受 G-STUB 影响。
  3. 同一性与 CC 工具表这两条，放进合并时一定会跑的检查。作者在 `cf6cb4a` 实测过 G-STUB 会拒「只判转出口同一性」的测试（CC 包里没有被它触及、返回原始值的函数），如果仍过不了，如实报出、按「需拍板」第 2 条用户的决定办，不要只留在 proof 里了事。

#### R1-03 · 中：搬进内核的共享校验器有三个拒收分支没有任何测试

- 位置：`packages/kernel/src/compute/validate.ts:27`（`rules` 必须是字符串数组）、`:35`（`placement` 只收三个值）、`:56`（`constraintVer` 必须非负）。
- 复现（第二节 F3c、F3e、F3f）：分别改成「接受负版本号」「`rules` 只要是数组」「多收 `"cloud"`」，typecheck、lint、全量 1487 全部通过；S-PORT-02 也不报。
- 这三处在基线 CC 测试里就没人守，不是本片改坏的。但本片把它们从 CC 私有代码变成了内核里的共享合同，S-PORT-02 是作者声明的「owning-kernel witness」，第二片接 Codex 时最可能改的正是这几个函数。
- 返修要求：在内核的测试里，对 `checkComputeBrief` 与 `checkSnapshot` 的每个拒收分支（每个字段：缺、错类型、越界、多余字段）各给正反对照，至少让 F3c、F3e、F3f 按名字失败。新断言写进 S-PORT-02 或新测试后，红提交要按 G-RED 重做。

#### R1-04 · 中：与 #7 的撞车没有核

- 边界原文：「CC 侧原路径留转出口……这样 #7、#29、#74、#77 不会因搬文件撞车」。收据 `pr74` 只核了 #74（`21ac0887`，确实不重叠），没有 #7 的记录。
- 实测：`feat/cc-compute`（#7，头 `95c9ed50`）在 dev/integration 里只合到第 7 轮（`6c524020`），之后第 8–12 轮改了 `plain.ts`（R8-01 数组越界键与空位的修复，+42/−21）和 `types.ts`（`snapshot` 注释）。把 #7 试合到基线 `272b1b5d` 冲突 2 个文件（`adapter.ts`、`procgroup.ts`）；试合到本片 HEAD 冲突 4 个，多出 `plain.ts`、`types.ts`。#29、#77 是本片祖先，#74 不重叠。
- 影响：解冲突时取 #7 的 `plain.ts` 就是 F4：CC 变回一份独立实现、带 R8-01 修复；`kernel/compute/plain.ts` 停在旧逻辑；而 CC 的 `checkBrief`/`checkSnapshot` 走的是内核那份，等于 R8-01 对 brief 与交接快照的修复没生效。现有检查全绿（F4 实测）。
- 返修要求：README 与收据补上 #7 的重叠与解冲突规则（R8-01 等对 `plain.ts` 的修复要落在 `kernel/compute/plain.ts`，CC `plain.ts` 保持一行转出口；`types.ts` 的注释改动落到 `kernel/compute/ports.ts`），并与 R1-02 第 3 条的同一性守护配合。

#### R1-05 · 低：收据作者会话号不符合原则 71，G-PROVENANCE 实判失败

- 位置：`receipts/feat-compute-port-extract.json` 的 `author.session`、`contributingSessions`。
- 复现：见第四节第 5 条与「审查后门禁」。原则 71（`docs/dev-handbook` `90226df5`，用户 DM#3211）要求写宿主会话 `<harness>:<id>`，子线程号写进 notes。
- 返修要求：`author.session` 改为 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`，子线程 `01a1d043-1042-7e61-9981-968868c25de1` 写进 notes；顺带把已经过时的 `verification.cloud`（「not started」）、`normalPush`（「not started」）、README「Pending cloud acceptance: Not started」改成实际结果并给证据位置。改收据会改内容 hash，需要第 2 轮审查。

#### R1-06 · 低：红提交的来历写得不够直白

- 实际：本片是抽取，新位置的模块「还不存在」时就是红，这种红是真的。但收据里的 `red.commit` `ec4610e` 是**在实现提交 `cf6cb4a` 之后**、为通过 G-STUB / G-TAUTO，从 base 另起侧分支、只放测试、再 merge 回来的；红的形态是「`import("./index.ts")` 失败，被 try/catch 转成 `assert.ok(shared)` 的 `ERR_ASSERTION`」。G-RED 按祖先关系认它。
- README 只写「same S-PORT-02 body, named ERR_ASSERTION, neutral implementation absent」「reachable from the candidate history」，没写时间顺序和侧分支合并。
- 返修要求：README 与收据写明红是怎么造的（侧分支、在实现之后、模块缺失转断言失败），以及它只能证明「新模块存在且通过同一断言」，「行为不变」的证据是 CC 七文件基线与候选同名全绿。

### 六、不要求返修的观察

- 内核里现在有两个同名 `plainData`：根入口那份把值为 undefined 的字段删掉，`kernel/compute` 这份保留（R5-01）。选错入口做白名单校验，R5-01 的绕过会回来。S-PORT-02 已用负对照钉住两者不同；第二片接 Codex 时要从 `@g-group/kernel/compute` 取。
- CC `report-schema.ts:2` 注释「只依赖 ./plain.ts 与 node 内置模块」已不准确：经转出口现在依赖 `@g-group/kernel` 的包解析。仓库内实跑正常（resident 测试拉起真实 `report-mcp.mjs`），桌面端打包用 vite 把依赖打进单文件也能解析；只是注释过时。
- PR 正文里 cubic 机器人摘要写「Cloud regression … is not started yet」，与作者正文矛盾，是机器人按旧版本生成的。
- 收据、README、PR 说明都写明本片不含 Codex 适配器、Host 接线、实模 / CLI / 界面闭环，没有把本片说成 Q08 完成。

### 七、需拍板

1. **G-LAYER 不拦 domain/kernel 引 I/O**（第三节实测放行；F6 在 typecheck、lint、全量下也存活）。「内核不做 I/O」现在只靠约定和审查。建议另开一片门禁：domain/kernel 只许引纯内置模块（目前用到的是 `node:util`、`node:crypto`），引 `node:child_process`、`node:fs`、`node:net` 等即拒。改门禁要用户点头，不并进本片，也不作本片退回理由。
2. **转出口同一性与 CC 工具表的守护放哪**（R1-02 第 3 条）：①（推荐）先让作者在不改门禁的前提下试，确实过不了 G-STUB 时接受只在 proof 里守，但 PR 说明写清「默认检查 6/8」，并把 S-PORT-01 列为 #7 合入时的必跑项；②改 G-STUB，让只判转出口同一性的测试可以进 `npm test`（改门禁）。
3. **`stopped.scope: "main-then-group"` 等 CC 进程语义是否留在中性类型里**（R1-01）：①（推荐）本片只改注释、类型不动，第二片按 Codex 实测再定；②本片就把 `scope` 改成 harness 可声明的值（这是类型变化，会扩大本片范围）。

### 审查后门禁

填好本轮 review 后，在本机 seatbelt 跑 `node scripts/gates/run-all.ts --local --base=origin/feat/runtime-config`（证据目录 `local/gates-local-after-review.txt`）：

- G-PROVENANCE ✗「作者会话不可信:会话记录不存在:codex:01a1d043-1042-7e61-9981-968868c25de1」（R1-05）。审查部分没有报错：本会话记录里那次单独的 `--hash` 输出等于 reviewed_hash，模型判为 anthropic。
- G-REVIEW ✗「审查结论是 reject」。
- G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER ✓；CONTENT_HASH 仍为 `27c57735…19b91b2`（`reviews/` 与收据 review 栏不进 hash）；exit 1。

### 证据

`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr90-r1-claude/`：`box2/repro-logs.tgz`（复现日志，sha256 `531aa964…`）、`box2/faults-compact.tgz`（单点故障结果，sha256 `a30deabe…`）、`gate-negatives/`（门禁负例原样日志）、`local/`（审查前后门禁、导出面与同一性核对）、`provenance/`（来源探针）、`scripts/`（全部脚本）。
