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
