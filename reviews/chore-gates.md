# PR #1 机械门禁独立复现审查

## 结论

**reject，修复后重审，不应合并。** 四条指定命令均能退出 0，但独立反例证实：跨厂商审查仍可绕过、门禁执行配置不受审查约束、无效测试可获放行、R-18 自检不能发现真实 runner 被跳过。作者收据中的 R-01/02/03/04/15/18「通过」不足以成立；R-08 的已测字段校验可以工作，但不能据此推导整个门禁链合规。

本次只写本报告和收据的 `review` 字段；没有修门禁代码，没有更改分支保护，没有尝试合并。

## 审查对象与身份

- PR：<https://github.com/SammySnake-d/g-group/pull/1>，分支 `chore/gates`。
- 被审提交：`2f3dbd35f833a02f94ce12a99c4e1ef247deee3d`，已包含作者第二次提交的 cubic 修复；基线 `main` 为 `412ce25`。
- 本机对象：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group`。
- 审查人：Astra；mirasim 会话 `codex:f933f07c-ae51-45bf-ba20-4d6cea7e2b8c`，以该目录的 `record.json` 核实；对应 native 会话 `01a1a7ee-d4fe-7b12-9ac5-a6c9923d2225`。
- 实际模型：本轮续跑及签署为 `ai-iisbo/[乾坤按量]gpt-6-astra`；前一轮复现为 `ai-iisbo/[乾坤按量pro]gpt-6-astra`。两者均从 native 会话 `turn_context` 核对，原生研发方为 OpenAI；作者会话记录为 Claude/Anthropic，满足本次审查的跨厂商分工。
- 日期：2026-11-05（Asia/Tokyo）。执行环境固定 Node `v22.22.0`，与 workflow 的 Node 22.22 一致。

在仓库根目录亲自执行：

```sh
node scripts/gates/run-all.ts --hash --branch chore/gates
```

输出并绑定本次结论的内容 hash：

```text
9c82e6ea9c229fec2711eb2412f77f4653a7fe8b1d061199b2fff4a22f2b11ea
```

## 基线实跑

以下均由审查会话亲自执行，不采用作者粘贴的结果：

| 命令 | 实际结果 | 证据边界 |
|---|---|---|
| `npm ci` | 退出 0，3 packages，0 vulnerabilities | 依赖安装成功，不代表行为合规 |
| `npm run typecheck` | 退出 0 | 静态类型通过 |
| `npm run gates:selftest` | 退出 0，「自检通过」 | 现有样例通过；发现 F-08 证明其执行链覆盖不完整 |
| `npm test` | 退出 0，tests=0、pass=0、fail=0 | 本 PR 无产品代码；不是产品测试通过，也不单凭零测试判缺陷 |
| `node scripts/gates/run-all.ts --branch=chore/gates --local`，写审查前 | 退出 1，仅 G-REVIEW 报「还没有独立审查」 | 与当前 CI 失败原因一致；不是整套规则已获独立验收 |

隔离反例使用独立 Git 副本、固定提交、真实 Node 测试进程与真实门禁入口。通过 `MIRASIM_SESSIONS` / `MIRASIM_ROOMS` 注入的模拟会话和模拟消息只存在副本内，未修改真实会话或群聊。多数反例执行的是带 `--local` 的完整门禁，不只是直接调用一个函数；F-07 另明确限定为两个 Gate 的实跑。

## 阻塞问题

### F-01 [P1] 权威合并检查不验证实际审查来源，伪造 review 可过 CI

位置：[gates.yml](../.github/workflows/gates.yml#L26)、[run-all.ts](../scripts/gates/run-all.ts#L29)、[merge.sh](../scripts/merge.sh#L12)。对应 R-01、R-07。

**反例与观察：** `ci-fake-review` 在受管路径增加一个改动，填入不同 agent、不同厂商、自报 approve 和正确 hash，但作者/审查会话并不存在。按 CI 的普通模式运行退出 **0**；同一树加 `--local` 并指向不存在的会话根目录，退出 **1**，明确报作者与审查会话不存在。

通过 GitHub API 实时读取 `main` 分支保护：required status 只有 `gates`（`strict=true`、`app_id=null`），`enforce_admins=true`，没有必需 PR review 配置。CI 不跑 G-PROVENANCE，而 `merge.sh` 并非服务端强制执行的唯一入口，因此有效 CI 状态不能证明存在真实的跨厂商独立审查。作者 `unverifiable` 已披露网页绕过，但「靠纪律」不满足用户硬门禁；本审查未实际点网页或调用合并 API。

**要求：** 让受保护的必需检查消费可信、绑定当前 hash 和实际审查动作的证明；不能只相信 PR 内可自填的 review，也不能把唯一来源校验只放在自愿运行的本机脚本。修复后用「不存在审查会话」与真实有效审查作正反例。

### F-02 [P1] 只改 workflow 等执行策略时，无收据、无审查仍全绿

位置：[gates.ts:needsReceipt](../scripts/gates/gates.ts#L9)。对应 R-01、R-15、R-18。

**反例与观察：** `unguarded-workflow` 仅把 `.github/workflows/gates.yml` 最后一条门禁命令改为 `run: 'true'`，提交后不提供该分支收据。主动再执行完整 `--local` 门禁，**7 个门禁全绿，退出 0**。

`needsReceipt` 只覆盖 `packages/` 和 `scripts/gates/`；`.github/workflows/`、`scripts/merge.sh`、`.githooks/`、根 `package.json` 等能决定检查是否执行的文件被当作无需收据的改动。这里不需要先破解审查 hash：直接修改调用门禁的策略就能逃过审查。本例只在副本验证，没有推送被篡改 workflow。

**要求：** 将可执行策略、依赖/命令配置和所有门禁入口纳入受管改动集合；文档专用豁免用明确边界。应单独验证删掉、重命名或改写这些入口都必须要求有效收据与独立审查。

### F-03 [P1] 用户明确「不批准豁免」也被当成有效豁免

位置：[gates.ts:G-REVIEW](../scripts/gates/gates.ts#L50)、[G-PROVENANCE](../scripts/gates/gates.ts#L79)。对应 R-01、R-10。

**反例输入：** `denied-waiver` 把作者和 reviewer 都设为 Claude，模型会话彼此一致；收据填：

```json
{"waiver":{"by":"39impacts.talent","reason":"g-group#900"}}
```

隔离消息文件内第 900 条的原文是：

```text
- 02:18 **39impacts.talent**: 必须跨厂商，不批准豁免。 <!-- #900 -->
```

**实际结果：** 完整 `--local` 退出 **0**，G-REVIEW 打印 `Waived(by_user 39impacts.talent)`，G-PROVENANCE 也通过。这是明确拒绝被升级为授权，不是自然语言歧义：现有核对只验证消息号、名字及非 agent 标记，没有验证批准事件和作用范围。任意用户旧消息也可被复用。

**要求：** 使用经过认证、明确批准且绑定 PR/hash/豁免事项的授权记录；不能仅靠任意聊天文本的发送人。保留 Waived 与合规通过的区别；明确拒绝、无关消息、过期或跨 PR 授权均须拦截。

### F-04 [P1] 会话历史出现过另一厂商，就能冒充本次实际审查厂商

位置：[gates.ts:G-PROVENANCE](../scripts/gates/gates.ts#L71)。对应 R-01、R-07、R-17 的不可变快照原则。

**反例输入：** `stale-model` 的作者模型为 Claude；收据 reviewer 自报 GPT。模拟 reviewer 会话只有两个轮次：

```jsonl
{"model":"gpt-6-astra","text":"old unrelated turn, before artifact existed"}
{"model":"claude-opus-5-5","text":"current review <当前内容hash>"}
```

**实际结果：** 完整 `--local` 退出 **0**。历史所有 `"model"` 值被正则收集，只需 `.some` 匹配自报厂商；hash 也只需在全文任何位置出现。两者不必属于同一次审查动作，因此实际同为 Anthropic 的本次生产与审查可被包装成跨厂商。

**要求：** 结构化解析来源记录，将当前产物与本次审查动作绑定到各自不可变模型快照；不能将「会话曾用过某模型」等同「这次动作使用该模型」。以历史切模、多个 hash、模型字段出现在引用材料中的情况补反例。

### F-05 [P1] 给 node:test 的 test 起别名可让零断言测试通过全部门禁

位置：[gates.ts:lintTestFile](../scripts/gates/gates.ts#L198)。对应 R-04。

`no-assertion` 提交的测试：

```ts
import { test as check } from "node:test";
import { add } from "./add.ts";
check("adds", () => { add(1, 2); });
```

红提交的 `add` 抛出未实现错误；绿提交故意返回 **999**，不返回正确答案。收据正确引用红提交与测试名，其他字段满足门禁。

**实际结果：** `npm test` 为 1 个测试通过；完整 `--local` 仍退出 **0**。红/桩只检出异常与非异常，不能替代断言；lint 只寻找字面 `test`/`it` 调用，未识别真实 import 绑定，完全没有检查 `check` 的测试体。

**要求：** 依据测试框架导入绑定定位测试及断言，覆盖别名和支持的调用形式；无法识别时不能默默判该文件无问题。回归用例必须包含上述零断言测试及错误实现。

### F-06 [P1] 每文件一个红测试不足以保证每条行为测试先红

位置：[gates.ts:G-RED](../scripts/gates/gates.ts#L109)。对应 R-02、AC-27。

**反例与观察：** `partial-red` 的红提交只有 `adds`；绿提交在同一文件新增 `negative-behavior-never-red`，收据仍只填 `red.tests=["adds"]`。两条测试当前均有真实源码断言、当前通过且桩替换能变红；但新增测试在红提交根本不存在。完整 `--local` 仍退出 **0**。

AC-27 明确要求「合入的每个行为测试都有一次红记录」。当前实现只验证 `red.tests` 点名项曾失败，以及每个文件当前至少有一个通过的名字在该数组中，导致一个先红测试可以覆盖同文件任意数量后补测试。

**要求：** 校验当前应受管的每条行为测试，绑定文件与稳定测试身份，分别证明对应红记录及当前通过，不能只按文件取一个交集；同时防止不同文件同名测试相互代偿。

### F-07 [P1] 模块加载失败被当成空桩激活成功，复制逻辑可同时骗过两道检查

位置：[gates.ts:G-STUB](../scripts/gates/gates.ts#L155)、[lintTestFile](../scripts/gates/gates.ts#L165)。对应 R-03、R-04。

`stub-load-error` 的源码：

```ts
export function add(a: number, b: number): number { return a + b; }
export const initialized = add(0, 0);
```

测试导入 `add`，但测试体只是：

```ts
test("copied-logic", () => {
  void add;
  const actual = 1 + 2;
  assert.equal(actual, 3);
});
```

**实际结果：** 基线真实测试通过 `copied-logic`；桩替换后模块顶层就抛错，测试根本没注册，结果为 `passed=[]`、`failed=["packages/core/src/add.test.ts"]`。G-STUB 只遍历 `passed`，因此返回空问题列表；G-TAUTO 也返回空列表，因为 `void add` 就满足 usesSrc，断言实际只验证复制逻辑。

本例直接执行这两个真实 Gate 并记录真实测试进程输出，**没有宣称这一例完整 G-RED/G-REVIEW 也已通过**。它证明两道检查无法提供各自声明的激活及源码断言证明。

**要求：** 对照基线 named-test 清单，确认同一条测试实际执行并因桩变红；加载错误、超时、零发现、跳过或取消均不能算激活。断言应关联真实源码结果，不能把测试体任意一次提及源码符号当成断言使用源码。

### F-08 [P1] 跳过真实 runner 的普通模式，自检仍绿，R-18 未修完

位置：[selftest.ts](../scripts/gates/selftest.ts#L147)、[run-all.ts](../scripts/gates/run-all.ts#L21)、[普通模式分派](../scripts/gates/run-all.ts#L29)。对应 R-18；也反证 cubic `4471886509` 已完全修复的说法。

**单变量反例：** `runner-bypass` 使用原始被审版本，正常 CLI 对「未独立审查」退出 **1**；仅在隔离副本把下面这一行的最后 `ALL_GATES` 改成 `[]`：

```ts
const gates = a.local ? [...ALL_GATES, ...LOCAL_GATES] : ALL_GATES;
```

**实际结果：** `npm run gates:selftest` 仍退出 **0**；相同违规输入再执行普通 CLI 却退出 **0**，没有运行任何门禁。

新增的自检只核对导出的注册表，以及直接调用 `runGates`；`--self-test` 在第 21 行提前退出，完全不经过真实 CLI 的第 29 行分派。注册表没坏而调用被跳过时，自检无法发现，直接违反「规则自身可信」的验收条件。

**要求：** 在隔离副本对子进程的真实普通/本机 CLI 及实际调用入口做双侧与跳过守卫变异校验；违规输入必须因对应 gate 变红，删执行调用必须使自检失败。修复前不得把 R-18 标为通过。

## cubic 11 条逐项核对

以下核对基于实际 GitHub 评论及第二次提交内容，不把机器人显示 Addressed 当作验收证据。评论链接末尾为 GitHub discussion ID。

| 评论 | 结论 | 独立证据或边界 |
|---|---|---|
| [4471886396 分支 shell 注入](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886396) | 已修 | 用当前 workflow 的真实 bash 命令，`HEAD_REF=feature;true` 仍退出 1，没有执行尾随 true |
| [4471886400 删除/重命名漏检](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886400) | 已修 | 独立 Git 删除、移到 docs 两例均被 G-TRACE 拦截，退出 1 |
| [4471886414 分支值冒充模式](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886414) | 已修 | `--branch=--self-test` 与 `--branch=--hash` 均正常执行门禁并退出 1，不走模式捷径 |
| [4471886423 伪造豁免](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886423) | 部分修复 | 增加了本机出处检查，但 F-01/F-03 仍可绕过 |
| [4471886430 merge SHA 漂移](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886430) | 静态修复已见，端到端未测 | 已固定 SHA、同 SHA CI 查询、`--match-head-commit`；未实际合并或注入远端竞争 |
| [4471886445 provenance 无自检](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886445) | 字面缺项已补，来源绑定仍不足 | 自检含正反例且亲自跑绿；F-04 说明历史模型仍可冒充 |
| [4471886458 manifest 依赖漏分层](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886458) | 已修 | 独立 optionalDependencies 反向依赖被 G-LAYER 拦截 |
| [4471886470 bare expect 算断言](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886470) | 已修 | 单独运行 lint 返回「没有任何断言」；不等于其他断言识别均正确，见 F-05/F-07 |
| [4471886477 hook 吞失败输出](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886477) | 已见输出调整，未注入 hook 失败 | 当前首遍保留非通过行，测试输出不再全部重定向；selftest 仍执行两遍，不列为本次阻塞问题 |
| [4471886488 裸 o1](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886488) | 已修 | 独立 `vendorOf("o1")` 返回 `openai` |
| [4471886509 R-18 runner 覆盖](https://github.com/SammySnake-d/g-group/pull/1#discussion_r4471886509) | 未修完 | F-08：跳过实际分派后 selftest 仍 0，违规 CLI 由 1 变 0 |

## R-01 至 R-18 的本次边界

「失败」指本次已构造违反规则而仍被放行的反例；「未测」不等于不适用，也不替作者更改其 acceptance 数组。

| 条目 | 本次判断 | 依据与剩余边界 |
|---|---|---|
| R-01 | 失败 | F-01 至 F-04；本次 Astra 与作者确实不同厂商，不代表机制能强制所有 PR |
| R-02 | 失败 | F-06；AC-27 的每条行为先红未被保证 |
| R-03 | 失败 | F-07；加载失败不足以证明 named test 激活源码 |
| R-04 | 失败 | F-05/F-07；零断言、复制逻辑可漏检 |
| R-05 | 未完成 | 现有样例可跑，F-08 的元验证埋雷存活；产品判据无产品代码可验 |
| R-06 | 未测 | 本 PR 为工程门禁，不冒充产品端到端垂直切片；G-TRACE 只做字段关联 |
| R-07 | 部分检查已测，整体未通过 | 对真实进程/原始输出审查；来源绑定缺陷见 F-01/F-04，证据内容真实性仍需人判 |
| R-08 | 已测字段校验通过 | 自检确认非法状态、无证据、缺第 7 栏被拦；受管范围绕过见 F-02，非完整收据语义验收 |
| R-09 | 未测 | 无产品交付确认/超时状态机 |
| R-10 | 失败（豁免路径） | F-03；其他宿主授权路径本 PR 未实现 |
| R-11 | 未测产品权限隔离 | 本次注入门禁反例，不冒充产品权限故障注入验收 |
| R-12 | 未见新增阈值拍板 | 未将主稿待决产品项冒充已验；产品准入策略未测 |
| R-13 | 未测 | 无产品指标回放报告 |
| R-14 | 未测 | 无非确定性产品评测，不以本次确定性小样本声称精度 |
| R-15 | 失败 | F-02：改可执行检查策略，无收据仍放行 |
| R-16 | 未测 | 无 UI 和产品用户故事交互链 |
| R-17 | 未测产品快照约束 | F-04 暴露来源检查未绑定本次动作；不据此声称验证了 ComputeAdapter 或存储 |
| R-18 | 失败 | F-08；真实执行链被跳过时自检仍绿 |

## 原始工件与复跑定位

以下为本机实跑工件，不是产品发布证据。为遵守只提交两个文件的要求，复现脚本、隔离副本和日志没有额外加入 Git；上文保留了关键输入、改动位置与实际结果，作者可据此补回归用例。

- 完整独立反例脚本：`/tmp/g-group-review-f933f07c.mjs`。
- 权威完整运行目录：`/var/folders/lh/z4bcmr1d18z53jcctpfhwdt80000gn/T/g-group-review-f933-TtBPrN/`。
- 总结果：上述目录内 `results.json`；每例还各有同名 `.json`，包括命令退出码、完整原始 stdout/stderr 和对应隔离 Git 副本路径。
- 对应文件：F-01 `ci-fake-review.json`、F-02 `unguarded-workflow.json`、F-03 `denied-waiver.json`、F-04 `stale-model.json`、F-05 `no-assertion.json`、F-06 `partial-red.json`、F-07 `stub-load-error.json`、F-08 `runner-bypass.json`。
- 对照工件：`branch-controls.json`、`control-deletion.json`、`control-rename.json`、`control-layers.json`、`control-syntax.json`。

在被审版本及依赖不变时，完整脚本复跑命令如下；脚本会建立新临时目录，假记录只在新目录生效：

```sh
env PATH=/Users/snakesammy/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  /Users/snakesammy/.nvm/versions/node/v22.22.0/bin/node /tmp/g-group-review-f933f07c.mjs
```

模拟收据均通过 `ctxFromGit(...).contentHash()` 绑定当前副本，并先提交红/绿及收据；不是拿过期 hash 造成无关失败。F-01 刻意不给来源记录；F-02 刻意不给收据；F-03/F-04 单独改变授权或模型轮次；F-05/F-06 通过真实 Git 红提交和真实测试重跑构造。修复后应逐例把原来错误放行变为准确拦截，并保留正确阴性对照。

## 写入审查后的复核

- `review.verdict` 已填 `reject`；仅新增本报告及修改 `receipts/chore-gates.json.review`，通过结构化比较确认收据其余字段与被审提交一致。
- 再次在仓库根目录运行指定 hash 命令，仍为 `9c82e6ea9c229fec2711eb2412f77f4653a7fe8b1d061199b2fff4a22f2b11ea`，报告与 review 未使审查失效。
- 再跑完整 `--local`：退出 **1**，G-REVIEW 原因由「还没有独立审查」变为「审查结论是 reject」；G-PROVENANCE 通过，未伪造、补写或修改真实会话记录。
- `git diff --check` 通过。拒绝结论应继续阻止合并；修复由作者另行实施，本报告不替换为作者自检，也不放宽任何硬门禁。

## 重审

### 重审结论与对象

**仍为 reject。** 本次对象固定为 `f5dfaf5fcfb62248b34d37cb8c232b739d734eb8`，分支仍为 `chore/gates`；原报告保留，上文判断属于上一版，不覆盖本节的新结果。新的真实 CLI 自检和变异校验确有改进，旧的几个反例已被拦住，但以下 **8 个合并前必须修复的问题**仍使 R-01/R-02/R-04 与受保护执行边界不能成立。

审查仍由 Astra 独立执行，mirasim 会话为 `codex:f933f07c-ae51-45bf-ba20-4d6cea7e2b8c`，实际模型 `ai-iisbo/[乾坤按量]gpt-6-astra`（从 native `turn_context` 以及已落盘的本次 hash 工具调用轮次核实，OpenAI）。作者为 Claude/Anthropic；未由作者自判通过，也未改门禁代码、分支保护或写远端 provenance 状态。

本人在仓库根目录执行 `node scripts/gates/run-all.ts --hash --branch chore/gates`，本次被审 hash 为：

```text
86ba2b96f8a182dfd39f266659d2d3683634ffcfee898342b559622e0cef22da
```

### 重审实跑与旧问题回归

执行固定 Node `v22.22.0`；反例用被审提交的独立 judge 副本，通过 `--repo` 检查真实临时 Git 仓库，红提交、绿提交、收据及来源记录均隔离。下文「8 道门禁全绿」指真实 CLI 的完整 `--local`，不是仅调用单个 Gate；不冒充已在 GitHub 完成攻击。

| 项目 | 亲自观察的结果 |
|---|---|
| `npm ci` | 退出 0，5 packages，0 vulnerabilities |
| `npm run typecheck` | 退出 0 |
| `npm run lint` | 直接复跑退出 0，Biome 检查 8 个文件；首遍 RTK 的 ESLint 解析报错不算 lint 结果，已用 `rtk bypass` 纠正执行器输出 |
| `npm test` | 退出 0，但 tests=0；仍无产品代码，不能写成产品测试已验收 |
| `npm run gates:selftest` | 退出 0；56 个 Git/CLI 样例加 8 个 vendor 检查，共 64 项 |
| `npm run gates:mutation` | 最终独立复跑退出 0，原样副本通过、20 个变异均被自检发现，含「CI 模式不跑任何门禁」；不是 21 个变异，作者将原样对照也计入了总数 |
| 初次 mutation 执行 | 清理 `.git/ai` 时 ENOTEMPTY，退出 1；不能冒充通过。后用进程级 Git 配置关闭临时仓库继承 hooks、并发数 2 重跑成功；未改项目 runner |
| GitHub `f5dfaf5` 的 self-check | API 确认成功，运行 `41911827747`；这不是 trusted-gates 的执行证明 |
| Docker | `docker info` 实际失败，OrbStack daemon socket 不存在；没有启动 Docker，也没有把容器路径标成已实测 |

| 原发现 | 重审判断 |
|---|---|
| F-01 | 必需 provenance 状态已配置，但来源验证仍可绕过，见 RR-01/RR-02/RR-05 |
| F-02 | 旧路径白名单缺口已修；CLI 自检确实拦只改 workflow/package.json 无收据，文档豁免仍通过 |
| F-03 | 旧的「不批准豁免」输入已被自检拦住，但引用材料与用户身份绑定仍有缺口，见 RR-08 |
| F-04 | 旧的历史 GPT、hash 轮为 Claude 的输入已被拦住；累积生产厂商仍漏相对路径操作，见 RR-05 |
| F-05 | 独立旧别名零断言反例现在退出 1，明确报「没有任何断言」；新变体见 RR-04/RR-06 |
| F-06 | 独立同文件后补 negative 测试现在退出 1，报没有按名字失败；红绿行为绑定仍不足，见 RR-07 |
| F-07 | 独立旧复制逻辑/加载失败反例退出 1，G-STUB 和 G-TAUTO 均拦下；不再沿用旧版失败结论 |
| F-08 | 原「跳过 CI 全部门禁」变异本次确实被自检发现，可以关闭该具体反例；不表示新 workflow 策略已经安全或所有变异均可发现 |

### RR-01 [P1] session 的 harness 可路径穿越，PR 内伪造记录被当作真实独立审查

位置：[gates.ts:readTurns](../scripts/gates/gates.ts#L64)。对应 R-01/R-07。

`readTurns` 只检查冒号右边的 id，未限制左边的 harness，也没有对拼接后的 realpath 做会话根目录 containment 校验。收据可以把左边填为 `../g-group/reviews/forged`，右边为 `r`，使实际读取落到 PR 的 `reviews/forged/r/turns.jsonl`。`reviews/` 不进入 hash，所以伪造记录可以在获得 hash 后写入，无循环依赖。

**实际证明：** `review-session-path-traversal` 在真实临时 Git 仓库提交伪造记录，完整 `--local` 的 8 道门禁全绿，退出 **0**。随后 `default-sessions-traversal` 取消 `MIRASIM_SESSIONS` 环境变量，使用默认真实会话根目录与作者原有真实会话（只读），仅将 reviewer.session 设为从该根目录通向隔离 PR 的相对路径，仍退出 **0**。没有改任何真实 turns.jsonl。该路径的具体临时目录和最终读取文件均在原始 JSON 中。

**影响：** 作者无需存在真正的 OpenAI 审查会话，仅靠 PR 内一份 JSONL 就能通过来源门禁；这不是「信任真实会话文件未被篡改」可以解释的边界，因为被读的根本不是真实会话文件。

**要求：** 对完整 `<harness>:<id>` 做严格 schema 校验和 harness allowlist，拒绝额外冒号、分隔符、绝对路径及路径跳转；读取前核对 realpath 必须位于可信会话目录，包含软链逃逸反例。来源必须与真实会话身份绑定，不能由 PR 指定任意文件。

### RR-02 [P1] 本机来源签署进程执行未隔离 PR 测试，PR 可在核验前补造来源

位置：[merge.sh](../scripts/merge.sh#L24)、[lib.ts:sandboxed](../scripts/gates/lib.ts#L72)、[门禁顺序](../scripts/gates/gates.ts#L332)。对应 R-01/R-07/R-18。

本机 `merge.sh` 未设置 `GATE_SANDBOX_IMAGE`，`sandboxed` 默认退回宿主 `spawnSync`，子进程继承全部环境、文件权限与网络能力；worktree 不是进程隔离。G-RED/G-STUB/G-TAUTO 在最后的 G-PROVENANCE 前运行 PR 测试。main 上的裁判代码不变，也不能阻止这些测试写裁判稍后读取的外部文件。

**实际证明 A：** `local-external-write` 的正常测试将环境变量 `REVIEW_SENTINEL` 写到检出目录之外的临时标记文件；真实观察到内容 `independent-review-only`，同时完整门禁退出 **0**。只读了自设哨兵，没有读取真实凭据。

**实际证明 B：** `local-tests-forge-provenance` 初始模拟 reviewer 记录为空；PR 测试在正常调用源码后，将收据 hash 写入模拟会话根目录下的 reviewer JSONL。最后 G-PROVENANCE 认可这份由 PR 测试补造的记录，完整 8 道门禁退出 **0**。该测试以 main 同款配置进行 typecheck、Biome lint 也都退出 0。模拟文件全在 disposable 目录，未改真实会话。

**影响：** 与「所有者本人能写状态」不同，这里是所有者运行标准合并核验时，把可读凭据/可写来源的执行权限交给了未受信的 PR 测试。继承的 token（若有）或宿主可读认证文件也处于同一信任域；未实际读取 token、写 GitHub 状态或尝试合并。

**要求：** 本机与 CI 都应 fail closed 地执行隔离测试，隔离环境不能接触会话/群聊/凭据、裁判及其依赖，不应继承敏感环境；签署状态的进程与 PR 代码分离。没有可用沙箱时停止，而不是静默回退宿主；补测试伪造来源与目录外写入反例。还应冻结核验输入，防止测试进程改写后续检查对象。

### RR-03 [P1] G-WORKFLOW 用原文正则，带引号的写权限与表达式检查名可同时漏过

位置：[gates.ts:G-WORKFLOW](../scripts/gates/gates.ts#L260)。对应 R-18、受保护 provenance 状态边界。

反例新增普通 PR workflow：

```yaml
name: auxiliary
on: pull_request
permissions:
  statuses: "write"
jobs:
  auxiliary:
    name: ${{ format('pro{0}', 'venance') }}
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
```

**实际结果：** `workflow-quoted-write-dynamic-name` 完整 8 道门禁退出 **0**；同一内容只改为不带引号的 `write` 和字面 `provenance`，`workflow-literal-control` 即退出 **1**，同时报写权限与保护名问题。已用 YAML 解析器确认带引号值确为字符串 `write`。GitHub 官方文档确认 job name 支持表达式，`format` 产生拼接结果；因此原文中没有完整 `provenance` 不代表实际检查名不是它。[workflow 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idpermissions)、[表达式适用位置](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)、[format](https://docs.github.com/en/actions/reference/evaluate-expressions-in-workflows-and-actions#format)。

**边界：** 没有推送攻击 workflow，没有声称已经在 GitHub 伪造了状态或绕过了合并。已证实的是本 PR 声明必须拦的写权限及保护检查名输入被本机完整门禁放行。当前 provenance 的保护配置 `app_id=null`，所以不能把可信状态的来源区分仅寄托于该正则。

**要求：** 结构化解析 YAML，校验有效 permissions；对受保护 job/status 名拒绝无法静态证明安全的表达式及动态生成，或从服务端机制隔离可信检查身份。必须覆盖引号、折叠标量、锚点、表达式和实际 job name，而非只找原文 token。

### RR-04 [P1] 恒真源码断言仍能与错误实现一起过完整门禁

位置：[testlint.ts:analyzeBody](../scripts/gates/testlint.ts#L110)。对应 R-04。

`self-equality` 的红实现直接 throw，绿实现故意 `return 999`，测试为：

```ts
test("adds", () => { assert.equal(add(1, 2), add(1, 2)); });
```

**实际结果：** 测试通过，完整 8 道门禁退出 **0**；以被审 tsconfig 和 biome 配置检查该反例，typecheck/lint 均退出 0。该断言只验证确定性函数与自身相等，没有验证加法结果为 3。G-RED/G-STUB 只能因 throw 变红，不能使恒真断言变成行为规格。

同类补充 `unreachable-assertion` 在 `if (false)` 中放源码断言，测试仅真实调用源码，无实际执行断言，8 道门禁也退出 0；此补充只声明门禁结果，未声称它通过其他 lint。`srcAsserts` 的语法提及与 `constAsserts` 的字面量检查，均不足以验证有意义且执行过的判据。

**要求：** 至少拦自比较、恒真关系与不可达断言；不要将污点存在等价于测试语义有效。用错误的非抛错实现做行为变异校准，让确定性错误值必须被当前测试识别；保留正确负向对照，不能靠统一禁止源码测试换红。

### RR-05 [P1] 生产厂商累积集合仍漏相对路径操作，同厂商审查可伪装合规

位置：[gates.ts:producers](../scripts/gates/gates.ts#L94)。对应新版 R-01 的 `actual_producer_models[]`。

**反例：** 固定在 g-group 工作目录的作者会话，Claude 轮次的输入含绝对仓库路径；随后 GPT 轮次用相对路径 `packages/core/src/add.ts` 执行 apply_patch。审查轮次为 GPT，无豁免。输入记录中 GPT 轮次的相对 patch 不含字面 `g-group`，所以未计入生产集合。

**实际结果：** `relative-producer-turn` 完整 8 道门禁退出 **0**。这里使用模拟多轮原始记录测试来源算法，不指控真实作者已经换过模型；它证明所谓「宁多勿少」实际上仍会漏掉标准相对路径编辑。正反例中的厂商区别不能弥补漏识别整个生产轮次。

**要求：** 根据 session/turn 的真实工作目录与工具语义解析规范化文件路径，或直接消费宿主生成的不可变生产模型快照与动作关联；不能以工具输入是否含仓库名作可信来源判定。覆盖 apply_patch 相对路径、持续 cwd、工具省略 cwd、链接路径和重命名。

### RR-06 [P1] 用 Set 对齐测试名不等于一一对应，同名间接测试仍可零断言通过

位置：[gates.ts:G-TAUTO](../scripts/gates/gates.ts#L238)、[testlint.ts](../scripts/gates/testlint.ts#L125)。对应 R-04/R-03。

`duplicate-runtime-name` 在同一文件中提交：

```ts
test("adds", () => { assert.equal(add(1, 2), 3); });
const register = test;
register("adds", () => { add(1, 2); });
```

红提交源码 throw，绿提交正常加法。**实际结果：** Node 注册了两个具名测试，两个都通过；完整 8 道门禁仍退出 **0**，同款 typecheck/lint 也退出 0。静态分析只识别第一条，运行时与静态各转成按 `file+name` 的 Set，重复项被折叠，于是第二条零断言测试消失。静态同名检查也看不到未识别的 register。

**要求：** 比较稳定身份及数量，不用去重集合冒充一一映射；发现运行时同名/额外实例或无法追踪注册必须拦截。G-RED/G-STUB 同样不能用另一条同名的失败代偿当前测试；保留嵌套 suite 与参数化测试的明确身份规则。

### RR-07 [P1] 红绿只按名字匹配，可先写假断言红，再把断言改绿

位置：[gates.ts:G-RED](../scripts/gates/gates.ts#L170)。对应 R-02/AC-27。

`red-different-test-body` 的红提交已经有正确 `add` 实现，测试名 adds，但断言 `assert.equal(add(1, 2), -100)`；绿提交只将期望改成 3，同名测试通过。真实正确行为测试从未在空壳/错误实现上执行过一次红。

**实际结果：** 红提交同名测试确实失败、绿提交确实通过、桩替换失败，完整 8 道门禁退出 **0**，同款 typecheck/lint 也退出 0。当前 `changedTests` 与 base 比较了测试体，却没有把绿版本测试体与 red.commit 的测试体绑定；`red.commit`「只含测试和空壳实现」也未被验证。

**要求：** 红阶段运行的应是同一行为规格及其必要测试依赖，不能让更换期望/移除断言冒充实现从红到绿。绑定红绿测试身份和规范化内容，必要时在红实现上重跑绿版本测试；以本例补负向回归，避免仅凭相同名称作证明。

### RR-08 [P1] 豁免仍未绑定真实授权动作与授权人，引用示例被当成同意

位置：[gates.ts:waiver](../scripts/gates/gates.ts#L121)。对应 R-01/R-10。

**反例 A：** `quoted-waiver` 令作者/审查均为 Claude；模拟 usr_ 用户消息原文为 `以下只是测试样例，不构成授权：「批准豁免 <当前hash前12位>」`。没有不批准/拒绝/不同意这三个黑名单子串，只有引用示例，却被记录为 Waived。完整 8 道门禁退出 **0**。

**反例 B：** `different-waiver-user` 中收据 by 仍为 `39impacts.talent`，模拟原始事件的发送者是另一个 `usr_unrelated`，完整门禁也退出 **0**。检查只认 usr_ 前缀，未将 waiver.by 映射到发起人身份或具有该权限的主体。真实群聊 g-group#865 的用户 UID 已核实，反例未往真实群聊写入任何模拟消息。

**要求：** 使用认证主体发出的、作用于本 PR/hash 的结构化授权事件/明确确认交互；转发、引用、示例和否定不能产生授权事件，不能把「任意 usr_ 消息」当成「指定用户本人」。保留编辑/撤回后失效，并明确谁有权批准，而不是不断扩充否定词正则。

### 作者第 7 栏的风险是否可接受

| 声明的边界 | 重审判断 |
|---|---|
| 所有者 token 能写 provenance，防不了所有者本人 | 可作为外部信任根限制披露，不要求防御最终管理员；但 RR-02 是未受信测试继承所有者执行权限，RR-03 是检查来源可混淆，不能并入「所有者主动绕过」而豁免 |
| 信任 turns.jsonl 未被篡改 | 若来源由独立受保护宿主维护，可显式列为信任前提；当前 RR-01 连来源文件位置都不可信，RR-02 还允许 PR 测试在核验前写来源，故现状不可接受 |
| Docker 本机未测 | 维持未测，不等于通过。已实际确认 daemon 不可用；未来 trusted-gates 需要真实沙箱正反例，特别是目录外写、凭据/来源不可读、依赖/裁判不可改及网络拒绝 |
| 引导期 trusted-gates 不会运行 | API 确认 main 无此文件，目前必需项只有 self-check（GitHub Actions app_id=15368）和 provenance（app_id=null）。一次性引导需要明确受控步骤与首次落地后的实测，再将可信检查加入必需项；不能把未运行路径标为已验。本次仍有直接门禁绕过，不批准用引导理由提前合并 |

另外，README 当前写「三项都必须」，与实际两项的引导期状态并不一致；这属于待作者纠正的发布状态描述，不由本次审查改动。裁判移到 main 的方向与 R-18 的具体旧变异修复成立，不抵消上述来源、测试有效性和执行隔离问题。

### 重审原始工件与交付范围

- 完整反例脚本：`/tmp/g-group-rereview-f933.mjs`；最新完整运行目录：`/var/folders/lh/z4bcmr1d18z53jcctpfhwdt80000gn/T/g-group-rereview-f933-apfk2A/`，总结果 `results.json`，各例同名 JSON 保存退出码、完整输出、收据、红提交和副本路径。
- RR-01 默认真实会话根目录的额外验证：`/tmp/g-group-default-session-probe-f933.mjs`；原始结果 `.../g-group-rereview-f933-8RnB4V/default-sessions-traversal.json`。脚本只在隔离 PR 内写伪造文件，真实作者会话只读。
- RR-02 链式验证：最新目录的 `local-tests-forge-provenance.json`；目录外哨兵：`local-external-write.json`；静态额外对照：`fixture-static-checks.json`。
- 变异最终实跑：`/tmp/g-group-rereview-f933-mutation-final.json`，退出 0。变异源码未在运行中修改；关闭继承 hooks 仅为测试进程配置，未修改仓库 hook 或全局 Git 配置。
- 反例的假会话、假豁免事件均在临时目录，经环境变量明确注入；没有写真实会话/群聊，没有远端攻击状态、没有实际合并。源码与执行器在实验期间冻结，真实仓库只追加本节并填 review。
- 收据除 `review` 外保持作者提交内容不变。本次不能将 R-01/R-02/R-04 等作者「通过」继承为独立通过；R-08 原有字段反例和 F-08 具体旧变异可确认改善，产品状态机/UI/真实容器执行仍未验。

作者应先修上述问题，再交跨厂商独立复审。不要只加能对上本次字面输入的正则；应补信任边界、结构化身份与红绿同一规格，并以正反例证明实际执行结果。

重审 review 写入后已复核：原报告是当前报告的完整前缀，收据非 review 字段与 `f5dfaf5` 结构化比较完全一致，仅指定两文件变化；`git diff --check` 通过。指定 hash 命令仍输出本节的 `86ba2b96…cef22da`；完整 `--local` 退出 1，唯一问题是「审查结论是 reject」，G-PROVENANCE 通过。未以绕过本次拒绝为目的写成功状态或合并。


## 第三轮复审（7865762）

### 结论

**reject，修复后重审，不应合并。** 本轮对象为 `78657627b5116033ed002141e9593e9cecf06c5d`（用户简称 `7865762`），基线 `origin/main=412ce25278e3b0057e02d792a8394f98aaf21424`。我在普通独立 clone `/private/tmp/g-group-pr1-codex-786` 复现，未改门禁代码。**执行错误：首次提交和推送 `f32155b` 时我误用了共享 linked worktree，并在那里实际触发了 pre-push hook，违反用户的推送规则。**后续更正从普通独立 clone 推送；不能抹去已发生的共享 hook 执行。

按路径跳过设计存在两个**必须在合并前修复的 CI 执行边界问题**：默认重命名检测可能漏掉移出门禁目录的旧路径；另外，self-check 的“是否改了门禁”判断脚本属于 PR 自己的 workflow，功能 PR 可以把这个判断改成恒定 `changed=false`，同时避开自检与变异校验。Gates 代码的 `G-WORKFLOW` 可能拦截普通 PR workflow 对受保护 job/status 的冒充，但它并不验证 self-check 是否仍执行这两个步骤；而 `trusted-gates` 当前不运行 selftest/mutation，也不把 self-check 的分支判定作为可信输入。因此“功能 PR 不改门禁时跳过”不能由 PR 可修改的判定器决定。

### 复现环境与基线命令

| 项目 | 亲自观察结果 |
|---|---|
| clone/绑定 | 普通 clone，`HEAD=78657627b5116033ed002141e9593e9cecf06c5d`，`origin/main=412ce25278e3b0057e02d792a8394f98aaf21424`，工作树干净 |
| `npm ci` | 退出 0，审计 0 vulnerabilities |
| `npm run typecheck` | 退出 0 |
| `npm run lint` | 退出 0，Biome 检查 8 个文件 |
| `npm run gates:selftest` | 退出 0；独立完整重跑共 111 个样例/检查，末尾为“自检通过” |
| `GATE_MUTATION_JOBS=4 npm run gates:mutation` | 默认值独立运行退出 1：原样副本自检在 `runSelftest` 的 900 秒上限处未完成，输出 `✗ 原样副本自检通过` 并提前返回；38 个变异未开始。日志 `/private/tmp/g-group-pr1-codex-786-mutation.log`。另以 `GATE_MUTANT_TIMEOUT_MS=100`、`GATE_MUTATION_JOBS=1` 实跑：原样副本通过，38 条全部打印 `✗ …自检超时(0s),不算被发现`，最终退出 1；不是把超时算作成功。 |
| `git diff --check` | 退出 0 |
| `node scripts/gates/run-all.ts --hash --branch=chore/gates --base=origin/main` | 原样输出：`b3d591914d9e156cd272901686eddbb309ddf2a450d2cd327ba43800d08d809e` |
| 作者 proof | `scripts/gates/proof/mutation.txt` 显示原样通过、38/38 变异被发现、汇总退出 0；作者 proof 自报的完整结果未被本次独立默认运行复现（原样副本超时）；独立的 selftest、timeout 反例和路径判定反例见本节。 |

注意：本轮在本地普通 clone 中独立运行；最初查询 GitHub 时 PR head 为旧 `8a28502`，对应 `self-check` run `42053090530` 已成功；没有查到以 `7865762` 为 head 的 run。首次推送后，`f32155b` 的 run `42078235009` 已触发；截至 2026-11-06 01:57（UTC+8），自检成功、变异校验仍在运行，最终结论未知。不能用旧 run 的成功冒充新 HEAD 的 CI 结果。

### 阻塞问题

#### RR-09 [P1] PR 可改写 self-check 的路径判定，使功能改动跳过 selftest/mutation

位置：[`.github/workflows/self-check.yml:35-40`](../.github/workflows/self-check.yml#L35-L40)。该步骤在 `pull_request` workflow 中直接执行 PR checkout 里的 YAML；步骤内容包括：

```sh
if git diff --name-only "$(git merge-base "$base" HEAD)" HEAD \
  | grep -qE '^(scripts/gates/|\.github/workflows/)'; then
  echo "changed=true" >> "$GITHUB_OUTPUT"
else
  echo "changed=false" >> "$GITHUB_OUTPUT"
fi
```

**独立反例与边界：** 对冻结的 `7865762` 内容在内存中将两个 gated steps 的 `if` 改为 `if: false`，实际调用 `G-WORKFLOW.run`，原始和修改版均返回 `[]`，修改版包含两个 `if: false`。按 workflow 条件语义这会跳过两步；本轮没有把该改动推到 GitHub 或实际运行 Actions，不能称为真实 CI 已绕过。也未构造满足其他全部门禁及独立审查的完整功能 PR。由于该 PR 仍可把 workflow 文件留在本次受管树里，原有 `G-WORKFLOW` 只检查工作流是否冒充受保护检查、申请写权限、调用危险事件等，未对“self-check 必须运行 selftest/mutation”建立结构化断言。实际受保护 `trusted-gates` 从 main 取裁判，也不会执行 PR 自己的 self-check 两步或比较其 skipped 状态。因此，从代码结构可推断这样的改动能够令两项跳过；本轮没有验证其他检查和合并保护仍绿，不能宣称已成功绕过整个 CI 或独立审查。

**要求：** 把路径选择移到 main 上的可信裁判/受保护 workflow（例如 main 版本脚本依据可信 checkout 的 diff 计算，或者始终运行 selftest/mutation；至少让 trusted-gates 检查 self-check 的必需步骤和未被 skipped），并为“功能代码改动 + PR 修改判定器”以及“只改 workflow”补负/正例。不能只依赖 PR 自己的 YAML 做门禁可信度决定。

这个问题不是“工作流能被作者修改”的泛化说法：新提交明确规定“功能 PR 可跳过”，所以关键是**跳过决定本身被不可信输入控制**。如果项目接受始终执行两项门禁，也可消除该分支；在修复前不能把 R-18/门禁自身可信称为完整通过。

### 新提交的独立核对

- **按路径选择本身的普通正例成立**：对当前基线的实际变更集合包含 `.github/workflows/self-check.yml` 与 `scripts/gates/mutation.ts`，同一 grep 判定 `changed=true`；所以这次 PR 在作者预期下会触发两步。
- **RR-10 [P1] 默认重命名检测可漏掉移出受管目录的路径**：以上一版门禁 `7865762` 作为未来功能 PR 的基线，独立 Git fixture 仅把 `scripts/gates/vendor.ts` 原样移到 `packages/vendor.ts`。Git 默认返回 `R100 scripts/gates/vendor.ts packages/vendor.ts`，`git diff --name-only` 只输出 `packages/vendor.ts`；原 workflow grep 实测为 `changed=false`。同一 fixture 使用 `git -c diff.renames=false diff --name-only` 则为 `changed=true`。该例会破坏已有导入、类型检查可能因此失败；我没有声称它能直接造成合并，但已证明“只要改到门禁路径，两个元验证一定会运行”的路径判断不成立。应使用 `--no-renames` 或同时检查重命名前后路径，并对移出/移入/删除/新增和普通功能文件分别补真实命令对照。
- **timeout 语义成立**：`runSelftestAsync` 使用 `detached: true`，超时对负 PID 发 `SIGKILL`，返回 `timedOut` 并生成 `✗ …不算被发现`；`GATE_MUTANT_TIMEOUT_MS` 默认 900000（15 分钟），job 另有 120 分钟限制，self-check job 150 分钟，trusted-gates job 60 分钟。
- **进度输出**：作者提交的 proof 显示 1..38；本轮短超时实跑也逐项打印 1..38。默认运行尚未结束，不能据此确认 38 条被发现。
- **超时进程组回收边界**：本轮只验证了超时被判失败；未伪造或读取任何密钥/凭据文件。代码发 `SIGKILL` 到 detached child 的进程组，符合当前变异 runner 的回收目标；没有把它夸大为跨平台或所有 daemon 的完全隔离。
- **concurrency 配置**：顶层写有 `group: self-check-${{ github.ref }}` 和 `cancel-in-progress: true`；本轮未独立触发两个同 ref run 验证取消行为。

### 第 7 栏边界核对

作者新增的边界描述中，“15 分钟超时算未被发现”“逐个打印进度”“job timeout”“按相对基线判断且找不到基线按改了处理”“同分支取消旧 run”均与当前提交代码一致。原先第 7 栏关于本机 Docker 未实测、返回类型变异范围、来源记录信任、`R-18` 只覆盖列出的变异等限制仍然成立；本轮没有观察到作者声称的 Docker 本机实测，也没有使用凭据文件。中性标记实测：目录外普通标记可读但不可写；放在模拟 MIRASIM_SESSIONS 保护目录的标记不可读也不可写。因此 seatbelt 是路径黑名单式读保护，不是“所有目录外文件均不可读”。

但第 7 栏最后写“按路径跳过依赖 workflow 自身判断，若该判断被改坏，功能 PR 会少跑这两步——但改 workflow 本身就落在‘改了’范围里会触发这两步”，没有证明门禁安全：**恰恰因为判断器与 `if` 同属 PR 可改的 workflow，改 workflow 可能让功能 PR 的 diff 不触发/步骤直接跳过。**该句应改为明确的未闭合风险，或先修复后再写已接受边界。

### 规则与门禁状态

| 条目 | 本轮判断 | 依据 |
|---|---|---|
| R-01 | 未完成独立验收 | RR-01/RR-02/RR-05 的作者自检本轮通过；尚未逐条完成独立正反例，不能沿用旧版漏洞结论 |
| R-02 | 未完成独立验收 | RR-07 的作者自检本轮通过；尚未逐条完成独立正反例 |
| R-03 | 未完成独立验收 | 作者自检本轮通过；尚未逐条完成独立正反例 |
| R-04 | 未完成独立验收 | RR-04/RR-06 的作者自检本轮通过；尚未逐条完成独立正反例 |
| R-05 | 仍未完成 | 本轮只对规则自身的 38 个列举变异做了新执行方式校验，不能替代产品判据 |
| R-06 | 未测 | 仍为工程门禁 PR，不冒充产品切片边界验收 |
| R-07 | 未完成独立验收 | 来源检查仍信任宿主记录；没有完成每个来源分支的独立正反例 |
| R-08 | 未完成独立验收 | 收据字段自检通过，但尚未完成独立双侧全覆盖 |
| R-10 | 未完成独立验收 | RR-08 对应作者自检通过，尚未逐条完成独立正反例 |
| R-15 | 未完成独立验收 | 作者自检通过；RR-09/RR-10 影响元验证是否执行 |
| R-18 | **未通过** | 作者 proof 声称 38 个列举变异被发现；本轮独立默认运行在原样对照阶段超时并退出 1、未执行变异；短超时反例显示 fail-closed。workflow 可改写/跳过两项且重命名路径可漏检，故规则可信性端到端仍未闭合 |

### 交付边界

- 本轮没有写代码修复，未改 `scripts/gates/**`、workflow 逻辑、README 或现有历史轮次。
- 仅应提交本报告追加与 `receipts/chore-gates.json` 的 `review` 字段；复现脚本、timeout 反例和独立 fixture 不入 Git。
- 结论保持 **reject**，本轮新增 RR-09/RR-10。对于上一轮 RR-01..RR-08，本轮已跑作者提供的修复自检，但未对每条完成独立的正反例复现，不能仅凭旧报告宣称其仍未修复；应以本次实际独立复核结果为准。本轮也未为每个门禁编写独立双侧输入，尚未达到用户要求的完整审查覆盖。


### 第三轮补充独立反例（在 7865762 上重跑）

补充复现使用被审代码 `7865762` 未变的 gate 实现，并在 `/private/tmp/g-group-pr1-independent-probes/` 建立临时 Git 夹具与模拟会话/消息，不触碰真实会话、凭据或真实群聊。每例均通过真实 `run-all.ts --local` 再次运行，退出 0 且 8 个门禁全绿；对应 JSON 保留 stdout、stderr、退出码与 fixture。此处的“放行”不是称该行为符合要求，而是说明反例未被拦住。

- **RR-11 [P1，关联 RR-07] 红绿测试依赖可变化。** 测试体始终是 `assert.equal(add(1, 2), expected)`，红提交 `add` 已经正确但 `expected=-100`，绿提交仅把 helper 的 `expected` 改为 3。门禁只对比测试体，并把当前测试文件覆盖到红快照；helper 仍使用红提交版本，故因错误期望而红，完整门禁错误放行。应将影响规格的测试依赖一并绑定/重放，不能只比较测试体。
- **RR-12 [P1，关联 RR-04] 每文件至少一条变异失败可掩盖同文件弱测试。** 一个测试准确断言 `add(1,2)===3`，另一个对错误实现 `difference(...)=999` 只断言 `typeof ... === "number"`。红时它因抛错失败，绿时通过；对全部返回值同时变异时，前一个测试失败即可满足 `G-STUB` 的每文件条件，后一个错误结果未被检测，8 门禁全绿。应按测试与被测行为/变异关联判定，而不是按文件取“至少一条”。
- **RR-13 [P1，关联 RR-08] 明确拒绝可和格式行同消息导致豁免。** 模拟所有者消息先写“下面仅为格式演示，我不批准任何豁免：”，下一行写格式正确的 `批准豁免 PR#7 <当前hash前12位>`。两模型同厂商时，G-PROVENANCE 输出 `Waived`、完整门禁退出 0。它满足当前机械格式，但上下文明确否定授权；需要认证的结构化确认事件，而不是从自由文本抽取一行。未发送真实豁免。
- **RR-14 [P1，关联来源绑定] 命令匹配能把打印伪装成 hash 调用。** 模拟 reviewer 实际工具命令为 `printf '%s\\n' '<当前hash>' # node scripts/gates/run-all.ts --hash`；输出确为 hash，但命令中 `run-all.ts --hash` 仅是 shell 注释，未执行 hash 命令。G-PROVENANCE 仍认可该轮并全绿。应消费宿主生成的可信、结构化执行记录，核对实际可执行文件、参数、工作目录、退出码及输出，而非在任意输入文本中找子串。
- **RR-15 [P1，关联 RR-05] 同仓库另一 clone 的产出厂商可能漏计。** 模拟作者的 Anthropic 轮次操作路径含 `g-group`；后续 OpenAI 轮次写入临时目录中的另一 clone（路径不含仓库名）。该 clone 由同一 fixture 的仓库克隆；审查人为 OpenAI。路径启发式未将后者计入产出集合，8 门禁全绿。该例证明跨 clone 的关联未绑定仓库身份；不指控真实作者曾这样操作。
- **RR-09 的完整门禁对照**：另在功能 fixture 写入只执行 `echo no-checks-were-run` 的 `self-check.yml`，真实完整 `--local` 8 门禁均绿，退出 0；没有在 GitHub 上提交该 fixture，也没有声称服务端已合并。该例补强前述“G-WORKFLOW 不校验 self-check 的步骤内容”的局部证明。

以上是独立夹具结果，不等同真实宿主身份被伪造、真实凭据泄露、GitHub 状态被写入或真实 PR 已合并。作者应分别补对应正例及反例；本轮的完整 RR-01..08 双侧独立覆盖和默认 38 项变异未完成（原样对照超时），不能据此宣称审查已全部覆盖。


### 原样对照超时与 CI 状态补记

在 Node `v25.8.1`、`GATE_MUTATION_JOBS=4` 的普通独立 clone 中，`npm run gates:mutation` 原样副本自检运行约 900 秒后未完成，程序输出 `✗ 原样副本自检通过` 并退出 1，38 项变异没有启动。`runSelftest` 使用 `spawnSync` 的固定 `timeout: 900_000`，但只返回 `status/stdout/stderr`，未打印 `error` 或明确区分超时；本次结果是资源/时限下**未完成**，不是证明具体门禁变异存活。建议原样对照超时单独报告超时错误并确认子进程回收，也应使限制与目标运行环境的实际耗时相容。

本机本次审查为 Node 25；workflow 指定 Node 22.22，不能将此本机超时直接当成 CI 的同一失败。审查推送的 `f32155b` run `42078235009` 已被同分支更新取消；`13dba1f` run `42080188883` 也取消；最新 `cea05b7` run `42080870577` 截至检查时仍运行，最终 CI 结果未知。

写入 reject 后真实 `--local` 退出 1：G-REVIEW 报 reject；G-PROVENANCE 因当前会话的 `turns.jsonl` 当时尚未落盘而报会话记录不存在，不能声称来源门禁通过。CONTENT_HASH 未变。中性标记沙箱探针与独立反例路径见 `/private/tmp/g-group-pr1-independent-probes/`。
