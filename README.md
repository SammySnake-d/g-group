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

## dev/agy-backend 后端进度

[docs/BACKEND-PROGRESS-CHECKLIST.md](docs/BACKEND-PROGRESS-CHECKLIST.md) 按优先级记录 B0–B4 与 P1-A 至 P1-C 的实现、证据和未测边界。P1-A 提供每轮冻结说话配置、长期记忆卫生与证据台账、协作观察和净室群模板克隆；公告与协作观察分开，观察只在 Block 5 按需注入。

当前勾选表示对应 D 层后端切片落地。B4 的 ling-jing 上游故障尚未形成 live 成功闭环；P1-B（#126）的 Codex Compute 适配与轮边界 handoff 已完成 D 层验证；P1-C 的 HTTP/WS 合同、鉴权、背压、resync 与 CLI 生命周期已通过离线 D 层验证；真实 Electron 前端端到端手动 UI smoke 等待前端启动/P3。P2-A/B 和 P3 真实模型/前端 D+X 验收仍待完成。DM#2103 手册具体方案继续标为候选。

C0 默认启用后台状态笔记压缩。联系人可在反思完成前回复和继续下一轮，后台只接纳来源仍有效的结果，并保留较新的未压缩输入。Block 5 与 `read_memory` 提供长期记忆溯源，记忆写入校验关系外键。D 层证据见 [C0 proof](packages/server/proof/c0-bg-compaction-provenance.txt)。

## HTTP + WebSocket 后端（P1-C）

```sh
npm ci --ignore-scripts
node packages/server/src/cli.ts serve --data-dir ./gg-data --port 3489 --host 127.0.0.1 --mind fake --compute fake
# 显式允许前端来源并启用鉴权：
node packages/server/src/cli.ts serve --data-dir ./gg-data --token local-secret --cors-origin http://localhost:5173
```

启动输出一行 JSON：`httpUrl`、`wsUrl`（`/api/events` 端点）、`eventSeq`；SIGINT/SIGTERM 关闭 HTTP、WS 和 Host。`--port 0` 分配临时端口；`--db PATH` 覆盖数据库路径，否则使用 `--data-dir/gg.db`（未指定目录时 `./gg.db`）。支持 `--mind fake|pi`、`--compute fake|claude|codex`、`--api`、`--protocols`、`--magpie/--no-magpie`、`--model`、`--note-max-bytes N|none`。`serve --compute codex` 已接通 P1-B 的 Codex Compute，并将默认 Harness 设为 Codex。真实二进制、模型和 Electron UI 的端到端验收留 P3。

`POST /api/invoke` 发送 `{ "method": "session.hello", "params": { "clientApiVersion": "0.1.0" } }`，响应为合同 `ApiResult`；版本值以 `@g-group/api-contract` 的 `API_VERSION` 为准。事件从 `WS /api/events?sinceEventSeq=N` 续订，窗口过期收到 `stream.resync` 后重新加载快照。HTTP Bearer 和 WS `?token=`/Bearer 使用同一可选令牌；令牌启用时 health 只返回 `{ "ok": true }`，端点输出不带令牌。

CORS 默认只放行 HTTP(S) 的 localhost/127.0.0.1/[::1] 来源；拒绝其它 Origin 的请求和 WS upgrade。`--cors-origin` 可重复或用逗号分隔；`file://`/`null` 需显式列入，`*` 是显式全放行。库入口 `createHttpWsBridge(started, options)` 只管理传输；`serveHttpWs({ dataDir, ...options })` 同时管理 Host。可配 `pingIntervalMs`（默认 30000）及 `maxBufferedBytes`（默认 8 MiB）；慢客户端超限后断开并取消订阅。近 35 MB base64 上传、413、补发和资源释放的证据见 [P1-C proof](packages/server/proof/p1c-http-ws-bridge.txt)。macOS Seatbelt 的完全禁网策略会阻止 loopback listen；运行本片隔离门禁须使用现有 Docker 模式：预备 Node 22 镜像（例如 `node:22-slim`；本次实跑复用的本地镜像见 proof），再以 `GATE_SANDBOX_IMAGE=node:22-slim node scripts/gates/run-all.ts --local --branch=feat/agy-http-ws-bridge --base=origin/dev/agy-backend` 执行，容器仍为 `--network none`。

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

后端分层门禁与 P1-B 依赖顺序见 [进度清单](docs/BACKEND-PROGRESS-CHECKLIST.md)。

## 架构:插件化

- `domain`:领域类型、状态机、不变量。不依赖任何东西。
- `kernel`:宿主内核与插件接口(插件注册、事件总线、存储端口、上下文装配端口)。
- `process`:独立进程工具层，不依赖其他内部层；仅 `adapter` 可新增依赖（Q08 / AC-23 前置）。
- `adapter`:外部系统适配器(Claude Code / Codex Compute、pi 联系人运行时、SQLite)。
- `plugin`:可选能力与外部数据源(例如飞书 IM),只依赖 kernel 暴露的插件接口。
- `app`:组装入口(CLI / 桌面壳)。

## 本地

```sh
npm ci
git config core.hooksPath .githooks
npm run check && npm run lint && npm test && npm run gates:selftest
```

`npm run check` 校验治理文档与链接、共享合同、包结构和类型。前端合同在相邻工作目录时自动核对，也可用 `--frontend-dir=<path>` 指定前端的 `src/contracts`。开发前先从 [子系统索引](docs/subsystems/README.md) 找到模块归属。

## 第三方代码

`packages/server/src/atomic.ts` 及配套测试改编自 [milind-soni/OpenMausBot (`613ed01fd`)](https://github.com/milind-soni/OpenMausBot/tree/613ed01fd)（Copyright 2026 Milind Soni and OpenMausBot contributors），许可为 [Apache-2.0](packages/server/licenses/OpenMausBot-APACHE-2.0.txt)。

### 第三方组件与致谢

- 旧消息与记忆的混合检索使用 [acp-kernel 0.0.191](https://github.com/ranxianglei/acp-kernel)，来自 [Billion Context `541cf26`](https://github.com/ranxianglei/billion-context/tree/541cf26/kernel)。随仓保留 [MIT 及出处标注条款](third_party/acp-kernel/LICENSE)和[上游构建说明](third_party/acp-kernel/UPSTREAM.md)。
- `packages/server/src/compaction-summary.ts` 与配套测试改编自 [milind-soni/OpenMausBot (`613ed01fd`)](https://github.com/milind-soni/OpenMausBot/tree/613ed01fd)，Copyright 2026 Milind Soni and OpenMausBot contributors，[Apache-2.0](packages/server/licenses/OpenMausBot-APACHE-2.0.txt)。


## Codex Compute 与轮边界换 Harness（P1-B）

startServer({ compute: "codex", dataDir }) 与 CLI --compute fake|claude|codex 已接入。真实运行模式注册 Claude Code 和 Codex 工厂；联系人选择 Harness 与兼容模型，宿主不静默代跑。Codex 使用 app-server 原生线程与 turn；开发指令放在线程启动/恢复参数，每轮通过 turn/start 显式发 model/effort。

每个 Compute 槽位使用独立 CODEX_HOME，保留真实 HOME 供 git、SSH 和用户工具使用。联系人换 Harness 后，在下一轮边界确认旧执行器停止，再在同任务 worktree 建新原生会话，保留分支/SHA、进度与追加模型账本。工具授权只映射完整 native workspace scope 或空工具只读范围；其它子集与 Claude skill 插件明确拒收。

本片已验证确定性 native-wire、真实自有进程清理、双向 handoff 与取消/rewind；真实 codex-cli 0.169.0 二进制 E2E、模型 S+X 和实际能力配置验证留 P3。AC-23 / AC-51 / V-02 整体仍“未测”，独立审查待完成。详见[证明](packages/server/proof/p1b-codex-protocol.txt)与[进度清单](docs/BACKEND-PROGRESS-CHECKLIST.md)。

packages/adapter-codex-compute/src/startup.ts 的启动 admission 思路参考 OpenMausBot 613ed01fd（Apache-2.0），源码注明出处；[许可](packages/server/licenses/OpenMausBot-APACHE-2.0.txt)随仓保留。

## F0 前端合同扩展

后端已同步前端合同快照，提供网关模型发现、用户手动长期记忆写入、能力目录 MCP 描述与脚本清单，以及联系人资料页最近完成任务。当前证据覆盖 D 层和合同 parity，前端 UI、真实网关/模型与 Electron 端到端联调仍待 P3。

## `#4386` 任务交付即完成与对话追问重开

未挂未合入 `codeRepo` 工作树的普通任务在联系人调用 `deliver` 后即视为完成（立即了结承诺与 `task-status` 卡片、清空 `pendingForUser`、归入联系人资料页 `doneTasks` 并使用非催促交付文案），不再要求人类回复「通过」；挂有 `codeRepo` 工作树的任务仍保留人工确认与合入闸门。交付或验收后的任务（`T8a_Delivered` / `T8_Accepted`）在提出者于聊天追问修改或调用 `tasks.reject` 时可重开回 `T3_Running` 继续执行并再次交付，轮次装配默认随附最近最多 10 条本人 `T8_Accepted` 任务供联系人定位修改目标。详见[证明](packages/server/proof/direct-task-completion-20261121.md)与[进度清单](docs/BACKEND-PROGRESS-CHECKLIST.md)。
