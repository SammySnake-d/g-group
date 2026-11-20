# ADR 0001: Preserve non-obvious code decisions outside source comments

## Status

Accepted for this cleanup slice.

## Decision

Source comments that explain behavior, compatibility, test boundaries, or operational constraints are recorded here while source comments are removed. The source location and original wording are retained so later maintainers can recover the rationale.

## Decision records moved

- `apps/desktop/e2e/a2ui.ui.spec.ts:4` — // #823:「a2ui 应该参考 mirasim 这种可以折叠的形式，而不是做成气泡，做成气泡如果选项很长就不好看了」
- `apps/desktop/e2e/a2ui.ui.spec.ts:67` — // 提问卡片展开:选中的打勾,其余不能再点
- `apps/desktop/e2e/app-shell.electron.spec.ts:9` — // 应用壳:没接入模型时整窗先请用户接入,填好后宿主用真模型脑子起来、界面连上;
- `apps/desktop/e2e/app-shell.electron.spec.ts:72` — // 用提示条上的按钮走:点「下载」后提示条不能消失,下载完同一条提示上出现「重启并安装」
- `apps/desktop/e2e/astryx.ui.spec.ts:27` — // 亮暗跟随我们自己的 dark 状态
- `apps/desktop/e2e/astryx.ui.spec.ts:87` — // 外观选项仍使用已验收的预览卡，不为迁移重做布局。
- `apps/desktop/e2e/astryx.ui.spec.ts:92` — // 设置是浮层；遵循现有关闭路径，不能穿透遮罩点导航。
- `apps/desktop/e2e/backend.electron.spec.ts:6` — // 真实路径(窄):Electron 主进程里起 dev/integration 的宿主服务(@g-group/server,SQLite + 联系人注意循环 + Compute),
- `apps/desktop/e2e/backend.electron.spec.ts:7` — // 渲染层只经 window.gg 按接口合同调用——建联系人 → 开私聊 → 派活 → 联系人回话 → Compute 进度 → 交付卡,
- `apps/desktop/e2e/backend.electron.spec.ts:8` — // 外加事件流推送、slash 内置命令、插件市场。联系人脑子和 Compute 用宿主自带的规则替身(不连模型)。
- `apps/desktop/e2e/backend.electron.spec.ts:47` — // 联系人回话、派出 Compute、Compute 跑完、联系人以普通消息交付(AC-56:交付是普通消息,不出专用卡)
- `apps/desktop/e2e/closed-loop.electron.spec.ts:7` — // 最小闭环(真实路径,只经界面):Electron 主进程里起宿主服务(GG_BACKEND=server,规则替身脑子 + 剧本 Compute),
- `apps/desktop/e2e/closed-loop.electron.spec.ts:11` — // 连上后端时界面只显示后端数据:演示联系人、演示群一个都不能出现。
- `apps/desktop/e2e/closed-loop.electron.spec.ts:81` — // 照设计:Compute 是联系人派出去的执行者——挂在联系人「接了任务」那句下面;这一行只写标题、谁在干(harness)、阶段,
- `apps/desktop/e2e/closed-loop.electron.spec.ts:86` — // 做完、交付之后(#1790 消息优先):Compute 那一行挂在联系人的交付消息下面,不再单独占一行
- `apps/desktop/e2e/compute.ui.spec.ts:4` — // #1005:Compute 是一个具体的 harness,要能「打开会话」看它和 Claude Code / Codex 的原始对话(只读)。
- `apps/desktop/e2e/compute.ui.spec.ts:180` — // 停下后记录里还标着在跑的那次测试显示成中断,不再转圈
- `apps/desktop/e2e/concept.ui.spec.ts:4` — // 概念版(#985「有时候就只是需要一个小点子」):每个点子一条用例,断言它在真实应用里生效。
- `apps/desktop/e2e/concept.ui.spec.ts:17` — // 第一次走远路(悬浮条「回复」):轻提示一次双击也能回复;第二次不再提示
- `apps/desktop/e2e/concept.ui.spec.ts:60` — // 群里三件等你的事:Codex 做完等验收(g6)、Argon 等你选(g12)、Argon 等你同意(g13p),按消息先后排
- `apps/desktop/e2e/concept.ui.spec.ts:121` — // 两件都回了 → 不再盯着你,眯眼笑
- `apps/desktop/e2e/console-baseline.ts:2` — // 这是现存壳层问题，不在组件试跑中修改安全策略。要求精确相同，不吞掉其他报错。
- `apps/desktop/e2e/cron.ui.spec.ts:146` — // 详情里看到的是同一个状态，从详情打开回来
- `apps/desktop/e2e/cron.ui.spec.ts:215` — // 本群（模型助手群聊）不混进「前端设计讨论」的定时
- `apps/desktop/e2e/files-context.ui.spec.ts:16` — // 三站:Astra 连发两条(说明 + 文件)并成一站「交付」→ 你「派活」→ Argon「已做」(g3 的交代 ref 指向 g3b)
- `apps/desktop/e2e/files-design.ui.spec.ts:14` — // 总览不再放第二个搜索框和类别筛选
- `apps/desktop/e2e/files-look.ui.spec.ts:4` — // 文件页前后对照截图:只导航、只拍,不依赖具体结构,改前改后用同一份跑。
- `apps/desktop/e2e/group-side.electron.spec.ts:8` — //   公告(AC-55)发布 / 改 / 撤下,顶栏公告条与各联系人「已装配 vN」;群设置改名、置顶、免打扰;群临时算力上限(U09);
- `apps/desktop/e2e/group-side.electron.spec.ts:9` — //   群清单(AC-47)新建任务、交给联系人认领;拍一拍;把成员拖出群(AC-49);定时页读后端(重启还在);解散群(U03)。
- `apps/desktop/e2e/layout.ui.spec.ts:4` — // #719:「我感觉他主面板太长了」「消息悬浮的菜单项……根本不贴着消息，漂移太严重」
- `apps/desktop/e2e/layout.ui.spec.ts:5` — // #1032(需求变更):「用户想要回复，肯定是先移动到需要回复的消息上……为什么不能做成更贴近消息体的，在消息上方的设计呢？这样不是移动路径更短吗？」
- `apps/desktop/e2e/layout.ui.spec.ts:123` — // 自己的消息右边缘在阅读栏内,不再贴到窗口最右
- `apps/desktop/e2e/member-stack.ui.spec.ts:4` — // #976:聊天头部右上角的成员头像组默认收拢,移上去(或键盘聚焦)才展开;悬停某个头像浮起并显示名字;点了打开群资料成员页。
- `apps/desktop/e2e/models.ui.spec.ts:4` — // 模型配置(需求 D07.4 规则 1/2/5/6、U93、U92;验收 R-17、AC-32、AC-51)。全部用真实点击、下拉选择、键盘输入驱动,断言用户看得到的结果。
- `apps/desktop/e2e/models.ui.spec.ts:5` — // 演示数据:Claude Code 说话 claude-opus-5-5、Compute 跟随说话模型、effort xhigh、Harness Claude Code,手上 3 个在跑的任务;
- `apps/desktop/e2e/models.ui.spec.ts:6` — // Argon 的 Compute 单独指定 claude-opus-5-5;Astra 在 Codex 上继承全局;全局默认 Compute 模型 claude-sonnet-5-5、effort high。
- `apps/desktop/e2e/models.ui.spec.ts:39` — // 单独指定:先带上当前生效的模型,不凭空换;再选 gpt-6.1
- `apps/desktop/e2e/models.ui.spec.ts:47` — // 再切回跟随说话模型,链又回到说话模型
- `apps/desktop/e2e/models.ui.spec.ts:68` — // 两条路:单独指定兼容模型(候选是 Claude Code 能跑的,默认保持原来的 claude-opus-5-5),或换成能跑 gpt-6 的 Codex
- `apps/desktop/e2e/models.ui.spec.ts:101` — // 修法是把 Compute 单独指定成兼容模型(默认保持原来的 claude-opus-5-5),说话照样用 gemini-flash
- `apps/desktop/e2e/models.ui.spec.ts:116` — // 在跑的任务仍显示启动时的快照,另注明下一轮起用新模型
- `apps/desktop/e2e/models.ui.spec.ts:171` — // 去 Astra 的工作台看:单独指定了原来的模型,Harness 没动
- `apps/desktop/e2e/models.ui.spec.ts:229` — // 设置页还开着;各联系人在用的模型已更新,固定在 claude-opus-5-5 的 Argon 没被改
- `apps/desktop/e2e/parity-compute.electron.spec.ts:12` — // F-STOP2(停止两步,停下后可继续)、F-FILES(文件区读真实文件、来处在正文右侧、点了回原消息)。
- `apps/desktop/e2e/parity-compute.electron.spec.ts:55` — // F-LIVE / F-NO-ACCEPT(#1790 消息优先):做完后 Compute 那一行挂在交付消息最下面,不再单独占一行;交付消息下没有验收按钮
- `apps/desktop/e2e/parity-compute.electron.spec.ts:67` — // 运行位置、harness、模型照原型写在头部
- `apps/desktop/e2e/parity-compute.electron.spec.ts:70` — // 「会话」页:联系人交给它的话 + 它自己报的每一步 + 结论,都来自后端;不再是「还没拿到 harness 记录」
- `apps/desktop/e2e/parity-compute.electron.spec.ts:139` — // F-FAIL3:另一条路照失败卡上真有的写(放弃这件写成卡上的原话「不重试了」;备用模型配了才有「换个模型」)
- `apps/desktop/e2e/parity-compute.electron.spec.ts:145` — // 你点的「重试」以你的名义记进会话(决定是共享上下文)
- `apps/desktop/e2e/parity-compute.electron.spec.ts:168` — // F-STOP2:确认它启动的程序都退出了才到「已停止」,注明算力已归还;按下去之后不再有停止按钮
- `apps/desktop/e2e/plugins.ui.spec.ts:38` — // 「消息」只出现在三张卡的简介里,按目录顺序
- `apps/desktop/e2e/plugins.ui.spec.ts:126` — // 详情页里看到的是同一个状态
- `apps/desktop/e2e/plugins.ui.spec.ts:245` — // 群里出修复卡(AC-35⑤),在卡上重新授权
- `apps/desktop/e2e/progress.ui.spec.ts:4` — // 进展全景看板(#806 四级 + 单击即跳;#872 / #877 照 mirasim「会话全景」;#998 带暗背景的弹出遮罩)。
- `apps/desktop/e2e/progress.ui.spec.ts:5` — // 对照 g-group-progress-panel 原型 README 的 20 项核对里能在桌面端成立的部分:悬停整条链、状态筛选、各类单击落点、
- `apps/desktop/e2e/shell-look.ui.spec.ts:4` — // #929 两条反馈的可量化断言:
- `apps/desktop/e2e/shell-look.ui.spec.ts:5` — //   ① 左侧导航和页面主题割裂 → 导航底色与聊天区底色的对比度必须很低(同一张纸),导航图标仍要看得清
- `apps/desktop/e2e/shell-look.ui.spec.ts:6` — //   ② 回到最新放在角落、观察成本高 → 必须在阅读栏水平居中、紧贴输入框上方
- `apps/desktop/e2e/shell.electron.spec.ts:5` — // 宿主(比如在 Electron 应用里跑的终端)可能带着 ELECTRON_RUN_AS_NODE,会让 Electron 退化成纯 Node,这里去掉
- `apps/desktop/e2e/walk.ui.spec.ts:5` — // 只从左侧导航、聊天头部、群资料页签这些用户看得到的入口进,不用 URL 直达中间状态。

## Scope

This ADR covers the decision comments removed from desktop end-to-end tests in this cleanup slice. Comments in frozen in-flight files, the gate self-test fixtures, and untouched vendor or generated files remain in the ratchet baseline.
