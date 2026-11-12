> 当前状态：R1独审已REJECT，审查提交6d812334保留；下文为R1作者历史快照，不代表当前review=null或R2成绩。R2变更和限制见[本轮说明](r2/README.md)。

# U07 联系人配置历史与回滚：作者候选证据

- 范围：`contacts.history` / `contacts.rollback`；每次 create/update/batch/rollback 追加配置版本；回滚生成新版本，不覆盖旧版本；版本CAS与幂等动作持久化；沿用当前模型预检和下一轮配置生效。
- `contactConfigOf` 只投影配置白名单，身份ID、createdAt、长期记忆、任务与运行状态不在回滚内容里。历史表 UPDATE/DELETE 触发器拒绝原位改写；升级仅记录已知当前基线，不伪造此前版本。
- 不改前端，不做导入导出，不改 G2 round 配置装配或 G4 pointers/回收，不触 C/C2。基线 `dev/integration 4efdee0be6d161060099b5ce488e3344c70305ee`。

## 本次实际运行

| 边界 | 对象/结果 |
|---|---|
| 原候选 | `/private/tmp/gg-req-contact-history-20261112` HEAD `badd24e5a6b4d4ae5a7601fb933d7c393ec54e12`；本次在独立副本续跑，原件未改 |
| 红提交 | `93e8cf922e4b4c7997691ed8ddc7262bd357b13e`；当前12项测试体与该提交逐字相同，先前空壳与早期红提交仍在历史中 |
| 绿 | 本机单文件12/12；box3 Node v24.21.0同一12项12/12，skip/cancel/todo为0 |
| 变异 | box3受测 `126c42aed03612883810f6379326b4620a8278b5`，原样12/12；预设15个单点变异15/15被指定CFG编号的具名ERR_ASSERTION杀死，存活/无效0，详见归档逐个TAP |
| 最终源码检查 | box3 `13774dd4c0e521d4102fe9f28821ce8cb00408f7` typecheck=0/lint=0；随后添加的仅本证据与收据 |
| 真实生产入口proof | `node packages/server/proof/contact-config-history-real.ts`，box3 exit0：创建→修改→回滚→重启重放→过期CAS拒绝。真实任务、md记忆/SQLite索引、消息日志与游标在回滚前后字节/结构相同；在途轮次仍OLD，更新后下一轮NEW，回滚后下一轮OLD |
| 全量 | 保留此前box3全量1485/1485、fail/cancel/skip/todo=0； `c8449f699ccb4dc72cc44e6dd652c9cc63b7162d` 的完整原始全量日志与result。生产源码逐项与当前相同；随后只有测试的直接服务入口写法校准及proof/runner新增，不把旧全量冒充最终测试文件版本全量。正常推送钩子另记录最终全量 |

production proof 使用真Host/SQLite/service/真实MemoryStore的md与索引，脑子使用确定性scripted替身以控制时序和remember动作。未调用真实模型，不代表模型判断质量、桌面UI、WebSocket用户验收已完成。

## 失败与修正不抹除

1. 继承云变异runner未显式指定TAP，原样进程exit0但解析total/pass为0，原runner正确拒绝评变异；这是执行器输出格式错误，不是测试绿或产品失败。修正为 `--test-reporter=tap`，并将工作区依赖明确链接到每个变异副本，防止绝对symlink返回绿色原树。
2. 本次首次云传输bundle仅公布HEAD而非分支名；fetch不存在分支退出128，尚未跑候选。续跑改fetch实际HEAD，失败日志保留。
3. 最初独立production proof漏传API必需clientActionId，创建断言失败；补完整输入后通过，未降低断言。

## 审查和验收边界

这是作者候选，不是独立审查。`review=null`，不得自签。G-PROVENANCE在无review时会短路；任何显示绿色都不等于来源已实核。当前接手宿主无兼容turns.jsonl，未伪造，须由Mira Bot安排独立跨厂商审查并真实核验来源。未合并dev/integration，未对外发布。
完整AC-01/AC-32需要的其他子项未在本片重验，收据保持未测；此处只交U07配置历史与回滚的限定证据，不把子项绿提升为整项产品验收通过。

## 归档校验与机械门禁

`cloud-proof.tar.gz` 125974 bytes，SHA256 `1949fdcbef83513761a210659f7c44380f80f68149c78f95440dbaa30953ccba`；37个普通成员，36项文件SHA全部核对。原全量、失败runner与当前15项变异逐个TAP均保留；旧baseline实际是Node的checkmark/spec输出，不是TAP，见 `runner-before-baseline.txt`。

本机 `run-all.ts --local --base 4efdee0... --branch feat/contact-config-history`：G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER通过；G-REVIEW失败：还没有独立审查。G-PROVENANCE因review=null短路，不是来源已实核。这次首次门禁在源码/测试/runner/proof冻结后、完整证据提交前运行，见 `mechanical-gates-before-evidence.txt`。最终hash也覆盖docs证据，不能在本文内嵌自引用；完整证据提交后重新跑出的门禁与hash写在 `reviews/contact-config-history-final-gates.txt`（不参与hash）。
