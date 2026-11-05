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

---

# 第二轮 · Codex 独立复现（2026-11-05）

## 结论：reject

`96d48dd3fa8e9cc053950d313ce9d344b7408ef6` 的常规检查、作者列举的 62 项变异和本轮 18 格返工路径均可复现；但**启动/停止回包归属、启动中改条件、旧卡回包，以及重要行为的测试标定仍有必须处理的缺口**。下列独立变异是测试充分性反例，不能误写成当前原版已存在相同改坏实现。审查不改产品代码、不合并 PR。

- 审查人：`codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，实际模型 `gpt-6.1-terra`（OpenAI，取当前 Codex 原始 rollout 的 `turn_context.model`）；作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的原始 turns 中触及仓库的模型均为 `claude-opus-5-5`（Anthropic，存在不同渠道前缀）。写审跨厂商，未使用豁免。
- 普通独立 clone；`.git` 和 common dir 均为该副本自己的 `.git`。审查时 `origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 是 `133cf7abcf6c897653f5b91647202c4ac963f231`；前者比后者只多 PR #2 的 `receipts/feat-domain-core.json`、`reviews/feat-domain-core.md` 两个审查文件。GitHub PR API 当时仍返回 base SHA `133cf7a`，不可把两个值混同。
- 在仓库根目录独立运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
a0ee78f092579b5180a6af48749a28648a180c843bfc11398b15fc1c66ad5962
```

- 日志、独立探针、10 个变异的补丁及测试/typecheck 原始结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review-evidence-5fd2f15b/`。

## 一、亲自运行与红基线的限定

| 操作 | 实测 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，75 通过，0 失败，0 跳过 |
| 普通独立副本检出红提交 `cb162a80b07475e9ee5aed1dd252afaac7e3518b`，运行全部具名测试 | exit 1，23 通过、52 条具名失败；红绿提交的两个测试文件相同 |
| 红测试文件 + `75a76cd` 的原有 `task.ts` / `vendor.ts`，在另一个隔离副本运行 | exit 1，61 通过、**14 条具名失败**，覆盖新旧审查、不可恢复返工/回绑、确认卡快照和独立表期望；证明针对旧实现确实有可复现的失败 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 75 绿、62 项均出现具名失败；不把这 62 项全杀当成所有行为已标定 |
| 独立构造 B01–B10，逐项隔离运行完整测试和 typecheck | **8 项存活**（测试 75/75 绿、typecheck exit 0），另 2 项阳性对照被具名测试杀死，typecheck 均 exit 0 |
| 自写返工路径矩阵 | `Amend` 在 T5/T7/三个 T8 状态各测可/不可恢复，`UserReject` 在三个 T8 状态各测两侧，`Review reject` 测两侧，共 18 格通过；另验绑定后取消/失败、旧审查版本、冻结与同卡号旧版本回复 |

**红的原因不能只数名字**：`cb162a8` 把已有 `task.ts` 和 `vendor.ts` 的实现整体换成空壳；52 条具名失败中 51 条报“未实现”，1 条是 `TABLE` 为 undefined，而非 52 条分别证明各修复缺陷。上面的 14 条是把同一批红测试嫁接回旧实现后本轮实测的反例；它不是作者当时实际留下的 14 条历史运行记录。R-02 和 R-03 是不同要求，返修时应保存针对**未修复旧行为**的具名红记录，不能仅用空壳红代替 bug 复现红。

## 二、必须返修

### R2-CORR-01 · 在途启动的停止确认没有身份，旧确认可使新实例漏停

- `packages/domain/src/task.ts:24–28,90–95,228–238,240–241`：`cancel-spawn` 不带启动请求 ID；`StoppedConfirmed` 不带 Compute、请求或 epoch 身份。`T9` 收到任意该事件就清掉 `spawnPending` 进入终态，而终态 `Dispatch` 一律忽略。
- 本轮实际状态机序列：已交付 → `UserReject(false)` 新开待回绑 → `Cancel`，得到 `T9 + cancel-spawn` → 若**旧实例的迟到** `StoppedConfirmed` 到达，实际立即 `T10 + spawnPending:false` → 新实例随后 `Dispatch(c2)` 实际 `ok:true` 但保持 T10、effects 空。反过来若 `Dispatch(c2)` **先于**停止确认，T9 分支确实发 `stop-compute(c2)`。作者测试只覆盖后一种顺序。
- 领域接口无法区分上面的旧确认与待取消启动的安全确认；没有实际启动进程，故不声称本轮已在 OS 中泄漏进程。**若宿主不另行过滤或隔离，领域层会把旧回包当作足以终结新启动的证据**。这影响本片“撤销启动、确认停止后终态”的主干，不能仅以第 7 栏注明并发未验来认定已实现。
- 修复须把在途启动与停止确认关联到可验证的 request/lease/epoch，或明确并实测等价的宿主隔离/完成确认契约；覆盖旧实例迟到停止、新实例在确认前后回绑、重复回包和最终资源回收。仅发 `cancel-spawn` 不等于撤销已完成。

### R2-CORR-02 · 启动中改条件后，可回绑无法证明使用了新版本

- `task.ts:88–89,108–119,173–179`：`spawnPending:true` 且 `computeId:null` 时，T3 的 `Amend` 仍成功把 `constraintVer` 从 1 加到 2，但 effects 为空，原启动仍在途；之后的 `Dispatch` 只带实例 ID/模型，不带启动请求或其条件版本，成功把实例绑定到 v2。
- 实测见 `independent-probes-original.log` 的 `pending_before_amend`、`pending_amend`、`pending_after_amend_dispatch`。若旧请求已携 v1 交接启动，现有领域接口没有手段确认它实际使用 v2，也没有发重启、更新条件或拒绝旧版本回绑的效果。这里没有接真实适配器，**不声称实测该进程已经按旧条件产出**；这是可复现的接口/状态缺口。
- 修复或明确可验证契约：将启动请求绑定条件版本和代次；改条件时安全更新/撤销重发，或在回绑时阻止旧版本并处理实例，增加“启动在途→改条件→旧启动迟到”及正常新版阴性对照。

### R2-CORR-03 · 过期不同卡号的回复会中断后续有效回复

- `task.ts:186–194` 先比 `qId`，再比版本。先问 q1/v0 → Amend → 再问 q2/v1 → 投递 q1/v0，实际是 `ok:false`，而不是需求文档 `D20.3` T4b 的过期回复幂等忽略；当前 q2 不被清除，但 `applyAll([旧 q1, 有效 q2])` 会在旧回包处停止，单独执行 q2/v1 则正常回 T3。
- 同卡号、不同版本的旧回复已正确忽略；不是说确认卡快照修复无效。补“不同旧卡号+旧版本”和后续当前卡有效回复的成对测试；同时保留**同版本但错误卡号拒绝**的阴性对照。

### R2-TEST-01 · 独立表已改善，但关键字段/条件分支仍能被变异骗过

`task.test.ts:37–115` 的 `SPEC` 不读取生产 `TABLE`，逐格目标状态检查比第一轮更强；但单一样例对多数 go 格只断言目标状态，未逐格验证负责人、生产集合及所有守卫分支。以下 **8 项每项原测试均 75 绿且 typecheck 绿**；原版和变异版均以额外独立探针比较过：

| ID | 故意注入的单点错误 | 实际漏检的后果 |
|---|---|---|
| B01 | 可恢复返工时把 owner 改为 requester | 负责人从 `author` 静默变成 `user`，违背身份连续性 |
| B02 | 可恢复返工时只保留最后一个生产模型 | `{Anthropic, OpenAI}` 退化为 `{OpenAI}`，旧 Anthropic 生产厂商的审查竟标 `compliant` 并进 T7 |
| B03 | T5 中忽略 `ProducerModelAdded` | 审查期间新增的 OpenAI 生产模型未记录，OpenAI 审查错误进 T7 |
| B04 / B05 | T5 / T7 的 Amend 无论 `false` 都按 `true` 恢复 | 原实例不可恢复时仍发 `resume-compute(old)`，应新开 |
| B06 / B07 | Accepted / Archived 的 `UserReject(false)` 被当成 `true` | 应带交接新开，却向失效旧 ID 发 resume |
| B08 | T9 迟到新实例回绑时把 owner 改为 requester | T9 中负责人被静默改掉 |

阳性对照 B09（启动中取消不撤销）及 B10（未回绑即提审）被现有具名测试杀死，排除本轮变异跑错套件或完全无效。原版 **B02/B03 的相应探针均正确拒绝同厂商审查**；这里的发现是回归测试不能保护这一硬门禁，而不是指控当前原版已放行。本片 `R-05` 的“通过”应限于现有变异集合，补每个实际有意义入口的双侧行为和 owner/累积厂商断言，并让上述变异因正确断言失败。

### R2-CORR-04 · 审查对象 ABA：是否容许复用旧轮次须明确

`task.ts:126–129,202` 只比较 `(commit, constraintVer)`。本轮实际送 `sha-a/v0 → sha-b/v0 → sha-a/v0`，第一次的 `sha-a/v0` 迟到 approve 在最后一次 T5 被接受并进入 T7。D20.3 写明作者推新 commit 后旧评审过期重审；若这意味着**过期轮次不得复活**，仅比较这对字段不够，须绑定唯一审查请求/轮次并补 ABA 测试。若产品明确允许对完全相同 commit 与条件版本复用旧评审，则需明确该例外及审查人资格/生产快照条件；当前代码无法证明轮次新鲜。这个问题与不同 commit 或不同版本的普通迟到回包已修好并不矛盾。

## 三、逐项复核首轮与三个设计选择

- **CORR-01**：不同 commit、不同条件版本的旧回包均被忽略，当前对照可进入 T7；一般路径已修。另有上面的同值 ABA 轮次边界。
- **CORR-02**：不可恢复返工后能 `Dispatch` 新实例，保留 owner 并累积模型；绑定后取消/失败分别停新 ID，停止确认后释放新槽位；启动中取消会发 `cancel-spawn`。但启动/停止回包身份及倒序竞争仍未闭合，见 R2-CORR-01/02。
- **CORR-03**：本轮 18 格原版路径的两个恢复分支及 T5 恢复副作用均正确；不过四个入口的不可恢复分支可被 B04–B07 单独改坏而测试仍绿。
- **CORR-04**：新旧 Task 不共享卡片对象，`pendingQ` 冻结，卡片与任务版本一致性及同卡号旧版均有防护。不同卡号旧回包的幂等/事件批次问题仍在，见 R2-CORR-03。
- **TEST-01**：独立 SPEC 和目标状态、部分 effects/ver 断言已解决“完全用生产 TABLE 自作预期”的原问题；但不等于每格关键字段和分支均充分，B01–B08 反证 R-05 完整标定。
- **Amend 必填 `computeResumable`**：为 T5/T7/T8 返工让宿主报告可恢复性，是可行的接口选择，需求没有规定这一字段形式；但类型也要求 T1–T4b 这种不读它的事件提供布尔值，属于额外调用约束，不应解释成“用户必须判断实例能否恢复”。宿主如何得到可信结果、未知时是否先探测/安全处理，未验证；不能把传 `true` 说成真的恢复成功。
- **`cancel-spawn`**：撤销在途派发的意图与 D20.3 的先停后终态方向一致，不是需求禁止的副作用；但当前无身份关联，不能由效果字样单独证明真实撤销与隔离，见 R2-CORR-01。
- **`spawnPending` 时禁止 `NeedHuman`/`SubmitForReview`**：在新实例尚未绑定时不把旧/无来源回包当作本次产出，是合理的保守处理；需求没有直接规定这种接口策略。若真实启动回调可能先于 Dispatch 到达，当前做法会拒绝而不缓存，需由适配器明确保序或可靠重投并在跨层验证，不能默认这些事件永不乱序。

## 四、第 7 栏和验收口径

1. 独立实测 `vendorOf('google/stealth-crouton-alpha') === 'google'`、`vendorOf('stealth/gpt-custom-unverified') === 'openai'`、无关键词字符串为 `unknown`；所写“整串关键词可误判”属实。仅凭字符串本身不证明这两个虚构名称对应实际厂商；可信原生模型身份、真实豁免发起人和产出集合采集仍需宿主与适配器。
2. 独立实测 T9/T10/T11 的 `Amend` 原样忽略、版本不变；与 D20.3 中 T9 记录条件供重开、终态新代次的文字存在已披露差异。真正补充消息落盘及终态重开由哪个外层接口承担尚无实现证据，不能擅自断定必须在原任务对象原地重开，但也不能宣称这几格符合需求。
3. 缺 request/lease/epoch、`HumanReply` 无 taskId、`withHandoff:true` 只有意图标记、真实卡片与日志、槽位/进程、CAS、免审路径和超时 N 等边界均应保持未测；本轮只跑纯函数，未启动真实 Compute，也未证明跨层隔离/投递/恢复。
4. `AC-09` 的 180 格是**本片** 12×15 单一代表性状态与事件，不是完整需求状态机或所有分支。`AC-19/26/28` 在收据为未测是合理的整项界限；对 `AC-09`/`R-05` 和 R-02 的通过口径须按上面的漏检及红原因收窄/补证。

最小复现（仓库根目录；只读原始实现）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review-evidence-5fd2f15b
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# 独立变异的精确补丁及原测试日志在 "$E/mutants/B01" … "$E/mutants/B10"。
```

本轮只更新本报告及 `receipts/feat-task-lifecycle.json` 的 review 字段。保留第一轮及作者其余收据字段，返修交回 Claude Code，修完后仍需新的跨厂商独立复审。

### 本轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因结论是 reject 按预期阻止合入；`G-RED/G-STUB/G-TAUTO/G-TRACE/G-WORKFLOW/G-LAYER` 通过，但 G-RED 只证明 52 条按名红，不能取代本报告对实际失败原因的核对。`G-PROVENANCE` 报本审查会话 `turns.jsonl` 记录尚不存在；当前活动会话的 `record.json` 和 Codex 原始 rollout 已单独核实身份与模型，但**不声称来源门禁已通过**。会话结束、记录落盘后应由原任务复跑，不伪造会话文件。完整输出见证据目录 `gates-after.log`。

---

# 第三轮 · Codex 独立复现（2026-11-05）

## 结论：reject

返修 `cb3fba02725c37d8de3b2e066a04ce44c8019eda` 的常规检查、旧实现红对照、作者 82 个变异，以及本轮实走的 18 格返工路径均可复现；但新增的启动身份处理引入了**重复上线误停合法实例、多个在途启动尚未全部停止就结束任务**两个可复现问题。旧执行器的执行/提审回包也没有可校验的来源或版本，不能只靠回绑时校验请求号证明旧产物不会进入新版本。另有 9 个独立单点变异存活，见下文。返修交回 Claude Code；审查不改产品代码、不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，本轮原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话中涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），满足跨厂商；无豁免。
- 普通独立 clone 审查，`.git` 与 common dir 均为该 clone 自己的目录。基线 `origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`；与 HEAD 的 merge-base 是 `133cf7abcf6c897653f5b91647202c4ac963f231`，两者差异只包含 PR #2 的审查与收据文件。
- 在仓库根目录运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
0abcb78516594a476200a83ec538fc719fde386be38ef5b2056c7ee54043ae58
```

- 原始日志、独立测试和脚本、每项变异补丁及其测试/typecheck/比较探针：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review3-evidence-5fd2f15b/`。

## 一、独立执行结果

| 操作 | 实际结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，85 通过，0 失败，0 跳过 |
| 检出红提交 `af549553ee51c96c4b5e70def85dc34ed05fb7ed`，运行完整具名测试 | exit 1，23 通过、62 具名失败：61 条报“未实现”，1 条为 TABLE undefined；红绿测试文件相同。这是空实现激活证据，不是 62 个不同旧缺陷 |
| 红提交测试配上 `96d48dd` 的原实现，在隔离副本独立运行 | exit 1，68 通过、17 具名失败；与 `packages/domain/proof/red-against-96d48dd.tap` 的失败名称集合完全一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 85 绿、82 项均有具名失败；未将文件加载失败算作被杀 |
| 独立行为测试 | **2 红、1 绿**：重复上线误停、未等旧实例停止提前终态；正确当前实例停止确认的阴性对照通过 |
| 独立事件历史矩阵 | 9 个返工入口 × 可/不可恢复共 18 格通过；旧卡号旧版本后当前卡继续处理、审查 ABA 和当前轮对照通过 |
| 自造 C01–C10，分别运行完整测试与 typecheck | **9 项存活，均 85 绿、typecheck exit 0**；C10 阳性对照被具名测试杀死且 typecheck 绿 |

## 二、必须返修

### R3-CORR-01 · 重复当前上线回包会停止合法运行的实例

- `packages/domain/src/task.ts:132–146,207–213,218–219,234–235`：第一次 `Dispatch(requestId=L1, computeId=c2)` 成功后，`bind` 把 `launch` 清成 null，但没有保留已绑定的启动请求身份。下一次**完全相同**的 Dispatch 进入 `orphan`，由于 `L1 !== undefined`，误发 `stop-compute(c2)`；任务仍显示 T3、`computeId=c2`。
- 本轮分别实测 T3、T4b、T5 下重复该已绑定回包，都产生 `stop-compute(current-worker)`。这不是另一个过期实例；回包的 requestId 和 computeId 与第一次绑定完全相同。至少一次投递/回放、丢 ACK 后重投等正常重复会错误中断当前活；本轮只验证 effect，**没有声称已在 OS 中停止真实进程**。
- 补充可验证的已绑定身份并将同一实例同一请求的重复回包幂等处理（或安全拒绝且无停止效果）；同时确保**不同**旧请求的不同实例仍被停止。分别测试 T3/T4b/T5 等状态、重放和不同实例的阴性对照。

### R3-CORR-02 · 已发现的旧实例仍未确认停止时，另一请求的确认可提前终结

- `task.ts:127–138,262–276`。可运行复现：返工发 L1/v1 → 在途 Amend 发 `cancel-spawn(L1)` 和 L2/v2 → 用户取消，T9 等待 L2 → L1 的实例 `old-launch-worker` 迟到上线，领域层实际发 `stop-compute(old-launch-worker)`，但 Task 不登记这个仍待停止的实例 → `StoppedConfirmed(requestId=L2)` 到达，实际立即进入 **T10**，尽管 L1 实例尚无 `StoppedConfirmed(computeId=old-launch-worker)` → 之后该确认在终态被忽略，也没有该实例的 `release-slot` effect。
- 这是**已经收到旧实例上线事件**的情况，不以猜测是否存在进程为前提；仍没有真实启动进程，因此不把领域结果说成已发生真实泄漏。当前 T9 只跟踪一个 `launch` 或 `computeId`，无法表示撤销重发后多个尚未结束的请求/孤儿实例；单个当前请求的确认不足以证明全部停止。第二轮提出的“真实停止/隔离后才终态”因此仍未闭合。
- 修复可选择：在旧启动确认不可能上线/已停止隔离后再启动新代次，或持续跟踪所有未决旧请求及已发现实例，逐个确认停止/隔离与资源处理；不得因为 L2 的确认抹掉 L1 的未决停止。补 L1/L2 乱序、重复 ACK、失败终态及无真实实例的对照，不只测一条在途请求。

### R3-CORR-03 · 回绑虽带号，但后续执行结果未绑定实例/条件版本

- `task.ts:12–19,28–30,207–216`：`SubmitForReview` 只有 commit，`NeedHuman`、`ProducerModelAdded`、`ExecFailed` 也不带执行实例/启动请求/版本。实际在 L1/v1 被撤销、L2/v2 已回绑后，模拟 L1 的迟到 `SubmitForReview(commit=old-L1-artifact)`，领域函数仍进入 T5 并发出 `request-review(round=2, constraintVer=2, commit=old-L1-artifact)`；当前轮的跨厂商 approve 后进入 T7。模拟旧实例的 `ExecFailed` 也会发 `stop-compute(new-L2-worker)`。
- 探针把 `computeId/requestId/constraintVer` 作为**额外元数据**标注来源；它们不是目前 `TaskEvent` 声明的字段，当前实现忽略它们。此测试证明领域接口自身无法区分上述来源，并没有证明真实适配器已经产生这些迟到回包。若依赖宿主先过滤，必须定义不可绕过的来源/代次校验契约，并用实际宿主边界的重放测试证明；否则在领域事件及状态上关联执行身份和条件版本，使旧执行器的提审、询问、模型变更、失败回包不能影响当前代次。
- 这与本轮已经修复的“旧 requestId 不可回绑”和“旧审查 round 不可批准”不同：上例旧结果被当作**当前**条件发起了全新一轮审查，故仅审查 round 守卫无法拦住。

### R3-TEST-01 · 82 项全杀属实，但 9 个相关独立故障仍存活

每个 C01–C09 都只改单一实现点、保留原测试、实跑全套 85 项及 typecheck，均 exit 0；各项另有原版/变异版行为对照。下表是**测试盲区**，不指控原版已有这些故意注入的错误：

| ID | 单点变异与可观察后果 |
|---|---|
| C01 / C02 / C03 | T5 / T4b / T8a 遇旧请求实例改为仅拒绝、不发停止；原版会 `stop-compute(orphan)`，变异版不停止 |
| C04 | 仅在 `stopReason=fail` 时取消停止确认身份检查；旧实例的确认可令当前实例尚未确认退出就进 T11 并释放当前槽位 |
| C05 | 审查只拦较小轮次、不拦未来轮次；未来轮次 approve 错误进 T7 |
| C06 | 仅 approve 核审查 round，reject 不核；旧轮次打回可中断当前审查并恢复 Compute |
| C07 | 卡片版本在第二次改条件后被错误封顶；v2 卡携 v1，当前 v2 回复被拒 |
| C08 | 审查请求 effect 的条件版本在第二次改条件后被错误封顶；T5 实际 v2，却请求审查 v1 |
| C09 | 回绑时把启动序列归零；下一次不可恢复返工复用 `t#L1`，而原版是 `t#L2` |

C10（允许无请求号的实例回绑）被两条具名测试杀死，typecheck exit 0。建议用独立期望补足上述状态、轮次、重复/乱序和多次返工条件，并保留 C01–C09 的双侧对照；不能据 82 个自选变异全杀就宣称这些判据已充分标定。

## 三、逐项复核第二轮返修

- **R2-CORR-01：部分修复。** 正常单次启动的不同 ID 上线会被停止；旧实例停止确认不会终结正在等待的新请求，当前实例的正确确认可释放槽位。本轮独立阴性对照通过。但重复同一合法回包误停、以及多请求未决停止被遗忘，分别见 R3-CORR-01/02。
- **R2-CORR-02：部分修复。** 在途改条件确实产生新的 requestId/新版本，并要求只有当前请求才能回绑；旧请求上线时发停止 effect。它还未证明旧执行结果不会作为新版本提审，见 R3-CORR-03；也未等待所有旧启动/实例停止，见 R3-CORR-02。
- **R2-CORR-03：已复现修复。** 旧卡号+旧版本回复被幂等忽略，不打断同批当前卡有效回复；同版错卡号仍拒绝。
- **R2-CORR-04：已复现所选方案。** 每次提审产生 round 和 `request-review`，`a→b→a` 后旧轮回包不复活，当前轮可通过；同值重审的代价写入第 7 栏。C05/C06 显示对应分支仍可被改坏而不被测试发现，并不是说原版 round 守卫没生效。
- **R2-TEST-01：原 B 类变异已被作者脚本杀死，逐格补充 owner/生产模型、18 格返工两侧有实际改善；但本轮 C01–C09 证明仍不是所有安全相关分支都有有效对照。**

## 四、第 7 栏和验收边界

红提交空壳的 62 失败与旧实现上的 17 失败均实测属实；后者失败名称与作者记录一致。`T9/T10/T11` 下改条件、模型名关键词推断、真实进程/资源回收、可信宿主提供身份、适配器保序重投、Handoff 内容、CAS 和完整状态机等仍是已披露的界限，不应当称为跨层验收完成。额外需要补入的是：绑定后重复同一回包会误停当前实例；已发现的孤儿仍未停止时另一请求 ACK 能提前终结；执行/提审回包本身无法按来源与版本辨别。上述问题不是本轮真实进程测试结果。

复现（从审查目标仓库根目录运行；独立行为测试预期 2 红 1 绿）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review3-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# 每个独立变异补丁、85 项测试及 typecheck 原始输出在 "$E/mutants/C01" … "$E/mutants/C10"。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前两轮及作者其余收据字段。修复后应再次跨厂商独立复现。

### 第三轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 实际报告当前已落盘会话里尚无输出等于本轮 hash 的调用、审查那轮厂商认不出：本会话当前轮次尚未落盘，本轮 hash 命令及原始 rollout 的实际模型已分别实查，**不声称来源门禁通过**。当前轮记录落盘后需由原任务复跑，不伪造记录。原始输出见证据目录 `gates-after.log`。

---

# 第四轮 · Codex 独立复现（2026-11-05）

## 结论：reject

`b50c0e9f87d686bf72898b45deae3da54f3a72fb` 的 98 项原样测试、105 项作者变异及第三轮修复的主要正反路径可以复现；但旧生产实例的换模回包迟到时会被丢弃，可能让**实际参与生产的厂商通过跨厂商审查**。此外，旧执行器在等人确认状态的回包仍会中断有效回复，首派在途取消没有可表达或安全收口的状态。新造的 11 项变异有 10 项存活。审查仅使用纯函数与隔离副本，没有启动真实 Compute；返修交回 Claude Code，不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），跨厂商、无豁免。
- 普通独立 clone；`.git` 与 common dir 均为该副本自己的 `.git`。`origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 为 `133cf7abcf6c897653f5b91647202c4ac963f231`，两者只差 PR #2 的审查/收据文件。
- 在仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
156a216f70138c27186f9f895d67e353ebbcda60d8a02962d48c12f7eefb7073
```

- 原始日志、独立行为测试、事件路径探针、11 个变异补丁及测试/typecheck/比较结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review4-evidence-5fd2f15b/`。

## 一、亲自执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，98 通过、0 失败、0 跳过 |
| 普通独立副本检出红提交 `4888aafdd9995b25bb852f5c4641e76cd46f7bfd` 后跑全部具名测试 | exit 1，23 通过、75 具名失败；74 条报“未实现”、1 条 TABLE undefined；红绿测试文件相同。它是空壳激活红，不是 75 条彼此独立的缺陷红 |
| 红测试配旧版 `cb3fba0` 的实现，在另一隔离副本运行 | exit 1，81 通过、17 具名失败；与 `packages/domain/proof/red-against-cb3fba0.tap` 中失败名称集合完全一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 98 绿，105 项出现具名失败；文件级失败不算杀死 |
| 本轮独立行为测试 | **4 红、4 绿**：旧生产模型迟到、两类旧回包阻断当前卡回复、模拟首派迟到上线无停止效果；当前实例重复回包、当前卡有效回复、首派已回绑取消、首派未发取消的对照通过 |
| 本轮独立事件矩阵 | 9 个返工入口 × 可/不可恢复共 18 格，重复同一实例上线、同请求不同实例、两次启动乱序停止以及 T3 旧执行器回包对照通过 |
| 自造 D01–D11，逐项跑完整测试和 typecheck | **10 项存活**（每项 98 绿、typecheck exit 0）；D11 阳性对照被具名测试杀死且 typecheck 绿 |

## 二、必须返修

### R4-CORR-01 · 旧生产实例的换模回包迟到可漏掉参与厂商

- `packages/domain/src/task.ts:125–130,175–178,246–249,279–284`：`ProducerModelAdded` 只接受 `ev.computeId === t.computeId`，返工回绑新实例后旧实例的换模记录一律忽略。
- 独立对照：c1 在旧代次使用 Anthropic，产生一次 `ProducerModelAdded(c1, gpt-6)`；旧产物交付后不可恢复返工并回绑 c2（DeepSeek）。**同一个旧生产模型事件**若在 c1 仍是当前实例时处理，累计集合为 `{Anthropic, OpenAI, DeepSeek}`，后续 OpenAI 审查被拒；若该事件排队迟到至 c2 回绑之后，实际被无效果忽略，集合只剩 `{Anthropic, DeepSeek}`，后续 OpenAI 审查返回 `compliant` 并进入 T7。
- 这里的“c1 的模型实际参与了旧产物/交接”是探针的明确前提，不是声称本轮启动真实模型或观察到磁盘产物被改。只凭当前代码无法辨别这条真实但迟到的生产记录，也没有已验证的宿主保序/落盘屏障，故“宁多勿少”的累积集合与跨厂商硬门禁不能在该顺序下成立。T7/T8 的 `ProducerModelAdded` 还会直接拒绝，不能补齐事后迟到记录。
- 应持久化并关联每一代次的实际生产模型，在产物提审/批准前确保相关记录已收齐且可追溯；若晚到记录改变合规结论，需使受影响审查失效/重审。也可由宿主保证事件与产物的原子有序提交，但须有具体不可绕过的接口及真实乱序/恢复测试，不能仅靠“当前实例 ID”假设。对未参与产物的旧实例保留阴性对照。

### R4-CORR-02 · 等当前确认卡时，旧执行器回包会阻断有效用户回复

- `task.ts:250–258,263–275,335–344`：T3 中旧来源的 `NeedHuman` 和 `SubmitForReview` 会先核 ID/版本并忽略；但 T4b 对这两类事件直接使用无条件 `rej`，没有区分旧来源。
- 实测：c2/v1 正在等待 q2，迟到的 c1/v0 `NeedHuman(q1)` 或 `SubmitForReview(old)` 均返回 `ok:false`。`applyAll([旧回包, HumanReply(q2,v1,approve)])` 在第一条即停；单独执行同一有效 q2 回复则正常回 T3。与第二轮的旧卡回复问题相同，旧事件可挡住当前有效操作。
- 在所有会接收迟到执行事件的相关状态先做来源/版本校验并幂等忽略旧回包，再对**当前实例的非法重复提问/提审**保留拒绝；补 T4b 旧提问、旧提审与其后有效回复的批次测试及当前来源阴性对照。

### R4-CORR-03 · 初次派发在途取消不能区分“尚未发”和“已发送待上线”

- `task.ts:103–106,110–115,228–245,155–164,208–210`：T2 没有表示首派请求在途的字段或事件，`Cancel` 在无 `computeId/launch` 时直接 T10；首派成功回报的 `Dispatch` 也允许不带 requestId。D20.3 T2 明确要求：未发请求可直接取消，**已在途或状态未知必须先转 T9**。
- 纯函数模拟：认领 T2 → Cancel 得 T10、effects 空 → 晚到无 requestId 的首次 `Dispatch(first-worker)`，实际仍 T10、effects 空，既不登记也不停止该实例。此处没有真正发送派发请求或启动进程：测试显示的是状态/API 无法表示“请求已发但尚未回绑”，以及随后输入被静默忽略。相对照，已回绑的首派取消会发 stop 并等实例确认，确实尚未发出时直接取消也正确；关键是当前 T2 无法把两种情况区分开。
- 需要持久化首派请求及发送/确认状态、关联请求身份，并覆盖取消与上线/确认乱序；或定义并实测宿主在发起请求前的原子绑定及取消隔离协议。第 7 栏提到首派无 requestId，但不能据此宣称首派在途取消已实现。

### R4-TEST-01 · 新引入的多未决集合和版本通知仍有回归盲区

D01–D10 是**人为单点改坏的变异，不是声称原版本身已存在这些错误**。每项均在隔离副本跑完 98 项原测试与 typecheck，均 exit 0；另逐项对照原版和变异版的真实纯函数结果：

| ID | 可存活的单点变异 |
|---|---|
| D01 / D02 | T4b / T7 不消费孤儿停止确认，孤儿与槽位无法清理 |
| D03 | 任一旧启动确认清空全部 `revoked`；L1 确认可抹掉 L2，当前 L3 确认后提前 T10 |
| D04 | 任一孤儿确认清空全部 `orphans`；孤儿 1 确认可抹掉仍未停止的孤儿 2 |
| D05 | 仅登记第一个孤儿；第二个旧实例上线不发停止效果 |
| D06 / D07 | `revoked` / `orphans` 数组不再冻结；外部可直接清掉待确认对象 |
| D08 | 返工时丢掉尚未停止的孤儿集合 |
| D09 | 同一启动请求但不同实例被误当成重复回包，不停止第二个实例 |
| D10 | 第三次及以后 `update-constraints` 的版本错误封顶；任务 v3 但通知实例 v2 |

D11（停止确认时不等待当前实例）被现有具名测试杀死且通过 typecheck，作为阳性对照。应补多条旧启动/多个孤儿、各状态确认、快照不可变、同请求不同实例、反复版本推进的双侧测试，并区分**需要记录所有未决对象**与“单个对象”正例。105 项作者变异全杀本身属实，但不证明这些新增判据已被充分标定。

## 三、逐项复核第三轮及边界

- **R3-CORR-01：原版复现修复。** 同一实例重复上线不再发停止；不同实例即使带同一请求号，本轮独立对照也会被停止并登记。实际实现对任何与当前 `computeId` 相同的回包都不发停止，不仅限同一 requestId；作者第 7 栏已披露无法识别冒用 ID。
- **R3-CORR-02：上轮两请求/一个孤儿的提前终态路径已复现修复。** 旧实例已上线时，L2 确认不会抹掉孤儿，孤儿确认后才进终态并释放其槽位。多个未决对象的**测试保护**不足见 D03–D05；首派在途是另一未实现路径，见 R4-CORR-03。
- **R3-CORR-03：T3 的旧实例/旧版本提问、提审与旧实例失败可忽略；当前实例改条件/恢复效果带新版本。** T4b 的旧回包仍阻断有效操作，旧生产实例的迟到换模记录被忽略，见 R4-CORR-01/02。`update-constraints` 只是通知，实际执行器是否使用正确版本仍未测。
- **R3-TEST-01：C01–C09 均在作者变异脚本内被具名测试杀死，属于真实改进；**D01–D10 的独立反例证明不能把这一点扩大为完整标定。
- **其他界限：**T9/T10/T11 改条件、真实身份认证、跨进程 CAS/租约、实际恢复和资源回收、可信模型身份、Handoff 内容、UI 与完整状态机均未实测。另实测：L1 仍在 `revoked` 未确认时，L2 绑定后可以发起提审；若两代执行器可能共享可写工作区，宿主必须证明旧执行器隔离/提交屏障，再声称产物与厂商集合可信；本轮未执行真实工作区并发。

复现（仓库根目录；独立行为测试当前预期 4 红、4 绿）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review4-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# 各变异补丁及测试/typecheck 输出见 "$E/mutants/D01" … "$E/mutants/D11"。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前三轮及作者其余收据字段。返修后继续由不同厂商独立复现。

### 第四轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER/G-PROVENANCE` 均通过。来源门禁通过只证明本轮审查与作者来源及 hash 检查通过，不覆盖以上业务反例。完整输出见证据目录 `gates-after.log`。

---

# 第五轮 · Codex 独立复现（2026-11-05）

## 结论：reject

`fdfecb13f48262b85610cbf62fb7d3a84cd8badb` 的 115 项原样测试、131 个作者变异和第四轮修复的主要路径均可复现；但**交付确认和验收事件没有绑定交付代次**，上一版的迟到确认、退回或超时可作用于新版本，上一轮的发送确认也可把新一轮标成已交付。迟到生产记录触发重审时，旧交付确认还可让 `applyAll` 丢失前面的重审结果。自造 10 个变异有 9 个存活。审查只跑纯函数及隔离副本，没有启动真实 Compute、发送真实卡片或修改产品代码；返修交回 Claude Code，不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），跨厂商、无豁免。
- 普通独立 clone；`.git` 与 common dir 均为该副本自己的目录。`origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 为 `133cf7abcf6c897653f5b91647202c4ac963f231`；二者只差 PR #2 的审查/收据文件。
- 仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
0afd541f65efbe0da82c6815366998997af88e1717fd2c5f29f7bf4bdc72c8e3
```

- 原始日志、独立行为测试、事件路径探针、10 个变异补丁及测试/typecheck/比较结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review5-evidence-5fd2f15b/`。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，115 通过、0 失败、0 跳过 |
| 红提交 `9dacc0920b463c8a8944c7ffad3f56266b6e9acf` 完整具名测试 | exit 1，23 通过、92 具名失败：91 条报“未实现”、1 条 TABLE undefined；红绿测试文件相同。空壳红是激活证据，不是 92 个各自的缺陷复现 |
| 红测试配旧版 `b50c0e9` 实现，在另一隔离副本运行 | exit 1，104 通过、11 具名失败；与 `packages/domain/proof/red-against-b50c0e9.tap` 的失败名称集合完全一致。仅补测试、旧实现本来正确的 D 类变异，应靠变异校准而非旧实现红来验证 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 115 绿，131 项出现具名失败；文件级失败不算杀死 |
| 本轮独立行为测试 | **6 红、3 绿**：旧版本的接受/退回/超时、旧发送确认、迟到模型与旧发送确认批次、首派重发时旧提问；当前用户验收、非提出者拒绝、单独迟到模型重新送审的对照通过 |
| 本轮独立事件矩阵 | 已绑定实例的迟到模型在 T7/T8a/Accepted/Archived 四个状态重判；仍合规、显式豁免、历史实例回包、旧卡批次、首派取消及重发的原版路径通过 |
| 自造 E01–E10，逐项跑完整测试和 typecheck | **9 项存活**（每项 115 绿、typecheck exit 0）；E10 阳性对照被具名测试杀死且 typecheck 绿 |

执行纠错记录：最初在 `npm ci` 前误跑 hash，因缺少 `typescript` 报 `ERR_MODULE_NOT_FOUND`、exit 1；随后安装成功并重新运行指定 hash 命令得到上文结果。这是执行顺序错误，不当作产品失败；原日志见 `hash-before-ci.log`。

## 二、必须返修

### R5-CORR-01 · 旧交付卡的接受、退回、超时可作用于新版本

- `packages/domain/src/task.ts:24–27,342–355`：`UserAccept` 只有 `by`，`UserReject` 只有 `by/computeResumable`，`AcceptTimeout` 没有任何交付身份。没有 card、artifact、交付代次、审查轮次或条件版本，状态机无法区分旧卡的回包和当前卡的回包。
- 独立纯函数序列：v0/旧 commit 已发卡；保存那张卡发出的 `UserAccept(user)`、`UserReject(user)` 和旧超时事件；然后用户 Amend，v1/新 commit 完成新审查并交付。向 v1 的 T8a 投递这些旧事件：旧接受实际令 **v1 进入 T8_Accepted、badge=accepted**；旧退回令 v1 意外进入 T3/v2 并发恢复；旧超时令 v1 提前归档为 unverified。用户对旧卡的点击不能证明用户验收了新产物，这触及 R-09 “必须明确确认、不说话不算验收”。
- 探针模拟的是旧事件晚到，并没有真实用户点击或卡片发送；同一个 `by` 的旧/新 `UserAccept` 在当前公开类型中**字节内容完全相同**，因此仅靠当前状态不可能区分。不能把“谁发的”校验误当成“确认的是哪一版”。
- 为每次交付定义不可复用的卡片/交付代次，并在接受、退回及超时事件中携带并核验其身份与产物/条件版本；旧事件幂等忽略、当前版本的合法接受/退回/超时仍正常。若由宿主先校验，须明确不可绕过的事件边界并提供实际乱序回放证明，不得让领域层凭无法区分的事件直接接受新版本。

### R5-CORR-02 · 上轮发送确认能冒充新轮交付；失效回包可堵住重审批次

- `task.ts:24,226–229,335–338,384–394`：`DeliveredCard` 仅有 kind，不绑定 commit、审查轮次或发送请求。实测 v0 的 T7 发送确认延迟，再将任务改到 v1、新 commit、新审查轮次的 T7；投递旧 `DeliveredCard` 后实际直接进 v1 的 T8a。领域层没有字段可知道这是上一轮发送确认，也不能证明新一轮卡片已发送。
- 新增迟到生产记录路径还有一个批次反例：在旧 T7 上单独处理已绑定生产实例迟到的同厂商模型记录，原版会正确撤销审查并返回 T5 + `request-review(round=2)`；但 `applyAll([该记录, 上轮 DeliveredCard])` 的第二条在 T5 被拒，整个返回值仅有 `ok:false/reason`，不提供前一步的更新任务或重审 effect。纯函数入参未变；若宿主按整批成功才提交/重放，会留在旧 T7，必须额外拆批/跳过才能恢复。没有真实 Outbox 或群消息测试，不能声称实际消息已发出或已被接受。
- 为发卡请求及发送 ACK 绑定同一交付代次、commit/条件及审查轮次；旧发送确认不可证明新卡已送达。明确 `applyAll` 的原子/前缀语义，使迟到旧 ACK 不能吞掉有效的审查撤销；实际宿主发卡的提交前版本校验、取消/失效标记与乱序回执另需跨层验证。

### R5-CORR-03 · 首派重发时旧版本回包仍可阻断新实例上线

- `task.ts:269–293,384–394`：首派 L0 在途时 Amend 到 v1 并重发 L1，旧执行器的 `NeedHuman(v0)` 或 `SubmitForReview(v0)` 在 T2 均无条件拒绝；`applyAll([旧回包, Dispatch(L1)])` 返回 false，不处理当前实例上线，单独投递同一 L1 Dispatch 则正常。
- 第 7 栏已说明启动在途时拒绝提问/提审、不缓存乱序；这里进一步确认**可由版本判定为旧的回包也会阻断同批后续有效事件**。在保留“当前版本、未回绑的真实提问/提审须保守拒绝或可靠重投”的同时，对可确认的旧版本/旧请求回包做幂等忽略或通过有证据的宿主保序/重投协议处理，并验证后续新实例能上线。真实适配器如何投递仍未测。

### R5-TEST-01 · 第四轮变异均杀死，但新重判契约仍有单点回归盲区

E01–E09 是**人为单点改坏的变异，不是指控原版已有这些错误**。每项均在隔离副本跑 115 项原测试及 typecheck、均 exit 0；并对原版和变异版分别运行实际路径对照：

| ID | 可存活的单点变异 |
|---|---|
| E01 / E02 | 只认最近两个曾回绑实例；第三次换实例后最早实例的生产记录被丢弃，审前可放行同厂商、审后可漏触发重审 |
| E03 | 审后迟到的 `unknown` 生产厂商不触发重审，仍显示 compliant |
| E04 / E05 | 审查批准快照不冻结或沿用调用方可变引用，可篡改之后重判依据 |
| E06 | 触发重审时保留旧 `approval` 对象，违反 T5 无当前批准的字段契约 |
| E07 | 迟到生产记录触发重审时把负责人改成提出者 |
| E08 | 在 T1 已改条件后认领，首派请求仍绑定版本 0 而非新版本 |
| E09 | 当前实例未来版本的迟到回包被拒而非忽略，可挡住后续当前卡有效回复 |

E10（迟到生产厂商冲突时不重审）被具名测试杀死且 typecheck 绿。建议对多次换实例后最早实例、未知厂商迟到、批准快照不可变/不共享、重审身份清理、认领前改条件和版本乱序补独立双侧对照；131 项全杀不等于这些新分支已标定。

## 三、逐项复核第四轮返修与未测边界

- **R4-CORR-01：所实现的已回绑实例路径复现有效。** 老实例记录在新实例回绑后仍累计；审后迟到记录在四个交付状态不合规时撤销旧结论并重审；仍合规、显式豁免和未回绑孤儿阴性路径按作者选择处理。纯函数无法证明模型记录已全部收齐；未回绑孤儿是否真的不可能在隔离/回绑前写入产物仍需宿主证明，不能仅以未回绑推断实际没有贡献。
- **R4-CORR-02：原先 T4b 旧提问/提审阻断有效用户回复已复现修好。** 当前实例当前版本的不合法重复仍拒绝；T2 首派重发期的不同旧事件批次见 R5-CORR-03。
- **R4-CORR-03：首派认领产生 L0，首派在途取消/上线/停止确认与改条件重发均已独立复现。** 宿主须在确认撤销 L0 后保证不会再实际发送该启动请求；这是已披露、未接真实适配器的边界。
- **R4-TEST-01：D01–D11 在作者 131 项变异执行中均被具名测试杀死。** 新增 E01–E09 暴露的是新实现条件的测试不足。
- **补充第 7 栏：**T9 中 `ProducerModelAdded` 对已回绑旧实例也无条件忽略，实际不会并入集合；该状态目前只走取消/失败且终态记录被声明忽略，审查没有将其等同于已交付的直接门禁绕过，但“晚到记录不丢弃”的口径需限制状态，后续重开/审计须补证。T9/T10/T11 改条件、真实模型身份及事件认证、模型/工作区隔离、CAS/租约、实际恢复、资源回收、Handoff 内容、卡片发送和 UI 均未做跨层验证。

复现（仓库根目录；独立行为测试当前预期 6 红、3 绿）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review5-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# 各变异补丁及测试/typecheck 输出见 "$E/mutants/E01" … "$E/mutants/E10"。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前四轮及作者其余收据字段。返修后继续由不同厂商独立复现。

### 第五轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 实际报告当前已落盘会话中没有输出等于本轮 hash 的调用、审查那轮厂商认不出；活动轮次尚未落盘，本轮 hash 命令与原始 rollout 的实际模型已分别实查，**不声称来源门禁通过**。当前轮记录落盘后由原任务复跑，不伪造记录。原始输出见证据目录 `gates-after.log`。

---

# 第六轮 · Codex 独立复现（2026-11-05）

## 结论：reject

`78cecbb5463dbafe8fe89775d163a3ee964a3b68` 的 126 项原样测试、151 项作者变异，以及第五轮旧交付代次与重审批次的主要正反路径均可复现；但孤儿实例的停止确认会删除其唯一身份记录，导致**同一已停止孤儿的迟到回包再次阻断当前启动，重复上线/确认还能产生两次释放同一槽位的 effect**。此外，无效、从未分配的 0/负数/小数交付代次被当成旧代次成功忽略，与本轮契约的“未分配即拒绝”不符。自造 9 个变异有 8 个存活。审查仅执行纯函数与隔离副本，没有启动真实进程或真实回收槽位；返修交回 Claude Code，不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），跨厂商、无豁免。
- 普通独立 clone；`.git` 与 common dir 均为该副本自己的目录。`origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 为 `133cf7abcf6c897653f5b91647202c4ac963f231`；二者只差 PR #2 的审查/收据文件。
- 仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
44bbc3fb9e46aac0c164275cb18f893d2d909a8769847fc98a09407ee8e924ba
```

- 原始日志、独立行为测试、事件路径探针、9 个变异补丁及测试/typecheck/比较结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review6-evidence-5fd2f15b/`。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，126 通过、0 失败、0 跳过 |
| 红提交 `bccccdbfd0034e6de7e6b2acfa61b583e8c85ab5` 完整具名测试 | exit 1，23 通过、103 具名失败：102 条报“未实现”、1 条 TABLE undefined；红绿测试文件相同。空壳红是激活证据，不是 103 条各自的缺陷复现 |
| 红测试配旧版 `fdfecb1` 实现，在另一隔离副本运行 | exit 1，117 通过、9 具名失败；与 `packages/domain/proof/red-against-fdfecb1.tap` 的失败名称集合完全一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 126 绿，151 项出现具名失败；第五轮 E01–E09 均被杀；文件级失败不算杀死 |
| 本轮独立行为测试 | **6 红、2 绿**：已确认停止的孤儿旧提问/提审、未分配数字代次、模拟跨任务错路由，以及 T2/T9 孤儿重复上线后重复释放；确认前旧提问和当前合法路径对照通过。跨任务红仅证明领域接口能力边界，不等于已观察到宿主误路由 |
| 本轮独立事件矩阵 | 旧卡接受/退回/超时、旧发送 ACK、迟到生产记录重审批次、当前交付及首派重发旧版本对照均通过 |
| 自造 F01–F09，逐项跑完整测试和 typecheck | **8 项存活**（每项 126 绿、typecheck exit 0）；F09 阳性对照被具名测试杀死且 typecheck 绿 |

## 二、必须返修

### R6-CORR-01 · 确认停止后忘掉孤儿身份，迟到回包阻断及重复释放

- `packages/domain/src/task.ts:183–197,284–290,314–322,397–406`：孤儿上线后记在 `orphans`，`StoppedConfirmed(computeId)` 清掉该 ID 并发 `release-slot`；`provablyStale` 随后只能查 `instances` 或**当前** `orphans`，没有已确认停止的孤儿记录。
- 独立纯函数序列：T2 等待当前首派 L0；错误请求的 `stopped-orphan` 上线，被登记并发 stop。**确认之前**它携当前条件版本的迟到 `NeedHuman` 被正确忽略；收到该孤儿停止确认后，同一个迟到提问或提审变成 `ok:false`。`applyAll([孤儿旧回包, 当前 L0 的合法 Dispatch])` 在第一条停止；单独执行相同合法 Dispatch 可以上线。这里说的是已被本任务登记且确认停止的实例，不是未知当前来源。
- 同一根因还可重复产生释放 effect：孤儿上线 → `StoppedConfirmed` 返回一次 `release-slot(id)` → 同一个上线回包迟到重放 → 再次登记/stop → 同一个停止确认重放，实际又返回一次 `release-slot(id)`。T2 和 T9 均亲自复现。只观察了**两次同 ID 释放意图**，没有接真实槽位表，不能声称实际超配或重复扣减已经发生；宿主资源层的幂等也尚未验证。
- 需保留能识别已结束实例及已消费确认的持久身份/幂等账本（可采用有界生命周期设计），让旧回包在确认前后都不阻断当前代次；同一实例/请求的重复上线与确认不可二次发释放。覆盖 T2/T3 新启动、T9、上线/确认乱序和不同合法实例的阴性对照；资源层也要对重复释放做可验证的幂等，不靠进程内数组假设。

### R6-CORR-02 · 从未分配的交付代次被静默当成旧代次

- `task.ts:291–295,426–440`：交付号从 1 开始递增，但 `staleDelivery` 只判断 `deliveryRound > deliverySeq`。在当前交付 round=1 时，`UserAccept` 的 round `0`、`-1`、`0.5`（均为 TypeScript `number`）都返回 `ok:true`、任务原样不变；round `2` 才被拒绝，round `1` 正常接受。前三个数都从未分配。
- 这不是“无效代次获得了验收”：上述输入没有推进状态；问题是与本轮明确契约“已分配的旧代次忽略，**未分配的代次拒绝**”不符，调用方可能把成功的无操作当作已消费。若外层在反序列化前已保证正安全整数，也必须明确并验证该边界；当前公开事件类型仅为 `number`。
- 先校验代次为正安全整数并确实属于本任务已分配的范围，再区分历史代次忽略与当前交付校验；未来、零、负数、小数和非有限值应有明确拒绝/解析错误，保留合法旧代次幂等与当前代次正例。不要把任务间相同数值自动视作同一代次，见下述边界。

### R6-TEST-01 · 第五轮变异均杀死，但多代交付与已知孤儿分支仍有回归盲区

F01–F08 是**人为单点改坏的变异，不是指控原版已有这些错误**。每项均在隔离副本跑完 126 项原测试与 typecheck，均 exit 0；各项另跑原版与变异版路径对照：

| ID | 可存活的单点变异 |
|---|---|
| F01 / F02 | 未回绑时不识别已登记孤儿，或只认最近两个历史实例；已知旧来源的同版本回包被拒并可中断批次 |
| F03 | 第三次交付后，最早交付的迟到回包不再忽略，阻断后续当前卡确认 |
| F04 / F05 / F08 | 多次条件修改或第三次交付时，`send-card` effect 携带错误条件版本、commit 或交付轮次 |
| F06 | 未核验归档后退回时交付序列清零；同 commit 再交付重用旧轮次，旧点击可误验收新版本 |
| F07 | 只对 `UserAccept` 检查旧交付 commit；旧退回与当前确认同批时意外拒绝并中断 |

F09（未回绑的未知当前来源也忽略）被具名测试杀死且 typecheck 绿，作为阳性对照。应补已登记孤儿的当前版本来源、多次历史实例和至少三次交付、不同事件种类的旧 commit、归档后重交付及 effect 字段的双侧测试；不能以 151 项作者变异全杀推断这些分支已被充分标定。

## 三、逐项复核第五轮与边界

- **R5-CORR-01：原有跨版本旧卡路径复现修好。** 旧 round 的接受/退回/超时均不改变新交付，当前 round 合法事件生效；未来正整数 round 在 T8a 被拒。0/负/小数并非已分配代次，仍被忽略，见 R6-CORR-02。
- **R5-CORR-02：原有旧发送 ACK 与重审批次路径复现修好。** 新 `send-card` 携当次 round、commit、条件版本；旧 ACK 不把新一轮标成已交付，迟到模型 + 旧 ACK 的批次返回 T5 和重审 effect。真实宿主发卡前重校验及 UI 旧卡失效仍未测。
- **R5-CORR-03：已知旧版本、已绑定实例和停止确认前已登记孤儿的回包可忽略；未知来源当前版本仍拒。** 孤儿停止确认后身份被删除的路径未闭合，见 R6-CORR-01。
- **R5-TEST-01：E01–E09 在作者脚本均被具名测试杀死。** 本轮 F01–F08 是新增分支的独立测试盲区。
- **交付任务身份边界：**D20.3 的 `E6(target_id, decision, expected_ver)` 指定 T8a 的 target 是 `task_id`（`docs/spec/需求文档.md:1488`）。当前交付事件和 `send-card` effect 只携 task 内数字 round 与 commit，不携 task ID。独立构造任务 A/B：同一提出者、同一 commit、各自 round=1 时，模拟把 A 的 `UserAccept` 投给 B，纯函数会让 B 进入 Accepted；本轮没有真实路由器，也没有证明宿主发生串包。宿主必须把经认证的 task/card 身份绑定到 effect、回包和事务，或领域事件自身携 task ID 并校验，再做 A/B 同提交同轮次错路由的跨层测试；不能仅凭 round+commit 声称跨任务隔离已经验证。
- T9 下换模记录忽略、真实模型身份与事件认证、工作区隔离、CAS/租约、实际恢复/资源回收、Handoff、发送 Outbox、卡片 UI 和完整状态机均仍是第 7 栏所述未测边界。本轮没有将纯函数 effect 当成 OS 或 UI 实际完成。

复现（仓库根目录；独立行为测试当前预期 6 红、2 绿，其中跨任务用例模拟宿主错路由）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review6-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# 各变异补丁及测试/typecheck 输出见 "$E/mutants/F01" … "$E/mutants/F09"。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前五轮及作者其余收据字段。返修后继续由不同厂商独立复现。

### 第六轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 实际报告当前已落盘会话中没有输出等于本轮 hash 的调用、审查那轮厂商认不出；活动轮次尚未落盘，本轮 hash 命令与原始 rollout 的实际模型已分别实查，**不声称来源门禁通过**。当前轮记录落盘后由原任务复跑，不伪造记录。原始输出见证据目录 `gates-after.log`。

---

# 第七轮 · Codex 独立复现（2026-11-06）

## 结论：reject

`a425387bc9781f53a44f48892dfb041cd8f7f3e4` 的 138 项原样测试、169 项作者变异，以及第六轮已退役实例、合法 taskId 和非法数字代次的主要路径均可复现；但新增入口校验**仅在 taskId 存在时比对**，缺失该必填字段的运行时 JSON 仍能触发交付、验收、退回、超时及停止确认。另有部分交付状态把从未分配的未来代次成功忽略，而非按本轮声明拒绝。自造 10 个变异有 9 个存活。审查只跑纯函数和隔离副本，没有发真实卡片、启动真实进程或回收真实槽位；返修交回 Claude Code，不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），跨厂商、无豁免。
- 普通独立 clone；`.git` 与 common dir 均为该副本自己的目录。`origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 为 `133cf7abcf6c897653f5b91647202c4ac963f231`；二者只差 PR #2 的审查/收据文件。
- 仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
74317f462b5f5935556fc7a79efd93e8b54df3e0088433a4f39ca2b01c76b1f2
```

- 原始日志、独立行为测试、类型/JSON 对照、事件路径探针、10 个变异补丁及测试/typecheck/比较结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review7-evidence-5fd2f15b/`。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，138 通过、0 失败、0 跳过 |
| 红提交 `bb21b878d74776343c44685c031e8563dee19b79` 完整具名测试 | exit 1，23 通过、115 具名失败：114 条报“未实现”、1 条 TABLE undefined；红绿测试文件相同。空壳红是激活证据，不是 115 条各自的缺陷复现 |
| 红测试配旧版 `78cecbb` 实现，在另一隔离副本运行 | exit 1，128 通过、10 具名失败；与 `packages/domain/proof/red-against-78cecbb.tap` 的失败名称集合完全一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 138 绿，169 项出现具名失败；第六轮 F01–F08 均被杀；文件级失败不算杀死 |
| 本轮独立行为测试 | **6 红、2 绿**：五类缺 taskId 的运行时输入、已验收状态未分配未来代次；明确错任务 ID 的拒绝/当前任务正例、已退役旧实例与当前上线对照通过。缺字段输入不符合静态 TaskEvent 类型，见下一节的类型与 JSON 区分 |
| 本轮独立事件矩阵 | T2/T9 退役实例重放只释放一次，退役旧提问不阻断当前上线；明确错误 taskId 被拒，当前 taskId 正常，0/负数/小数/非有限代次被拒 |
| 自造 G01–G10，逐项跑完整测试和 typecheck | **9 项存活**（每项 138 绿、typecheck exit 0）；G10 阳性对照被具名测试杀死且 typecheck 绿 |

执行纠错：初次 SSH 独立 clone 因 `Permission denied (publickey)` 退出 128；改用 GitHub 现有凭据经 HTTPS 建立新的普通独立 clone，未修改全局 Git 凭据配置。独立 TypeScript JSON 探针第一次显式传文件时因 TS5112（存在 tsconfig，需 `--ignoreConfig`）exit 1；加参数后 typecheck exit 0、运行 exit 0，日志均保留在证据目录。这两项是审查执行环境/命令问题，不当作产品失败。

## 二、必须返修

### R7-CORR-01 · 必填 taskId 在运行时缺失时绕过入口校验

- `packages/domain/src/task.ts:24–33,441–455`：五类事件的 TypeScript 联合类型声明 `taskId` 必填，但 `misrouted` 的实际判断是 `ev.taskId !== undefined && ev.taskId !== t.id`。字段**存在但错投**确会拒绝；字段缺失或值为 undefined 时，条件为 false，继续执行状态表。
- 独立纯函数运行时对照：目标任务 B 的当前交付是 `(round=1, commit=same)`。`UserAccept(taskId=A, ...)` 投给 B 被拒；去掉 taskId、其余字段不变，实际返回 `ok:true`、B 进入 `T8_Accepted`。同样去掉 taskId 的 `DeliveredCard`、`UserReject`、`AcceptTimeout` 分别推进到 T8a、返工和未核验归档；去掉 taskId 的 `StoppedConfirmed(computeId=B-c)` 能使 B 从 T9 到 T10 并发 `release-slot(B-c)`。仅观察领域状态/effect，未发送实际卡片或释放实际资源。
- **区分静态类型和运行时输入**：字面量缺 taskId 作为 `TaskEvent` 编译失败（exit 2，TS2322）；但本轮另写了明确标注 `const input: TaskEvent = JSON.parse(...)` 的 TypeScript 探针，`tsc --ignoreConfig ...` exit 0，执行 exit 0 且缺 taskId 的输入令 B 验收。`JSON.parse` 不自动验证结构，静态必填不能替代外部事件的运行时校验；本轮未发现或声称实际宿主已接入这样的未校验 JSON 路径。
- 既然本轮声称这五类事件**必填 taskId 并在入口拒绝错投**，应在领域入口或不可绕过的宿主解码边界校验字段存在、为有效字符串且等于当前任务；缺字段/undefined/null/错误类型均应拒绝且不改变状态、不发 effect。补五类事件的缺字段与错误任务 ID 双侧对照，并保留其他尚无 taskId 事件的既定行为。若只在宿主校验，需提供实际宿主入口/解码器及乱序错投测试，而不是只依赖类型声明。

### R7-CORR-02 · 部分交付状态把未分配的未来代次成功忽略

- `task.ts:432–455`：正安全整数校验已修复 0/负数/小数；但 `staleDelivery` 对 `deliveryRound > deliverySeq` 返回 false 后直接落到状态表。部分状态用 `ign`，没有经 `forDelivery` 拒绝未来代次。
- 真实事件矩阵：当前 `deliverySeq=1`，有效 taskId B、未来 round=2。T8a 的四类未来交付事件都拒绝；但 T7 的 `AcceptTimeout` 返回 `ok:true`；T8_Accepted 的 `DeliveredCard/UserAccept/AcceptTimeout` 返回 `ok:true`；T8_ArchivedUnverified 的 `DeliveredCard/AcceptTimeout` 返回 `ok:true`。它们均没有推进状态；问题是与本轮和第 7 栏“从未分配的未来代次在交付状态拒绝”的口径不符，成功无操作也可能被上游当作有效消费。
- 在统一入口区分合法已分配历史代次、当前代次和从未分配的未来代次，明确不同状态都应拒绝还是哪些终态允许无害忽略；如果有意豁免终态，先修正契约与收据并加状态矩阵，而不是把单一 T8a 正例扩大为全部状态通过。旧已分配代次仍应幂等忽略，当前正例仍正常。

### R7-TEST-01 · 本轮新增身份与退役账本的分支仍有回归盲区

G01–G09 是**人为单点改坏的变异，不是指控原版已有这些错误**。每项隔离运行 138 项原测试与 typecheck，均 exit 0；各项再对照原版与变异版纯函数结果：

| ID | 可存活的单点变异 |
|---|---|
| G01 | 失败停止的 `StoppedConfirmed` 不核 taskId，错误任务确认可让当前任务进 T11 并发释放效果 |
| G02 / G03 | 已验收状态的退回、未核验归档状态的补确认不核 taskId，可分别误返工或误验收 |
| G04 | 只有 `UserAccept` 校验代次正整数；其他交付事件的非法 round 被成功忽略 |
| G05 | `retired` 账本不冻结，外部可清掉已停身份 |
| G06 / G07 | 第三个孤儿退役时丢掉更早记录，或当前实例停止时覆盖旧退役账本；旧回放可重新产生释放效果 |
| G08 | 未回绑时只识别最近两个退役实例；更早已停实例的迟到回包又被拒绝 |
| G09 | 退役实例重放上线时误停止当前活动实例，而非重放实例 |

G10（完全删除跨任务校验）被具名测试杀死且 typecheck 绿。应补不同任务状态和失败/取消原因、四类交付事件的非法数值、至少三个退役实例、当前停止保留旧账本、退役重放时存在另一活动实例、`retired` 冻结及缺字段 JSON 的双侧对照。169 项作者变异全杀属实，但不能据此推断这些新增分支也已标定。

## 三、逐项复核第六轮与边界

- **R6-CORR-01：原有两条孤儿迟到/重复释放路径复现修好。** T2/T9 已停实例重放只重新发 stop、不重新登记；重复停止确认不再发 release-slot；旧提问后当前实例可上线。宿主资源侧 release-slot 幂等仍未验证；`retired` 只增不减、每次状态快照复制，当前未做容量或长期负载测试，不能仅凭“任务内实例数有限”证明其有界。
- **R6-CORR-02：0/负数/小数/NaN/Infinity 被拒，当前合法代次正常。** 未分配的未来正整数在部分交付状态仍被忽略，见 R7-CORR-02。
- **跨任务错投：带明确且不匹配 taskId 的五类事件已复现被拒，send-card 带本任务 ID。** 缺字段运行时输入仍可绕过该入口，见 R7-CORR-01。taskId 是否来自可信认证、HumanReply 与执行侧回包如何绑定任务，仍需真实宿主/路由验收。
- **R6-TEST-01：F01–F08 在作者脚本均被具名测试杀死。** 本轮 G01–G09 是新增分支的独立测试盲区。
- 仍未实测真实模型身份采集、工作区隔离、CAS/租约、实际恢复/资源回收、Handoff、Outbox、旧卡 UI、T9/T10/T11 改条件与完整状态机。纯函数的效果不等于 OS 或 UI 已执行。

复现（仓库根目录；独立行为测试当前预期 6 红、2 绿，其中缺字段来自模拟未验证 JSON，而不是合法 TS 字面量）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review7-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-probes.mjs" "$PWD"
# typed-json-probe.mts 与其 typecheck/运行日志、各变异补丁见证据目录。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前六轮及作者其余收据字段。返修后继续由不同厂商独立复现。

### 第七轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 实际报告当前已落盘会话中没有输出等于本轮 hash 的调用、审查那轮厂商认不出；活动轮次尚未落盘，本轮 hash 命令与原始 rollout 的实际模型已分别实查，**不声称来源门禁通过**。当前轮记录落盘后由原任务复跑，不伪造记录。原始输出见证据目录 `gates-after.log`。

---

# 第八轮 · Codex 独立复现（2026-11-06）

## 结论：reject

`4cd80a3f302e913f62cbcd871c579847ea0ab418` 的 150 项原样测试、189 项作者变异，以及第七轮缺 taskId 和未来交付代次的主要修复路径均可复现；但新 `validateEvent(e: unknown)` 对某些**可由标准 JSON.parse 产生的未知 kind** 会抛 `TypeError`，而不是返回拒绝。自造 10 项变异有 9 项存活。审查只运行纯函数及隔离副本，没有启动真实服务、发送卡片或修改产品代码；返修交回 Claude Code，不合并 PR。

- 审查会话 `codex:5fd2f15b-443d-4c5b-a287-dfa6fe248103`，原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）；作者会话涉及目标仓库的实际模型为 `claude-opus-5-5`（Anthropic，不同渠道前缀），跨厂商、无豁免。
- 普通独立 HTTPS clone；`.git` 与 common dir 均为该副本自己的目录。`origin/feat/domain-core=afd02560f9546147da380382404eb6106222a9b8`，与 HEAD 的 merge-base 为 `133cf7abcf6c897653f5b91647202c4ac963f231`；二者只差 PR #2 的审查/收据文件。
- 仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
673839576013644b72eae0107b98fa014eb8e8808dbf8441474ef94cc3cc06d4
```

- 原始日志、独立行为测试、375 项形状矩阵、旧 U02 隔离等价对照、10 个变异补丁及测试/typecheck/比较结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review8-evidence-5fd2f15b/`。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1` / npm `11.11.0` |
| `npm test` | exit 0，150 通过、0 失败、0 跳过 |
| 红提交 `889050e8a2d37dc3c411d6f2ef71d27aefa30691` 完整具名测试 | exit 1，23 通过、127 具名失败：126 条报“未实现”、1 条 TABLE undefined；红绿测试文件相同。空壳红是激活证据，不是 127 条各自的缺陷复现 |
| 红测试配旧版 `a425387` 实现，在另一隔离副本运行 | exit 1，142 通过、8 具名失败；与 `packages/domain/proof/red-against-a425387.tap` 的失败名称集合完全一致。旧版不导出新符号，为避免文件级加载失败，**在隔离副本追加一行恒返回 null 的 `validateEvent` 桩**；其余旧实现原样，不能称为未经修改的旧实现运行 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 150 绿，189 项出现具名失败；W01–W11 均被杀；文件级失败不算杀死 |
| 本轮独立形状矩阵 | 15 种事件、375 项独立期望检查；372 项符合预期，3 个 JSON 可表示的未知 kind 抛 TypeError，脚本 exit 1 |
| 本轮独立行为测试 | **3 红、2 绿**：同一 JSON 异常 kind 分别经 `validateEvent`、`apply`、`applyAll` 抛异常；普通未知 kind、合法 Claim/额外字段对照通过 |
| 本轮独立事件矩阵 | 五类事件缺/错 taskId 被拒且有效正例通过；四个交付状态 × 四类未分配未来事件均拒；已分配旧代次忽略 |
| 旧 U02 注入点隔离对照 | 去掉 `forDelivery` 的原比对后原测试 150 绿、typecheck 绿；15,552 个状态/代次/commit/任务/事件组合的输出一致。入口先拒未来代次，再忽略所有与当前交付不符的已分配代次，故该后置比对对到达它的事件无额外作用；有限组合结果与代码路径均支持作者将其判为等价变异、转而测试入口，不把“旧变异存活”误报为当前缺陷 |
| 自造 H01–H10，逐项跑完整测试和 typecheck | **9 项存活**（每项 150 绿、typecheck exit 0）；H10 阳性对照被具名测试杀死且 typecheck 绿 |

旧 U02 对照首次汇总日志时相对路径写错，`tail` 报文件不存在；已从本轮隔离目录实际写入的位置复制并核对完整测试/类型检查日志，不把汇总命令的路径错误当作产品失败。

## 二、必须返修

### R8-CORR-01 · 标准 JSON 的异常 kind 可使入口抛异常，而非拒绝

- `packages/domain/src/task.ts:472–480,488–500`：非字符串 kind 也进入错误消息模板 `${String(kind)}`。当 kind 是从合法 JSON 得到的普通对象、其自有 `toString` 被置为非函数时，JS 无法将其转为原始值，`String(kind)` 自身抛 `TypeError`。
- 最小输入是标准 JSON，不需要 Proxy、getter 或自定义类：

```json
{"kind":{"toString":null}}
```

  本轮对 `JSON.parse` 的结果分别调用 `validateEvent`、`apply(newTask(...), ...)`、`applyAll(newTask(...), [...])`，三者均抛 `TypeError: Cannot convert object to primitive value`，没有返回约定的原因或 `ok:false`。`{"kind":{"toString":{},"valueOf":{}}}` 和 `{"kind":[{"toString":null}]}` 同样复现；普通 `{"kind":{}}` 正常返回“未知的事件种类”，作为阴性对照。
- 在单独 Node 进程中不加外层捕获调用 `apply`，实测进程 exit 1，栈指向 `task.ts:476`。这证明库调用可抛出而非按契约拒绝，**不声称真实宿主没有全局异常捕获或已发生线上故障**；如果宿主按事件批次处理，异常可能中断该批次，但实际宿主行为未测。
- 对非字符串 kind 返回固定、不依赖输入强制转换的错误，再仅对安全字符串做枚举比较；若错误消息需要包含不可信值，必须保证格式化本身不会抛异常。补上述真实 JSON、嵌套数组、普通未知字符串/对象、合法事件及 `apply/applyAll` 三条入口对照。拒绝时应返回结构化失败、不改任务、不发 effect。

### R8-TEST-01 · 表驱动校验覆盖改善，但取值域与异常格式化仍有盲区

H01–H09 是**人为单点改坏的变异，不是指控原版已有这些错误**。每项隔离运行 150 项原测试与 typecheck，均 exit 0；各项另对照原版和变异版纯函数结果：

| ID | 可存活的单点变异 |
|---|---|
| H01 | 正整数改用 `Number.isInteger`，允许超过 MAX_SAFE_INTEGER 的审查轮次 |
| H02 / H03 | 非空字符串额外禁止非 ASCII（中文联系人名被拒）；或拒绝未知附加字段（违反本轮允许多余字段的契约） |
| H04 / H05 | 布尔接受数组或字符串 `"false"`；无效退回请求中的 truthy 值可错误发恢复原实例 effect |
| H06 / H07 | 枚举接受 `"yes"` 或把 `"APPROVE"` 大小写折叠通过，但后续分支仍按原字符串比较，错误发停止效果 |
| H08 | `Review.reject` 的 `computeResumable` 仅检查是否存在、不检查布尔；字符串 `"false"` 可被当 truthy 恢复实例 |
| H09 | 数字 kind 被错误放过，后续 `apply` 对未定义表格抛 TypeError |

H10（非负整数允许超出安全范围）被具名测试杀死且 typecheck 绿，作为阳性对照。原版对上表探针均按契约拒绝或允许；这些是**测试保护不足**，不是原版现有逻辑错误。建议独立覆盖正安全整数上界、合法非 ASCII/额外字段、布尔的数组/对象/`"false"`、枚举多种非法字符串及大小写、reject 条件字段的所有非法类型、数字/对象 kind，且保留合法布尔/枚举与正常事件的阴性对照。

## 三、逐项复核第七轮与未测边界

- **R7-CORR-01：五类事件缺失/null/类型错/空 taskId 形状校验已生效。** 本轮独立矩阵另对五类缺 taskId、错误 taskId 和正确 taskId 实际调用 `apply`，均符合预期；可信身份认证/真实宿主路由仍未测。
- **R7-CORR-02：未来交付代次在四个交付状态 × 四类事件均被拒；已分配旧代次正常忽略。** 已独立验证 16 格与旧代次对照。
- **R7-TEST-01：G01–G09 在作者脚本均被具名测试杀死。** 本轮 H01–H09 是新形状校验分支的独立测试盲区；真实 JSON 异常 kind 属 R8-CORR-01 的实际原版缺陷。
- **停止/失败来源语义需明确：**当前 `StoppedConfirmed(taskId)` 不带 computeId/requestId、以及 `ExecFailed` 不带任何来源，`validateEvent` 均返回 null，`apply` 成功无操作；作者现有测试也明确将这两种形状列为合法。它们不会触发停止或释放，但与源码注释“必须指明哪个实例或启动”可能造成调用方将无来源信号视为成功消费。若产品要求至少一个来源，应在类型/验证与宿主协议中明确；若有意接受为空作噪声，需把该语义与重投/告警责任写清。本轮不把这个已被测试明确选择的边界单独当成必修结论。
- `retired` 无上界、可信 taskId/computeId/model 的认证、宿主发卡前重校验、旧卡 UI、工作区隔离、CAS/租约、真实恢复与资源回收、T9/T10/T11 改条件及完整状态机均仍未做跨层验证；不把纯函数 effect 当作真实进程或 UI 完成。

复现（仓库根目录；独立行为测试当前预期 3 红、2 绿）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review8-evidence-5fd2f15b
REVIEW_REPO="$PWD" node --test "$E/independent.test.mjs"
node "$E/independent-matrix.mjs" "$PWD"
node "$E/independent-shapes.mjs" "$PWD"
# 各变异补丁及测试/typecheck 输出见 "$E/mutants/H01" … "$E/mutants/H10"。
```

本轮只追加本报告并修改 `receipts/feat-task-lifecycle.json` 的 review 字段；保留前七轮及作者其余收据字段。返修后继续由不同厂商独立复现。

### 第八轮本地门禁的实际结果

写入 reject 收据后运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`：exit 1。`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 实际报告当前已落盘会话中没有输出等于本轮 hash 的调用、审查那轮厂商认不出；活动轮次尚未落盘，本轮 hash 命令与原始 rollout 的实际模型已分别实查，**不声称来源门禁通过**。当前轮记录落盘后由原任务复跑，不伪造记录。原始输出见证据目录 `gates-after.log`。

---

# 第九轮 · Codex 独立复现（2026-11-06）

## 结论：reject

`52eb37af7a67ca34abe4269d5e294e0cffc2f764` 修复了第八轮所报的异常 **kind**：标准 JSON 的异常种类、原型链名字和读取时立即抛错的 getter，在 `validateEvent` 中均按预期拒绝；原样 159 项测试与作者的 204 个变异复现通过。但审查发现 **校验与后续实际使用不是同一个事件快照**：继承来的可选字段仍能触发停止、释放和豁免；另一个标准 JSON 附加字段能令 `apply` / `applyAll` 抛异常；校验后变化的 getter 还能写入非法类型或触发错误副作用。独立注入的 4 个变异存活。必须返修并补测，不能合并。

- 对象：`feat/task-lifecycle` HEAD `52eb37af7a67ca34abe4269d5e294e0cffc2f764`；指定基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`。普通独立 clone，`.git` 和 common dir 均是本副本自己的 `.git`，不在共享 linked worktree 执行钩子。
- 审查：`codex:494d03f8-8b47-4ae3-a080-43526db82afd`；本轮原始 Codex `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 中涉及本仓库的模型记录为 `claude-opus-5-5`（Anthropic，两个渠道前缀）；双方不同原生研发厂商，无豁免。
- 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
3afaf9c960a1ded93a509aebebf45ba591aefa7b7a8fd4e340dde9e5e19d59d8
```

- 证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review9-evidence-494d03f8/`。本轮执行纯函数和隔离副本；没有启动真实 Compute、发送卡片或修改产品代码。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1`、npm `11.11.0` |
| `npm test` | exit 0，159 通过、0 失败、0 跳过 |
| 独立 clone 检出红提交 `0fd741e6cef41933bb0a18ade77c6a9275f84187` | 159 项中 23 通过、136 **具名失败**，exit 1；按文件与名字比对指定基线以来新增/改动的 136 条测试，红提交全部按名失败、当前版全部按名通过，文件级失败 0；红绿测试文件无差异。该空壳红主要证明测试激活源码，不等于逐项复现缺陷 |
| 新测试原样对 `4cd80a3` 的实现 | 隔离 clone 中只将 `task.ts` 换成旧版原文，不加桩；154 绿、5 具名失败、exit 1，与 `packages/domain/proof/red-against-4cd80a3.tap` 的失败名称集合一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0；原样 159 绿，204 个单点变异均有具名失败。该结果只覆盖作者所选 204 个故障，不证明所有判据充分标定 |
| 独立行为测试 | 17 组：7 绿、10 红；包含 15 种事件的 444 条字段取值断言、异常 kind、getter、继承属性、交付代次、批次和下述反例；完整 TAP 与脚本见证据目录 |
| 独立变异 | J01–J04 各自隔离改坏一个位置，typecheck 与原 159 项测试均绿，实际行为与原版不同；J05 删状态表一格后 typecheck 与两个具名 AC-09 测试均红；J06 增加事件、全格补齐并同步样例后 typecheck 和 159 项测试均绿 |

第一次试算 hash 时在 `npm ci` 之前运行，因缺少 `typescript` 退出 1；安装依赖后以用户指定原命令重跑，退出 0 并取得上面的原样输出。这是执行顺序错误，不是产品失败。

## 二、必须返修

### R9-CORR-01 · 校验忽略继承字段，状态机执行却仍使用它们

`packages/domain/src/task.ts:482–493` 的 `own()` 使验证阶段只看自有字段；但通过校验后，`execFailed`（144–147）、`ackStale`（198–203）、停止确认（403–412）、`review`（234–245）和 `misrouted`（501–506）又直接读取原事件对象或使用 `in`，会读取继承属性。以下都是独立测试的真实原版结果，对照均使用同一任务和同一事件，只改变字段是缺省、继承还是自有：

1. `ExecFailed` 没有自有 `computeId` 时，继承的 `computeId` 指向当前实例：`validateEvent` 返回 `null`，`apply` 却进入 `T9_StopRequested` 并发出 `stop-compute`；完全省略该字段则保持 `T3_Running`、无副作用。后续有效提问放在同一 `applyAll` 中也会被这次错误停止改变结果。
2. `StoppedConfirmed` 自有 `taskId` 正确，但 `computeId` 仅来自原型：当前实现会进入 `T10_Cancelled` 并发 `release-slot`；省略来源的对照仍在 `T9` 且无释放。自有的正确 `computeId` 正例仍正常确认。
3. 同厂商审查事件没有自有 `waiverBy`，仅从原型继承提出者 ID 时，`validateEvent` 接受，`apply` 记录 `waived-by-user` 并发 `send-card`；没有该继承值时正确拒绝，自有豁免值对照按现有领域契约记为 Waived。**这说明领域函数错误地消费了继承字段，不声称已证明真实宿主的身份认证或用户授权被绕过。**
4. 不声明 `taskId` 的 `Claim`，即使事件自有字段合法，继承的别任务 `taskId` 也会使其被错投检查拒绝，而无该继承值的对照正常认领。

应保证状态机只消费与形状校验相同的自有字段，并为可选 `computeId` / `requestId` / `waiverBy` 及无声明 `taskId` 的事件补验证和实际 `apply` / `applyAll` 正反对照。领域层仍不能代替宿主认证。

### R9-CORR-02 · 标准 JSON 的额外 `taskId` 能让入口抛异常

`packages/domain/src/task.ts:501–505` 对**任何**事件上出现的 `taskId` 都作错投判定，并在错误原因中对其插值；但 `Claim` 等事件的形状根本不声明 `taskId`，且本片明确允许多余字段。无需 getter 或 Proxy，标准 JSON 即可复现：

```json
{"kind":"Claim","by":"author","taskId":{"toString":null}}
```

`validateEvent` 返回 `null`，而 `apply` 和 `applyAll` 都抛 `TypeError: Cannot convert object to primitive value`；把该附加字段去掉或换为普通无关的 `extra` 字段，正常认领。附加的不同字符串 `taskId` 也会被错误当作该类事件的路由字段而拒绝。此处只观察到纯函数抛错，未假定线上宿主没有外层异常处理。

应只对本契约声明带 `taskId` 的事件做该字段的路由检查，或者明确修订并一致执行附加字段契约；不能让未校验字段插值或使批次抛异常。补普通 JSON 的恶意对象附加字段、普通附加字段和五类真正带任务号事件的正反对照。

### R9-CORR-03 · 通过校验后重复读取原对象，可绕过类型检查或抛错

`validateEvent` 内的 `try/catch` 只覆盖本次校验；`apply` 随后再次读取调用方原对象（`task.ts:299–304,482–493,501–517`）。这不是声称当前 `validateEvent` 对立即抛错 getter 不安全：该对照已经通过。问题是 JavaScript 对象的 getter 可以在两次读取之间返回不同值或第二次抛错：

- `Claim.by` 首次返回合法字符串、第二次返回数字 `42`，当前 `apply` 返回 `ok:true`、`owner:42`，并发 `spawn-compute`。
- `UserReject.computeResumable` 首次返回布尔 `false`、随后返回字符串 `"false"`，当前分支把字符串当真值，错误发 `resume-compute`，而不是不可恢复侧的处理。
- `kind` getter 校验时返回 `Claim`、下一次读取抛错，`apply` 直接抛错。

这些例子是带访问器的 JS 输入，不是普通 JSON；之所以在本轮范围内，是因为入口明确支持捕获字段读取异常。建议把经安全读取和验证的自有字段构造成稳定快照，供检查与转移共同使用；或者在入口一致拒绝不稳定的访问器。补上述变值、第二次抛错、正常稳定值和无副作用对照。

### R9-TEST-01 · R-05 的新边界仍存在可存活变异

以下是审查人**故意改坏**的独立单点变异，不是声称原版已存在对应的校验错误；每项均 typecheck exit 0、原 159 测试全部通过，并在独立探针中与原版表现不同：

| 变异 | 实际对照 |
|---|---|
| J01 事件 `kind` 改为读取继承属性 | 原版拒绝继承的种类；变异版校验通过 |
| J02 可选字段改为读取继承属性 | 原版忽略继承的非法可选字段；变异版错误拒绝 |
| J03 审查退回所需 `computeResumable` 改为读取继承属性 | 原版拒绝仅继承的字段；变异版错误通过 |
| J04 非负整数额外拒绝 `-0` | 原版按非负安全整数接受；变异版拒绝 JavaScript/JSON 可表示的负零 |

J05 为阳性对照：从 T1 表删除一个事件格，typecheck exit 2，两个 AC-09 具名测试失败；J06 为阴性对照：新增事件、为各状态补格并同步测试样例及期望后，typecheck 与原测试均通过。完整补丁、测试、类型检查与原版/变异版探针均在 `mutants/J01`–`J06`。R-05 要求每项判据的阳性与阴性对照；上述新边界既能被改坏而不被原套件检出，当前不能据 204 项作者变异全杀就断言这些判据已完成双侧标定。

## 三、与验收文档及收据第 7 栏对照

- **AC-09**：亲自检查本片 12 状态 × 15 事件的 180 格均有处理或原因，并跑了删格与新增完整事件双侧对照；这是本片主干，不等于需求文档 D20.3 全表。收据列出的 T2b、T4a/T4c、T6/T6b、T8b 和 E5/E7b/E10 等仍未建模，不能把整张需求表判绿。
- **R-02**：136 条新增/改动测试的红绿具名集合一致；空壳红是激活证明，另有未加桩的旧实现 5 条具名红。不能将空壳的 136 红解读成 136 个真实缺陷都在旧实现上复现。
- **R-05**：作者所选 204 个确实均被杀；J01–J04 的独立存活反证了覆盖充分性。收据将 R-05 写为“通过”，对上述新边界不成立，应在返修后重新校准。
- **第 7 栏精度**：`validateEvent` 对稳定自有字段、基本类型边界、原型名和立即抛错的字段读取，本轮所测符合描述；但“只读自有属性”和“多余字段不拒绝”不能推广为整个 `apply` / `applyAll` 链路已满足，R9-CORR-01/02 为反例；再次读取的不稳定 getter 也未受校验快照保护。其他已写明边界仍成立：taskId / computeId / 模型与豁免人真实性依靠宿主，退役账本无上界，真实进程恢复、资源回收、工作区隔离、CAS/租约、UI 卡片及跨层闭环本轮均未验。
- 本轮额外对四类交付事件 × 12 个状态各测未分配未来代次拒绝与已分配旧代次忽略；五类要求 taskId 的事件错任务均拒绝。这些是领域函数的标识比对，不是宿主认证证明。

复现：在该独立 clone 仓库根目录执行：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review9-evidence-494d03f8
REVIEW_REPO="$PWD" node --test --test-reporter=tap "$E/independent.test.mjs"
# 预期 7 绿 / 10 红；变异补丁与运行结果见 "$E/mutants/"。
```

本轮只追加本报告并更新 `receipts/feat-task-lifecycle.json` 的 `review` 字段；返修交回 Claude Code，由不同厂商再次独立复现。

### 第九轮本地门禁的实际结果

写入 reject 收据后，在此独立 clone 运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`，exit 1：`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 报 `审查会话记录不存在:codex:494d03f8-8b47-4ae3-a080-43526db82afd`；实查当前活动会话目录只有 `record.json`，尚无门禁读取的 `turns.jsonl`。本轮原始 rollout 的实际模型与指定 hash 命令已分别实查，但**不能声称来源门禁通过**；待会话记录落盘后由原任务复跑，不能伪造记录。日志见证据目录 `gates-after.log`。

---

# 第十轮 · Codex 独立复现（2026-11-06）

## 结论：reject

`24646a2868b2006eb7cd35e943746d3b2abbd7e3` 对第九轮的普通场景已修复：事件进入状态机前会构造冻结、空原型的快照；继承的可选字段和未声明的 `taskId` 不再参与转移；普通的变值／抛错 getter 只读取一次。原样 174 项测试与作者的 217 个变异均独立复现通过。但仍有三个必须处理的问题：**getter 自带的 `call` 属性可以替换真正的 getter，使事件种类发生错误转移；数组、可调用及已撤销 Proxy 的拒绝原因不符合约定；`Review(approve)` 对旧版允许的附加字段出现拒绝回归。**另有 4 个独立单点变异存活。该版本不能据此作为已通过复审的 PR #4 基线。

- 对象：`feat/task-lifecycle` HEAD `24646a2868b2006eb7cd35e943746d3b2abbd7e3`；指定基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`。普通独立 HTTPS clone，`.git` 与 common dir 均为该 clone 自己的目录，不在共享 linked worktree 运行钩子。
- 审查：`codex:494d03f8-8b47-4ae3-a080-43526db82afd`；本轮原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）。作者 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 的本仓库产出轮次为 `claude-opus-5-5`（Anthropic，两个渠道前缀）；不同原生研发厂商，无豁免。
- 仓库根目录运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
bbe39e6bc1ce496bfc98cb79f65681893cf30b0debf4e76f07a1093d02b3b5a1
```

- 脚本、TAP、红绿名称比对、旧版对照、变异补丁与日志：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review10-evidence-Oy7YB6/`。只运行领域纯函数和隔离副本，未启动真实 Compute、发送卡片或修改产品代码。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1`、npm `11.11.0` |
| `npm test` | exit 0；174 通过、0 失败、0 跳过 |
| 普通独立 clone 检出红提交 `fce6e9f` | exit 1；23 绿、151 具名红；红绿测试文件无差异。按文件＋测试名比对指定基线以来新增／改动的 151 条，红提交全部按名失败、绿版全部按名通过，文件级失败 0。空壳红证明测试激活，不等于每条缺陷都在真实旧实现上复现 |
| 同一份新测试套旧实现 `52eb37a` | 隔离副本只替换 `task.ts` 为旧版并追加 `normalizeEvent` 垫片：调用旧 `validateEvent`、成功时原样返回原事件；其余实现不改。exit 1，164 绿、10 具名红，与作者 `red-against-52eb37a.tap` 失败名集合一致。垫片是使新测试能够加载，不是旧实现原生具备快照 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0；原样 174 绿，217 个作者单点变异均有具名失败 |
| 独立行为测试 | 20 组：13 绿、7 红；对 15 类事件在 `normalizeEvent`、`validateEvent`、`apply` 三入口检查了 183 次字段读取计数，并覆盖空原型、普通对象、Proxy、原型污染、任务错投、快照、 getter 和实际转移。失败分别对应下述三项 |
| 独立单点变异 | K01–K04 类型检查和原 174 项测试全绿，但与原版探针行为不同；K05 去掉全部快照冻结，原有具名测试杀死。K06 删除一格后 typecheck 与 2 条 AC-09 测试失败；K07 新增事件、全格补齐并同步样例后 typecheck 与 174 项测试均绿 |

## 二、必须返修

### R10-CORR-01 · 读取 getter 时使用其可被覆盖的 `call` 属性，快照可能不是字段的真实值

`packages/domain/src/task.ts:493–498` 使用 `d.get.call(o)`，而 getter 是普通 JavaScript 函数，其自有 `call` 属性可以遮蔽 `Function.prototype.call`。输入事件本身是原型为 `Object.prototype` 的普通对象，不是 Proxy 或类实例；仅把 `kind` 的 getter 设为返回 `Claim`，再给该 getter 函数设置一个自有 `call` 方法返回 `Cancel`：

- 语言层面的 `event.kind` 为 `Claim`；`normalizeEvent` 实际得到冻结快照 `{kind:"Cancel", by:"author"}`。
- 对新建任务调用 `apply`：真正的 getter **调用 0 次**、遮蔽的 `call` 方法调用 1 次，返回 `ok:true` 并进入 `T10_Cancelled`；预期应读取真正 getter 一次，以 `Claim` 进入 `T2_Claimed`。
- 将 getter 的自有 `call` 设为非函数时，真正 getter 可正常返回合法值，但当前入口返回 `事件无法校验`，真正 getter 仍未调用。

这是支持访问器的普通事件对象上的实际状态机结果，不涉及声称真实宿主已执行某个外部副作用。应使用不经 getter 自身 `call` 属性的调用方式（例如 `Reflect.apply`），并覆盖 kind、普通字段、覆盖为函数／非函数及稳定 getter 的对照。

### R10-CORR-02 · Proxy 分类在数组与类型判断之后，部分 Proxy 给出错误拒绝原因

`packages/domain/src/task.ts:500–507` 在 `types.isProxy` 之前先判断 `typeof` 和 `Array.isArray`。按本轮明确的契约，Proxy 一律应以 `只接受普通数据对象` 拒绝、判断时不得触发陷阱；独立四入口探针的实际结果：

| 输入 | `normalizeEvent` / `validateEvent` / `apply` / `applyAll` 实际原因 |
|---|---|
| 普通对象 Proxy | `只接受普通数据对象`，符合预期 |
| 数组 Proxy、可调用 Proxy | `事件不是对象` |
| 已撤销的对象 Proxy | `事件无法校验`（`Array.isArray` 在检查前抛错，被外层捕获） |

四组探针的 Proxy 陷阱次数均为 0，且均被拒绝；此处是**拒绝原因和判定顺序违约**，不是声称这些 Proxy 被放行。普通非 Proxy 数组仍应按非事件对象拒绝。应先以不触发陷阱的方式识别全部 Proxy，再做类型／数组／原型检查，并补上述三类与普通对象 Proxy、普通数组的对照。

### R10-CORR-03 · Review 通过分支把原先的附加字段改成受校验字段

`TaskEvent` 的 `Review` 联合类型（`task.ts:23–24`）仅在 `verdict:"reject"` 分支声明 `computeResumable`；此前承诺未声明的多余字段不拒绝。新形状表（`task.ts:455,516–522`）却把该字段无条件列为 Review 的可选布尔，并在知道 verdict 前读取：

- 同一条合法 `Review(approve)` 在 `52eb37a` 和本版不带额外字段时都进入 `T7_Delivering` 并发 `send-card`；附加普通 JSON 字段 `computeResumable:"metadata"` 时，旧版仍正常通过，新版返回 `Review.computeResumable 取值非法(应为布尔)`。
- 将该未使用的附加字段换成会抛错的 getter，旧版不读取它且照常通过；新版调用 getter，返回 `事件无法校验`。

这不仅是快照内部多一个键，而是旧版实际已接受的外部输入被拒绝；`approve-extra-probe.log` 中分别记录旧版与本版正反对照。应按 Review 的实际分支选择声明字段：打回时读取并要求布尔，通过时丢弃未声明的该字段；如果产品有意扩大为两种 verdict 均声明的可选字段，应先明确这是契约变更，不能仍以“未声明字段一律丢弃／多余字段不拒绝”描述它。

### R10-TEST-01 · 新快照契约仍有可存活的单点变异

以下是审查人在隔离副本中**故意改坏**的变异，不表示原版已存在相应错误。每项 typecheck exit 0、原 174 项测试全绿；独立探针确认其行为与原版不同：

| 变异 | 原版与变异版的实际差异 |
|---|---|
| K01 只对 `requestId` 重复读取 | 原版 getter 读 1 次并通过；变异版读 2 次、第二次抛错后拒绝 |
| K02 只让 `HumanReply` 快照不冻结 | 原版冻结；变异版可写 |
| K03 只让 `HumanReply` 快照带普通原型 | 原版原型为 null；变异版不是 null |
| K04 只对 `HumanReply` 读取多余 `extra` | 原版丢弃且不调用多余 getter；变异版调用 getter 并拒绝 |

K05 将所有快照改为不冻结，现有具名快照测试能杀死它，作为阳性对照。以上补丁和逐项类型检查、完整测试、原版／变异版探针见 `mutants/K01`–`K05`。这说明作者 217 个变异均被杀的事实可以复现，但不能据此推断每个事件字段或快照分支都已完成 R-05 双侧标定。

## 三、第九轮返修及收据第 7 栏边界

- 继承的 `computeId`、`waiverBy`、`taskId` 在普通对象的 `Object.prototype` 被污染时，不再影响对应转移；本轮分别对照省略字段和自有字段。用户不带任务号的 `Claim` 即使附带无法转换的 JSON `taskId` 也正常认领；真正声明任务号的五类事件错投仍拒绝。
- 常规 getter 首次失败返回 `事件无法校验`；第二次才改变或抛错的 getter 在所测路径只调用一次。15 类事件逐字段取值／调用次数与快照冻结、空原型均有独立对照；R10-CORR-01 是 getter 本体 `call` 被遮蔽时的例外。
- **AC-09**：本片 12 × 15 共 180 格具处理或原因；删格阳性和新增事件全格补齐阴性均已执行（`mutants/K06`、`K07`）。这不等于需求文档 D20.3 中尚未建模的 T2b、T4a/T4c、T6/T6b、T8b 和 E5/E7b/E10 均已覆盖。
- **R-02**：151 条新增／改动测试均按文件和名称红绿匹配；另以明确标注的兼容垫片复跑旧实现，10 条具名失败与作者证据一致。
- **R-05**：217 个作者变异复现全杀，但 K01–K04 存活，当前第 7 栏对于每个声明字段、快照形状及未声明字段的整体断言仍可能被现有测试骗过；需要补变异与正反对照，不能仅因作者变异全杀而将新边界整体标为充分校准。
- 收据仍正确提示：可信 taskId / computeId / 模型／豁免人由宿主负责；真实 Compute、卡片 UI、工作区隔离、CAS/租约、真实资源回收及跨层闭环本轮未验。领域函数的 `send-card` 或 `release-slot` 是意图，不是真实发送或回收证明。

复现（独立 clone 仓库根目录；当前预期 13 绿 / 7 红）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review10-evidence-Oy7YB6
REVIEW_REPO="$PWD" node --test --test-reporter=tap "$E/independent.test.mjs"
REVIEW_REPO="$PWD" node "$E/spot-probes.mjs"
REVIEW_REPO="$PWD" node "$E/approve-extra-probe.mjs"
```

本轮只追加本报告并更新 `receipts/feat-task-lifecycle.json` 的 `review` 字段；返修交回 Claude Code，再由不同厂商独立复现。

### 第十轮本地门禁的实际结果

写入 reject 收据后，在独立 clone 运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`，exit 1：`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 通过。`G-PROVENANCE` 报当前会话记录中没有一次 hash 命令输出等于本轮 `reviewed_hash`，因此也认不出该轮审查厂商；当前门禁读到的 `turns.jsonl` 尚未包含本活动轮次。指定命令和本轮原始 `turn_context.model` 已分别实际核对，但**不声称来源门禁已通过**；待本轮记录落盘后由原任务复跑，不伪造会话记录。原始输出见证据目录 `gates-after.log`。

---

# 第十一轮 · Codex 独立复现（2026-11-06）

## 结论：reject

`8e57583bd0934bb110f99c63fda3974c407a6380` 的第十轮主要修复在本轮常规对照中成立：各类 Proxy 先判、访问器不调用而拒绝、`Review(approve)` 丢弃附加的 `computeResumable`、事件快照冻结且原型为 null。原样 180 项测试和作者 227 个变异均独立复现通过。但**合法 JSON 审查打回事件仍可受 `Object.prototype` 上同名属性影响**：自有的 `computeResumable:true` 被丢弃并错误选择新开实例，缺失的必填字段也可被放行；同名不可写数据属性则令合法事件被误拒。另有 4 个独立单点变异存活。此版应返修后再复审，不得据此合并。

- 对象：`feat/task-lifecycle` HEAD `8e57583bd0934bb110f99c63fda3974c407a6380`；基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`。普通独立 HTTPS clone，`.git` 与 common dir 都是此 clone 自己的目录，不在共享 linked worktree 运行钩子。
- 审查会话 `codex:494d03f8-8b47-4ae3-a080-43526db82afd`；本轮原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 中本仓库产出轮次为 `claude-opus-5-5`（Anthropic，两个渠道前缀）；不同原生研发厂商，无豁免。
- 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出：

```text
3392b3d2ba9e6ec6842d4ae1e90db210c8f0d215b5b1eec9f6389ac275911be1
```

- 证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review11-evidence-uDMmuf/`。测试只运行纯函数和隔离副本，没有启动真实 Compute、发送卡片或修改产品代码。

## 一、独立执行

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1`、npm `11.11.0` |
| `npm test` | exit 0，180 通过、0 失败、0 跳过 |
| 普通独立 clone 检出红提交 `ee72b47` | exit 1，23 绿、157 具名红；红绿测试文件无差异。按文件＋名称比对基线以来新增／改动的 157 条，红提交全部具名失败、绿版全部具名通过，文件级失败 0；空壳红证明激活，不等于每个缺陷都在旧实现上复现 |
| 新测试套旧实现 `24646a2` | 隔离副本只将 `task.ts` 换回旧版原文，不加垫片；exit 1，174 绿、6 具名红，失败名称集合与 `red-against-24646a2.tap` 一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 180 绿、227 个作者变异均有具名失败。第一次运行被主机重启中断，保留残段 `author-mutations-interrupted.log`，恢复后在同一 HEAD 重跑，完整结果为 `author-mutations.log` |
| 独立行为测试 | 17 组：14 绿、3 红；15 类事件共 61 个声明字段的访问器分别走四入口，共 244 次入口断言；另测 Proxy、symbol／不可枚举／仅 setter、自有 JSON 字段、Review 两个 verdict、快照与受污染原型 |
| 独立变异及对照 | L01–L04 各自在隔离副本 typecheck exit 0、原 180 项测试全绿，但原版／变异版探针有实质差异；L05 删除全部访问器拒绝时 typecheck 绿、4 条具名测试红；AC-09 删格 K06 类型检查及 2 条测试红，新增事件全格补齐 K07 类型检查及 180 项测试绿 |

## 二、必须返修

### R11-CORR-01 · 审查打回的条件字段定义受继承 setter／不可写属性影响

`packages/domain/src/task.ts:517–519` 用普通原型对象 `req = { ...shape.req }` 保存必填字段，然后通过赋值 `req.computeResumable = "bool"` 追加条件字段。普通对象赋值会经过原型链：如果 `Object.prototype` 恰有一个同名 setter，赋值调用该 setter 而不是创建 `req` 的自有字段；如果它是不可写数据属性，赋值抛 `TypeError`，被外层包装成 `事件无法校验`。

本轮在**单独 Node 进程**中临时设置该原型属性，测试结束均在 `finally` 中删除；被测事件本身是 `JSON.parse` 产生的普通对象，相关自有字段全是数据属性、没有 getter 或 Proxy。比较同一事件、同一 T5 任务，仅切换宿主原型条件：

| 条件与事件 | 实测结果 |
|---|---|
| 无污染，自有 `computeResumable:true` | 快照保留 `true`；`apply` 发 `resume-compute`，保留当前实例 |
| 同名继承 setter，自有 `computeResumable:true` | setter 被调用，快照缺少该字段；`apply` 错发 `spawn-compute`，清掉当前实例 |
| 无污染，缺 `computeResumable` | 返回 `Review.computeResumable 缺失或取值非法(应为布尔)` |
| 同名继承 setter，缺 `computeResumable` | 错误校验通过，并发 `spawn-compute` |
| 同名不可写数据属性，自有 `computeResumable:true` | `normalizeEvent`、`validateEvent`、`apply`、`applyAll` 均返回 `事件无法校验`；无污染的同一事件正常恢复 |

这直接违反第七栏沿用的“只认自有属性、`Object.prototype` 被污染时继承字段不算数”，也违反本轮对 `Review(reject)` 的布尔必填与返工选择。**前提是宿主进程的 `Object.prototype` 已有同名 setter／不可写属性；没有证明普通 JSON 本身能建立这种污染，也未测真实宿主是否处于该状态。**输出 effect 是领域意图，不是声称真实进程已经停止或新开。

建议让临时字段表自身也使用空原型，或用不会经过继承 setter 的方式定义条件字段；补无污染、同名可写数据字段、setter、不可写字段的四入口对照，并对 `true`、`false`、缺失分别检查实际转移与 effects。证据：`prototype-setter-probe.mjs/.log`、`prototype-nonwritable-probe.mjs/.log` 和 `independent-test.tap` 的 11–13 项。

### R11-TEST-01 · 227 个作者变异之外仍有可存活故障

下表是审查人在隔离副本中**故意注入**的单点故障，不把它们当作原版已存在的实现错误。每项 typecheck exit 0、原 180 项测试全部通过，独立探针证实原版与变异版输出不同：

| 变异 | 原版／变异版差异 |
|---|---|
| L01 有 `waiverBy` 的 Review 打回漏掉 `computeResumable` 必填校验 | 原版缺字段拒绝、`true` 恢复原实例；变异版缺字段放行，`true` 也错误新开 |
| L02 漏检不可枚举的 symbol 访问器 | 原版按访问器拒绝；变异版错误放行，均未调用 getter |
| L03 漏检 symbol 键的仅 setter 访问器 | 原版拒绝；变异版错误放行，均未调用 setter |
| L04 重新注入已移除的 X03：去掉外层 catch | 在上面的同名不可写原型字段条件下，原版将合法 JSON 事件返回 `事件无法校验`；变异版直接抛 `TypeError` |

L05 删除全部访问器拒绝后，typecheck 仍绿但 4 条具名测试红，是阳性对照。补丁、完整测试和两侧探针位于 `mutants/L01`–`L05`。这些结果说明作者所选 227 项全杀可以复现，但不代表 R-05 的上述组合已充分双侧标定。

**被删除变异的边界：**Y01“访问器读两次”在本轮对事件自有访问器直接拒绝的契约下确无同样触发路径，删除理由成立。X03“去掉外层兜底”所写的“契约内输入不会抛错”对当前代码不成立：L04 使用普通 JSON 事件，在本收据仍承诺处理的 `Object.prototype` 同名字段环境下实际抛错。修复 R11-CORR-01 后应重新评估该变异是否等价；如果有意排除被污染的宿主原型，应明确修订之前的边界，而不是同时声称继承字段一律不影响。

**K01–K04 的来源：**对照本审查人第十轮实际注入脚本与当前 `mutations.mjs`：K02/K03 保持相同注入方向；K01 从“重复读取 requestId getter”改为“放行 requestId 访问器”，K04 从读取／保留额外 getter 改为保留额外数据字段。新契约拒绝访问器，改写可能合理，但它们并非四项均“原样”注入，证据见 `k-variant-comparison.txt`。

## 三、契约与收据边界

- 本轮常规数据对象、空原型对象、JSON、数组／函数／已撤销 Proxy、不可枚举和 symbol 访问器、setter-only、Review 的 approve/reject 分支、15 类快照均已独立实测。非 Proxy 数组仍按“事件不是对象”拒绝；各类 Proxy 均按约定拒绝且陷阱次数为 0。
- **PR #4 并非已确认与本轮完全一致：**本轮查询到其远端 HEAD `98e31bd54a8ec7ac1d9f6f42ca3f26e43392a557`。该版本 `receipts/feat-contact-helper.json` 写明普通对象 getter 读取一次；其 `briefFor` 的 CH-18 getter 用例在另一个普通独立 clone 实跑 exit 0，确认 getter 被接受并各读一次。本 PR 的新契约则拒绝任何自有访问器。该事实只针对当时已推送的 PR #4 版本及该联系人入口，不推断未推送的本地改动或后续合流结果；若要求统一，需由对应负责人协调契约和调用方。
- PR #6 当时远端 HEAD `e92cba87060b574a6ca87480fa0a5e2e2fcd0b0e` 的收据与 `packages/kernel/src/plugins.test.ts` 对 **OutboundChannel 配置**明确拒绝 getter，与本轮方向一致；这不足以证明 PR #6 的所有入口与 PR #3 是同一契约。
- **AC-09**：本片 12 × 15 的 180 格有处理或原因，删格与新增完整事件的阳性／阴性对照已执行；需求文档 D20.3 中未建模状态和事件不因本片而全部通过。**R-02** 的 157 条红绿名称匹配；**R-05** 的 227 个已选故障全杀，但 L01–L04 为额外存活反例。
- 仍不验证宿主对 taskId、computeId、模型、豁免身份的真实性；真实 Compute、卡片 UI、工作区隔离、CAS/租约和跨层资源回收不在本片。`resume-compute` / `spawn-compute` 是纯函数返回的意图，不是真实进程执行证据。

复现（独立 clone 仓库根目录；当前独立测试预期 14 绿／3 红）：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review11-evidence-uDMmuf
REVIEW_REPO="$PWD" node --test --test-reporter=tap "$E/independent.test.mjs"
REVIEW_REPO="$PWD" node "$E/prototype-setter-probe.mjs"
REVIEW_REPO="$PWD" node "$E/prototype-nonwritable-probe.mjs"
```

本轮只追加本报告并更新 `receipts/feat-task-lifecycle.json` 的 `review` 字段；返修交回 Claude Code，再由不同厂商独立复现。

### 第十一轮本地门禁的实际结果

写入 reject 收据后，在独立 clone 运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`，exit 1：`G-REVIEW` 因 reject 按预期阻止合入；`G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER/G-PROVENANCE` 均通过。来源门禁本轮已在会话记录中识别出指定 hash 和跨厂商来源；完整输出见证据目录 `gates-after.log`。

---

# 第十二轮 · Codex 独立复现（2026-11-06）

## 结论：approve（限定本片领域纯函数）

第十一轮原型字段污染导致的必填校验和返工副作用错误，在指定 `a85a90928804aac2fd52f5aaf1a4391af51b1ef4` 的本轮独立对照中已修复；用户列出的行为、7 个重定向变异语义、X03 可达性、PR #4 联系人入口契约，以及 8 个门禁的独立负例均已执行。**没有发现当前原版必须修复的行为缺陷**，故对本片代码审查给出 approve；这不是用户体验、真实 Compute 或完整跨层验收。

需要如实保留测试覆盖边界：本轮另造的 5 个单点故障中 **2 个被现有测试杀死、3 个存活**；原版在这 3 个独立探针中均正确。建议把对应 3 个用例加入后续回归，不把“234 个作者变异全杀”解释成所有可能的故障都会被发现。R-05 要求每条判据至少一个阳性与阴性对照，并未要求所有可构造变异全杀；本轮用户指定判据的现有正反标定与独立实测见下，不将仅属未来回归保护的存活变异虚报为当前实现缺陷。

- 对象：`feat/task-lifecycle` HEAD `a85a90928804aac2fd52f5aaf1a4391af51b1ef4`；基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`。普通独立 HTTPS clone，`.git` 与 common dir 都是该 clone 自己的目录；未在共享 linked worktree 运行钩子。
- 审查会话 `codex:494d03f8-8b47-4ae3-a080-43526db82afd`；本轮原始 `turn_context.model` 为 `gpt-6.1-terra`（OpenAI）。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38` 涉及本仓库的产出轮次为 `claude-opus-5-5`（Anthropic，两个渠道前缀）；不同原生研发厂商，无豁免。
- 在独立 clone 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/task-lifecycle --base=origin/feat/domain-core`，原样输出，与作者声明一致：

```text
d0ff7802b8fed999fa6af05049c246e85516e859bdd32b75a41ef6418d18b61f
```

- 原始日志、脚本、单点变异补丁、独立门禁夹具与结果：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review12-evidence-gWS5VA/`。独立探针运行纯函数及隔离副本，未启动真实 Compute 或发送卡片。

## 一、独立执行与第十一轮返修

| 操作 | 实测结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均 exit 0；Node `v25.8.1`、npm `11.11.0` |
| `npm test` | exit 0；184 通过、0 失败、0 跳过 |
| 独立 clone 检出红提交 `60389ce` | exit 1；23 绿、161 具名红。按文件＋测试名比对基线以来新增／改动的 161 条，红提交全部具名失败、绿版全部具名通过，文件级失败 0；红绿测试文件无差异。空壳红证明测试激活，不等于每个缺陷在旧实现上均被复现 |
| 新测试套旧实现 `8e57583` | 隔离副本只把 `task.ts` 换回旧版，沿用绿版新增测试夹具，不加垫片；exit 1，182 绿、2 具名红，失败名称集合与作者 `red-against-8e57583.tap` 一致 |
| 作者 `node packages/domain/proof/mutations.mjs` | exit 0，原样 184 绿；234 个作者变异均有具名失败。7 个重新指向的旧变异另逐项隔离执行，见下 |
| 上轮审查独立测试 | 本审查人的第十一轮 17 组测试在本版全部通过，包括上轮 3 条原型污染红例、61 个声明字段 × 4 入口的访问器拒绝对照 |
| 原型矩阵 | 27 个字段名 × 可写数据属性／setter／不可写属性，共 81 组；每组对 Review 打回 `true`、`false`、缺失分别调用四入口，并检查新建任务与派发，全部通过；继承 setter 未调用。测试只在单独进程临时改变原型，结束恢复 |
| Review 打回效果 | `true` 恢复 `cc-1` 并发 `resume-compute`；`false` 清除当前实例并发带交接的 `spawn-compute`；缺失在四入口按字段原因拒绝。上述三种在各原型条件下与无污染对照一致 |
| 独立 AC-09 对照 | 本片 12 × 15 格有处理／原因；删除一格 typecheck 失败且 2 条 AC-09 具名测试红；新增事件、补全所有格及测试样例后 typecheck 与 184 项测试绿。首次运行对照脚本时漏建证据子目录，Python 报 `FileNotFoundError`，原管道仅返回 `tee` 的 exit 0；建目录并启用 `pipefail` 后已重跑，非产品失败 |

## 二、7 个重定向变异与 X03

7 个变异逐一在独立副本按作者当前注入点执行：每项 typecheck exit 0、原测试有具名失败；同时用相同输入比较原版／变异版的实际语义：

| 变异 | 独立对照 |
|---|---|
| N13 | 原版 `pendingQ` 冻结且不复用外部引用；变异版沿用引用，外部修改会改变结果 |
| D06 / D07 | 原版 `revoked` / `orphans` 冻结；对应变异版未冻结 |
| E05 | 原版 `approval` 复制并冻结；变异版沿用外部引用，可被外部改写 |
| G05 | 原版 `retired` 冻结；变异版未冻结 |
| W07 | 原版非法可选字段 `ExecFailed.computeId` 被拒；变异版放行 |
| P07 | 原版 `Review(approve)` 快照丢弃 `computeResumable`；变异版保留 |

所以就上述实际探针而言，7 项的重定向仍覆盖作者写明的原故障方向，不仅是因类型错误或模块加载失败变红。完整补丁、类型检查、原测试与双侧探针见 `retarget/`。

**X03 非等价理由成立。**审查人另建循环 ES module：在导出绑定初始化前取得命名空间，它不是 Proxy、原型为 null，但取未初始化绑定的属性描述符会抛 `ReferenceError`。原版四入口均返回 `事件无法校验`；隔离副本去掉外层 catch 后，同一输入的四入口均抛 `ReferenceError`，且原有具名测试杀死该变异。模块命名空间不是 JSON 数据对象；它证明外层兜底对这个可达的**契约外输入**有区别，不是称其为合法 JSON 事件。结果见 `x03/original.log`、`mutant.log`、`tests.tap`。

收据对 K01/K04 已明确记为适配新契约后的改写，而不是“原样注入”；K02/K03 方向未变，描述已与代码相符。

## 三、独立注入故障与剩余覆盖风险

以下仅是隔离副本中**故意改坏**的单点故障。R01–R03 每项 typecheck exit 0、原 184 项测试仍全绿；原版／变异版的同一输入实际不同：

| 变异 | 原版／变异版对照 | 对现有测试的意义 |
|---|---|---|
| R01 仅把 `UserReject` 临时字段表改为普通原型 | 同名继承 setter 下，原版保留自有 `true` 并恢复原实例；变异版调用 setter 并错误新开 | 现有原型测试覆盖 Review 打回和其他任务字段，但未以此特定组合杀死故障 |
| R02 错误放过 getter、setter 均为 `undefined` 的自有访问器描述符 | 原版按访问器拒绝；变异版错误放行 | 现有测试覆盖可调用 getter、setter-only 等，但此描述符组合未锁住 |
| R03 错误跳过数字名称的自有访问器 | 原版拒绝且 getter 调用 0 次；变异版放行 | 现有测试未锁住 `"0"` 这类键名 |

R04（`NeedHuman` 可选字段表认继承 `opt`）及 R05（patch 用 `in` 认继承属性）均被现有具名测试杀死，类型检查均绿。额外独立的 `novel-regressions.test.mjs` 在原版 3/3 通过，在 R01、R02、R03 各自只让对应一条失败；建议将这 3 个用例纳入产品测试，以保护重要的返工与“任何访问器”边界。完整补丁、测试、双侧结果在 `novel-mutants/`。这些是**回归测试缺口，不是当前原版已出现上述变异行为**。

## 四、各门禁独立负例及 PR #4

审查人构造 8 个独立临时 Git 仓库，每个只注入一个针对目标门禁的违规输入；另有一个正常对照。均调用本轮实际 `scripts/gates/run-all.ts --local`：正常对照 exit 0、8 门禁全绿；每个负例 exit 1，且**恰好目标门禁失败**。来源记录在这些仓库中是明确标注的合成测试夹具，不冒充真实审查会话。

| 门禁 | 独立失败输入 | 观察 |
|---|---|---|
| G-TRACE | 收据声明验收文档不存在的 `AC-99` | 只该门禁拒绝 |
| G-REVIEW | 收据审查结论 `reject` | 只该门禁拒绝 |
| G-RED | 红提交里的行为测试本来就绿 | 按测试名拒绝 |
| G-STUB | 测试吞掉桩异常并错误保留期望值 | 判为空桩下未具名失败 |
| G-TAUTO | 增加恒真断言 `assert.equal(7, 7)` | 标出恒真断言 |
| G-WORKFLOW | PR workflow 申请 `contents: write` | 拒绝写权限 |
| G-LAYER | domain 包引用 kernel 包 | 拒绝反向依赖 |
| G-PROVENANCE | 合成审查记录中的 hash 不等于收据 | 拒绝来源不符 |

另测合成的同厂商且无豁免输入：`G-REVIEW` 与 `G-PROVENANCE` 均拒绝。各夹具及输出见 `gate-fixtures/`；仓库自带 `npm run gates:selftest` 也 exit 0，64 个检查项通过。

PR #4 当时远端 HEAD 为 `f227649a4676716e3851b4ddbc9bd8609f6d864a`。其收据与联系人入口源代码已改为普通数据对象、Proxy 拒绝、自有访问器拒绝且 getter 不调用；审查人另在普通独立 clone 运行“联系人每个公开入口对象字段 getter/setter 均拒绝”用例，1/1 通过。与本 PR 事件对象的相关原则一致；PR #4 对其需要的数组还有单独约束，本次未完成 PR #4 全量审查或端到端验收。

## 五、收据与未测边界

- 审查前运行本机 `run-all --local`：只 `G-REVIEW` 因 review 尚为空失败；此时 `G-PROVENANCE` 虽显示绿，但因无 review 会直接跳过，不能把它当成来源验证。
- 收据保留的边界仍重要：AC-09 仅本片 12 × 15 主干；其他需求状态／事件、宿主对 taskId / computeId / 模型 / 豁免身份的认证、真实 Compute 恢复或新开、UI、工作区隔离、CAS/租约及跨层资源回收均未验。纯函数 effects 是意图，不是实际进程或卡片证据。
- 独立复现脚本示例：

```sh
E=/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr3-review12-evidence-gWS5VA
REVIEW_REPO="$PWD" node --test --test-reporter=tap "$E/prototype-matrix.test.mjs"
REVIEW_REPO="$PWD" node --test --test-reporter=tap "$E/novel-regressions.test.mjs"
# 各单点变异和门禁负例的完整输入、日志及原版／变异版对照均保存在证据目录。
```

本轮只追加本报告并更新 `receipts/feat-task-lifecycle.json` 的 `review` 字段；未修改产品代码。批准仅针对本片领域纯函数及本轮所列检查，不替代用户验收或后续跨层验证。

### 第十二轮本地门禁的实际结果与合入阻塞

写入 approve 收据后，在独立 clone 运行 `node scripts/gates/run-all.ts --local --branch=feat/task-lifecycle --base=origin/feat/domain-core`，exit 1。`G-TRACE/G-REVIEW/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER` 均通过；**`G-PROVENANCE` 未通过**：门禁读取的会话记录中尚没有输出恰等于本轮 `reviewed_hash` 的工具调用，因此也无法认出该轮审查厂商。实查当前 `turns.jsonl` 已落盘的 4 轮中命中本 hash 的调用为 0；本轮指定命令已单独实际运行，原始 `turn_context.model` 与作者模型也已分别核查，但这些观察不能代替门禁通过。

因此，本报告的代码 `approve` **不解除跨厂商来源硬门禁，当前不可据此合入**。待本活动轮次完整落盘后，由原任务复跑同一 `--local` 命令并确认 `G-PROVENANCE` 真正通过；不伪造会话记录。原始输出见证据目录 `gates-after.log`。
