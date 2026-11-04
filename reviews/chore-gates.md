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
