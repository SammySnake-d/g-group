# PR #7 Claude Code Compute 适配器：跨厂商独立复现审查

**结论：reject，交回 Claude Code 返修。** 真实 CLI 的 `default` 保留字可使工具清单扩张；明确放弃任务会被误报为完成；`stop` 只等待直接子进程，不能保证它的下游执行已经停止；汇报服务还会接受不符合自身 schema 的受阻字段。下面的空白名单单点变异也证明现有测试不能挡住一种同类权限回归。15 个作者变异都被杀和全仓测试全绿，不能抵消这些反例。

## 一、身份、范围和固定版本

- 仓库 `SammySnake-d/g-group`，PR #7 `feat/cc-compute`；产品 HEAD `7fbba6c86f4ce20a74a1f9bbfc425fdcc0e7e07b`，基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`。
- 审查人 `codex`，mirasim 会话 `codex:592ebd7a-e738-43bd-a331-069366648d54`；本轮原生 Codex `turn_context.model` 是 `gpt-6.1-terra`（OpenAI），原生线程 `01a1ac2c-da80-79e2-836b-77a9797e0ddf`。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的轮次模型均为 Claude/Anthropic；所观察的双方原生厂商不同，无豁免。
- 审查在普通独立 clone `/tmp/g-group-pr7-review-codex-592ebd7a`；红提交与变异各在另一个独立副本。Node `v25.8.1`、npm `11.11.0`、真实 Claude Code `2.1.316`。未在共享 linked worktree 中执行钩子，未修改产品源码和测试。
- 仓库根目录实跑：`node scripts/gates/run-all.ts --hash --branch=feat/cc-compute --base=origin/feat/domain-core`，**原样输出**：

  ```text
  7402e18b7d5c9157a0328d74b35b050d2bb0a077a6f3e2cce13714803e946d33
  ```

当前审查轮次在结束前尚未生成自己的 `turns.jsonl`；本报告不宣称当前轮次的 G-PROVENANCE 已通过，也不补写或伪造会话记录。

## 二、必须修复

### F-01 [P1] `default` 被当成普通工具名，真实 CLI 展开未授权工具

位置：`packages/adapter-cc-compute/src/brief.ts:9-10,23`，`src/cli.ts:29-45`；相关测试 `src/adapter.test.ts:70-83,143-150`。对应 AC-33④、真实执行器的工具清单。

**反例与真实观察：** 将 brief 的 `tools` 设为 `['default']`。入口正则放行，`cliArgs` 生成 `--tools default`。Claude Code 2.1.316 的本机 `--help` 明确将 `default` 定义为内置默认集合，而非名为 default 的普通工具。使用该适配器的原样 `cliArgs`、真实 `claude`、独立临时 HOME、严格 MCP 配置和不提供凭据的本地不可达地址，仅观察 init 后终止，得到：

| brief.tools | 真实 init.tools |
|---|---|
| `[]` | `mcp__host__report_progress` |
| `['Read']` | `Read`, `mcp__host__report_progress` |
| `['default']` | `Bash`, `Edit`, `Read`, `mcp__host__report_progress` |

可见 `Bash/Edit/Read` 的工具 schema 已超出给定清单，返回的 manifest 却仅列 `default` 和汇报工具。这个试验**没有**驱动模型调用这些工具，因此只证明实际工具清单越界，不声称已证明未授权调用成功。独立断言“不得将 `default` 原样交给 `--tools`”在原实现上失败。

**修复要求：** 不把 CLI 的控制词/通配语义当成普通工具；对可支持的具体工具名做明确映射或拒绝保留字。用真实 CLI 的 init 清单及受控调用分别验证空集、正常子集和 `default`/其他控制词，不只比较 argv 或假 CLI 的自报。下文 M33-empty-default 的存活也必须补测试。

### F-02 [P1] 受理了明确的 `failed` 汇报，却把放弃任务报为 `completed`

位置：`mcp/report-mcp.mjs:9,13-16,42-54`，`src/adapter.ts:72-84,119-123`，`src/events.ts:51,62-66`。对应任务语义事件与 V-06。

**反例：** 通过既有假 CLI 和真实 report MCP 发 `{kind:'failed', summary:'无法完成，放弃任务'}`，再让 CLI 以 `subtype:'success'`、退出码 0 结束，result 文本为“无法完成，放弃任务”。服务接受汇报；适配器实发 `[started, completed]`，completed 的 result 正是“无法完成，放弃任务”，没有 failed。`absorb` 只处理 milestone/blocked，丢弃了工具自身声明的 failed。独立断言实际失败。

原型报告与 `out/t3/cc-blocked/stream.jsonl` 还表明：CLI 的 `success` 可以只是本轮对话正常结束，受阻任务也会返回 `success`；因此该字段不能无条件等同于业务任务完成。当前代码已经对 blocked 做了例外，却遗漏了 MCP 明确支持的“放弃报 failed”。这不是把 milestone 次数当真值：漏报 milestone 且确有成功 result 的阴性对照仍应完成。

**修复要求：** 定义已受理 failed、blocked 和 CLI 结果的冲突优先级，至少不得把显式放弃上报成完成；同时保留非零/信号失败、漏报 milestone 仍可完成的正反用例。不要仅靠自然语言 result 猜测最终状态。

### F-03 [P1] stopped 只等待直接子进程，后代仍可在 stopped 后产生副作用

位置：`src/adapter.ts:89,111-124,165-175`；现有测试 `src/adapter.test.ts:189-226` 只检查直接 CLI PID。

**反例：** 使用可注入 runner 启一个真实 Node 子进程；该子进程再启动会在 1 秒后写入临时 `outside-marker.txt` 的下游进程，然后保持运行。等待下游启动后调用 `stop`：适配器返回 `{ok:true}`、事件终态为 `stopped`，但等待 1.5 秒后中性标记文件已经出现。独立断言“stopped 后不再产生标记”失败。没有创建伪造密钥或凭据文件。

**影响和边界：** 已实证的是注入 runner 的进程树；没有声称真实 Claude Code 2.1.316 一定以相同行为遗留子进程。直接 CLI PID 已退出仍不等于该轮 Compute 的全部执行和副作用已停止，可能使停止、交接快照和重做保护失效。

**修复要求：** 在支持的平台上定义并实现子进程树的停止/回收与超时升级，或提供等价的可证明隔离；`stopped` 必须晚于可继续执行任务的下游进程退出。补父子进程和标记文件反例，并区分真实 CLI 的平台验证。

### F-04 [P1] 汇报服务器确认了不合 schema 的 blocked，适配器丢掉它并可能报完成

位置：`mcp/report-mcp.mjs:17-28,44-54` 和 `src/adapter.ts:76-83`。schema 明示 `stage` 与 `needs` 为字符串，但服务器只检查真假，不检查类型。

**反例：** 直接 JSON-RPC `tools/call`，输入 `{kind:'blocked',summary:'中性标记',needs:1}`，服务器返回 `isError:false`、文本“已记录。”；`milestone` 的 `stage:1` 同样被接受。通过假 CLI 再以该 blocked 输入、成功 CLI 结果“尚未完成”走完整事件链，实际只有 `[started, completed]`，blocked 被适配器的 `typeof r.needs === 'string'` 检查静默丢弃。两条独立 schema 断言均失败。

**修复要求：** 按声明 schema 校验条件字段的类型及非空，非法汇报明确拒绝并让执行器能重报；补直接 MCP 与完整映射两层测试。模型侧 schema 检查不能替代服务器校验。

## 三、独立运行、反例和变异

| 独立动作 | 结果 |
|---|---|
| 绿版 `npm ci` / `npm run typecheck` / `npm run lint` | 各退出 0 |
| 绿版 `npm test` | 退出 0；44 通过、0 失败、0 跳过，其中本包 21 条 |
| 独立 clone 检出红提交 `47f21066c7108b258e6e7ce0db40f15edcb6a09a`，`npm ci`，运行本包测试 | 安装退出 0；测试退出 1，21 条全部按名字失败、0 跳过，错误在测试调用空壳 `createComputeAdapter` 抛“未实现”，不是测试文件加载失败 |
| 红绿测试、假 CLI 和 MCP 服务器文件 diff | 空；同一测试体比较 |
| 审查前 `run-all --local`，指定本 PR/base | 退出 1，仅 G-REVIEW 为“还没有独立审查”；G-RED/G-STUB/G-TAUTO/G-TRACE/G-WORKFLOW/G-LAYER 均绿。此时 review 为 null，G-PROVENANCE 没有实质核验，不能将其显示的绿号当成来源证明 |
| 填写 reject 后 `run-all --local` | 退出 1；G-REVIEW 为“审查结论是 reject”，G-PROVENANCE 因当前审查会话 `turns.jsonl` 尚未生成而报“审查会话记录不存在”；不伪造记录补绿 |
| 作者 `proof/mutations.mjs` 亲自重跑 | 原样 21 绿；M01–M15 均有具名失败，脚本退出 0。只证明这 15 个已列故障被杀 |
| 独立反例 | `node --test /tmp/g-group-pr7-independent-probes.mjs`：12 项、7 通过、5 失败，0 跳过。5 项分别为 F-01、F-02、F-03 和 F-04 两种字段 |
| 真实 CLI 工具清单初始化 | `/tmp/g-group-pr7-real-cli-tool-init.log`，空集、Read、default 三组见 F-01；无模型调用/真实凭据，不能证明真实工具调用被拒 |
| 真实 CLI smoke | 在独立 clone 按请求运行一次 `SMOKE_TIMEOUT_MS=120000 node packages/adapter-cc-compute/smoke/real-claude.mjs`；本会话 `hostEnv` 没有模型配置，120 秒后脚本 stop，退出 2；只观察到 `started`、`stopped`，无文件、无汇报、无成功快照。**这次没有观察到 503，不能推断网关当前状态**，也不能当真实事件映射或完整任务通过 |

每个目标判据至少做了拒绝输入和对照，并以隔离副本做单点变异；变异期间没有修改正在执行的源码：

| 判据 / 单点变异 | 原实现反例与阴性对照 | 独立变异：原有测试 | 独立变异：新增断言 |
|---|---|---|---|
| AC-33④：只放过 `memory` 额外字段 | memory/soul 被拒且不启动；原样有效 brief 可启动 | 具名失败，杀死 | 具名失败 |
| AC-07：去掉 `constraintVer` 校验 | 缺版本交接被拒且不启动；有效快照逐项进入提示和清单 | 具名失败，杀死 | 具名失败 |
| V-06：忽略非零退出，只按 success result 完成 | 非零退出 failed；漏 milestone 的成功 result 仍 completed | 具名失败，杀死 | 具名失败 |
| AC-33④：仅在 `tools=[]` 时将 `--tools ''` 改成 `--tools default` | 原版空集产生空参数；真实 CLI 的 default 实际扩成 Bash/Edit/Read | **21/21 通过，变异存活** | 空集参数断言具名失败 |

四个变异各自 `npm run typecheck` 均退出 0；上述失败不是语法、类型检查或文件加载失败。变异与独立探针运行在 `/tmp`，摘要 `/tmp/g-group-pr7-mutation-results/summary.json`、原始输出在同目录；这些临时文件不是仓库收据或可永久保存的证据，表中已列出可重做的输入、单点改动及观察值。

## 四、对照规格及第 7 栏边界

- **AC-07：整项仍未测。** 本包拒绝无版本快照，并把给定的版本、问题和副作用逐项放进首提示/装配清单；整条“转交前一定快照、负责人不变、已完成副作用不重做”需要内核实际转交和副作用账，不能由这次假 CLI 测试推定。快照内容确实来自汇报自报，代码未与权威约束或副作用账核对；F-03 进一步表明进程树不静止时不能把快照当最终账。
- **AC-33④：整项仍未测，且本包工具清单有 F-01。** 额外 memory/soul 字段与非引用文本被拒；真实安装的 `--bare` 帮助声称跳过 CLAUDE.md 自动发现和 auto-memory，但本轮没有驱动模型验证真实上下文或联系人私有记忆隔离。假 CLI 对 `--tools`、`--allowedTools`、`dontAsk`、`--bare` 的行为确实由测试夹具模拟；真实 CLI init 只核实了可见工具清单，未核实最终授权执行。联系人授权子集比较也依赖尚未接线的宿主。
- **环境边界属实但不是凭据安全证明。** `cliEnv` 没有展开完整 `process.env`；中性标记验证了父环境的普通变量不自动继承、显式 `hostEnv` 则原样进入子进程。代码仍继承 PATH/HOME/TMPDIR，且 `...hostEnv` 对其也可覆盖。它不检查宿主显式传入值是否为明文；smoke 脚本明确从环境挑选认证变量放入 `hostEnv`。未创建伪造密钥/凭据文件、未读取或记录真实凭据；因此不能宣布 AC-33 的环境子判据通过，内核必须提供可核验的句柄/凭据接线方案。
- **V-06：本适配器的真实事件映射仍未测。** 原型中真实 CC 的 blocked 后 CLI success 样本与当前假 CLI 的 blocked 抑制完成分支相符；milestone 允许漏报，宿主仍须按 completed 补齐/标记漏报，不能以 milestone 数量当真值。本适配器将 CLI `init` 映射为 started，不等于模型已成功处理任务；本轮真实 smoke 在无汇报时也出现 started。F-02/F-04 是目前独立复现的映射缺陷，不能靠原型 10 次结果证明它们不存在。
- 收据原有 AC-07 / AC-33 / V-06 的“未测”不改写为通过。R-02 与本轮具名红绿复现相符；原始 G-STUB 对 R-03 报通过；R-05 的 15 个具体变异已复现，但空白名单新变异存活，不能把那 15 个结果扩大成所有工具子判据已充分标定。

**返修后复审边界：** 保留原作者收据的其他字段；修复 F-01–F-04，补真正检出反例的测试和双侧标定。真实 CLI 模型不可用时继续标记未测，不能用假 CLI 或一次 init 冒充真实完整执行；跨厂商审查与最终门禁重新对准新 hash。
