# PR #75 第一轮独立审查：REJECT

结论：桌面最小闭环已经有可运行安装包，最终头的后端与桌面测试通过；本轮不放行。停止确认存在一项独立复现的真实缺陷，此外整条 PR 的正式门禁尚未通过。本文将产品缺陷、缺测/证据问题和环境失败分开记录，不修改产品代码，不合并 PR。

## 被审版本与身份

| 项目 | 冻结值 |
| --- | --- |
| PR / 分支 | #75 / `feat/desktop-closed-loop`，含合并的 #99、#100 及 #74 常驻停止确认 |
| reviewed HEAD | `cb9f13e00f5ac36f6bfea47d9f4c37d0ce9398ed` |
| base | `origin/feat/desktop-files-provenance` = `907a87c0030ad671991ba8b81668b461118c2b6a` |
| reviewed_hash | `2a8d88358c0c4cc2eb0c309995e66fb5918a36ca672cda9dac8b1e5fbf69a83b` |
| 审查人 | Codex；`codex:5c7730f7-9b5e-436b-bf34-f54611e16e15` |
| 实际模型 | 原始 Codex turn_context：`chatflows/gpt-6.1-sol`，OpenAI；没有更换审查模型 |
| native session | `01a1d98a-5952-7302-8957-6a95ce505d1e` |
| 执行 | 独立 HTTPS 克隆；box2 后端与行为验证，box1 桌面与独立变异，box4 门禁环境诊断；均使用共享 heavy 锁；未使用 box3 |

`git diff dce88933 HEAD` 为空。719e95d2 到最终头只增加证据与收据，没有产品代码差异。hash 在审查会话里用单独一次 `node scripts/gates/run-all.ts --hash --branch=feat/desktop-closed-loop --base=origin/feat/desktop-files-provenance` 取得；远端 head/base 在交付前再次回读。

## 必修：真实产品缺陷

### CORR-001 / High：已记录的子进程换进程组后，被误判为已经退出

位置：`packages/adapter-cc-compute/src/procgroup.ts:85` 的 `stillAlive`，以及 `packages/adapter-cc-compute/src/stop-confirm.ts:40` 的确认循环。该实现来自本 PR 合入的停止确认切片，属于此次 diff。

`stillAlive` 要求当前 PID 的 pgid 与停止前记录一致；只要 pgid 不同就返回 false。进程可以在停止前快照之后调用 `setsid()`，而不退出、不更换 PID。CLI 随后退出、子进程被过继，`treeNow(root)` 无法重新发现它；确认循环又将已记录的子进程按旧 pgid 过滤，于是存活集合变空，返回 `{ok:true,killed:0}`。

本轮在 macOS 用真实 Python 父子进程复现，结果见 `pgid-transition.log`：

- 停止前记录到子进程 PID 33831、PPID/PGID 33826。
- 父进程自行退出，子进程自行 `setsid()`；`ps` 显示 `33831 1 33831 Ss`，同一个子进程仍然存活。
- 调用生产函数 `confirmStopped(33826, before, 120)` 返回 `ok:true,killed:0`，之后对 PID 的存在检查仍为真。
- 任何非零信号均拦截为中性标记；实际没有发送停止信号。收尾由子进程读取中性标记自行结束，临时目录已删除。

这不属于“停止前父子链已经断掉、没有记录到守护进程”的已定排除项：该子进程在停止前的快照中确实存在。`Host.afterRound`（`packages/server/src/host.ts:3566`）信任 quiesce 的成功结果，随后可以提交 `StoppedConfirmed` 并归还槽位（3581、3584 行）。因此这项错误确认可进一步导致任务提前落 T10、成员移出或槽位归还；本轮直接复现的是错误的确认返回值，未将该时序另包装成一次完整的真实模型 service 运行。

修复要求：不能用 pgid 改变证明旧进程退出。需用可核对的稳定进程身份判断归属；身份或查询无法确认时不能返回成功。补充“快照时同组、随后 setsid、主进程退出、子进程仍存活”的回归与阴性对照，同时继续避免 PID 复用误伤。

复现命令：`node reviews/pr75-r1-evidence/pgid-transition-probe.mjs <本仓库绝对路径>`。缺陷存在时脚本退出 1，并输出 `defect:true`；退出 1 是本复现检查的红结果。

## 单独结论：T5 → T8a 没有证据表明是在把真实回归改绿

该修改符合需求 §8.1 已定 1、AC-28/AC-56：没有合格审查人或审查没做成时，交付进入 T8a，门禁留 none；沉默不通过；本人确认之后才 T8，记 waived-by-user。有合格审查人的路径继续先在 T5 审查，合规通过和本人豁免仍有区别。

独立复跑了作者所列的同一组 13 个测试文件：红提交 `398a202c` 为 264 条、226 过、38 失败；最终头为 264/264。38 个失败名称与作者红记录逐个一致，没有额外失败、skip、todo 或 cancelled。红快照的 `@g-group/*` 均指向红快照自己的 packages，未借用最终头的跨包实现。若干红用例因等不到预期 T8a 而超时失败，此事实保留在原始 TAP 中。

独立构造的 6 个故障全部由指定具名测试发现，原样副本 39/39，每个变异都完整执行 39 条，无 skip/todo/cancelled：

| 故障 | 结果 |
| --- | --- |
| 无审查时仍停 T5 | `delivery-t8a` 私聊状态断言失败 |
| 本人通过但不记 waived-by-user | 新领域用例失败 |
| 非提出者也能确认 | 新领域阴性用例失败 |
| 不核对无审查回包的轮次/commit/版本 | 过期回包用例失败 |
| F13 放行生产厂商 | **F13 自己按名字失败** |
| 不核对实际审查模型 | `review-actual` 的同厂商与 unknown 用例失败 |

因此 F13 将任务拷回 T5 是在隔离核对领域守卫，仍能发现被破坏的厂商判断；不能把它等同一次完整的宿主重审流程。`rewind.ts` 不列 T8a 为取消，与领域对 T8a Cancel 的空操作合同一致；本轮未发现该项更改造成的新缺陷。

## 独立执行结果

| 验证 | 观察结果 |
| --- | --- |
| 最终头根 typecheck / lint | 退出 0 / 0 |
| 最终头根 npm test | **1665/1665**，无跳过/取消 |
| 两份桌面 tsc / structure / build | 均退出 0 |
| renderer，全量，Chrome，worker 1 | **146/146** |
| Electron，全量，真实宿主 + 规则替身模型 | **20/20** |
| 常驻补齐原有行为变异 | 原样 21/21；**17/17** 被具名测试发现 |
| 跨厂商审查原有行为变异 | 原脚本退出 0，**24/24** KILLED，包含复核失败、重启、沉默不通过等 |
| 本轮独立 T8a / F13 / 实际模型变异 | **6/6**，每个完整 39 条 |
| 门禁阳性夹具 | 真实 CLI 非 local 模式 7/7，退出 0 |
| 本轮 8 个中性反例 | TRACE、REVIEW、RED、STUB、TAUTO、WORKFLOW、LAYER、PROVENANCE 均由相应目标门禁拒绝，退出 1 |
| 新打包库的只读检查脚本 | 退出 0；两次交付快照和 final.db 的独立 SQL 读回符合 T8a→T8；读前后 sha256 不变 |
| 旧打包库反例 | 退出 1；两份旧库四件任务因仍停 T5 按同一判据变红 |

17 个常驻补齐既有变异（含隔离、活动流和停止确认）全绿并不能覆盖 CORR-001 的换组时序，反例优先于总通过数。24 个既有审查变异脚本只保存了具名摘要；本轮独立 6 个变异另外保存了每次完整 TAP 与数量判据，不把未留存的既有逐项 TAP 说成已留存。

打包证据来自已存在的真实模型运行，本轮未重复调用模型：原记录 35/35 断言计数已重算；安装副本 `app.asar` 的 sha256 实测为 `5a027f008f3d6dfd311d8906060bae625241b2c8493ba890e6f2d0f11563a194`，与收据一致；独立 SQL 核对到两件任务在交付之后确有 requester 本人的“通过”消息。截图和模型行为成功率仍只对应既有那一次运行，不宣称本轮又跑了一次付费模型闭环。

## 必修/待闭合：测试与正式门禁，不能当成新的产品缺陷

1. **TEST-001：缺少 CORR-001 的时序回归。** 现有停止用例在采样之前就让孙进程 setsid，漏掉采样之后才换组的情形。需补测试并在修复前看到它因上述错误确认变红。
2. **整条 PR 的红记录不闭合。** 根收据仍指 `red.commit=4e7bc90b`。本轮真实 `--local --pr=75` 的 G-RED 未通过，包含红提交缺测试/测试体不一致，以及官方容器运行中未按名通过等多种原因。T8a 的 38 红/264 绿已经复现，不能替代整条叠栈分支统一的红记录问题。
3. **G-STUB、G-TAUTO 未通过。** G-STUB 报 `task.test.ts:635` 与 `:1982` 两条对错值变异仍绿；G-TAUTO 有 344 项报告，包含无法静态追踪 helper 返回值的服务测试。独立变异已证明若干被报测试确能检测行为错误，因此不能把 344 项误读为 344 个产品缺陷，也不能假装机械门禁已通过。需保留断言、补足真正的覆盖缺口，并按仓库现流程解决静态追踪/既存门禁问题；不能删测试、放宽断言、skip 或豁免冒充通过。
4. **资格与来源尚未闭合。** #75 的旧接手实现记录明确包含 Astra/Codex（OpenAI）。本轮对 Claude 所写 T8a/常驻切片是跨厂商检查，但本轮 OpenAI 审查不能替代旧 OpenAI 实现部分的异厂商放行。当前 live 审查会话的宿主 `turns.jsonl` 尚不存在，不伪造来源回执。初次云端输出 G-PROVENANCE 的 ✓ 是没有 review 时的早返回，不能作为来源验收通过。

最终头初次正式 CLI（8 门禁，退出 1）：TRACE、WORKFLOW、LAYER 通过；REVIEW、RED、STUB、TAUTO 失败；PROVENANCE 如上为空审查早返回。写入本轮 REJECT 后，另在本机真实会话目录上调用生产 `provenance.run(ctx)`，退出 1，明确报“审查会话不可信：会话记录不存在：codex:5c7730f7-9b5e-436b-bf34-f54611e16e15”；证据为 `local-provenance-after-review.log`。REVIEW 也应随 REJECT 继续阻止合并。

自检与环境原样保留：box2 完整 219 条中 218 过，R7-01 因其内层 PATH 丢失任务级 Docker wrapper 而遇到 Docker socket permission denied；随后使用仅对子进程生效的补充组权限，原样重跑 R7-01，1/1 通过。不能称为一次全量 219/219。box4 另有 registry DNS network is unreachable，使用已有官方镜像后又遇到 containerd overlay mount invalid argument，未改共享 daemon、socket 或用户组。完整门禁变异 sweep 未形成有效结果：原样对照失败时没有将其记为变异被杀。未用诊断环境的成功抹去这些失败。

## 证据、交付与边界

证据均在 `reviews/pr75-r1-evidence/`：`MANIFEST.json` 给出逐文件 sha256；六份 `*-evidence.tar.gz` 保存云端日志、命令/退出码、具名变异与中性门禁反例；`pgid-transition-probe.mjs` / `.log` 是真实缺陷复现；`snapshot-*.json` 与 `old-db-independent-red.json` 是只读库核验。本轮没有改实现、测试、既有红记录或作者验收字段，只写审查报告、审查证据和根收据的 review 块。

A4/A5 的真实模型证据仍在 da7fe313，最终头没有重跑真实模型停止/移出；不能写成已在最终打包界面验证。PR #59 仍是独立的下层 PR，本轮没有替它签审。此次 REJECT 交回作者修复 CORR-001、补回归并闭合相关门禁；不合并、不发布。

清理结果见 `reviews/pr75-r1-evidence/cloud-cleanup.json`；提交号、推送结果和远端回读另记在本轮工作目录 `deliverables/g-group-pr75-r1-codex/delivery-result.json`。只清本轮独立克隆与验证副本，保留用户现有安装包、截图、数据库和所有原失败证据。
