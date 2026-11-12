# D09.2④：当前人工阻塞的一行摘要（后端子片）

## 改动与边界

RoomView 新增可选 nullable 的 `blockedSummary`，Host.roomView 从当前房间真实任务/有效 open 提问卡投影，不由模型生成：最早 #seq 的 T4b 问题、其余问题计数、折为单行并限制 500 个 JS 字符。回答生效后清除并经 room.updated 推送；读取不推进已读位置、不变更任务版本；其他房间和已回收为失败的旧阻塞不会串入。

本片不覆盖 UI 橙点/列表展示，不覆盖全部 T8a/R0 待确认摘要，不新增收件箱或授权动作。重启沿用现有失联 Compute -> T11_Failed 语义，不承诺失联执行器继续在线。G4 runRound/pointers、C/C2 发送 gate、前端均未修改。

## R1 历史冻结、红绿与云证明（以下数字不适用于 R2）

- base：4efdee0be6d161060099b5ce488e3344c70305ee（dev/integration）。
- 同一份测试的有效红：274e3be11e6b9d3c92c7ffc7898f601aca1e0c42。
- 正式云端源码 HEAD：1fc0e9197d7f4e4c98b89457a752176180d17613。后续仅增加证据、说明和收据；五个受测源码文件的 SHA-256 见 source-freeze.json / result.json。
- box3，Node v24.21.0，共享 flock /workspace/.heavy.lock 串行；本次独占可执行 RAM 工作区及 TMPDIR，持久日志来自 /workspace/req-room-summary-20261112-v5。
- 有效红 7/7：七条业务断言失败，无加载失败、夹具未就绪或超时冒充红。
- 原样绿 7/7；全量 1480/1480（fail/cancelled/skipped/todo 全 0）；typecheck 与 lint 退出 0。
- 正式变异 8/8：每项都完整执行七条测试，退出 1、ERR_ASSERTION，且被指定测试杀死。原样对照七条全部通过，存活项 0。
- 真实 Host、SQLite、service API 与事件推送；脑子和 Compute 为项目现有 scripted 替身，不声称真实模型或桌面用户验收。

## 复核原始证据

`cloud-proof.tar.gz` SHA-256：9319d2fa61a4b1e47e3ec766a004cf374dbb2bb67942aed41daf8d9fbaa38c4c。

解包后按 `archive-manifest.json` / 包内 proof-manifest.json 校验每个成员。包内含完整红/绿/全量 TAP、变异原样与八项故障日志、命令/退出码/时长/源码 SHA 收据、被传入云端的 source.bundle，以及前几次失败日志。三个外置 JSON 只是包内原始文件的逐字副本。

## 失败与修正，不抹掉失败

- 继承的变异执行器仓库根路径多退一级，git archive 退出 128；在本会话副本改为 ../../..，原候选未动。
- Node 24 暴露夹具提前判断空闲；改为同时等待 Compute.drained 与稳定 loop 空闲，全部业务断言保留。重启夹具补上 HostOptions 必需的既有 scriptedMind；缺卡判断改等价 optional chain，修正 typecheck / lint。
- API 测试显式 createService(s.host)，让 G-TAUTO 直接追踪真实被测入口；未复制实现、删除断言或降级检查。新有效红先提交，再恢复绿实现。
- 全局门禁自检首次缺 GATE_SANDBOX_IMAGE；sudo Docker 与现有 Node 镜像已验证可用，但之后控制器多次遇持久云盘 ENOSPC。包内保留相关日志，此项云端自检未被宣称通过，也不替换成推断的退出码。仓库正常 pre-push 钩子的独立结果另记。
- 收据 evidence 曾误填“路径加说明”，被 G-TRACE 按不存在路径拒绝；已改成仓库内 README.md 的单一路径，说明保留在该文档。失败日志保留在 reviews/room-pending-summary-mechanical-before-evidence-fix.txt，未放宽门禁。
- 仅清理本次创建、且 Git bundle 已保全的旧云端副本；共享镜像与其他任务未清理。

## 独立审查与来源现状

R1 的真实 REJECT 和审查提交 515db145 保留，review 对象不清空、不改成 approve；原 reviewed_hash 仍对应 R1。R2 是后续普通叠加的作者候选，尚未推送、未交独审，不合并、不发布，waiver=null。

作者宿主 codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7 的 turns.jsonl 现在存在；本轮实读 record.json 指向原生 01a1cfc8-db89-7400-b3de-876bd8478982。R2 在真实原生子线程 01a1d03a-add3-7a02-92d2-92e9791196ee（gpt-6.1-sol）完成，宿主身份未伪造。更早最初10个提交来自 codex:534f3614-21cd-43eb-9db6-3cd1673d2b62 / 原生01a1cf01-3b82-7211-b7b9-c7147d5e45e7，模型chatflows/gpt-6-astra；此链是R1审查人工核验结论，本轮不将它冒充门禁自动覆盖。没有补写宿主记录或改门禁。

## R2 作者返修（只报新实测）

- R1-05 首先在 515db145 后加具名失败并提交 b93f2e385edd4bc35e56c32ead5fcdb82106390f：原7项pass、新1项 ERR_ASSERTION；再只改截断，4f15f21da646f515841507556abcba0c3097d856 上同文件8/8通过，未后补冒充此顺序。
- 截断先给完整「另有 N 项」及省略号预留空间，总长<=500个UTF-16码元；正文结尾不留下孤立高代理。纯ASCII/中文499/500/501边界分别钉住。
- 宿主双联系人同群两个实际问题，取最早并计数，回答后换下一条；授权问题取真实授权请求action；读取用total_changes()和事件订阅防止幂等写入漏测。
- R1-04 三过滤逐项见 r2/guard-reachability.md：剩余open卡条件有独立实际反例；state与visible在当前稳定Host边界不可独立触发，按审查允许的另一条路线删去，不制造非法数据库快照来计kill。
- 新窄测17/17通过，无skip/todo/cancel；18项完整单文件变异runner已准备并静态确认注入点唯一，**本机未执行变异大扫，也未重跑full**。旧1480/8数字不签新版本。新full与18项变异交根排box4共享heavy锁后实测。
- 最终同体红校准若在扩展测试后补做，会另列为「补丁后校准」而不是历史TDD；真实首个R1-05红始终单列。
- AC-50及UI/实模验收保持未测。本片不新增前端、G4、C/C2、runRound或生命周期实现改动。
