# T-186 收尾候选

- 基线 `22472dcbe19bc3a59331edc5833b3050e41b4b66`。上轮真实结果：renderer 146/146、root 1628/1628、两份 tsc 与 structure 通过；Electron 16/17，连续回复分组失败。旧 app-shell/merged-green.txt 对应 a55d941，不替代这轮结果。
- 红提交 `52dcb911`：File 路径返回“接口缺失”；window.capture 返回 ok:false；两条按名行为失败，见 red.txt。首次调用遇到云中继 UND_ERR_SOCKET，未进入测试，不计为红。
- 实现 `46abb343a2e7cc9b27cdf534f73310a7b3cd2429`：preload 使用 webUtils.getPathForFile；磁盘 File 走已有 attachments.add，内存 File/截图走 attachments.upload；window.capture 只截发起调用的应用主窗口，沿用来源与白名单校验；发送期间禁用截图按钮，失败保留真实错误。
- 分组根因：去重后上一句仍带引用，被 continuesPrev 拆组。相同引用现在不拆头像组；完成/待答回合、超过五分钟和不同作者仍沿用原判定。
- 作者验证：box3 两份 tsc、structure 通过；native/chat/shell 7/7 + 其他 Electron 12/12 = 19/19；受影响 renderer 49/49。未重跑已绿且无改动的后端全量与其余 renderer。
- 证据：green.txt、remaining-green.txt；baseline-* 为原轮日志；native-window-shot-sent.png、dm-quote-once.png 为当前真后端规则替身截图；compare-window-capture.png 左为原型 F-ATTACH、右为当前实现。规则替身不当作真实模型验收。
- 设计沿用纸墨柿与已有 IconButton；本轮按 product-not-report、frontend-logic-design、impeccable harden/craft-floor、emil-design-eng 校准，截图仍在输入栏一键操作，不引入开发流程界面。
- macOS 新包与真实模型验收以 packaged/ 下的收据为准。自动更新原有 0.1.0→0.1.1 本机通过记录继续保留，未声称重新运行。
- 独立审查待 Claude 与 hy4；作者验证不构成审查通过。未合并 dev/integration，未发布 Release。

## 真机暴露的第二处根因

- 46abb343 的 dmg 真机模型验收：私聊与群聊两个任务均 done、联系人交付与 hello.txt/group.txt 字节内容匹配；追加截图发送失败。失败运行保留在 deliverables/g-group-closed-loop/accept-packaged-46abb343，不整体标绿。
- 直接复现：attachments.upload 的 400042 字符请求被入口的 262144 上限拒绝，见 packaged-upload-red.txt。附件 schema 允许 35,000,000 字符 base64，与入口限额冲突。
- 红提交 a79d212a：新增具名方法限额正/负对照；默认入口拒绝合同范围内附件。对应 budget-red.txt。内存附件的实际 UI 回归同时加入 native-files.electron.spec.ts。
- 修复 52412af1：由主进程给 attachments.upload 单独配置来自 API 合同常量的限额；不由请求指定，不放宽普通方法、来源检查或纯 JSON 检查。超过附件专属限额仍拒绝。
- 最终包在旧真实任务状态上继续验收，只重复受影响的启动、重读、截图与文件发送；两次成功的模型工作保留原结果，不重新派活。

最终 52412af1：两份桌面 tsc/structure、根目录 typecheck/lint 通过；root 1630/1630。修改影响的 Electron native-files/shell 4/4（新增大附件一条），其余 Electron 的 46abb343 结果保留。两次真实模型任务与续验详细边界见 packaged/README.md。

推送前原版 .githooks/pre-push 将在同提交 box3 副本执行；仅本次 git -c core.hooksPath 指向临时转发钩子，共享 Git 配置不改，未使用 --no-verify。
