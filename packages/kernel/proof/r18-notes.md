# 第十八轮返修说明（R17-A1）

## 合同、修改边界

合同仍是 origin/docs/dev-handbook《验收文档》§9 和《需求文档》§8.1 已定 17：内核只读判定插件交回值，拒收不处理、不改写对象、不装全局失败处理器；内置原型/方法预先被改写的环境不在合同内。没有修改合同、产品源码或审查放行规则。本轮只改测试、测试夹具、证明与收据。产品文件相对 6f43f25 字节不变；红提交复用旧空壳仅作按名失败对照，不冒称历史首次开发遵循 TDD。

## 同步观察的范围规则（不是对象名清单）

- 根：当前隔离 worker 的 globalThis 本身、插件交回值、插件定义对象。不是仅从“值为原生函数”的全局属性开始。上轮 r17-notes 的“原生构造器闭包”说法不能推导出本 realm 全部内置对象已覆盖，本轮更正。
- 边：Reflect.ownKeys 枚举每个对象的自有描述符（字符串与符号键）；数据属性沿 value，访问器仅沿 get/set 函数对象，不调用访问器；同时沿 [[Prototype]]。按对象身份去重到不动点，不用 JSON/Intl 名单参与发现。
- 停止：原始值、Proxy、原型链不能回到本 realm Object.prototype / Function.prototype 的外 realm 对象。无原型记录在 JS 中没有可判定的 realm 身份，按显式根可达记录收录，不声称能区分跨 realm 的 null-prototype 记录。最多 4096 对象，超出立即报错而非静默截断。
- 全局访问器背后的对象不读取：process、Buffer、performance、navigator、crypto 若只由访问器提供，就不会因为其名称而纳入；通过其它数据边是否可达以本次闭包为准，不对 Node 版本硬编码。函数闭包捕获值不是描述符边，不能沿它走。
- 窗口：真实 plugins.ts 的全部 Debugger 可停位置。每次停下与独立描述符基线比较值/旗标/get/set/原型/可扩展性。不冻结对象，不替换内置方法，不代理被测值。返回后快照只证明“已恢复”，不替代写入期间的观察。
- 写法标定：加后删（JSON、Intl.DateTimeFormat.prototype、Math、Intl.Collator.prototype、WebAssembly.Table.prototype，以及原有 Map/WeakMap）；已有值改回（赋值/defineProperty/Reflect.set）；旗标改回；原型换回；不可扩展性写入（不可逆，单列）。每项有/无异步事件，另有两侧无写入对照。真实拒收为 send/pull × own then/constructor × async_hooks 开关 8 组。
- 动态观察明确不覆盖：没有可停位置的原生操作；plugins.ts 以外的模块、eval/new Function 代码在两次停点之间写后恢复；Map/Set 内容、Date 内部值、符号注册表、私有字段、闭包状态等非属性状态；停止规则以外的对象。不能把动态全绿说成“任意对象无写入”的完备性证明。

## 操作白名单（与对象名无关的一层检查）

采用 Claude 第 1.3 a/b/c 的技术建议，新增 fixtures/rejection-operations.mjs，读取真实 plugins.ts 的 TypeScript AST。拒绝未知值/语句语法，而不是仅搜索几个危险 API 名字。不在产品里执行。

窗口固定为 isPlainPromise 及 isTracking/safeId、attemptOnce 中 p.send 返回赋给 pending 之后到立即拒收 return（含局部 unknown 闭包）、pull 中 p.pull 返回赋给 returned 之后到立即拒收 return。交回语句必须是 try 的唯一语句且无 finally，下一语句必须直接是 !isPlainPromise(...) 的拒收分支；不允许在它们之间塞操作。异常插件调用的 catch 属于未正常交回路径，不冒称本检查覆盖所有异常处理；后续普通 Promise 的 await 路径也不是拒收窗口。

白名单及理由：

| 操作 | 条件和只读依据 |
|---|---|
| types.isPromise / types.isProxy | 必须直接导入 node:util，先排除非 Promise 与 Proxy，品牌判定不调用插件 |
| Object.getPrototypeOf / hasOwn / isExtensible / getOwnPropertyDescriptor；Reflect.ownKeys | 在非 Proxy 上只读规范内部方法，不求值属性访问器、不写目标 |
| TRACKING.has | 固定私有 const Set 的只读成员判断；禁止取别名、泄露、add/delete 或重赋值 |
| isTracking / safeId / isPlainPromise | 同次 AST 检查递归校验其实际函数体；保护绑定唯一、不许同名遮蔽或别名 |
| unknown | 只构造局部普通结果；唯一放行的写是内核自有 ledger entry.state = delivery-unknown，不是插件/内置对象 |
| typeof、严格比较、短路逻辑、in、局部 const 描述符与 ownKeys for-of、普通结果字面量 | 值域限定为本地 x/k/d/v/reason/detail，读属性只允许 Promise.prototype、k.description、d.value；不许任意用户属性读取或隐式转换 |

不许 new/delete/赋值更新（账目例外）/标签模板/计算成员调用/别名调用/外部调用/默认参数求值/动态求值。内置 Object/Reflect/Promise/Set/undefined 禁止同名绑定。未知 AST 节点默认报错。源码窗口迁移或新操作需要审查白名单与说明，不能靠让检查忽略代码解决。

标定：7 个历史正例 R14-M1、R15 两类、R16 两类、R17 JSON/Intl；另 7 类 alias/computed/safeId/new Function/eval/同名 Object/交回后插入写。原样真实源码为阴性。此检查是当前有限语法和绑定规则的保证，不是任意 JS 或任意跨模块环境的完备纯度证明；发现检查漏窗或许可语法能写外部对象仍应返修。

## Claude 意见与已定验收口径

采纳其升级操作层检查、窗口定义、全局数据属性闭包、访问器函数边、写法表、三类动态盲区与证据版本标注：这些提升现有判据的鉴别力，不改变产品行为。未采用 throwOnSideEffect：上一轮实测它也拒绝无对象写入的 Promise 事件，且依赖 V8 内部名单并会推动产品为测试而重构。

用户已在 dm-ai-matrix#2531（2026-11-11 14:35）选 A，已回读 origin/docs/dev-handbook 437721d7207fb097f418522f31230ff678890d50《验收文档》§9：以操作白名单静态检查为主、有界同步观察为辅，窗口写死／操作封闭／有界观察三项齐备即算已标定。范围内漏检、静态规则允许可写语法、窗口漏代码、出现操作检查不覆盖的新写法仍属拒审理由；仅换范围外对象或同类 API 拼法而静态检查已打红，记为「边界外线索」，不拒审。本 PR 只引用已定条款，不修改验收文件。

纯空白插件 id 补具名测试和变异，仅保持已有行为，不升级为新合同。撤回内容仅 U+200B/U+0085 的规范化空文本边界继续“待厘清”，不改行为。classify 历史 25 条记录已逐条复核：因旧日志省略 AST 偏移、同一行有三个数值 0，覆盖了 27 个注入位置，每个跑现有具名测试和 119 个独立输入。按历史记录归并：4 条已被当前测试杀死、4 条等价或受剩余判定屏蔽、2 条只改变未约定的诊断措辞、15 条改变锚点/路由或抛错而现有测试仍绿。最后 15 条的具名回归本轮未补，不称已修；它们证明测试仍有有限性，不证明未变异产品有同样故障。逐项位置、反例与判定见 r18-classify-audit.json；语法错误/定位歧义的两次执行器失败保留在原始归档，不算有效测试。

## 执行结果与证据版本

运行结果在 r18-* 原始输出及本轮收据列明；每份日志记录运行提交及内容 hash。收据/证明更新后的 HEAD 与实际执行版本分开标注，不让旧日志看起来在最终 HEAD 上执行。G-PROVENANCE 云端无会话原始记录失败，G-REVIEW 保留第十七轮 reject；不得写成通过或擅自豁免。

## 本轮实际结果与证据版本

- 原错复现：基线 6f43f25，box4 Node24.21.0。clean、JSON、Intl 各 225/225；后两项独立扩充观察各 8/8 在同步停点看到写入且返回后恢复，阴性 8/8 无写入。
- 红 97b8afa：233/233 按名失败。绿 4c71508：全仓 256/256，内核 233；闭包 1722 个对象。产品 .ts 非测试文件相对 6f43f25 字节不变。
- 首次 lint 因旧候选的注释范围失败。5ee839c 移动注释后 lint 通过，却改变 G-RED 比较的函数文本；首轮门禁如实失败。421392f 改用已有的体外范围注释，全部 110 个 plugins 测试函数文本与红提交逐字相同；与变异执行版去注释 AST 完全相同。没有弱化断言、删测试或加 skip。
- 变异 fc216e6 / hash 7f03973c45271e535e0312caf999a784b010e1120f700444e3ce8799a77c0d8d，box4 Node24.21.0 并发 1：238/238 具名杀死，0 存活/超时；每项完整 233 条、0 skip/todo/cancelled。逐份 TAP 独立复核，计数差异 0。金丝雀约 5 秒超时终止，不计杀死。不是 Node22/25 上的全量变异结果。
- Node22.22.0 真实 Docker 全仓 256/256（box2，4432090 / 37b1168ecd93b43effbd8f1ea907d35cdaebb0f98440de1f960cb1c85d691c42）；Node24.21.0 修正版全仓 256/256、typecheck/lint 退出 0（box2，421392f / 6bea64690f4c96b544dd3e7d68f42813a3789bee1316b212471e02b201daae2d）。
- --local 在 box2 的 421392f / 6bea64690f4c96b544dd3e7d68f42813a3789bee1316b212471e02b201daae2d：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-PROVENANCE 因云端没有会话根目录失败，G-REVIEW 因旧 reject、同厂商和旧 hash 失败。不是“除 G-REVIEW 外全绿”。保留原 review、不改门禁、不造来源记录。
- 门禁自检 118/118、容器指定故障 5/5 在 4432090 / 37b1168ecd93b43effbd8f1ea907d35cdaebb0f98440de1f960cb1c85d691c42 上执行。Docker 经任务目录 bin/docker 转 sudo -n；未改 socket、用户组或守护进程，沙箱/测试容器均非 root。此后门禁代码未变。
- 421392f 之后仅写收据和证明文本，不把上述输出冒称最终收据提交的日志。仓库文本仅整理行尾空白；逐字原始输出保留于压缩归档。box4-final.tgz SHA-256=d29916d89d61eab93e3784636b50f8ddcf8349423334c75f112054e12666e972；box2-complete.tgz SHA-256=7cbed9bdb42b52f2897db7e04c4ee569dd9c3cd1dbe94bae6b8c80b6a156c99f。

## 三项判定与标定清单

1. 窗口写死：已做。isPlainPromise/isTracking/safeId、attemptOnce 的 p.send 正常交回到立即 non-promise-send（含 unknown）、pull 的 p.pull 正常交回到 invalid-batch；语句定位、唯一性、无 finally 以及辅助函数绑定都实际检查。异常插件抛出路径和接纳后的 await 路径不是本检查声明的拒收窗口。
2. 操作封闭：已做。真实源码 AST 阴性绿，历史七项正例均被静态规则判红；别名/计算调用/safeId 写入、eval/new Function、遮蔽、交回后插入写、Symbol 参数值域均有具名标定。未知语法默认拒绝，不声称这是任意 JavaScript 的纯度证明。
3. 有界观察：已做。根/边/停止处/上限/盲区见前文；保留有无异步事件的正反对照。加删属性由 R18-01/02/03/04/05 与 R17-02 发现；已有值赋值/defineProperty/Reflect.set 改回由 R17-01 发现；旗标、原型、可扩展性由 R18-06 标定、源代码故障由 R17-01 发现。不可扩展性不可恢复，单列而非伪称恢复。

自选目标是 Math、Intl.Collator.prototype、WebAssembly.Table.prototype，各有/无事件故障（K262–K267）均被对应 R18-03/04/05 杀死。审查 JSON/Intl（K258–K261）均由 R18-01/02 杀死。原形 hy4 B3/B4 在基线225条全绿，本轮 K283/K284 均仅由 R18-07 操作检查发现，说明动态停点的代码外盲区确实仍存在，而非宣称动态观察器已能看见它们。

## 终审意见逐项处置

- 1.1–1.3：采纳升级操作层、固定窗口与有界观察，三项证据如上。
- 1.4–1.5：用户已选 A（dm-ai-matrix#2531），回读 437721d 后直接引用，不再列为待拍板。仅范围外换对象且静态规则已打红的反例记“边界外线索”。
- 1.6：不走 throwOnSideEffect；误拒 Promise 事件、V8 内部名单不稳定、易迫使产品为测试改写，沿用上一轮实测结论，没有重跑或冒称新结论。
- 1.7–1.8：披露规则、1722 对象与实际耗时；复用已安装 TypeScript，G-TAUTO 已实跑通过，不是推测。
- 第2节：复现并关闭 R17-A1；JSON/Intl/纯空白 id 进入存活清单并分别补测/变异（纯空白 id 仅保持既有行为）。门禁日志逐份绑定提交/hash。U+200B/U+0085 继续待厘清，不改行为。
- 第3节：分类完25条历史记录，但15条行为型存活的具名回归未补，单列保留；既有 AC-06/08/11/12/35/39、R-06 未测边界不抹去，后补红不证明初次TDD。
- 第4节：B3/B4 原形复现并纳入 K283/K284；其它 classify 线索按逐项表归类，不把别人的未复现实验当结论。
- 第5节及14:40更正：本 PR policy 仍只有 codex/astra，dev/integration 已有 argon。后续正式跨厂商 APPROVE 的策略对齐或豁免仍需统筹/用户决定；本轮不擅改。
- 第6节：旧会话和旧审查目录只读；本轮仅清自己的 -t1 环境，清理收据另列。
