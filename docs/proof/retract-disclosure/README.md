# Q12 / AC-08 撤回披露候选：作者证据，不是全量验收

本次仅补齐受测源码 `80aa646bea7a9ae7b403af16e604192dca3a67f8` 的证明与本分支收据；产品、测试、变异和门禁代码冻结不改。受测内容 hash 是 `ae7af5bd8e0dda2cd389eae18d50c452f1bdd5f46bd25a3df46e75ec9105ed73`。base 是 PR #73 的 `c56dae7e3e3f564a4f5080712bfdde92081789d2`，整支 #71 `c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29` 已并入；不改这两条原分支。

## 变更与可观察结果

既有产品变更在 `appendUserEvent` 撤回分支中，按 `room + sourceSeq` 关联已完成台账，同一持久事务追加宿主 system 披露：指出受影响任务、Compute 与已完成结果；披露失败则撤回也回滚。没有副作用的闲聊不通知，跨房同序号不串源，通知不复制撤回原文。`runRound`、清洗实现及任务 T5 未改。

box4 已完成的同一次 run（queue 636890）原始证据收在 `cloud-out/`，不重新运行 full 或变异。相同 8 项在依赖-only red 上 4 通过 / 4 具名 ERR_ASSERTION 失败，在候选上 8/8 通过；12 个变异逐个完整运行 4 项、指定具名断言 kill（附带失败照实保留）。依赖回归 14/14、typecheck/lint exit0、full 1503/1503。原始 523 个受测文件在本次补证明前逐字节核对一致；原 ceaa3535 的 4 条测试一字未改。

最后两条测试是产品补丁后的扩展回放 red，不是历史 TDD 证明。Compute 是确定性替身，文件工件是真实持久事实；不是实模 / CLI / UI 验收。

## 门禁与范围

原 run 的 runner 整体 exit1。官方 `run-all.ts --local` 真实 exit1：TRACE / WORKFLOW / LAYER 绿，REVIEW 未签，RED / STUB / TAUTO 的具名 runtime 次数为 0。镜像可 inspect 不证明 Docker 可运行；没有通过削弱断言、改假 base、跳沙箱或豁免解决。G-PROVENANCE 在 `review=null` 时短路，不能称来源已实核。原始失败日志完整保留。后续 final-HEAD gate-only 及 Docker 错误以最终验证包的外置原始执行记录为准；这里不预告结果，也不改写旧 run。

完整 Q12 / AC-08 的未上报副作用、follow-up 来源链、R-Rule 及独立跨厂商审查仍缺证。收据维持 AC-08 未测、review=null、waiver=null。只有 draft 作者候选，不签验收、不合并、不发布。

入口为 `coverage-index.json`。本目录只记录旧受测源码的冻结值；新增证据提交的最终 HEAD 与 CONTENT_HASH 存在验证包外置 manifest，避免自引用。
