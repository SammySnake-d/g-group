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

---

## 第二轮（2026-11-06）：返修后的独立复审

**结论：reject，继续交回 Claude Code 返修。** 首轮原有 12 项独立反例已经转绿，普通同进程组的回收和原 M17 空白名单变异也已复现修复；但受阻状态仍可被错误清除并继续产生副作用，汇报 MCP 缺失或 init 信息不完整时也可未经核验而完成。`stopped` 对主动脱离进程组的后代仍不成立，且快照接口没有保证调用时已静止。以下区分了新发现与作者已披露的边界。

### 1. 复审身份和范围

- 产品 HEAD `2a4d3872873de0867dd4993192b53bdf8aea315f`，基线 `origin/feat/domain-core` 的 `afd02560f9546147da380382404eb6106222a9b8`；红 `fbac6de76e8fd064a655194a60e4b1be75d86a90`，绿 `98713f64e7a745636d4afe44c4b0c79e952543e6`。
- 普通独立 clone `/tmp/g-group-pr7-r2-review-codex-592ebd7a`；红与单点变异在另两个普通独立副本。审查会话仍是 `codex:592ebd7a-e738-43bd-a331-069366648d54`，本轮原生 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话中涉及该仓库的产出轮次均为 Claude/Anthropic。没有使用豁免。
- 根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/cc-compute --base=origin/feat/domain-core`，原样输出：

  ```text
  6ff1111788cf671b820f18852a067c887207cc24abc96eed27a3f2b60e9924f1
  ```

- 本轮活动尚未结束，新增 hash 调用对应的本轮会话记录此时尚未落盘；不宣称本轮 G-PROVENANCE 已通过，不伪造记录。

### 2. 首轮四项修复实测及剩余问题

| 首轮项 | 独立观察 | 本轮判断 |
|---|---|---|
| F-01 | `default` 等控制词被拒；空白名单传空串；声明越界的 init 会触发 failed。原 M17 单点变异类型检查通过、32 项中 2 项具名失败 | 这几条反例已修；init 缺失、无效或汇报工具未挂载仍会通过，见 RR-02 |
| F-02 | 明确 `failed` 与 `is_error:true` 已映射为 failed；非法 blocked 未重报、无其他报告时也 failed | 换一个 unrelated completed 即可清掉拒收，受理的 blocked 也可在同一轮自行解除，见 RR-01；停止与违规优先级另见 RR-05 |
| F-03 | 原先同组孙进程测试已转绿：在 stopped/正常 completed 前回收，之后中性标记不出现 | 作者披露的脱组边界可复现，不能据此承诺整棵执行树停了；运行中快照也未强制静止，见 RR-03/RR-04 |
| F-04 | MCP 直连 `needs:1` / `stage:1` 均拒收；回执伪称接受时适配器也拒收；非法 blocked 被记录 | 原反例已修；共用 schema 同错会一起失效的边界仍存在 |

### RR-01 [P1] 受阻报告未重报或已经受理后，仍可在同一轮继续并误报完成

位置：`packages/adapter-cc-compute/src/adapter.ts:106-119,151-157,173-181`；验收文档 V-06 与原型报告要求受阻带 needs 并停下。

1. **拒收后被其他种类清除。** 假 CLI 经真实 MCP 发送 `{kind:'blocked',summary:'等待条件',needs:1}`，服务器拒收并记录；随后仅发合法 `{kind:'completed',summary:'结束'}`，**没有重报 blocked**，CLI 正常退出且 result 为“尚未完成”。实际事件为 `[started, completed]`，而 `rejectedReports` 仍含 blocked。`absorb` 对任何合法 completed 都清空 `round.rejectedStop`，与“blocked/failed 被拒收且未重报不算完成”不符。对照：只发非法 blocked 时终态确为 failed。
2. **受理后仍能执行。** 使用现有假 CLI、真实 MCP 和同组孙进程，先合法汇报 `{kind:'blocked',needs:'需要用户确认',...}`，在没有任何用户续接前等 1.2 秒，孙进程已写出 `outside-marker.txt`；最后由审查脚本 stop 清理。另一条纯事件反例为 `[started, blocked, milestone, completed]`，result 为“尚未完成”：一次 milestone 就把 `blockedOpen` 清掉。模型被提示“blocked 后停止”不是机械保证。

**要求：** 对拒收报告按种类/实例保留未解决状态，只有符合约定的重报或由宿主授权的明确解除才能消除；已受理 blocked 后必须保证不继续执行或产生副作用，除非通过明确的宿主 resume/解除流程。保留成功执行中 milestone 可漏报、正常 resume 可完成的对照。标记文件只是临时中性文件，没有伪造密钥/凭据文件。

### RR-02 [P1] 汇报工具未连接或 init 无法核验，仍可报告完成

位置：`src/events.ts:43-45,65` 与 `src/adapter.ts:142-150,166-181`。当前 init 把缺失/非数组 tools 转成 `[]`，把非字符串元素过滤掉；终态没有要求曾收到有效、完整的 init 或 `report_progress`。

- **真实 CLI 初始化观察：** Claude Code 2.1.316、隔离临时 HOME、无凭据、回环不可达地址，使用原样 `cliArgs` 并让 host MCP 以 `/usr/bin/false` 退出；真实 init 给出 `tools:['Read']`、`mcp_servers:[{name:'host',status:'failed',source:'dynamic'}]`，真实 CLI 并不会因 MCP 启动失败而在 init 前终止。
- **适配器独立反例：** 将上述同形 init（含 failed MCP）和 CLI `success` 结果交给注入式 runner，实际 `[started, completed]`，尽管没有 `mcp__host__report_progress`。分别省略 init、init 缺 tools、tools 含非字符串，实际也可完成；完整且不越界的 init 对照完成。这里的成功 result 来自注入式 runner，不冒称真实网关/模型完成。

**要求：** 未收到可校验的 init、工具列表形状不合规、必须的 report MCP 未实际挂载/连接，应以明确失败处理并回收，而非把未知清单视作空集。补真实初始化失败与适配器同形事件流两层测试；不要仅检测列表里已出现的越界名字。

### RR-03 [P1 / 首轮 F-03 尚未完整关闭] 后代脱离进程组时，stopped 之后仍可产生副作用

位置：`src/adapter.ts:47-71,125-126,166-175,225-233`。作者第 7 栏已明确披露此限制，本轮不是把它冒充为未披露问题。

只切换孙进程的 `detached` 开关：同组对照在 stopped 后标记不存在；另建 session 的子进程在 `stop` 返回 `{ok:true}` 且事件为 stopped 时仍存活，1.2 秒后实际写出 `outside-marker.txt`。所有测试子进程由审查脚本在退出前自行结束/清理。复现使用可注入 runner、真实 POSIX 进程和中性标记，不声称在本轮真实 Claude 模型调用中已复现。

首轮审查对 F-03 的要求是 stopped 后不能再有该执行的下游副作用；当前只保证未脱组的进程，`Bash` 已在本适配器可授权清单内，另建会话/托管并非类型上不可能。**要求：** 在把 stopped 用作整体停止或交接前提时，提供可验证的会话/容器/宿主隔离等边界，或取得用户对更窄语义的明确决定并阻止内核把它当全树静止；仅在收据披露不等于首轮完整关闭。Windows 仍未测。

### RR-04 [P1 / AC-07 边界] 运行中的 Compute 也能返回成功交接快照

位置：`src/adapter.ts:187-205,247-250`。用合法 handoff 的 `constraintVer:1` 启动仍在运行且其同组孙进程也存活的 runner，立即调用 `snapshot()`，返回 `{ok:true,snapshot:{constraintVer:1,openQuestions:[],doneSideEffects:[]}}`，没有等待停止或进程组退空。独立断言“最终交接快照不得在活动进程上成功”失败。

这直接限制了收据中“快照取的是进程树静止后的状态”的表述：本包没有保证调用顺序，快照的内容仍是 Compute 自报；AC-07 的负责人和副作用账也仍未接线，整项继续未测。**要求：** 对最终交接快照提供机械的静止/代次前置条件，或将运行中结果显式标为非最终快照并要求内核证明停止后再取；同时覆盖组未退空的失败路径和停止竞态。

### RR-05 [P2 / 声明的终态优先级不一致] 用户 stop 与工具越界并存时实际报 failed

位置：`src/events.ts:84-88`。本轮提交和收据声明“停止 > 适配器违规”，但 `terminalFor` 只有 `stopRequested && fault === undefined` 才返回 stopped。独立真实子进程先 init 自报越界 Bash 并忽略 SIGTERM，随后用户 `stop` 返回 `{ok:true}`；实际终态是带越界原因的 failed，不是声明的 stopped。纯函数和进程链两种反例一致。

**要求：** 明确并实现同一套对外状态优先级，同时保留违规作为可审计事实；若认为违规应高于停止，需让请求方确认并同步契约/收据。进程组未收干净必须 failed 的明确例外不能被普通停止掩盖。

### RR-06 [P2 / 标定执行可靠性] M18 反例使测试进程长期不退出，缺少失败清理

位置：`src/adapter.test.ts:115-130`、`proof/mutations.mjs` 的 M18 和 `run()`。作者原脚本的原样副本 32 项通过，M01–M17 均产生具名失败；到 M18（禁用 init 越界核对）时，本轮 Node 25 的 `node --test --test-timeout=20000` 进程仍在运行，至少经过 2 分 49 秒，测试 worker 及其 `hang:graceful` 假 CLI 仍存活且脚本没有输出该变异的结果。该测试在 `within(...)` 超时断言失败后没有 `finally` 回收被测假 CLI；单条测试的超时不等于测试进程和后代已退出。脚本外层 `spawnSync` 配置的是 300 秒超时，未等待到该上限，因此不能断言它到上限后的最终表现。

为避免继续占用共享机器，只对可确认属于本轮临时变异目录的进程发送终止信号；脚本退出 143，已确认这些进程退出。**M18–M31 本轮没有完成复现，不将作者 31/31 的说法当作本轮观察，也不因此断定作者记录虚假。** 本轮独立完成的六种变异和 M17 结果见下表。

**要求：** 即使阳性变异使断言失败或超时，也在 `finally` 中回收该测试自己创建的进程树；为完整测试进程设有界超时并校验清理，不把超时/强杀/部分执行误计为按名杀死。不得清理其他会话的进程。

### 3. 独立执行与双侧标定

| 项目 | 实际观察 |
|---|---|
| 绿提交 `npm ci`、typecheck、lint、全仓 test | 全部退出 0；test 为 55/55，0 跳过 |
| 红提交独立 clone、`npm ci`、本包测试 | 安装退出 0；测试退出 1，32 条按名称失败、0 跳过；32 个名字均在绿版通过；红绿测试、假 CLI、MCP 服务器文件 diff 为空 |
| 首轮 `/tmp/g-group-pr7-independent-probes.mjs` 换到本轮产品副本后重放 | 12/12 通过；覆盖首轮四项及其对照，不代表本轮新反例通过 |
| 本轮新增独立反例 | 15 项中 4 项对照通过、11 项断言失败，0 跳过；同一根因可能对应多个输入，详见 RR-01–RR-05 |
| 真实 smoke | 本会话未设置 Anthropic 模型/网关环境；运行一次 `SMOKE_TIMEOUT_MS=20000 node packages/adapter-cc-compute/smoke/real-claude.mjs`，20 秒超时后 stopped、退出 2；无汇报/文件/快照，定向检查无本次 report-mcp 残留。本轮没有观察到 503，不推断网关当前状态 |
| 填本轮审查前 `run-all --local` | 退出 1；G-REVIEW 因首轮 reject 与旧 hash 拦截，其余包括旧轮次 G-PROVENANCE 通过。这个通过不等于本轮 hash 已完成来源核验 |
| 填本轮 reject 后 `run-all --local` | 退出 1；G-REVIEW 正确因 reject 拦截；G-PROVENANCE 暂因本轮 hash 调用未落盘而找不到匹配轮次，随后厂商也显示认不出。不能把旧轮次的通过当本轮通过 |
| Node 22.22.0 兼容性抽查 | 真实 MCP JSON-RPC schema 的 1 条具名测试退出 0；不是 Node 22 下全仓测试 |
| 作者原 31 个变异完整重放 | 原样 32 绿，M01–M17 有具名失败；M18 测试进程至少 2 分 49 秒未退出，主动清理本轮进程后脚本退出 143；M18–M31 未完成复现，详见 RR-06 |

本轮单点变异使用另一个完整 clone，每项修改仅一处，测试运行结束才恢复源文件；六次 typecheck 均退出 0。前五项运行对应原有具名测试，最后一项运行完整本包 32 项与独立反例：

| 条件/单点改坏 | 现有测试 | 独立输入 |
|---|---|---|
| AC-33：放行 `default` | 对应具名测试失败 | 默认控制词拒绝是原样对照 |
| AC-07：放行缺 constraintVer | 对应具名测试失败 | 缺版本被拒、完整快照进入提示/清单 |
| V-06：忽略 accepted failed | 对应具名测试失败 | failed + CLI success 不得 completed |
| stop：禁用 SIGKILL 升级 | 对应具名测试失败 | 无视 SIGTERM 的目标在超时后被测试清理 |
| schema：`needs` 只检查真假 | MCP JSON-RPC 具名测试失败 | 数字 needs 被拒，合法字符串接收 |
| **新变异：在已有 cleared 条件外，额外让 `started` 清除尚未重报的 blocked** | **32/32 通过，变异存活** | 非法 blocked → 合法 started → CLI success 的独立断言失败；原版同输入 failed |

另独立复跑 M17：仅将空集的 `--tools ''` 改为 `default`，类型检查退出 0，本包 32 条全部执行、30 绿 2 条按名红。单点变异输出与反例脚本在 `/tmp/g-group-pr7-r2-mutations/`、`/tmp/g-group-pr7-r2-independent-probes.mjs`；临时路径不是永久证据，上文已给输入与实际结果。

### 4. 未测与接线边界

- AC-07、AC-33④、V-06 的整体状态仍为未测；不得以模拟 CLI、init 自报或原型的 10 次实验冒充本适配器的真实完整模型执行。原型确实允许 milestone 漏报，宿主以最终完成补齐/标注；其 blocked 样本为请求用户条件后停止，而 CLI result 的 subtype 仍是 success。
- 本轮中性环境对照仍证明 `hostEnv` 显式内容会进入子进程，不证明内核不会放明文；没有伪造凭据文件，也没有取用真实凭据。`--bare` 不读取 auto-memory/CLAUDE.md 的真实模型上下文、真实授权外工具调用、Windows 及跨厂商状态机完整接线仍未验证。
- 仅修改本报告的“第二轮”追加段和收据 `review`；具体问题修复由作者进行。返修后应对新 hash 再做跨厂商复审，不把暂时缺测或错误终态标绿。

---

## 第三轮（2026-11-06）：按用户确认的 process-group 语义复审

**结论：reject。** 用户已经明确不需要容器，停止范围改为 `process-group`；本轮不再以 setsid 脱组后代仍存活作为缺陷。独立实测组内 SIGTERM、立即 stopped、默认 10 秒 SIGKILL、blocked 冻结和主进程退出前拒绝快照均符合本轮明示行为；但停止后的输出仍可改变终态、空续接先杀掉暂停进程、init 前输出的门禁不完整。另发现一个变异触发的测试进程清理缺口，以及用户所列语义与 mirasim 0.0.774 源码并不完全相同，不能写成逐项等同。

### 1. 固定对象、身份与跨厂商

- PR #7 `feat/cc-compute` 产品 HEAD `e7c1d4aa624e7cf4dc13a51e389f9661c1e9b97c`；基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`。暂停时的 `388bce0` 已作废，本结论不以它为审查目标。
- 普通独立 clone：`/tmp/g-group-pr7-r3b-review-codex-592ebd7a`；红提交和变异分别使用其他独立副本，不在共享 linked worktree 执行钩子。Node `v25.8.1`，macOS，8 核；真实 Claude Code 网关未配置，本轮未跑真实模型 smoke。
- 审查会话 `codex:592ebd7a-e738-43bd-a331-069366648d54`，本轮原生 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话中涉及本仓库的模型均为 Claude/Anthropic。没有豁免。
- 指定命令 `node scripts/gates/run-all.ts --hash --branch=feat/cc-compute --base=origin/feat/domain-core` 在该 clone 根目录的**原样输出**如下，与作者声明一致：

  ```text
  46b92e881f30862f7eea853ae17b7ea7051f1142b20732d30c6278274bded229
  ```

- GitHub self-check run `42122024671` 的 `headSha` 确为上述产品 HEAD，状态 completed、结论 success；这不是独立审查通过，也不是全部业务验收通过。

### 2. 必须修复的问题

#### R3-01 [P1] `stopped` 后仍处理输出，受阻回报还能反向覆盖终态

位置：`packages/adapter-cc-compute/src/adapter.ts:120-164,263-277`。`stop()` 设置 `finished` 并立即 emit stopped，但没有设置 `halted`；`onLine()` 只检查 `halted`。因此仍在宽限期的 CLI 可以在 stopped 之后继续改变对外事件和内部状态。

**独立反例：** 使用可注入的真实 Node 子进程及同组子进程；主进程收到 SIGTERM 后写一个合规 `report_progress` 的 tool_use/tool_result，再保持存活。先调用 `stop`：

- 若迟到的是 milestone，实际在 stopped 之后又收到 milestone。
- 若迟到的是 blocked，实际顺序为 `started → stopped → blocked → stopped`；第二次 `stop()` 也返回 `{ok:true}`。迟到的 blocked 将 `round.terminal` 改回 `paused-blocked`，还向组发送 SIGSTOP。

这不是要求等进程退出：用户明确允许 stopped 立即产生；问题是**已经宣布的终态仍被同一轮的迟到输出改写**。测试用的是模拟 CLI stream 和真实 POSIX 信号，没有冒称真实 Claude 模型执行。原有测试只用收到 TERM 后不再输出的夹具，因此没有发现。

**要求：** stop 确认后封存该轮语义输入与终态，后续 stdout/tool_result 不得再产事件、改变状态或触发信号；保留已记录的违规、SIGTERM 和 10 秒升级。补迟到 milestone、blocked、重复 stop 和退出竞态对照。

#### R3-02 [P1] 空 `resume` 先杀掉受阻进程，再返回输入错误

位置：`src/adapter.ts:245-259`。受阻进程处于 SIGSTOP 时，`resume()` 在检查 `text.trim()` **之前**对其进程组 SIGKILL 并等待退出。

**反例：** 已核验 init、blocked 后，确认父子组状态均为 `T`；调用 `resume(id, '   ')`，得到 `{ok:false,reason:'续接的内容不能为空'}`，但原主进程已不再存活。合法续接仍有原有测试作对照。无效输入不应先对暂停的原会话产生不可逆进程副作用。

**要求：** 在任何信号/状态变更前验证续接输入及其他必要前置条件；补空白输入前后主进程和同组子进程保持暂停、合法续接再执行的单开关测试。

#### R3-03 [P1] init 前未识别的输出被静默忽略，提前 tool_use 还能在 init 后生效

位置：`src/events.ts:51-78`、`src/adapter.ts:141-164`。第二轮返修要求 init 前其他输出回收并 failed，但 parser 对非 JSON、assistant 文本、尚未配对的 tool_use 都返回空 signal，故 `onLine()` 的 init 前检查没有运行。

**三个独立输入：**

1. assistant 文本 → 合法 init → success result，实际 `started → completed`。
2. 非 JSON 行 → 合法 init → success result，实际 `started → completed`。
3. init 前的 `report_progress` tool_use → 合法 init → 对应 tool_result → success，实际 `started → milestone → completed`；提前的调用被 `pending` 保存并跨越 init 配对。

对照：合法 init 后正常 result 完成；init 前直接 result 目前确实 failed。夹具 `test-support/fake-claude.mjs:47-73` 自己也在 init 前输出 `fake_grandchild` 行，而当前 parser 会忽略它。

**要求：** 按已确认的协议显式处理 init 前每一行，不得先记住工具调用、后通过 init 洗白；如果某些真实 CLI 前导帧需要豁免，应先明确允许清单和用户契约，而不是静默吞掉所有未知输出。把测试用 PID 屏障留在中性文件/IPC，不依赖未声明的前导 stdout。

#### R3-04 [P2 / RR-06] 断言在假 CLI 写记录前失败时，afterEach 漏回收进程

位置：`src/adapter.test.ts:27-49,684-690`。独立将快照守卫做单点变异（运行中错误地放行），typecheck 退出 0；对应测试在约 10ms 具名失败，但测试进程未正常退出。首次外层 90 秒超时后，本轮假 CLI 仍作为独立进程存活，已核验其命令属于本轮独立变异副本后清理。按本仓库规则，**超时/强杀不能计为完整按名杀死**。

进一步在另一个独立变异副本限制观察 6 秒：测试已具名失败而假 CLI 仍存活；只清理匹配该副本完整可执行路径的组后，测试进程才退出 1。清理只涉及本轮进程，之后两个变异副本均恢复干净。代码存在的竞态是：`afterEach` 只从已经存在的 `record.jsonl` 取 PID 并立即清空 `ownDirs`；若断言先于假 CLI 写记录失败，就没有 PID 可回收。

**要求：** 测试在启动时直接记录可回收的子进程/进程组身份，或提供可靠启动屏障；无论断言失败在记录前还是后均在 `finally/afterEach` 回收。对完整变异执行验收需排除超时、信号、部分执行和残留；不得按名称模糊清理其他会话。

### 3. 与 mirasim 0.0.774 的实际对照

用户本轮明示的 **POSIX 组 SIGTERM → 立即 stopped → 默认 10 秒后仍存活组 SIGKILL** 是本次审查的行为基准，本 PR 的独立实测符合它；不应因为参考实现不同就擅自改成只杀主进程。

但指定文件 `/Users/snakesammy/.mirasim/app/0.0.774/server-main.cjs` 的 SHA-256 为 `b342710fd8a9cf28211003fe521bd12e11e36b8f8cd3ce4a988b305d359c4d4c`。源码中 Claude abort 路径调用 `z2(child,{graceMs:0,group:true})`；`PU = process.platform !== 'win32'`，POSIX 下该函数初始分支调用 `MLe(child)`，即 **`child.kill('SIGTERM')`，不是组 SIGTERM**。其 10 秒升级经 `FG(...,'SIGKILL')` 发组信号，但主进程 `exit` 会清除升级计时器。

为核对解释，将本机原文件的 `MLe` 至 `z2` 原函数片段放进隔离进程执行（仅将 forceMs 缩短为 1 秒以观察，默认值仍由原源码 `Lkc=1e4` 核实）：主进程保持运行时，主进程收到 TERM、同组子进程**没有**收到 TERM，之后两者被组 KILL；主进程先退出时，计时器取消、同组子进程仍活。全过程只用中性标记并清理自己的进程。

**结论：** 当前 PR 符合用户明确列出的组信号要求，但“与 0.0.774 不多不少/完全一致”的说法与所给源码不符；需要更正证据与措辞，若要改用户明确行为须另行征得用户决定。不能把脱组后代逃逸当作本轮失败：独立 setsid 对照中，stopped 的 `scope:'process-group'` 且脱组中性子进程继续写标记，正是已披露、不覆盖的范围，不要求 Docker 或容器。

### 4. 实际运行、门禁负例与变异

| 复现 | 实际结果与边界 |
|---|---|
| 绿版 `npm ci`、typecheck、lint、全仓 test | 各退出 0；全仓 72/72，0 跳过 |
| 红提交 `5312efc0f6c80fabb5729f129b6aa9f13130c496` 独立 clone、npm ci、本包测试 | 安装退出 0；49 条按名字失败、0 跳过；这些名字均在绿版通过；红绿测试与假 CLI 文件无差异 |
| 独立 POSIX 同组信号 | stopped 约 1ms 返回时父子均存活，随后父子均写出 TERM 标记；默认强杀实际约 10.107 秒，两者随后消失。blocked 时父子 `ps` 状态均为 T；主进程存活及刚 stopped 时 snapshot 均拒绝，退出后给快照 |
| F-03 负载复现 | 自建 2 个 CPU 负载进程、8 核机器上只针对“正常结束留同组孙进程”用例连续 20 次，20/20 通过；观察的 1 分钟 load 约 5.2–9.7。**不是**重新跑完整 49 项 20 次，也未复现作者约 28 的峰值；作者 `flake-20.txt` 对应的 `a83b309` 到本 HEAD 产品源码和夹具无差异 |
| 审查前完整 `run-all --local` | 退出 1，G-REVIEW 因旧 reject 和旧 hash 拦截；其余绿。旧轮次 G-PROVENANCE 通过不代表本轮 hash 已完成来源核验 |
| 填写本轮 reject 后 `run-all --local` | 退出 1；G-REVIEW 按 reject 拦截，G-PROVENANCE 暂未在已落盘轮次中找到本轮 hash，因而同时报审查轮次厂商无法确认；不伪造当前会话记录补绿 |
| 真实 smoke | 当前审查环境没有设置 Anthropic 网关/认证环境，本轮没有运行真实模型 smoke。`proof/smoke-real.txt` 从 `388bce0` 到本 HEAD 无改动，最后一次提交为 `88dbbef`；只能说明仓库没有新增 smoke 证据，不能证明作者本机从未运行未记录的测试 |

**每个机械门禁独立负例：** 在临时、普通 Git 仓库中给真实 `run-all.ts --local` 分别输入：G-TRACE 缺失证据、G-REVIEW 作者自审、G-RED 缺红提交、G-STUB 只断言模块加载时算出的顶层值、G-TAUTO 恒真断言、G-WORKFLOW 使用 `pull_request_target`、G-LAYER 领域层反向依赖内核、G-PROVENANCE 审查记录缺 hash 调用。八例均退出 1 且对应门禁和预期原因被观察到；独立合规对照退出 0。会话记录是门禁测试用的隔离夹具，不是实际审查来源或凭据文件。

**独立单点变异：** 下列变异均在单独 clone、每次只改一处且 typecheck 退出 0：

| 变异 | 现有测试的实际结果 |
|---|---|
| SIGTERM 只发主进程 | F-03 具名失败 |
| 不升级组 SIGKILL | 无视 SIGTERM 的 stop 用例具名失败 |
| blocked 不发 SIGSTOP | blocked 组冻结用例具名失败 |
| stop 等待主进程退出才返回 | 立即 stopped 用例具名失败 |
| 原 M18 不核对越界 / M32 started 清除拒收 | 两项分别具名失败，M18 这次有界退出 |
| init 前 signal 不检查、直接忽略 | **现有本包 49/49 通过，变异存活**；独立的“init 前 result 后补合法 init”断言失败，原版该对照通过 |
| 快照守卫放行运行中 | 具名断言先失败，但测试进程超时且假 CLI 残留；按超时/强杀规则不计完整杀死，见 R3-04 |

未重跑作者全部 45 个变异，不把作者的 45/45 自报当作本轮观察；本轮独立测试和日志存于 `/tmp/g-group-pr7-r3b-*`，报告已列出输入与决定性结果。

**执行器错误如实记录：** 独立默认强杀探针首版误给了 700ms 覆盖值而失败，修正为不传覆盖值后实测 10.107 秒通过，该失败不是产品结论。一次额外清理监督脚本因把自身 shell 命令字符串误识别为目标而退出 137；仅该临时复测受影响，随后核验并清理自己的两组进程，严格按可执行路径重跑后得到 R3-04 的 6 秒观察；不把退出 137 当产品失败。 插入门禁结果时曾误改旧段，前缀校验发现后已从 HEAD 恢复旧报告原字节，仅保留第三轮追加；未提交受影响版本。

### 5. 未测与交付边界

AC-07、AC-33④ 和 V-06 整项仍未测：内核授权子集、权威约束/副作用账、真实 CLI 的工具权限及模型事件映射没有凭本轮假 CLI 推断通过。`hostEnv` 明文接线、共享 schema 同错、Windows 和脱组后代均保持已披露边界。用户已经选择本机 process-group 语义，内核不得把 stopped 或主进程退出误当作整棵执行树静止。

本轮只追加本节和更新收据 `review`；本轮会话尚在运行，hash 对应的当前轮记录尚未落盘，不声称本轮 G-PROVENANCE 已通过。返修由作者负责，新产品 hash 需重新跨厂商审查。

---

## 第四轮（2026-11-06）：按更正后的 mirasim 停止语义独立复审

**结论：reject。** 第三轮 R3-01～R3-04 的原反例已独立转绿，停止的默认主进程 TERM / 到期组 KILL 行为也基本复现；但外部 accessor/Proxy 输入会被调用并放行，合法 JSON `null` 会令汇报 MCP 进程崩溃。此两项均在用户确认的“内置原型未被改”范围内，不能因为全仓测试或 CI 为绿而放行。

### 1. 固定对象与合同

- PR #7 `feat/cc-compute` 产品 HEAD `a134e8a9c998e4240be7bbe11436136d26048712`；基线 `origin/feat/domain-core` 的 `afd02560f9546147da380382404eb6106222a9b8`。红提交 `230155ab320ecdb567541269f63ebcffe43ac862`，绿提交 `c418b74849e96400c7d3a8eb866a66866b3b7917`。
- 本次使用普通独立 clone `/tmp/g-group-pr7-r4-review-codex-592ebd7a`；红提交与单点变异各在另一个独立副本，不在共享 linked worktree 运行钩子。Node `v25.8.1`；相关输入缺陷另在 Node `v22.22.0` 复现。
- 审查会话 `codex:592ebd7a-e738-43bd-a331-069366648d54`，本轮原生模型 `gpt-6.1-terra`（OpenAI）；作者会话涉及仓库的产出轮次均为 Claude/Anthropic。没有豁免。
- 在独立 clone 根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/cc-compute --base=origin/feat/domain-core`，**原样输出**与声明一致：

  ```text
  d515493cfe9f3a065c977fc8bc4191c4c72ff62139501c4867efdb2682bb81ef
  ```

- GitHub self-check `42174842013` 为 completed/success，headSha 正是上述产品 HEAD。PR 正文已核对：当前状态是主进程 SIGTERM、到期组 SIGKILL、`scope:main-then-group`；旧组 SIGTERM 等文字在历史轮次并明确作废，本轮不拿它当当前合同。
- 用户 `g-group#2662` 缩小了宿主内置原型已被修改时的合同；本轮**没有修改 `Object.prototype`、`Array.prototype` 或其他内置原型**，也不把先污染内置原型的反例作为打回理由。外部 getter/setter/Proxy 不调用即拒收，以及合法 JSON `null` 不抛错，仍按本轮明确要求核对。

### 2. 必须修复

#### R4-01 [P1] 外部 accessor / Proxy 被执行并放行，甚至启动执行器

位置：`packages/adapter-cc-compute/src/brief.ts:13-35,42-55`、`src/adapter.ts:229-238`、`src/report-schema.ts:7-26`。这些对外入口直接 `Object.keys`、解构、读取数组元素和读取汇报属性，未先拒绝 Proxy/访问器。

**独立反例（全部使用正常内置原型和无害计数器）：**

- `brief.task` 是 getter：调用 `checkBrief` 后 getter 命中 1 次，结果 `ok:true`；调用实际 `spawn` 时同样命中 1 次、返回 `ok:true`，注入式子进程实际写出了中性 `outside-marker.txt`。
- 顶层 Proxy 的 `ownKeys/get` trap 合计命中 6 次，仍 `ok:true`；撤销后的 Proxy 则抛出 `Cannot perform 'IsArray' on a proxy that has been revoked`，没有返回拒绝。
- `rules[0]` getter 被调用 2 次并放行；自定义对象原型上的 getter 命中 1 次并放行——这没有改动任何内置原型。带不可枚举 setter 的输入虽然未调用 setter，仍被放行。
- handoff `constraintVer` getter 命中 1 次并放行；`spawn` 选项的 `handoff` getter 命中 1 次，进程照样启动；导出的 `reportErrors` 对 `kind` getter 调用 4 次且返回空错误列表。

普通纯数据 brief 的对照通过；直接 `checkBrief(null)` / `checkSnapshot(null)` 拒绝、`reportErrors(null)` 返回错误。上述 getter 与 Proxy 反例不依赖内置原型污染。Node 22 对字段 getter 另复现同样的命中与放行。

**要求：** 在读取外部对象、数组或选项的属性前，安全识别并拒绝 Proxy、访问器及非预期属性；递归覆盖嵌套数组和快照/汇报输入，拒绝过程不能调用 getter、setter 或 Proxy trap，也不能启动子进程。补可观察计数器、撤销 Proxy 和普通纯 JSON 对照。这里只证明当前合同及副作用，不声称远程攻击已发生。

#### R4-02 [P1] 合法 JSON `null` 使 report MCP 崩溃，后续合法请求不再处理

位置：`packages/adapter-cc-compute/mcp/report-mcp.mjs:34-38`。`JSON.parse('null')` 成功后，代码直接访问 `m.method`，抛 `TypeError` 并终止服务器。

**单开关对照：** 向真实 MCP 子进程 stdin 只发合法 `tools/list` 请求，退出 0 且收到 id 1 响应；先发一行 `null` 再发同一请求，进程退出 1、stderr 为 `Cannot read properties of null (reading 'method')`，没有后续响应。Node 22 与 Node 25 均复现。`null` 是合法 JSON，但并非有效 JSON-RPC 请求；要求是安全拒绝/忽略该无效请求并保持进程可用，**不是**把它当作有效 RPC 接受。

**要求：** 在访问字段前检查解析结果是合规请求对象；覆盖 `null` 后继续处理合法请求、其他合法原始 JSON 值、对象正常调用和坏 JSON 对照。

### 3. 源码对照与测试缺口

#### R4-03 [P2] `MIRASIM_REAP_FORCE_MS` 的环境覆盖未接线

参考文件 `/Users/snakesammy/.mirasim/app/0.0.774/server-main.cjs` 的 SHA-256 为 `b342710fd8a9cf28211003fe521bd12e11e36b8f8cd3ce4a988b305d359c4d4c`。其 `z2(...,{graceMs:0,group:true})` 在没有显式 forceMs 时经 `Ukc()` 读取 `process.env.MIRASIM_REAP_FORCE_MS`，合法正数生效，否则默认 `10000`。本包 `src/adapter.ts:92-95` 仅用 `options.reapForceMs ?? 10000`，没有读取该环境变量。

**对照：** 在审查测试进程内设置 `MIRASIM_REAP_FORCE_MS=500`，不传 adapter 选项，1.4 秒后忽略 TERM 的主进程仍存活；同样注入式进程显式传 `reapForceMs:500` 时约 525ms 后主进程和同组子进程均消失。将指定原文件的实际 `z2/Ukc` 片段放到隔离进程、同样只设置该环境变量时，主进程不退出的组在 1.3 秒内已被回收；主进程提前退出时组 KILL 取消。该测试未更改正在运行的 mirasim 服务。

默认 10 秒、初始只 TERM 主进程和主进程先退出取消升级均实测符合本轮所列行为；**未证实调用方是否打算负责把该变量映射为选项**。若要求配置层也与参考一致，需实现或明确由宿主接线并测试默认、有效/无效环境值和显式选项优先级；若刻意不支持环境覆盖，须更正“完全对齐”边界并取得相应合同确认。blocked 的 SIGSTOP 是作者已明确披露的适配器自有设计，不冒称来自 mirasim。

#### R4-04 [P2] 多凭据引用组合的单点故障在现有测试中存活

原版对 `credentialRefs:['ref://fixture/path','not-a-reference']` 正确返回拒绝；没有创建伪造密钥或凭据文件。仅在隔离副本改变一处：把凭据引用校验改为**仅数组长度为 1 时执行**。typecheck 退出 0，现有本包测试 **57/57 通过**；独立的上述双元素反例按名失败。其余五个可编译单点变异分别被相应用例发现，见下表。

这证明现有测试未阻止“单元素正确、多元素放过明文样式”的回归；**不声称当前原版存在该放行**。要求补多元素中每一位置的非引用负例及全合法对照，并纳入变异标定。作者 50 个已列变异的结果不等于所有组合均有覆盖。

### 4. 第三轮回归与独立运行

| 检查 | 本轮实际观察 |
|---|---|
| `npm ci` / typecheck / lint / 全仓 test | 各退出 0；全仓 80/80，0 跳过 |
| 红提交独立 clone 与本包测试 | npm ci 退出 0；57 条按名字失败、0 跳过，名字均在绿版通过；红绿测试和假 CLI 文件 diff 为空 |
| R3-01 | 重放上轮迟到 milestone / blocked 反例，stopped 后均无迟到事件、不会重复 stop；独立 2 项通过 |
| R3-02 | 空白 resume 返回拒绝时冻结主进程仍存活；合法 resume 的原有对照通过 |
| R3-03 | 上轮 assistant 文本、非 JSON、提前 tool_use/result 五项负例及对照全部通过；现有允许的三种 pre-init system 帧按当前合同核验 |
| R3-04 | 仅去掉运行中 snapshot 守卫，typecheck 0；对应测试按名失败、无超时、无外部强杀、无遗留本轮 fake CLI；原版直接 R3-04 测试随全仓通过 |
| 独立停止进程 | 初始 TERM 只到主进程；主进程先退出时同组子进程不接收 TERM、过宽限仍活且可写中性标记；主进程忽略 TERM 时到期整组 KILL；默认实测约 10030ms。blocked 时父子组 `ps` 状态为 T；主进程未退出时快照拒绝，退出后可取 |
| F-03 负载定向复现 | 对“CLI 正常结束不发信号、同组孙进程仍活”这一条连续 20 次，20/20 通过；初段使用两个本轮 CPU 负载进程，1 分钟 load 超 100 后已只停止这两个进程，剩余轮次在自然负载下运行。期间观察 load 约 63.7–116.9，8 核；不是重新跑完整 57 条 20 次 |
| 填写本轮 reject 后 `run-all --local` | 退出 1；G-REVIEW 因 reject 拦截；G-PROVENANCE 尚未在已落盘轮次找到本轮 hash，因而同时报审查轮次厂商无法确认；不伪造会话记录补绿 |
| 当前 CI / smoke | self-check 已验证为指定产品 HEAD success；当前审查进程未设置 Anthropic 网关/认证环境，本轮未跑真实模型 smoke。`proof/smoke-real.txt` 从上一轮审查提交到本 HEAD 无修改；这只能证明仓库没有新增 smoke 证据，不能证明作者没有未记录的运行 |

**逐门禁独立负例：** 在临时普通 Git 仓库中运行真实 `run-all.ts --local`，分别输入：G-TRACE 缺失证据、G-REVIEW 作者自审、G-RED 缺红提交、G-STUB 只断言模块加载时的顶层值、G-TAUTO 恒真、G-WORKFLOW 使用 `pull_request_target`、G-LAYER 领域层反向依赖内核、G-PROVENANCE 审查记录缺 hash 调用。八例均退出 1、对应门禁及预期原因被观察到；合规对照退出 0。测试会话记录是隔离夹具，不是真实来源记录或凭据文件。

**独立单点变异：** 每次只改隔离副本一处并完成 typecheck。取消主进程 exit 时的组 KILL 计时器清理（M46）、stop 不封存（M47）、非法 resume 先杀进程（M48）、忽略非法 pre-init 帧（M49）、运行中允许快照（M41），相应用例均按名失败、无超时/强制清理；双凭据数组跳过校验的变异则 **57/57 存活**，独立双元素负例失败。未重跑作者全部 50 个变异，不把其 50/50 自报当作本轮观察。

执行器错误：M49 第一版变异写法产生 TS2339、typecheck 退出 2，不能算测试杀死；改为类型正确的单点变异后 typecheck 0、相应用例具名失败。旧版聊天工具名调用返回 `TypeError` 后，改用当前 `chat read` 成功核对 `g-group#2662`；请求一个已关闭的工具会话返回 unknown process id，均未当作产品结果。

### 5. 未测与交付范围

AC-07、AC-33④、V-06 整项仍未测：权威约束与副作用账、内核授权子集、真实 Claude 工具权限及真实模型事件映射不能由模拟 CLI/原型样本推断通过。用户已明确不采用容器；主进程先退出后同组及脱组后代可能继续运行是当前合同与已披露边界，本轮不因此打回，也不要求 Docker。

本轮只追加本节及更新收据 `review`。当前轮会话尚未结束、hash 调用尚未落入完整轮次记录，不宣称本轮 G-PROVENANCE 已通过。修复由作者进行，新产品 hash 需重新跨厂商审查。

### 第四轮补充：TDD 证据与汇报服务覆盖（g-group#2864）

**结论：维持第四轮 reject，将证据和测试覆盖缺口并入返修，不另计一次拒绝。** 不应通过倒回或重写历史来伪称最初实现时已先红；补写现状、补回归和变异也不能替代当时的先红证据。

1. **首次实现的历史边界。** `47f2106` 的 `mcp/report-mcp.mjs:2-3,24-26,49-51` 已包含 `constraintVer/openQuestions/doneSideEffects` 的 schema 与校验，注释称服务器来自原型。首红当时 21 条按名失败均由适配器空壳触发，不能证明这三个服务器字段的校验先于其实现而失败。首红测试已有 `constraintVer:-1` 的适配器行为用例和合法快照字段用例，但没有服务器 schema 的直接测试；并非完全没有相关间接用例。独立将 `47f2106` 原始服务器取出运行：`constraintVer:1.5` / `"3"`、`openQuestions:[1]`、`doneSideEffects:"fixture"` 均拒收，合法三字段对照接收；说明这些校验在后来新增直接测试之前已存在。注释所称外部原型的具体源码历史未在本次独立比对。
2. **后续 F-04 的红绿范围。** 在普通隔离副本分别检出 `fbac6de` 与 `98713f6`、各自 `npm ci`，同名直接 JSON-RPC 测试分别 0/1、1/1，红绿测试体与假 CLI 无差异。红版首次 RPC 调用即命中 `reportErrors` 空壳 `throw new Error("未实现")`，服务器退出 1、stdout 为空，测试因 `JSON.parse` 空输出报错；未实际处理到后面的三个字段反例。因此这证明的是共享校验器与 F-04 回归测试的具名红绿，不证明三个字段原始实现有各自的先红。作为对照，首红服务器对 F-04 新增的 `needs:1`、`stage:1`、未知字段均错误放行，修复这些新反例与既有字段的历史应分开看。
3. **两项字段单点变异。** 在仅含产品 HEAD `a134e8a` 的独立副本中，分别只删除 `openQuestions` 或 `doneSideEffects` 的一条校验；两次 typecheck 均退出 0，本包各自 56 绿、1 红、0 跳过，唯一失败均为同一个 F-04 直连用例，断言中对应不合规输入从拒收变为放行。正式变异集包含 M25（服务器绕过校验）、M29（constraintVer）、M31（未知字段），目前没有这两个专门变异。现有测试能杀死这两个故障；建议由作者将其纳入正式变异集，不能把此次临时变异当作正式集已更新。
4. **R4-05 [P2，测试缺口] `tools/list` 与 `REPORT_LOG` 未被现有本包测试有效保护。** 实际假 CLI 只握手 `initialize`、按连接状态自行向 init 加入工具名，再请求 `tools/call`；它不请求 `tools/list`。测试也没有设置或断言 `REPORT_LOG`，因此不能笼统说这两项已由适配器行为测试间接覆盖。独立原版对照：`tools/list` 返回 `report_progress`，设置中性临时日志路径后合法与非法调用依次写出 `valid:true/false` 的相应记录（本次按非法、合法顺序观察为 `[false,true]`）。分别单点变异为“`tools/list` 返回空数组”和“删除日志追加语句”：两次 typecheck 均退出 0，直接探针确认工具消失或日志未写出，但现有本包测试两次均 57/57 通过，0 跳过。**这是现有测试的漏检，不是宣称原版工具列表或日志已经损坏。**

**返修要求与门禁口径：** 作者在收据中如实说明首次三字段实现、后续 F-04 红绿以及原型复用部分的证据边界；为两个字段加入正式单点变异。补 `tools/list` 正反对照及经假 CLI 的工具发现/缺失路径，补 `REPORT_LOG` 合法与非法调用的记录正反对照，并用相应单点变异验证测试能发现清单为空或不写日志。首轮审查中“R-02 与具名红绿复现相符”仅指当时的机械具名测试结果；`G-RED` 检查声明红提交上的测试按名失败及当前通过，并不核实每段代码最早编写前是否已有针对性失败测试，不能把此结果扩大为三字段原始实现全部已证明 TDD。对历史先红缺证如何验收，应由项目规则或负责人明确，不能伪造补齐。

本补充所有变异只在临时独立副本运行，没有修改产品代码或正式变异集；审查对象仍是 `a134e8a`，补充时重新实跑指定 hash，原样输出仍为 `d515493cfe9f3a065c977fc8bc4191c4c72ff62139501c4867efdb2682bb81ef`。

---

## 第五轮（2026-11-06）：第四轮返修后的独立复审

**结论：reject。** 第四轮的 getter/Proxy、JSON `null`、forceMs 环境覆盖、多凭据及补充的工具发现/日志反例已复现修复；但本轮另发现额外字段值为 `undefined` 时被放行并启动执行器，以及 MCP 对未声明工具名返回成功。两项均需返修，不能用全仓及 CI 绿抵消。

### 1. 固定对象与独立证据

- 产品 HEAD `942659ce747581ceac0a72019524ef1f3915d737`，基线 `origin/feat/domain-core`（`afd02560f9546147da380382404eb6106222a9b8`）；红 `6e2c825b58b668f9067710c08ab2ff1c9551dd21`、绿 `cd43675`。审查使用普通独立 clone，测试、红版、变异和临时工作目录与其他会话隔离。
- 审查 `codex:592ebd7a-e738-43bd-a331-069366648d54`、模型 `gpt-6.1-terra`（OpenAI），作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`、`claude-opus-5-5`（Anthropic）；跨厂商。
- 在审查 clone 根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/cc-compute --base=origin/feat/domain-core`，原样输出 `9665e9f6fadbef48379655a9eea66b9dd88a3e7ee790871755c6e4e0916c3153`，与声明一致。GitHub self-check `42237714177` 在该产品 HEAD 已 completed/success。
- 本地证据仅保留于 `$E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr7-r5-evidence-codex-592ebd7a`：`$E/hash.txt`、`$E/{typecheck,lint,test,red-test}.log`、`$E/{gate-negatives.mjs,gates-negative.log}`、`$E/{independent-probes.mjs,independent-probes.log,previous-brief.ts,undefined-before-after.log}`、`$E/{single-mutations.mjs,single-mutations.log,single-mutations-summary.json,mutation-*.log}`、`$E/mcp-tools-spec.mdx`。脚本运行时使用审查用临时 clone 路径；若复现，需先按脚本路径重新准备相同版本的隔离副本。没有伪造密钥或凭据文件。

### 2. 必须修复

#### R5-01 [P2] 未声明字段值为 `undefined` 时被丢弃，brief 和 spawn 选项仍被接受并启动进程

位置：`packages/adapter-cc-compute/src/plain.ts:40-52`、`src/brief.ts:20-26,50-56`、`src/adapter.ts:76-84,309-329`、`src/report-schema.ts:46-52`。`plainData` 在白名单检查前跳过值为 `undefined` 的对象属性；因此实际有未声明自有字段的输入被当作没有该字段，违背 brief 只接受五个字段、额外 `memory`/`soul` 拒绝且不起进程的合同。

**独立反例：** 在未修改内置原型的环境，合法 brief 加自有 `memory:undefined` 后 `checkBrief` 返回 `ok:true`；`spawn` 返回 `ok:true`，注入 runner 实际写出中性 `outside-marker-0.txt`。合法 brief 搭配 `{outside:undefined}` spawn 选项同样被接受并写出 `outside-marker-1.txt`。`soul:undefined`、快照 `outside:undefined` 和汇报 `memory:undefined` 也分别被接受/没有错误。`memory:null` 对照正确拒绝；相同 `memory:undefined` 输入在上一产品版本 `a134e8a` 实际被拒绝（`$E/undefined-before-after.log`）。`undefined` 的值本身并非证明实际私人记忆外泄；问题是字段存在时未按合同拒收，且执行器确已启动。

**要求：** 在不调用 getter/setter/Proxy 的前提下，根据安全取得的自有描述符拒绝未知字段，不能因值为 `undefined` 而绕过白名单；对允许的可选字段如何处理 `undefined` 可单独明确。增加 brief、spawn 选项、快照和汇报的未知字段 `undefined` 负例、合法对照及不起进程的中性标记断言。

#### R5-02 [P2] MCP 将未声明的工具名当成 `report_progress` 成功处理

位置：`packages/adapter-cc-compute/mcp/report-mcp.mjs:28-36`。服务只在 `tools/list` 列出 `report_progress`，但 `tools/call` 分支不检查 `params.name`，对任何名字都直接按汇报参数校验、记录并回成功。

**独立反例：** 同一服务器进程依次请求 `tools/list`、调用 `name:"unknown_tool"` 和调用 `name:"report_progress"`，两者都以合法 `started` 参数传入。工具列表只有 `report_progress`，但未知工具返回 `isError:false`、文本“已记录。”；启用中性 `REPORT_LOG` 时两条均被记为 `valid:true`（`$E/independent-probes.log` 的 `OBS_TOOL_NAME`）。这证明服务错误接收和误记，**不证明未知工具实际执行了其他工具或已被映射为适配器事件**。[MCP 2025-06-18 工具规范的错误处理](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#error-handling) 将未知工具列为协议错误，示例使用 `-32602`。

**要求：** 在处理或记录汇报之前核对 `params.name`；未知或缺失名称返回适当协议错误，不能报“已记录”或作为有效汇报入日志。补未知/缺失名称与合法名称的直接 JSON-RPC 单开关对照及相应单点变异。

### 3. 第四轮返修与本轮运行

| 检查 | 本轮独立结果 |
|---|---|
| `npm ci`、typecheck、lint、全仓 test | 均退出 0；全仓 95/95、0 跳过 |
| 红提交 | 独立 clone、`npm ci` 后本包 72 条按名失败、0 跳过；这 72 个名字在绿版均通过，红绿测试及假 CLI 文件 diff 为空 |
| R4-01 | getter、嵌套 Proxy、撤销 Proxy、适配器选项 Proxy 独立反例均不调用即拒收，纯数据对照通过；新发现的未知 `undefined` 字段见 R5-01 |
| R4-02 | 坏 JSON 返回 `-32700`，`null`、数字、布尔、字符串、数组返回 `-32600`，同进程随后的 `tools/list` 正常 |
| R4-03 | 对照本机 mirasim 0.0.774 的 `Ukc/z2` 源码；独立子进程忽略 TERM 时，环境 `MIRASIM_REAP_FORCE_MS=400` 下约 403ms 后退出，stopped 的 scope 为 `main-then-group`；运行中快照拒绝。显式选项优先的函数对照及全仓进程组测试通过 |
| R4-04 | 多个引用位置分别换成非引用均拒绝，全合法对照通过；只检查最后一个元素的独立变异被具名测试发现 |
| R4-05 和历史 TDD 边界 | `tools/list` 和 `REPORT_LOG` 的原第四轮负例对应测试通过；M52–M55 已列入正式变异脚本；收据如实记录首红三字段缺少各自先红，后续红绿不冒充历史先红。但未知工具名仍可误接收，见 R5-02 |
| 七个独立单点变异 | 只检查最后一个凭据、跳过访问器、null 守卫缺失、工具列表空、日志不写、环境值压过显式值、退出后不清目录：每个 typecheck 0，对应测试均按名失败；无超时、无信号终止、0 跳过（`$E/single-mutations-summary.json`） |
| 每个门禁反例 | 在临时 Git 夹具调用当前真实门禁：G-TRACE 缺证据、G-REVIEW 自审、G-RED 缺红提交、G-STUB 只测顶层值、G-TAUTO 恒真、G-WORKFLOW 使用 `pull_request_target`、G-LAYER 领域层依赖内核、G-PROVENANCE 缺审查 hash 调用均按各自原因拦截；合规对照放行（`$E/gates-negative.log`） |
| 清理 | 在本轮独有 TMPDIR 中，全仓测试前后 `g-group-cc-*`、`fake-cc-*` 均为 0；变异分别使用自己的临时目录并清理。审查完成后移除本轮独立 clone、运行与构建产物，只留上述引用证据 |

本轮没有重跑作者全部 73 个变异，不把作者自报当作独立观察；没有重跑真实 Claude smoke。AC-07、AC-33④、V-06 的完整内核接线、真实 CLI 工具限制及真实模型事件映射仍未验证。用户已限定内置原型未被事先改写，且停止语义按 mirasim 而不是容器/后代树静止，本轮未以超出这两项边界的反例打回。
