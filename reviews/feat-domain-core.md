# PR #2 领域底座：独立复现审查

**结论：reject。** 作者的 14 条测试确实先红后绿，但不足以证明本片合同成立：原实现存在可复现的消息体引用泄漏；4 个破坏核心行为的变体仍然全部通过现有测试。不得把本次基础检查全绿等同于 AC-03 / AC-05 / AC-21 整项通过。

## 1. 审查身份与固定范围

- 审查人：`astra`；mirasim 会话：`codex:a29efe3a-4939-4f8c-ba7f-3e52222b56bd`。
- 实际模型：`gpt-6-astra`（OpenAI），来自本轮原生 Codex `turn_context.model`，不是收据示例或配置猜测。原生线程：`01a1aa49-ec71-71a1-b125-04507e8f3842`。
- 作者会话中触及本仓库的轮次实际模型为 `ai-iisbo-2/[kiro企业优化]claude-opus-5-5`、`ai-iisbo/[鸿运按量]claude-opus-5-5`，均为 Anthropic。已观察到的产出厂商与本轮审查厂商不同；没有用作者自报代替此核对。
- 源仓库：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group`，分支 `feat/domain-core`。
- 固定功能提交：`33fe57f65370e7729878fe21fe1fc33b51aeb040`；基线 `origin/chore/gates`：`b2a15c7b10e3e1520debf024e3dfb55974130c31`。
- 红提交：`dd7bf7a0708ed3856674a2c7bbc02c1e295afdd2`。红、绿测试文件的 Git diff 为空。
- 环境：Node `v25.8.1`、npm `11.11.0`；日期：2026-11-05。测试运行在两个固定提交的独立 detached worktree，所有故障注入另建副本；未改作者实现与测试。
- 本轮在源仓库根目录实际执行：

  ```sh
  node scripts/gates/run-all.ts --hash --branch=feat/domain-core --base=origin/chore/gates
  ```

  原样标准输出：

  ```text
  3b1798a514566edb18065e3b230e6a6c3b7c762c306c18160bc3c5d6bbb5e414
  ```

本报告只审这一个产品 PR，不替 PR #1 作批准，也不以等待 PR #1 合并为阻塞理由。当前活跃轮的 mirasim `turns.jsonl` 尚未落盘，因此这里不宣称本轮 `G-PROVENANCE` 已通过；不得伪造会话记录补门禁。

## 2. 独立执行结果

| 对象 / 命令 | 退出码 | 观察结果 |
|---|---:|---|
| 绿提交 `npm ci` | 0 | 安装成功 |
| 绿提交 `npm run typecheck` | 0 | 通过 |
| 绿提交 `npm run lint` | 0 | 14 个文件检查通过，无自动修复 |
| 绿提交 `npm test` | 0 | 14 通过，0 失败，0 跳过 |
| 红提交 `npm ci` | 0 | 安装成功 |
| 红提交 `npm test` | 1 | 同一批 14 条具名测试失败，0 通过、0 跳过；不是文件加载失败 |
| 绿提交附加独立探针类型检查 | 0 | 包含可变 body 反例，无 `any` 或强制类型断言绕过 |
| 绿提交附加独立探针 | 1 | 7 条中 5 通过、2 失败；两条失败均为 F-01 |
| 9 种行为变体各自 `npm run typecheck` | 全部 0 | 排除了类型错误 / 无法加载造成的假红 |
| 所有实验后重跑原绿提交 `npm test` | 0 | 仍为 14/14；红、绿 worktree 的 Git 状态均干净 |

既有机械门禁在未填写审查的原始绿提交上：`G-RED`、`G-STUB`、`G-TAUTO`、`G-TRACE`、`G-WORKFLOW`、`G-LAYER` 通过；整体退出 1，原因为 `G-REVIEW: 还没有独立审查`。这是原始状态，不是本次 reject 后的来源门禁结果。

### 具名先红后绿核对

以下每条均亲自观察到在 `dd7bf7a` 失败、在 `33fe57f` 通过：

1. 基于当前版本提交成功,版本号加一
2. 两人基于同一版本修改,后提交者收到版本冲突(阳性埋雷:去掉版本校验就会静默覆盖)
3. 冲突时当前值保持先提交者的内容
4. 多文档存储:改不同文档互不冲突(阴性对照)
5. 多文档存储:同一文档基于旧版本提交被拒绝,不存在的文档按版本 0 新建
6. 追加的事件序号递增并串成 hash 链
7. 原地改写旧记录会被 hash 链查出(阳性埋雷)
8. 编辑是一条新事件,原记录逐字节不变,投影显示新文字
9. 撤回只追加撤回事件,投影标记已撤回,原记录保留
10. 只改可见性的投影不改原记录 hash(阴性对照)
11. Compute 不能直接在群里发言(AC-03)
12. 联系人转述 Compute 结果可以发出(AC-03 阴性对照)
13. 只有原发言者能编辑或撤回自己的消息
14. 编辑或撤回的目标必须是存在且未撤回的消息

## 3. 必须修复

### F-01 [P1 / 正确性] append 保存外部可变 body 引用，纯函数层已可原地改写历史

位置：`packages/domain/src/log.ts:48-54`，尤其第 53 行 `body` 原样进入 `draft`。

调用方合法持有一个可变消息体，追加后再修改自己的对象，已提交日志随之改变；无需修改 `log.events`、无需类型绕过、无需 SQLite。独立探针经过 TypeScript 严格类型检查后真实执行：

```ts
const body = { kind: "message" as const, text: "原文" };
const log = append(emptyLog(), { kind: "user", id: "u1" }, body, at);
const before = JSON.stringify(log);
body.text = "后来修改";
assert.equal(JSON.stringify(log), before); // 实测失败
```

实测：事件数仍为 1，`project(log)[0].text` 已变成“后来修改”，原 hash 不变，`verify(log)` 返回 `{ok:false, brokenAt:1}`。同样修改已追加的 `edit` body，事件数仍为 2，投影出现未经新事件提交的文字，校验在第 2 条失败。

**影响**：违反 AC-05“禁止原地改写原记录”，且是本片自己承诺的内存层边界，不可推给存储适配器。`readonly` 只限制经该类型写入，不能隔离调用方原引用；`verify` 事后发现损坏不等于“禁止改写”。

**修复要求**：追加时建立不与调用方共享可变引用的事件快照，至少覆盖 message / edit / retract 的 body；补足“追加后改调用方 body，历史、投影与 hash 均不变”的测试。审查人未代改代码。

### F-02 [P1 / 测试] AC-05 的旧记录不变和链验证存在存活埋雷

位置：`packages/domain/src/log.test.ts:18-40,51-56`。

- **M01**：只删除 `verify` 的 `e.prev !== prev ||`，14/14 仍绿。现有篡改案例只改正文，无法证明逐项 hash 正确但前后脱链时会被拒绝。独立探针把第二条的 `prev` 改掉并重算该条 hash：原实现拒绝，M01 错误接受。
- **M05**：在编辑路径先原地改旧消息、重算后续链，再正常追加 edit，14/14 仍绿。第 36 行比较的是共享可变对象两侧，`before` 已经一起变了，不能证明“逐字节不变”。独立探针在调用前保存序列化快照，原实现通过、M05 失败。

**修复要求**：使用调用前的独立不可变快照比较整个原日志；对原地 UPDATE 路径实注入；补断链、前驱校验的独立反例。只添加“改正文但不重算 hash”的篡改样本不够。原实现目前会正确拒绝独立探针中的断链，本项是覆盖缺口，不把测试弱点冒充已有断链缺陷。

### F-03 [P1 / 测试] commitIn 不写入新内容、原地改输入 Store，现有测试仍全绿

位置：`packages/domain/src/cas.test.ts:28-42`；对应 `cas.ts:22-24`。

- **M06**：把 `out.set(key, { value: next, ... })` 改为已有文档仍保留 `cur.value`，14/14 绿。当前多文档阴性对照只验证版本号 `[1,1]`，即使显示“成功”却没写新正文也通过。
- **M07**：把 `new Map(store)` 改成直接修改原 Store，14/14 绿。未证明纯函数“不改入参”的合同。

独立探针断言两个文档的新内容、未改文档的旧内容、原 Store 调用前后的序列化快照：原实现通过，M06 / M07 分别失败。

**修复要求**：对成功写入和新建断言真实 `value`、`ver`；对不同 key 的单开关对照断言彼此内容与版本；对成功和冲突路径保存输入快照并验证不变。当前 CAS 判断本身在已测顺序调用中工作，问题不是宣称现有实现已丢内容，而是必须的行为可被破坏而测试不红。

### F-04 [P1 / 验收范围] 三项“通过”超过实际证据，第 7 栏不能抵消状态误报

位置：`receipts/feat-domain-core.json:4-6,12`；作者证明文件 `packages/domain/proof/domain-core-tests.txt`。

- AC-05 原实现已在内存层失败，不能继续标“通过”。
- AC-03 只验证 `append` 参数，未观测文档指定的消息表 `sender_kind`、宿主其他写入入口；完整 AC 仍未测，不能把入口单测当整项通过。
- AC-21 只有调用者主动传入最新状态后的顺序比较，未证明两人共享存储的单一原子提交点。直接对同一个旧 `cell` 分别调用两次 `commit`，两次均返回成功；这正是纯函数需依赖外部事务的边界，不是纯函数 CAS 比较本身的实现错误。
- 证明文件只有 14 条绿输出，没有故障注入、存活埋雷、落盘或并发证据；红提交可独立重跑，但树中没有单独保存的红运行输出。

**修复要求**：按 R-08 / 收据四状态修正 AC-05 为失败；未覆盖的整项 AC 不写通过，明确标未测与原因，并在 slice / 证据中列出已通过的纯函数子判据。补实际双侧标定与埋雷存活清单。只做本片所需修正即可，不要求先把整个产品做完，也不阻塞其他独立切片继续开发。

## 4. 按 AC 四栏核对

| AC | 必须 | 禁止 | 阳性埋雷实测 | 阴性对照实测 / 判断 |
|---|---|---|---|---|
| AC-03 | User / Contact 可经 append 入日志；用户与联系人普通消息已执行 | compute 的 message 被 `sender-not-allowed` 拒绝；删除该限制则具名测试红 | M02 放行 compute → 13 绿 / 1 红，红因为缺少预期异常，鉴别有效 | 原作者联系人转述案例绿，但输入还同时改变 id / 文本，不是严格单开关；独立补同 body、id、at 只切 kind 的 compute/contact 对照通过。消息表、宿主总入口未测；Helper 口径见下一节 |
| AC-05 | 常规 edit/retract 追加事件、投影文字/撤回状态正确，独立快照对照通过 | 禁止原地改旧记录尚未成立：F-01 外部 body 别名已破坏历史；“纠正”没有独立事件类型/测试，只能解释为 edit 的范围 | 删除正文校验 M08 会红，固定错误 prev 的 M09 会红；但删除前驱检查 M01、编辑时原地 UPDATE 并重算链 M05 都存活，因此该栏不充分 | 原作者撤回前后旧 hash 相同的对照通过，独立 edit/retract 快照对照也通过；只能证明这些已执行路径，不覆盖别名与任意可见性操作 |
| AC-21 | 当前版本成功、版本递增；同文档旧版本拒绝，顺序纯函数层通过 | 去掉 commit / commitIn 版本判断均被发现；真实并发静默覆盖没有测 | M03 / M04 各出现 1 条针对冲突的具名失败；但 M06 / M07 存活，成功内容与输入不可变未受保护 | 原作者改不同文档成功，但只看版本；独立补同提案只切 key 的对照，检查新旧内容与输入 Store，原实现通过。持久化单一提交点未测 |

## 5. R-02 / R-03 / R-04

| 规则 | 判断 | 独立证据与限制 |
|---|---|---|
| R-02 先红后绿 | 红提交可复现，14/14 具名先红后绿 | 两个提交的测试体相同，红提交是绿提交祖先；本次保存了完整红输出。作者仓库原证明文件只有绿输出；历史上何时实际跑过不从提交说明推断 |
| R-03 空实现红基线 | 本次执行范围通过 | 除重跑原门禁外，逐个把导出函数体替换成抛出 `ASTRA_STUB:<symbol>` 的空桩：emptyLog 9 红、append 9 红、verify 3 红、project 4 红、cell 4 红、commit 3 红、commitIn 2 红。全部 14 条测试都有相关桩激活；不是加载失败 |
| R-04 非同语反复 | 真实符号调用与机械检查通过，但不能据此认定行为覆盖充分 | 作者测试直接导入真实函数、没有 mock / 复制 hash 算法 / 恒真断言，G-TAUTO 绿；F-02 的共享引用比较以及 F-03 的只验版本仍能被有效变体骗过。R-03 与 R-04 的通过不能替代逐 AC 的双侧标定 |

独立断链探针手工构造损坏输入需要重算单条摘要；它是本次审查的反例构造，不是作者测试复制被测算法来证明算法正确。

### 行为变异完整清单

| 变体 | 单项改变 | 作者测试结果 | 判断 |
|---|---|---|---|
| M01 | verify 删除前驱关联检查 | 14 绿 / 0 红 | 存活，F-02 |
| M02 | assertSender 放行 compute | 13 绿 / 1 红 | 被杀，AC-03 有效 |
| M03 | commit 删除版本检查 | 13 绿 / 1 红 | 被杀，AC-21 冲突检查有效 |
| M04 | commitIn 删除版本检查 | 13 绿 / 1 红 | 被杀，AC-21 冲突检查有效 |
| M05 | 编辑时原地重写旧事件及链，再追加 edit | 14 绿 / 0 红 | 存活，F-02 |
| M06 | commitIn 已有文档保留旧 value | 14 绿 / 0 红 | 存活，F-03 |
| M07 | commitIn 原地修改输入 Map | 14 绿 / 0 红 | 存活，F-03 |
| M08 | verify 删除正文 hash 校验 | 13 绿 / 1 红 | 被杀，正文篡改检查有效 |
| M09 | append 的 prev 一律为 GENESIS | 12 绿 / 2 红 | 被杀，基本串链检查有效 |

四个存活变体均由额外独立断言证实为非等价变异：对应新增断言原版绿、变体红；不是未执行到修改点的猜测。每种变体是隔离副本，未在运行中改 runner 或混叠多种故障。

## 6. 第 7 栏真实性及遗漏

作者写出的三项边界中：

1. **存储层尚未闭环**属实，没有 SQLite、拒绝 UPDATE/DELETE 的触发器与落盘读回证据；但“AC-05 目前只在内存里的纯函数层成立”被 F-01 直接否定。
2. **CAS 纯函数不是事务**属实，已亲自执行相同旧快照上的两次成功提交。真正共享最新版本的读写、并发争用、重启恢复需后续适配器证明。
3. **Compute 限制只在 append 入口**属实，目前没有宿主全入口覆盖证据。

漏掉的边界 / 文档口径：

- 输入引用所有权及已有快照不可变性（F-01）；哈希链关联校验、编辑原地 UPDATE 与成功写入内容的测试鉴别力（F-02 / F-03）。
- `SenderKind` / `SENDERS` 包含 helper（`log.ts:7,26`），但固定 AC-03 行只列 User / Contact。用户最新三入口要求允许被 @ 的 Helper 在会话展示，因此**不能机械要求删掉 Helper**；当前 append 没有 @ 或入口来源参数，也不能独自保证“仅被叫到时作答”。须统一 AC 与最新需求，并由宿主明确覆盖全局 / 侧栏不进消息、@ 入口才进消息的行为；本片没有该证据。
- `verify` 证明的是传入链的内部一致性，不等同于真实作者授权、存储不可改或完整历史证明；本次未把它当作这些更强保证。
- 未做 UI、消息表、并发事务、跨进程重启、负载测试；不作体验、性能上界或完整产品验收结论。AC-15 / AC-31 已标未测的状态保留。

## 7. 证据位置与重审条件

本机持久证据目录（未提交到功能 PR）：

`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-review-evidence/pr2-33fe57f-a29efe3a/`

- `identity.json`、`provenance-observed.json`、`spec-hashes.json`：提交 / 会话 / 实际模型与文档摘要。
- `green-results.json`、`red-results.json`、`green-*.log`、`red-*.log`：逐命令退出码与原始输出。
- `mutations.json`、`run-mutations.py`、`M*.patch`、`M*.log`、`S-*.log`：9 个行为变体、7 个逐符号空桩及具名结果。
- `independent-probes.mts`、`probe-results.json`、`probes.log`、`*-independent.log`：原版失败反例与存活变体的独立鉴别。
- `green-source.tar`、`red-source.tar`、`README.md`：固定输入与可重建执行方法；`SHA256SUMS.json` 校验上述工件。

重审最低条件：F-01 修正并增加真实回归；F-02 / F-03 的四个存活埋雷被针对性测试杀死；阴性对照仍绿；F-04 的收据状态与第 7 栏据实收口；重新跑基础检查、红基线、双侧标定与新内容 hash。仍由不同厂商模型独立复现，不以作者自检代替。

本次仅提交本审查文件和 `receipts/feat-domain-core.json` 的 `review` 字段，未修改产品源码、测试、作者验收声明或其他收据字段。

## 重审

### 2026-11-05：8431601，结论仍为 reject，剩两处定点测试缺口

**主要实现修复有效，但还不能批准本轮。** 上次的 body 引用缺陷已消失，原先 4 个存活变体已被挡住，完整 AC 的状态也已改为未测；本轮剩余阻塞是两个既有合同的回归测试未闭合，不是要求增加产品功能或提前完成存储层。

#### 固定版本、身份及 hash

- 功能提交：`8431601e2689201a6eece0092a833ac209016e6f`。
- 红提交：`bc28ed2ab10df5a0867937a286c95838b7a2d77a`；基线仍为 `origin/chore/gates` 的 `b2a15c7b10e3e1520debf024e3dfb55974130c31`。
- 审查人 / 会话：`astra` / `codex:a29efe3a-4939-4f8c-ba7f-3e52222b56bd`。
- 本轮实际 `turn_context.model`：`gpt-6-astra`，OpenAI。重新读取作者会话中触及本仓库的轮次，实际模型仍为上述两种路由前缀的 `claude-opus-5-5`，厂商集合为 Anthropic。不同厂商条件成立；作者没有自判批准。
- 审查期间原共享目录被并行开发切到 `feat/task-lifecycle`，HEAD 为 `720d683`。没有切回或改动该工作树；本审查继续使用自己已固定在 `8431601` 的独立 worktree，并将它检出为 `feat/domain-core`。此前在已换分支目录上取得的 `44731d…` **不是本轮受审 hash，不采用**。
- 本轮在受审 worktree 的仓库根目录 `/private/tmp/g-group-pr2-rereview-aj_r9ge8/green` 实际执行以下原命令：

  ```sh
  node scripts/gates/run-all.ts --hash --branch=feat/domain-core --base=origin/chore/gates
  ```

  原样标准输出：

  ```text
  9e16ca6b83e9f863f544d9240bcb98fc84a4abce28ddf8925444ded579f6b78b
  ```

#### 独立执行，而非采信作者输出

| 检查 | 观察结果 |
|---|---|
| 绿版 npm ci / npm run typecheck / npm run lint | 分别退出 0；lint 无自动修改 |
| 绿版 npm test | 退出 0；19 通过，0 失败，0 跳过 |
| 红版 npm ci / npm test | 安装退出 0；测试退出 1，19 条具名失败，0 通过 / 跳过；逐名字与绿版匹配，不是文件加载失败 |
| 红绿测试文件连续性 | `git diff bc28ed2..8431601 -- packages/domain/src/{log,cas}.test.ts` 为空 |
| 原门禁 runner | G-RED / G-STUB / G-TAUTO / G-TRACE / G-WORKFLOW / G-LAYER 均绿；原始收据 review=null，G-REVIEW 报“还没有独立审查”，整体退出 1 |
| 作者 mutations.mjs 亲自重跑 | 原样 19/19；M01–M12 均有具名测试失败，脚本退出 0 |
| 独立逐个再注入 M01–M12 | 12 种全部被杀；保留完整 TAP，逐次确认全部 19 个测试均执行，未把文件级错误当具名失败 |
| 本轮 16 种行为变体的类型检查 | 全部通过；没有用语法错误、加载错误冒充测试鉴别力 |
| 上次独立探针复跑 | 7/7 通过；原先 message / edit body 别名两条由红变绿，正文保持原值，verify 为 ok:true |
| 本轮额外独立探针 | 5/5 通过且严格类型检查通过：覆盖三种 body、sender、投影隔离、五层冻结、真实冲突输入快照及旧快照边界 |
| 实验结束后重跑绿版 | 仍然 19/19；产品源码与测试保持原样 |

#### 上轮意见逐条收口

| 原意见 | 本轮判断 |
|---|---|
| F-01 引用导致历史改写 | **实现缺陷关闭。** message / edit / retract 与 sender 均经过合同字段快照；调用方后续改对象不影响历史、投影、hash。实际已提交对象的冻结也有效；相应回归覆盖仍有 RR-01 |
| F-02 断链与原地编辑变体存活 | **关闭。** M01 被“单条 hash 自洽但与前一条脱链”杀死；M05 原地写旧事件被冻结保护阻止，测试失败；新编辑测试保存了调用前独立序列化快照 |
| F-03 CAS 内容与输入不变未验证 | **部分关闭。** M06 保留旧正文、M07 原地修改输入 Store 都被杀；新建 / 更新的 value、ver 已断言。但冲突路径比较错对象，RR-02 未关闭 |
| F-04 验收范围误报 | **关闭原主要问题。** AC-03 / AC-05 / AC-21 全部标未测，并分别说明宿主入口 / 落盘 / 事务缺口；已测纯函数子判据与整项验收分开。R-02 的红提交可独立复现；R-05 的“通过”只支持已实际执行的 12 种变体，不证明以下拆开的子判据 |

#### RR-01 [P1 / 合并前必补] M12 多层同时取消冻结，红因不能证明事件外壳不可改

位置：`packages/domain/src/log.test.ts:88-93`；`packages/domain/proof/mutations.mjs:25`。

“已提交的事件对象不可被改写”实际只尝试修改 `e.body.text` 与 `log.events.push(e)`。M12 同时取消事件、事件数组、日志外壳三层冻结。独立保留的完整 TAP 显示：它在 **log.test.ts:92 的数组 push 缺少预期 TypeError** 处失败，不是在改事件外壳处失败。

把三个不同保护单独拆开，结果如下（每次只改一个点，其他源码与 19 条测试不变）：

| 独立变体 | 作者测试 | 独立断言 |
|---|---|---|
| R13 仅去掉 `Object.freeze({ ...draft, hash: hashOf(draft) })` 的事件外壳冻结 | 19/19 绿 | `Object.assign(e,{seq:99})` 不再抛 TypeError，断言红 |
| R14 仅去掉 sender 的 freeze，仍然拷贝 kind / id | 19/19 绿 | `Object.assign(e.sender,{id:"冒充"})` 不再抛 TypeError，断言红 |
| R15 仅去掉返回日志外壳的 freeze，事件和数组继续冻结 | 19/19 绿 | `Object.assign(log,{events:[]})` 不再抛 TypeError，断言红 |

原实现对以上三种改写均正确抛 TypeError；因此本项是**具体测试假阴性**，不把未发生的实现错误写成现状。三种变体均通过 typecheck，不是无效变异。

**定点修复**：分别断言事件顶层字段、事件 sender、body、数组、日志外壳不能被改写，并核对失败操作后完整快照 / hash 不变。把 M12 拆成能独立覆盖各保护点的埋雷，勿再用“数组冻结产生的红”代替“事件冻结已被验证”。这些都是本片已有的不可改写合同，不要求增加新的业务能力。

#### RR-02 [P1 / 合并前必补] CAS 冲突路径保存、比较的不是本次入参

位置：`packages/domain/src/cas.test.ts:43-52`。

第 49 行冲突调用传入的是 `ok.store`，第 52 行却继续比较第一次成功调用之前的 `store` 与 `saved`；对真正的冲突输入只检查了 `.value`，没有检查版本或整份 Store。

独立变体 R16 仅在 `commitIn` 冲突分支增加下面这一处错误副作用，保留原有冲突返回值：

```ts
if (curVer !== expectedVer) {
  if (cur) Object.assign(cur, { ver: curVer + 1 });
  return { ok: false, reason: "version-conflict", currentVer: curVer };
}
```

**实测作者测试仍为 19/19 绿。** 对真正入参保存 `JSON.stringify([...store])` 再比较的独立探针：原版绿、R16 红；冲突已经偷偷推进版本，虽然返回的 currentVer 仍为 1、正文未变。该变体也通过 typecheck。

**定点修复**：冲突调用前保存 `ok.store` 的独立完整快照，调用后比较同一个 `ok.store`；包含文档版本和未改键。把冲突时更改 version 的埋雷加入校准，确认针对性测试红且正常冲突仍绿。`cas.ts` 原实现此路径没有改入参，无需为了本意见发明新的 CAS 机制。

#### AC 四栏及第 7 栏复核

| AC | 必须 | 禁止 | 阳性埋雷 | 阴性对照与范围 |
|---|---|---|---|---|
| AC-03 | user / contact 普通消息通过 | compute 被 sender-not-allowed 拒绝 | M02 具名失败，已独立复现 | 同 body / id / at 只切 sender kind 的对照成立；helper 允许是三入口需求的预留。`@` 条件本片没有输入、不能验证，宿主总入口 / 消息表整项保留未测 |
| AC-05 | edit / retract 追加事件，独立历史快照、投影、hash 正确；body 引用缺陷已修 | 现实现的五层不可改写探针通过 | M01 / M05 / M08–M12 被杀，但 R13–R15 仍存活，不能声称冻结所有子判据已标定 | 只改投影不改日志成立；存储落盘未测。剩余阻塞仅为 RR-01 的回归与单点校准 |
| AC-21 | 当前版写入 value / ver，旧版拒绝；新建与不同文档内容正确 | 现实现无顺序静默覆盖、无输入修改 | M03 / M04 / M06 / M07 被杀，但 R16 冲突错误改版本仍存活 | 独立同一快照只切 key 的对照通过；作者同名对照的两次调用使用先后状态，不能仅凭测试标题当严格单开关证明。共享存储原子提交仍未测 |

第 7 栏关于纯函数不是事务、同一旧快照两次提交都成功、Helper 三入口须由内核路由保证、hash 只证明链内自洽的边界均与本次观察相符。补充两点：

- 12 种变体的覆盖上界已经说明，但 M12 复合变异留下 RR-01；“两条路径都不改入参”还留下 RR-02。
- `Object.defineProperty` **不能改写这些已冻结对象的现有字段**：独立探针尝试改已冻结事件的 hash，实际抛 TypeError。第 7 栏“冻结以外的约束”若泛指授权 / 路由应如此明确写，不应理解成反射能够绕过本实现的冻结。这是措辞澄清，不另列合并阻塞。

R-02 的具名先红后绿、R-03 的当前空桩门禁、R-04 的真实符号检查本轮均已亲自运行；它们的通过仍不能替代上述单点反例。未运行真实存储、并发事务、宿主入口或 UI，不改变整项未测状态。

#### 本轮证据与下一次重审边界

持久证据：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-review-evidence/pr2-8431601-a29efe3a/`。

- `results.json`、`named-red-green.json`、`green-*.log`、`red-*.log`：命令、退出码与 19 条按名比对。
- `independent-mutations.mjs`、`mutations.json`、`M*-change.json`、`M*.log`：独立重复 M01–M12，保留具名红因。
- `R13`–`R16` 的 `*-change.json`、`*.log`、`*-typecheck.log`、`*-probe.log`：四个单点存活变体及非等价证明。
- `reviewer-probes.mts`、`previous-review-probes.mts`、`probe-results.json`：新旧独立探针；当前原实现全部通过。
- 两个源码归档、`identity.json`、`provenance-observed.json`、`reviewed-hash.txt`、`README.md` 和 `SHA256SUMS.json`：固定输入、来源与复现方法，83 个证据文件已逐一校验。

下一轮仅需定点补 RR-01 / RR-02 的测试与校准，保留负例红、正常路径绿，并提供新红提交 / 新内容 hash；不撤销已经关闭的 F-01 / F-02 / F-04，也不以其他切片未完成为阻塞。审查提交仍只追加本节并更新收据 review 字段。

### 第三轮：2026-11-05，133cf7a，当前审查结论 approve

**批准本 PR 的纯函数切片；RR-01、RR-02 均已通过独立复现关闭。** 前两轮 reject 是各自版本的历史结论，予以保留。本轮没有发现该切片范围内剩余必须修项；不把批准代码审查等同于完整 AC 验收或已经合并。

#### 版本及跨厂商身份

- 固定功能提交：`133cf7abcf6c897653f5b91647202c4ac963f231`。
- 红提交：`abe754eab4911d6f8a1bd6c686cdfe1cdbc05210`；基线：`origin/chore/gates` = `b2a15c7b10e3e1520debf024e3dfb55974130c31`。
- 审查人：`astra`；会话：`codex:a29efe3a-4939-4f8c-ba7f-3e52222b56bd`；本轮原生 `turn_context.model` 为 `gpt-6-astra`（OpenAI，2026-11-05T07:31:01.774Z）。
- 作者的 mirasim 已落盘轮次仍为 Anthropic。为避免仅凭旧轮次推断本轮生产模型，又读取其原生 Claude 记录的工具调用 / 结果，不读取推理块：本次写入 M12a–M12e、`savedConflictInput`，以及产生 `abe754e` / `133cf7a` 的 Bash 调用，实际模型均为 `ai-iisbo-2/[kiro企业优化]claude-opus-5-5`。相应调用 UUID 和时间保存在 `author-native-provenance.json`，其中生成 `133cf7a` 的调用为 `e420bf85-8b59-474f-988a-669ffee04898`（07:25:51.668Z）。跨厂商硬条件成立，不用作者自报或作者自检代替。
- 使用普通独立 clone `/private/tmp/g-group-pr2-review3-lnhg9zta/green`，独立 `.git` 目录；红版为另一普通 clone。未切换或修改正在开发 PR #3 的原工作树，也未在 linked worktree 内运行 pre-push 自检。
- 核对 `8431601..133cf7a`：`log.ts`、`cas.ts`、`errors.ts`、`index.ts` 与门禁代码 / 钩子没有差异。本轮是已审实现的测试与证据补强，没有混入 PR #1 或 PR #3 的实现。

在上述受审 clone 的仓库根目录，本轮实际运行：

```sh
node scripts/gates/run-all.ts --hash --branch=feat/domain-core --base=origin/chore/gates
```

原样标准输出：

```text
e877562242a309d30b8b4d1cacac196358f1e071d517c63237b8efe9e1481413
```

#### 独立执行结果

| 检查 | 实际结果 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 各退出 0；lint 未改文件 |
| 绿提交 `npm test` | 退出 0，23 通过 / 0 失败 / 0 跳过 |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1，23 条具名失败；名称集合逐条与绿版相同，不是文件级失败 |
| 红绿测试体 | `git diff abe754e..133cf7a -- packages/domain/src/{log,cas}.test.ts` 为空 |
| 作者 `mutations.mjs` 本轮亲自运行 | 原样副本 23/23；17 个变体全部有具名失败；脚本退出 0 |
| 独立执行器重复注入 | 从固定源码读取 17 个注入定义，另行运行并保存完整 TAP；每次均实际执行全部 23 条具名测试，17 个全部被杀 |
| 上轮 R13–R16 原样复放 | 4 个全部由对应作者测试杀死；不只运行作者重新改写的变体版本 |
| 上述 21 次变体运行的 typecheck | 全部退出 0，排除语法 / 加载故障导致的假红；21 次包括 17 个声明变体和 4 个旧变体复放，不声称 21 种互异故障 |
| 两组既有独立探针 | 7/7 与 5/5 通过，严格类型检查通过；body / sender 快照、五层冻结、投影隔离、冲突快照及旧快照边界均保持正确 |
| 变异完成后重跑原版 | 仍为 23/23；源码和测试未被审查修改 |
| 填审查前的门禁运行 | G-TRACE / G-RED / G-STUB / G-TAUTO / G-WORKFLOW / G-LAYER 通过；G-REVIEW 因原始 review=null 报“还没有独立审查”。该次整体退出 1，不冒充全门禁已通过 |

#### RR-01：五层冻结单独标定，关闭

五条测试分别对真实返回对象检查 `Object.isFrozen`，再尝试写入并要求抛 `TypeError`。单独取消每一层保护，实测分别为 **22 绿 / 1 红**：

| 单点变体 | 精确失败的作者测试 |
|---|---|
| M12a 事件对象不冻结；旧 R13 同样被杀 | 已提交事件本身冻结:不能改 seq、hash 等字段 |
| M12b sender 不冻结；旧 R14 同样被杀 | 已提交事件的 sender 冻结 |
| M12c message body 不冻结 | 已提交事件的 body 冻结 |
| M12d 事件数组不冻结 | 日志的事件数组冻结:不能追加或替换 |
| M12e 日志外壳不冻结；旧 R15 同样被杀 | 日志外壳冻结:不能把 events 换成另一份数组 |

不再依靠“数组没有冻结”的红因替代事件或 sender 冻结证据。原样实现与独立五层探针保持绿。本轮关闭的是上述已执行的保护点；17 项校准不被解释为穷尽所有可能错误。

#### RR-02：真正的冲突入参快照，关闭

CAS 测试现在在调用前令 `conflictInput = ok.store`，保存 `snapStore(conflictInput)`；调用后比较**同一个** `conflictInput` 的完整快照，另断言该文档保持 `{ value: "改", ver: 1 }`。

- 作者 M07b（冲突时用 Map.set 偷偷推进输入版本）：22 绿 / 1 红。
- 上轮原样 R16（冲突时原地修改 cell.ver，而非替换 Map 项）：22 绿 / 1 红。
- 两者均由“多文档存储:成功和冲突两条路径都不改输入 Store”发现；完整原样实现仍绿。此前比较错 Store 的缺口已闭合。

#### AC、R 规则及批准范围

| 条目 | 本轮收口 |
|---|---|
| AC-03 | append 的 compute 禁止分支及 contact 单开关阴性对照有效，M02 被杀；宿主总入口、消息表、Helper 三入口路由仍未测，收据整项未测保持不变 |
| AC-05 | 常规编辑 / 撤回追加、调用前快照、body / sender 引用隔离、正文 hash 与前驱关联、投影不改日志、上述五层冻结均有执行证据与相应变体；落盘拒绝 UPDATE/DELETE 仍未测 |
| AC-21 | 顺序版本冲突、成功内容 / 版本、新建、不同 key 对照、成功与冲突输入不变均有证据；同一旧快照两次提交仍可各自成功，单一持久化事务提交点未测 |
| R-02 / R-03 / R-04 | 23 条按名红绿、当前空桩门禁、真实符号 / 非恒真检查已执行；没有因测试增加而丢掉原有反例 |
| R-05 | 声明的 17 个故障已独立实注入，并原样复放上轮 4 个存活变体；本次执行集合中无存活项，原样副本与既有独立阴性对照均绿 |

第 7 栏关于存储、事务、Helper 路由、hash 不证明授权的边界继续保留。上一轮对 `Object.defineProperty` 措辞的澄清仍成立：它不能改写已经冻结的现有字段，不把该句解读为发现了新的冻结绕过。AC-15 / AC-31 也继续未测。

**本轮 approve 只表示 PR #2 当前纯函数切片通过独立代码 / 行为审查。** 不代表 PR #1 已批准、不绕过合并顺序、不宣称本轮 G-PROVENANCE 自动门禁已经验真，也不把整项 AC 或用户验收改为通过。PR #3 尚未审查，等单独派审后再处理，不在这里顺带批准或扩大范围。

#### 本轮工件

持久证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-review-evidence/pr2-133cf7a-a29efe3a/`。

- `results.json` / `named-red-green.json` / `green-*.log` / `red-*.log`：逐命令状态与 23 条按名核对。
- `independent-mutations.mjs` / `mutations.json` / `M*.log` / `R*.log` / `*-change.json`：全部 21 次独立注入及红因；类型检查输出另存。
- `reviewer-probes.mts` / `previous-review-probes.mts` / `reused-probes.json`：既有独立探针原样复用及摘要。
- `author-native-provenance.json` / `provenance-observed.json` / `identity.json` / `reviewed-hash.txt`：实际生产与审查来源、固定提交及本轮 hash。
- 两个源码归档、复现 README 与 `SHA256SUMS.json`：100 个证据文件逐一校验通过。

只追加本节并填写收据 review；原有审查历史及作者其他收据字段逐字节保留，产品代码与测试不改。
