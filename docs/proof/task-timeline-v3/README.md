# Q05 v3: explicit real-source public-service observations

The actor fix is still exactly the v2 three-line host change. No production file, gate, fake, assertion, expected value or named test is changed relative to v2. V1/v2 source snapshots and their original eleven-test bytes remain preserved.

The supported macOS seatbelt gate actually passed G-RED/G-STUB on v2, but G-TAUTO rejected TT01/TT03/TT04/TT05/TT07/TT08: their source instance and responses were hidden from its local-variable data flow by the scene helper. This is a real gate failure, not explained away as Docker. In those six final tests, instantiate the real imported createService(host) explicitly and use that same actual service for the existing queries/actions. Every original behavioral assertion remains, with only the equivalent service reference substituted; no new dummy/import-only assertion or copied implementation is introduced.

Actual local results on the final test body: 13/13 green; typecheck/lint exit0. Same final thirteen bodies against the independent empty-stream red commit 49cd32c9896d72dd7156d0b9c1126630d9c6ac89 fail all thirteen by named ERR_ASSERTION, with zero skip/cancel/todo. This calibration is retrospective after implementation and after the actual v2 actor fix; it is not historical test-first work. The two new actor regressions were genuinely red on v1 before the three-line fix, as preserved in task-timeline-v2. The new calibration is retained by an ordinary content-neutral merge; the old witnesses are not overwritten.

The current original 24 mutation definitions/runner are unchanged. A v2 cloud run remains frozen and is not modified. A final v3 cloud run is still pending: do not promote v1/v2 full or mutations into a tested v3 result. Supported native seatbelt gate-only is next; independent cross-vendor review, host provenance, complete AC-02/CLI/real-model/frontend acceptance remain incomplete. No self-sign, waiver, merge or deploy.


## 2026-11-13 新v3组合实际云证明（已结束，不是继承v2）

box4共享heavy锁的queue676763/runner680935真实finished exit0，受测HEAD 3d92212ef4d698742c2daf221bd3f23effb75fae；归档 `cloud-results-3d92212e.tar.gz` 为138446 bytes，SHA256 `08a73907a6e2e1769006f4be9885a78664f4c5ddbedd638944cfc0dfd636d3f4`。云runner/source/config执行中冻结不改。

根独立核原始档47文件、全部15阶段log SHA、542个受测冻结文件SHA，以及24份完整13测TAP。两个真实actor回归在v1先具名ERR_ASSERTION红；最终同13空流回溯校准13红/0绿，候选13绿/0红，零skip/cancel/todo。24/24变异均完整执行13测且由预绑定具名ERR_ASSERTION杀死，附带失败逐项保留；依赖33/33、type/lint0、新组合full1499/1499。详见 cloud-parent-verification.json，不用旧v2数字充新结果。

受支持macOS原生seatbelt官方门禁在受测HEAD六机械项通过，总exit1只缺REVIEW；PROVENANCE在review=null时短路，不算来源实核。此后仅添加这些proof及更新receipt，生产/13测试/24变异与受测HEAD逐SHA全等；最终proof-only HEAD将只重hash/seatbelt gate-only，不重full或变异，原样输出随最终作者包提供。

原v1两actor真缺陷、v2真实TAUTO失败、旧Docker失败及回溯红的时间顺序声明全部保留。早先本页“pending”段是该历史版本的状态，不代表本节新结果未执行。未跨厂商签审、未实核宿主来源、未合入发布。完整AC-02、外部resume成功后DB故障的更强原子语义、真实模型/CLI/UI与摘要插件仍未验收。
