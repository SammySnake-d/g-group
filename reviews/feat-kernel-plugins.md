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
