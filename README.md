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
- 审查人:默认 Codex,Astra 也可(g-group#1531,写在 `scripts/gates/policy.json`)。审查会话必须是 codex 会话,厂商按会话记录里实际的模型核对;审查必须与作者不同厂商,这是硬门禁;禁止自审;reject 必须返修后再审。
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

裁判在 main 上。`trusted-gates` 用 `pull_request_target` 触发,workflow、门禁代码、tsconfig、biome 配置都取自 main,PR 的内容只当数据检查,PR 代码只在沙箱里执行:CI 用 docker --network none,本机用 macOS sandbox-exec(禁网、只许写本次临时副本、不许读会话/群聊/凭据目录);两者都没有就停,不回退到宿主。门禁的 git 子进程剥掉全部 GIT_* 环境、不跑 hook。`self-check` 跑 PR 自己的门禁自检和变异校验,证明改过的门禁仍然可信。

引导期(trusted-gates 还没进 main)分支保护只要求 `self-check` 和 `provenance` 两项在 PR 当前 head 上通过;trusted-gates 合进 main 后再加为必需项。三项各自的内容:

| 检查 | 谁写 | 内容 |
|---|---|---|
| `trusted-gates` | main 上的 workflow | 下表除 G-PROVENANCE 外的门禁 + 类型检查 + lint + 测试 |
| `self-check` | PR 的 workflow | 类型检查、lint、测试、门禁自检、门禁变异校验 |
| `provenance` | `scripts/merge.sh`(仓库所有者的 token) | 本机跑全部门禁含 G-PROVENANCE,通过后写在这个 SHA 上 |

| 门禁 | 规则 | 拦什么 |
|---|---|---|
| G-TRACE | R-06 R-08 R-15 | 受管改动没收据;条目不在验收文档;通过没证据;状态不在 通过/失败/未测/不适用;第 7 栏没点到条目 |
| G-REVIEW | R-01 | 审查人不在 policy.json 的白名单(默认 Codex,Astra 也可);作者自审;自报同厂商且无豁免;厂商认不出;审查结论不是 approve;审后又改 |
| G-PROVENANCE | R-01 R-07 R-10 | 会话标识不合格式、harness 不在白名单、realpath 逃出会话根目录;审查会话不是 codex 会话、或派活卡片显示会话属于别的助手;审查会话里没有一次 `run-all.ts --hash` 输出等于被审 hash;算 hash 那一轮的模型与自报不符;审查厂商落在作者的产出厂商集合里;豁免不是仓库所有者 39impacts.talent(usr_4f6ca5e0d86b4a73b5575724ab172bb0)本人发的整行独立指令 `批准豁免 PR#<号> <hash前12位>`(不在引号、引用块、代码块里,全文只此一处),或之后被引用、转发、编辑、撤回 |
| G-RED | R-02 | 新增或改动的每条测试:红提交上的测试体与现在不同;把现在的测试文件放到红提交的实现上没按名字失败(加载失败不算);现在没恰好通过一次 |
| G-STUB | R-03 R-04 | 测试执行期间把所有源码函数变成空桩,基线通过的测试没有按名字失败(仍通过、skip、没执行都算);返回 number/string/boolean 的函数换成错误返回值(不抛错)后,文件里的测试全部仍通过 |
| G-TAUTO | R-04 | 按 node:test 真实导入识别测试(含别名);无断言、自比较或恒真关系、写在执行不到的位置、没有一条断言判被测源码的结果、恒定断言、skip/only;运行时注册的测试和静态识别按 file+name 逐条计数不一致(含同名重复) |
| G-WORKFLOW | R-18 | 结构化解析 YAML(含引号、折叠标量、锚点合并):PR 的 workflow 的 job id 或 name 冒充受保护检查名、name 含 `${{ }}` 表达式、workflow 或 job 申请任何写权限(含 write-all)、写提交状态、用 pull_request_target/workflow_run、调用可复用 workflow;删掉 trusted-gates.yml |
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

## 第三方组件与致谢

- **acp-kernel / billion-context**:记忆排序和旧消息检索用的是 [acp-kernel](https://github.com/ranxianglei/acp-kernel)(Billion Context 内核,[billion-context](https://github.com/ranxianglei/billion-context) 主仓的 `kernel/`)的 hybrid 检索。原样放在 `third_party/acp-kernel/`(上游提交 `541cf26`,版本 0.0.191),只经 `packages/kernel/src/history-search.ts` 一处调用。Copyright (c) 2026 ranxianglei,MIT 许可另加出处标注条款,见 `third_party/acp-kernel/LICENSE`、`NOTICE` 与 `UPSTREAM.md`。
