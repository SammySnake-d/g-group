# PR #6 内核插件契约：Codex 独立复现审查

**结论：reject。** 当前 PR 的独立检查和原有 14 个变异能复现，但这些绿色结果不能证明插件契约和分类合同成立：外部事件关键信息被丢弃；异步渠道可在失败时被报告为成功；发送副作用后超时再次调用可重复发送；注册后的可变元数据绕过校验；非法分类结果可抛异常；带 `@` 的控制指令被固定归为 `E1`。此外两个自行构造的变异逃过全部 51 条测试。本 PR 不应合并，应由作者返修后重新独立审查。

## 固定范围和身份

- 审查对象：`feat/kernel-plugins`，功能 HEAD `8df6b8fbef0ed58933853750e36cc158ebad0188`；基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；红提交 `043687723dd9483f1ce01f5e64a772b59d5e73e5`。
- 在普通独立 clone `/private/tmp/g-group-pr6-codex-7d29bd3e` 审查；红提交及变异各在独立副本中运行；不修改主审查副本产品源码或测试。Node `v25.8.1`，npm `11.11.0`。
- 审查人 `codex`，mirasim 会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 实际模型 `gpt-6.1-terra`（OpenAI）。作者会话中实际触及项目的模型均为 `claude-opus-5-5`（Anthropic），不是仅凭收据中的作者自报判断。
- 在审查 clone 仓库根目录实际执行：

  ```sh
  node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core
  ```

  标准输出原样为：

  ```text
  bfd2172771d30c4a5959a5bf6310afa7ffb11c9af3923bde3b292a17f3770845
  ```

- 本轮 `turns.jsonl` 尚未在运行中落盘，不能宣称本轮 `G-PROVENANCE` 已经核验通过，也不能伪造原始会话。原始收据 `review=null` 时本地门禁显示的 `G-PROVENANCE` 绿，是该检查提前跳过，不是审查来源验证。

## 独立复现结果

| 检查 | 实际结果 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 检查 21 文件 |
| 绿提交 `npm test` | 退出 0，51 通过、0 失败、0 跳过；其中 kernel 28 条 |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1，23 条旧测试通过、28 条新增具名测试失败、0 跳过；失败为调用空壳 `未实现`，不是文件加载失败 |
| 红绿测试名核对 | 绿提交 kernel 的 28 个测试名与红提交具名失败的 28 个测试名双向差集为空；三个测试文件在红绿提交间无差异 |
| 作者 `node packages/kernel/proof/mutations.mjs` | 原样 28 绿，脚本列出的 14 个变异均有原通过的具名测试变红；只证明这些特定变异被杀，不证明其他反例 |
| 本轮自造变异 M1、M2 | 在独立副本中运行；M1 后 51/51 绿，继续叠加 M2 后仍 51/51 绿；各自的违约输入见 F-06 |
| 原始收据上的 `node scripts/gates/run-all.ts --local --branch=feat/kernel-plugins --base=origin/feat/domain-core` | 退出 1，`G-REVIEW` 因无审查而红；`G-RED/G-STUB/G-TAUTO` 等机械项绿。`G-PROVENANCE` 因 `review=null` 未执行来源核验 |
| 写入 reject 收据后重跑同一门禁 | 退出 1；`G-REVIEW` 因 reject 必然拦截；`G-PROVENANCE` 报当前会话找不到对应 hash 调用、审查厂商认不出。运行时本轮尚未写入 `turns.jsonl`；会话落盘后是否满足该门禁仍须实测，不能提前宣称通过 |

第 1 次检出红提交时执行器把 checkout 放在了 `/private/tmp` 而非 clone 内，命令退出 128；已在独立红副本内纠正并完成上述复现，不将该执行器错误计为产品失败。

## 必须修复

### F-01 [P1 / AC-35] 外部事件契约和宿主盖章丢失版本、类型、时间与附件

位置：`packages/kernel/src/plugins.ts:7-13,28-34,77-78,91-95`。主稿 `docs/spec/需求文档.md` D04.1/D04.2 及 US12 明确要求数据源事件包含 `source_id/channel_id/native_msg_id/revision_id/event_type(create|edit|delete)/occurred_at/ingested_at/content/attachments`，供区间、迟到及编辑/撤回对账。

`RawExternalMessage` 只有 `nativeId/author/content`，`stamp` 强制仅复制这三个及宿主来源。因此插件即便传入文档要求的字段，也会被丢弃。本轮向同一源传入同一消息的 `revision_id=rev-1,event_type=create` 与 `revision_id=rev-2,event_type=delete`，其余内容相同；`pull` 返回两个**完全相同**的信封，时间、版本、事件类型及附件均消失。下游无法判定后者是撤回，也无法区分发生时间与入库时间。

**修复要求**：宿主契约保留并验证所需来源、版本、事件类型、双时间及附件引用；有 `create/edit/delete`、迟到及版本的真实契约反例，证明经过宿主后仍能区分并支持对账。这里要求阶段 I 合同正确，不要求本 PR 冒充阶段 II 的真实 Telegram E2E。

### F-02 [P1 / AC-35] 异步插件误报成功；副作用后异常不具备结果未知状态

位置：`plugins.ts:12,19,45-47,91-107`；主稿 D04.2、技术栈工程规则第 8 条要求外部投递区分 `B1/B2` 与 `DeliveryUnknown`。当前接口强制同步，但 `register(candidate: unknown)` 实际接受异步函数：

- `async pull() { return [] }` 可注册，`pull` 直接对 Promise 调 `.map`，抛 `TypeError: p.pull(...).map is not a function`。
- `async send() { throw new Error('远端超时') }` 可注册；宿主立刻返回 `ok:true`，`receipt` 是 Promise 而非 `SendReceipt`；该 Promise 实际拒绝后，第二次同一 `action_id` 仍返回 `ok:true, deduplicated:true` 并复用已拒绝的 Promise。
- 单独以同步模拟渠道“先产生外部副作用，再因响应超时抛错”：连续两次相同 `action_id` 调用都能进入插件，实际调用数为 2，因为 `sent.set` 仅在正常返回后执行。代码本身没有自动重试；问题是暴露的按 `action_id` 幂等入口不能安全处理调用方重试，也不能表明结果未知。

**修复要求**：契约明确支持并等待异步外部操作，或在这一片明确拒绝不支持的异步插件，不能把 Promise 当成功回执。对已 in-flight 后超时/异常表达 `DeliveryUnknown`，禁止无服务端幂等保证的 B2 盲重试；区分 B1 的相同 action/payload/TTL 与 B2，对失败后的重复调用、结果未知及实际回执做反例。不要把本地缓存或邮件 `Message-ID` 当作外部恰一次保证。

### F-03 [P1 / 契约完整性] 注册后修改对象能绕过来源、ID 和定时声明检查

位置：`plugins.ts:64-73,81-95`。`register` 只检查一次，然后原样保存调用者的对象和数组引用；TypeScript 的 `readonly` 不冻结调用者仍持有的可变对象。

独立探针注册 `{id:'a', sources:['g1']}` 后，调用方 `sources.push('g2')`、将 `id` 改为 `'b'` 并加 `cron`；随后 `pull('a','g2')` 返回 `ok:true`，再注册另一个 `id:'b'` 也成功，`list()` 出现两个 `b`。它们在此期间并未再次通过宿主注册校验。

**修复要求**：对身份、类型、来源/挂载点和受限声明建立不可被调用方后续篡改的宿主管理快照或等效约束，并对注册后突变添加真实行为测试；同时澄清可执行插件本身的隔离/加载约束，不能仅靠一段可变声明声称禁止插件定时或互相依赖。正常允许的插件实现更新须走明确的重新校验路径。

### F-04 [P1 / AC-12] 非法分类输出的违规记录自身可能抛错

位置：`packages/kernel/src/classify.ts:34,44-45`。`Classifier` 返回 `unknown`，超出枚举应归 `Uncertain` 并记录违规。但对循环对象，`JSON.stringify` 抛 `TypeError: Converting circular structure to JSON`；对 `1n` 抛 `TypeError: Do not know how to serialize a BigInt`。本轮直接调用均未得到 `Uncertain`。

**修复要求**：让任何非枚举值的诊断转换本身也有安全兜底，保持失败封闭并记录可识别违规；对循环对象、BigInt 及序列化异常添加测试。不能因已有普通对象/数字样本通过而声明所有非法输出受控。

### F-05 [P1 / AC-11、AC-35] 机械锚点被当作完整事件语义，控制指令无法由本入口正确分类

位置：`classify.ts:26-31,36-45`。本轮 `classifyInbound({text:'@小秘 停止定时总结', mentions:['xiaomi']}, () => 'E4')` 返回 `{event:'E1',via:'mechanical',cues:['mention']}`，分类器未调用。相同代码对任何带引用的消息都定为 E1；任何有限 `version` 都定为 E6，输入契约没有 E6 的 `target_id/decision` 或人类身份。

主稿 `docs/spec/需求文档.md:1476-1488` 定义 E3 修改、E4 停止/撤回、E5 纠偏和带目标/决定的 E6；D04.2 要求直接 `@` 下达停止/修改控制指令不能被职责锁阻断。`@/引用` 可机械提供路由锚点，并不凭自身判定“这不是 E3/E4/E5”。当前尚无注意循环，因此这里证明的是**导出分类结果与该控制输入不符**，不声称已实测整套系统死锁。

**修复要求**：分离机械锚点与真正可确定的事件/意图；为带 `@` 的停止、修改、纠偏、带引用的控制及确认卡身份/目标/版本增加端到端语义合同测试。必须保留 AC-11 对真正可机械判定线索不调用分类模型的要求，不能以直接绕过该条为修复。

### F-06 [P1 / R-05] 现有测试能被破坏性的独立变异骗过

位置：`plugins.test.ts:50-61,85-105`。以下均是对**隔离副本**的实验，不是声称原版已经出现这两个错误：

- **M1**：把源码的 `if (!p.sources.includes(sourceId))` 改为 `if (sourceId === 'g2' && !p.sources.includes(sourceId))`。全仓 51/51 仍绿；变异版注册只声明 `g1` 的源后，读取未声明 `g3` 实际返回 `ok:true`。现有负例只覆盖固定 `g2`。
- **M2**：在 M1 副本上再删除 outbound-channel 必须有 `send` 的注册检查。全仓仍 51/51 绿；变异版注册 `{kind:'outbound-channel',id:'x'}` 返回 `{ok:true}`。原版会正确拒绝无 `send`，这里的问题是测试无法证明这个合同。

**修复要求**：对三类契约各自的缺字段/错误类型做正负对照；未声明来源至少覆盖多个不同输入及注册后突变，正例也需保留。为这些关键行为增加真正能被相应坏变异击中的阳性埋雷和单开关阴性对照。作者脚本的 14 个预选变异全被杀，与这两个存活变异并不矛盾；当前收据将 R-05 整体写成“通过”缺少对这些合同的充分标定。

### F-07 [P1 / R-06] 本片尚无所要求的可验收纵向路径

位置：`receipts/feat-kernel-plugins.json` 的 slice 与验收条目；`docs/spec/验收文档-v0.1.md:40` 的 R-06。当前 PR 提交的是三个并列纯函数/内存原语，未展示从群消息入站经状态落盘到用户可见结果的一条可验收路径；四个 AC 整项也均注明未测。`G-TRACE` 的机械绿只证明收据格式及条目关联，不证明 R-06 的用户可观察纵向切片。

**修复要求**：按项目的 R-06 提供实际最小纵向路径及相应端到端证据，或将该未完成边界明确交回项目负责人处理，不能以纯函数全绿代替该规则通过。此项不要求把 AC-35 的阶段 II/III 真实渠道或市场提前冒充完成。

## 第 7 栏与验收边界

- `assemble` 的预算确实为渲染后 UTF-8 字节数，不是 token；超长消息整条进入或 `over-budget`，未实现 D06.3/4 的 token 预算、长文切片、分页游标与多引用公平分配。`assemble(log, opts)` 也不携带当前会话/权限上下文，不能由本片证明跨会话回读隔离；真实接入需验证。AC-06 整项保持未测是正确边界。
- 撤回消息在已测窗口/引用中不进入内容，窗口内引用不重复；正常短引用可按原文页入且清单有 seq 和字节数。这些局部行为不是整项或超长场景通过。
- 信封固定 `trust:'untrusted'` 是字段标记，不是已实现 R-10/AC-20 的宿主拦截。数据源元信息丢失是 F-01 新发现，不在原第 7 栏列明。
- `sent` 是 `createRegistry()` 中的内存 Map，进程或注册表重建后丢失；作者披露属实。另有同一进程中的异步误报及结果未知后重试问题，见 F-02，不能只用“重启后丢失”概括。
- 概念卡 v2 第 4、11 张明确“定时归联系人”，现有明文 `schedule/cron` 声明被拒与该方向一致；F-03 表明一次性校验不能证明对象后续不变。`G-LAYER` 只扫描仓库 `packages` 的已知包及 `.ts` 导入，不能证明任意仓库外第三方插件永不互相依赖。
- AC-11、AC-12、AC-35 整项未测的标记应保留；真实分类日志、状态机、专职锁、外部拦截、授权、Outbox 及阶段 II/III 均未由本 PR 验收。本次 reject 不代表整个后端目标完成：仍需返工、跨厂商复审，并继续实现直至文档需求、验收清单和用户故事实际通过。

## 审查探针复现

在审查过的 `8df6b8f` 仓库根目录、完成 `npm ci` 后运行以下只读探针；断言的是**已观察到的当前错误**，不是期望修复后的正确行为：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {createRegistry} from './packages/kernel/src/plugins.ts';
import {classifyInbound} from './packages/kernel/src/classify.ts';
const e = {nativeId:'m', author:'a', content:'x', occurred_at:'2026-11-05T00:00:00Z', ingested_at:'2026-11-05T00:01:00Z', attachments:[]};
const r = createRegistry();
r.register({kind:'data-source', id:'s', sources:['g1'], pull:()=>[
  {...e,revision_id:'1',event_type:'create'}, {...e,revision_id:'2',event_type:'delete'}]});
const pulled=r.pull('s','g1');
assert.equal(pulled.ok,true); assert.deepEqual(pulled.messages[0],pulled.messages[1]);
console.log('F-01：创建与撤回经宿主后无法区分');
const a=createRegistry(); a.register({kind:'data-source',id:'a',sources:['g1'],async pull(){return []}});
assert.throws(()=>a.pull('a','g1'),/map is not a function/);
const s=createRegistry(); s.register({kind:'outbound-channel',id:'s',async send(){throw Error('超时')}});
const first=s.send('s',{action_id:'act',payload:'x'}); assert.equal(first.ok,true);
await assert.rejects(first.receipt); const second=s.send('s',{action_id:'act',payload:'x'});
assert.equal(second.ok && second.deduplicated,true); assert.equal(second.receipt,first.receipt);
let n=0; const t=createRegistry(); t.register({kind:'outbound-channel',id:'t',send(){n++;throw Error('送达后超时')}});
for(let i=0;i<2;i++) assert.throws(()=>t.send('t',{action_id:'act',payload:'x'}));
assert.equal(n,2); console.log('F-02：异步误报成功；超时后重复发送');
const source={kind:'data-source',id:'old',sources:['g1'],pull:()=>[]};
const m=createRegistry(); m.register(source); source.sources.push('g2'); source.id='new'; source.cron='0 8 * * *';
assert.equal(m.pull('old','g2').ok,true);
assert.equal(m.register({kind:'ui-extension',id:'new',mounts:[]}).ok,true);
assert.deepEqual(m.list().map(x=>x.id),['new','new']); console.log('F-03：变更后绕过检查');
const cycle={}; cycle.self=cycle;
assert.throws(()=>classifyInbound({text:'x'},()=>cycle));
assert.throws(()=>classifyInbound({text:'x'},()=>1n)); console.log('F-04：非法输出抛异常');
const control=classifyInbound({text:'@小秘 停止定时总结',mentions:['xiaomi']},()=> 'E4');
assert.equal(control.event,'E1'); console.log('F-05：停止指令被归类为',control.event);
NODE
```

---

# 第二轮：返修版独立复审

**结论：reject。** 首轮多数具体反例得到修复，但返修版仍存在可重复发送的 B1 TTL 错误和插件更新绕过 B2 未知状态的问题；中文标点紧接 `@` 时停止指令仍被机械误分。新构造的两个变异仍可骗过全部测试。这些是对 `8964bfc` 实际运行的结果，不把原问题“一般样例已修复”等同于合同全部成立。

## 复审对象和证据

- 普通独立 clone `/private/tmp/g-group-pr6-codex-7d29bd3e`，HEAD `8964bfc875a0033a5912c2f1bfaa4cfccc74f1aa`；基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`；红提交 `c07656c8ffc482c20817ba073dbe7f873b01d870`。本次只追加本报告并填写收据的 `review`，不修改产品代码；故障注入在另一个独立副本。
- 审查人 `codex`，会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`；本轮原生 `turn_context` 模型 `gpt-6.1-terra`（OpenAI）。作者会话实际触及该项目的轮次模型均为 `claude-opus-5-5`（Anthropic）。本轮来源门禁仍需等当前会话落盘后实际核验，不能由厂商自报冒充门禁通过。
- 独立 clone 根目录运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，原样输出：

  ```text
  3d7e9f12193180ab59a9287d8477ea781a6ca952eb450551512742c013af2b44
  ```

| 验证 | 独立观察 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 检查 22 文件 |
| 绿提交 `npm test` | 退出 0；72 通过、0 失败、0 跳过（其中 kernel 49 条） |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1；23 条旧测试通过、49 条 kernel 具名测试失败、0 跳过。按测试名双向比较差集为空，红绿三份测试文件无差异 |
| 作者 `node packages/kernel/proof/mutations.mjs` | 原样 49 绿，输出的 45 个指定变异均由具名测试杀死，包括上一轮 M1/M2（K14/K15）；只证明这些变异 |
| 自造变异 R2-M1、R2-M2 | 第一个变异后，及叠加第二个变异后，类型检查均退出 0、全仓均 72/72 绿；违约行为见 RR-05 |
| 原始收据 `run-all.ts --local` | 退出 1，`G-REVIEW` 因尚无 review 而红；`G-RED/G-STUB/G-TAUTO` 等绿。`G-PROVENANCE` 在 `review=null` 时直接跳过，不是审查来源已验证 |
| 写入 reject 收据后重跑同一门禁 | 退出 1，`G-REVIEW` 因 reject 拦截；`G-PROVENANCE` 当前报未找到本次 hash 调用、审查厂商认不出。本轮运行中尚未落盘，会话完成后仍须复核 |

## 首轮问题逐项复测

- **F-01**：常规 create/delete 事件的 `sourceVersion/eventType`、源与宿主时间等可区分，宿主丢弃插件自报信任标志；先前“完全相同”的原反例不再重现。仍只能说所测字段和正负样例通过，不代表 AC-35 整项通过。
- **F-02**：普通异步成功要等待真实回执；B2 送达后抛错、同一注册状态下重复调用确实返回 `retry-refused` 且只调一次。**但 B1 TTL 和插件更新后的异常路径仍失败，见 RR-01、RR-02。**
- **F-03**：普通来源数组、ID/挂载点突变不改变宿主快照；更新走 `reregister` 校验。可执行函数仍以原对象为 `this`，代码隔离不在本片；更新时对旧投递状态的错误处理见 RR-02。
- **F-04**：循环对象、BigInt、`toJSON` 抛错等作为分类器返回值时已封闭为 `Uncertain`。但抛出的异常自身读取失败仍能逃出，见 RR-04。
- **F-05**：`@小秘 停止定时总结`（空格分开）会保留锚点并经分类器返回 E4；中文无空格标点反例仍失败，见 RR-03。
- **F-06**：上次两个变异已被 K14/K15 检出，但本轮两个新变异存活，见 RR-05。
- **F-07**：收据现将 R-06 标为未测，比冒充通过准确；当前仍未提供群消息入站→状态落盘→用户可见结果的真实纵向路径，不能说 R-06 或整个后端验收已通过。后续 app 接线是待完成工作，不是已完成证据。

## 必须修复

### RR-01 [P1 / AC-35] B1 的 TTL 逻辑在过期后仍重发，可造成重复外部副作用

位置：`packages/kernel/src/plugins.ts:86,96-105,113-119,163-174`，`packages/kernel/src/plugin-contract.ts:90-96`；需求文档 D04.2 的 B1 条件要求同一 action、相同载荷、**首次尝试仍在服务商幂等保留期内**，超期结果未知时禁止当作安全重发。

独立探针用宿主可注入时钟和**模拟**的 B1 接收端（按 action_id 去重，1,000 ms 后忘记旧键）复现：

1. 第一次返回真实回执并 `confirmed`；时钟推进 1,001 ms，再用完全相同 action_id 和 payload 调用。宿主第 170 行重新发送，模拟接收端因键已过期产生第二次副作用；结果分别为 `r1`、`r2`，两次均 `deduplicated:false`。
2. 第一次已产生副作用但回执丢失，宿主标 `delivery-unknown`；推进 1,001 ms 后再次调用，同一逻辑动作再被发送并产生第二次副作用。第 172–174 行对未知状态根本不检查首次尝试时间和服务商 TTL。

`packages/kernel/src/plugins.test.ts:357-375` 的测试甚至**要求**已确认 B1 过期后再次调用插件，K36 把“不再重发”的变异当作坏变异杀死；它的绿色与安全幂等要求相反。上述是确定性模拟，不宣称已对真实 Gmail/Resend 发送。

**修复要求**：已确认的同动作/载荷复用已知确认结果，不能因服务端缓存过期就重新产生副作用；对结果未知的 B1 保存首次尝试时间、对应服务商真实幂等保留期及载荷指纹，仅在保留期内允许安全重试，超期保持 `DeliveryUnknown` 并对账，不盲发。测试覆盖保留期前、恰到期、过期以及多次重试不能刷新首次时间；纠正当前反向断言和 K36。

### RR-02 [P1 / AC-35] `reregister` 可以把 B2 结果未知的动作改按新 B1 判断并重发

位置：`plugins.ts:96-105,130-137,157-174`。独立探针先注册 B2 渠道：它产生一次外部副作用后抛超时，宿主记录 `delivery-unknown`。然后用同一插件 ID `reregister` 一个新的、在自身服务端正确按 action_id 去重的 B1 渠道；更新返回 `{ok:true}`。再次调用同 action_id/载荷，宿主依据**当前** `p.idempotency` 而非旧动作所绑定的渠道版本/首次投递能力，进入 `deliver`；由于新服务端从未见过该动作，产生第二次副作用并返回 `confirmed`。

这不是把不守约的 B2 伪装成 B1：探针的新 B1 对自身重复 action_id 确实去重，只是无法知道旧 B2 已发出什么。更换插件或接收端不能 retroactively 将旧的不确定投递变成幂等投递。

**修复要求**：将每个在途/未知动作绑定到首次投递的插件版本、渠道身份、幂等能力及安全窗口；重注册或权限变更不得把旧 B2 未知结果转成可盲重发。需对 B2→B1、不同接收端、更新时 in-flight 等路径作真实调用计数测试，未知结果先对账或显式处理。

### RR-03 [P1 / AC-11、AC-35] 中文标点与 @ 紧接时，“纯点名”正则吞掉控制指令

位置：`packages/kernel/src/classify.ts:72-88`。`mentionOnly` 用 `e.text.replace(/@\S+/g, '')` 试图去掉 @ 名称。对于文本 `@小秘，停止定时总结` 和真实结构化 `mentions:['小秘']`，无空格的 `\S+` 将**整段文字**当作 @ 名称删除；实测返回 `intent:E1, via:mechanical`，分类器调用 0 次，而非交给分类器识别 E4。对中文自然输入这是现实可达路径；不是上一轮已测的带空格样例。

**修复要求**：基于结构化 mention 的确切范围/格式区分名字与后续正文；只有正文真正为空才走纯点名。增加中文逗号、冒号、无空格控制文字、多个 @ 和真正纯点名的正负对照，并保持机械锚点与语义分离，不要用宽泛正则丢失正文。

### RR-04 [P1 / AC-12] 分类器抛出无法读取 message 的 Error 时，兜底本身再次抛错

位置：`classify.ts:89-92`。尽管 `safeDescribe` 自身有保护，catch 分支在调用它之前先求值 `err instanceof Error ? err.message : err`。本轮将一个 `Error` 的 `message` 属性设置为读取时抛错，再让分类器抛出它；`classifyInbound` 实际抛出 `Error: message getter failed`，没有返回 `Uncertain` 和违规说明。异常对象可以来自外部分类器；此处只证明该输入的同步失败，不声称已产生下游系统故障。

**修复要求**：连 `instanceof` 和 `message` 的读取也放在不会逃出异常的安全兜底里；增补恶意 getter、异常对象本身不可转文字等测试，分类失败仍返回保守结果。

### RR-05 [P1 / R-05] 两个新的违约变异仍可骗过所有测试

对独立 clone 的 `plugins.ts` 注入，原始产品代码未改；每次类型检查 0，全部 72 条测试通过：

- **R2-M1**：将 `const payload = String(req.payload);` 改为 `const payload = String(req.payload).trim();`。先发载荷 `x`，再以相同 action_id 发 `x `：原版返回 `payload-mismatch`；变异版返回 `ok:true,deduplicated:true`，将不同原文错误当成同一动作。现有测试不覆盖有意义的空白差异。
- **R2-M2**：在 M1 副本上，删除 `typeof e.author !== 'string'` 的拒绝检查，返回信封时将 `e.author` 改为 `String(e.author)`。输入 `author:42` 时原版将该事件放入 `rejected`，变异版却接收成 `author:'42'`；全仓依然 72/72 绿。

**修复要求**：针对载荷字节级差异及每个必需外部事件字段的非法类型，添加独立反例和能杀死对应错误的双侧标定；复核收据 R-05 的“通过”是否与完整判据覆盖相符。以上是测试缺口，不把两种变异造成的行为说成原版已有缺陷。

## 原版实际错误的最小复现

在 `8964bfc` 的仓库根目录、`npm ci` 后运行；以下断言的是**当前错误现象**，不是修复后的期望：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {createRegistry} from './packages/kernel/src/plugins.ts';
import {classifyInbound} from './packages/kernel/src/classify.ts';
let t=100000, effects=0; const ttl=1000, seen=new Map();
const r=createRegistry({now:()=>t,receiptTtlMs:ttl});
r.register({kind:'outbound-channel',id:'b1',idempotency:'action-id',send:async q=>{
  const old=seen.get(q.action_id); if(old && t-old.at<ttl) return old.receipt;
  effects++; const receipt={action_id:q.action_id,receiptId:`r${effects}`};
  seen.set(q.action_id,{at:t,receipt}); return receipt;
}});
await r.send('b1',{action_id:'a',payload:'x'}); t+=ttl+1;
await r.send('b1',{action_id:'a',payload:'x'}); assert.equal(effects,2);
console.log('RR-01 已确认的 B1 TTL 过期后副作用次数:',effects);
let u=200000, n=0; const seen2=new Map(), x=createRegistry({now:()=>u,receiptTtlMs:ttl});
x.register({kind:'outbound-channel',id:'b1',idempotency:'action-id',send:async q=>{
  const old=seen2.get(q.action_id); if(old && u-old.at<ttl) return old.receipt;
  n++; const receipt={action_id:q.action_id,receiptId:`r${n}`}; seen2.set(q.action_id,{at:u,receipt});
  if(n===1) throw Error('已送达但回执丢失'); return receipt;
}});
assert.equal((await x.send('b1',{action_id:'a',payload:'x'})).state,'delivery-unknown');
u+=ttl+1; await x.send('b1',{action_id:'a',payload:'x'}); assert.equal(n,2);
console.log('RR-01 结果未知的 B1 TTL 过期后副作用次数:',n);
let sent=0; const z=createRegistry(), newProvider=new Map();
z.register({kind:'outbound-channel',id:'mail',idempotency:'none',send:async()=>{sent++;throw Error('已送达但回执丢失')}});
assert.equal((await z.send('mail',{action_id:'a',payload:'x'})).state,'delivery-unknown');
z.reregister({kind:'outbound-channel',id:'mail',idempotency:'action-id',send:async q=>{
  if(newProvider.has(q.action_id)) return newProvider.get(q.action_id);
  sent++; const receipt={action_id:q.action_id,receiptId:'new'}; newProvider.set(q.action_id,receipt); return receipt;
}});
await z.send('mail',{action_id:'a',payload:'x'}); assert.equal(sent,2);
console.log('RR-02 B2 未知后替换插件的副作用次数:',sent);
let calls=0; const event={sender:{kind:'user',id:'u'},text:'@小秘，停止定时总结',mentions:['小秘']};
const c=classifyInbound(event,()=>{calls++;return 'E4'}); assert.equal(c.intent,'E1'); assert.equal(calls,0);
console.log('RR-03 中文控制语句:',c.intent,'分类器调用:',calls);
const bad=new Error('original'); Object.defineProperty(bad,'message',{get(){throw Error('message getter failed')}});
assert.throws(()=>classifyInbound({sender:{kind:'user',id:'u'},text:'测试'},()=>{throw bad}),/message getter failed/);
console.log('RR-04 异常兜底再次抛出');
NODE
```

---

# 第三轮：返修与 AC-39 独立复审

**结论：reject。** 第二轮的常规反例已复现修复，但新装配器在压缩后无法处理旧消息的编辑和撤回，甚至可把撤回原文从压缩块送入模型；普通用户发言与固定提示词偶然重合会导致装配失败。第二轮声称绑定的发送渠道还可通过注册对象的可变接收端被绕过。两个新构造变异骗过全部 93 条测试。不能把这些结果表述成 AC-39 的前缀纪律子判据均已通过。

## 范围、身份和独立执行

- 审查普通独立 clone 的 `feat/kernel-plugins`，功能 HEAD `c829cb02cc32b29efe3f9cbfa4ab20b29bd0c1f9`；`origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；红提交 `ef9b953ccea20bea81bf2979cfb471b1f60b7f8a`。先前两轮报告原样保留；本轮只追加此节并填写收据 review。所有变异在独立副本执行。
- 审查会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 模型 `gpt-6.1-terra`（OpenAI）；作者会话实际触及项目的模型均为 `claude-opus-5-5`（Anthropic）。当前会话落盘后的来源门禁仍需实测。
- 自己在仓库根目录运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，原样输出：

  ```text
  0a540eede66e796fa689ce2a0f5ec9a8f7f8cecff6f6c516c5ef6cedb391b56e
  ```

| 检查 | 独立结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 绿提交均退出 0；lint 检查 22 文件 |
| 绿提交 `npm test` | 退出 0，93 通过、0 失败、0 跳过；其中 kernel 70 条 |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1，23 旧测试通过、70 个 kernel 测试按名字失败、0 跳过。红绿三份测试文件无差异，70 个名字双向差集为空；失败样本为真实调用空壳而非文件加载失败 |
| 作者变异脚本（Node 22.22.0） | 原样 70 绿，69 个列出的变异均有具名测试变红，命令退出 0；K51/K52 也被杀。仅证明这些指定变异 |
| 作者变异脚本（Node 25.8.1） | 常规测试 93 绿，但脚本完成 33 个变异后卡在 K08；我在 4 分 49 秒后终止自己的隔离进程，退出 143，未完成，不记为 69 个通过，见 R3-07 |
| 独立故障注入 R3-M1 / R3-M2 | 独立副本中的两个变异累积后类型检查均退出 0，且 93/93 测试仍绿；具体违约及原版对照见 R3-06 |
| 原始 `run-all.ts --local --branch=feat/kernel-plugins --base=origin/feat/domain-core` | 退出 1，只有 `G-REVIEW` 因无审查而红，其余机械门禁显示绿。`review=null` 时 `G-PROVENANCE` 提前跳过，不能当作实际来源已校验 |
| 写入 reject 后重跑 `--local` | 退出 1；`G-REVIEW` 因 reject 拦截；`G-PROVENANCE` 因本轮会话尚未落盘而未找到本次 hash 调用并报厂商认不出。会话完成后仍须复核，不能提前声明来源门禁通过 |

## 第二轮修复复测

- **RR-01**：已确认 B1 在保留期后复用回执、插件调用仍 1 次；未知 B1 在首次尝试后 999 ms 可重试、1,000 ms 恰到期及之后被拒，首次时间不随重试刷新。该固定渠道样例通过；不同接收端的隐式切换见 R3-03。
- **RR-02**：经 `reregister` 的 B2→B1 情况保留旧 B2 状态，第二次 `retry-refused`，调用 1 次。普通版本更新样例通过，但同一个已注册对象的可变 `this` 不经 `reregister` 也能换接收端，见 R3-03。
- **RR-03 / RR-04**：使用结构化范围的 `@小秘，停止定时总结` 返回 E4 且分类器调用 1 次；抛出 message getter 失败的 Error 返回 `Uncertain`。原错误样例通过。
- **RR-05**：作者脚本将上一轮 R2-M1/R2-M2 纳入 K51/K52。新增漏洞和存活变异见下文；R-06 仍为未测，未出现用户可见纵向路径。

## 必须修复

### R3-01 [P1 / AC-06、AC-08、AC-39] 撤回后压缩块仍可向模型暴露被撤回原文

位置：`packages/kernel/src/assemble.ts:82-84,88-101`；`docs/spec/验收文档-v0.1.md` 的 AC-06/AC-08 及需求文档 D06.3 明确撤回内容不能由缓存、派生摘要或回读重新暴露。

独立输入：用户 #1 是 `用户原来决定吃面`，#2 是普通消息；合法压缩块 `throughSeq:2` 的摘要里保留 #1 的原文。用户随后追加 `retract(target:1)`，且本次引用 #1。实测 `skipped=[{seq:1,reason:'retracted'}]`，但 `serialize(request)` 的压缩块**仍含 #1 原文**，装配还返回 `ok:true`。跳过 `page-in` 只检查单条投影，不能清除压缩块里已派生的数据。

**修复要求**：压缩结果须携带来源/版本或等价可验证依赖；当压缩范围内消息撤回、删除或需隐私修订时，在任何请求发出前机械失效并重建/安全隔离受影响块与缓存，不能只跳过引用。补足“压缩前包含撤回原文、撤回后完整序列化请求和缓存都不可见”的端到端负例。若摘要包含敏感信息但非逐字相同，还需处理派生关联，不能只做字符串替换。

### R3-02 [P1 / AC-39] 编辑事件被旧消息 seq 过滤掉，或原地改变已缓存前缀

位置：`assemble.ts:76-84,96-100`；领域日志 `packages/domain/src/log.ts:83-96`。`project(log)` 折叠 edit 到旧消息的原 seq，然后仅保留 `m.seq > throughSeq`：

- 未压缩时，编辑 #1 后它在原来的位置被替换，旧前缀哈希与新请求相应前缀不同；`assemble` 仍返回成功，没有给调用者任何失效提示。这不是正常“只追加一条新消息”。
- 已压缩到 #2 后，再追加编辑 #1 的事件 #3（“用户改为决定吃米饭”）；实测新旧请求体完全相同，既保留旧摘要“吃面”，也不包含新文字。若没有显式引用 #1，新编辑根本未进入上下文。

**修复要求**：用追加事件/版本游标与压缩依赖建模编辑后的可见状态，保证新修订不会被旧消息 seq 吞掉；针对可安全保留的历史只追加修订，必须重建的隐私/压缩块则显式通知缓存失效并更新块。增加压缩点前/后编辑、连续多轮及相邻前缀/最新版本对照，不要以纯追加新消息的 30 轮测试代表所有合法入站事件。撤回隐私优先于缓存命中，不得为了哈希稳定保留已撤回内容。

### R3-03 [P1 / AC-35] 注册后改变插件实例内部接收端，可绕开动作的渠道版本绑定

位置：`packages/kernel/src/plugins.ts:41-50,138-145,175-191`。宿主快照冻结了函数包装，但第 50 行仍执行 `send.call(c, r)`，其中 `c` 是调用方原对象。一个普通插件的 `send` 可读取自身可变 `this.endpoint`，此字段不在冻结快照内。

独立模拟：一个声明 B1、保留期 10 秒的插件初始 `endpoint='A'`；A 接收 action 后回执丢失，宿主记 `delivery-unknown`。调用方**不执行 reregister**，只把原实例 endpoint 改为 `B`；在期限内重试同一 action/载荷。A、B 各自都按 action_id 在自己的接收端去重，但 B 没见过 A 的请求，实际副作用依次为 `[A,B]`；宿主记录的 `channelVersion` 前后均为 1，最后误记 `confirmed`。这是模拟接收端的真实调用计数，不声称调用了真实邮件服务。

**修复要求**：首次动作绑定实际接收端/渠道实例的不可变标识、版本及能力，并在每次尝试前验证；插件调用不应通过保留可变配置的外部 `this` 绕开宿主版本，更新配置必须走受控版本变更并对未知动作拒绝盲重试。补“实例原配置字段突变但不 reregister”和在途突变的正负测试。若无法在当前插件模型验证接收端，需保守阻止未知结果重试，不能宣称已绑定。

### R3-04 [P1 / AC-39] 普通消息与固定提示词重合即触发误拦

位置：`assemble.ts:49-65,76-81`。固定 system 文本 `你是群聊助手，请帮助用户解决问题。` 本身不变；空日志可成功装配。用户随后合法发 `帮助用户`，由于它是固定文本中的 4 字子串，`volatileIn` 立即返回 `消息 #1 原文`，整次装配 `volatile-in-stable`。这里并没有把新消息注入 stable；单靠内容碰撞无法判断生成来源。这样任意常见措辞重合都可能中断聊天，且早前空日志成功与新消息失败构成单开关证据。

**修复要求**：以明确的输入来源、不可变模板版本/结构化字段及相邻请求实际前缀变化判断是否把会变内容注入 stable，而不是把正常重复字串当作注入；在不削弱真实动态注入拦截的同时，新增固定提示词与用户自然复述重合的阴性测试。

### R3-05 [P1 / AC-39] 输入既不保证固定段顺序，也不验证压缩点在有效日志范围

位置：`assemble.ts:76-84,96-99`。D22 明确前缀为 system→工具→人设/规则→历史。将 `stable` 按 `[persona,system,tools]` 传入时实测返回 `ok:true`，输出顺序仍为 `persona,system,tools`。此外，仅有两条消息时传入 `throughSeq:999` 也返回成功、清单为空，原两条均未进入历史，导致把未压缩的新消息错误视作已压缩。调用方传压缩块不等于允许宿主无条件接受一个未来位置。

**修复要求**：明确可选/重复稳定段契约并机械保证固定顺序，拒绝或规范化非法顺序；验证压缩水位与可信日志快照和压缩内容/版本关联，未来或无效水位显式失败而非静默吞消息。补倒序、缺失/重复段以及负数、非整数、未来压缩点的单开关测试。

### R3-06 [P1 / R-05] 原版测试不能证明 helper 历史和会变状态的内容完整

以下均为**隔离副本**故障注入，不是声称原版已经丢失 helper 或 volatile：

- **R3-M1**：在 history 过滤条件增加 `m.sender.kind !== 'helper'`。类型检查通过、93/93 测试绿；独立输入一条合法 helper 消息“重要工具结果”，变异版 `ok:true` 但内容与清单都没有该消息。原版同输入内容可见、清单有 #1。
- **R3-M2**：在 M1 副本上，把 tail 内容中的 `${opts.volatile}` 换成固定字串 `无`。类型检查通过、仍 93/93 绿；会变状态“必须停止发送”在变异版消失，原版则完整出现。现有测试多检查段位置/自洽字节数，没有断言实际载荷。

**修复要求**：对 user/contact/helper 等合法发言者、非空会变状态及其原文字节做完整内容断言，加入对应的可执行坏变异和单开关对照；当前收据 R-05 写“通过”不足以说明新 AC-39 相关判据已标定完备。

### R3-07 [P1 / R-05] 作者变异脚本在受支持的 Node 25 下卡住且无超时

位置：`packages/kernel/proof/mutations.mjs` 的 `run()` 使用 `spawnSync`，没有进程或测试超时。绿提交自身在 Node `v25.8.1` 的常规 93 条测试通过；独立运行同一版本的作者变异脚本时，前 33 个变异有结果，进入 K08 后其 Node 测试子进程持续等待超过 4 分钟 49 秒、无后续结果。我另行直接运行该 K08 的 `classify.test.ts`，能看到多条具名断言失败，但测试进程同样不退出。为避免留下本次隔离进程，已终止本次自启进程；原脚本退出 143，不把这次中断记为 69 个通过。

**修复要求**：为每个隔离变异设置有界超时并回收测试子进程，逐项输出完成或超时状态；超时/未完成不能自动冒充已杀变异，仍须有具名断言失败证据或明确将校准标为未完成。补一个会卡住的变异验证脚本能有界退出；不应仅依赖全局 CI 长超时。Node 22.22.0 同一脚本本轮实测 69 个变异均杀、退出 0；这不消除 Node 25.8.1 卡住和缺超时的问题。

## 原版反例可执行复现

在 `c829cb0` 的仓库根目录 `npm ci` 后执行。断言固定的是本轮**观察到的错误**，并非修复后的期望；插件仅是本机模拟，不访问外网：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {append,emptyLog} from './packages/domain/src/log.ts';
import {assemble,serialize,prefixHash,prefixLength} from './packages/kernel/src/assemble.ts';
import {createRegistry} from './packages/kernel/src/plugins.ts';
const u={kind:'user',id:'u'},at='2026-11-05T00:00:00Z';
const stable=[{kind:'system',text:'你是群聊助手，请帮助用户解决问题。'},{kind:'tools',text:'查询历史'},{kind:'persona',text:'回答清晰。'}];
const opts=x=>({stable,quotes:[],budgetBytes:100000,...x});
let log=append(emptyLog(),u,{kind:'message',text:'用户原来决定吃面'},at);
log=append(log,u,{kind:'message',text:'普通记录'},at);
const edited=append(log,u,{kind:'edit',target:1,text:'用户改为决定吃米饭'},at);
const x=assemble(log,opts()),y=assemble(edited,opts());
assert.notEqual(prefixHash(y.request,prefixLength(x.request)),prefixHash(x.request));
const compressed={throughSeq:2,text:'用户原来决定吃面；普通记录'};
const before=assemble(log,opts({compressed})),after=assemble(edited,opts({compressed}));
assert.equal(serialize(before.request),serialize(after.request)); assert.equal(serialize(after.request).includes('用户改为决定吃米饭'),false);
const revoked=append(log,u,{kind:'retract',target:1},at), bad=assemble(revoked,opts({compressed,quotes:[1]}));
assert.equal(bad.skipped[0].reason,'retracted'); assert.equal(serialize(bad.request).includes('用户原来决定吃面'),true);
console.log('R3-01/02：压缩后撤回原文仍在，编辑不进入请求；未压缩编辑改写前缀');
const common=append(emptyLog(),u,{kind:'message',text:'帮助用户'},at);
assert.equal(assemble(emptyLog(),opts()).ok,true); assert.equal(assemble(common,opts()).reason,'volatile-in-stable');
const reversed=assemble(log,opts({stable:[stable[2],stable[0],stable[1]]}));
assert.deepEqual(reversed.request.segments.filter(s=>s.section==='stable').map(s=>s.label),['persona','system','tools']);
const future=assemble(log,opts({compressed:{throughSeq:999,text:'先前摘要'}})); assert.deepEqual(future.manifest,[]);
console.log('R3-04/05：固定提示词重合误拦；倒序及未来压缩点被接受');
let t=100000; const effects=[],caches={A:new Map(),B:new Map()};
const plugin={kind:'outbound-channel',id:'mail',idempotency:'action-id',idempotencyWindowMs:10000,endpoint:'A',async send(q){
 const cache=caches[this.endpoint]; if(cache.has(q.action_id)) return cache.get(q.action_id);
 effects.push(this.endpoint); const receipt={action_id:q.action_id,receiptId:'provider-'+this.endpoint}; cache.set(q.action_id,receipt);
 if(this.endpoint==='A') throw Error('A 已接收但回执丢失'); return receipt;
}};
const r=createRegistry({now:()=>t}); r.register(plugin); const req={action_id:'a',payload:'x'};
assert.equal((await r.send('mail',req)).state,'delivery-unknown'); const v1=r.delivery('mail','a').binding.channelVersion;
plugin.endpoint='B';t+=1000;await r.send('mail',req);
assert.deepEqual(effects,['A','B']); assert.equal(r.delivery('mail','a').binding.channelVersion,v1);
console.log('R3-03：不重注册换接收端，重复副作用:',effects.join(','));
NODE
```

---

# 第四轮：返修独立复审

**结论：reject。** 第三轮的常规样例及变异运行器已有可复现修复，但本版仍可将撤回内容重新送入请求，`recompress` 回调还可篡改被引用消息；冻结的 `Map` 或共享原型仍能让同一动作切换接收端，B1 墙钟回拨与账本键冲突也会破坏幂等。两个自行构造的坏变异骗过全部 112 条测试。这些均是对 `c0dd021` 的实际执行，不将模拟渠道当作真实邮件 E2E。

## 复审范围和执行结果

- 独立普通 clone 的功能 HEAD `c0dd0217b8eaee35008771796c97914248badd0c`；基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`；红提交 `5fed9eb63b1c70c54d19e9c60756c7ec704ac78d`。先前三轮报告字节原样保留；本次只追加本节并更新收据 `review`，变异在独立副本。
- 审查人 `codex`、会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`；本轮原生 `turn_context` 模型 `gpt-6.1-terra`（OpenAI）。作者会话中实际触及项目的轮次模型为 `claude-opus-5-5`（Anthropic）；本轮来源门禁需会话落盘后实际核验。
- 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，标准输出原样为：

  ```text
  e3e8a92e41c85048fd538cc0b9d31be5b9d9d0ac9a20f0b90dca39fba5b63f95
  ```

| 检查 | 实际结果 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 全部退出 0，lint 检查 22 文件 |
| 绿提交 `npm test` | 退出 0，112 通过、0 失败、0 跳过，其中 kernel 89 条 |
| 红提交 `npm ci`、`npm test` | 安装退出 0，测试退出 1：23 条旧测试通过、89 条内核测试逐名失败、0 跳过；红绿三份测试文件无差异，失败名与当前测试名双向差集为空 |
| 作者变异脚本，Node `v22.22.0` / `v25.8.1` | 两次独立顺序运行均退出 0；各自原样 89 绿、87 个变异被具名测试杀死、0 存活、0 超时。K86/K87 均被杀 |
| `--canary-hang`，Node 22 / 25 | 两次以 `KERNEL_MUT_TIMEOUT_MS=5000` 执行均约 5 秒结束、退出 0；脚本明确将金丝雀超时记为超时、不计变异杀死 |
| 自造变异 R4-M1 / R4-M2 | 在隔离副本先后注入；每次类型检查退出 0、全仓 112/112 测试仍绿；原版对照及反例见 R4-07 |
| 原始 `run-all.ts --local --branch=feat/kernel-plugins --base=origin/feat/domain-core` | 退出 1，`G-REVIEW` 因尚无 review 而红，其余机械门禁显示绿；`review=null` 时 `G-PROVENANCE` 提前跳过，不是来源已验证 |
| 写入 reject 后重跑同一 `--local` | 退出 1；`G-REVIEW` 因 reject 拦截；`G-PROVENANCE` 当前找不到本次 hash 调用且不能确认审查厂商。本轮会话尚未落盘，完成后仍须实测该门禁 |

## 第三轮问题复测

- **R3-01 / R3-02**：旧压缩块在撤回后返回 `recompress-required`，普通重建只收到可见消息；未压缩消息的编辑追加为新事件且正常样例前缀不变。新的短文本与可变回调反例仍失败，见 R4-01。
- **R3-03**：直接修改原插件对象的 `endpoint` 不再改变宿主账本绑定；但 `Map` 内部槽及共享原型仍可改变真实目的地，见 R4-02。标准私有字段类插件兼容性见 R4-03。
- **R3-04 / R3-05**：用户复述已有提示词的普通样例不误拦；倒序 stable 和未来压缩点被拒。静态规则中出现“新消息”仍有误拦，见 R4-06。
- **R3-06**：作者已把原 helper 和 volatile 变异纳入 K86/K87 并杀死；新变异仍存活，见 R4-07。**R3-07**：两种 Node 版本独立实跑及金丝雀均有界完成；此前 Node 25 K08 卡住的原样例本轮不再重现。

## 必须修复

### R4-01 [P1 / AC-06、AC-08] 短撤回原文从 tail 漏出；重建回调还能篡改引用投影

位置：`packages/kernel/src/assemble.ts:19-20,118-131,150-175,199-209`，领域消息类型 `packages/domain/src/log.ts:22`。

1. 用户 #1 发送 `不同意` 后撤回；在 `volatile:'不同意'` 下调用装配，实测返回 `ok:true`，序列化请求的 tail 仍有这三字。`MIN_LEAK_SCAN_CHARS=4` 导致此路径不检查短原文；压缩块 `builtAtSeq` 不覆盖 `volatile`，因此不能兜底。第 7 栏已披露扫描只处理 4 字以上，但收据又称“只保证本次请求体不含撤回原文”，该保证与实际冲突。不能用对任意三字做无差别全局过滤替代来源/依赖控制。
2. 先发未撤回 #1 `真正的用户指令` 与 #2 `这是需要撤回的密码`，随后撤回 #2；旧压缩块触发 `recompress`，回调将收到的可见对象 `visible[0].text` 改成 #2 的原文，再返回无泄漏字样的摘要，同时引用 #1。实测 `ok:true`，最终 page-in 为 `#1 user:u: 这是需要撤回的密码`，真实 #1 原文消失。`visible` 数组虽标 readonly，`ProjectedMessage` 元素本身可变，且与后续 `all.find` 共享对象；我另用实际 TypeScript 编译器验证这种回调赋值类型检查退出 0。

**修复要求**：对 tail/压缩派生内容建立可验证的来源依赖并在撤回后失效，短原文也不能仅靠 4 字扫描放行；给外部回调独立、不可修改的深快照，引用页入从未受回调污染的权威日志重新取得最新原文，并在最终完整请求边界验证撤回约束。补短文本、回调改元素/嵌套字段、引用与撤回组合测试；不可把“上层压缩器通常不改对象”当成安全合同。

### R4-02 [P1 / AC-35] 快照的 Map 和原型仍可变，同一未知动作可换接收端

位置：`packages/kernel/src/plugins.ts:26-39,67-72,198-213`。`Object.freeze(map)` 不冻结 Map 内部条目；`Object.create(Object.getPrototypeOf(c))` 还共享调用方原型。

- 独立 B1 模拟插件将实际目的地存于 `this.route = new Map([['dst','A']])`。首次向 A 产生副作用后，插件正常执行 `this.route.set('dst','B')` 并因回执丢失抛错；保留期内重试，宿主仍记录 `endpoint:'A'`、同一渠道版本 1，却真正向 B 发出，模拟副作用依次为 `[A,B]`，最后误报 confirmed。
- 另以继承原型上的 `endpoint:'A'` 与 `send` 的合法实例注册；第一次 A 结果未知后，仅将共享原型的 endpoint 改为 B，不 reregister，实测也出现 `[A,B]`，账本仍绑定 A 和原版本。

这两例的两个模拟接收端均各自按 action_id 去重；问题是不同接收端的去重域独立。它们使用 `this` 上的配置或原型，不是仅重复第 7 栏已披露的外部闭包变量问题。

**修复要求**：对允许进入配置快照的值和原型提供真正不可变、不可借内部槽修改的表示，或拒绝无法安全快照的配置；绑定并验证实际接收端能力，而不只信任自报的字符串。对 Map/Set/Date、原型继承及在途变更做实际调用计数反例；无法验证时保守拒绝结果未知后的重试。

### R4-03 [P1 / 插件契约] 合法带私有字段的渠道被注册成功，但实际调用必然失败

位置：`plugins.ts:26-39,58-72`。一个实现 `kind/id/endpoint/idempotency/send` 的正常 JavaScript class，其 `send` 读取自身 `#credentials`。实测 `register(new Mail())` 返回 `{ok:true}`；发送时 `send.call(self,...)` 的 `self` 只是 `Object.create` 的同原型对象，没有该类的 private brand，抛 `Cannot read private member #credentials...`，宿主记 `delivery-unknown`；B2 的后续同动作因未知结果不可重试。

**修复要求**：明确并实现可用的插件实例/快照协议，保留所需实例语义；不能安全支持的实例需在注册前显式拒绝，而非先声称注册成功、到发送时才落入结果未知。增加 class 私有字段与典型有状态适配器的正负测试，不要求将不可快照资源的内部字段原样暴露给模型。

### R4-04 [P1 / AC-35] 墙钟回拨会延长 B1 重试窗口并重发

位置：`plugins.ts:120-122,198-199,209-213`。默认 `now=Date.now`，只判断 `now() - firstAttemptAt >= windowMs`，没有保护墙钟回拨。独立模拟：服务端正常前进 1,001 ms 且 1,000 ms 的幂等键已过期，但宿主墙钟比首次尝试倒退 1 ms；同一未知动作仍被重试，接收端产生第二个副作用。仅看 `now - firstAttemptAt` 的负值会错误落在“保留期内”。

**修复要求**：使用适合本运行生命周期的单调时间核对真实经过时长，并对时钟不可信、重启后无法确认安全窗口等情况保守保持 `DeliveryUnknown`；至少拒绝负向时间，测试回拨、前进跳变、恰好到期和多次重试。不要把可注入的墙钟值视作已经证明服务商仍保留幂等键。

### R4-05 [P1 / 账本隔离] 含 NUL 的合法字符串导致不同渠道/动作键碰撞

位置：`plugins.ts:20-21,47,125,191-197,215-217`。注册及 action_id 校验只要求非空字符串，账本却以 `${pluginId}\0${actionId}` 拼接。实测注册 `id='a'` 和 `id='a\0b'` 均成功；先发送 `(a, b\0c)`，再发送 `(a\0b, c)`、相同 payload。第二次错误返回第一渠道的回执（action_id 还是 `b\0c`）、`deduplicated:true`，第二渠道实际调用 0 次。

**修复要求**：使用不碰撞的结构化键（例如分层 Map/长度编码），或在契约输入处明确拒绝分隔符及其他不合法 ID，并对两个不同渠道/动作、相同及不同 payload 做隔离测试。不能靠调用方“通常使用 UUID”保证该已接受输入安全。

### R4-06 [P1 / AC-39] 固定说明中出现“新消息”也会被误当成动态内容

位置：`assemble.ts:70-85,137-143`。空日志下，完全静态的 system `收到新消息后，先遵守群规。` 实测返回 `volatile-in-stable`，因为规则无条件匹配字串 `新消息`；实际上没有任何新消息正文、时刻或任务表被注入固定前缀。它是常见的行为规则，阻断了正常固定提示词，第三轮“避免自然内容误拦”未完全成立。

**修复要求**：区分稳定的规则描述与实际动态值，借助结构化数据来源/版本和相邻请求变化校验，而非只凭触发词判定。保留真实的动态注入负例，同时加入“不含动态值的通用规则”阴性测试。

### R4-07 [P1 / R-05] 两个新变异存活，撤回编辑文本与阈值边界未被覆盖

变异仅在隔离副本执行；每次 `npm run typecheck` 退出 0、`npm test` 112/112 绿：

- **R4-M1**：删除 `retractedTexts` 收集被撤回消息 edit 文本的分支。对先发“最初的旧内容”、再编辑成“新的非常机密内容”、再撤回并在 volatile 带编辑文本的输入，原版返回 `retracted-text-leaked`；变异版却 `ok:true` 并把编辑文本带入 tail。
- **R4-M2**：在 M1 的副本上，将 `t.length >= MIN_LEAK_SCAN_CHARS` 改成 `>`。对恰好四字的撤回内容 `秘密口令`，原版拦截；变异版放行。112 条测试仍全绿。

**修复要求**：覆盖撤回前多次编辑的全部版本出现在压缩块/tail 的场景，以及明确阈值的边界正负对照，并实际注入上述错误检查具名测试变红。第 7 栏已承认只测 87 种变异，但收据 R-05 的整体“通过”不能代替对新增判据的充分标定。以上是**测试覆盖缺口**，不是把变异后行为说成原版已有错误。

## 原版反例可执行复现

在 `c0dd021` 的仓库根目录完成 `npm ci` 后运行；以下断言的是当前观察到的错误，两个接收端均是本机模拟，不连接外网：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {append,emptyLog} from './packages/domain/src/log.ts';
import {assemble,serialize} from './packages/kernel/src/assemble.ts';
import {createRegistry} from './packages/kernel/src/plugins.ts';
const u={kind:'user',id:'u'},at='2026-11-05T00:00:00Z',stable=[{kind:'system',text:'助手规则'}];
let log=append(emptyLog(),u,{kind:'message',text:'不同意'},at);log=append(log,u,{kind:'retract',target:1},at);
const short=assemble(log,{stable,quotes:[],volatile:'不同意',budgetBytes:1000});
assert.equal(short.ok,true);assert.ok(serialize(short.request).includes('不同意'));
const secret='这是需要撤回的密码';log=append(emptyLog(),u,{kind:'message',text:'真正的用户指令'},at);
log=append(log,u,{kind:'message',text:secret},at);log=append(log,u,{kind:'retract',target:2},at);
const poisoned=assemble(log,{stable,quotes:[1],budgetBytes:10000,compressed:{throughSeq:2,builtAtSeq:2,text:'旧摘要'},recompress(_n,visible){visible[0].text=secret;return '安全摘要'}});
assert.equal(poisoned.ok,true);assert.ok(serialize(poisoned.request).includes(secret));assert.equal(serialize(poisoned.request).includes('真正的用户指令'),false);
console.log('R4-01：短撤回文字泄出；重建回调篡改引用并带回撤回原文');
let now=100000;const effects=[],caches={A:new Map(),B:new Map()};
const p={kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'action-id',idempotencyWindowMs:10000,route:new Map([['dst','A']]),async send(q){
 const dst=this.route.get('dst'),cache=caches[dst];if(cache.has(q.action_id))return cache.get(q.action_id);
 effects.push(dst);const r={action_id:q.action_id,receiptId:dst};cache.set(q.action_id,r);
 if(dst==='A'){this.route.set('dst','B');throw Error('A 已接收但回执丢失')}return r;
}};
const reg=createRegistry({now:()=>now});assert.equal(reg.register(p).ok,true);const req={action_id:'a',payload:'x'};
assert.equal((await reg.send('p',req)).state,'delivery-unknown');now+=1000;await reg.send('p',req);
assert.deepEqual(effects,['A','B']);assert.equal(reg.delivery('p','a').binding.endpoint,'A');
console.log('R4-02：冻结 Map 仍能改路由，重复副作用',effects.join(','));
class Mail {kind='outbound-channel';id='m';endpoint='M';idempotency='none';#credential='handle';async send(q){return {action_id:q.action_id,receiptId:this.#credential}}}
const classes=createRegistry();assert.equal(classes.register(new Mail()).ok,true);
const cr=await classes.send('m',{action_id:'a',payload:'x'});assert.equal(cr.reason,'send-threw');assert.match(cr.detail,/private member/);
console.log('R4-03：合法私有字段类注册成功但无法发送');
let host=100000,server=0,count=0;const cache=new Map(), clock=createRegistry({now:()=>host});
clock.register({kind:'outbound-channel',id:'c',endpoint:'C',idempotency:'action-id',idempotencyWindowMs:1000,async send(q){
 const old=cache.get(q.action_id);if(old&&server-old.at<1000)return old.receipt;
 count++;const receipt={action_id:q.action_id,receiptId:'r'+count};cache.set(q.action_id,{at:server,receipt});
 if(count===1)throw Error('已送达但回执丢失');return receipt;
}});
await clock.send('c',req);server=1001;host=99999;await clock.send('c',req);assert.equal(count,2);
console.log('R4-04：墙钟回拨后副作用次数',count);
const calls=[],ledger=createRegistry();for(const [id,ep] of [['a','A'],['a\0b','B']]) ledger.register({kind:'outbound-channel',id,endpoint:ep,idempotency:'none',send:async q=>{calls.push(ep);return {action_id:q.action_id,receiptId:ep}}});
await ledger.send('a',{action_id:'b\0c',payload:'x'});const wrong=await ledger.send('a\0b',{action_id:'c',payload:'x'});
assert.deepEqual(calls,['A']);assert.equal(wrong.deduplicated,true);assert.equal(wrong.receipt.action_id,'b\0c');
console.log('R4-05：不同渠道/动作碰撞并错误复用回执');
const fixed=assemble(emptyLog(),{stable:[{kind:'system',text:'收到新消息后，先遵守群规。'}],quotes:[],budgetBytes:1000});
assert.equal(fixed.reason,'volatile-in-stable');console.log('R4-06：无动态输入的静态规则被误拦');
NODE
```

## 仍未完成的验收边界

AC-06、AC-08、AC-11、AC-12、AC-35、AC-39 与 R-06 的整项均未通过；短撤回文本、引用回读、实际渠道与持久账本、模型真实缓存断点、按线路的命中率及可信度、常驻会话和用户可见纵向路径都不能以当前纯函数/模拟结果代替。特别是 AC-08 和 AC-39 是本轮已复现有实质错误的子判据，不只是“等集成测试”。

---

# 第五轮：返修独立复审

**结论：reject。** 第四轮的常规反例已有可复现修复，但单调时钟先前进再倒退时仍会重发；被声明必须拒绝的 getter 在数组内被执行并接受，关键字段 getter 抛错会逃逸注册入口；重建压缩块的异常兜底也可再次抛错；部分发言者标签被误扫为消息正文。两个自行构造的撤回检查变异骗过全部 135 条测试。以下是对 `cedc19e` 的实测，不以模拟接收端冒充真实外发 E2E。

## 复审范围与运行结果

- 普通独立 clone `feat/kernel-plugins`，功能 HEAD `cedc19eff9d1681624993843f005694eb7b6bdc7`；基线 `origin/feat/domain-core` = `afd02560f9546147da380382404eb6106222a9b8`；红提交 `86263e187391c573d332667fb58172e802679353`。前四轮报告原样保留；只追加本节并改收据 `review`。自造变异在另一个独立副本。
- 审查人 `codex`，会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`；本轮原生 `turn_context` 模型 `gpt-6.1-terra`（OpenAI）。作者会话触及本项目的模型为 `claude-opus-5-5`（Anthropic）。来源门禁仍须等本轮会话落盘后实测。
- 审查仓库根目录实际执行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，原样标准输出：

  ```text
  6622c16d92efaa0a90df359386bd277afe1c7dcd69700bdc67dc0334816104b7
  ```

| 检查 | 独立结果 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 检查 22 文件 |
| 绿提交 `npm test` | 退出 0，135 通过、0 失败、0 跳过；其中 kernel 112 条 |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1，23 条旧测试通过、112 条 kernel 测试逐名失败、0 跳过。红绿三份测试文件无差异，测试名与红失败名双向差集为空 |
| 作者变异脚本，Node `v22.22.0` / `v25.8.1` | 两次独立顺序运行均退出 0；各自原样 112 绿，107 个具名变异被杀、0 存活、0 超时；R4-M1/M2 的 K92/K91 均纳入 |
| 超时金丝雀，Node `v22.22.0` / `v25.8.1` | `KERNEL_MUT_TIMEOUT_MS=5000` 两次均约 5 秒退出 0；金丝雀超时按脚本语义不记为变异被杀 |
| 自造变异 R5-M1 / R5-M2 | 隔离副本先后注入；每次 typecheck 退出 0，全仓 135/135 仍绿；原版对照与具体反例见 R5-05 |
| 原始 `run-all.ts --local --branch=feat/kernel-plugins --base=origin/feat/domain-core` | 退出 1；`G-REVIEW` 因无 review 而红，其余机械门禁显示绿。`review=null` 时 `G-PROVENANCE` 提前跳过，不能当作审查来源已验证 |
| 填写 reject 后重跑同一 `--local` | 退出 1；`G-REVIEW` 因 reject 拦截；`G-PROVENANCE` 找不到本次 hash 调用且不能确认审查厂商，本轮会话尚未落盘，结束后仍须实测 |

## 第四轮修复复测

- **R4-01**：普通 3 字撤回原文在 volatile 中被拒；回调试图修改冻结可见消息时不能污染引用，引用仍是日志真实原文。异常兜底的另一条路径见 R5-03。
- **R4-02 / R4-03**：普通 `Map` 配置与带私有字段的类实例在注册时返回 `unsupported-instance`；已注册普通对象的 send 请求带绑定 endpoint。嵌套数组 getter 与关键字段 getter 的异常路径仍有缺口，见 R5-02。
- **R4-04**：墙钟跳变不影响正常单调时钟窗口；读数低于首次读数时该次被拒。但读数低于**上一次**而仍高于首次时不被拒，见 R5-01。
- **R4-05 / R4-06**：此前含 NUL 的两渠道动作各自产生一次调用，不再共用账本；静态规则“收到新消息后，先遵守群规”被放行。**R4-07**：作者已将此前两个变异纳入 K92/K91 并杀死，但本轮两个新变异存活，见 R5-05。

## 必须修复

### R5-01 [P1 / AC-35] 单调读数相对上一轮倒退仍可重试，已发现倒退后恢复也可再次重试

位置：`packages/kernel/src/plugins.ts:159-162,245,255-260`。代码只比较当前读数与 `firstAttemptMonotonic`，没有记录上一次观测值或“时钟已不可信”状态。

独立模拟的 B1 服务商在 1,000 ms 后忘记去重键，三次宿主读数依次为 `1000 → 1100 → 1050`：第二次在服务商保留期内重复请求；第三次相对上一轮倒退，但仍高于首次，宿主继续发送。服务商在独立模拟时钟上已过期，真实副作用数由 1 增至 2。另一反例：`1000 → 999` 的那次虽拒绝，但读数再变成 `1001`、服务商实际已过期时宿主又允许发送，最终副作用仍为 2。这里的服务商/时钟都是确定性模拟，不称真实邮件已重复。

**修复要求**：逐次记录可比较的最近单调观测，任意倒退或无法确认时长后将该动作的自动重试资格持久地标为不可信，直到明确对账/新动作；不能因读数回升便重新假设 TTL 安全。保留首次时间不刷新的约束，覆盖首次后倒退但仍高于首次、发现倒退后读数回升、到期与无倒退对照。

### R5-02 [P1 / AC-35] getter 在数组中被执行并接受；关键字段 getter 抛错可逃出注册

位置：`plugins.ts:31-55,63-75,83-107`。`plainData` 的数组分支直接读 `x[i]`，没有检查索引 descriptor；而 `snapshotOf` 在调用 `channelSelf` 检查 getter 之前就读取 `kind/id/send/endpoint` 等字段。

- 对普通插件配置 `config.routes[0]` 定义可枚举 getter，getter 只返回字符串 `A` 并递增计数；独立调用 `register` 实际 `{ok:true}`，getter 被执行 1 次。与“getter 注册即拒且指出字段”相反。
- 对顶层 `endpoint` 定义会抛错的 getter，`register` 直接抛 `Error: endpoint getter 执行`，没有 `RegisterResult` 和字段级拒绝。不是现有测试里非关键 `route` getter 的普通样例。

**修复要求**：在读取任何契约字段前先以安全 descriptor 检查普通对象/数组的自有字段，逐层拒绝 accessor 并报告路径（包括数组索引）；处理可能抛出的反射/读取错误，不能让注册入口抛异常或执行 getter 后再声称已拒绝。补关键字段及嵌套数组 getter 的正负对照和调用计数。

### R5-03 [P1 / AC-08] 重建回调的异常兜底自身仍可抛错

位置：`packages/kernel/src/assemble.ts:173-180`。当被撤回消息使旧压缩块失效时，令 `recompress` 抛出一个 `Error`，其 `message` getter 自身抛错；当前 catch 块先直接读取 `err.message`，实测 `assemble` 抛出 `Error: message getter 错误`，而不是返回 `{ok:false,reason:'invalid-compressed'}`。这和分类器已修复的异常序列化问题是同类但不同代码入口。

**修复要求**：对 `instanceof`、错误字段读取及字符串化全部使用安全封闭的诊断转换；恶意 getter、会抛的 `getPrototypeOf`、普通 Error 及非 Error 都要返回明确失败，不暴露半成品且不抛出。

### R5-04 [P1 / AC-08] 带 `: ` 的发言者 ID 让宿主标签被误计入撤回扫描

位置：`assemble.ts:199-202,220-225,252-258`。代码通过 `sg.text.indexOf(': ')` 猜测正文起点，而不是直接保存结构化正文。合法事件序列：用户 #1 发 `敏感词` 并撤回；另一发言者 ID 为 `其他: 敏感词`，消息正文为 `普通内容`。实测返回 `retracted-text-leaked / history / seq:1`；只把该 ID 的 `: ` 改成 `_`，正文和其他输入不变，装配成功。被命中的是发言者标签，不是正文，违背本轮明确要求“宿主自加的序号与发言者标签不参与扫描”。这不同于作者已披露的“其他人正文恰含撤回短词”的有意保守误拦。

**修复要求**：渲染时保留独立的原始内容字段供扫描，或用消息事件直接提供正文，勿从可包含任意 ID 的渲染字符串反向猜分隔符；分别覆盖消息、编辑与引用的 sender ID 中 `: `、空格和冒号，并确保真实正文含撤回原文仍被拦。

### R5-05 [P1 / R-05] 两个新变异存活，空白种类和多次撤回缺少充分校准

以下只发生在隔离变异副本，不是将变异版行为归咎原版；每次 `npm run typecheck` 退出 0、`npm test` 全仓 135/135 绿：

- **R5-M1**：将 `squash` 的 `/\s+/gu` 换成只删除普通空格和换行的 `/[ \n]+/g`。对撤回原文 `秘密口令` 与 volatile `秘\t密　口令`（制表符和全角空格），原版返回 `retracted-text-leaked`，变异版返回 `ok:true` 并带入尾部；现有空白测试只覆盖普通空格和换行。
- **R5-M2**：在 M1 副本上，让 `retractedTexts` 仅收集第一条被撤回的 message。输入连续撤回 `第一个秘密` 和 `第二个秘密`，volatile 为第二条原文；原版拒绝并报 `seq:2`，变异版 `ok:true`。现有测试没有以多条同时撤回及第二条正文作为判据。

**修复要求**：补制表符、全角空格等支持的空白种类及多条撤回分别命中的可执行负例，注入相应坏变异并配非泄漏正例；不要以预选 107 个变异全部被杀代替这些新增合同的双侧标定。

## 原版反例可执行复现

在 `cedc19e` 仓库根目录 `npm ci` 后运行；断言固定的是**当前错误**，服务端和时钟均为本机模拟：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {append,emptyLog} from './packages/domain/src/log.ts';
import {assemble} from './packages/kernel/src/assemble.ts';
import {createRegistry} from './packages/kernel/src/plugins.ts';
const arr=[];let reads=0;Object.defineProperty(arr,'0',{enumerable:true,configurable:true,get(){reads++;return 'A'}});arr.length=1;
const r=createRegistry(),base={kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',config:{routes:arr},send:async q=>({action_id:q.action_id,receiptId:'r'})};
assert.equal(r.register(base).ok,true);assert.equal(reads,1);
const bad={kind:'outbound-channel',id:'g',idempotency:'none',send:async q=>({action_id:q.action_id,receiptId:'r'})};
Object.defineProperty(bad,'endpoint',{enumerable:true,get(){throw Error('endpoint getter 执行')}});
assert.throws(()=>r.register(bad),/endpoint getter 执行/);console.log('R5-02：数组 getter 被接受且执行；关键 getter 抛出');
let mono=1000,server=0,effects=0,calls=0;const seen=new Map(),reg=createRegistry({now:()=>0,monotonic:()=>mono});
reg.register({kind:'outbound-channel',id:'b1',endpoint:'A',idempotency:'action-id',idempotencyWindowMs:1000,send:async q=>{
 calls++;const old=seen.get(q.action_id);if(old!==undefined&&server-old<1000)throw Error('回执继续丢失');
 effects++;seen.set(q.action_id,server);throw Error('已送达但回执丢失');
}});
const req={action_id:'a',payload:'x'};await reg.send('b1',req);mono=1100;server=100;await reg.send('b1',req);mono=1050;server=1001;await reg.send('b1',req);
assert.equal(calls,3);assert.equal(effects,2);console.log('R5-01：读数倒退后请求数',calls,'副作用数',effects);
const u={kind:'user',id:'u'},at='2026-11-05T00:00:00Z',stable=[{kind:'system',text:'助手'}];
let log=append(emptyLog(),u,{kind:'message',text:'旧的保密原文'},at);log=append(log,u,{kind:'message',text:'普通消息'},at);log=append(log,u,{kind:'retract',target:1},at);
const err=new Error('x');Object.defineProperty(err,'message',{get(){throw Error('message getter 错误')}});
assert.throws(()=>assemble(log,{stable,quotes:[],budgetBytes:1000,compressed:{throughSeq:2,builtAtSeq:2,text:'旧摘要'},recompress(){throw err}}),/message getter 错误/);
console.log('R5-03：重建异常处理再次抛错');
let labels=append(emptyLog(),u,{kind:'message',text:'敏感词'},at);labels=append(labels,u,{kind:'retract',target:1},at);
const a=append(labels,{kind:'user',id:'其他: 敏感词'},{kind:'message',text:'普通内容'},at);
const b=append(labels,{kind:'user',id:'其他_敏感词'},{kind:'message',text:'普通内容'},at);
assert.equal(assemble(a,{stable,quotes:[],budgetBytes:1000}).reason,'retracted-text-leaked');
assert.equal(assemble(b,{stable,quotes:[],budgetBytes:1000}).ok,true);console.log('R5-04：标签中的冒号导致误拦');
NODE
```

## 未完成验收边界

作者披露的短撤回词与他人**正文**碰撞可能误拦、摘要改写后的派生语义无法由逐字扫描保证、插件可能忽略声明 endpoint、进程重启后内存账本丢失及 AC-39 实际缓存/会话/用量观测未接线，均不能以当前模拟结果当作通过。R-06 纵向路径仍未测；AC-06、AC-08、AC-11、AC-12、AC-35、AC-39 整项也均未通过。本次 reject 的问题包含本片内已可直接复现的错误，不只是未来集成缺口。

---

# 第六轮：返修独立复审

**结论：reject。** 哈希与作者一致；常规入站 getter、第五轮时钟反例和 8 个门禁的各自负例已独立复现。但“所有入口访问器均不执行”和“原型 setter/只读属性不影响合法输入”不成立：`Object.prototype.get` 污染会拒绝合法数据；`Array.prototype[0]` setter 可使拉取结果缺失事件却返回成功，装配也会抛错；若干公开入口和非法分类/发送结果仍会执行 getter。两个自行注入的单点故障一个被杀、一个存活。

## 审查范围、身份和实际执行

- 普通独立 clone `feat/kernel-plugins` 功能 HEAD `2d4bf600165d61a1e6264b2ad68ae9f1c83a74cb`；`origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；红提交 `0d0a03b42e735261b91543765222c53614607ea8`。前五轮原样保留；本次只追加本节与更新收据 `review`；变异及门禁夹具均在其他临时独立目录。
- 审查人 `codex`；会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`；本轮原生 `turn_context` 实际模型 `gpt-6.1-terra`（OpenAI）。作者会话实际触及项目的模型为 `claude-opus-5-5`（Anthropic）。当前轮来源门禁须会话落盘后再核验。
- 独立 clone 仓库根目录实际执行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，标准输出原样为：

  ```text
  2f6783ff4f308ba9ea77918bd5b1549a7dc46f980f98e438d0844cd33bf98f27
  ```

  与用户给出的作者 hash **完全一致**。

| 检查 | 独立结果 |
|---|---|
| 绿提交 `npm ci`、`npm run typecheck`、`npm run lint` | 全部退出 0；lint 检查 24 文件 |
| 绿提交 `npm test` | 退出 0；174 通过、0 失败、0 跳过，其中 kernel 151 条 |
| 红提交 `npm ci`、`npm test` | 安装退出 0；测试退出 1；23 条旧测试通过、151 条 kernel 测试逐名失败、0 跳过。红绿四份测试文件无差异，测试名与红失败名双向差集为空 |
| 作者变异脚本，Node `v22.22.0` / `v25.8.1` | 两次独立顺序运行均退出 0；各自原样 151 绿，131 个具名变异被杀、0 存活、0 超时。K20/K72/K128 的新注入点均被具名测试杀死 |
| 金丝雀，Node 22 / 25 | 各以 `KERNEL_MUT_TIMEOUT_MS=5000` 运行，约 5 秒结束、退出 0；金丝雀被记录为超时，不冒充杀死 |
| 自造单点变异 R6-M1 / R6-M2 | M1 在隔离副本被一条具名测试发现；M2 typecheck 通过、174/174 测试绿却破坏空白撤回防护，见 R6-05 |
| 原始 `run-all.ts --local` | 退出 1，`G-REVIEW` 因无审查而红；其余门禁显示绿。`review=null` 时 `G-PROVENANCE` 提前跳过，不能称已核验来源 |
| 填写 reject 后重跑同一 `--local` | 退出 1；`G-REVIEW` 因 reject 拦截；`G-PROVENANCE` 当前找不到本次 hash 调用且无法确认审查厂商。本轮会话尚未落盘，结束后仍须实测 |

## 逐入口 getter 与原型条件

- 独立构造 getter 时，`plainData`、`plainItems`、注册、重注册、发送请求、发送回执、拉取数组、拉取事件、装配日志、装配选项和分类入站**在各自所测样例中**均给出拒绝/保守结果，getter 调用 0 次；分类器计数也为 0。不能据此推广到未覆盖的公开入口或分类器返回值：见 R6-03/R6-04。
- `Object.prototype.x` 同名 setter 或不可写属性下，合法 `{x:1}` 的 `plainData` 及普通装配样例正常；`plainData(['a'])` 本身在 `Array.prototype[0]` setter / 不可写下标下也正常。针对描述符字段名和完整调用链的反例见 R6-01/R6-02。
- 第五轮的单调时钟先升后降并恢复反例，现在持续 `clock-untrusted`，不会自动再发；普通字段 getter、重建恶意异常、含冒号的 sender 标签样例已修复。所有这些仅是局部样例，不等于所有边界已证明。

## 每个门禁的独立负例

为每项创建单独的临时真实 Git 仓库；在同一生产 `runGates` 上核对预期问题文字，并分别以本仓库真实 `node scripts/gates/run-all.ts --repo <夹具> --base main --branch feat/case --local` 运行完整 CLI。**八个夹具均退出 1，且各自目标门禁为 ✗**；单个夹具可能同时触发其他门禁，不能据此声称其他门禁通过。

| 门禁 | 本轮独立输入 | 实际目标判定 |
|---|---|---|
| G-TRACE | 收据 AC-01 状态写 `快通过` | 状态不是四选一 |
| G-REVIEW | 审查 agent 与作者均为 `claude` | 审查人与作者是同一个 |
| G-PROVENANCE | `codex:not-found` 审查会话；临时空会话根 | 审查会话不可信 |
| G-RED | `red.commit` 为不存在的 40 个 0 | 红提交不存在 |
| G-STUB | 测试只断言 `typeof calc`、从不调用实现 | 空桩后没有按名字失败 |
| G-TAUTO | `assert.equal(3,3)` | 恒真/恒定断言 |
| G-WORKFLOW | 新 workflow 声明 `permissions: {contents: write}` | 申请写权限 |
| G-LAYER | plugin-one 的源码 import plugin-two | plugin 层不能依赖 plugin 层 |

本轮第一个自写夹具运行时把 G-TAUTO 预期文字误写成“字面量”，门禁实际已报“恒真”；且管道未开 `pipefail` 遮住了脚本非零退出。我修正预期并开启 `pipefail` 后重跑：8/8 目标负例均识别，随后完整 CLI 的 8 次也均为目标 ✗、退出 1。下方给出可重跑的完整临时夹具脚本；这验证每门禁一条负例，不代表门禁不存在其他绕过。

## 删除与修改的变异

- **K21**：把 `mounts: Object.freeze([...c.mounts])` 改成 `mounts: c.mounts`，独立变异 174 绿；注册后修改原实例 mounts，原版与变异都只保留注册时值。当前 `c` 已先经 `plainData` 深拷贝冻结，且公开 API 不暴露该数组引用，因此在已声明的行为下删除理由成立。
- **K108**：当前先检测并持久标记 `clock-untrusted`，窗口判断才执行。对照加回 `elapsed >= 0`、再测读数 `500→499→501`，原版与对照均两次 `clock-untrusted`、真实调用 1 次，174 测试绿；该旧条件在当前可达路径中冗余，删除理由成立。
- **K141**：将对 null 原型结果对象的 `defineProperty` 改为直接赋值；含自有 `__proto__`、`constructor` 与 `Object.prototype.a` setter 的样例中，原版/变异均保持 null 原型、值相同、setter 0 次，174 测试绿。该指定结果写入变异在当前合同下有等价依据；**这不能证明其他描述符构造点能抵抗 `Object.prototype.get` 污染**，见 R6-01。
- 修改后的 **K20/K72/K128** 在 Node 25 的独立原脚本运行中均被具名测试杀死，分别检出原对象共享、错误 this、数组元素描述符绕过。上述三个等价结论均限定本版已声明的可观察接口及所测输入，不是对所有未来实现的永久证明。

## 必须修复

### R6-01 [P1 / 普通对象合同] `Object.prototype.get` 污染使合法输入被误拒

位置：`packages/kernel/src/plain.ts:23-30,38-43,73-83,96-112`。`ownDescs` 虽用 null 原型保存结果，但 `Object.defineProperty(table,k,{value:d,enumerable:true})` 的**描述符参数自身**是普通对象。临时在 `Object.prototype` 安装名为 `get` 的 setter 后，对无 accessor 的合法 `{x:1}` 调 `plainData`，实测 `ok:false`，理由 `Invalid property descriptor. Cannot both specify accessors and a value or writable attribute`；`assemble` 同样失败，`classifyInbound` 把合法输入归为 `Uncertain`。`get` 设为不可写普通值 `17` 时也拒绝，理由 `Getter must be a function: 17`。setter 本身虽未调用，结果已改变。作为正对照，`Object.prototype.x` setter/不可写属性下相同合法输入通过。

**修复要求**：连传给 `Object.defineProperty` 的属性描述符也不得继承可污染原型，检查 `get/set` 应只依据 descriptor 的自有字段；对 `get/set/value/writable/enumerable/configurable` 等描述符名分别做 setter/只读对照，并验证从 public 入口到最终结果，而非仅测普通输入键 `x`。

### R6-02 [P1 / AC-35、AC-39] Array 原型污染穿透调用链，拉取成功但丢事件

位置：`packages/kernel/src/plugins.ts:194-212`、`assemble.ts:187-225`。`plainData/plainItems` 自身用 `defineProperty` 追加，所测单独克隆可通过；但调用者仍用 `events.push`、`segments.push`、`bodies.push` 等。

独立进程临时在 `Array.prototype['0']` 设置 setter，正常 DataSource 返回一条合法事件。实测 `pull` 返回 `ok:true`，setter 被调用 1 次，`events.length===1` 但 `Object.hasOwn(events,0)===false`、事件为稀疏空槽（JSON 中显示 `null`）；合法内容没有返回。相同条件下装配合法日志抛 `Cannot read properties of undefined (reading 'label')`。把该属性改成不可写数据属性，合法 `pull` 与装配分别抛 `Cannot assign to read only property '0'`。污染只在独立子进程里临时设置，结束后恢复；这不是说真实宿主已被污染。

**修复要求**：保障整个公开调用链的结果数组构建及后续使用不受继承 setter/只读下标影响，或在入口检测并显式拒绝环境而不得返回伪成功；对合法一条/多条事件、合法装配、拒收事件与空结果分别验证自有下标及真实内容，覆盖 setter 与不可写两侧。不能只证明 `plainData` 的临时数组安全。

### R6-03 [P1 / 对外入口合同] 工厂选项、序列化和前缀工具仍会执行 getter

位置：`plugins.ts:130-134`、`plain.ts:39-41`、`assemble.ts` 的 `serialize/prefixLength/prefixHash`（均由 `packages/kernel/src/index.ts` 导出）。

独立测试 `createRegistry({get now(){counter++;return Date.now}})`：对象被接受且 getter 调用 1 次；`plainData({x:1},'x',{get topFunctions(){counter++;return true}})` 同样接受并调用 1 次。给 `serialize/prefixLength/prefixHash` 一个 `segments` getter，三个函数分别执行 getter 1、1、2 次并返回结果，而不是拒绝。以上是直接传入公开接口的 accessor，不是前述已通过的 `assemble` 日志/选项样例。

**修复要求**：明确这些公开入口的边界并在读取属性前做无 getter 检查；若仅允许可信内部 `AssembledRequest`，应收紧导出/类型并用可验证的内部能力而非接受任意对象。新增每个公开入口的 getter/setter 与不调用计数测试。

### R6-04 [P1 / AC-12、AC-35] 非法分类结果与 thenable 会执行 getter，发送账本卡在 in-flight

位置：`classify.ts:87-104`、`plain.ts:116-144`、`plugins.ts:23-26,143-158`。

- 让分类器返回带可枚举 getter 的非枚举对象：分类结果虽为 `Uncertain`，`safeDescribe` 的 `JSON.stringify` 已执行 getter 1 次。入站事件 getter 计数为 0 的测试不能证明分类器输出也安全。
- 让已注册 JS 插件的 `send` 返回非 Promise 对象，且 `then` 是会抛错的 getter。`isThenable` 直接读 `x.then`，实测 getter 被执行、首次 `send` 的 Promise 抛 `then getter`，账本仍为 `in-flight`；再次同动作只能收到 `in-flight`，并未按不合法发送结果记 `DeliveryUnknown`。

**修复要求**：对分类器非枚举结果做不执行 getter/`toJSON` 的安全诊断；发送结果识别与 Promise assimilation 不得在受保护范围外触发 accessor，任何无法确认的执行结果应安全落入 `DeliveryUnknown`，不能让账本永久停在 in-flight。测试非法 getter 有/无抛错、真实 Promise、同步返回、重试及计数。

### R6-05 [P1 / R-05] 自造单点变异一个被杀，一个存活

在独立副本分别修改，未改原版：

- **R6-M1（被杀）**：`plain.ts` 把 `Number.isFinite(x)` 改成 `Number.isInteger(x)`；typecheck 0，174 条中 173 绿、1 条具名红，失败是压缩点 `2.5` 的预期错误类型改变。证明这个单点错误能被现有套件发现；它不是单独证明普通小数正例已被覆盖。
- **R6-M2（存活）**：`assemble.ts` 将统一空白正则改为只列出已测普通空格、tab、换行、回车、NBSP、全角空格和零宽字符的白名单，遗漏合法空白 U+000B（垂直制表符）。typecheck 0、174/174 绿。原版对撤回 `秘密口令` 与 volatile `秘\u000B密口令` 返回 `retracted-text-leaked`；变异版 `ok:true` 并带入 tail。

**修复要求**：对支持的完整空白类别做性质测试或代表性边界测试，注入不含 U+000B 的白名单故障并验证具名测试变红；不要仅以 131 个预选变异全部被杀宣称所有撤回检查已双侧标定。

## 原版反例可执行复现

在 `2d4bf60` 的仓库根目录完成 `npm ci` 后运行；脚本只在本进程临时污染原型并在 finally 恢复，断言的是当前**错误行为**，无外网副作用：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {plainData} from './packages/kernel/src/plain.ts';
import {createRegistry} from './packages/kernel/src/plugins.ts';
import {assemble,serialize,prefixLength,prefixHash} from './packages/kernel/src/assemble.ts';
import {classifyInbound} from './packages/kernel/src/classify.ts';
import {append,emptyLog} from './packages/domain/src/log.ts';
const d=Object.create(null);d.configurable=true;d.set=()=>{};const old=Object.getOwnPropertyDescriptor(Object.prototype,'get');let checked;
try{Object.defineProperty(Object.prototype,'get',d);checked=plainData({x:1})}finally{delete Object.prototype.get;if(old)Object.defineProperty(Object.prototype,'get',old)}
assert.equal(checked.ok,false);console.log('R6-01：Object.prototype.get setter 使合法数据被拒');
const r=createRegistry(),ev={nativeId:'m',sourceVersion:'1',eventType:'create',author:'a',content:'hello',occurredAt:'2026-11-06T00:00:00Z',attachments:[]};
r.register({kind:'data-source',id:'p',sources:['g'],pull:async()=>[ev]});
const log=append(emptyLog(),{kind:'user',id:'u'},{kind:'message',text:'合法正文'},'2026-11-06T00:00:00Z');const opts={stable:[{kind:'system',text:'助手'}],quotes:[],budgetBytes:1000};
let calls=0,out,err;const ad=Object.create(null);ad.configurable=true;ad.set=()=>{calls++};const old0=Object.getOwnPropertyDescriptor(Array.prototype,'0');
try{Object.defineProperty(Array.prototype,'0',ad);out=await r.pull('p','g');try{assemble(log,opts)}catch(e){err=String(e)}}finally{delete Array.prototype['0'];if(old0)Object.defineProperty(Array.prototype,'0',old0)}
assert.equal(out.ok,true);assert.equal(out.events.length,1);assert.equal(Object.hasOwn(out.events,0),false);assert.ok(calls>0);assert.match(err,/undefined/);
console.log('R6-02：合法 pull 假成功且事件为空槽；assemble 抛错');
let n=0;const options={};Object.defineProperty(options,'now',{enumerable:true,get(){n++;return Date.now}});createRegistry(options);assert.equal(n,1);
const request={};Object.defineProperty(request,'segments',{enumerable:true,get(){n++;return []}});serialize(request);prefixLength(request);prefixHash(request);assert.equal(n,5);
console.log('R6-03：工厂和公开工具执行 getter');
let seen=0;const raw={};Object.defineProperty(raw,'x',{enumerable:true,get(){seen++;return 'x'}});
const c=classifyInbound({sender:{kind:'user',id:'u'},text:'hi'},()=>raw);assert.equal(c.intent,'Uncertain');assert.equal(seen,1);
const thenable={};Object.defineProperty(thenable,'then',{get(){seen++;throw Error('then getter')}});
const send=createRegistry();send.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:()=>thenable});
await assert.rejects(send.send('p',{action_id:'a',payload:'x'}),/then getter/);assert.equal(send.delivery('p','a').state,'in-flight');assert.equal((await send.send('p',{action_id:'a',payload:'x'})).reason,'in-flight');
console.log('R6-04：分类器输出 getter 被执行；then getter 让账本卡在 in-flight');
NODE
```

## 各门禁负例完整夹具脚本

在审查版本仓库根目录，将下面脚本保存为临时 `.mjs` 文件并运行。它只创建系统临时目录中的普通 Git 仓库与伪会话，不写生产仓库、不访问网络；每例既调用实际 `runGates` 检查原因，也运行实际 CLI 检查对应 `✗` 与退出码 1。

```js
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const judge=process.cwd();const {trace,review,provenance,red,stub,tautology,workflow,layers}=await import(pathToFileURL(path.join(judge,'scripts/gates/gates.ts')).href);
const {ctxFromGit,runGates}=await import(pathToFileURL(path.join(judge,'scripts/gates/lib.ts')).href);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pr6-independent-gates-'));const original=path.join(tmp,'original');fs.mkdirSync(original);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(root,f,text)=>{const x=path.join(root,f);fs.mkdirSync(path.dirname(x),{recursive:true});fs.writeFileSync(x,text)};
const commit=(dir,msg)=>{git(dir,'add','-A');git(dir,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m',msg);return git(dir,'rev-parse','HEAD')};
git(original,'init','-q','-b','main');write(original,'package.json','{"type":"module"}\n');write(original,'docs/spec/验收文档-v0.1.md','| AC-01 示例 |\n');write(original,'packages/core/package.json',JSON.stringify({name:'fixture-core',gGroup:{layer:'domain'}}));write(original,'.github/workflows/trusted-gates.yml','name: trusted-gates\non: pull_request_target\n');commit(original,'base');git(original,'checkout','-q','-b','feat/case');
const test='import {test} from "node:test"; import assert from "node:assert/strict"; import {calc} from "./calc.ts"; test("正向结果",()=>{assert.equal(calc(2),7)});\n';
write(original,'packages/core/src/calc.ts','export function calc(n:number):number {return 0}\n');write(original,'packages/core/src/calc.test.ts',test);const redSha=commit(original,'red');write(original,'packages/core/src/calc.ts','export function calc(n:number):number {return n+5}\n');commit(original,'green');
const receipt={slice:'fixture',acceptance:[{id:'AC-01',status:'未测',reason:'fixture'}],author:{agent:'claude',session:'claude:fixture',model:'claude-opus-5-5'},red:{commit:redSha},unverifiable:'AC-01 fixture',waiver:null,review:null};write(original,'receipts/feat-case.json',JSON.stringify(receipt,null,2));commit(original,'receipt');
const sessions=path.join(tmp,'sessions');fs.mkdirSync(sessions);process.env.MIRASIM_SESSIONS=sessions;process.env.MIRASIM_ROOMS=path.join(tmp,'rooms');
const cases=[
 {gate:trace,expect:'不是 通过/失败/未测/不适用',mutate:(dir)=>{const r=JSON.parse(fs.readFileSync(path.join(dir,'receipts/feat-case.json')));r.acceptance[0].status='快通过';write(dir,'receipts/feat-case.json',JSON.stringify(r))}},
 {gate:review,expect:'审查人与作者是同一个',mutate:(dir)=>{const r=JSON.parse(fs.readFileSync(path.join(dir,'receipts/feat-case.json')));r.review={agent:'claude',session:'claude:same',model:'claude-opus-5-5',verdict:'approve',reviewed_hash:'wrong',notes:'fixture'};write(dir,'receipts/feat-case.json',JSON.stringify(r))}},
 {gate:provenance,expect:'审查会话不可信',mutate:(dir)=>{const r=JSON.parse(fs.readFileSync(path.join(dir,'receipts/feat-case.json')));r.review={agent:'codex',session:'codex:not-found',model:'gpt-6.1-terra',verdict:'approve',reviewed_hash:'wrong',notes:'fixture'};write(dir,'receipts/feat-case.json',JSON.stringify(r))}},
 {gate:red,expect:'不存在',mutate:(dir)=>{const r=JSON.parse(fs.readFileSync(path.join(dir,'receipts/feat-case.json')));r.red.commit='0000000000000000000000000000000000000000';write(dir,'receipts/feat-case.json',JSON.stringify(r))}},
 {gate:stub,expect:'在全部实现换成空桩后没有按名字失败',mutate:(dir)=>write(dir,'packages/core/src/calc.test.ts','import {test} from "node:test"; import assert from "node:assert/strict"; import {calc} from "./calc.ts"; test("不调用实现",()=>{assert.equal(typeof calc,"function")});\n')},
 {gate:tautology,expect:'恒真',mutate:(dir)=>write(dir,'packages/core/src/calc.test.ts','import {test} from "node:test"; import assert from "node:assert/strict"; import {calc} from "./calc.ts"; test("恒真",()=>{void calc;assert.equal(3,3)});\n')},
 {gate:workflow,expect:'写权限',mutate:(dir)=>{write(dir,'.github/workflows/unsafe.yml','name: unsafe\non: pull_request\npermissions: { contents: write }\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo-ok }]\n');git(dir,'add','.github/workflows/unsafe.yml')}},
 {gate:layers,expect:'不能依赖',mutate:(dir)=>{write(dir,'packages/one/package.json',JSON.stringify({name:'plugin-one',gGroup:{layer:'plugin'}}));write(dir,'packages/two/package.json',JSON.stringify({name:'plugin-two',gGroup:{layer:'plugin'}}));write(dir,'packages/one/src/a.ts','import "plugin-two";\n');git(dir,'add','packages/one','packages/two')}}
];
let failed=0;
for(const [i,c] of cases.entries()){
 const dir=path.join(tmp,'case-'+i);git(tmp,'clone','-q','--no-hardlinks',original,dir);git(dir,'branch','main','origin/main');c.mutate(dir);
 const ctx=ctxFromGit(dir,'main','feat/case');const actual=runGates(ctx,[c.gate])[0];const messages=actual.problems.map(p=>p.msg);const targeted=messages.some(x=>x.includes(c.expect));
 const cli=spawnSync(process.execPath,[path.join(judge,'scripts/gates/run-all.ts'),'--repo',dir,'--base','main','--branch','feat/case','--local'],{encoding:'utf8',timeout:120000,env:process.env});
 const raw=(cli.stdout??'')+(cli.stderr??'');const cliRejected=cli.status===1&&raw.includes(`✗ ${c.gate.id} `);fs.writeFileSync(path.join(tmp,`${c.gate.id}.log`),raw);const ok=targeted&&cliRejected;
 console.log(JSON.stringify({gate:c.gate.id,negativeRecognized:ok,cliExit:cli.status,expected:c.expect,problems:messages}));if(!ok)failed++;
}
console.log(JSON.stringify({cases:cases.length,recognized:cases.length-failed,failed,fixtureRoot:tmp}));process.exit(failed?1:0);
```

# 第七轮：返修独立复审

**结论：reject。** 本轮在普通独立 clone 审查 `a1431c7a45f03823379dd44cfa269de1817a4772`。上轮所测描述符字段、数组下标与发送账本反例在重跑样例中已修；但拉取回调的返回值仍能执行 getter，公开导出的工具亦有同类漏洞；`Object.prototype.then` 为只读数据属性时合法发送被破坏。导出的可变策略对象还能关闭撤回扫描、放行倒序固定段；合法 JSON `null` 会让多个入口抛错；自造三个单点故障有两个逃过全套测试。必须返修后复审，不把本内核片段绿灯当成全部用户故事已验收。

## 审查范围与独立结果

- 基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；作者/审查者分别为 Claude/Anthropic 与 Codex/OpenAI。本会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 记录模型 `gpt-6.1-terra`。当前会话尚在运行，最终来源门禁仍须在记录落盘后复核。
- 在本独立 clone 的仓库根实际执行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，其标准输出**原样**如下，与作者声明完全一致：

  ```text
  74b06b1104306632e8f840af04ddfc114cfae36bcf5d91519a5b61a8ba9c9cfe
  ```

| 检查 | 本轮实测 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 24 文件 |
| `npm test`（Node 25.8.1） | 191 通过、0 失败、0 跳过，其中 kernel 168 条 |
| 红提交 `f925f192f8df21fa7f02652df7b416d737f57008` | 独立普通 clone 执行 `npm ci` 后 `npm test` 退出 1：23 旧测试通过、kernel 168 个具名测试失败、0 跳过。红绿 kernel 测试文件无差异；绿版 168 个测试名与红版失败名双向差集均为空 |
| 旧绿 `257d56e` 与新绿 `542c478` | 四个实现文件 `assemble.ts`、`classify.ts`、`plain.ts`、`plugins.ts` 的 `git diff --quiet` 退出 0；测试有调整 |
| 作者变异脚本 | Node `v25.8.1` 与 `v22.22.0` 独立各跑一次：原样副本均 168 绿，144 个变异均被具名测试发现、0 存活、0 超时；中断前的 Node 22 不完整日志保留，不计为通过 |
| 自造变异 | 三个注入点各在独立 clone 精确替换一次；typecheck 均通过，1 个被测试发现、2 个存活，见 R7-05 |
| 未填 `review` 时的 `--local` | 退出 1；`G-REVIEW` 报“还没有独立审查”，其余显示绿。注意 `G-PROVENANCE` 在 `review=null` 时提前返回，显示绿不代表审查来源已核验 |
| 填写 `reject` 后的 `--local` | 退出 1；`G-REVIEW` 正确阻挡 reject；`G-PROVENANCE` 报已落盘会话未找到本轮 hash 调用且审查厂商认不出。hash 已在独立 clone 实际执行，本轮会话落盘后仍需按门禁复核，不能把当前来源门禁报成通过 |
| 变异超时金丝雀 | Node 22 和 25 各实跑一次，5.0 秒超时被杀；超时不算变异被杀 |

验收范围：对照仓库 AC-06/08/11/12/35/39，此片仍只有装配、分类、插件宿主等纯函数/内存子判据；收据把整体验收和 R-06 纵向路径列为未测是必要边界，不能由单元测试代替真实运行时、存储及用户故事验收。

## 第六轮探针与本轮边界

- R6-01：`Object.prototype` 的 `get/set/value/writable/enumerable/configurable` 六个字段分别设 setter 与不可写数据值；独立样例 `plainData`、`assemble`、`classifyInbound` 均正常，setter 0 次。R6-02：在独立子进程对 `Array.prototype` 的下标 0、1、2 分别设 setter 或不可写值；拉取两条有效事件加一条拒收、装配与双点名分类都得预期内容与自有数组下标，setter 0 次。这不代表任意属性都已验证，见 R7-03。
- R6-03/04 已测分支：`plainData` 的 `topFunctions` getter、`plainItems` 数组元素、注册、发送请求、拉取事件、装配日志与选项、分类输入、`serialize/prefixLength/prefixHash` 和分类器结果上的 getter 均拒绝或保守处理，计数 0。`send` 回调同步抛错、Promise 拒绝、超时、非法回执和 then getter 均记为 `delivery-unknown`；B2 同动作重试为 `retry-refused`，上述非法回执/then getter 计数 0。**不能推广到所有入口或 pull 返回值，见 R7-01/02。**
- 补充探针：工厂选项、重注册、拉取数组、分类卡片 getter 分别拒绝或 `Uncertain`，安全描述使用占位，getter 与分类器调用均为 0，重注册失败保留旧快照。该探针首次把期望枚举 `Uncertain` 误拼为 `Unertain` 而断言退出 1；更正探针后重跑通过，这是审查脚本笔误而非产品故障。
- 撤回比对单独测试了所列 30 个 Unicode 空白/零宽字符点，包括 U+000B、U+0085；混入后均返回 `retracted-text-leaked`。不混入该字符的直接泄漏同样被拦截。
- 收据第 7 栏关于 **U+00AD 软连字符与全角/半角同形不规范化** 的披露与实测一致：原文 `秘密A` 被撤回后，`秘\u00AD密A` 和 `秘密Ａ` 仍可通过装配；这是声明的范围外，不能报成防住了同形改写。它关于“内置方法本身被改写不承诺”的披露在测试性改写 `JSON.stringify` 的样例中亦如实；**但新增一个 `Object.prototype.then` 只读属性不是重写内置方法，也会破坏结果**，见 R7-03。收据“外部回调返回值诊断不执行 getter”的概述不能覆盖 R7-01 的 await 边界。

## 必须修复

### R7-01 [P1 / AC-35] `pull` 在检查返回值之前 `await`，执行了返回值的访问器

位置：`packages/kernel/src/plugins.ts:227-230`。`batch = await p.pull(sourceId)` 触发 JS Promise 同化，随后才调用 `plainItems`。独立传入一个自有 `then` getter 的同步返回对象，`pull` 虽最后返回 `invalid-batch`，getter 已执行 **1 次**；带会抛错的 `then` getter 也会执行后才报 `pull-failed`。即便插件返回的是原生 Promise，在该 Promise 实例上放自有 `constructor` 抛错 getter，`await` 仍执行 getter 1 次才返回 `pull-failed`。这与“外部回调返回值遇到访问器拒绝，且不调用”不符，不能用检查最终数组元素的测试替代检查 await 前的返回值。

要求：在与 `send` 一致的可验证边界上先识别并拒绝不合约定的返回形态，避免宿主在验证前读取不可信的 `then/constructor`；对非抛错和抛错 getter、原生 Promise 自有访问器、合法原生 Promise 和合法数组结果分别断言 getter 计数及最终状态。由插件内部自行执行的代码或 Promise 自身在交给宿主前已经发生的同化，应另明确其无法控制的边界，不能冒称宿主未调用。

### R7-02 [P1 / 对外入口] 部分已导出工具仍执行或接收访问器

位置：`packages/kernel/src/index.ts:1-4`、`assemble.ts:138`、`plain.ts:47-61`。`index.ts` 通过 `export *` 把这些函数暴露为公开 API：

1. `squash` 对传入值直接读 `.replace`。传入带 `replace` getter 的对象，实测 getter 1 次，返回 getter 指定的结果，不是拒绝。
2. `appendOwn` 对非数组目标直接读 `.length`。传入带 `length` getter 的对象，实测 getter 1 次并继续写入。
3. `plainData` 的判定选项仅看 `topFunctions` 的描述符；选项对象另有一个自有 getter 时，getter 虽为 0 次，却返回 `ok:true`，没有按“遇到访问器拒绝”的合同拒绝。

要求：要么将纯内部 helper 从公开导出中撤出并限制可用边界，要么对公开入口先进行不触发访问器的类型/描述符检查并拒绝；判定选项须检查整个声明允许的对象而不只读取一个字段。分别测试 getter 与 setter、可枚举与不可枚举、合法参数和调用计数。诊断型 API 若有不同的“安全占位而非拒绝”合同，应明确区分并测试。

### R7-03 [P1 / 原型条件] 只读 `Object.prototype.then` 改变合法发送结果

位置：`packages/kernel/src/plugins.ts:168-202,245-260`。在隔离进程中仅向 `Object.prototype` **新增**不可写的 `then` 数据属性，值是接受 `resolve` 的函数；没有改写任何已有内置方法。正常异步渠道返回合法 `{action_id, receiptId}` 时，无污染对照确认成功；污染下 Promise 同化调用继承的 `then` 两次，调用方拿到字符串 `prototype-then` 而不是 `SendResult`，账本为 `delivery-unknown`。这是用户本轮要求检查的只读原型属性，而不是第 7 栏排除的“内置方法被改写”。

要求：对此类 Promise 同化边界做隔离/防护或明确拒绝不安全环境，不得把返回字符串当合法结果；补无污染对照、只读 `then`、触发次数、真实副作用次数及账本状态。若产品只能承诺六个描述符名和数组下标等较窄场景，应把限制准确写在可见契约中并与本轮验收要求对齐，不能以“内置方法改写不承诺”掩盖此反例。

### R7-04 [P1 / AC-08、AC-39] 导出的可变策略对象可改变撤回扫描和固定段顺序

位置：`packages/kernel/src/assemble.ts:53,98,136-138`。`INVISIBLE` 是被直接导出的同一个可变 `RegExp` 实例，`squash` 也直接使用它；`STABLE_ORDER` 是导出的数组，TypeScript 的 `readonly` 不会冻结运行时对象。独立进程先运行正常对照：撤回 `秘密口令` 后的会变状态 `秘\u0085密口令` 被拦截，倒序 `persona → system` 被拒绝。随后仅对 **导出的实例** 调用 `INVISIBLE.compile('x','g')` 和 `STABLE_ORDER.reverse()`，没有修改任何内置方法：相同撤回正文装配成功并出现在 tail，倒序固定段亦成功。复现后已恢复两个实例；源文件和被审 clone 不变。

要求使外部调用者拿不到可改变宿主判定的共享策略状态：如固定段顺序冻结或私有化，正则以不可变规范构造独立实例，或导出与内部状态分离的副本；补变更导出值前后的同一输入正负对照，明确宿主自身的策略不能被外部持有的对象改变。此反例不依赖改写 `RegExp.prototype`、`Array.prototype` 等内置方法，也不能由第 7 栏的内置改写范围外声明覆盖。

### R7-05 [P1 / R-05] 两个新的单点故障逃过全部测试

分别在普通独立临时 clone 里改一个注入点（没有改受审 clone），三者 typecheck 均退出 0：

- **R7-M1，存活**：`plain.ts` 的 `topFunctionsOf` 末行 `return d.value === true` 改为 `return true`。原版对 `{topFunctions:false}` 下的顶层函数拒绝；变异版放行。全仓测试仍 **191/191 绿**。现有测试只对未传选项和 `true` 做对照。
- **R7-M2，被杀**：`assemble.ts` 的预算比较 `need > budget` 改为 `need >= budget`。全仓 190 绿、1 红，被“预算恰好等于所需字节时装配成功”具名测试发现。
- **R7-M3，存活**：`assemble.ts` 页入条件移除 `paged.some((p) => p.seq === seq)`。对一个已压缩旧消息重复引用 `[1,1]`，原版页入 1 次、清单 1 条；变异版页入 2 次、清单 2 条，可能无谓占用预算。全仓测试仍 **191/191 绿**。已有重复引用测试是撤回消息，并未覆盖同一仍可见旧消息。

要求补 `topFunctions:false` 的单开关对照、同一仍可见压缩旧消息重复引用与清单/字节数断言，再把上述单点故障作为具名阳性校准；不要把作者预选变异 100% 杀死解读为充分证明。

### R7-06 [P1 / 对外输入] 通过普通数据校验的 `null` 仍会在多个入口抛异常

位置：`classify.ts:83-87`、`assemble.ts:156-168`、`plugins.ts:249-254`。`plainData(null)` 将 null 当作合法 JSON 值返回；这些入口随后直接将它强转为对象并读字段。独立实测 `classifyInbound(null, classifier)` 抛 `Cannot read properties of null (reading 'text')`；`assemble(null, opts)` 和 `assemble(log, null)` 分别在 `events`、`quotes` 处抛错；已注册渠道的 `send('p', null)` 在读取 `action_id` 时 Promise 拒绝而不是返回拒绝结果，插件实际调用 0 次。

要求在统一普通值校验之后、属性读取之前验证各入口所需的对象形状：分类返回 `Uncertain` 与违规，装配返回 `invalid-input`，发送返回明确拒绝且不触发插件/建立虚假账目。对 `null`、其他 JSON 基本值、正常对象分别做负例与阳性对照；不能只测试 getter 和 Proxy。

## 删除 K38 的核对

旧 K38 改的是 `safeDescribe` 的异常兜底分支。新脚本声称“safeDescribe 不再调用 `JSON.stringify`”，这句事实不准确：`plain.ts` 的 `render` 仍对字符串、符号描述等**基本类型**调用 `JSON.stringify`，只是不再把外部对象直接传给它或执行其 `toJSON`。我在独立副本把新 catch 改成重抛：typecheck 通过、191/191 测试绿；普通对象、循环、BigInt、已撤销 Proxy、getter/toJSON 等所测样例与原版相同且外部 getter/toJSON 调用 0。

隔离进程中若**改写内置** `JSON.stringify` 使其抛错，原版返回 `<无法描述>`、对照版抛错；该情形被第 7 栏明示排除，因此不构成承诺范围内反例。结论：删除理由里的“完全不调用 JSON.stringify”需更正；所测范围支持在未改内置、正常资源条件下两者相同，但不能据有限样例宣称兜底分支在所有可能环境中严格不可达。

## 八个门禁的独立负例

使用前一轮报告“各门禁负例完整夹具脚本”在本版独立 clone 重建临时 Git 仓库与会话目录，G-TRACE 状态改成另一无效值 `将要通过`；除逐门 `runGates` 检查预期问题外，每例另实跑完整 `run-all.ts --local` CLI。8/8 目标门禁均显示 ✗ 且各 CLI 退出 1：

| 门禁 | 负例 | 实际被目标门禁拒绝 |
|---|---|---|
| G-TRACE | 非四选一验收状态 | 状态非法 |
| G-REVIEW | 作者与审查者都填 Claude | 审查人与作者相同等 |
| G-PROVENANCE | 不存在的审查会话 | 审查会话不可信 |
| G-RED | 不存在的红提交 | 红提交不存在 |
| G-STUB | 只断言导入函数类型、不调用实现 | 空桩后未按名字失败 |
| G-TAUTO | `assert.equal(3,3)` | 恒真断言 |
| G-WORKFLOW | PR workflow 申请 `contents: write` | 申请写权限 |
| G-LAYER | plugin 导入另一 plugin | 插件层不能相互依赖 |

这是每门禁各一条独立负例，不证明门禁没有其他绕过。`G-PROVENANCE` 对本轮正式收据须等会话落盘后再核验。

## 最小复现（受审仓库根目录，`npm ci` 后）

下列脚本只在当前隔离 Node 进程中构造非法值与临时原型属性，结束前恢复，不访问网络；`pull` 与公开 helper 的打印是本版实际错误行为：

```sh
node --input-type=module <<'NODE'
import { createRegistry } from './packages/kernel/src/plugins.ts';
import { plainData, appendOwn } from './packages/kernel/src/plain.ts';
import { squash } from './packages/kernel/src/assemble.ts';
let pullGetter=0; const out={}; Object.defineProperty(out,'then',{get(){pullGetter++; return undefined}});
const r=createRegistry(); r.register({kind:'data-source',id:'p',sources:['g'],pull:()=>out});
const result=await r.pull('p','g'); console.log('pull',result.reason,'getter',pullGetter); // invalid-batch, 1
let helperGetter=0; const bad={}; Object.defineProperty(bad,'replace',{get(){helperGetter++; return ()=> '调用了';}});
console.log('squash',squash(bad),'getter',helperGetter); // 调用了, 1
let lengthGetter=0; appendOwn({get length(){lengthGetter++;return 0}},'x'); console.log('appendOwn getter',lengthGetter); // 1
let optionGetter=0; const options={}; Object.defineProperty(options,'other',{get(){optionGetter++;return 1},enumerable:true});
console.log('options accepted',plainData({x:1},'x',options).ok,'getter',optionGetter); // true, 0
NODE
```

```sh
node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';
const reg=createRegistry({sendTimeoutMs:100});let sent=0;
reg.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:async q=>{sent++;return {action_id:q.action_id,receiptId:'r'}}});
console.log('control',await reg.send('p',{action_id:'control',payload:'x'}));
let n=0,result,error;const d=Object.create(null);d.configurable=true;d.writable=false;d.value=function(resolve){n++;resolve('prototype-then')};
try{Object.defineProperty(Object.prototype,'then',d);result=await reg.send('p',{action_id:'polluted',payload:'x'})}catch(e){error=String(e)}finally{delete Object.prototype.then}
console.log({result,error,thenCalls:n,sent,ledger:reg.delivery('p','polluted')});
NODE
```

```sh
node --input-type=module <<'NODE'
import {INVISIBLE,STABLE_ORDER,assemble} from './packages/kernel/src/assemble.ts';
import {append,emptyLog} from './packages/domain/src/log.ts';
const u={kind:'user',id:'u'},t='2026-01-01T00:00:00Z';let log=append(emptyLog(),u,{kind:'message',text:'秘密口令'},t);log=append(log,u,{kind:'retract',target:1},t);
const opts={stable:[{kind:'system',text:'固定规则'}],quotes:[],volatile:'秘\u0085密口令',budgetBytes:1000};
console.log('撤回对照',assemble(log,opts));
const source=INVISIBLE.source,flags=INVISIBLE.flags;
try{INVISIBLE.compile('x','g');console.log('改变导出正则后',assemble(log,opts))}finally{INVISIBLE.compile(source,flags)}
const reversed={...opts,stable:[{kind:'persona',text:'风格'},{kind:'system',text:'规则'}],volatile:'无'};
console.log('倒序对照',assemble(log,reversed));
try{STABLE_ORDER.reverse();console.log('改变导出数组后',assemble(log,reversed))}finally{STABLE_ORDER.reverse()}
NODE
```

```sh
node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';import {classifyInbound} from './packages/kernel/src/classify.ts';import {assemble} from './packages/kernel/src/assemble.ts';import {append,emptyLog} from './packages/domain/src/log.ts';
const opts={stable:[{kind:'system',text:'规则'}],quotes:[],budgetBytes:1000},log=append(emptyLog(),{kind:'user',id:'u'},{kind:'message',text:'正常'},'2026-01-01T00:00:00Z');
for(const [name,fn] of [['classify null',()=>classifyInbound(null,()=> 'E1')],['assemble log null',()=>assemble(null,opts)],['assemble options null',()=>assemble(log,null)]]){try{console.log(name,fn())}catch(e){console.log(name,'THREW',e.message)}}
const r=createRegistry();let calls=0;r.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:async q=>{calls++;return {action_id:q.action_id,receiptId:'r'}}});try{console.log(await r.send('p',null))}catch(e){console.log('send null THREW',e.message,'calls',calls)}
NODE
```

# 第八轮：返修独立复审

**结论：reject。** 本轮审查普通独立 clone 的 `ad43546f64f696a63d152b2ee32fdc0077b7849c`。R7-01、R7-02、R7-04、R7-05、R7-06 的原样反例已按下文复测；R7-03 按用户 `g-group#2662` 缩小后的合同排除，不作为打回依据。但未改内置原型时，公开状态参数和时钟回调返回值仍会执行访问器或 Proxy，`appendOwn` 接受带访问器的数组；带自有访问器的已拒绝 Promise 虽先返回拒绝，随后会在默认 Node 进程触发未处理拒绝并退出。一个新造的单点故障也逃过全部测试。

## 审查身份、范围与基础结果

- 分支 `feat/kernel-plugins`，基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；普通独立 clone，Git 共用目录就是该 clone 的 `.git`。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`；审查会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 的模型 `gpt-6.1-terra`，分别属于 Anthropic 与 OpenAI。
- 在被审 clone 的仓库根目录实跑 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，标准输出**原样**为：

  ```text
  a0c64e77bb4192d61874f26d58133753b4de32ea2148874fe62091efbd9cdadd
  ```

  与作者声明完全一致。

| 检查 | 独立实测 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 检查 24 文件 |
| Node 25 `npm test` | 206 通过、0 失败、0 跳过，含 183 条 kernel 测试 |
| 红提交 `5236136a4dc6a3dc177b2478a51b655c6d3741d3` | 另一个普通独立 clone 安装后执行测试，退出 1；23 条旧测试通过、183 条 kernel 测试逐名失败、0 跳过；红绿 kernel 测试文件无差异，绿通过名与红失败名双向差集均为空 |
| 两个绿提交 `7d0ca09` 与 `cca84b0` | 四个实现文件 `assemble.ts`、`classify.ts`、`plain.ts`、`plugins.ts` 的 `git diff --quiet` 为 0 |
| 作者 161 个变异 | Node `v25.8.1`、`v22.22.0` 各独立运行一次：原样副本均 183 绿，161/161 被具名测试发现，0 存活、0 超时；K156、K157、K158 均被各自对应具名测试发现 |
| 自造单点变异 | 三个独立 clone 各注入一个故障，typecheck 均通过；2 个被具名测试发现，1 个存活，详见 R8-05 |
| `review=null` 的 `--local` | 退出 1，仅 `G-REVIEW` 报未审；`G-PROVENANCE` 因尚无 review 提前跳过，不是已核验来源 |
| 填写 reject 后 `--local` | 退出 1；`G-REVIEW` 按 reject 阻挡；`G-PROVENANCE` 当前报告已落盘会话找不到本轮 hash 调用、审查厂商认不出。命令和输出已在本轮实际运行；会话落盘后仍需复核门禁，当前不能宣称来源门禁通过 |
| 变异超时金丝雀 | Node 22 与 25 各跑一次，必卡子进程约 5.0 秒超时被杀；超时不计为变异杀死 |

收据仍将 AC-06/08/11/12/35/39 和 R-06 纵向路径列为未测；当前结果仅覆盖内核片段，不代表真实联系人运行时、外部渠道及完整用户故事已验收。

## 上轮问题复测及 K38

- **R7-01**：同步 then getter 对象、原生 Promise 自有 constructor getter 的上轮样例均返回 `invalid-batch`，getter 调用 0；普通数组和普通原生 Promise 均可拉取。但被拒绝 Promise 已经拒绝时仍有进程级问题，见 R8-04。
- **R7-02**：上轮假目标对象的 `length` getter、`squash` 的 `replace` getter、`plainData` 选项中的额外 getter 均拒绝且 getter 为 0；其他状态参数和真实数组仍有缺口，见 R8-01/02。
- **R7-03**：用户已明确只保证内置原型未被改写的环境。本轮不再以预先修改 `Object.prototype`、`Array.prototype`、`Promise.prototype` 或内置方法作为拒绝理由，既有防护与测试不等于扩张合同。
- **R7-04**：`STABLE_ORDER`、`EVENT_CODES` 已冻结；空白正则实例不再导出，只导出不可变 `INVISIBLE_SOURCE`。修改由规范文本另建的正则不改变宿主对 U+0085 混入撤回原文的拦截；倒序固定段仍拒绝。
- **R7-05**：`topFunctions:false` 下顶层函数被拒；同一可见压缩旧消息重复引用只页入一次，清单一条。K156/K157/K158 的独立变异结果见上表及日志。
- **R7-06**：分类、装配、发送的 null 反例分别给出 `Uncertain`、`invalid-input`、`invalid-payload`；序列化工具对 null 抛约定的受控 `TypeError`，未再出现上轮的无保护字段读取。`createRegistry(null)` 按无选项处理。各结论仅限所测入口与样例。
- 撤回空白 U+000B/U+0085/零宽字符，以及 B1 未知后窗口内重试、已确认回执复用、未知动作换渠道版本拒重试，独立样例均符合预期；不能以此替代运行时纵向验收。
- **K38 删除理由已更正**：脚本明确仍对基本类型调用 `JSON.stringify`，但不把外部对象交给它或执行其 `toJSON`，且仅声称有限样例和未改内置环境下的判断。我在独立 clone 把新 `safeDescribe` catch 改为重抛，typecheck 与 206 条测试均绿；普通对象、循环、BigInt、撤销 Proxy、getter/toJSON 样例原版和变异一致且外部 getter/toJSON 0 次。若隔离进程改写内置 `JSON.stringify` 使它抛错，两者有差异，但这属于用户排除的环境；以上不能证明所有可能环境中 catch 严格不可达。

## 必须返修

### R8-01 [P1 / 对外状态参数] `plainData` / `plainItems` 的路径参数可执行 getter 或 Proxy

位置：`packages/kernel/src/plain.ts:73-86,101,111-119,139-148`，函数从 `index.ts` 导出。独立传入的第二参数 `at` 是自有 `Symbol.toPrimitive` getter 的对象；`plainData({x:1}, at)` 实测 **getter 1 次并 `ok:true`**。把 `at` 换成有 `get` trap 的 Proxy，trap 1 次、仍 `ok:true`。对稀疏数组调用 `plainItems(array, at)` 虽返回拒绝，也在生成错误路径时先调用 getter 1 次。这些均未改任何内置原型。正常字符串路径的单开关对照通过。

影响限定在调用公开工具并传入非法路径参数的情形，不声称一般业务消息都能控制路径。这里的直接问题是状态参数被模板字符串隐式强转，违反“外部输入含状态参数出现访问器/Proxy 不调用即拒绝”。要求在任何插值/强转之前检查路径参数的原始类型；getter、setter、Proxy、null 等非法参数不触发外部代码，并提供受控拒绝和正常字符串对照。

### R8-02 [P1 / 对外状态参数] `appendOwn` 放行带访问器的真实数组并修改它

位置：`packages/kernel/src/plain.ts:47-51`。当前只检 `Array.isArray` 和目标本身不是 Proxy，没有检查目标数组的自有元素描述符及原型。对下标 0 为 getter/setter 的真实数组调用 `appendOwn(array,'z')`，实测访问器调用 0，但函数**没有拒绝**，长度由 1 变 2，写入了自有下标 1。`Array` 子类实例也被接受。原先“假对象带 length getter”的 R7-02 样例已拒绝，不能证明真实数组状态也拒绝。

要求按公开入口的实际合同检查调用方数组（含自有访问器、Proxy、非普通原型），非法时不调用访问器且不写入；对合法普通数组保留阳性对照。若不打算支持外部调用，应收紧导出并明确证明其只能接收宿主自建数组，而不是继续以公开函数宣称普通数组合同。

### R8-03 [P1 / 时钟状态与回调] 非数字时钟结果可触发访问器、伪造时间或抛出

位置：`packages/kernel/src/plugins.ts:238,265-273`。这是由调用方显式注入 `RegistryOptions.now/monotonic` 回调并使其返回非法对象的复现，**不是说普通外部消息自动能控制宿主时钟**：

1. `now()` 返回带 `Symbol.toPrimitive` getter 的对象；`pull` 在 `new Date(now())` 中执行 getter 1 次，仍 `ok:true`，收到时间被记为 `1970-01-01T00:00:00.000Z`。
2. B1 第一次 `monotonic()` 返回带 getter 的对象，首次发送结果未知；第二次返回数字，`reading < prior.maxMonotonic` 又将上次对象强转，getter 执行 1 次。若 getter 抛错，第二次 `send` 的 Promise 直接抛错而不是安全返回 `clock-untrusted`；首次实际插件调用 1 次、账本仍为 `delivery-unknown`。

Node 22.22.0 与 25.8.1 独立进程均复现；没有改内置原型。要求验证时钟结果是有限数字后才转换、存储或比较；已不可信状态不得在后续比较中重新执行外部值。对 getter、Proxy、null、非有限数字、恢复读数与合法时钟做单开关对照，并保证无法确认结果时不误重发、不把伪造时间盖章成成功。

### R8-04 [P1 / AC-35] 拒绝异常 Promise 后仍有未处理拒绝，可终止宿主进程

位置：`packages/kernel/src/plugins.ts:33-36,187-189,232-237`。在**没有额外 `unhandledRejection` 处理器**的独立进程里，插件返回一个已拒绝的原生 Promise，并在该 Promise 实例上定义自有 `then` 或 `constructor` getter；内置原型未修改。`send` 先返回 `non-promise-send` / `delivery-unknown`，`pull` 先返回 `invalid-batch`，getter 均为 0；随后未处理的 Promise 拒绝使 Node 默认策略下进程**退出 1**。同样的已拒绝普通 Promise（无自有访问器）作为对照，分别得到 `send-threw` / `pull-failed`，进程退出 0。Node 22.22.0 与 25.8.1 下 `then` 访问器的发送与拉取四个子进程均复现；Node 25 的 `constructor` 访问器也复现。

要求连同进程级观察验证“安全拒绝”：非法返回不读取 getter、不留下未处理拒绝，也不能把进程退出伪装为已安全返回；对已拒绝/稍后拒绝、then/constructor 访问器、合法已拒绝 Promise、发送账本和拉取结果分别作正负对照。若所用原生 Promise 形态无法在不触发访问器时安全观察，应调整外部回调边界或隔离执行，不应只断言返回值。

### R8-05 [P1 / R-05] 自造变异暴露非枚举数组元素的测试空缺

在独立临时 clone 对各注入点只改一次，未改受审仓库：

- **R8-M1，被杀**：删除 `appendOwn` 的 Proxy 拒绝条件；typecheck 0，全仓 205 绿 / 1 红，被目标数组 Proxy 的具名测试发现。
- **R8-M2，存活**：删除 `plain.ts` 中 `items` 对**数组下标** `!d.enumerable` 的拒绝；typecheck 0，全仓仍 206/206 绿。对自有下标 0 是不可枚举数据属性的数组，原版 `plainItems` / `plainData` 均拒绝，变异版均 `ok:true`。这是测试缺口，**不是说本版已经放行该值**；现有不可枚举正例只覆盖对象字段。
- **R8-M3，被杀**：将装配字节数从 UTF-8 `Buffer.byteLength` 改为 `s.length`；typecheck 0，全仓 200 绿 / 6 红，包括页入清单与实际字节数的具名测试。

要求为不可枚举数组元素补普通数组阳性与该单点故障阴性对照，分别覆盖 `plainItems`、`plainData` 和实际使用拉取数组的入口；不能把预选 161 个变异全杀等同所有形态都有防护。

## 每个门禁一条独立负例

按第六轮完整夹具脚本在本版独立 clone 中重建八个临时 Git 仓库和伪会话；本轮换了非法状态、缺失红提交和恒真常量等具体输入。每例单独调用目标 `runGates` 并实际运行完整 `run-all.ts --local` CLI：8/8 目标门禁显示 ✗ 且各 CLI 退出 1。单个夹具可能同时触发其他门禁，这不是对其他门禁正例的证明。

| 门禁 | 负例 | 目标结果 |
|---|---|---|
| G-TRACE | 收据状态 `接近通过` | 非四选一 |
| G-REVIEW | 作者和审查者均为 Claude | 同一审查人与作者 |
| G-PROVENANCE | `codex:does-not-exist-r8` 空会话 | 审查会话不可信 |
| G-RED | 不存在的全 `f` 红提交 | 红提交不存在 |
| G-STUB | 测试只断言导入函数类型 | 空桩未按名字失败 |
| G-TAUTO | `assert.equal(7,7)` | 恒真断言 |
| G-WORKFLOW | workflow 申请 `contents: write` | 申请写权限 |
| G-LAYER | plugin 导入 plugin | 插件层不能互相依赖 |

## 最小复现（受审仓库根目录，`npm ci` 后）

以下仅在当前进程创建临时值，不修改任何内置原型、不联网；打印的是本版实际行为：

```sh
node --input-type=module <<'NODE'
import {plainData,plainItems,appendOwn} from './packages/kernel/src/plain.ts';
let gets=0;const label={};Object.defineProperty(label,Symbol.toPrimitive,{get(){gets++;return ()=> '路径'}});
console.log('plainData',plainData({x:1},label),'getter',gets); // ok:true, 1
gets=0;console.log('plainItems',plainItems(new Array(1),label),'getter',gets); // 拒绝, 1
let traps=0;const proxy=new Proxy({}, {get(_t,k){traps++;return k===Symbol.toPrimitive?()=> '路径':undefined}});
console.log('path Proxy',plainData({x:1},proxy),'traps',traps); // ok:true, 1
let n=0;const a=[];Object.defineProperty(a,'0',{enumerable:true,get(){n++;return 'x'},set(_){n++}});
appendOwn(a,'z');console.log('appendOwn',{length:a.length,own1:Object.hasOwn(a,1),accessorCalls:n}); // 2,true,0
NODE
```

```sh
node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';
const ev={nativeId:'m',sourceVersion:'v',eventType:'create',author:'a',content:'hello',occurredAt:'2026-01-01T00:00:00Z',attachments:[]};
let nowGets=0;const clock={};Object.defineProperty(clock,Symbol.toPrimitive,{get(){nowGets++;return ()=>0}});
const a=createRegistry({now:()=>clock});a.register({kind:'data-source',id:'p',sources:['g'],pull:()=>Promise.resolve([ev])});
const pulled=await a.pull('p','g');console.log('now',{ok:pulled.ok,receivedAt:pulled.events?.[0].receivedAt,nowGets});
let monoGets=0;const state={};Object.defineProperty(state,Symbol.toPrimitive,{get(){monoGets++;throw Error('时钟访问器被执行')}});let reads=0,calls=0;
const b=createRegistry({monotonic:()=>reads++===0?state:1});b.register({kind:'outbound-channel',id:'b',endpoint:'A',idempotency:'action-id',idempotencyWindowMs:1000,send:()=>{calls++;return Promise.reject(Error('未知'))}});
console.log('first',await b.send('b',{action_id:'a',payload:'x'}));try{await b.send('b',{action_id:'a',payload:'x'})}catch(e){console.log('second throws',e.message)}console.log({monoGets,calls,state:b.delivery('b','a').state});
NODE
```

下列脚本故意运行两个将以 1 退出的隔离子进程，先打印拒绝结果，再由未处理拒绝终止；不应在生产宿主直接运行：

```sh
for mode in send pull; do
 MODE="$mode" node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';
let gets=0;const pending=Promise.reject(Error('外部 Promise 失败'));Object.defineProperty(pending,'then',{get(){gets++;throw Error('不应读取')}});
const r=createRegistry();if(process.env.MODE==='send')r.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:()=>pending});else r.register({kind:'data-source',id:'p',sources:['g'],pull:()=>pending});
const result=process.env.MODE==='send'?await r.send('p',{action_id:'a',payload:'x'}):await r.pull('p','g');console.log({mode:process.env.MODE,reason:result.reason,getterCalls:gets});setTimeout(()=>console.log('alive'),30);
NODE
 echo "$mode 子进程退出码: $?"
done
```

## 用户追加核对：v3.12 五块重拼、AC-39② 与 AC-40 坏实现⑪

### 结论与版本边界

**不符合 v3.11/v3.12 的五块重拼方向；但本 PR 是内核契约桩，五块尚未实现在本片不单独作为代码打回理由，也不能据此判端到端通过或失败。收据对装配口径的描述须在合并前更正。** 本轮原始受审 HEAD 为 `ad43546f64f696a63d152b2ee32fdc0077b7849c`；该 HEAD 自带 `docs/spec/需求文档.md` 是 **v3.2 审查稿**，其验收文档的 AC-39② 仍写“旧历史只追加”。这是本 PR 当前行为的旧文档来源，并非用户追加指定的 v3.12。

时间线与对照：受审装配器最后一次修改为 `cca84b0ef169c7419a5507df54fd3420a3bfca1d`（11-06 14:20:33 +08:00），早于文档分支 `39e6da5f42fc09cab2014b650ab8adcd49f31f97` 的 v3.11（14:42:49 +08:00）。我独立比较 v3.11 与 v3.12：D06 第 2 小节和 AC-39 行逐字一致，AC-40 坏实现⑪逐字一致；AC-40 整行另有变化，不能称整行相同。用户指定的对照文档为文档分支已推送提交 `36180ef7188a15c65689fec4a19e5b8ae201d699` 的 **v3.12 审查稿（非批准版）**；独立冻结了两个文件并核对与该提交字节一致：`需求文档.md` SHA-256 `f1949a5a3cdfd8e491c51f9b74b50c8b2f5cea35260ef362de1c94a76a095bc0`，配套 `验收文档-v0.1.md` SHA-256 `9ecb8c08eacf103c66a64b272a840911fa2332818a15ba6ce72478e7879b237a`。文档分支是对照真源，未把它合并进受审代码或改变本次内容 hash。

- [v3.12 D06 第 2 小节，第 682–701 行](https://github.com/SammySnake-d/g-group/blob/36180ef7188a15c65689fec4a19e5b8ae201d699/docs/spec/需求文档.md#L682-L701)要求每轮由宿主重拼：①固定前缀（含当前确认规矩与纠正原文）；②未了结承诺的原文/索引；③状态笔记；④ `processed_seq` 之后的新消息原文；⑤指针和按需取回。**同一轮内**的工具往返要保留本轮工具调用与结果。D23 第 9 小节同时说明方向已定、五块具体顺序仍是待审方案；此处按用户明确指定的 v3.12 做差异核对，不把候选顺序擅称为用户已批准的每个细节。
- [v3.12 验收文档 AC-39② / AC-40 坏实现⑪，第 159–160 行](https://github.com/SammySnake-d/g-group/blob/36180ef7188a15c65689fec4a19e5b8ae201d699/docs/spec/验收文档-v0.1.md#L159-L160)要求稳定前缀之后的账本、状态笔记、新消息每轮重拼；实际发出的第 N 轮请求若含五块以外旧消息、账本非原文，或同轮工具往返丢调用与结果，列为坏实现。AC-40 末列对当前必过与候选子项作区分，未在末列单独写明⑪的归类；不据此虚构其批准状态。

### 本 PR 实际实现与收据

1. [受审 `assemble.ts:18–48,231–265`](https://github.com/SammySnake-d/g-group/blob/ad43546f64f696a63d152b2ee32fdc0077b7849c/packages/kernel/src/assemble.ts#L231-L265)只声明 `stable / history / tail`：先放压缩块，再按 seq 追加压缩点之后所有可见消息/编辑，再将引用页入与 `volatile` 放 tail。`AssembleOptions` 没有 `processed_seq`、承诺账本或状态笔记等独立字段，也没有同一轮工具调用/结果接口；不能证明按五块逐轮重拼、逐字保留账本或同轮工具往返。调用方可以自行往通用字符串放内容，但该接口没有提供或校验对应的五块语义与顺序。
2. [受审 `assemble.ts:315–332`](https://github.com/SammySnake-d/g-group/blob/ad43546f64f696a63d152b2ee32fdc0077b7849c/packages/kernel/src/assemble.ts#L315-L332)的 `prefixLength` 和默认 `prefixHash` 把全部 `stable + history` 计入前缀；压缩块或后续历史变化会改变默认前缀 hash，与 v3.12 只以固定前缀为稳定边界、之后每轮重拼的口径不一致。`prefixHash` 确实允许调用方额外传字节数，因而可以**手工**只哈希 stable；但这不等于当前默认接口已建立 v3.12 的规则原文边界或完成命中率验收。
3. [受审收据 AC-39](https://github.com/SammySnake-d/g-group/blob/ad43546f64f696a63d152b2ee32fdc0077b7849c/receipts/feat-kernel-plugins.json#L49-L54)整体标“未测”，R-06 也承认无纵向路径，这部分边界如实；但其已过子判据仍称“②只追加、旧历史保留”，这是 v3.2 的旧标准，**不能作为 v3.12 AC-39② 已通过的证据**。本收据没有 AC-40 项。受审 HEAD 的 `G-TRACE` 从本仓库验收文档提取代号，且只检查代号/状态/证据路径；其绿灯既未换用 v3.12，也不证明 AC-39/40 语义已实现。

### 独立装配探针及交付边界

我在 `ad43546` 的普通独立 clone 构造三条消息：#1 已压缩，#2 假定已处理且没有被引用，#3 是本轮新消息；压缩点设为 1、引用为空。传入**仅作诊断的未声明附加字段** `processedSeq:2`，实际 `history` 仍包含 #2 和 #3；把诊断字段改为 3，序列化结果完全不变。实际 stable 长度为 22 字节，`prefixLength` 却为 128 字节；只改压缩块文本时，手工按 22 字节算的 stable hash 不变，默认 `prefixHash` 改变。说明该接口当前无法表达或执行“按处理游标筛本轮新消息”的合同，且默认把变化的 history 当作前缀。

若未来 runtime 将这次装配结果直接用于实际 provider 请求，则在该夹具假设（#2 不属于账本、状态、新消息或按需引用）下，会出现 AC-40⑪ 所描述的五块之外旧消息；**本轮没有实际联系人/模型请求观察，因此这只是有条件的集成风险，不报告成端到端已实测失败**。同轮工具往返、账本原文、真实缓存命中和处理游标的持久化也都未在本 PR 证明。

### R8-06 [合并前须更正收据 / D06、AC-39②、AC-40⑪] 新旧口径差异与后续切片

**范围判定**：本片不负责实现依赖 D23 承诺账本、状态笔记与 `processed_seq` 的完整五块重拼；仅因本片还没有实现五块，不单独打回本 PR。AC-39、AC-06 和 R-06 整项在收据里均为“未测”：本片的页入/预算测试只证明所测装配子行为，不能据此说任一项端到端已通过或失败。当前装配器与 v3.11/v3.12 的 **AC-39②** 不一致；**AC-40 坏实现⑪** 要看实际 provider 请求、账本原文和同轮工具往返，本片无该观测，不能判实测通过或失败。上述差异不改变 R8-01–R8-05 各自独立的拒绝结论。

**合并前收据修正**：当前收据称本片装配“按需求 D22 / AC-39”，但具体子判据仍是 v3.10 及以前的“三段式、历史只追加”口径，不能让人误读为符合 v3.11 的 AC-39② 或 AC-40⑪。作者须将其明确写为旧口径、保留整项未测、点名哪个后续切片负责五块重拼及其依赖；本次已有其他拒绝项，这个收据澄清并入返修即可。此审查提交不代改收据中作者负责的字段。

**后续交付，非已完成承诺**：Claude Code 在 `g-group#2806` 说明拟在 D23 账本切片之后单独交付五块重拼，先红后绿、再跨厂商审查；届时应覆盖已处理旧消息未引用不进入本轮、新消息进入、规矩/承诺原文与固定前缀、同轮工具往返和实际 provider 请求。收据内容改动会改变 `CONTENT_HASH`；待作者推送明确的新 HEAD 与新 hash 后，审查者须重新在独立 clone 实跑 hash 并审查对应改动，不能沿用本轮 `a0c64e77…`。

复现（`processedSeq` 故意作为诊断附加字段，**不是此版本已声明的参数**）：

```sh
node --input-type=module <<'NODE'
import {assemble,prefixLength,prefixHash,serialize} from './packages/kernel/src/assemble.ts';import {append,emptyLog} from './packages/domain/src/log.ts';
const u={kind:'user',id:'u'},t='2026-01-01T00:00:00Z';let log=emptyLog();for(const text of ['已压缩的旧消息','已经处理的旧消息','本轮尚未处理的新消息'])log=append(log,u,{kind:'message',text},t);
const base={stable:[{kind:'system',text:'固定规则'}],compressed:{throughSeq:1,builtAtSeq:3,text:'旧摘要'},quotes:[],budgetBytes:4000};
const a=assemble(log,{...base,processedSeq:2}),b=assemble(log,{...base,processedSeq:3}),c=assemble(log,{...base,compressed:{...base.compressed,text:'更新摘要'},processedSeq:2});
const stableBytes=a.request.segments.filter(s=>s.section==='stable').reduce((n,s)=>n+s.bytes,0);
console.log({segments:a.request.segments.map(s=>({section:s.section,label:s.label,seq:s.seq,text:s.text})),cursor2vs3Same:serialize(a.request)===serialize(b.request),stableBytes,prefixLength:prefixLength(a.request),stableHashSame:prefixHash(a.request,stableBytes)===prefixHash(c.request,stableBytes),defaultPrefixHashSame:prefixHash(a.request)===prefixHash(c.request)});
NODE
```

# 第九轮：返修独立复审

**结论：reject。** 第八轮路径、数组、时钟、非枚举测试和装配收据的原反例在独立样例中已修；被拒 Promise 的自有 `then` getter 情形也已修。但在不改任何内置原型、且没有 `unhandledRejection` 处理器的默认 Node 进程里，带自有 `constructor` getter 的已拒绝/稍后拒绝 Promise 仍能在返回拒绝后终止进程。用户 `g-group#2662` 只排除预先修改内置原型的环境，没有批准将外部返回值的访问器或 Proxy 触发进程退出排除在安全拒绝之外；仅在收据披露未来需隔离，不能把该结果当成本片已安全拒绝。另有自有普通 `constructor` 数据属性、Promise 子类和 Promise Proxy 的同类未处理拒绝；自造三个单点故障中两个逃过测试。

## 审查身份、范围与基础结果

- 被审 HEAD `7e6aebc2360d2af5ef11175f285919328ed7a8f7`，基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`；独立 HTTPS 普通 clone，`.git` 与 common dir 为同一目录。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`；审查会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 模型 `gpt-6.1-terra`，作者与审查分别为 Anthropic 与 OpenAI。
- 在独立 clone 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，标准输出**原样**为：

  ```text
  f4f9d769e128900f0e1fbe13fe23ad3d31ed0105e4ff50bfdc11024d7478f31b
  ```

  与作者声明完全一致。

| 检查 | 本轮独立结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 25 文件 |
| Node 25 `npm test` | 221 通过、0 失败、0 跳过，其中 kernel 198 条 |
| 红提交 `0dd6dade772f70a3a2fb25a9be73cc273264adcd` | 另建普通独立 clone、安装后测试退出 1；23 条旧测试通过、198 条 kernel 测试逐名失败、0 跳过。红绿 kernel 测试文件无差异，失败名和绿测试名双向差集均为空 |
| 绿提交 `2bd57e8` 与 `a8b8849` | `assemble.ts`、`own.ts`、`plain.ts`、`plugins.ts`、`plugin-contract.ts` 的 `git diff --quiet` 退出 0 |
| 作者 176 个变异 | Node `v25.8.1`、`v22.22.0` 各独立运行一次：原样副本均 198 绿，176/176 被具名测试发现、0 存活、0 超时；K173、K174、K175 均被各自具名测试发现 |
| 自造单点变异 | 三个独立 clone 中各注入一个故障，typecheck 均通过；1 个被具名测试发现、2 个存活，见 R9-02 |
| 未填 review 的 `--local` | 退出 1；`G-REVIEW` 报未审，`G-RED/G-STUB/G-TAUTO` 等显示绿。`G-PROVENANCE` 因 review 为 null 提前跳过，不能解读成来源已验 |
| 填写 reject 后的 `--local` | 退出 1；`G-REVIEW` 按 reject 阻挡；`G-PROVENANCE` 当前报告已落盘会话找不到本轮 hash 调用且审查厂商认不出。hash 已在本轮独立 clone 实际运行，会话落盘后仍须复核，当前不得报来源门禁已通过 |
| 变异超时金丝雀 | Node 22 和 25 各运行一次，必卡子进程约 5.0 秒超时被杀；超时不算变异杀死 |

## 第八轮逐项复测与边界

- **R8-01**：`plainData` / `plainItems` 的路径参数传自有 `Symbol.toPrimitive` getter 或 Proxy，均拒绝，getter/陷阱调用 0；正常字符串路径对照通过。
- **R8-02**：`appendOwn` 对带 getter/setter 下标的真实数组拒绝且不写入、访问器 0；Array 子类也拒绝；普通数组照常追加。`own.ts` 未从包入口导出，包 `exports` 只公开 `.`。
- **R8-03**：墙钟返回带 getter 的非数字时，拉取和首次发送均 `clock-invalid`，发送插件 0 次、不建账目、访问器 0；单调读数非法时首次只投递一次、记录宿主 NaN 并永久不重试，恢复数字后为 `clock-untrusted`，不读取非法值访问器。
- **R8-04**：原生 Promise 仅有自有 `then` getter 时，已拒绝和稍后拒绝两种在 Node 22 与 25 的发送/拉取独立子进程均安全返回并存活、getter 0；普通已拒绝 Promise 作为对照也存活。但自有 `constructor` getter 等情况仍有进程级问题，详见 R9-01。
- **R8-05**：不可枚举数组下标在 `plainItems` 和 `plainData` 被拒；K174 的独立变异结果见上表。
- **R8-06**：收据 AC-39 已明确本片是 v3.10 三段式，不满足 v3.11/v3.12 AC-39②，AC-40⑪无实际 provider 观测；五块重拼写为 D23 账本之后的后续独立切片，非已完成承诺。AC-06、AC-39 和 R-06 均标未测；不因本片没有完成五块或完整端到端链路本身打回。
- 受测 `null`：`plainData(null)` 保留 null，业务分类返回 `Uncertain`，装配返回 `invalid-input`，发送返回 `invalid-payload`，拉取返回 `invalid-batch`；`appendOwn(null)` 和 `squash(null)` 按其工具合同抛受控 `TypeError`，不把这两种受控拒绝记为上述业务路径未捕获异常。
- 未以修改 `Object.prototype`、`Array.prototype`、`Promise.prototype` 或其他内置对象的环境作为拒绝理由；本轮反例仅修改单个外部 Promise 实例或创建子类/Proxy，没有预先改内置原型。

## 必须返修

### R9-01 [P1 / AC-35、R8-04] 被拒 Promise 仍可产生未处理拒绝并终止进程

位置：`packages/kernel/src/plugins.ts:34–47,214–216,258–266`。`quietRefused` 只对原型恰为 `Promise.prototype` 且没有自有 `constructor` 的 Promise 附加拒绝处理。带自有 `constructor` getter 的 Promise 被主动跳过处理；这与作者的第 7 栏披露一致，但 **#2662 的缩小范围只排除事先改写内置原型，不排除外部返回值自有访问器**。R8-04 要求的不只是入口先返回拒绝，还包括拒绝后宿主进程不因该返回值退出；当前没有插件进程隔离或其他已验证的保护，披露后续隔离不能冒充当前防住。

独立按 Node `v22.22.0` / `v25.8.1`、`send` / `pull`、立即 / 稍后拒绝以及 6 种返回形态运行 **48 个隔离子进程**；不安装全局 `unhandledRejection` 处理器，也不改内置原型：

| 返回形态 | 最初结果 / 外部访问器 | 子进程 |
|---|---|---|
| 普通原生 Promise | `send-threw` / `pull-failed` | 8/8 退出 0 |
| 自有 `then` getter 的原生 Promise | `non-promise-send` / `invalid-batch`；getter 0 | 8/8 退出 0 |
| 自有 `constructor` getter 的原生 Promise | 同上；getter 0 | 8/8 退出 1 |
| 自有 `constructor` **数据属性**、值就是内置 `Promise` | 同上；无外部 getter | 8/8 退出 1 |
| Promise 子类 | 同上 | 8/8 退出 1 |
| 包装已拒绝 Promise 的 Proxy | 同上；Proxy get trap 0 | 8/8 退出 1 |

进程退出的条件是返回 Promise 拒绝、Node 采用默认未处理拒绝策略且宿主未安装相应处理器；不声称所有部署都配置如此。插件自身可执行任意代码而隔离未交付也是现实边界，但本例是**插件把结果交给内核后，内核拒绝该返回值却未处理其拒绝**；不能用“getter 没被调用”替代进程存活。

对作者称“constructor getter 不读便无法使用普通挂处理方式”的技术点：用已解决 Promise 的隔离对照实测 `Promise.prototype.then.call`、`Promise.resolve`、`await` 都各读该自有 getter 一次；这证明这三个直接办法不能同时满足不读 getter，但**不是所有可能架构均不可能的证明**。更具体地，对自有 `constructor` **数据属性**值恰为内置 `Promise` 的已拒绝原生 Promise，直接 `Reflect.apply(Promise.prototype.then, p, [undefined, ()=>{}])` 在 Node 22/25 各自退出 0；当前代码因只看 `Object.hasOwn` 而一律跳过，此可安全处理的子情况不应与访问器不可直接处理混为一谈。

要求补齐可安全判定的原生 Promise 情况（含自有数据 constructor），并对 getter、子类、Proxy 等无法在现合同下安全观察的情况提供经实际验证的安全拒绝/隔离边界；如要把进程存活排除在合同外，须由用户明确批准范围和集成前保护，不能仅凭作者披露视为已批准。测试需包含立即/稍后拒绝、发送/拉取、getter/Proxy 调用计数、结果状态、无全局处理器子进程存活及普通 Promise 阳性对照。

### R9-02 [P1 / R-05] 两个自造单点故障逃过 221 条测试

三个变异分别在普通独立临时 clone 中精确替换一个注入点，未改受审源码；typecheck 均退出 0：

- **R9-M1，存活**：`isoOf` 中 `Number.isFinite(ms)` 错改为 `Number.isInteger(ms)`。对有效墙钟 `now() => 0.5`，原版正常发送一次；变异版错误返回 `clock-invalid`、发送 0 次。全部 221 条测试仍绿。合同是有限数字，不只整数。
- **R9-M2，被杀**：去掉 `plainItems` 的路径参数类型检查；221 条中 220 绿、1 红，被路径 getter/Proxy 的具名测试发现。
- **R9-M3，存活**：去掉 `isPlainPromise` 对 `Object.getPrototypeOf(x) === Promise.prototype` 的检查。对已解决 Promise 子类，其自有静态 `Symbol.species` getter 会抛错：原版 `non-promise-send`、getter 0；变异版 `send-threw`、getter 1。全部 221 条测试仍绿。这里的 getter 属于新建子类，不是事先修改内置原型。

要求为有限小数墙钟补正例与整数化单点故障负例；为 Promise 子类及其自有 `Symbol.species` getter 补计数与不执行对照。作者列出的 176 种故障全杀仅证明这些选定注入点，不证明新边界均有测试。

## 八个门禁的独立负例

依照报告第六轮完整夹具脚本在本版独立 clone 中重建八个临时 Git 仓库与伪会话；逐门调用实际 `runGates` 检查原因，并逐例运行真实 `run-all.ts --local`。8/8 目标门禁均显示 ✗ 且 CLI 各退出 1；一个夹具可能同时触发其他门禁，不据此称其他门禁通过。

| 门禁 | 本轮负例 | 目标结果 |
|---|---|---|
| G-TRACE | 状态 `核验中` | 非四选一 |
| G-REVIEW | 作者和审查者均为 Claude | 同一审查人与作者 |
| G-PROVENANCE | `codex:does-not-exist-r9` 空会话 | 审查会话不可信 |
| G-RED | 不存在的全 `e` 红提交 | 红提交不存在 |
| G-STUB | 测试只断言导入函数类型 | 空桩未按名字失败 |
| G-TAUTO | `assert.equal(9,9)` | 恒真断言 |
| G-WORKFLOW | workflow 申请 `contents: write` | 申请写权限 |
| G-LAYER | plugin 导入 plugin | 插件层不能互相依赖 |

## 进程级最小复现（受审仓库根目录，`npm ci` 后）

本脚本在当前 shell 中启动隔离 Node 子进程，不改内置原型、不访问网络；`then` getter 应安全退出 0，其余列出的拒绝 Promise 形态在默认策略下会先打印拒绝再退出 1。不要在生产宿主直接运行：

```sh
for mode in send pull; do
 for shape in then-getter ctor-getter ctor-data subclass proxy; do
  MODE="$mode" SHAPE="$shape" node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';
let gets=0,traps=0;class Sub extends Promise{};const T=process.env.SHAPE==='subclass'?Sub:Promise;
const raw=new T((_,reject)=>reject(Error('外部拒绝')));
if(process.env.SHAPE==='then-getter')Object.defineProperty(raw,'then',{get(){gets++;throw Error('不得读 then')}});
if(process.env.SHAPE==='ctor-getter')Object.defineProperty(raw,'constructor',{get(){gets++;throw Error('不得读 constructor')}});
if(process.env.SHAPE==='ctor-data')Object.defineProperty(raw,'constructor',{value:Promise});
const pending=process.env.SHAPE==='proxy'?new Proxy(raw,{get(t,k,r){traps++;return Reflect.get(t,k,r)}}):raw;
const reg=createRegistry();if(process.env.MODE==='send')reg.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:()=>pending});else reg.register({kind:'data-source',id:'p',sources:['g'],pull:()=>pending});
const result=process.env.MODE==='send'?await reg.send('p',{action_id:'a',payload:'x'}):await reg.pull('p','g');console.log({mode:process.env.MODE,shape:process.env.SHAPE,reason:result.reason,gets,traps});setTimeout(()=>console.log('进程存活'),30);
NODE
  echo "$mode/$shape 子进程退出码: $?"
 done
done
```

在单独进程中，对自有 `constructor` **数据属性**等于 `Promise` 的情况，挂拒绝处理可以在不访问外部 getter 时成功：

```sh
node --input-type=module <<'NODE'
const p=Promise.reject(Error('预期拒绝'));Object.defineProperty(p,'constructor',{value:Promise});
Reflect.apply(Promise.prototype.then,p,[undefined,()=>{}]);setTimeout(()=>console.log('进程存活'),20);
NODE
```

# 第十轮：返修独立复审

**结论：reject。** 第九轮所列普通受支持 Promise 形态与小数时钟在独立样例中通过，但一个**未被用户排除且可安全处理**的形态仍会使进程退出：原生 Promise 的自有 `constructor` 是不可配置、**可写**、值不为内置 `Promise` 的数据属性。实现要求临时描述符 `configurable:true`，覆盖失败后不挂拒绝处理；Node 默认策略下先返回拒绝、随后因未处理拒绝退出。按用户 `g-group#3140` 的原话，排除的是 Proxy、不可配置 **getter**、冻结子类，并不包括此可写数据属性；本轮没有修改内置原型。另有两个自造单点故障逃过现有测试。

## 审查对象、来源与独立结果

- 审查 HEAD `f427a119b1e78034872b4b4348b8fc98134f1e32`，基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`。采用普通独立 HTTPS clone，Git common dir 为该 clone 自己的 `.git`；未在共享 linked worktree 执行钩子。作者会话 `claude:91b17b26-1e2d-4bc5-904f-9d3aab1e0f38`，审查会话 `codex:7d29bd3e-c4cd-4e15-ad0b-298bd0301bd3`，本轮原生 `turn_context` 模型 `gpt-6.1-terra`；作者与审查分别为 Anthropic、OpenAI。
- 在独立 clone 仓库根目录实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，标准输出**原样**为：

  ```text
  1e2a4f2df6dfb97b0d797a7fe61b16efc51151a0d091dc8c782d2f27624690b0
  ```

  与作者声明一致。

| 检查 | 独立结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；lint 25 文件 |
| `npm test` | Node 25.8.1 与 22.22.0 各 227 通过、0 失败、0 跳过，含 kernel 204 条 |
| 红提交 `afa8e50b499af531674a9c58a22f066e60dbb82b` | 独立 clone 安装后测试退出 1；23 条旧测试通过、204 条 kernel 测试逐名失败、0 跳过；红绿 kernel 测试文件无差异，绿测试名与红失败名双向差集为空 |
| 返修实现 | `dde651d` 与 `2d4fcf9` 的 `plugins.ts` 无差异；`a8b8849` 与 `12ffe52` 的五个实现文件无差异 |
| 作者 185 个变异 | Node 25.8.1：原样 204 绿，185 杀死 / 0 存活 / 0 超时；Node 22.22.0：原样 204 绿，185 杀死 / 0 存活 / 0 超时 |
| 重点变异 | Node 22.22.0 与 25.8.1 各独立检验 K177、K188–K196 共 10 个，均被原样通过的具名测试杀死 |
| 自造单点故障 | 三个隔离 clone 各注入一个故障，typecheck 均通过；1 个被具名测试发现，2 个存活，见 R10-02 |
| `review=null` 的 `--local` | 退出 1，`G-REVIEW` 报未审；`G-RED/G-STUB/G-TAUTO` 等显示绿。`G-PROVENANCE` 在 review 为 null 时提前跳过，不能当成来源已核验 |
| 填写 reject 后 | 分别对实际 `runGates` 调用两项：`G-REVIEW` 按 reject 阻挡；中断前的审查轮次落盘后重新核验，`G-PROVENANCE` 通过。此处是两门的定向复核，不冒称完整 `--local` 已通过 |
| 必卡金丝雀 | Node 22.22.0 与 25.8.1 各运行 `node packages/kernel/proof/mutations.mjs --canary-hang`：均约 5.0 秒超时杀组、正确记超时不计杀死，命令退出 0 |

## 返修与验收编号核对

- R9-02：有限小数墙钟、Promise 子类静态 `Symbol.species` getter 原反例及路径参数对照已补测试；K188、K189 与 K177 对应检查见上表。
- R9-01：在 Node 22/25，各测 `send/pull × 已拒绝/稍后拒绝`。自有 then getter、可配置 constructor getter、constructor 值为内置 Promise 的数据属性、值为其他类的可配置数据属性、可扩展子类这 5 类共 **40/40** 子进程退出 0；getter、species、额外子类构造均为 0，描述符和原型恢复。用户明确排除的 Proxy、不可配置 getter、冻结子类不以进程退出作拒绝理由。
- `plainData/plainItems` 的非法路径 getter、带访问器数组、U+000B/U+0085/零宽字符撤回扫描以及 B1 已确认回执复用、未知动作换渠道版本等独立样例符合预期；业务入口 null 的所测样例安全返回拒绝，`appendOwn`/`squash` 的错误类型按工具合同抛受控 `TypeError`，不泛称所有工具都不抛异常。
- 核对文档分支 `15e2046f44379c612bc05000baa1c84b9c9e307e` 的 v3.17 审查稿（非批准版），配套验收文档 SHA-256 `cca98187f579e426059731bc8916767875b82e8e4ab354cf602f2c2487e7d7de`：收据提及的 AC-06/08/11/12/20/31/32/35/39/40 均有对应条目；**AC-40 是消息连续投递不丢要求**，⑪在 v3.17 末列标为候选。收据 AC-39 已写本片仅 v3.10 三段式、不满足 v3.11/v3.12 的②，AC-40⑪无实际 provider 观测，五块重拼留给 D23 账本之后的独立切片；不以本片没有完成五块或完整端到端链路本身打回。
- 文档准确性建议：收据 AC-35 旧叙述把“专职锁没有做”与其他未交付项并列；v3.17 AC-35①明确专职开关已按用户 `#2273` 撤销，应标“已撤销、不做”，避免误作欠交功能。第 7 栏的 AC-20 对应“授权只来自用户本人”，不宜单独代表全部外部提示注入风险；通用外部不可信防注入另见 AC-35③。二者均不冒充已经通过，本轮不作为独立代码拒绝原因。

## 必须返修

### R10-01 [P1 / R9-01 安全拒绝] 不可配置但可写的 constructor 数据属性被错误排除

位置：`packages/kernel/src/plugins.ts:44–63,229–231,274–280`。`quietRefused` 对非内置 constructor 使用完整临时描述符 `{value: Promise, writable:true, enumerable:false, configurable:true}`。若外部原生 Promise 的自有 constructor 是 `{value: Other, writable:true, enumerable:true, configurable:false}`，改为 `configurable:true`（且改变 enumerable）不合法，`Reflect.defineProperty` 返回 false，代码直接返回、不挂拒绝处理。

在没有全局 `unhandledRejection` 处理器的独立子进程中，Node 22/25、send/pull、立即/稍后拒绝共 **8/8**：入口先给 `non-promise-send` / `invalid-batch`，访问器和 `Symbol.species` 调用均为 0，随后因未处理拒绝退出 1。该对象是普通原生 Promise，不是 Proxy、不可配置 getter 或冻结子类；它的属性虽不可配置但**值仍可写**，不在用户限定的三个排除形态之内。

同一对象的独立对照：只用 `{value: Promise}` 临时改值，不试图改 `configurable/enumerable`；调用内置 `Promise.prototype.then` 挂空拒绝处理，再只用 `{value: Other}` 恢复。Node 22/25 均退出 0，原描述符逐字段相同，外部 species getter 0。故此不是一般意义上“不可配置就不能安全处理”。

另测不可配置且不可写、值为其他类的数据属性：上述组合也退出 1；它不是用户明确列出的“不可配置 getter”，但本轮未证明存在不执行外部代码的安全处理方式。需要明确其隔离/范围，不得把它悄悄归入用户已批准的三类。对可写数据属性则已有可运行安全对照，不能以这一待定问题免除返修。另用 Node 25 实测：仅 `preventExtensions`、含仍可写字段且 `Object.isFrozen` 为 false、无自有 constructor 的 Promise 子类，`pull` 返回 `invalid-batch` 后仍因未处理拒绝退出 1；收据把“不可扩展”与“冻结”并列，但用户原话只列冻结子类。此形态能否安全处理本轮未证明，也应明示隔离边界并确认，不能直接冒称已获用户批准。

**要求**：区分可写数据描述符与不可配置访问器；覆盖和恢复时不改变原不可配置属性的其他旗标，拒绝后保证没有未处理拒绝。补 send/pull、立即/稍后拒绝、不同 enumerable/writable 组合、描述符原样恢复、getter/species 0、无全局处理器子进程存活及普通 Promise 对照。若不可写数据形态仍无法安全处理，先明确由何隔离以及是否需要用户重新批准范围。

### R10-02 [P2 / 测试充分性] 两个新单点故障逃过 227 条测试

三个独立临时 clone 各精确注入一个故障；typecheck 均退出 0。可按下列位置单独重做变异，不要同时注入：

- **R10-M1，存活**：在 `plugins.ts:62` 恢复原 constructor 描述符时，错误地在 `Object.assign(Object.create(null), own)` 后追加覆盖 `{enumerable:false}`。用原本 `configurable:true, enumerable:true` 的 constructor getter：原版拒绝且 getter 0、恢复为 enumerable true；变异版 getter 0 却恢复为 false。227/227 测试仍绿。实际产品原版在此样例正确，缺的是该旗标对照。
- **R10-M2，存活**：把 `plugins.ts:77` 的 `new Date(ms)` 改成 `new Date(Math.floor(ms))`。墙钟 `-0.5` 为合法有限数字；原版收到时间为 `1970-01-01T00:00:00.000Z`，变异版为 `1969-12-31T23:59:59.999Z`，227/227 测试仍绿。新增的小数样例均为正数，没覆盖负小数。
- **R10-M3，被杀**：`plugins.ts:71` 的 `readClock` 将 `Number.isFinite` 错改为 `Number.isInteger`；224 绿 / 3 红，其中包含有限小数墙钟的具名测试。

要求补原 constructor 描述符 enumerable=true 与 false 的单开关对照，并补负小数墙钟；把上述单点故障加入校准。它们说明测试覆盖不足，**不是声称当前原版在这两个样例已出错**。

## 记录：async_hooks 观察与主动修改的边界

普通只读 `async_hooks.init` 能在挂处理时看到临时 constructor，随后原描述符恢复，与收据披露一致。另在 Node 22/25 的 send/pull 独立进程中，让插件**主动**在该 hook 内把临时属性改为不可配置，`finally` 中恢复的 `Reflect.defineProperty` 返回 false 但实现没有检查；结果仍为普通拒绝，原描述符未恢复。此探针依赖插件主动修改自身 Promise，不等同于仅观察，也不是本轮 R10-01 的必要条件；考虑插件任意代码隔离尚未交付，记录为边界/需澄清与测试，不将其单独当成已批准外的第四类或本轮唯一打回理由。

## 各门禁独立负例

用本报告第六轮所附完整夹具脚本重新构造八个临时 Git 仓库与伪会话，逐门运行目标 `runGates` 检查原因，并逐例运行真实 `run-all.ts --local`；8/8 目标门禁均显示 ✗ 且各 CLI 退出 1。一个夹具可能同时触发其他门禁，不据此声称其他门禁通过。

| 门禁 | 本轮负例 | 目标结果 |
|---|---|---|
| G-TRACE | 收据状态 `待验` | 非四选一 |
| G-REVIEW | 作者与审查者都填 Claude | 审查人与作者相同 |
| G-PROVENANCE | `codex:missing-ten` 空会话 | 审查会话不可信 |
| G-RED | 不存在的全 `a` 红提交 | 红提交不存在 |
| G-STUB | 测试只断言导入函数类型 | 空桩后未按名字失败 |
| G-TAUTO | `assert.equal(11,11)` | 恒真断言 |
| G-WORKFLOW | workflow 申请 `contents: write` | 申请写权限 |
| G-LAYER | plugin 导入 plugin | 插件层不能互相依赖 |

## 最小复现（受审仓库根目录，`npm ci` 后）

下列子进程故意在无全局未处理拒绝处理器的默认 Node 策略下运行；不改任何内置原型、不联网。内核返回拒绝后，已拒绝 Promise 的未处理拒绝应使子进程退出 1；不要在生产宿主直接运行：

```sh
for mode in send pull; do
 MODE="$mode" node --input-type=module <<'NODE'
import {createRegistry} from './packages/kernel/src/plugins.ts';
let species=0;function Other(){}Object.defineProperty(Other,Symbol.species,{get(){species++;throw Error('不应读 species')}});
const p=Promise.reject(Error('外部拒绝'));Object.defineProperty(p,'constructor',{value:Other,writable:true,enumerable:true,configurable:false});
const before=Object.getOwnPropertyDescriptor(p,'constructor');const reg=createRegistry();
if(process.env.MODE==='send')reg.register({kind:'outbound-channel',id:'p',endpoint:'A',idempotency:'none',send:()=>p});else reg.register({kind:'data-source',id:'p',sources:['g'],pull:()=>p});
const result=process.env.MODE==='send'?await reg.send('p',{action_id:'a',payload:'x'}):await reg.pull('p','g');
const after=Object.getOwnPropertyDescriptor(p,'constructor');console.log({mode:process.env.MODE,reason:result.reason,species,descriptorUnchanged:before.value===after.value&&before.writable===after.writable&&before.enumerable===after.enumerable&&before.configurable===after.configurable});setTimeout(()=>console.log('进程存活'),30);
NODE
 echo "$mode 子进程退出码: $?"
done
```

同一非配置但可写数据属性可以只改其值、挂处理、再恢复，不改变 flags；独立 Node 22/25 正例均退出 0：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';let species=0;function Other(){}Object.defineProperty(Other,Symbol.species,{get(){species++;throw Error('不得访问')}});
const p=Promise.reject(Error('预期拒绝'));Object.defineProperty(p,'constructor',{value:Other,writable:true,configurable:false,enumerable:true});const before=Object.getOwnPropertyDescriptor(p,'constructor');
assert.equal(Reflect.defineProperty(p,'constructor',{value:Promise}),true);Reflect.apply(Promise.prototype.then,p,[undefined,()=>{}]);assert.equal(Reflect.defineProperty(p,'constructor',{value:Other}),true);
assert.deepEqual(Object.getOwnPropertyDescriptor(p,'constructor'),before);assert.equal(species,0);setTimeout(()=>console.log('原描述符恢复，进程存活'),20);
NODE
```

---

# 第十一轮：Astra 独立复审

**结论：REJECT。** 第十轮的不可配置但可写 constructor、enumerable 恢复、负小数墙钟原反例已修复。新的实现仍有一项 P1：拒收 Promise 时会临时改写 Node 内置 `Buffer[Symbol.species]`，同一观察窗口内正常的缓冲区切片会抛错；另有数组非下标数字键漏检及两个可破坏安全拒绝的单点故障未被测试发现。这里没有把用户排除的三类 Promise 形态或事先修改内置原型当成拒绝理由。

## 对象、身份和范围

- 普通独立 HTTPS clone：`/tmp/g-group-pr6-r11-astra-01a1b5ef`，开工回读远端 HEAD 为 `c4bc3326103e11acf77a1896c083c696252d88e9`；基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`。未使用 `deliverables/g-group-wt`，未使用已作废收据或先前子代理结论。
- 审查者 `astra`，Mirasim 会话 `codex:d1d48db4-4c36-45db-b221-5edcf62ed037`；原生会话 `01a1b5ef-a44e-7b73-9609-382f8d76b296` 的 `turn_context` 模型为 `ai-iisbo/[乾坤按量]gpt-6-astra`，厂商 OpenAI。作者收据为 `claude:68161be7-5085-463b-90f9-7700266c3f56`、`claude-opus-5-5`；来源门禁实测结果见下表，不用自报代替核验。
- 本轮只改本报告与收据 `review`。产品源码、作者验收状态、断言、测试、变异脚本都未改；自行故障注入在另外的临时副本完成。
- 依据 `origin/docs/dev-handbook` 的 `3ae540eee9c193cda368bf24a75c3ccef4db4cf0`：验收文档标题为同步 v3.18，SHA-256 `17a4f224bb39ac1156bd02674a412da528f20b5e57589901868523c3a3625d04`。该文档仍标审查稿、未批准，不将它或本单元测试报告变成整体验收通过。
- 在本会话、独立 clone 根目录实际运行规定命令，原样输出如下；填入 review 后再次运行仍相同：

  ```text
  44309caa4077bcdf2f409b56ff6cb26ee8b15ce052458f66a440ac9b23238fd1
  ```

## 复现结果

本机证据目录：`/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr6-r11-astra/`；每条采集命令有同名 `.json`（真实 command/cwd/退出码/起止时间）和 `.log`，以及可重跑的独立探针。脚本自身退出 0 不等于产品反例通过，下面区分记录。

| 检查 | 本轮实际结果 |
|---|---|
| `npm ci`、`npm run typecheck`、`npm run lint` | 均退出 0；安装审计 0 已知漏洞；lint 检查 25 文件 |
| `npm test` / Node 22.22.0 与 Node 25.8.1 | 各 230 通过、0 失败、0 cancelled、0 skip、0 todo，其中 kernel 207 条 |
| 红提交 `fd1f66087e2a0ce3d3d95cb12e057462b0555b37` | 另建普通独立 clone，安装退出 0；Node 22/25 各 23 旧测试通过、207 条 kernel 测试逐名失败、0 skip/todo；红绿四份 kernel 测试文件无差异，红失败名与绿 kernel 名双向差集为空 |
| 绿 `70c1d8f` 与被审 HEAD 的产品实现 | `git diff 70c1d8f HEAD -- packages/kernel/src` 为空 |
| 作者完整 197 个变异，Node 22.22.0 | 原样副本 207 绿；197/197 被原样通过的具名测试杀死、0 存活、0 超时，命令退出 0（12:20:12–12:50:00 UTC）；含 K197–K199 的第十轮存活故障回归 |
| Node 25 补充变异 | 已完成前 78 个均被具名测试发现；为避免重复整轮延迟，审查者主动停止补充轮，不计完整通过；完整清单以 Node 22 结束收据为准 |
| 必卡金丝雀，Node 22/25 | 各约 5.0 秒超时被杀，记超时而非杀死；校验命令退出 0 |
| 自造 4 个单点故障 | typecheck 全部退出 0；2 个被具名测试发现、2 个 230/230 仍绿，见 R11-03 |
| 独立 Promise 子进程矩阵，Node 22/25 | 共 88 个：72 个普通/受支持样例安全拒绝并退出 0；16 个锁定 null/Array 的残余样例先返回拒绝后退出 1。两类均访问器 0 次、描述符恢复；后者是确认残余风险，不是通过安全拒绝 |
| 八门禁负例 | 8/8 对应门禁判失败，真实 CLI 各退出 1；单夹具可同时触发其他门禁，不把它们当成其他门禁的阳性通过 |
| 假 HOME 中性标记隔离 | 保护目录直读和别名读取均 EPERM，普通对照标记可读；工作目录内可写、外部写被拒。未对真实 HOME 的文件作隔离攻击探针，未由此声称验证所有隔离路径 |
| 未填 review 的 `--local` | 退出 1；仅 G-REVIEW 报“还没有独立审查”。G-PROVENANCE 因 review=null 提前返回，不能当作来源通过 |
| 填 reject 后的 `--local` | 退出 1；G-REVIEW 报 reject；G-PROVENANCE 报本审查会话记录不存在（运行中尚未落盘）。G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 显示通过。原样完整输出在 `gates-after.log`，不得报八门全绿 |

执行器记录：默认 `node` 实际是 22.22.0。第一次标为 `mutations-node25` 的调用因此只是重复 Node 22，已用 SIGINT 停止，不计完整结果，原始日志和 signal 保留；之后以绝对路径 `/opt/homebrew/bin/node` 运行真正的 Node 25 回归、边界和金丝雀。`mutations-node25-actual` 的补充矩阵也主动停止于 78/197，不将命名或部分日志冒充全跑。完整 Node 22 原脚本未更改、未中断。

## 第十轮返修核对

- R10-01 主反例：不可配置但可写、enumerable=true/false 的 constructor 数据属性（值为另一个类、该类 species getter 不可配置）现在只改值，send/pull × 立即/稍后拒绝均安全拒绝，getter/species 0 次、描述符逐字段恢复、无全局处理器的进程退出 0。仅不可扩展的子类样例也通过。
- R10-02：可配置 constructor getter 的 enumerable 两侧、负小数 `-0.5/-1.5` 均有具名对照；K197–K199 的实跑结果以完整作者矩阵为准。本轮独立矩阵同时覆盖锁定 constructor 指向 species=null 的冻结普通函数，以及锁定 constructor 指向无 species 的冻结普通函数；原版均能安全拒绝，见 R11-03 的单点破坏对照。
- 收据已把专职开关明确改为用户撤销、不做；AC-20 与通用外部不可信防注入分开。AC-06/08/11/12/35/39 和 R-06 的整体验收仍未测；本片仍是旧 v3.10 三段式，不能冒充 AC-39② 的每轮五块重拼或 AC-40⑪ 的真实 provider 观测。本轮不以这些既有、已披露的后续集成范围单独打回。
- 残余锁定 constructor=null/Array 形态已由作者明确披露“待用户拍板”，独立子进程实测仍退出 1；它们不自动归入用户已排除的三类。本轮不把试过几种 API 当成一般不可能性的证明，也不替用户扩大排除范围；应保留范围/隔离决策，不能宣称所有拒收均保住宿主。

## 必须返修

### R11-01 [P1 / 拒收不得改写内置对象] INTRINSICS 漏掉 Node 内置 Buffer，方案 3 临时改写全局 species

位置：`packages/kernel/src/plugins.ts:44-51,82-91,123-125`。`INTRINSICS` 是手列的构造器集合，包含 Array/Promise/Uint8Array 却不含 Node 全局 `Buffer`。原生 Promise 的自有 constructor 锁定为 Buffer 时，实例无法改值，方案 3 把 `Buffer[Symbol.species]` 临时由内置 getter 改为数据属性 `Promise`。这违反本实现“只改插件自己的对象、不改内置对象”的边界，而不是插件预先污染了内置原型。

独立 `boundaries.mjs` 在 Node 22/25 的 send/pull 共 4/4：注册前的 `Uint8Array.prototype.slice.call(Buffer.from('neutral'))` 正常返回 Buffer；只读观察描述符的 async_hooks.init 看见一次全局 species=Promise，在该窗口执行相同切片会抛错一次；拒收返回 `non-promise-send` / `invalid-batch`，事后描述符恢复。探针没有改 Buffer 或其原型；hook 没有主动锁死、修改临时属性，只观察并调用正常内置切片。**不声称每个部署都装此 hook，也不声称属性永久未恢复；问题是已观察到的同步共享内置状态污染。**

要求：临时改写的对象范围必须可靠地排除 Node 内置对象，补 Buffer 的拒收与不改写对照，并检验方案 3 所触及对象的所有权/内置边界；不得只验证 Array/Promise 两个样例就声称所有内置对象均未动。相同观察窗口内正常缓冲区操作也须保持有效；若处理不了，显式纳入待决定的安全拒绝/进程隔离边界，不能静默改全局。

### R11-02 [P2 / 普通数组输入合同] 非数组下标的十进制数字键被吞掉，带访问器数组被接受

位置：`packages/kernel/src/plain.ts:22,138-149`。`INDEX` 只检查十进制数字文本，没有检查数组索引的上界和它是否落在 length 内。`4294967295`（2^32-1，不是数组索引）与 `9007199254740992` 因而通过键检查，但它们不改变 length，后面的 0..length-1 循环不检查这些键的描述符。

在空数组上分别定义这些自有 getter 后，Node 22/25 均观测 `plainData` 返回 ok:true/value:[]，`plainItems` 返回 ok:true/items:[]，已注册 DataSource 的 pull 返回 ok:true/events:[]/rejected:[]；getter 0 次。只把键换成 `extra` 的单开关对照，三条路径均明确拒绝。这里**不是声称 getter 被执行或有效索引里的正常事件丢失**，而是“出现访问器即拒绝、数组只能有下标与 length”的合同漏检，输入被静默净化成成功。

要求：按真实数组索引与当前 length 校验每个自有键，不让超界数字名绕过额外键/访问器拒绝；补 plainData/plainItems、appendOwn 与 pull 容器的 2^32-1/更大数字键对照，保证 getter 不调用、异常形状明确拒绝。

### R11-03 [P2 / R-05] 两个安全拒绝分支的单点破坏逃过 230 条测试

四个故障分别只在自己的临时完整副本改一个位置，typecheck 均退出 0，产品原版未改：

| 故障 | 精确改动 | 全套测试结果 | 独立行为对照 |
|---|---|---|---|
| R11-M1，存活 | plugins.ts:75 的 speciesSafe 不再把数据属性 species=null 视为安全 | 230 绿 / 0 红 | 原生 Promise 的 constructor 锁定为冻结普通函数，该函数自有只读 species=null：原版 send/pull × 立即/稍后拒绝 4/4 退出 0，变异版 4/4 先拒绝后因未处理拒绝退出 1 |
| R11-M2，被杀 | plugins.ts:89 恢复可写 constructor 时额外把 writable 设为 false | 228 绿 / 2 具名红 | 十六形态恢复测试与逐旗标测试发现描述符不一致 |
| R11-M3，存活 | plugins.ts:74 将“找不到 species 返回 true”改成 false | 230 绿 / 0 红 | constructor 锁定为无 species 的冻结普通函数（不是冻结 Promise 子类）：原版上述四组合退出 0，变异版四组合退出 1 |
| R11-M4，被杀 | plugins.ts:117 挂处理后把原型恢复目标错改成 Promise.prototype | 228 绿 / 2 具名红 | 十六形态描述符/原型与无全局处理器子进程测试发现故障 |

要求：为 species=null 与缺省 species 的**不可再改写普通函数**补单开关对照和无全局处理器子进程存活断言，将 M1/M3 纳入校准。原版在这两个样例正确，缺的是测试激活；“作者所列 197 种全部被杀”只能覆盖那些选定注入点。

## 八个门禁负例

`gate-negatives.mjs` 为每门创建独立真实 Git 夹具，用当前 runGates 检查具体原因，再调用真实 CLI。HOME、会话根和群聊根均指向新建的中性夹具目录；夹具结束后自行清理。

| 门禁 | 应失败输入 | 实际目标结果 |
|---|---|---|
| G-TRACE | 验收状态“待验” | 非四选一 |
| G-REVIEW | 作者与审查 agent 都为 claude | 同一作者/审查者 |
| G-PROVENANCE | 不存在的 codex:missing-r11 会话 | 审查会话不可信 |
| G-RED | 不存在的 40 个 e 红提交 | 红提交不存在 |
| G-STUB | 只断言导入函数类型，从不调用 | 空桩后未按名字失败 |
| G-TAUTO | assert.equal(11,11) | 恒真断言 |
| G-WORKFLOW | workflow 申请 contents:write | 申请写权限 |
| G-LAYER | plugin 包导入另一个 plugin 包 | 插件层不能互相依赖 |

## 复跑入口与清理

从该审查提交的仓库根目录安装依赖后，以证据目录的 `boundaries.mjs <repo>` 复现 R11-01/02，以 `own-mutations.mjs <repo>` 复现 R11-03（它只改临时副本并自动删除）。`independent-probes.mjs <repo> <node绝对路径>` 可重跑 44 个进程矩阵；故意复现残余样例的退出 1 不要误读为平台拦截。

清理：本轮已绑定的临时 clone、故障副本、夹具和中断变异残留将在推送回读完成后删除，实际删除量另存证据收据；不删除其他助手或无法确认归属的临时目录。保留上述证据目录，不改其他工作区或现场服务。

---

# 第十二轮：Codex 独立复审

**结论：REJECT。** 存在外部 Promise 访问器被执行并可能终止宿主、带访问器的 Promise 被当作正常回执/拉取结果、外部请求字节数错误导致前缀哈希误判，以及两个独立单点故障逃过现有测试的问题。以下结果只来自本轮执行，不采用旧子代理结论或本地通过收据。

## 对象、范围与证据

- 被审 `origin/feat/kernel-plugins` HEAD `8abfbae536452e5f729a7436f96896862716d8fe`；基线 `origin/feat/domain-core` 为 `afd02560f9546147da380382404eb6106222a9b8`。开工时远端回读一致。普通独立 HTTPS clone，不使用共享 worktree；产品源码和原测试未改。来源规范 `origin/docs/dev-handbook` 为 `396c05360b1381e1eb1acb1792b070d99fbb4945`，不把标记「候选」的条目作为验收标准。
- 本次 Mirasim 会话 `codex:6e2a9ebd-ea69-49ac-aaf7-3bb3e5c7edd5`；实际原生会话 `01a1b9b7-2113-7aa3-8abe-7080e6cf07d8` 的 turn_context 模型为 `gpt-6.1-terra`。在本会话实际运行 `node scripts/gates/run-all.ts --hash --branch=feat/kernel-plugins --base=origin/feat/domain-core`，输出并钉住：`999cdbc26456965da0daff45db052ab625a1a3d3ff2fe30a68878d5987676bfd`。
- 本轮原始日志与可重跑探针保留在 `/Users/snakesammy/.mirasim/assistants/deliverables/g-group-pr6-r12-codex/`。独立探针不预先改写任何内置原型；隔离验证仅使用假 HOME 与中性标记。

## 独立复现

- `npm ci` 退出 0；`npm run typecheck`、`npm run lint` 均退出 0，lint 检查 25 文件。`npm test` Node 22.22.0 和 25.8.1 各 240 通过、0 失败、0 cancelled、0 skipped、0 todo。日志 `npm-test-node22.log`、`npm-test-node25.log`。
- 红提交 `6faf40311220b0f7f053f2bca8d8dc49ed1d4240` 的测试文件与当前相同；Node 22 上 217 条内核测试全按名失败；当前同名 217 全按名通过，集合双向差集各 0（`red-node22.tap`、`green-node22.tap`）。
- 作者 203 项单故障：Node 22.22.0 原样副本 217 绿，203/203 被原样通过的具名测试杀死，0 存活、0 超时，退出 0（`mutations-node22.log`）；K210/K211 均被具名测试杀死。为降低本机并发，副本 runner 仅给 node:test 增加 `--test-concurrency=1`，其清单、注入、测试和杀死判据不变，差异见 `mutation-runner.diff`，产品源码与作者脚本未改。
- 超时金丝雀：Node 22/25 均约 5 秒被终止并按超时而非杀死记录（`canary.log`）。
- 上轮 R11-01：Node 22/25 的 send/pull 四次实测均拒收锁定 Buffer 的 Promise；async_hooks 观察窗口各 6/2 次，Buffer species 描述符变化 0，正常 Buffer 切片失败 0，事后属性相同（`boundaries-node22.log`、`boundaries-node25.log`）。但仅证明不改写 Buffer；该形态无全局处理器时分别返回拒绝后以未处理拒绝退出 1（`buffer-unhandled.log`）。它不属于已明确排除的三类，必须保留待用户决定/集成前隔离的边界，不能写成拒收已确保宿主存活。
- R11-02：`2^32-1`、更大十进制名、额外字符串名和有效下标访问器分别经过 plainData、plainItems、appendOwn、pull 四条路径，Node 22/25 均拒绝、getter 0 次；普通数组对照放行、Proxy 陷阱 0 次。
- R11-03：在隔离副本分别注入 species=null 的 M1 和缺省 species 的 M3，Node 25 原版的十九形态无全局处理器测试按名通过；两种故障各被同一具名测试按名杀死（`r11-baseline-node25.tap`、`r11-M1-node25.tap`、`r11-M3-node25.tap`）。
- 合法嵌套 JSON null 保留，入站 null 不抛错地拒绝；EVENT_CODES、STABLE_ORDER 修改被阻止，Node 22/25 对照见 `null-policy.log`。这不是所有 API 对任意错误形状一律不抛错的声明：serialize/prefixLength/prefixHash 的顶层非对象输入现有合同是受控 TypeError。

## 必须返修

### R12-01 [P1] 已拒绝 Promise 的异步追踪符号 getter 在宿主中执行，抛错可终止进程

位置：`packages/kernel/src/plugins.ts:41-43,161-175,343,389`。`quietRefused` 调用内置 `Promise.prototype.then` 时，已启用 async_hooks 的 Node 内部会读取该外部 Promise 的 `async_id_symbol`。独立探针不改内置原型：原生 Promise 上放可配置的 `then` getter（用来触发拒收）和同样可配置的自有 `async_id_symbol` getter；对照只把后者换为数据属性。Node 22/25 的 send、pull 对照均为 0 次，getter 版本均为 2 次，`then` getter 自身仍为 0 次；四个返回理由分别符合拒收分支（`promise-symbol-getter-node22.log`、`promise-symbol-getter-node25.log`）。把该 getter 换成抛出普通错误，四个独立子进程都在 `getOrSetAsyncId → trackPromise → Promise.then → attachQuiet` 退出 1，即使外层有 try/catch 和 unhandledRejection 监听（`promise-symbol-throws.log`）。这是实例自有访问器，不是预先改写内置原型，也不等于用户排除的不可配置 constructor getter。

要求：拒收/处理所有受支持外部 Promise 前，不调用实例及相关链上的外部访问器；对无法安全挂处理的形态明确隔离边界并交用户决定，不能把可能退出的形态计作安全拒收。补 send/pull、Node 22/25、数据属性单开关及会抛错的无全局处理器子进程测试。

### R12-02 [P2] 原生 Promise 的非 then/constructor 自有 getter 被接受

位置：`packages/kernel/src/plugins.ts:31-37,343,389-390`。`isPlainPromise` 只检查 `then`、`constructor` 两个自有名称，不检查其他自有描述符。Node 22/25 两种路径的独立单开关对照中：在正常兑现的原生 Promise 上仅新增 `extra` 自有 getter，getter 调用 0，但 send 仍返回 confirmed，pull 仍返回成功；去掉 getter 同样成功（`promise-extra-getter.log`）。此处问题是**没有按合同拒绝带访问器的外部输入**，不是声称这个 `extra` getter 被调用。

要求：不读取值地检查 Promise 自有描述符，对外部 getter/setter 显式拒绝；兼容运行时正常的异步追踪数据属性，并与 R12-01 的安全拒收一并验证。

### R12-03 [P2] 外部请求的错误 bytes 被信任，前缀哈希可误判相同

位置：`packages/kernel/src/assemble.ts:301-317,324-333`。`segmentsOf` 只检查 bytes 是整数，不检查非负或与 text 实际 UTF-8 字节一致。独立探针先用原版 assemble 构造真实的 A/B 请求，真实前缀哈希不同；将两份普通 JSON 副本的 `segments[0].bytes` 单独改为 0 后，两个不同的 11 字节 system 段都被 `prefixLength` 判为 0，`prefixHash` 错误地相同；bytes=-1 也被接受并返回 -1。Node 22/25 一致（`prefix-length-input.log`）。这个反例是外部传回的错误结构，不是声称 assemble 自己生成的冻结原版 bytes 有错。

要求：对外部请求重新按 UTF-8 计算并核验每段长度和边界，或拒绝与正文不符/负数的 bytes；补合法中文 UTF-8、零值/负值和不同内容不得误判的单开关测试。

### R12-04 [P2 / R-05] 两个独立单点故障逃过 240 条现有测试

每种故障在各自隔离快照只替换一个注入点，五个故障 typecheck 均退出 0，原版基线 240 绿（`own-mutants.log` 及各 TAP）：

1. O1 将 `classify.ts:51` 的 end 整数检查去掉：240 绿。对照 `text="@x "`、`end=2.5`，原版走语义分类 E2，故障版误判机械 E1 且分类器调用 0。
2. O2 让 `plugins.ts:243` 拒绝合法空字符串附件名：240 绿。原版一条事件盖章成功，故障版事件 0、拒绝 1。
3. O3 把 epoch 0 当非法墙钟：被 5 条具名测试发现；O4 接受空 edit 正文：被 1 条具名测试发现；O5 放行数组元素可枚举 getter：被 6 条具名测试发现。

`own-mutant-behavior.log` 是 O1/O2 原版与单故障版的行为对照；这两项描述测试覆盖缺口，不把原版行为说成发生了上述故障。要求为非整数 mention 边界与可选空字符串附件名补双侧单开关，并将两个故障纳入校准。

## 门禁与隔离

- 按真实 PR base 显式运行 `node scripts/gates/run-all.ts --local --branch=feat/kernel-plugins --base=origin/feat/domain-core`：G-TRACE/G-RED/G-STUB/G-TAUTO/G-WORKFLOW/G-LAYER 通过，G-REVIEW 因尚无本轮收据而失败；G-PROVENANCE 显示绿但因 review=null 提前返回，不可作为来源已验证。完整原样输出 `gates-bound.log`。
- 按字面运行 `node scripts/gates/run-all.ts --local` 时初始检出为 detached HEAD，命令实际默认 `branch=HEAD`、`base=origin/main`、收据 `receipts/HEAD.json` 不存在，G-TRACE/G-RED/G-STUB 失败；那不是针对 PR 基线的有效门禁结果，原样保留 `gates-before.log`，未掩盖此次执行器参数错误。
- GitHub self-check 查询确认 run `42422226052` 的 headSha 即 `8abfbae`、状态 completed/success，含安装、测试、门禁自检和门禁变异等实际步骤（`github-self-check.json`）；只作为 CI 观察，不代替本轮独立测试。
- 门禁完整自检：103 个样例与 8 个厂商识别检查均通过，退出 0；原始输出 `gates-selftest.log`。
- 八个门禁分别喂入独立真实 Git 夹具：错误验收状态、作者与审查同一人、会话不存在、缺红提交、只检查函数类型的测试、恒真断言、workflow 写权限、插件依赖插件。每个目标门禁都按对应原因失败且 CLI 退出 1（`gate-negatives.log` 和 `negative-G-*.log`）。每个夹具可能同时触发别的门禁，不能把它当成其他门禁的阳性通过。
- 假 HOME 下受保护中性标记及其软链读均 EPERM，普通标记可读；工作目录内可写、外部写 EPERM（`sandbox.log`）。只证明这些隔离样例。

- 填入本轮 reject 后，在 `origin/feat/domain-core` 基线上再次执行 `--local --branch=feat/kernel-plugins --base=origin/feat/domain-core`：G-TRACE、G-RED、G-STUB、G-TAUTO、G-WORKFLOW、G-LAYER 通过；G-REVIEW 按 reject 失败；G-PROVENANCE 失败，明确报告 `审查会话不可信:会话记录不存在:codex:6e2a9ebd-ea69-49ac-aaf7-3bb3e5c7edd5`。本会话确实执行过哈希命令，但门禁所需的 `turns.jsonl` 在执行时未落盘，不能因此称来源验证通过，也未手写会话记录。完整输出 `gates-after-review.log`。
- 填收据后另按字面运行 `node scripts/gates/run-all.ts --local`：分支为 feat/kernel-plugins，但命令仍默认 base=origin/main，将领域层 23 项测试也纳入 G-RED，G-PROVENANCE/G-REVIEW/G-RED/G-STUB 失败，其余通过；它不是 PR 的正确 base，完整原样输出 `gates-exact-after-review.log`。
