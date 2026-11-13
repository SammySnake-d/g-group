# PR #83 D09.2④ 房间阻塞摘要（后端子片）：独立复现审查

## 第 1 轮（d4013dcb）

- 审查人：`claude`（跨厂商审 Codex 写的 PR，开发手册原则 68）；mirasim 会话 `claude:8cbac2cc-c5f7-45af-a8db-c74a3419331f`，本轮模型 `group/opus`（Anthropic）。作者 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`（OpenAI gpt-6.1-sol）。
- 被审：`origin/feat/room-pending-summary` HEAD `d4013dcb1c0a4af10e6c905a02a64298a0cd77a4`，base `origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`。开工前与定稿前两次 `git ls-remote` 回读，HEAD 未变。
- 独立克隆 `/tmp/pr83-r1-claude`（本机，Node v22.22.0，只做 git、`--hash`、单文件探针、门禁 `--local`）；重活在 box2 `/workspace/pr83-r1/`（Node v24.21.0，走 `/workspace/.heavy.lock` 排队）。没有读取任何先前结论或本地 pass 收据。
- 本会话单独一次工具调用：

  ```sh
  node scripts/gates/run-all.ts --hash --branch=feat/room-pending-summary --base=origin/dev/integration
  ```

  原样输出：

  ```text
  91a926b0f55a6a4ca211a5ef41a4e81774fc0f04e5a2709b2b19fe44c9db328c
  ```

  与作者报的 CONTENT_HASH 一致。
- hy4 辅审因线路 403 未产出（`deliverables/g-group-pr83-r1-hy4/` 不存在），本轮无辅审。
- 证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr83-r1-claude/`（下文文件名都相对它）。

### 结论：REJECT（请求返修）

作者报的数字全部复现属实，范围没有越界，来源核到原生记录一级没有发现不实。驳回理由是判别力和一处自述行为不成立：

1. 审查方自构 12 个单点故障，现有 7 条测试只发现 2 个，存活 10 个。其中「宿主层取最新而不是最早」「截断边界 500 改 499 / 501」「授权提问的原因来源丢失」「不判提问消息是否可见」都活着；收据与 README 写的「最早问题、剩余数、500 字符截断」在宿主接线这一层没有被任何测试钉住（R1-01 至 R1-04）。
2. 第一条问题超过约 490 字符且还有其它待答项时，「（另有 N 项）」被截断吃掉，自述的「剩余数」不成立（R1-05，需要改产品代码）。

探针证明其余行为现在是对的（同群两条阻塞取最早并计数、回答最早一条后换成下一条、受阻出现与取消都经 `room.updated` 反映、`rooms.list` 与 `rooms.get` 一致），所以 R1-01 至 R1-04 只需补测试与变异。

### 复现数字

| 项 | 结果 | 证据 |
|---|---|---|
| npm ci | 本机与 box2 均 exit 0 | — |
| typecheck（box2） | exit 0，无输出 | `box2/out/typecheck.log` |
| lint（box2） | exit 0，`Checked 200 files … No fixes applied` | `box2/out/lint.log` |
| npm test（box2，HEAD d4013dcb） | tests 1480 / pass 1480 / fail 0 / cancelled 0 / skipped 0 / todo 0；`test-runner:实际执行并通过 1480 条用例` | `box2/out/test.log` |
| 作者 8 个变异（box2） | 原样对照 7/7；8/8 被杀，每项 exit 1、七条跑完、ERR_ASSERTION，且被指定的具名测试杀死（「空态造摘要」另带倒 3 条） | `box2/out/mut.json`、`mut.json.*.tap` |
| 红提交 274e3be1（box2） | 测试文件与 HEAD 逐字相同（diff 0 行）；7 条 not ok、7 个 `ERR_ASSERTION`、pass 0，无加载/语法错 | `box2/out2/red.tap` |
| 末提交只补证据 | `git diff --stat 1fc0e91 d4013dc` 只有 `docs/proof/…`、`receipts/…`、`reviews/…` 共 10 个文件；5 个源文件 SHA-256 与 `source-freeze.json`、包内 `result.json` 逐项一致 | 本机 |
| 证据包 | `cloud-proof.tar.gz` SHA-256 `9319d2fa…8c4c` 与 README 一致；包内清单 33 项全对；`result.json`、`mutations.json`、`full.log` 与 box3 `/workspace/req-room-summary-20261112-v5/` 现存文件 SHA-256 相同 | 本机 + box3 只读 |
| GitHub self-check | run 43232182842 COMPLETED / SUCCESS（`gh pr view 83` 回读），PR 仍是 draft | — |
| `--local`（本机 sandbox-exec，review=null） | ✓ G-PROVENANCE（短路）✓ G-TRACE ✗ G-REVIEW（还没有独立审查）✓ G-RED ✓ G-STUB ✓ G-TAUTO ✓ G-WORKFLOW ✓ G-LAYER，exit 1 | `local-gates-mac-before-review.txt` |
| `--local`（box2，无沙箱镜像变量） | G-RED / G-STUB / G-TAUTO 报「门禁自身出错:没有可用沙箱」，拒绝在宿主上执行 | `box2/out/local.log` |
| `--local`（box2，`sudo env GATE_SANDBOX_IMAGE=node:22.22.0-slim`） | G-RED / G-STUB / G-TAUTO 报「运行时只执行了 0 次」。同一镜像里手工 `docker run … node --test` 该文件 7/7 通过，判为我这次以 root 调用的环境问题，不作为对 PR 的结论 | `box2/out2/local-sandbox.log` |
| 门禁负例 8 个 | G-TRACE、G-REVIEW、G-PROVENANCE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 各一个应失败输入，目标门禁全部判 ✗ | `neg/neg-*.log`、`neg.sh` |

门禁自检 219/219 我没有重跑：作者推送钩子日志（`deliverables/g-group-coverage/takeover-20261112/room-pending-summary-push-hook.txt`）里 `__GATE_CASE__` 219 行、`# tests 1480 / # pass 1480`，与 CI self-check SUCCESS 相符。

### 范围与标注核对

- 改动只有 `packages/api-contract/src/entities.ts`（+2 行）、`packages/server/src/host.ts`（roomView 内 +11/−1）、新文件 `room-blocked-summary.ts` 与其测试、变异脚本、证据与收据。没有前端、G4 runRound/pointers、C/C2 发送门的改动，属实。
- 需求依据：v3.31《需求文档》D09.2④「遇到 `T4b` 阻塞时，左侧会话列表直接亮起橙色状态点并透出一行阻塞摘要」。本片只做后端投影，橙点与渲染未做，README 与收据都写明了。
- AC-27 标「通过」：该条是「先红后绿与空实现红基线」的过程判据，G-RED / G-STUB 在本机沙箱与 CI 上通过，标注成立。它不是 D09.2④ 的功能验收，本片没有任何功能性 AC 被写成通过。
- AC-50 标「未测」并写明原因，如实；没有把后端投影说成 AC-50 / D09.2 全量通过。

### 来源核验（核到哪一步）

- **门禁能读作者一侧**：收据里「宿主尚未生成当前会话 turns.jsonl」已过时。`~/.mirasim/sessions/codex/76d2c467-…/turns.jsonl` 在 22:02 写出 1 轮（model `gpt-6.1-sol`，84 次工具调用），`record.json.nativeSessionId` = `01a1cfc8-db89-7400-b3de-876bd8478982`，与收据一致。把 review 填成另一会话后跑 `--local`，G-PROVENANCE 对作者一侧没有任何报错（负例里它算出的作者产出厂商集合是 `{openai}`）。
- **原生记录逐项核对**（`~/.codex/sessions/2026/11/12/rollout-…01a1cfc8-….jsonl`，model `gpt-6.1-sol`，348 次调用）：
  - 20:53–21:21 在 `/private/tmp/gg-req-room-summary-resume-20261112` 提交红 `274e3be1`、绿 `1fc0e919`（调用输出里有两条提交行与 `FROZEN 1fc0e919… RED 274e3be1…`）；与 git 提交时间 21:21:47 / 21:21:48 相符。
  - 21:29 起在 box3 `/workspace/req-room-summary-20261112-v5` + `/dev/shm/…` 跑冻结源码；21:40 回读 `full: tests 1480 / pass 1480 / fail 0 / cancelled 0 / skipped 0 / todo 0`、包 SHA-256 `9319d2fa…`、34 个文件；box3 上 `result.json` 落盘时间 13:32:16Z，夹在绿提交与证据提交之间。
  - 21:49 提交 `d4013dcb`；同一调用输出里有六项机械门禁 ✓、G-REVIEW ✗ 与 `CONTENT_HASH=91a926b0…`。
  - 21:51–21:55 正常 `git push -u origin HEAD:refs/heads/feat/room-pending-summary`（命令里没有 `--no-verify`，先断言 `core.hooksPath=.githooks`、远端分支不存在），`PUSH_RESULT exit_code 0, selftest 219/219, full_1480_pass`。
  - 21:57 `PR_CREATED number 83, headRefOid d4013dcb…, isDraft true`。
- **接手链**：最早 10 个提交（`85ecfb80`…`808fd833`）出自上一棒 `codex:534f3614-…`（原生 `01a1cf01-…`，model `chatflows/gpt-6-astra`，其 turns.jsonl 首轮有 15 次涉及本片文件的调用）；更早已停的 `claude:dd154965-…` 11 轮里没有一次调用提到本片文件。全链产出厂商都是 OpenAI，Claude 没有写过本片代码，跨厂商成立。G-PROVENANCE 只查 `author.session` 一个会话，不查接手链，这一段是我用宿主与原生记录人工核的。
- **审查一侧**：填完 review 后门禁的实际判定见本节末「填 review 后的门禁输出」。宿主在一轮结束时才写 turns.jsonl，本提交产生时我的会话记录还不存在。
- **没核到的**：box3 上那次运行的进程级记录（只有落盘文件、时间与哈希对得上）；作者推送钩子在本机实际执行的进程记录（只有日志文件与原生记录里的调用输出）。

### 审查方单点故障（box2，作者 7 条测试，原样对照 7/7）

| 编号 | 注入 | 结果 |
|---|---|---|
| R1 | 宿主层 `seq: card.seq` → `-card.seq`（取最新） | 存活 |
| R2 | 去掉 `state !== "T4b_BlockedOnHuman"` 判定 | 存活 |
| R3 | 去掉卡片 `state !== "open"` 判定 | 存活 |
| R4 | 去掉「提问消息仍可见」判定 | 存活 |
| R5 | `line.length <= 500` → `<= 499` | 存活 |
| R6 | `line.length <= 500` → `<= 501`（输出 501 字符，超合同） | 存活 |
| R7 | 原因只取卡片 `needs`，丢掉授权请求的 `action` | 存活 |
| R8 | 去掉同 seq 的任务号定序 | 存活（同房间 seq 不会相同，等价变异，不计） |
| R9 | `ordered.length > 1` → `>= 1` | 发现（rooms.get 那条） |
| R10 | roomView 里顺手把已读推进到最新 | 存活（见 R1-06） |
| R11 | 去掉 `.trim()` | 发现（折行截断那条） |
| R12 | 同时去掉卡片 open 与可见两道判定 | 存活 |
| D1 | 双点：同时去掉状态与卡片 open 判定 | 发现（重启那条） |
| D2 | `slice(0, 499)` → `slice(0, 600)` | 发现 |

证据：`box2/out2/rmut.json`、`rmut.json.*.tap`、`rmut2-mac.json`；脚本 `rmut.mjs`、`rmut2.mjs`。

探针（原样 HEAD，`zz-review-probe.test.ts`、`zz-review-probe2.test.ts`，不入库）：

- Q1 同一群两个联系人先后受阻 → `等待你：问题1（另有 1 项）`；回答问题 1 后 → `等待你：问题2`。把 R1 注入后同一探针按名失败（实际 `等待你：问题2（另有 1 项）`），说明这种夹具能钉住宿主层次序。
- P2 受阻出现时 `room.updated` 序列末项为 `等待你：问题1`；P4 `rooms.list` 一致；P5 整行恰 500 不截、501 截成 499+`…`；P8 取消 T4b 任务后为 null。以上通过。
- P6、P7 失败，见 R1-05、R1-07。

### 问题清单

**R1-01（必修，补测试）宿主层「最早一条 + 其余计数」没有测试**
- 位置：`packages/server/src/host.ts` roomView 的 `blockers`（`return [{ taskId, seq: card.seq, text }]`）；现有次序与计数断言只在纯函数 `roomBlockedSummary` 上。
- 复现：`node rmut.mjs <克隆> out.json` 的 R1 存活。
- 返修：加一条经真实 Host / service 的用例，同一房间两条有效 T4b 提问（探针 Q1 的夹具可用：一个群、两个联系人、各自受阻），断言取最早并带「（另有 1 项）」，回答最早一条后换成下一条且不带后缀；把 R1 加入变异清单并按名杀死。

**R1-02（必修，补测试）截断边界没有钉住**
- 位置：`room-blocked-summary.ts` `line.length <= 500`。
- 复现：R5、R6 存活；R6 下输出 501 字符，超过 `RoomView.blockedSummary` 的 `str({ max: 500 })`。
- 返修：加整行恰 500（不截）与 501（截成 499 + `…`，总长 500）两条断言，R5、R6 入变异清单。

**R1-03（必修，补测试）授权提问的原因来源没有测试**
- 位置：`host.ts` `this.authzOf(…).value.requests.find(…)?.action ?? this.questionText(…)`。
- 复现：R7 存活。授权提问卡的 meta 没有 `needs`（`host.ts` 授权提问处 meta 只有 `qId/constraintVer/authz`），丢掉 `action` 后摘要会变成「等待你：」空原因。
- 返修：加一条群规触发授权提问的用例（`intent.test.ts` 已有夹具写法），断言摘要是授权动作原文；R7 入变异清单。

**R1-04（必修，二选一）三道过滤各自没有被钉住**
- 位置：`host.ts` blockers 的 `state !== "T4b_BlockedOnHuman"`、`card?.state !== "open"`、`visible.some(…)`。
- 复现：R2、R3、R4、R12 单点全部存活；只有 D1（同时去掉状态与卡片判定）被重启那条发现。
- 返修：对每一道判定，要么给出只有它能拦住的场景并加测试（例如卡片已被领取或已过期而任务仍在 T4b；提问消息在 DM 回退后不可见），要么证明该场景在现有宿主里到不了并删掉这道判定。不接受三道都留着却没有一条测试能区分。

**R1-05（必修，改产品代码）第一条问题过长时「另有 N 项」被截掉**
- 位置：`room-blocked-summary.ts` 先拼后缀再整行 `slice(0, 499)`。
- 复现：`roomBlockedSummary([{ taskId:"a", seq:1, text:"中".repeat(600) }, { taskId:"b", seq:2, text:"x" }])` 结尾是 `…中中中…`，不含「（另有 1 项）」（探针 P7）。提问原文上限 5000 字符，属于合同内输入。
- 返修：先红后绿——先截正文再接后缀，保证总长 ≤ 500 且后缀完整；加对应断言与变异。

**R1-06（建议）「读取无副作用」的断言测不到幂等写入**
- 位置：测试「rooms.get 返回真实阻塞原因且读取不改变任务与已读游标」。
- 复现：R10 存活。快照 `before` 之前 roomView 已随每次 `room.updated` 跑过多次，读路径里的幂等写入在快照前就发生了；断言也没有看读取期间有没有发事件。
- 返修建议：`rooms.get` 前后比较数据库写入计数（如 `total_changes()`）并断言订阅器没有收到事件。本轮不作为驳回理由。

**R1-07（建议）截断可能切开代理对**
- 复现：`text = "中".repeat(494) + "😀😀😀"` 时输出倒数第二个码元是孤立的 `0xD83D`（探针 P6，`isWellFormed()` 为 false）。
- 说明：同文件既有的 `lastMessagePreview: last.text.slice(0, 200)` 是同一写法，不是本片新引入的模式；建议和 R1-05 一起按码点截断。本轮不作为驳回理由。

**R1-08（必修，收据文字）来源说明过时**
- 位置：`receipts/feat-room-pending-summary.json` `provenance.note`、README「来源限制」一节。
- 现状：作者会话的 turns.jsonl 已存在且门禁能读。返修时改成现状，并把接手链（`codex:534f3614`、model `chatflows/gpt-6-astra` 写了最早 10 个提交）写清楚。按分工收据其余字段我没有动。

### 需拍板

- G-PROVENANCE 只核 `author.session` 一个会话；本片最早 10 个提交出自接手前的另一个 Codex 会话，门禁看不到。这次我人工核了，厂商结论不受影响。要不要让门禁支持接手链（收据列出多个作者会话、逐个核对）由用户定；我没有改门禁。

### 填 review 后的门禁输出

填好 `review`（agent claude、本会话、model group/opus、verdict reject、reviewed_hash 同上）后，本机 `node scripts/gates/run-all.ts --local --base=origin/dev/integration` 原样输出（规则说明文字略，exit 1）：

```text
✗ G-PROVENANCE
    - 审查会话不可信:会话记录不存在:claude:8cbac2cc-c5f7-45af-a8db-c74a3419331f
✓ G-TRACE
✗ G-REVIEW
    - 审查结论是 reject
✓ G-RED
✓ G-STUB
✓ G-TAUTO
✓ G-WORKFLOW
✓ G-LAYER
CONTENT_HASH=91a926b0f55a6a4ca211a5ef41a4e81774fc0f04e5a2709b2b19fe44c9db328c
```

G-PROVENANCE 这一条报的是审查一侧：宿主只在一轮结束时写 `turns.jsonl`，本会话这一轮还没结束，记录尚不存在；它对作者一侧没有报任何问题。本轮结束后宿主写出记录，门禁才能核到那次 `--hash` 调用，我没有为此改门禁或补写会话记录。完整输出在证据目录 `local-gates-mac-after-review.txt`。

## 第 2 轮（702c8719）

- 审查人：`claude`（跨厂商审 Codex 写的 PR，开发手册原则 68）；mirasim 会话 `claude:c2ba2550-7fa0-4c1e-a8a1-c4266c213d65`，本轮模型 `group/opus`（Anthropic）。作者 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`（返修在其原生子线程 `01a1d03a-add3-7a02-92d2-92e9791196ee`，`gpt-6.1-sol`）。
- 被审：`origin/feat/room-pending-summary` HEAD `702c87194e886b40272ff21c831788f4450d5d27`，base `origin/dev/integration` `4efdee0be6d161060099b5ce488e3344c70305ee`。开工前（11-13 03:01）、断线续做时（23:22）、定稿前三次 `git ls-remote` 回读，HEAD 与 base 都没变。
- 历史：返修是 `515db145`（第 1 轮审查提交）之后线性叠加的 7 个提交（`b93f2e38` → `4f15f21d` → `7f81c9d5` → `21f0931e` → `6ff18281` → `6da91f5a` → `702c8719`），`515db145` 与 `d4013dcb` 都是 HEAD 的祖先，没有 force、没有改写；`reviews/feat-room-pending-summary.md` 在 HEAD 上与 `515db145` 上逐字相同（162 行，diff 为空），「第 1 轮」原文未动。
- 独立克隆 `/tmp/gg-pr83-r2-claude/repo`（本机 Node v22.22.0，只做 git、`--hash`、seatbelt 下的门禁 `--local`、门禁自检与门禁负例）；重活在 box1 `/workspace/pr83-r2/`（Node v24.21.0，2 核 3G，走 `/workspace/.heavy.lock` 排队，变异不并发）。没有用作者的工作树、box4 或其它审查的目录。
- 本会话里单独一次、不带 `cd`/`&&` 的工具调用（第 1 轮那次写成 `cd … && node …`，门禁的 `isHashCall` 遇到 `&` 不认，见 R2-04）：

  ```sh
  node /tmp/gg-pr83-r2-claude/repo/scripts/gates/run-all.ts --hash --repo=/tmp/gg-pr83-r2-claude/repo --branch=feat/room-pending-summary --base=origin/dev/integration
  ```

  原样输出：

  ```text
  9b0b4e8675379c0ac0e6c00bec1a3f96cf4583c01146c911486eb94bf0639feb
  ```

  与作者报的 CONTENT_HASH 一致。
- hy4 辅审因线路 403 未产出，本轮无辅审。
- 证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr83-r2-claude/`（`box1-evidence.tgz` SHA-256 `26b0521c…0ef4` 内含 box1 上全部输出与探针；本机门禁输出在 `local-*.txt`、`selftest.txt`、`neg/`）。

### 结论：REJECT（请求返修）

作者报的数字全部复现属实，R1-05 的真缺陷修对了，第 1 轮 12 个单点故障里能注入的现在全被具名测试杀死，来源核到原生子线程一级没有发现不实。驳回理由只有两条，都只需补测试、不需要改产品代码：

1. **R2-01** 删掉「提问消息仍可见」过滤所依赖的不变量，在 #71（群主撤回别人的消息，ready）合入的那一刻就失效：把 #83 HEAD 与 `origin/feat/chat-admin` `c7d1a2dd` 合并（无冲突），群主撤回联系人的提问后，会话列表摘要仍透出被撤回的问题原文，而作者 17 条测试在合并版上 17/17 全绿。作者只留了一句说明，没有一条会在那时变红的测试。
2. **R2-02** 「取最早 #seq 的提问」这一核心说法仍没被钉住：把排序换成「按任务号」或「按任务来源消息」两个单点故障，17 条测试全部存活。

### 复现数字

| 项 | 结果 | 证据 |
|---|---|---|
| npm ci | 本机与 box1 均 exit 0 | `out/setup.log` |
| typecheck（box1） | exit 0，无输出 | `out/typecheck.log` |
| lint（box1） | exit 0，`Checked 200 files in 523ms. No fixes applied.` | `out/lint.log` |
| npm test（box1，HEAD 702c8719） | tests 1490 / pass 1490 / fail 0 / cancelled 0 / skipped 0 / todo 0；`test-runner:实际执行并通过 1490 条用例` | `out/test.log` |
| 窄测 / intent+rewind 回归（box1） | 17/17；30/30，均无 skip/todo/cancel | `out/narrow.tap`、`out/lifecycle.tap` |
| 作者 18 个变异（box1，作者 runner 原样） | 原样对照 17/17；18/18 被杀：每项 exit 1、17 条完整跑完、指定具名测试 `ERR_ASSERTION`；`source_unchanged=true`；附带失败与作者 JSON 一致 | `out/mut.json`、`out/mut.json.*.tap` |
| 真实首红 `b93f2e38`（box1） | 8 条：7 过、`R2-05 …` 1 条 ERR_ASSERTION 失败 | `out2/rg-b93f2e38.own.tap` |
| 首绿 `4f15f21d` | 同一测试文件 8/8 | `out2/rg-4f15f21d.own.tap` |
| 校准红 `21f0931e` | 实现换成 `return "(未实现)"`；测试文件与 HEAD 逐字相同（diff 空）；17 条全部 not ok、17 个 `ERR_ASSERTION`、0 过 | `out2/rg-21f0931e.*.tap` |
| 恢复绿 `6ff18281` | 17/17；`6ff18281`→HEAD 之间 `packages/`、`scripts/` 无改动 | `out2/rg-6ff18281.own.tap` |
| 末两提交只补证据 | `git diff 6da91f5a HEAD -- packages scripts package*.json` 为空；`cloud-proof.tar.gz` SHA-256 `3dacf91d…912fe` 与 README 一致，包内 `full.log` 1490/1490、`mutations.json` 18/18、head `6da91f5a` | 本机 |
| G-RED 实际判法 | 收据 `red.commit` = `21f0931e`（校准红）。门禁把现在的测试文件放到该提交的实现上，要求每条改动测试按名失败、现在按名通过；本机 seatbelt 判 ✓。真实先红后绿只有 R1-05 一条（`b93f2e38`→`4f15f21d`），其余 9 条新测试是写好实现之后再做同体校准，作者在收据 `red.note` 与 README 里如实写明，不是冒充历史 TDD | 本机 `local-before-review.txt` |
| 门禁自检（本机，不经管道） | `npm run -s gates:selftest > selftest.txt 2>&1; echo $?` → **exit=0**，`自检通过`，用例 219/219，`__GATE_CASE__` 219 行 | `selftest.txt` |
| GitHub self-check | run 43283757225，headSha `702c8719`，COMPLETED / SUCCESS；PR 仍 draft/open | `gh pr view 83` 回读 |
| `--local`（本机 seatbelt，review 仍为第 1 轮） | ✗ G-PROVENANCE ✓ G-TRACE ✗ G-REVIEW ✓ G-RED ✓ G-STUB ✓ G-TAUTO ✓ G-WORKFLOW ✓ G-LAYER，exit 1；与作者 `author-final-seatbelt-gates.log` 逐行一致 | `local-before-review.txt` |
| 门禁负例 8 个（独立克隆） | G-TRACE（证据路径不存在）、G-REVIEW（hash 全 0）、G-PROVENANCE（审查=作者会话）、G-RED（red 指向绿提交 `6ff18281`）、G-STUB（吞异常测试）、G-TAUTO（自比较）、G-WORKFLOW（`pull_request_target`）、G-LAYER（相对路径跨包），目标门禁全部判 ✗ | `neg/neg-*.log` |
| 交接 ZIP | SHA-256 `a8ba307e…be8334744` 与交接一致；解到新空目录只读，57 个成员；作者本机门禁日志与我复现一致 | 本机只读 |

钩子说明：`.githooks/pre-push` 第 7 行 `gates:selftest | grep -v '^✓'` 只看 grep 的退出码，所以「钩子通过」不作为自检证据；上表自检是我不经管道单独跑的真实退出码。

### 第 1 轮问题核销

| 编号 | 结论 | 依据 |
|---|---|---|
| R1-01 宿主层取最早+计数无测试 | 已解决 | 新增 `R2-01 宿主最早问题与另有一项在回答后切换为剩余问题`（真实 Host、两个联系人同群各自受阻、回答后切换）；R1 注入（`-card.seq`）被它按名杀死。另发现的排序缺口另列 R2-02，不算 R1-01 未解决 |
| R1-02 截断边界 | 已解决 | `R2-02a/b/c`（499/500/501）；R5→被 `R2-02b` 杀，R6→被 `R2-02c` 杀 |
| R1-03 授权提问原因来源 | 已解决 | `R2-03` 走真实群规「改代码前先问我」，断言卡片 meta 无 `needs`、摘要取授权 `action`；R7 被它按名杀死 |
| R1-04 三道过滤 | **部分解决** | open 过滤：`R2-04b`（真实 stopTask 后 T9 保留 pendingQ、卡过期、消息仍可见）是只有它能拦住的场景，R3/R12/D1 均被它杀死——解决。state 过滤：删除；我用公开入口构造 14 个场景（stopTask、tasks.cancel、提问卡「不做了」、任务卡取消、撤回来源消息、撤回提问（私聊/群）、rewind 到来源前/来源与提问之间、带 stopTasks 移出成员、受阻后 failed、回答后再次受阻、等回答时补充条件、重启回收、授权回复「不行」），每一步新版摘要都等于按第 1 轮三道过滤重算的参照值，没构造出反例——在当前基线上成立。visible 过滤：删除；当前基线上用户撤回联系人消息一律 forbidden（私聊、群都试了），到不了；但与 #71 合并后立即可达且无测试变红，见 R2-01 |
| R1-05 「另有 N 项」被截掉 | 已解决 | `b93f2e38` 真实先红、`4f15f21d` 只改截断转绿；性质检查 39 256 组（BMP/星芒/混合/ASCII × 长度 0–700 × 其余项 0–12345 × 前导 0/1）全部：≤500、尾注完整、无孤立代理、未超长时原样、截断正文是原文前缀 |
| R1-06 读取无副作用测不到幂等写入（建议） | 已解决 | `R2-06` 比 `total_changes()` 并断言读取期间无事件；作者 R10 与我的 R10 注入都被它杀死 |
| R1-07 切开代理对（建议） | 已解决 | 截断后剥掉末尾孤立高代理；`R2-07` 钉住；我的 N3（剥成低代理）被它杀死；性质检查无孤立代理 |
| R1-08 来源说明过时 | 已解决 | 收据 `provenance` 与 README「独立审查与来源现状」改为现状：作者 turns.jsonl 已存在，写清接手链（`codex:534f3614` / 原生 `01a1cf01-…` / `chatflows/gpt-6-astra` 写了最早 10 个提交）与 R2 子线程 `01a1d03a-…`，并注明接手链是人工核、不冒充门禁自动覆盖 |

### 审查方单点故障（box1，作者现有 17 条测试，原样对照 17/17）

第 1 轮 12 个与 D1/D2 在新代码上的对应注入，加 5 个打在返修新代码上的：

| 编号 | 注入 | 结果（杀死它的具名测试） |
|---|---|---|
| R1 | 宿主层 `seq: -card.seq`（取最新） | 杀死：`R2-01 宿主最早问题与另有一项…` |
| R2 | 去掉 `state !== "T4b_BlockedOnHuman"` | 注入点已随返修删除，不可注入；风险见 R1-04 行 |
| R3 | `card?.state !== "open"` → `!card` | 杀死：`R2-04b …`、`重启回收后的失败任务…` |
| R4 | 去掉「提问消息可见」 | 注入点已随返修删除，不可注入；风险见 R2-01 |
| R5 | `<= 500` → `<= 499` | 杀死：`R2-02b 整行恰500字符不截断` |
| R6 | `<= 500` → `<= 501` | 杀死：`R2-02c 整行501字符截为499加省略号` |
| R7 | 只取卡片 `needs`，丢授权 `action` | 杀死：`R2-03 授权提问摘要取真实授权请求action…` |
| R8 | 去掉同 seq 的任务号定序 | 存活（同房间 seq 唯一，等价变异，不计） |
| R9 | `> 1` → `>= 1` | 杀死：11 条，含 `R2-01`、`R2-02a/b/c` |
| R10 | 读路径顺手写 `gg_read` | 杀死：`R2-06 rooms.get不产生幂等数据库写入也不发送事件` |
| R11 | 去掉 `.trim()` | 杀死：`阻塞摘要折为一行并限制为合同允许的长度` |
| R12 / D1 | 去掉卡片 open（新代码上与 R3 同一注入） | 杀死：同 R3 |
| D2 | 截断预留 `499` → `600` | 杀死：`R2-05`、`R2-02c`、`R2-07`、折行那条 |
| N1 | 截断预留 `499` → `500`（截断后 501 字符） | 杀死：同 D2 四条 |
| N2 | 省略号放到尾注之后 | 杀死：`R2-05 长问题截断保留另有 N 项尾注…` |
| N3 | 剥低代理而不是高代理 | 杀死：`R2-07 Unicode截断不留下孤立高代理码元` |
| N4 | 纯函数改为只按任务号定序 | **存活** |
| N5 | 宿主层按任务来源消息 `d.sourceSeq` 而不是提问消息定序 | **存活** |

第 1 轮存活的 10 个，现在：可注入的 8 个（R1、R3、R5、R6、R7、R9、R10、R11）与 R12/D1 全部杀死；R2、R4 的注入点随判定删除而不存在；R8 等价。脚本 `probes/rmut-r2.mjs`，结果 `out2/rmut.json`。

### 探针（不入库，box1 原样 HEAD 的独立工作树）

- `zz-r2-probe.test.ts` 17 条：A1–A14 即上面 R1-04 行的 14 个公开入口场景，逐步与三道过滤参照值比对，全部一致；B1 让先建的任务后提问、后建的任务先提问，摘要取「乙先问（另有 1 项）」——**现在的实现是对的**，只是测试分不出（R2-02）；B3 第一条提问 4990 字、另有一项，`rooms.get` 经合同校验返回 500 字且以「…（另有 1 项）」结尾。B2 失败：我直接调内部 `Host.stopTask` 后没有 `room.updated`，见 R2-03（`/stop` 命令与 `tasks.cancel` 走的路径会推送，不受影响）。
- `zz-r2-pure.test.ts` 6 条全过（性质检查见 R1-05 行）。
- `zz-r2-merge71.test.ts`：见 R2-01。

### 问题清单

**R2-01（必修，补测试）可见性过滤删掉后，#71 合入即失效且没有测试会变红**
- 位置：`packages/server/src/host.ts` roomView 的 `blockers`（返修删掉了 `visible.some((m) => m.seq === card.seq)`）；作者的 `R2-04c` 只在私聊里断言用户撤回联系人提问被拒。
- 复现：box1 上 `git merge origin/feat/chat-admin`（`c7d1a2dd`，#71，ready）到 `702c8719`，无冲突（合并提交 `16677251`）。合并版上作者 17 条测试 17/17 通过，`R2-04c` 仍绿（#71 只放开群里的群主撤回，私聊仍拒）。探针 M1：群里联系人受阻提问「请把私密验证码XYZ123发给我」，群主 `messages.retract` 该提问 → `ok:true`，消息 `retracted:true`、正文为空，但卡仍 `open`、任务仍 T4b，`rooms.get` 的 `blockedSummary` 仍是 `等待你：请把私密验证码XYZ123发给我`。第 1 轮的代码会因可见性过滤给出 null。被撤回原文从会话列表摘要回来，属 AC-08（撤回后缓存不得再返回原文）一类问题。
- 作者自述「不是对 #71 群主撤回的证明」属实，但只留了说明。#83 若先合，#71 后合，两边测试都绿，泄漏不会被任何测试发现。
- 返修：加一条会在 #71 合入时变红的测试——最直接的是把 `R2-04c` 在**群**里再做一遍（用户撤回群里联系人的提问须被拒、卡仍 open、摘要不变）；#71 合入后它变红，由后合的一方当场决定恢复可见性过滤（并改成断言撤回后摘要为 null）或在撤回时让提问卡过期。不接受只改说明文字。#71 自身的审查也请看这一点：合并后 `TaskView.pendingQuestion.text` 同样带出被撤回原文（既有字段，不是本片引入）。

**R2-02（必修，补测试）「最早 #seq 的提问」没有被钉住**
- 位置：`room-blocked-summary.ts` 排序 `a.seq - b.seq || a.taskId.localeCompare(b.taskId)`；`host.ts` `seq: card.seq`。
- 复现：N4（纯函数只按任务号）与 N5（宿主改用任务来源消息 `d.sourceSeq`）17 条全过。原因：纯函数测试 `阻塞摘要按最早消息顺序选择…` 的夹具里任务号顺序（`first` < `later`）恰好与 seq 顺序相同；`R2-01` 里先建的任务也先提问，任务号、来源消息、提问消息三者同序。
- README 与合同注释说的是「最早 #seq 的 T4b 问题」；探针 B1 证明实现是对的，所以只补测试：纯函数夹具让任务号顺序与 seq 顺序相反；宿主层加一条「先建的任务后提问」的用例（B1 的写法可用：两个联系人，第一个 Compute 只 `started`，第二个先受阻，再对第一个 `compute.emit` 一条 blocked），把 N4、N5 加进变异清单并按名杀死。

**R2-03（建议）离开 T4b 而不发消息的路径不推 `room.updated`**
- 复现：探针 B2 直接调 `Host.stopTask` 并等到 T10，订阅到的最后一个 `room.updated` 仍是旧摘要；A12 用户补充条件、联系人只 `forward` 不回话时，任务回 T3、摘要变 null，但这一步不发 `room.updated`。`/stop`、`tasks.cancel`、提问卡按钮、回答都会追加消息并推送，不受影响；移出成员在停止确认后推送。
- 说明：`pendingForUser` 红点有同样的既有缺口，README 只声称「回答生效后经 room.updated 推送」，属实。本轮不作为驳回理由；建议在 `emitTask` 里对任务所在房间补一次 `room.updated`，或在本片 README 写明限度。另记一条既有问题（不属本片）：A12 中补充条件经 `saveTaskTx` 改版本后，旧提问卡仍是 `open`（没走 `expireQuestionsTx`），与 AC-44 ⑤「版本已变后卡标已过期」不符，`pendingForUser` 因此多计 1。

**R2-04（记录，审查方自身）第 1 轮审查的 `--hash` 调用门禁认不出**
- 作者本机门禁保留的两项 G-PROVENANCE 原始失败（「审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash」「审查那一轮的厂商认不出」）都在审查一侧，不是作者的问题，也不是第 1 轮的「会话记录不存在」：第 1 轮会话 `claude:8cbac2cc` 的 turns.jsonl 已在 11-13 01:15 写出，里面那次调用写成 `cd /tmp/pr83-r1-claude && node scripts/gates/run-all.ts --hash …`，`isHashCall` 遇到 `&` 一律不认，第二条是第一条的连带结果（没有命中就取不到厂商）。本轮改为不带 `cd` 的单条命令（`--repo=` 指仓库），门禁规则不动。

### 来源核验（核到哪一步）

- **收据作者会话**：`author.session` = `codex:76d2c467-…`，是宿主会话号（不是子线程号）；`~/.mirasim/sessions/codex/76d2c467-…/turns.jsonl` 已写出（6.9 MB，11-13 03:50），`record.json.nativeSessionId` = `01a1cfc8-db89-7400-b3de-876bd8478982`。门禁对作者一侧无报错。
- **原生记录**：`~/.codex/sessions/2026/11/12/rollout-…-01a1d03a-add3-7a02-92d2-92e9791196ee.jsonl`（文件按本地时间落在 11/12 目录；11/13 目录下没有本片的记录），`session_meta.parent_thread_id` = `01a1cfc8-…`、`agent_path=/root/loop_proof_finish`，turn_context 模型只有 `gpt-6.1-sol`，571 次调用。按时间（UTC）对到：
  - 18:06:51 真实首红：`red_commit b93f2e38…, parent 515db145…, pass 7, fail 1, failure_code ERR_ASSERTION`；18:07:17 首绿 `4f15f21d…` 8/8，`test_file_identical_to_real_red: true`（与 git 提交时间 02:06:51/02:07:17 +08:00 一致）。
  - 18:20:57 `EXPANDED_GREEN 7f81c9d5…`，intent/rewind 30/30；18:22:20 校准红 `21f0931e` / 恢复绿 `6ff18281`，两端测试 SHA 同为 `aaf04904…`；18:23:19 `R2_SOURCE_FROZEN 6da91f5a…`。
  - 18:34–18:41 box4 `/workspace/req-room-summary-r2-20261113-6da91f5a` 经 `flock /workspace/.heavy.lock` 排队运行，下载包 SHA `3dacf91d…` 校验通过（与仓库内 `cloud-proof.tar.gz` 一致）。
  - 18:43:02 提交 `[feat/room-pending-summary 702c8719] docs(room-summary): record fresh R2 full and 18 named mutant proofs`；18:43:16 本机门禁输出与我复现的一致。
  - 18:43–18:47 正常推送：推送脚本（交接 ZIP 内 `author-final-gate-push.py`）先断言 `core.hooksPath=.githooks`，执行 `git push origin HEAD:refs/heads/feat/room-pending-summary`（无 `--no-verify`、无 force），exit 0，远端 `515db145` → `702c8719`；钩子输出 `自检通过 … 用例 219/219` 与全量 1490/1490（钩子的自检判定见上文管道问题，自检以我单独跑的为准）。
- **接手链**：最早 10 个提交出自 `codex:534f3614`（原生 `01a1cf01-…`，`chatflows/gpt-6-astra`），第 1 轮已人工核；本轮 7 个提交全部在 `01a1d03a`（`gpt-6.1-sol`）里。全链产出厂商都是 OpenAI，跨厂商成立。G-PROVENANCE 仍只查 `author.session` 一个会话，接手链是人工核的。
- **没核到的**：box4 上那次运行的进程级记录（按交接不去 box4，只核了下载包、成员 SHA 与原生记录里的调用输出）。

### 需拍板

- （第 1 轮遗留，仍待定）G-PROVENANCE 只核 `author.session` 一个会话，看不到接手链；本片接手链由我人工核过，厂商结论不受影响。要不要让门禁支持收据列出多个作者会话并逐个核对，由用户定；我没有改门禁。

### 范围与标注核对

- 返修只改了 `host.ts`（roomView 内删两道过滤，+3/−2）、`room-blocked-summary.ts`（截断）、测试、变异 runner、证据、收据与 README；没有前端、生命周期、G4、C/C2 改动。
- AC-27「通过」：G-RED（校准红）/ G-STUB 在本机 seatbelt 与 CI 通过，过程判据成立；作者如实区分了真实先红与同体校准。AC-50「未测」、界面与真实模型未测，收据 `unverifiable` 与 README 标注如实。

### 填 review 后的门禁输出

填好 `review`（agent claude、本会话、model group/opus、verdict reject、reviewed_hash 同上）并提交后，`--hash` 仍是 `9b0b4e86…39feb`（审查文件与收据不进内容 hash）。本机 seatbelt `node scripts/gates/run-all.ts --local --base=origin/dev/integration` 原样输出（规则说明文字略，exit 1）：

```text
✗ G-PROVENANCE
    - 审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash,无法证明审的是这一版
    - 审查那一轮的厂商认不出
✓ G-TRACE
✗ G-REVIEW
    - 审查结论是 reject
✓ G-RED
✓ G-STUB
✓ G-TAUTO
✓ G-WORKFLOW
✓ G-LAYER
CONTENT_HASH=9b0b4e8675379c0ac0e6c00bec1a3f96cf4583c01146c911486eb94bf0639feb
```

G-PROVENANCE 两条都在审查一侧：本会话的 turns.jsonl 现在只有第一轮（11-13 05:09 因线路 502 中断时写出），那一轮的 `--hash` 是 `cd … &&` 写法、门禁不认；本轮那次不带 `cd` 的单条调用要等本轮结束宿主写出记录后门禁才看得到。作者一侧无报错。我没有改门禁，也没有补写会话记录。G-REVIEW 只剩「审查结论是 reject」，hash 已钉在当前内容上。完整输出在证据目录 `local-after-review.txt`。
