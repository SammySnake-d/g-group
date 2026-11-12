# PR84 / U07 R2 作者返修（不是独立审查或全量验收）

冻结审查祖先 `6d8123341002f0e9f397c77633c3f30a6d01a54b`，base `dev/integration 4efdee0be6d161060099b5ce488e3344c70305ee`。原R1 REJECT、review对象及全部旧证明保留；不改门禁、Host、前端、#87或G/C/C2入口。

## R1-01至R1-04的实改与实际局部证明

- R1-01是真缺陷：只增加三行 `BEFORE INSERT ... WHEN EXISTS(contact_id, version)` 触发器，直接复用本仓库events表的覆盖写保护模式；不依赖`recursive_triggers`全局开关。`CFG13`在明确关闭递归触发器时断言INSERT OR REPLACE拒绝、原行字节/时间不变、对外history与rollback仍为原配置。真实首红`af3bf6f13756604e7ad8edd094f842658241b6f9`（13测，12绿/CFG13具名ERR_ASSERTION红），同体首绿`b2e8070daba2e207667641d83420e9e6eb772d07`（13/13）。更早`fcde7046`已真实Missing expected exception，但其下游工具夹具误把createContact不支持的tools输入当生效；原失败保留，通过真实updateContact设工具后重跑红，不弱化read断言。
- R1-02无产品改动：`CFG14`以真SQLite触发器令rollback历史写入失败；对外返回internal时联系人版本/整份配置、历史原行、幂等动作表和通知数都不变；去故障后同clientActionId重试只追加一个版本/通知，再重放不再写。
- R1-03无产品改动：`CFG15`通过真实service修改全部十字段，之后回滚逐字段核name/avatar/bio/speakingModel/harness/computeModel/tools/computeAssets/computeSlots/persona；同时核身份与createdAt不变和新历史kind/restoredFrom。工具、能力、槽位、简介、头像和两种模型/harness均为不同的真实前后值。
- R1-04无产品改动：`CFG16`直接查询SQLite原始`config`，逐行核精确十键白名单、嵌套Compute资产/模型键和两种中性秘密/记忆标记不落盘；create/update/batch/rollback/baseline五种真实路径均实际经过，6行。不是只核读API再次投影后的结果。
- 最终16同体回溯红`b92c857bc90f681cf8cdc2dff7ae6c39c99fe081`是将快照append设为空观察，16项全为具名ERR_ASSERTION；恢复绿`f73a2d278dfc8ce1ef112cc0664a304319601cb0`为16/16。这是实现后的校准，**不冒充16项历史TDD**；唯一新真bug先红再修是上面的CFG13。
- 本机局部16/16，typecheck/lint exit0。旧作者/审查的1485/15变异只属于旧R1，**不用于签本R2**。本R2新19变异/full/生产proof与正式seatbelt/正常push尚待执行，当前无完成结论。

## R1-05 来源与收据选择

收据author保留本轮真实宿主`codex:76d2c467-4626-4ff1-a5d3-54c5be6b3de7`、原生记录精确模型`gpt-6.1-sol`，因为本轮三行产品修复、四项新增测试/同体校准由根直接执行；并不把继承产品归给此宿主或finisher。原主体实现、测试及原始红0eb6ad3b/03d5e954、产品绿c8449f69、校准红93e8cf92和恢复badd24e5均来自原宿主`codex:534f3614-21cd-43eb-9db6-3cd1673d2b62`派出的`/root/implement_contact_history`，原生`01a1cf62-d34d-7050-b7b6-c9d738b02b9a`，模型精确`chatflows/gpt-6-astra`。

原续接宿主76d2c467的子代理`/root/contact_history_finish`，原生`01a1d035-2076-7443-bb9f-062b74f98187`，模型`gpt-6.1-sol`，从126c42ae起产出runner/proof/证据/receipt及正常push，不是主体产品作者。本轮同一助手只拥有R2变异runner增补；来源说明由现有`/root/loop_proof_finish`只读定位，根另核4个原生前缀SHA与13个匹配call_id的实际提交输出/改动路径。详见`r2-provenance-contributions.md/json`和`parent-provenance-verification.json`。

当前host76d2c467的turns.jsonl只有一条已结束旧轮次，不能证明本轮R2；旧host534当前record指针已切换，历史cf01绑定依历史turns，不靠当前指针倒推。模型字符串仅为现有原生记录内部一致性，不独立证明实际远端厂商、防篡改或完整最终来源。后续新提交不在只读定位冻结的第5646行内时明确为未覆盖，绝不伪造turns/改门禁。原review对象保留reject和旧hash，交Mira Bot安排独立R2及来源核验。

## 仍未验收及观察项

- AC-01/AC-32其余子项、真实模型/CLI/UI/WebSocket不在本片，未合入、未发布、不自签。
- 回滚无论模型字段变没变均重做当前模型预检；update仅补丁包含模型字段时预检，是当前保守策略，不为本轮改产品语义。空修改/回滚到当前也继续追加新版本。
- 下一轮生效/在途旧输入、真实md记忆/索引保留继续由production proof核验；不是新增全套npm test保护或模型质量证明。旧遗留缺tools的异常文档不在本轮合同内。
- shared pre-push已有管道可能吞npm退出；不能只信push exit，必须核完整full/selftest原文。此问题已另报Bot，不擅改门禁/hook。

原始TAP诊断有空白行尾；仓库以`.tap.gz`无损保存并逐原始字节SHA登记在`raw-tap-lossless-manifest.json`，未改写日志行，外部原始TAP仍保留。
