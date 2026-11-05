# PR #3 · 任务生命周期独立复现审查

## 结论：reject

本轮是独立审查结束，**不是任务状态机验收通过**。5 组必须返修项见下文；实现与补测交回 Claude Code 原开发任务，审查人没有修改实现代码。PR #2 的领域底座与 PR #1 的门禁修复不并入本轮。

- 对象：`feat/task-lifecycle`，`c6ca6941bff01f289136299d1e8039a6ee5aef0f`。
- 基线：`origin/feat/domain-core`，本轮固定为 `133cf7abcf6c897653f5b91647202c4ac963f231`；不是 `main`。
- 审查人：Astra；会话 `codex:fe55ba38-c68b-4127-b71b-1303a0e7b3c7`；实际模型 `gpt-6-astra`（OpenAI）。本轮原始 Codex `turn_context.model` 已核对。
- 作者会话：`claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`；本机原始 assistant 记录中的实际模型为两个渠道前缀下的 `claude-opus-5-5`（Anthropic，排除 `<synthetic>` 系统记录）。审查与实现不同厂商，不使用豁免。
- 环境：macOS，Node `v25.8.1`、npm `11.11.0`；普通独立 clone，`.git` 与 common dir 均为本 clone 的 `.git`，不使用共享 linked worktree。
- 审查范围：`task.ts`、`vendor.ts`、对应测试与变异脚本；对照仓库需求 D20.3、AC-09/19/26/28、R-01/02/03/04/05/09 和概念卡 v2。
- 在仓库根目录实际运行指定命令：

```sh
node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core
```

原样输出：

```text
fb306d3f832808a9d070539e9e6b370fe848c2b8d32fe2ee5d9f8081c428eb0f
```

## 1. 亲自运行的结果

| 操作 | 实测结果 |
|---|---|
| `npm ci` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | exit 0，56 通过、0 失败、0 跳过 |
| 独立 clone 检出 `c8de913bb05ea00d13dcb6a4dde8033db326a011`，运行 `node --test --test-reporter=tap "packages/**/*.test.ts"` | exit 1，23 通过、33 失败；新增 `task.test.ts` 和 `vendor.test.ts` 的 33 个测试名与失败名集合完全相等，缺失 0、多余 0；不是文件加载失败冒充红 |
| 比较红提交与绿提交的两份新测试 | 无差异；旧卡迟到回复的回归测试也在红提交中 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0；原样 56 绿，34 个单故障变异均产生具名失败。不是照抄作者 proof |
| 自建 14 个独立单故障变异 | **10 个存活，仍 56/56 通过；4 个被杀。14 个均通过 typecheck**，排除语法/类型错误导致的假杀死 |
| 自建状态/契约探针 11 条 | 5 绿、6 红；其中 4 条是下文实现缺陷，另 2 条是停止/终态重开契约探索，单列范围差异，不直接当成 2 个已定案实现 bug |
| AC-09 新增 `ProbeNoOp` 并补全所有行及样例 | typecheck 与 56 条测试均 exit 0；形成“新增事件且每格完整”的独立阴性对照 |
| 仓库门禁命令（相同 branch/base） | G-RED、G-STUB、G-TAUTO、G-TRACE、G-WORKFLOW、G-LAYER 通过；审查前 G-REVIEW 因尚无 review 失败。reject 收据写入后仍应阻止合并，不能将这个预期红门禁称为实现通过 |

本机完整证据目录：
`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review-evidence-fe55ba38/`

主要文件：`npm-ci.log`、`typecheck.log`、`lint.log`、`test.log`、`red-test.log`、`author-mutations.log`、`independent.test.mjs`、`independent-test.log`、`observations.mjs/json`、`independent-mutations.py`、`mutants/results.json`、每个变异的 `.patch/.test.log/.typecheck.log`、`added-event-*.log`、`gates-before.log`。这些是审查隔离副本与日志，不提交进产品源码。

**来源门禁的实测剩余项**：写入 review 后实际运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`，exit 1：G-REVIEW 因 reject 按预期失败；G-PROVENANCE 另报 `审查会话记录不存在:codex:fe55ba38-c68b-4127-b71b-1303a0e7b3c7`。本轮活动会话已有 record.json 和原始 Codex rollout，但该门禁读取的 mirasim `turns.jsonl` 尚未落盘，故**没有声称 G-PROVENANCE 已通过**。待会话记录落盘后需由原任务复跑；不写伪造会话记录、不换成别人的 session、不修改门禁。原始实际模型已按上文独立核实。完整输出见 `gates-after.log`。

## 2. 必须返修

### CORR-01 · 高：Review 未绑定提交/条件版本，旧审查能批准新提交

- 位置：`packages/domain/src/task.ts:17–18,100–114,166–169`。
- 需求：D20.3 T5 是 `InReview(pinned_commit / ver)`；作者新增 commit 时旧评审过期重审；不能把审查甲版本的结果算到乙版本。
- 复现：对 `sha-a` 开始审查，保留其 `Review(approve)`；执行 `SubmitForReview(sha-b)` 后投递旧 Review。
- **实际**：`ok:true`，`T7_Delivering`，`reviewedCommit:"sha-b"`，`reviewGate:"compliant"`。独立 I01 红。Review 类型没有 commit、constraint version 或审查轮次身份，守卫无法辨别旧回包；只保存“当前提交”不等于校验审查对象。
- 返修：审查请求及回包绑定同一个被审版本/轮次，机械拒绝或幂等忽略过期结果；补“新提交”与“改条件后再次提审”两条迟到回包测试及当前版本阴性对照。

### CORR-02 · 高：不可恢复返工只发 spawn，后续新 Compute 无法回绑

- 位置：`task.ts:90–96,133–149`。
- 复现：`Delivered → UserReject(computeResumable:false)` 得到 `T3_Running + computeId:null + spawn-compute(withHandoff:true)`；新实例 `c2` 启动后执行 `Dispatch(c2)`。
- **实际**：被拒为 `T3_Running × Dispatch:已有 Compute 在执行`（I02 红），尽管当前 ID 是 null。现有事件表只有 T2 的 Dispatch 能绑定 Compute，没有新实例回绑事件。
- 继续在返回任务上发 Cancel，实际直接 `T10_Cancelled`、effects 空；如果宿主已按 spawn 启动了新实例，就没有该实例的停止指令。这里验证的是领域状态/效果契约，**没有声称真的启动并泄漏了进程**。
- 另一连锁实测：同一 `T3 + null` 进入 NeedHuman 后 Amend，得到 `T4b_BlockedOnHuman + pendingQ:null`，形成无待答卡的阻塞态。
- 返修：补完新建请求、实例成功回绑及期间取消的领域路径，保留任务/负责人身份、累计生产模型及交接信息；测试必须走到新 Compute 回绑后再取消/失败，不能只断言发出了 spawn。

### CORR-03 · 高：不同返工入口未统一恢复语义

- 位置：`task.ts:16–18,77,113,168,175,182,189–191`。
- **T5 改条件**：需求明确退回 T3 并默认恢复原 Compute；实测状态和版本改变，但 `effects:[]`（I03 红），与 Review reject / T7 Amend 返回 resume 的契约不一致。已暂停等待审查的执行器不能靠状态文字继续运行。
- **审查打回/已交付后追加条件**：Review reject 和 T7/T8 Amend 都传 `rework(t,true)`；输入类型与状态都不能表达“历史 computeId 仍存在，但实例不可恢复”，因此只能向失效 ID 发 resume。`UserReject` 有 `computeResumable`，这些入口却没有等价信息或恢复失败路径。
- 准确边界：手工把 Task 的 computeId 设为 null 时，rework 的公共 helper 确实会发 spawn；并非“任何情况下都没有 fallback”。但现有合法事件无法把上述仍有历史 ID 的不可恢复情况表达出来，且 spawn 后仍遇 CORR-02。
- 返修：所有需求要求的返工入口使用同一可恢复性契约；分别验证可恢复时同实例 resume、不可恢复时带交接新开以及回绑，不把已知错误分支仅写入第 7 栏作为通过理由。

### CORR-04 · 高：确认卡是可变共享子对象，可绕过版本绑定

- 位置：`task.ts:37,67,144,155–160`。
- `Task` 外壳及 producerModels 已冻结，`pendingQ` 没冻结，也没有嵌套 readonly。调用方无需类型断言即可赋值 `task.pendingQ.constraintVer = 99`；set 又沿用这个子对象。
- **实际**：任务仍 `constraintVer:0`，卡片变成 99；随后 `HumanReply(q1,99,approve)` 被放行到 T3。`Object.isFrozen(task) === true`，`Object.isFrozen(task.pendingQ) === false`；I06 证明原快照可被改写，`observations.json` 进一步证明该回复被接受。
- 返修：卡片绑定形成不可变快照，防共享引用污染；校验绑定与当前任务版本一致。补从返回 Task 子对象直接改写、跨新旧 Task 引用改写的测试，不只测 apply 没有原地赋值。

### TEST-01 · 高：表遍历以实现为判据，测试全绿可掩盖主干坏转移

- 位置：`packages/domain/src/task.test.ts:29–44`；`packages/domain/proof/mutations.mjs`；收据 AC-09/R-05 的通过声明。
- 遍历测试从生产 `TABLE` 读取 kind，再按该 kind 检验结果；对 go 格不校验目标状态/副作用。因此把合法转移改成“有原因的 ignore”，测试会跟着变异改变预期。
- **实际**：下表 A01/A02/A03/A11 等坏转移仍 56 绿；A04/A05/A06/A07/A12/A13 也存活。不能用“180 格都访问过”推出“180 格符合需求”。
- 返修：对本片纳入的每个主干格建立独立的需求期望（目标状态、版本、身份、审查清理、副作用、拒绝/忽略原因），对条件分支补双侧对照并逐个校准；旧卡修复已有效，不重新要求重做。作者 34 项校准成功应保留，但 AC-09/R-05 不能据此宣称整项充分。

## 3. 独立变异明细

每个副本都固定来自 c6ca694；只改变表中一个实现点，测试保持原样。每个变异都实际跑完整 56 条测试及 typecheck。原样 C00 为 56 绿。

| ID | 单点故障 | 原测试结果 |
|---|---|---|
| A01 | T7 的 Amend 改成 ignore | **56 绿，存活** |
| A02 | T8_Accepted 的 UserReject 改成 ignore | **56 绿，存活** |
| A03 | T1 的 Cancel 改成 ignore | **56 绿，存活** |
| A04 | rework 保留 reviewedCommit/reviewGate | **56 绿，存活** |
| A05 | 不可恢复新开时仍保留旧 computeId | **56 绿，存活** |
| A06 | 删除 UserReject 的提出者身份限制 | **56 绿，存活** |
| A07 | 归档后允许任意非空 by 验收 | **56 绿，存活** |
| A08 | NeedHuman 写死 constraintVer 为 0 | 55 绿/1 红，被“同一张卡在新版本下重新发出……”杀死 |
| A09 | 旧版本回复清掉新 pendingQ | 55 绿/1 红，被同一条旧卡重发测试杀死 |
| A10 | 新开 Compute 不携带交接 | 55 绿/1 红，被 AC-28 条件 B 杀死 |
| A11 | T7 发卡失败调用 rework、重跑 Compute | **56 绿，存活** |
| A12 | T5 SubmitForReview 忽略新提交 | **56 绿，存活** |
| A13 | T1 Amend 不推进版本 | **56 绿，存活** |
| A14 | 删除生产厂商 unknown 守卫 | 55 绿/1 红，被 AC-26 条件③杀死 |

这些存活不是说当前 A01/A02/A11 实现已经坏了：**独立正常路径已确认 T7 改条件、T8 已验收后退回、T7 发卡失败不重跑都符合主干要求**；问题是原测试检测不出它们变坏。

## 4. AC 四栏逐项核对

验收文档采用“判据/观测点/阳性/阴性”表，AC-26 在判据内显式写必须/禁止。下表按要求展开，不凭空增设 UI 为本片实现任务。

| 条目 | 必须 | 禁止 | 阳性埋雷 | 阴性对照/判断 |
|---|---|---|---|---|
| AC-09 | 当前 12×15=180 格均有处理；但义务由同一源码 STATES/EVENT_KINDS/TABLE 驱动，无独立需求转移期望，也非需求表自动展开 | 缺格能发现；“有格但转移不符”不能充分发现，go→ignore 可骗过 | 作者 M26 缺格被杀；独立 A01/A02/A03/A11/A12/A13 存活 | 本轮新增事件并补全 12×16 格及样例，类型和测试通过；仅支持结构完整，不足以认定整项通过 |
| AC-19 | qId/卡版本检查与正常批准/拒绝有效；task_id 由调用方选择 Task 隐含承担，没有事件字段交叉校验；无卡片终态/执行日志 | 常规旧回复不会执行也不清掉新卡，已独立证实；但可变 pendingQ 破坏版本保证（CORR-04） | M20、A08、A09 均被正确回归测试杀死 | 同版确认正常回 T3，异卡号拒绝，旧版本 approve/reject 保留新卡；整项仍未验，不能只把剩余事项说成 UI |
| AC-26 | 五组条件的纯函数路径均已核实：自审/同源/unknown 拒绝，跨源通过，提出者豁免标 waived | 累积厂商（包括早先模型）有效，不只比末次；未核验真实 Compute 模型采集/持久快照，且版本绑定缺失见 CORR-01 | M13–17、M28 及本轮 A14 被杀；生产 unknown 不是只测审查方 | 合规跨源可推进；同厂商只切 waiverBy 可区分合法豁免与冒领。实际模型采集、落盘与回包对象绑定未闭环，整项未通过 |
| AC-28 | Delivered/Accepted/unverified 状态、可恢复退回的效果正确；不可恢复的 spawn 效果仅第一步正确，后续回绑失败 | 超时不当验收、可恢复时不盲目新开都成立；不能宣称默认恢复/新开全路径完成 | M18/M19 与本轮 A10 被杀；A05 保留旧 ID 却存活，A02 已验收后丢退回也存活 | 原样 UserAccept→Accepted、A→resume、B→spawn 有对照；B 未走到实例回绑，真实恢复日志/卡片/收据 UI 未测；CORR-02/03 必须修 |

## 5. R 规则核对

- **R-01**：本次审查来自 OpenAI，作者为 Anthropic；未自审、未豁免。领域层五组厂商条件可用，但 CORR-01 使批准结果不绑定实际被审版本；真实模型与生产集合采集仍属于后续跨层验证。
- **R-02**：通过本轮按名复现，33 个新增测试先红后绿，测试文件在红/绿之间未偷换。
- **R-03**：仓库 G-STUB 实际执行通过；红提交本身也保留可加载空壳，具名失败。它只证明激活了源码，不证明规格充分性。
- **R-04**：G-TAUTO 实际通过，大多数行为测试断言真实符号；但 AC-09 的表内自描述检查是结构检查，不能代替独立预期转移。
- **R-05**：作者 34 个变异的事实成立；“每条判据已双侧标定”的充分性不成立，独立 10 个存活已反证。不能把“原样全绿 + 自选变异全杀”直接等同每条规格已标定。
- **R-09**：纯状态层的超时只归档未核验、之后可退回均成立；真实卡片/收据显示及超时 N 仍未验/未定。N 待定不阻止测试事件语义，也不能自行填 N。

## 6. 第 7 栏真实性与遗漏

**属实的边界**：

1. 确为纯函数层；没有存储、真实模型调用、进程恢复/停止、资源租约、UI 观测。AC-19/26/28、AC-15、AC-23 标“未测”的大方向诚实，不能把 effect 当真实执行完成。
2. 尚未建模 T2b、T4a/T4c、T6/T6b、T8b、E5/E10 等完整需求表，不能声称整张 D20.3 无空格；本轮不要求为这一切片补齐所有延期状态。
3. 义务集不从需求文档生成，超时 N 待定；34 项作者变异数量与运行结果准确。
4. 豁免人的真实身份认证确实需要宿主。纯函数仅比字符串，不能证明事件的实际发出者。

**需要补全/纠正**：

- “审查打回假定可恢复”不只是将来接适配器时才要验证的边界，而是已实现主干缺少合法不可恢复分支（CORR-03）；UserReject 的不可恢复分支也尚未走通（CORR-02）。
- 未披露 Review 回包不绑定被审提交/版本、pendingQ 可被改写、T5 Amend 不发 resume，以及 AC-09 的自描述 oracle/存活变异。
- “新厂商模型名会判 unknown（偏严）”不是普遍成立的保证：实测 `vendorOf("google/stealth-crouton-alpha") === "google"`、`vendorOf("stealth/gpt-custom-unverified") === "openai"`；它对整串做关键词匹配。这里只证明**名称/渠道标签可以影响推断**，不声称这些测试标签对应真实已知模型，也不据此认定有真实跨厂商攻击。宿主必须提供可信、规范化的实际模型身份；该假设及模糊命名误判风险应明确列入边界，不能只写“偏严”。
- `HumanReply` 没有 taskId；`StoppedConfirmed` 没有 compute/request/lease/epoch 身份；`Dispatch` 没有在途请求身份。调用方的任务定位、防串包、取消与派发竞态/幂等仍未验，不能把本片“重复认领拒绝”说成已证明并发 CAS 原子性。
- `withHandoff:true` 是意图标记，不是已携带可恢复的 Handoff Capsule 数据；没有摘要/检查点缺口的内容验证。
- 已实现状态内仍有两处未披露的规格差异：D20.3 T9 要记录新条件供重开，当前 Amend 完全 No-Op；T10/T11 明确新条件重做要有新代次 T1/T2，当前 terminalRow 一概忽略 Amend。独立 I07/I08 探针对此为红。**T9 是否在外层事件日志记录、终态重开是否由单独 API 承担，当前纯函数接口未定义**；本轮不把“必须在此立刻递增版本/原地重开”这个具体设计当成已批准要求。作者应明确归属与验收切片，不能将这两格当成已对齐需求。
- 正常交付后的真实停止/资源回收、T4b 同版批准的持久留痕、免审产出路径也尚未覆盖。资源机可以另片实现，但本片的已测边界须说清。

**概念卡核对**：定时归联系人（概念卡 100、203–209、262–264 行），Helper 在当前聊天被 @ 时在该会话回答/给确认卡（65–66 行）。本 PR 没有定时/插件归属或 Helper 消息路由实现；没有看到将其错误实现为插件或只侧栏回答的改动，**也没有证据称这两个产品要求已经验收**，不为审查擅自扩展代码范围。

## 7. 核心复现（仓库根目录，无需修改实现）

```sh
node --input-type=module <<'JS'
import { newTask, apply, applyAll } from './packages/domain/src/task.ts';
const must = r => { if (!r.ok) throw Error(r.reason); return r; };
const run = () => must(applyAll(newTask('t','u'), [
  {kind:'Claim',by:'writer'},
  {kind:'Dispatch',computeId:'c1',model:'claude-opus-5-5'}
])).task;
const ir = () => must(apply(run(),{kind:'SubmitForReview',commit:'sha-a'})).task;
const review = {kind:'Review',reviewerId:'reviewer',reviewerModel:'gpt-6-astra',verdict:'approve'};
const newer = must(apply(ir(),{kind:'SubmitForReview',commit:'sha-b'})).task;
console.log('旧评审批新提交', apply(newer,review));
console.log('T5改条件无恢复效果', apply(ir(),{kind:'Amend',by:'u'}));
const delivered = must(applyAll(ir(),[review,{kind:'DeliveredCard'}])).task;
const rework = must(apply(delivered,{kind:'UserReject',by:'u',computeResumable:false}));
console.log('不可恢复新开',rework);
console.log('回绑新实例被拒',apply(rework.task,{kind:'Dispatch',computeId:'c2',model:'gemini-4-argon'}));
console.log('此后取消无停止效果',apply(rework.task,{kind:'Cancel',by:'u'}));
const blocked = must(apply(run(),{kind:'NeedHuman',qId:'q1'})).task;
blocked.pendingQ.constraintVer = 99;
console.log('被改写卡片版本放行',apply(blocked,{kind:'HumanReply',qId:'q1',constraintVer:99,answer:'approve'}));
JS
```

## 8. 返修与重新送审边界

Claude Code 在原 `feat/task-lifecycle` 开发任务内处理 CORR-01～04 和 TEST-01，分别留下先红后绿及新增单点变异证据；保留已确认有效的旧卡修复、跨厂商五组条件和超时未核验行为。补齐/收窄收据的通过口径和第 7 栏边界后，再交不同厂商独立复现。

本轮只提交 `reviews/feat-task-lifecycle.md` 与 `receipts/feat-task-lifecycle.json` 的 review 更新；不修改源代码、作者收据其他字段，不代替作者修复，不合并 PR。
