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

## Claude 意见与待拍板

采纳其升级操作层检查、窗口定义、全局数据属性闭包、访问器函数边、写法表、三类动态盲区与证据版本标注：这些提升现有判据的鉴别力，不改变产品行为。未采用 throwOnSideEffect：上一轮实测它也拒绝无对象写入的 Promise 事件，且依赖 V8 内部名单并会推动产品为测试而重构。

不自行采纳第 1.4 的“范围外只记线索、不算拒审理由”为验收政策：是否按建议 A 把操作白名单为主/动态为辅及反例处置写进验收 §9，仍需用户决定；本 PR 不改验收文件。建议 A 的技术检查先交审，政策由用户确认；B 维持现状保留既有裁量；C 改为人工签字降低机器保障，不建议。

纯空白插件 id 补具名测试和变异，仅保持已有行为，不升级为新合同。撤回内容仅 U+200B/U+0085 的规范化空文本边界继续“待厘清”，不改行为。Claude 对 classify 25 个机械存活项的逐项分类建议暂不纳入本次单条必修范围，仍如实披露未完成，不把候选线索称为产品缺陷或已关闭；建议由统筹独立安排分类。

## 执行结果与证据版本

运行结果在 r18-* 原始输出及本轮收据列明；每份日志记录运行提交及内容 hash。收据/证明更新后的 HEAD 与实际执行版本分开标注，不让旧日志看起来在最终 HEAD 上执行。G-PROVENANCE 云端无会话原始记录失败，G-REVIEW 保留第十七轮 reject；不得写成通过或擅自豁免。

## 本轮已观测阶段状态

原错 225/225 全绿且写入见证成立；红 233/233 具名失败；绿全仓 256/256，box4 Node 24.21.0，闭包对象 1722。第一次 lint 因旧候选注释放错位置失败，独立提交 5ee839c 只移动注释，断言不变；校验器补充参数值域、Symbol 短路保护和解析失败封闭。全量变异、容器门禁此时待运行，不能从本文推断已通过。
