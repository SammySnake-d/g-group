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
