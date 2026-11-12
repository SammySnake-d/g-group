# Q02 / PR86 R1 作者返修校准（R2，尚未整体验收）

本片只增强测试、proof runner 和真实作者 host 元数据，不修生产代码，不修改门禁或审查报告，不触碰 replying/afterAt/UI/真实模型路径。基于 R1 审查提交 `c908939d3d66c0e5018951b6381f9e2b3892a55d` 的独立副本；原候选与 R1 REJECT 全部保留。测试标题仍为原四项，原断言不删除、不加 skip，不更换原 8 项故障定义。

## 按真实时间顺序形成的证据

1. 在任何测试增强前登记三项审查反例：`r1-counterexamples-plan.json`。原四项干净副本 4/4 绿；M09 同名串记忆、M10 不过滤 task_id、M11 不核对 qId **各自仍是完整 4/4 绿**。这是断言真实缺口，见 `original-counterexample-survival.json` 和 `original-*.tap`，不能用旧 8/8 校准掩盖。
2. 初次 M09 锚点匹配到两处，在 Node 测试进程启动前中止；用连同下一行 `const now` 的唯一锚点纠正后才实际运行。原错误及更正保留在 `mutation-anchor-executor-error-v1.json`，不将执行器错误计红/kill。
3. R1-01 保留头像/合法换 harness/重启/原存储字节不变；同名第二位有独立 persona，两人实际跑同一群的后续一轮。仅 owner 能 remember，群共享 room anchor，避免不同私聊把错误串读偶然筛掉。核第一位仍带自己的记忆，第二位完整 request 不带第一位 persona 或记忆，第二位存储仍空。身份/记忆块改按 `RoundBlock.block` 1/5 查找。
4. R1-02 原任务事件、字段、时间、顺序、limit 和未知 task 控制保留，再创建真实第二任务，核对不同 computeId 和第二任务独有 milestone。分别查询两任务且重启后都逐项相等；不能用参数回填的 taskId 自证隔离。
5. R1-03 原 T4b 无关插话不变/原题可答流程保留。在正确回答前，向真实 tasks.answer 传错 qId，必须 not_found、整任务视图和原卡不变、spawn=1/resume=0；随后正确 qId 仍能恢复原 Compute。
6. 最终增强测试在干净副本 **4/4 绿**，三项精确故障各运行完整四测、各 **3 pass / 1 指定具名 ERR_ASSERTION fail**；无其他失败，无 skip/cancel/todo。见 `final-narrow-calibration.json` 和 `final-*.tap`。本机没有跑原 8 或完整 11 项大变异，没有跑 full。
7. 将最终完全相同测试体放到原红祖先 `a9c0ffef997b5f364fb6b725031357b4dcf93d74` 的另一独立副本，提交新红 `121a145f55bc966df7df438a16621af2a397fd60` 后实际得到 **0 pass / 4 具名 ERR_ASSERTION fail**、零 skip/cancel/todo；测试文件 SHA 与当前绿逐字节相同。见 `samebody-red-result.json` 和 `samebody-red.tap`。

**红的性质**：这是既有实现上的回溯四故障变异校准，不是测试先于产品实现的历史证据，不倒填时序。新红以普通 merge 纳入候选祖先，不回滚正确生产树，不替换原红历史。

## runner 的最小增量

`packages/server/proof/coverage-invariants-mutations.mjs` 的原 M01–M08 定义字节保持，另加 FOLLOWUP M09–M11（预绑定测试 0/2/3），执行总数 11。SQL 故障保留绑定参数数目，不把 SQL binding/load/runtime 错误算具名断言 kill。

baseline 与每次 mutant 必须都运行 4 个完整测试，pass+fail=4、零 skip/cancel/todo、无超时；mutant 仅 exit1 且预绑定具名 ERR_ASSERTION 才算 kill，所有原始 TAP 与 collateral 仍保留。complete 要求 11 条完整记录全部 kill、无 survivor/error，原 Host 与测试文件均未改变。详见 `runner-delta.json`。实际新 runner 纯解析器 11 项阳阴性检查已过（真实窄 TAP + 缺计数/少测试/少名称/skip/cancel/todo/timeout/非断言等控制），见 `runner-parser-check.json`；**不是完整 11 变异运行结果**。

本机 Node v25.8.1；runner syntax、typecheck、lint 均 exit0，实际命令/日志 SHA 见 `local-static-checks.json`。154 个非测试/非 proof 的 packages/scripts/.githooks 文件分别与 `4efdee0b`、`c908939d` 原字节比较全等，见 `production-byte-comparison.json`。

## 作者来源、历史与未完成边界

- `author.session` 与 `contributingSessions` 统一为真实宿主 `codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`；旧 native 主/子线程仅保在 notes 和 `receipt-before-r2.json`，不伪造新来源。改正标识不等于 G-PROVENANCE 已通过；宿主在跑的 turn 与子线程工具来源仍须独立审查实核。
- 原 `review` 的 Claude R1 REJECT、原审查文件和旧证据完整保留；它评的是旧 hash，不把它清空或自签新候选。
- 原云四红四绿、8/8、full1477/1477 是 **R1 历史结果**，留在旧 docs 和 receipt.historicalVerification；不能继承给当前 R2。当前 R2 的完整 11 变异、full、正式门禁还待根冻结后排共享云锁执行。
- replying 真实生命周期仍缺；afterAt 未修/未测；真实模型/CLI、UI、完整 INVARIANTS/AC-43/AC-44 复合闭环均没有在本片验收。所有复合 AC 仍未测，waiver=null，独立 R2 审查与来源判定尚未通过。

## 冻结后复现命令（由根排云，不在本机追加 full/大变异）

```sh
node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit --test-reporter=tap packages/server/src/coverage-invariants.test.ts
MUT_OUT=/owned/output node packages/server/proof/coverage-invariants-mutations.mjs
node packages/server/proof/coverage-invariants-replying-gap.ts # 当前产品缺口仍预期 exit1
npm run -s typecheck
npm run -s lint
npm test --silent
node scripts/gates/run-all.ts --hash --branch=feat/coverage-invariants --base=origin/dev/integration
```

本片不 push、不派审、不自签；根接收冻结 bundle 后才继续云证明/正式 gate/正常推送与 Bot 协调。候选交付不代表 PR86 或全量需求完成。
