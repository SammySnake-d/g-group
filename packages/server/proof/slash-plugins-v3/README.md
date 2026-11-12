# P7 · 隔离插件命令与 /ketchup 后端子路径

基底：PR #71 `feat/chat-admin`，固定 c7d1a2dd3671c2a2289a5cd4b3b673a9f1bb9f29。不是直接对 integration 的独立合入包。
受测源码：29f1fd3c6bc592881b6f39d6cc2a493d50c77080；红：e0b539158a8ebc9ee66beb4e065490e531cbcc30。此后只追加证明与收据；out/source-freeze.json 的506份受测文件逐一与本地原字节匹配。

## 真实观察

box3，独占 `/dev/shm/gg-slash-resume-v3-20261112`，共享 `/workspace/.heavy.lock`，低并发；源码与runner固定至运行结束。

- 同一测试体红16（具名ERR_ASSERTION）→绿16。见 out/red-green.json、red.log、green.log。
- 18个预注册单点变异，每项由指定具名业务断言杀死，存活0。断言失败与普通异常/加载失败/超时的解析器实跑阴阳性也保留；普通异常不算杀死。见 out/mutations/。
- production.log：真实Host、createService、SQLite、插件安装与隔离RPC；只读状态不变，输出来源是完整 `#2 后端命令插件现在可以执行`，重启重放返回原seq3。重放测试还通过计数后委托原方法观察真实RPC：并发/顺序合计1次，重启重放0次。
- typecheck 0，lint 0；完整suite **1501/1501**，fail/cancelled/skipped/todo均0。见 out/result.json、full.log。

## 改了什么

`service messages.send` 的声明插件命令交给 `SlashCommands.send`，内置与未知命令维持原宿主路径。插件命令在独立进程执行，返回系统消息而不是普通用户消息，不唤醒联系人。已停用命令明确拒绝；命令名冲突在安装/更新时拒绝（包括内置、其他插件与停用保留名）。

只给有chat:read的插件本会话可见只读快照；区间 `(lastRead,toSeq]` 或显式from，消息附来源且按发言人分组，已隐藏/撤回/摘要自己不进入下一次摘要；超过200条明确截断，任务/待办不被消息裁剪吞掉。任务变化与待回答/授权/交付分类保留原任务卡状态。`command.args`为真实对象才可执行，非法参数不得落消息或执行账本。

同action并发只执行1次，参数冲突拒绝；rendered/done结果持久重放，failed/running无活动执行器时拒绝盲重跑，调用者可用新action明确再试。

## 历史负结果，未改判

首轮16/18：来源测试只搜#seq误中范围标题、重放只比消息seq漏掉重复RPC。第二轮18/18但typecheck退出2（unknown args与proof缺mind）。已加完整来源行/发言人/真实RPC计数、非法args真实红和对象校验后，从头跑当前v3。
外部归档原失败包：v1 SHA256 6f3a631a6b140b7a8210147830682989c6d3be328a2d70cdc16d45753e49ad70；v2 SHA256 619e00b3b1b6cfa089469281b5a50dc249d4cdc4f5a2dbb9099b9d9524429e0c。父接手证据包保留两次完整原始输出。

## 未覆盖的边界

这只是 U58/D11 P1 的后端路由与可确定性只读汇总。未改前端，未验证UI胶囊、可点跳转或用户实际拍板流程；不用LLM归并语义话题，也不含附件预览。R0 Pending规矩提议的独立模型尚未落地，本片不声称列全其数据；不是完整C-US25/AC-35通过。`tasks`是当前文档投影，不伪造不存在的历史事件，可靠完整时间线及其摘要归Q05/Q06。未知命令回原宿主行为不是接管所有斜杠。

生产proof显式使用scriptedMind，但不调用模型；它证明真实插件隔离/service/SQLite路径，不证明真实模型或CLI Compute闭环。没有独立审查、没有来源实核通过、没有合并或发布；review仍null。
