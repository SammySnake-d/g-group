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

1. 分支 `feat/<切片>`。先写行为测试,单独提交一次(这个提交上测试必须失败),记下提交号。
2. 写实现,测试变绿。
3. 写收据 `receipts/<分支名,斜杠换成横杠>.json`(格式见 [docs/RECEIPT.md](docs/RECEIPT.md)):对上的 AC 条目、证据路径、红提交、第 7 栏。
4. `node scripts/gates/run-all.ts --hash` 得到内容 hash,交给 Astra 审。Astra 把结论、她的会话号和这个 hash 写进收据 `review` 字段。
5. 审后任何代码或收据结论的改动都会让 hash 失效,需要重审。
6. 只用 `scripts/merge.sh <PR号>` 合并:本机跑全部门禁(含会话来源核对)+ CI 绿。

## 机械门禁

`npm run gates:selftest` 校准门禁本身:每个门禁都有必须放行和必须拦下的样例。

| 门禁 | 规则 | 拦什么 |
|---|---|---|
| G-TRACE | R-06 R-08 R-15 | 改了代码没收据;条目不在验收文档;通过没证据;状态不在 通过/失败/未测/不适用;第 7 栏没点到条目 |
| G-REVIEW | R-01 | 作者自审;同厂商审查(除非有带群消息出处的用户豁免);厂商认不出;审后又改 |
| G-PROVENANCE | R-01 R-07 | 收据自报的模型与 mirasim 会话原始记录不符;审查会话里没出现过被审 hash(仅本机,merge.sh 跑) |
| G-RED | R-02 | 门禁检出红提交亲自复跑:点名测试当时没失败、现在没通过 |
| G-STUB | R-03 | 所有源码函数体换成 throw 后仍通过的测试 |
| G-TAUTO | R-04 | 无断言、恒真断言、不碰被测源码的测试 |
| G-LAYER | 插件化 | 包分层(domain → kernel → adapter/plugin → app)只能向下依赖;插件互不依赖;不准相对路径跨包 |

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
npm run typecheck && npm run gates:selftest && npm test
```
