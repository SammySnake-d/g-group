# g-group

多联系人群聊协作宿主:联系人(pi 运行时,薄大脑)在群里对话、派活;Compute(Claude Code / Codex)在幕后执行;宿主管状态、上下文与门禁。

## 产品对照文档(真源)

| 文档 | 作用 |
|---|---|
| [docs/spec/需求文档.md](docs/spec/需求文档.md) | 需求主稿(Argon 维护) |
| [docs/spec/验收文档-v0.1.md](docs/spec/验收文档-v0.1.md) | 验收规则 R-xx、验收标准 AC-xx、待实测 V-xx。每个 PR 都要对上这里的条目 |
| [docs/spec/技术栈与工程规则.md](docs/spec/技术栈与工程规则.md) | 技术栈与 7 条工程规则 |
| [docs/spec/PROTOTYPE-REPORT.md](docs/spec/PROTOTYPE-REPORT.md) | S-1/S-4 实测报告 |

主稿在 `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-requirements` 由 Argon 维护,这里是快照;Argon 更新后同步进来(只改 docs/,不需要收据)。

## 分工

- Claude Code:主开发、拆 PR、合并。
- Astra(Codex,OpenAI):每个 PR 独立复现验证。审查必须不同厂商,这是硬门禁。
- Argon:维护文档,标注实现与需求的差异。
- Grok:边界清楚、有测试兜底的子任务。

## 开发流程(每个 PR)

1. 分支 `feat/<切片>`。先提交"红"提交:行为测试 + 空壳实现(函数签名在、返回假值),测试按名字失败。记下提交号。
2. 写实现,测试变绿。
3. 写收据 `receipts/<分支名,非字母数字换成 ->.json`(格式见 [docs/RECEIPT.md](docs/RECEIPT.md))。
4. 审查人在自己的会话里跑 `node scripts/gates/run-all.ts --hash --branch <分支>`,把输出原样填进收据 `review.reviewed_hash`。G-PROVENANCE 只认这一次工具调用的输出和那一轮的模型。
5. 审后改任何受管内容(除 docs/、reviews/、receipts/、README.md 外的一切,含 workflow 和依赖清单)都会让 hash 失效,需要重审。
6. 只用 `scripts/merge.sh <PR号>` 合并。

## 机械门禁

裁判在 main 上。`trusted-gates` 用 `pull_request_target` 触发,workflow、门禁代码、tsconfig、biome 配置都取自 main,PR 的内容只当数据检查,PR 代码只在无网络容器里执行。`self-check` 跑 PR 自己的门禁自检和变异校验,证明改过的门禁仍然可信。

分支保护要求三项检查都在 PR 当前 head 上通过:

| 检查 | 谁写 | 内容 |
|---|---|---|
| `trusted-gates` | main 上的 workflow | 下表除 G-PROVENANCE 外的门禁 + 类型检查 + lint + 测试 |
| `self-check` | PR 的 workflow | 类型检查、lint、测试、门禁自检、门禁变异校验 |
| `provenance` | `scripts/merge.sh`(仓库所有者的 token) | 本机跑全部门禁含 G-PROVENANCE,通过后写在这个 SHA 上 |

| 门禁 | 规则 | 拦什么 |
|---|---|---|
| G-TRACE | R-06 R-08 R-15 | 受管改动没收据;条目不在验收文档;通过没证据;状态不在 通过/失败/未测/不适用;第 7 栏没点到条目 |
| G-REVIEW | R-01 | 作者自审;自报同厂商且无豁免;厂商认不出;审查结论不是 approve;审后又改 |
| G-PROVENANCE | R-01 R-07 R-10 | 审查会话里没有一次 `run-all.ts --hash` 输出等于被审 hash;算 hash 那一轮的模型与自报不符;审查厂商落在作者的产出厂商集合里;豁免不是用户本人在群里对这一版 hash 的明确"批准豁免"、或之后被撤回/改写 |
| G-RED | R-02 | 新增或改动的每条测试,门禁检出红提交复跑:当时没按名字失败(加载失败不算)、现在没按名字通过 |
| G-STUB | R-03 | 测试执行期间把所有源码函数变成空桩,基线通过的测试没有按名字失败(仍通过、skip、没执行都算) |
| G-TAUTO | R-04 | 按 node:test 真实导入识别测试(含别名);无断言、没有一条断言判被测源码的结果、恒定断言、skip/only;运行时注册的测试和静态识别不一致 |
| G-WORKFLOW | R-18 | PR 的 workflow 冒充受保护检查名、申请写权限、写提交状态、用 pull_request_target;删掉 trusted-gates.yml |
| G-LAYER | 插件化 | 包分层只能向下依赖;插件互不依赖;不准相对路径跨包;import 和依赖声明都查 |

门禁自身可信(R-18):`npm run gates:selftest` 在真实 git 仓库里调用真实命令行入口,合规必放行、违规必拦下;`npm run gates:mutation` 把门禁故意改坏 21 种(跳过执行器、不比 hash、删门禁……),每种都必须被自检发现。

机器验不了、交给人判的:R-06 切片边界对不对;R-07 证据是不是真实对象;收据第 7 栏的质量;体验类结论;需求有没有漏。

## 架构:插件化

- `domain`:领域类型、状态机、不变量。不依赖任何东西。
- `kernel`:宿主内核与插件接口(插件注册、事件总线、存储端口、上下文装配端口)。
- `adapter`:外部系统适配器(Claude Code / Codex Compute、pi 联系人运行时、SQLite)。
- `plugin`:可选能力与外部数据源(例如飞书 IM),只依赖 kernel 暴露的插件接口。
- `app`:组装入口(CLI / 桌面壳)。

## 本地

```sh
npm ci
git config core.hooksPath .githooks
npm run typecheck && npm run lint && npm test && npm run gates:selftest
```
