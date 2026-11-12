# Q05 v2：只修 TT-RO-01 / TT-RO-02 事实归因

## 对象与边界

v1 冻结候选为 `fbf62dedf42c2718095b77e67b3f0309907694c0`，PR base #77 为 `272b1b5d77bd95f34467a5aa04d0bf5891355887`。本 v2 在新的独立 Git 副本 `/private/tmp/gg-req-task-timeline-v2-resume-20261113` 开发，同逻辑分支 `feat/task-timeline`。原候选、原红副本、已运行的云 runner/config 均不改。两项有限只读校核报告的原件不覆盖，原字节副本见 [readonly-boundary-review.json](readonly-boundary-review.json)，SHA256 为 `a9e943881e65edff1cf01783892c499cc0c8900241fcdb357ddf715332733539`。本次为同厂商作者跟进，不是独立跨厂商审查。

## 两项真实问题与最小产品补丁

- **TT-RO-01**：联系人通过既有 `MindAction.stop` 取消自己任务时，默认 Cancel actor 推断把 contactId 标为 user。现仅在此联系人入口向 `stepTaskTx` 明确传入 `origin.actor={kind:contact,id:contactId}`；普通用户取消仍由原用户入口记 user。
- **TT-RO-02**：联系人自主发起、basisSeq=null 的自动重跑，既有运行账本正确记 contact/auto，新增任务时间线却被硬写为本机 user。现 `RerunCreate` / `RerunClaim` 均直接复用已经由 `planRerun` 判定并写入运行账本的 `plan.event.initiator`；手工 `runs.rerun` 仍记实际 user。不猜 ID、不新增来源规则、不改重跑协议。

产品代码仅 `packages/server/src/host.ts` 三行替换，完整差异见 [product-only.patch](product-only.patch)。无其他产品修改。

## 实际红绿与时间顺序

1. 先把真实公共 Host/service/SQLite 探针固化成独立文件 `packages/server/src/task-timeline-origin.test.ts` 的 TT12/TT13；原 `task-timeline.test.ts` 的11项文件完整字节不改。TT12 同时控制联系人 stop 与用户 cancel；TT13 同时控制 contact/auto 与 user/explicit 重跑，并对照真实 `gg_run_events`。
2. 在 v1 产品实现上、任何 v2 产品修改前，两项均以指定归因断言产生 `ERR_ASSERTION` 红，见 [two-regressions-v1-red.tap](two-regressions-v1-red.tap)，红提交 `f8fac8dd3712d8340a166ce0dcbf3603e1bf6090`。不是 unknown_method、模块/夹具错误或代码启动失败。
3. 最小补丁后同体2/2绿，再运行新2 + 原11共13/13绿，fail/skip/cancel/todo均0，见 [two-regressions-v2-green.tap](two-regressions-v2-green.tap) 与 [thirteen-v2-green.tap](thirteen-v2-green.tap)。产品绿提交 `56b95cde49a3e2b65d73bb42b505b947aebf90bc`。项目 typecheck 与 lint 均实际exit0。
4. 为最终同体13空桩校准，从既有空流红提交 `63c8c4e5d18f1dc76f76d63e3a8fb273e631cf21` 创建另独立新副本，仅加相同新2测试，得到 `3709debf59585bc2926754b3a2335da73f26ec20`；全部13具名断言 `ERR_ASSERTION` 红，见 [thirteen-empty-stream-red.tap](thirteen-empty-stream-red.tap) 与 receipt。该步骤发生在产品修复后，明确是**回溯校准**；不冒称13项全在产品补丁前编写。用普通 `ort` merge 保留该红祖先，合并树与之前产品绿树逐字节相同。

原11文件 SHA256：`505693df33a22b3825aba37a0de6f27d1c4683e626e1e52986ea10141c493a78`。新2文件 SHA256：`6038004818a068c69c0b1c9bcc044be17105d08a651d078a742d5795d9680bde`。真实2红、2绿、最终13空桩红/产品绿中的文件均相同，无弱化断言、skip或测试删除。

## 变异与下一次云输入

原22条变异定义语义与顺序完全保留，新增 M23→TT12（去掉联系人的明确 actor）与 M24→TT13（恢复错误的环境 user 来源），都是实现后登记，不是先于产品的计划。已验证24条所有编辑锚点唯一。每次完整运行两测试文件13项；`expected_total_tests=13`，`test_file` 单值改为 `test_files` 数组；变异 runner 只把单文件 argv 改为数组展开，指定判据必须具名 `ERR_ASSERTION`、完整计数、无skip/cancel/todo、collateral保存等判定均不改。

**本机未运行24变异或全量。** 由根在 Q08 既有队列之后另冻结 v2 combo 云run；v1旧11/22/full云结果不可当 v2验收。须同步新HEAD/bundle、最终红提交、两个测试路径、13项计数和24变异定义，不能复用旧11项配置或仅替换展示数字。

## 原始错误和仍未验收的边界

首次 clone 已带同名本地分支，`git checkout -b` 真实exit128，随后核对现有ref后改为 `git checkout` 成功。见 executor-error receipt，不计产品红。受控 Mind/Compute 仅控制动作方和信号，底层为真实 Host/service/SQLite；不是真模型、真CLI或前端验收。未自行push、发Bot、派审、签字、合并产品或部署。

v2 尚需云24变异/依赖回归/全量、正式沙箱门禁与跨厂商独审；既有 Docker overlay 运行层失败不得绕过。本片仍不代表完整 AC-02/R-02 验收，provenance未实核，review=null不能当通过。若后续出现第三项产品BUG，仅报告并另行授权，不在此补丁扩张。

最终源码/测试/变异输入提交 `a2603daea77d94f3974555f70fd4a6f9c1f697b7` 上再次实际运行13绿、项目typecheck/lint均exit0，见 [final-narrow-verification.json](final-narrow-verification.json)、[final-thirteen-green.tap](final-thirteen-green.tap)、[final-typecheck.log](final-typecheck.log)、[final-lint.log](final-lint.log)。随后只收进这些原始证明文件，不再改行为、测试或变异输入。
