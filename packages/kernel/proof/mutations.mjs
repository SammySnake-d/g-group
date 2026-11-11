// 行为变异校准(R-05 阳性埋雷):对 kernel 包的实现逐个注入单一故障(第二轮按 PR #6 审查 F-01..F-06 扩充,含审查存活的 M1=K14、M2=K15;第三轮按 RR-01..RR-05 与 AC-39 扩充,含 R2-M1=K51、R2-M2=K52,删掉方向反了的旧 K36;第四轮按 R3-01..R3-07 扩充,含 R3-M1=K86、R3-M2=K87,每个变异有超时;第五轮按 R4-01..R4-07 扩充,含 R4-M1=K92、R4-M2=K91;第六轮按 R5-01..R5-05 扩充,含 R5-M1=K111、R5-M2=K126;第七轮按 R6-01..R6-05 扩充,含 R6-M1=K142、R6-M2=K143;第八轮按 R7-01/02/04/05/06 扩充,含 R7-M1=K156、R7-M2=K157、R7-M3=K158;第九轮按 R8-01..R8-05 扩充,含 R8-M1=K173、R8-M2=K174、R8-M3=K175;第十轮按 R9-01/R9-02 扩充,含 R9-M1=K188、R9-M2=K177、R9-M3=K189;第十一轮按 R10-01/R10-02 扩充,含 R10-M1=K197、R10-M2=K198、R10-M3=K199,并按新实现改写 K184、K190–K196 的注入点;
// 第十二轮按 PR #6 第十一轮审查 R11-01..R11-03 扩充,含审查自造的存活单点故障 R11-M1=K210、R11-M3=K211,
// 新实现带来的 K212–K214,并按新实现改写 K138、K204 的注入点;第十三轮按 PR #6 第十二轮审查 R12-01..R12-04 扩充,
// 含审查自造的存活单点故障 R12-O1=K228、R12-O2=K226,新实现带来的 K216–K225、K227、K229–K238,
// 并按新实现改写 K155、K159、K184、K185、K207、K208 的注入点,语义不变;第十四轮按用户 2026-11-09 改的合同「拒收只判定、不处理」
// 删掉拒收挂处理机制的 36 个变异,K30 改注入点到新实现,新增 K239–K241;第十五轮按第十四轮审查 R14-01..R14-03 扩充,含审查自造的存活单点故障 M1=K243、M2=K244、M3=K245,
// R14-01 原错 K242、R14-03 原错 K246 与上限差一 K247,并按新实现改写 K159、K240 的注入点;第十六轮按第十五轮审查 R15-01 加审查的两类同步临时改写 K248、K249),在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。注入点必须在源码里恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。
// 每个变异在独立进程组里跑,超时(默认 300s,KERNEL_MUT_TIMEOUT_MS 可改)就杀掉整个进程组,记 ✗ 超时,不算被杀死。
// 用法: node packages/kernel/proof/mutations.mjs
//       node packages/kernel/proof/mutations.mjs --canary-hang   注入一个必然卡住的变异,验证脚本能有界退出并把它记成超时
// 环境变量:KERNEL_MUT_CONCURRENCY=N 给每个副本的 node --test 加 --test-concurrency=N(本机同时有别的测试时调低);
//           KERNEL_MUT_ONLY=<正则> 只跑名字匹配的变异(调试用,正式校准不设)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 删掉的等价变异(在 55e7121 的实现下改不了行为,不再列入):
//   K21 mounts 不拷贝:注册入口先把整个输入克隆成冻结纯数据,mounts 读自这份副本,拷不拷贝都不与调用方共享;
//   K141 对象结果直接赋值:对象结果本身是 Object.create(null),没有原型,直接赋值碰不到原型链上的同名 setter,与 defineProperty 等价;
//   K38 诊断序列化失败直接抛出(在 257d56e 起的实现下、内置未被改写时等价):safeDescribe 不再把外部对象交给 JSON.stringify
//       (不执行 toJSON),只读非 Proxy 对象的自有描述符;JSON.stringify 仍用于给字符串、符号描述等基本类型加引号,
//       这些调用在内置未被改写时不会抛错,所以兜底 catch 在所测样例中走不到。若内置 JSON.stringify 被改写成抛错,
//       原版返回 <无法描述> 而变异版抛错,但这属于合同之外(只保证内置原型未被改写的运行环境,用户 g-group#2662);
//       这是对有限样例和该合同的判断,不是兜底分支在所有环境中严格不可达的证明;
//   K209 方案 3 不排除 Proxy 构造器(第十一轮,等价):lookup 第一步就对传入对象查 types.isProxy,值是 Proxy 时返回空链,
//       shadow 对空链直接返回 undefined,去掉调用处的 !types.isProxy(value) 改不了行为(lookup 里那一步由 K205 覆盖);
//   (K209 的说明只对第十一至十三轮的拒收挂处理机制成立;第十四轮整套机制已删,不再适用)
//   K108 单调读数倒退仍放行:读数一倒退该动作就已标为时钟不可信并在窗口判断前返回,窗口判断里不会再见到负的 elapsed。
const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  // —— 插件注册(原 K01–K03,F-06 补的三类契约正负对照)
  ["K01 允许重复 id", "plugins.ts", 'if (plugins.has(r.snapshot.id)) return reject("duplicate-id", r.snapshot.id);', ""],
  ["K02 放行插件声明定时", "plugins.ts", 'if ("schedule" in c || "cron" in c) return { ok: false, reason: "schedule-not-allowed", detail: SCHEDULE_REASON };', ""],
  ["K03 放行插件互相依赖", "plugins.ts", 'if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return', "if (false) return"],
  ["K14 未声明源只拦 g2(审查 M1)", "plugins.ts", "if (!p.sources.includes(sourceId))", 'if (sourceId === "g2" && !p.sources.includes(sourceId))'],
  ["K15 OutboundChannel 不查 send(审查 M2)", "plugins.ts", 'if (typeof send !== "function") return', "if (false) return"],
  ["K16 DataSource 不查 sources", "plugins.ts", "if (!isStrList(c.sources) || c.sources.length === 0) return", "if (false) return"],
  ["K17 DataSource 不查 pull", "plugins.ts", 'if (typeof pull !== "function") return', "if (false) return"],
  ["K18 UIExtension 不查 mounts", "plugins.ts", "if (!isStrList(c.mounts)) return", "if (false) return"],
  ["K19 OutboundChannel 不查 idempotency", "plugins.ts", 'if (typeof c.idempotency !== "string" || !IDEMPOTENCY.has(c.idempotency)) return', "if (false) return"],
  // —— 宿主快照(F-03)
  ["K20 注册入口读调用方原对象,配置与调用方共享", "plugins.ts", "const c = plain.value as Record<string, unknown>;", "const c = raw as Record<string, unknown>;"],
  ["K22 注册表保存调用方原对象", "plugins.ts", "return { ok: true, snapshot: Object.freeze({ kind: \"data-source\", id, sources, pull: (s: string) => pull.call(self, s) }) };", "return { ok: true, snapshot: raw as Plugin };"],
  ["K23 reregister 允许换类型", "plugins.ts", "if (old.plugin.kind !== r.snapshot.kind) return", "if (false) return"],
  // —— 外部事件盖章(F-01)
  ["K10 外部内容不标不可信", "plugins.ts", '    trust: "untrusted",', '    trust: ((e as { trust?: string }).trust ?? "untrusted") as "untrusted",'],
  ["K24 丢弃源端版本", "plugins.ts", "    sourceVersion: e.sourceVersion,", '    sourceVersion: "",'],
  ["K25 丢弃事件类型", "plugins.ts", "    eventType: e.eventType as ExternalEventType,", '    eventType: "create" as ExternalEventType,'],
  ["K26 收到时间改用发生时间", "plugins.ts", "    receivedAt,", "    receivedAt: new Date(e.occurredAt).toISOString(),"],
  ["K27 丢弃附件引用", "plugins.ts", "    attachments: Object.freeze(attachments as AttachmentRef[]),", "    attachments: Object.freeze([]),"],
  ["K28 不校验事件类型枚举", "plugins.ts", 'if (typeof e.eventType !== "string" || !EVENT_TYPES.has(e.eventType)) return', "if (false) return"],
  // —— 外发(F-02)
  ["K11 发送不要求 action_id", "plugins.ts", 'if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id"', 'if (false) return { ok: false, state: "rejected", reason: "missing-action-id"'],
  ["K12 同一 action_id 已确认仍重复真发", "plugins.ts", "if (prior.state === \"confirmed\" && prior.receipt) return", "if (false) return"],
  ["K29 B2 结果未知时盲重试", "plugins.ts", "if (b.idempotency === \"none\") return", "if (false) return"],
  ["K30 同步返回值当回执(第十四轮改注入点到新实现)", "plugins.ts", "if (!isPlainPromise(pending)) return unknown(\"non-promise-send\"", "if (false) return unknown(\"non-promise-send\""],
  ["K31 超时当成功", "plugins.ts", 'if (got === TIMEOUT) return unknown("timeout", ', 'if (got === TIMEOUT) got = { action_id: actionId, receiptId: "assumed" }; if (false) return unknown("timeout", '],
  ["K32 异步异常当成功", "plugins.ts", '    } catch (err) {\n      return unknown("send-threw", errText(err));', '    } catch {\n      got = { action_id: actionId, receiptId: "assumed" };'],
  ["K33 回执不校验 action_id", "plugins.ts", "if (!isObj(rc) || rc.action_id !== actionId || !isStr(rc.receiptId)) return", "if (!isObj(rc) || !isStr(rc.receiptId)) return"],
  ["K34 在途时允许再发", "plugins.ts", 'if (prior.state === "in-flight") return', "if (false) return"],
  ["K35 同 action_id 换内容复用旧回执", "plugins.ts", "if (b.payloadSha256 !== fingerprint) return", "if (false) return"],
  // —— 上下文装配(AC-06)
  ["K04 Page-in 改成取最近 N 条", "assemble.ts", "const m = all.find((x) => x.seq === seq);", "const m = all.slice(-3).find((x) => x.seq === seq);"],
  ["K05 超预算静默截断", "assemble.ts", "if (need > opts.budgetBytes) return { ok: false, reason: \"over-budget\", need, budget: opts.budgetBytes, action: \"compress\" };", "while (final.length > 0 && final.reduce((a, s) => a + s.bytes, 0) > opts.budgetBytes) final.shift();"],
  ["K06 窗口内引用重复页入", "assemble.ts", "if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (paged.some((p) => p.seq === seq)) continue;"],
  ["K07a 撤回消息被引用时仍页入", "assemble.ts", "if (m.retracted) { pushOwn(skipped, { seq, reason: \"retracted\" }); continue; }", ""],
  ["K07b \u64a4\u56de\u6d88\u606f\u8fdb\u7a97\u53e3", "assemble.ts", "      if (retracted.has(e.seq)) continue;\n", ""],
  // —— 分类(AC-11 / AC-12,F-04 / F-05)
  ["K08 \u6709\u673a\u68b0\u951a\u70b9\u4e5f\u8c03\u5206\u7c7b\u5668", "classify.ts", "const { invalidMentions, ...anchors } = anchorsOf(event);", "const { invalidMentions, ...anchors } = anchorsOf(event);\n  try { classifier(event); } catch { /* \u53d8\u5f02:\u591a\u8c03\u4e00\u6b21 */ }"],
  ["K09 分类器自由文本被放行", "classify.ts", 'if (typeof raw === "string" && ALLOWED.has(raw))', 'if (typeof raw === "string")'],
  ["K13 确认卡版本号不算机械线索", "classify.ts", "if (anchors.card !== undefined) {", "if (false) {"],
  ["K37 诊断不防循环引用", "plain.ts", "  if (seen.has(v)) return JSON.stringify(\"[循环]\");\n", ""],
  ["K39 诊断不处理嵌套 BigInt", "plain.ts", "  if (typeof v === \"bigint\") return JSON.stringify(`${v}n`);\n", ""],
  ["K40 确认卡不校验回复者是用户", "classify.ts", 'if (e.sender?.kind !== "user") return', "if (false) return"],
  ["K41 确认卡不校验版本", "classify.ts", "if (!Number.isInteger(c.version) || c.version < 1) return", "if (false) return"],
  ["K42 确认卡不校验决定枚举", "classify.ts", 'if (typeof c.decision !== "string" || !DECISIONS.has(c.decision)) return', "if (false) return"],
  ["K43 带 @ 带文字也机械判 E1(审查 F-05 原错)", "classify.ts", "if (mentionOnly(event, { ...anchors, invalidMentions })) return", "if (anchors.mentions.length > 0) return"],
  ["K44 带引用也机械判 E1", "classify.ts", "if (mentionOnly(event, { ...anchors, invalidMentions })) return", "if (mentionOnly(event, { ...anchors, invalidMentions }) || anchors.quotes.length > 0) return"],
  // —— 第三轮:RR-01..RR-05
  ["K71 已确认 B1 过保留期后重发(RR-01 原错)", "plugins.ts", "if (prior.state === \"confirmed\" && prior.receipt) return", "if (prior.state === \"confirmed\" && prior.receipt && now() - b.firstAttemptAt < b.windowMs) return"],
  ["K55 未知 B1 不查保留期(RR-01 原错)", "plugins.ts", "if (!(elapsed < b.windowMs)) return", "if (false) return"],
  ["K56 \u6070\u5230\u671f\u4ecd\u653e\u884c\u91cd\u8bd5", "plugins.ts", "elapsed < b.windowMs)", "elapsed <= b.windowMs)"],
  ["K57 重试刷新首次尝试时间", "plugins.ts", "entry.attempts++;", "entry.attempts++;\n    entry.binding = { ...entry.binding, firstAttemptAt: now() };"],
  ["K54 \u672a\u77e5\u52a8\u4f5c\u4e0d\u67e5\u6e20\u9053\u7248\u672c(RR-02 \u539f\u9519)", "plugins.ts", "if (reg.version !== b.channelVersion || p.endpoint !== b.endpoint) return", "if (p.endpoint !== b.endpoint) return"],
  ["K58 未知动作按当前渠道判 B2(RR-02 原错)", "plugins.ts", "if (b.idempotency === \"none\") return", "if (p.idempotency === \"none\") return"],
  ["K59 B1 不要求保留期", "plugins.ts", "if (idempotency === \"action-id\" && !(typeof w === \"number\" && Number.isFinite(w) && w > 0)) return", "if (false) return"],
  ["K60 载荷不查字符串", "plugins.ts", "if (typeof payload !== \"string\") return", "if (false) return"],
  ["K51 载荷比对前去空白(审查 R2-M1)", "plugins.ts", "const payload = q.payload;", "const payload = typeof q.payload === \"string\" ? q.payload.trim() : q.payload;"],
  ["K52 不查 author 类型(审查 R2-M2)", "plugins.ts", "if (typeof e.author !== \"string\") return \"缺 author\";", ""],
  ["K53 不查 content 类型", "plugins.ts", "if (typeof e.content !== \"string\") return \"content 必须是字符串\";", ""],
  ["K45 纯点名用宽泛正则去名字(RR-03 原错)", "classify.ts", "return rest.trim() === \"\";", "return e.text.replace(/@\\S+/g, \"\").trim() === \"\";"],
  ["K46 点名不查名字里的标点", "classify.ts", "NAME_FORBIDDEN.test(name)", "false"],
  ["K47 点名不查范围与正文对得上", "classify.ts", "return text.slice(start as number, end as number) === `@${name}`;", "return true;"],
  ["K50 异常兜底直接读 message(RR-04 原错)", "plain.ts", "      if (d && !isAccessor(d) && typeof d.value === \"string\") return d.value;", "      return String((err as Error).message);"],
  // —— AC-39 / D22 前缀纪律
  ["K61 stable 段不扫会变内容(system 注入时间)", "assemble.ts", "for (const [name, re] of VOLATILE_PATTERNS) {", "for (const [name, re] of []) {"],
  ["K62 stable 段放行最近 N 条", "assemble.ts", "  [\"最近 N 条\", /最近\\s*\\d+\\s*条/],", ""],
  ["K64 \u6bcf\u8f6e\u91cd\u622a\u6700\u8fd1 N \u6761", "assemble.ts", "if (e.seq <= through) continue;", "if (e.seq <= through || e.seq < head - 2) continue;"],
  ["K65 Page-in 插进前缀", "assemble.ts", "for (const m of paged) push(seg(\"tail\", \"page-in\",", "for (const m of paged) push(seg(\"history\", \"page-in\","],
  ["K70 会变状态放进 stable", "assemble.ts", "push(seg(\"tail\", \"volatile\",", "push(seg(\"stable\", \"volatile\","],
  ["K66 \u65ad\u70b9\u8d85\u8fc7 4 \u4e2a", "assemble.ts", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),\n    lastOf((s) => s.section === \"tail\"),\n    0,"],
  ["K67 \u65ad\u70b9\u653e\u8fdb tail", "assemble.ts", "lastOf((s) => s.section === \"history\" && s.label !== \"compressed\"),", "lastOf((s) => s.section !== \"stable\" && s.label !== \"compressed\"),"],
  ["K68 前缀哈希把 tail 算进去", "assemble.ts", "section !== \"tail\")", "section !== \"never\")"],
  ["K69 前缀哈希不按字节截", "assemble.ts", "subarray(0, bytes ?? prefixBytes(segs))", "subarray(0)"],
  // —— 第四轮:R3-01..R3-06
  ["K63 stable \u6bb5\u62ff\u4f1a\u8bdd\u6d88\u606f\u6bd4\u5bf9(R3-04 \u539f\u9519)", "assemble.ts", "const hit = volatileIn(part.text);", "const hit = volatileIn(part.text) ?? (log.events.some((e) => e.body.kind === \"message\" && e.body.text.length >= 4 && part.text.includes(e.body.text)) ? \"\u6d88\u606f\u539f\u6587\" : undefined);"],
  ["K72 send 用调用方原对象为 this(R3-03 原错)", "plugins.ts", "send: (r: SendRequest) => send.call(self, r)", "send: (r: SendRequest) => send.call(raw, r)"],
  ["K73 \u64a4\u56de\u4e0d\u4f5c\u5e9f\u538b\u7f29\u5757(R3-01 \u539f\u9519)", "assemble.ts", "if (stale.length > 0) {", "if (false) {"],
  ["K74 不扫压缩块里的撤回原文", "assemble.ts", "${block.text}\\n`), block.text);", "${block.text}\\n`), \"\");"],
  ["K75 不扫会变状态里的撤回原文", "assemble.ts", "${opts.volatile}\\n`), opts.volatile);", "${opts.volatile}\\n`), \"\");"],
  ["K76 重建压缩块时交出撤回消息", "assemble.ts", "frozenSnapshot(all.filter((m) => m.seq <= b.throughSeq && !m.retracted))", "frozenSnapshot(all.filter((m) => m.seq <= b.throughSeq))"],
  ["K77 history 撤回不标 prefixBreak", "assemble.ts", "if (target > through && isNew(rs)) pushOwn(prefixBreaks", "if (false) pushOwn(prefixBreaks"],
  ["K78 \u540c\u4e00\u64a4\u56de\u6bcf\u8f6e\u91cd\u590d\u62a5 prefixBreak", "assemble.ts", "const isNew = (retractSeq: number) => opts.previousHeadSeq === undefined || retractSeq > opts.previousHeadSeq;", "const isNew = (_retractSeq: number) => true;"],
  ["K79 \u64a4\u56de\u540e\u7684\u7f16\u8f91\u6587\u5b57\u4ecd\u8fdb history", "assemble.ts", "      if (retracted.has(b.target)) continue;\n", ""],
  ["K80 编辑原地改写旧消息(R3-02 原错)", "assemble.ts", "push(seg(\"history\", \"message\", `#${e.seq} ${who(e)}: ${b.text}\\n`, { seq: e.seq }), b.text);", "push(seg(\"history\", \"message\", `#${e.seq} ${who(e)}: ${all.find((m) => m.seq === e.seq)?.text ?? b.text}\\n`, { seq: e.seq }), b.text);"],
  ["K81 编辑事件被丢掉(R3-02 原错)", "assemble.ts", "push(seg(\"history\", \"edit\",", "if (false) push(seg(\"history\", \"edit\","],
  ["K82 \u4e0d\u6821\u9a8c\u56fa\u5b9a\u6bb5\u987a\u5e8f(R3-05 \u539f\u9519)", "assemble.ts", "if (i < last) return", "if (false) return"],
  ["K83 \u4e0d\u6821\u9a8c\u56fa\u5b9a\u6bb5\u91cd\u590d", "assemble.ts", "if (seen.has(p.kind)) return", "if (false) return"],
  ["K84 \u4e0d\u6821\u9a8c\u751f\u6210\u70b9\u8303\u56f4", "assemble.ts", "if (c.builtAtSeq < c.throughSeq || c.builtAtSeq > head) return", "if (false) return"],
  ["K85 \u538b\u7f29\u70b9\u4e0d\u67e5\u975e\u8d1f\u6574\u6570(R3-05 \u539f\u9519)", "assemble.ts", "if (!isNat(c.throughSeq)) return", "if (false) return"],
  ["K86 helper \u6d88\u606f\u4e0d\u8fdb history(\u5ba1\u67e5 R3-M1)", "assemble.ts", "    if (b.kind === \"message\") {\n", "    if (b.kind === \"message\" && e.sender.kind !== \"helper\") {\n"],
  ["K87 \u4f1a\u53d8\u72b6\u6001\u88ab\u6362\u6210\u56fa\u5b9a\u5b57(\u5ba1\u67e5 R3-M2)", "assemble.ts", "`[\u5f53\u524d\u72b6\u6001]\\n${opts.volatile}\\n`", "`[\u5f53\u524d\u72b6\u6001]\\n\u65e0\\n`"],
  ["K88 \u4e0d\u8981\u6c42 endpoint", "plugins.ts", "if (!isStr(c.endpoint)) return", "if (false) return"],
  ["K89 不快照配置", "plugins.ts", "if (!plain.ok) return", "if (false) return"],
  // —— 第五轮:R4-01..R4-07
  ["K90 \u64a4\u56de\u539f\u6587\u6309 4 \u5b57\u9608\u503c\u653e\u884c(R4-01 \u539f\u9519)", "assemble.ts", "if (needle !== \"\" && hay.includes(needle)) return seq;", "if (needle.length >= 4 && hay.includes(needle)) return seq;"],
  ["K91 \u9608\u503c\u6539\u6210\u5927\u4e8e 4(\u5ba1\u67e5 R4-M2)", "assemble.ts", "if (needle !== \"\" && hay.includes(needle)) return seq;", "if (needle.length > 4 && hay.includes(needle)) return seq;"],
  ["K92 \u4e0d\u6536\u96c6\u64a4\u56de\u6d88\u606f\u7684\u7f16\u8f91\u6587\u672c(\u5ba1\u67e5 R4-M1)", "assemble.ts", "    if (b.kind === \"edit\" && retracted.has(b.target)) out.set(b.target, [...(out.get(b.target) ?? []), b.text]);\n", ""],
  ["K93 不做空白规范化", "assemble.ts", "  return t.replace(INVISIBLE, \"\");", "  return t;"],
  ["K94 最终请求边界不扫描", "assemble.ts", "const leaked = leakIn(bodies[i] ?? \"\", secret);", "const leaked = undefined as number | undefined;"],
  ["K95 不扫 stable 段", "assemble.ts", "${part.text}\\n`), part.text);", "${part.text}\\n`), \"\");"],
  ["K96 扫描包含宿主标签", "assemble.ts", "const leaked = leakIn(bodies[i] ?? \"\", secret);", "const leaked = leakIn(sg.text, secret);"],
  ["K97 \u56de\u8c03\u62ff\u5230\u53ef\u53d8\u539f\u5bf9\u8c61(R4-01 \u539f\u9519)", "assemble.ts", "const visible = frozenSnapshot(", "const visible = ((x: readonly ProjectedMessage[]) => x)("],
  ["K99 \u56de\u8c03\u629b\u9519\u4e0d\u515c\u5e95", "assemble.ts", "try { text = opts.recompress(b.throughSeq, visible); } catch (err) {", "try { text = opts.recompress(b.throughSeq, visible); } catch (err) { throw err;"],
  ["K100 放行 Map 等非普通对象(R4-02 原错)", "plain.ts", "  if (proto !== Object.prototype && proto !== null) {\n    return bad(at, \"只允许普通对象", "  if (false) {\n    return bad(at, \"只允许普通对象"],
  ["K101 放行配置 getter", "plain.ts", "    if (isAccessor(d)) return bad(`${at}.${k}`, \"不允许 getter/setter\");\n", ""],
  ["K102 this \u539f\u578b\u4e0d\u662f null", "plugins.ts", "  const self: Record<string, unknown> = Object.create(null);", "  const self: Record<string, unknown> = {};"],
  ["K103 this 不冻结", "plugins.ts", "  return Object.freeze(self);\n}", "  return self;\n}"],
  ["K104 嵌套对象不冻结", "plain.ts", "  return { ok: true, value: Object.freeze(out) };\n}", "  return { ok: true, value: depth > 0 ? out : Object.freeze(out) };\n}"],
  ["K105 放行类实例与继承原型(R4-03 原错)", "plain.ts", "if (proto !== Object.prototype && proto !== null) {", "if (depth > 0 && proto !== Object.prototype && proto !== null) {"],
  ["K106 请求里不带 endpoint(R4-02 原错)", "plugins.ts", "Object.freeze({ action_id: actionId, payload, endpoint })", "Object.freeze({ action_id: actionId, payload })"],
  ["K107 墙钟算 B1 窗口(R4-04 原错)", "plugins.ts", "const elapsed = reading - b.firstAttemptMonotonic;", "const elapsed = now() - b.firstAttemptAt;"],
  ["K109 账本键用分隔符拼接(R4-05 原错)", "plugins.ts", "  const entryOf = (pluginId: string, actionId: string) => ledger.get(pluginId)?.get(actionId);\n  const putEntry = (pluginId: string, actionId: string, e: LedgerEntry) => {\n    let m = ledger.get(pluginId);\n    if (!m) { m = new Map(); ledger.set(pluginId, m); }\n    m.set(actionId, e);\n  };", "  const flat = new Map<string, LedgerEntry>();\n  const entryOf = (pluginId: string, actionId: string) => flat.get(`${pluginId}\\u0000${actionId}`);\n  const putEntry = (pluginId: string, actionId: string, e: LedgerEntry) => { flat.set(`${pluginId}\\u0000${actionId}`, e); };"],
  ["K110 stable \u628a\u666e\u901a\u8bcd\u5f53\u52a8\u6001(R4-06 \u539f\u9519)", "assemble.ts", "  [\"\u6700\u8fd1 N \u6761\", /\u6700\u8fd1\\s*\\d+\\s*\u6761/],", "  [\"\u6700\u8fd1 N \u6761\", /\u6700\u8fd1\\s*\\d+\\s*\u6761/],\n  [\"\u65b0\u6d88\u606f\", /\u65b0\u6d88\u606f|\u521a\u624d\u8bf4|\u521a\u8bf4|\u6700\u65b0\u4e00\u6761/],"],
  // —— 第六轮:R5-01..R5-05
  ["K111 只删普通空格和换行(审查 R5-M1)", "assemble.ts", "const INVISIBLE = /[\\s\\u0085\\u200B-\\u200D\\u2060\\uFEFF]+/gu;", "const INVISIBLE = /[ \\n]+/gu;"],
  ["K127 不去零宽字符", "assemble.ts", "const INVISIBLE = /[\\s\\u0085\\u200B-\\u200D\\u2060\\uFEFF]+/gu;", "const INVISIBLE = /[\\s\\u0085]+/gu;"],
  ["K126 只收集第一条撤回消息(审查 R5-M2)", "assemble.ts", "if (b.kind === \"message\" && retracted.has(e.seq)) out.set", "if (b.kind === \"message\" && retracted.has(e.seq) && out.size === 0) out.set"],
  ["K112 只和首次读数比(R5-01 原错)", "plugins.ts", "if (!(reading >= prior.maxMonotonic)) prior.clockTrusted = false;", "if (!(reading >= b.firstAttemptMonotonic)) prior.clockTrusted = false;"],
  ["K113 读数回升恢复重试资格(R5-01 原错)", "plugins.ts", "if (!prior.clockTrusted) return", "if (!prior.clockTrusted && reading < prior.maxMonotonic) return"],
  ["K114 不更新已见最大读数", "plugins.ts", "else prior.maxMonotonic = reading;", "else void reading;"],
  ["K115 非有限读数不算不可信", "plugins.ts", "  return typeof v === \"number\" && Number.isFinite(v) ? v : Number.NaN;", "  return typeof v === \"number\" ? v : Number.NaN;"],
  ["K116 不查 Proxy", "plain.ts", "return bad(at, `不支持 ${typeof x}`);\n  if (types.isProxy(x)) return bad(at, \"不允许 Proxy\");\n", "return bad(at, `不支持 ${typeof x}`);\n"],
  ["K118 放行不可枚举属性", "plain.ts", "    if (!d.enumerable) return bad(`${at}.${k}`, \"不允许不可枚举属性\");\n", ""],
  ["K119 放行嵌套函数", "plain.ts", "if (!fnsHere) return", "if (false) return"],
  ["K120 不查稀疏数组", "plain.ts", "if (!d) return bad(`${at}[${i}]`, \"不允许稀疏数组\");", "if (!d) { out.push(null); continue; }"],
  ["K128 数组元素不查描述符(R5-02 原错)", "plain.ts", "    if (isAccessor(d)) return bad(`${at}[${i}]`, \"不允许 getter/setter\");\n    if (!d.enumerable) return bad(`${at}[${i}]`, \"不允许不可枚举属性\");\n    pushOwn(out, d.value);", "    if (!d.enumerable) return bad(`${at}[${i}]`, \"不允许不可枚举属性\");\n    pushOwn(out, (x as unknown[])[i]);"],
  ["K122 recompress 兜底直接读 message(R5-03 原错)", "assemble.ts", "不能改消息投影):${describeThrown(err)}", "不能改消息投影):${err instanceof Error ? err.message : \"未知错误\"}"],
  ["K124 按冒号分割猜正文(R5-04 原错)", "assemble.ts", "const leaked = leakIn(bodies[i] ?? \"\", secret);", "const leaked = leakIn(sg.text.slice(sg.text.indexOf(\": \") + 2), secret);"],
  ["K125 引用页入不扫正文", "assemble.ts", "{ seq: m.seq }), m.text);", "{ seq: m.seq }), \"\");"],
  // —— 统一普通数据对象判定接到全部对外入口
  ["K129 发送请求不过统一判定", "plugins.ts", "const plainReq = plainData(req, \"发送请求\");", "const plainReq = { ok: true as const, value: req } as ReturnType<typeof plainData>;"],
  ["K130 回执不过统一判定", "plugins.ts", "const plainGot = plainData(got, \"回执\");", "const plainGot = { ok: true as const, value: got } as ReturnType<typeof plainData>;"],
  ["K131 拉取事件不过统一判定", "plugins.ts", "const plain = plainData(raw, `事件[${index}]`);", "const plain = { ok: true as const, value: raw } as ReturnType<typeof plainData>;"],
  ["K132 拉取容器直接读下标", "plugins.ts", "const list = plainItems(batch, \"pull 结果\");", "const list = Array.isArray(batch) ? { ok: true as const, items: [...batch] } : plainItems(batch, \"pull 结果\");"],
  ["K133 装配日志不过统一判定", "assemble.ts", "const pl = plainData(logInput, \"日志\");", "const pl = { ok: true as const, value: logInput } as ReturnType<typeof plainData>;"],
  ["K134 装配选项不过统一判定", "assemble.ts", "const po = plainData(optsInput, \"装配选项\", { topFunctions: true });", "const po = { ok: true as const, value: optsInput } as ReturnType<typeof plainData>;"],
  ["K135 入站事件不过统一判定", "classify.ts", "const plain = plainData(input, \"入站事件\");", "const plain = { ok: true as const, value: input } as ReturnType<typeof plainData>;"],
  ["K136 undefined 属性不按 JSON 规则去掉", "plain.ts", "    if (d.value === undefined) continue;\n", ""],
  ["K138 放行数组上的额外属性", "plain.ts", "if (!INDEX.test(k) || Number(k) >= len) return", "if (false) return"],
  // —— 原型链污染:中间表与结果不经过原型链
  ["K139 描述符表走原型链(原型污染)", "plain.ts", "  const table: Record<string, PropertyDescriptor> = Object.create(null);", "  const table: Record<string, PropertyDescriptor> = {};"],
  ["K140 数组结果用 push(原型 setter / 只读下标)", "own.ts", "  Object.defineProperty(out, out.length, dataDesc(v));", "  out.push(v);"],
  // —— 第七轮:按 PR #6 第六轮审查 R6-01..R6-05 扩充,含审查自造 R6-M1=K142、R6-M2=K143
  ["K142 有限小数被拒(审查 R6-M1)", "plain.ts", "return Number.isFinite(x) ? { ok: true, value: x }", "return Number.isInteger(x) ? { ok: true, value: x }"],
  ["K143 空白改成白名单漏掉 U+000B(审查 R6-M2)", "assemble.ts", "const INVISIBLE = /[\\s\\u0085\\u200B-\\u200D\\u2060\\uFEFF]+/gu;", "const INVISIBLE = /[ \\t\\n\\r\\u00A0\\u3000\\u200B-\\u200D\\u2060\\uFEFF]+/gu;"],
  ["K144 空白只用 \\s,漏掉 U+0085", "assemble.ts", "const INVISIBLE = /[\\s\\u0085\\u200B-\\u200D\\u2060\\uFEFF]+/gu;", "const INVISIBLE = /[\\s\\u200B-\\u200D\\u2060\\uFEFF]+/gu;"],
  ["K145 defineProperty 描述符继承 Object.prototype(R6-01 原错)", "own.ts", "  const d: PropertyDescriptor = Object.create(null);\n  d.value = value;", "  const d: PropertyDescriptor = {};\n  d.value = value;"],
  ["K146 访问器判断读继承属性(R6-01 原错)", "plain.ts", "const isAccessor = (d: PropertyDescriptor): boolean => Object.hasOwn(d, \"get\") || Object.hasOwn(d, \"set\");", "const isAccessor = (d: PropertyDescriptor): boolean => \"get\" in d || \"set\" in d;"],
  ["K147 拉取结果用 push(R6-02 原错)", "plugins.ts", "else pushOwn(events, s);", "else events.push(s);"],
  ["K148 装配段用 push(R6-02 原错)", "assemble.ts", "const push = (sg: Segment, body: string) => { pushOwn(segments, sg); pushOwn(bodies, body); };", "const push = (sg: Segment, body: string) => { segments.push(sg); bodies.push(body); };"],
  ["K149 注册表选项不过统一判定(R6-03 原错)", "plugins.ts", "const plain = plainData(input ?? {}, \"注册表选项\", { topFunctions: true });", "const plain = { ok: true as const, value: input ?? {} } as ReturnType<typeof plainData>;"],
  ["K150 判定选项直接读 topFunctions(R6-03 原错)", "plain.ts", "    const fns = topFunctionsOf(opts);", "    const fns = (opts as PlainOptions | undefined)?.topFunctions === true;"],
  ["K151 序列化与前缀工具不过统一判定(R6-03 原错)", "assemble.ts", "  const plain = plainData(input, `${fn} 请求`);", "  const plain = { ok: true as const, value: input } as ReturnType<typeof plainData>;"],
  ["K152 分类结果不过统一判定(R6-04 原错)", "classify.ts", "    const p = plainData(raw, \"分类结果\");", "    const p = { ok: true as const, value: raw } as ReturnType<typeof plainData>;"],
  ["K153 诊断不标访问器", "plain.ts", "isAccessor(d) ? JSON.stringify(\"[getter/setter]\") : render(d.value, seen, depth + 1)", "render(d.value, seen, depth + 1)"],
  ["K154 发送结果读 then 判 thenable(R6-04 原错)", "plugins.ts", "  if (!types.isPromise(x) || types.isProxy(x)) return false;", "  if (typeof x === \"object\" && x !== null && typeof (x as { then?: unknown }).then === \"function\") return true;\n  if (!types.isPromise(x) || types.isProxy(x)) return false;"],
  ["K155 放行带自有 then 的 Promise(第十三轮改注入点到新实现)", "plugins.ts", "  if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;\n", ""],
  // —— 第八轮:按 PR #6 第七轮审查 R7-01/02/04/05/06 扩充,含审查自造 R7-M1=K156、R7-M2=K157、R7-M3=K158
  ["K156 topFunctions:false 也放行顶层函数(审查 R7-M1)", "plain.ts", "  return value;\n}", "  return true;\n}"],
  ["K157 预算恰好等于所需字节也判超(审查 R7-M2)", "assemble.ts", "if (need > opts.budgetBytes) return", "if (need >= opts.budgetBytes) return"],
  ["K158 同一可见旧消息重复引用重复页入(审查 R7-M3)", "assemble.ts", "if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (inHistory.has(seq)) continue;"],
  ["K159 pull 不判形态就 await(R7-01 原错;第十三轮、第十五轮改注入点到新实现)", "plugins.ts", "      if (!isPlainPromise(returned)) return { ok: false, reason: \"invalid-batch\", detail: NON_PROMISE_PULL };\n", ""],
  ["K160 appendOwn 不查目标是数组(R7-02 原错)", "plain.ts", "  if (!items(out, \"appendOwn 的目标\").ok) throw new TypeError(\"appendOwn 的目标必须是普通数组\");\n", ""],
  ["K161 squash 不查字符串(R7-02 原错)", "assemble.ts", "  if (typeof t !== \"string\") throw new TypeError(\"squash 只接受字符串\");\n", ""],
  ["K162 判定选项只看 topFunctions 一个键(R7-02 原错)", "plain.ts", "    if (!d || isAccessor(d) || k !== \"topFunctions\") return undefined;", "    if (k !== \"topFunctions\") continue;\n    if (!d || isAccessor(d)) return undefined;"],
  ["K163 宿主直接用导出的可变固定段顺序(R7-04 原错)", "assemble.ts", "const ORDER: readonly StableKind[] = Object.freeze([\"system\", \"tools\", \"persona\"] as StableKind[]);\nexport const STABLE_ORDER: readonly StableKind[] = Object.freeze([...ORDER]);", "export const STABLE_ORDER: readonly StableKind[] = [\"system\", \"tools\", \"persona\"];\nconst ORDER = STABLE_ORDER;"],
  ["K164 导出的固定段顺序不冻结(R7-04 原错)", "assemble.ts", "export const STABLE_ORDER: readonly StableKind[] = Object.freeze([...ORDER]);", "export const STABLE_ORDER: readonly StableKind[] = [...ORDER];"],
  ["K165 导出的事件枚举不冻结(R7-04 原错)", "classify.ts", "export const EVENT_CODES = Object.freeze([\"E1\", \"E2\", \"E3\", \"E4\", \"E5\", \"E6\", \"E7\", \"E8\", \"E9\", \"E10\"] as const);", "export const EVENT_CODES = [\"E1\", \"E2\", \"E3\", \"E4\", \"E5\", \"E6\", \"E7\", \"E8\", \"E9\", \"E10\"] as const;"],
  ["K166 日志是 null 时直接读字段(R7-06 原错)", "assemble.ts", "  if (!isRecord(pl.value)) return { ok: false, reason: \"invalid-input\", detail: \"日志必须是对象\" };\n", ""],
  ["K167 装配选项是 null 时直接读字段(R7-06 原错)", "assemble.ts", "  if (!isRecord(po.value)) return { ok: false, reason: \"invalid-input\", detail: \"装配选项必须是对象\" };\n", ""],
  ["K168 日志事件不查形状(R7-06 原错)", "assemble.ts", "  if (badEvent >= 0) return", "  if (false) return"],
  ["K169 入站事件是 null 时直接读字段(R7-06 原错)", "classify.ts", "    return { anchors: { mentions: [], quotes: [] }, intent: \"Uncertain\", via: \"mechanical\", violation: \"入站事件必须是对象\" };", "    return classifier as never;"],
  ["K170 确认卡是 null 时直接读字段(R7-06 原错)", "classify.ts", "    if (typeof anchors.card !== \"object\" || anchors.card === null || Array.isArray(anchors.card)) return", "    if (false) return"],
  ["K171 发送请求是 null 时直接读字段(R7-06 原错)", "plugins.ts", "      if (!isObj(plainReq.value) || Array.isArray(plainReq.value)) return { ok: false, state: \"rejected\", reason: \"invalid-payload\", detail: \"发送请求必须是对象\" };\n", ""],
  ["K172 序列化请求是 null 时直接读字段(R7-06 原错)", "assemble.ts", "  if (!isRecord(plain.value)) throw new TypeError(`${fn} 请求必须是对象`);\n", ""],
  // —— 第九轮:按 PR #6 第八轮审查 R8-01..R8-05 扩充,含审查自造 R8-M1=K173、R8-M2=K174、R8-M3=K175
  ["K173 appendOwn 放过 Proxy 目标(审查 R8-M1)", "plain.ts", "  if (!items(out, \"appendOwn 的目标\").ok) throw", "  if (!types.isProxy(out) && !items(out, \"appendOwn 的目标\").ok) throw"],
  ["K174 数组下标不查可枚举(审查 R8-M2)", "plain.ts", "    if (!d.enumerable) return bad(`${at}[${i}]`, \"不允许不可枚举属性\");\n", ""],
  ["K175 装配字节数按 UTF-16 长度算(审查 R8-M3)", "assemble.ts", "const bytesOf = (s: string) => Buffer.byteLength(s, \"utf8\");", "const bytesOf = (s: string) => s.length;"],
  ["K176 plainData 不查路径参数类型(R8-01 原错)", "plain.ts", "  if (typeof at !== \"string\") return badPath();\n  try {\n    const fns", "  try {\n    const fns"],
  ["K177 plainItems 不查路径参数类型(R8-01 原错;即审查 R9-M2)", "plain.ts", "  if (typeof at !== \"string\") return badPath();\n  try { return items", "  try { return items"],
  ["K178 appendOwn 只查是真数组且非 Proxy(R8-02 原错)", "plain.ts", "  if (!items(out, \"appendOwn 的目标\").ok) throw", "  if (!Array.isArray(out) || types.isProxy(out)) throw"],
  ["K179 pull 直接用 now() 盖收到时间(R8-03 原错)", "plugins.ts", "      const receivedAt = isoOf(readClock(now));", "      const receivedAt = new Date(now() as number).toISOString();"],
  ["K180 首次发送不查墙钟(R8-03 原错)", "plugins.ts", "        if (isoOf(firstAttemptAt) === undefined) return", "        if (false) return"],
  ["K181 时钟读数不查类型原样返回(R8-03 原错)", "plugins.ts", "  return typeof v === \"number\" && Number.isFinite(v) ? v : Number.NaN;", "  return v as number;"],
  ["K182 墙钟不查 Date 范围", "plugins.ts", "  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();", "  return d.toISOString();"],
  ["K187 首次单调读数原样存储(R8-03 原错)", "plugins.ts", "        const firstAttemptMonotonic = readClock(monotonic);", "        const firstAttemptMonotonic = monotonic();"],
  // —— 第十轮:按 PR #6 第九轮审查 R9-02 扩充,含审查自造 R9-M1=K188、R9-M3=K189(R9-M2 与 K177 注入点相同,见上)
  ["K188 墙钟只认整数毫秒(审查 R9-M1)", "plugins.ts", "  if (!Number.isFinite(ms)) return undefined;", "  if (!Number.isInteger(ms)) return undefined;"],
  ["K189 原生 Promise 判定不查原型,子类也 await(审查 R9-M3)", "plugins.ts", "  if (Object.getPrototypeOf(x) !== Promise.prototype) return false;\n", ""],
  // —— 第十轮:R9-01(用户 g-group#3140 选 A)单点故障;第十一轮按新实现改写注入点,语义不变
  // —— 第十一轮:按 PR #6 第十轮审查 R10-01 / R10-02 扩充,含审查自造 R10-M1=K197、R10-M2=K198、R10-M3=K199
  ["K198 墙钟先向下取整再转时间(审查 R10-M2)", "plugins.ts", "  const d = new Date(ms);", "  const d = new Date(Math.floor(ms));"],
  ["K199 时钟读数只认整数(审查 R10-M3)", "plugins.ts", "  return typeof v === \"number\" && Number.isFinite(v) ? v : Number.NaN;", "  return typeof v === \"number\" && Number.isInteger(v) ? v : Number.NaN;"],
  // —— 第十二轮:按 PR #6 第十一轮审查 R11-01 / R11-02 / R11-03 扩充,含审查自造的单点故障 R11-M1=K210、R11-M3=K211
  ["K214 数组键只查十进制文本,不查是否落在 length 内(回到 R11-02 原错)", "plain.ts", "if (!INDEX.test(k) || Number(k) >= len) return", "if (!INDEX.test(k)) return"],
  // —— 第十三轮:按 PR #6 第十二轮审查 R12-01..R12-04 扩充,含审查自造的单点故障 R12-O1=K228、R12-O2=K226
  ["K222 原生 Promise 判定不查可扩展(冻结的也 await,开着钩子时 Node 在钩子里抛错)", "plugins.ts", "  if (!Object.isExtensible(x)) return false;\n", ""],
  ["K224 追踪键只认 async_id_symbol,漏掉 trigger_async_id_symbol", "plugins.ts", "new Set([\"async_id_symbol\", \"trigger_async_id_symbol\"])", "new Set([\"async_id_symbol\"])"],
  ["K225 原生 Promise 判定不查其它自有访问器(回到 R12-02 原错)", "plugins.ts", "    if (!(\"value\" in d)) return false;\n", ""],
  ["K226 拒绝合法的空字符串附件名(审查 R12-O2)", "plugins.ts", "if (a.name !== undefined && typeof a.name !== \"string\") return undefined;", "if (a.name !== undefined && (typeof a.name !== \"string\" || a.name === \"\")) return undefined;"],
  ["K227 拒绝合法的空字符串附件 mime", "plugins.ts", "if (a.mime !== undefined && typeof a.mime !== \"string\") return undefined;", "if (a.mime !== undefined && (typeof a.mime !== \"string\" || a.mime === \"\")) return undefined;"],
  ["K228 点名 end 不查整数(审查 R12-O1)", "classify.ts", "!Number.isInteger(end)", "false"],
  ["K229 点名 start 不查整数", "classify.ts", "!Number.isInteger(start)", "false"],
  ["K230 外部请求不核对 bytes 与正文 UTF-8 字节数(回到 R12-03 原错)", "assemble.ts", "    if (sg.bytes !== real) throw new TypeError(", "    if (false) throw new TypeError("],
  ["K231 按 UTF-16 长度核对 bytes(合法中文请求被拒)", "assemble.ts", "    const real = bytesOf(sg.text);", "    const real = sg.text.length;"],
  ["K232 不查段顺序(tail 在前时前缀哈希盖到 tail 上)", "assemble.ts", "if (r === undefined || r < rank) throw", "if (r === undefined) throw"],
  ["K233 不查 section 取值(未知段名算进前缀)", "assemble.ts", "if (r === undefined || r < rank) throw", "if (r !== undefined && r < rank) throw"],
  ["K234 原生 Promise 判定不查追踪符号的值(值为带 valueOf 的对象也 await,Node 转数字时执行插件代码)", "plugins.ts", "    if (isTracking(k) && !safeId(d.value)) return false;\n", ""],
  ["K238 追踪符号的值把 BigInt 也当安全(Node 转数字时抛 TypeError)", "plugins.ts", "typeof v === \"number\" || v === undefined;", "typeof v === \"number\" || typeof v === \"bigint\" || v === undefined;"],
  // —— 第十四轮:用户 2026-11-09 按根因改合同(拒收只判定、不处理),删掉拒收挂处理机制及其 36 个变异(K183–K186、K190–K197、K200–K208、
  // K210–K213、K215–K221、K223、K235–K237),下面三个变异各自回到一种「内核替插件的失败兜底」的做法,必须被具名测试杀死
  ["K239 send 拒收后仍用内置 then 给它挂空拒绝处理(回到 R8-04 做法:会执行插件的访问器与子类构造)", "plugins.ts", "    if (!isPlainPromise(pending)) return unknown(", "    if (!isPlainPromise(pending) && types.isPromise(pending)) { try { Reflect.apply(Promise.prototype.then, pending, [undefined, () => {}]); } catch { /* 变异 */ } }\n    if (!isPlainPromise(pending)) return unknown("],
  ["K240 pull 拒收后仍用内置 then 给它挂空拒绝处理(第十五轮改注入点到新实现)", "plugins.ts", "      if (!isPlainPromise(returned)) return { ok: false, reason: \"invalid-batch\", detail: NON_PROMISE_PULL };\n", "      if (!isPlainPromise(returned) && types.isPromise(returned)) { try { Reflect.apply(Promise.prototype.then, returned, [undefined, () => {}]); } catch { /* 变异 */ } }\n      if (!isPlainPromise(returned)) return { ok: false, reason: \"invalid-batch\", detail: NON_PROMISE_PULL };\n"],
  ["K241 建注册表时装全局 unhandledRejection 处理器吞掉插件的失败(改了宿主的全局失败语义)", "plugins.ts", "  const { now, monotonic, sendTimeoutMs } = registryOptions(opts);", "  process.on(\"unhandledRejection\", () => {});\n  const { now, monotonic, sendTimeoutMs } = registryOptions(opts);"],
  // —— 第十五轮(第十四轮审查 R14-01..R14-03)
  ["K242 pull 判定失败后仍把同步普通数组当批次处理并盖章(回到 R14-01 原错)", "plugins.ts", "      if (!isPlainPromise(returned)) return { ok: false, reason: \"invalid-batch\"", "      if (!isPlainPromise(returned) && !Array.isArray(returned)) return { ok: false, reason: \"invalid-batch\""],
  ["K243 拒收有自有 then/constructor 的可扩展 Promise 时临时加自有属性、期间创建一个 Promise、再删掉(审查 M1:返回前后看不出)", "plugins.ts", "  if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "  if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) {\n    if (Object.isExtensible(x)) { Object.defineProperty(x, \"__neutral_temporary__\", { value: 1, configurable: true }); void Promise.resolve(); Reflect.deleteProperty(x, \"__neutral_temporary__\"); }\n    return false;\n  }"],
  ["K244 额外拒绝不可枚举的自有数据属性(审查 M2:合同只要求都是数据属性)", "plugins.ts", "    if (!(\"value\" in d)) return false;\n", "    if (!(\"value\" in d)) return false;\n    if (typeof k === \"string\" && !d.enumerable) return false;\n"],
  ["K245 追踪符号上的数字只接受整数(审查 M3:合同是数字或 undefined)", "plugins.ts", "typeof v === \"number\" || v === undefined;", "(typeof v === \"number\" && Number.isInteger(v)) || v === undefined;"],
  ["K246 sendTimeoutMs 不查上限(回到 R14-03 原错:超过 Node 定时器上限被缩成 1 毫秒)", "plugins.ts", "o.sendTimeoutMs > 0 && o.sendTimeoutMs <= MAX_SEND_TIMEOUT_MS)", "o.sendTimeoutMs > 0)"],
  ["K247 sendTimeoutMs 上限差一(把合法的 2147483647 也拒了)", "plugins.ts", "o.sendTimeoutMs > 0 && o.sendTimeoutMs <= MAX_SEND_TIMEOUT_MS)", "o.sendTimeoutMs > 0 && o.sendTimeoutMs < MAX_SEND_TIMEOUT_MS)"],
  // 第十六轮按第十五轮审查 R15-01:拒收过程中同步临时改写、期间不产生异步事件(审查注入原样)
  ["K248 拒收时同步给插件 Promise 加再删中性自有属性(审查 R15 注入①)", "plugins.ts", 'if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) return false;', 'if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) { if (Object.isExtensible(x)) { Object.defineProperty(x, "__neutral_temporary__", { value: 1, configurable: true }); Reflect.deleteProperty(x, "__neutral_temporary__"); } return false; }'],
  ["K249 拒收时同步给 Promise.prototype 加再删中性属性(审查 R15 注入②)", "plugins.ts", 'if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) return false;', 'if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) { Object.defineProperty(Promise.prototype, "__neutral_temporary__", { value: 1, configurable: true }); Reflect.deleteProperty(Promise.prototype, "__neutral_temporary__"); return false; }'],
  // 第十七轮:审查两个存活故障 + 分流单开关,指定发现者;不同写法与事件控制。
  ["K250 已有可写自有数据属性改值再恢复(R16-01/H16-P1)", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { for (const k of Reflect.ownKeys(x)) { const d = Object.getOwnPropertyDescriptor(x, k); if (d === undefined || !(\"value\" in d) || !d.writable) continue; const old = d.value; Object.defineProperty(x, k, { ...d, value: 1 }); Object.defineProperty(x, k, { ...d, value: old }); } return false; }", "R17-01"],
  ["K251 Map.prototype 同步加再删(R16-01/H16-P2)", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Map.prototype, \"__neutral_temporary__\", { value: 1, configurable: true }); Reflect.deleteProperty(Map.prototype, \"__neutral_temporary__\"); return false; }", "R17-02"],
  ["K253 赋值改已有自有值再恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { const d = Object.getOwnPropertyDescriptor(x, \"then\"); if (d && \"value\" in d && d.writable) { const o = x as unknown as {then: unknown}; const old = o.then; o.then = 1; o.then = old; } return false; }", "R17-01"],
  ["K254 Reflect.set 改已有自有值再恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { const d = Object.getOwnPropertyDescriptor(x, \"then\"); if (d && \"value\" in d && d.writable) { const old = d.value; Reflect.set(x, \"then\", 1); Reflect.set(x, \"then\", old); } return false; }", "R17-01"],
  ["K255 WeakMap.prototype Reflect 同步加再删", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Reflect.defineProperty(WeakMap.prototype, \"__neutral_temporary__\", { value: 1, configurable: true }); Reflect.deleteProperty(WeakMap.prototype, \"__neutral_temporary__\"); return false; }", "R17-02"],
  ["K256 改已有值期间产生异步事件再恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { for (const k of Reflect.ownKeys(x)) { const d = Object.getOwnPropertyDescriptor(x, k); if (d === undefined || !(\"value\" in d) || !d.writable) continue; Object.defineProperty(x, k, { ...d, value: 1 }); void Promise.resolve(); Object.defineProperty(x, k, d); } return false; }", "R17-01"],
  ["K257 Map.prototype 改写期间产生异步事件再恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Map.prototype, \"__neutral_temporary__\", { value: 1, configurable: true }); void Promise.resolve(); Reflect.deleteProperty(Map.prototype, \"__neutral_temporary__\"); return false; }", "R17-02"],
  ["K252 混合点名删除 invalidMentions 条件(R16-02)", "classify.ts", " || a.invalidMentions > 0", "", "R17-03"],

  // 第十八轮:具名正例、窗口操作检查和观察规则自身的标定。
  ["K258 JSON 写后恢复 无事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(JSON, \"__neutral_temporary__\", {value:1, configurable:true}); Reflect.deleteProperty(JSON, \"__neutral_temporary__\"); return false; }", "R18-01"],
  ["K259 JSON 写后恢复 有事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(JSON, \"__neutral_temporary__\", {value:1, configurable:true}); void Promise.resolve(); Reflect.deleteProperty(JSON, \"__neutral_temporary__\"); return false; }", "R18-01"],
  ["K260 Intl.DateTimeFormat.prototype 写后恢复 无事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Intl.DateTimeFormat.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); Reflect.deleteProperty(Intl.DateTimeFormat.prototype, \"__neutral_temporary__\"); return false; }", "R18-02"],
  ["K261 Intl.DateTimeFormat.prototype 写后恢复 有事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Intl.DateTimeFormat.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); void Promise.resolve(); Reflect.deleteProperty(Intl.DateTimeFormat.prototype, \"__neutral_temporary__\"); return false; }", "R18-02"],
  ["K262 Math 写后恢复 无事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Math, \"__neutral_temporary__\", {value:1, configurable:true}); Reflect.deleteProperty(Math, \"__neutral_temporary__\"); return false; }", "R18-03"],
  ["K263 Math 写后恢复 有事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Math, \"__neutral_temporary__\", {value:1, configurable:true}); void Promise.resolve(); Reflect.deleteProperty(Math, \"__neutral_temporary__\"); return false; }", "R18-03"],
  ["K264 Intl.Collator.prototype 写后恢复 无事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Intl.Collator.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); Reflect.deleteProperty(Intl.Collator.prototype, \"__neutral_temporary__\"); return false; }", "R18-04"],
  ["K265 Intl.Collator.prototype 写后恢复 有事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(Intl.Collator.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); void Promise.resolve(); Reflect.deleteProperty(Intl.Collator.prototype, \"__neutral_temporary__\"); return false; }", "R18-04"],
  ["K266 WebAssembly.Table.prototype 写后恢复 无事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(WebAssembly.Table.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); Reflect.deleteProperty(WebAssembly.Table.prototype, \"__neutral_temporary__\"); return false; }", "R18-05"],
  ["K267 WebAssembly.Table.prototype 写后恢复 有事件", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.defineProperty(WebAssembly.Table.prototype, \"__neutral_temporary__\", {value:1, configurable:true}); void Promise.resolve(); Reflect.deleteProperty(WebAssembly.Table.prototype, \"__neutral_temporary__\"); return false; }", "R18-05"],
  ["K268 旗标改回", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { for (const k of [\"then\", \"constructor\"]) { const d = Object.getOwnPropertyDescriptor(x,k); if (d?.configurable) { Object.defineProperty(x,k,{...d,enumerable:!d.enumerable}); Object.defineProperty(x,k,d); } } return false; }", "R17-01"],
  ["K269 原型换回", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { const p = Object.getPrototypeOf(x); Object.setPrototypeOf(x,null); Object.setPrototypeOf(x,p); return false; }", "R17-01"],
  ["K270 不可扩展性写", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object.preventExtensions(x); return false; }", "R17-01"],
  ["K271 别名调用", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { const f=Object.defineProperty; f(JSON,\"__neutral__\",{value:1,configurable:true}); Reflect.deleteProperty(JSON,\"__neutral__\"); return false; }", "R18-07"],
  ["K272 计算调用", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { Object[\"defineProperty\"](JSON,\"__neutral__\",{value:1,configurable:true}); Reflect.deleteProperty(JSON,\"__neutral__\"); return false; }", "R18-07"],
  ["K273 safeId 内写", "plugins.ts", "typeof v === \"number\" || v === undefined", "(Reflect.set(JSON,\"__neutral__\",1), Reflect.deleteProperty(JSON,\"__neutral__\"), typeof v === \"number\" || v === undefined)", "R18-07"],
  ["K274 eval 内写后恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { eval(\"JSON.__neutral__=1; delete JSON.__neutral__\"); return false; }", "R18-07"],
  ["K275 new Function 内写后恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { new Function(\"o\", \"o.__neutral__=1; delete o.__neutral__\")(JSON); return false; }", "R18-07"],
  ["K276 遮蔽原生绑定", "plugins.ts", "function isPlainPromise(x: unknown): x is Promise<unknown> {", "function isPlainPromise(x: unknown): x is Promise<unknown> { const Object = globalThis.Object;", "R18-07"],
  ["K277 插件交回与判定之间写", "plugins.ts", "if (!isPlainPromise(returned))", "Reflect.set(JSON,\"__neutral__\",1); Reflect.deleteProperty(JSON,\"__neutral__\"); if (!isPlainPromise(returned))", "R18-07"],
  ["K278 放行纯空白 id", "plugins.ts", "!isStr(c.id) || c.id.trim() === \"\"", "!isStr(c.id)", "R18-08"],
  ["K279 操作检查恒放行", "../fixtures/rejection-operations.mjs", "export function auditRejectionSource(code) {", "export function auditRejectionSource(code) { return [];", "R18-07"],
  ["K280 观察器丢全局根", "../fixtures/sync-window.mjs", "const hosts = closure([globalThis]);", "const hosts = closure([]);", "R18-01"],
  ["K281 观察器漏符号边", "../fixtures/sync-window.mjs", "Reflect.ownKeys(ds)", "Object.keys(ds)", "R18-06"],
  ["K282 观察器漏访问器函数边", "../fixtures/sync-window.mjs", "else { add(d.get); add(d.set); }", "else { /* 故障:不收 get/set 函数 */ }", "R18-06"],
  ["K283 hy4 B3 原形 new Function 改值再恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { const d = Object.getOwnPropertyDescriptor(x, \"then\"); if (d && \"value\" in d && d.writable) { new Function(\"o\", \"old\", \"o.then = 1; o.then = old;\")(x, d.value); } return false; }", "R18-07"],
  ["K284 hy4 B4 原形 eval Map 原型写后恢复", "plugins.ts", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) return false;", "if (Object.hasOwn(x, \"then\") || Object.hasOwn(x, \"constructor\")) { eval(\"Object.defineProperty(Map.prototype, '__neutral_temporary__', { value: 1, configurable: true }); Reflect.deleteProperty(Map.prototype, '__neutral_temporary__');\"); return false; }", "R18-07"],
  ["K285 isTracking 读属性之前丢类型保护", "plugins.ts", "typeof k === \"symbol\" && TRACKING.has(k.description ?? \"\")", "TRACKING.has(k.description ?? \"\")", "R18-07"],
  ["K286 isTracking 调用传入未经值域约束的对象", "plugins.ts", "isTracking(k) && !safeId(d.value)", "isTracking(x as PropertyKey) && !safeId(d.value)", "R18-07"],
];

const TIMEOUT_MS = Number(process.env.KERNEL_MUT_TIMEOUT_MS ?? 300_000);
const CONCURRENCY = process.env.KERNEL_MUT_CONCURRENCY ? [`--test-concurrency=${Number(process.env.KERNEL_MUT_CONCURRENCY)}`] : [];
const ONLY = process.env.KERNEL_MUT_ONLY ? new RegExp(process.env.KERNEL_MUT_ONLY) : undefined;
const CANARY = process.argv.includes("--canary-hang");

/** 跑一个副本的全部测试;超时杀掉整个进程组,返回 timedOut。 */
function run(dir, timeoutMs = TIMEOUT_MS) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...CONCURRENCY, "--test-reporter=tap", ...files], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill(); // 回收可能残留的孙进程
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut, out, stderr });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const LOG_DIR = process.env.KERNEL_MUT_LOG_DIR;
if (LOG_DIR) fs.mkdirSync(LOG_DIR, { recursive: true });
function save(tag, r) { if (LOG_DIR) fs.writeFileSync(path.join(LOG_DIR, `${tag}.tap`), r.out + r.stderr + `\nEXIT=${r.code} TIMEOUT=${r.timedOut}\n`); }
async function main() {
  console.log(`node ${process.version},每个变异超时 ${secs(TIMEOUT_MS)}`);
  if (CANARY) {
    const d = copy("canary");
    const f = path.join(d, "src", "assemble.ts");
    // 按函数名定位注入点;找不到就直接判失败,不能让替换静默落空
    const code = fs.readFileSync(f, "utf8");
    const m = /export function assemble\([^)]*\)[^{]*\{/.exec(code);
    if (!m) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log("✗ 金丝雀:找不到 assemble 的函数头,注入点失效(更新本脚本)");
      process.exit(1);
    }
    fs.writeFileSync(f, code.replace(m[0], `${m[0]}\n  for (;;) { /* 金丝雀:必然卡住 */ }`));
    const t0 = Date.now();
    const r = await run(d, Number(process.env.KERNEL_MUT_TIMEOUT_MS ?? 5_000));
    fs.rmSync(tmp, { recursive: true, force: true });
    const good = r.timedOut;
    console.log(`${good ? "✓" : "✗"} 金丝雀(必然卡住的变异):${r.timedOut ? `超时被杀,用时 ${secs(Date.now() - t0)},记 ✗ 超时、不算杀死` : "没有超时,脚本超时机制失效"}`);
    process.exit(good ? 0 : 1);
  }
  let ok = true;
  const clean = await run(copy("clean"));
  save("clean", clean);
  const named = new Set(clean.passed);
  const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
  console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.timedOut ? ",超时" : ""}`);
  if (!cleanOk) { fs.rmSync(tmp, { recursive: true, force: true }); console.log("原样副本失败,本段标定无效"); process.exit(1); }
  let killedN = 0, survived = 0, timeouts = 0;
  const list = ONLY ? M.filter(([name]) => ONLY.test(name)) : M;
  if (ONLY) console.log(`只跑名字匹配 ${ONLY} 的 ${list.length} 个变异(调试用,不是正式校准)`);
  let next = 0;
  const width = Math.max(1, Math.min(2, Number(process.env.KERNEL_MUT_JOBS ?? 1)));
  await Promise.all(Array.from({ length: width }, async () => {
   while (next < list.length) {
    const i = next++;
    const [name, file, from, to, designated] = list[i];
    const tag = `[${i + 1}/${list.length}]`;
    const d = copy(`m${i}`);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次(实现已变,更新本脚本)`); continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const t0 = Date.now();
    const r = await run(d);
    save(name.split(" ")[0], r);
    fs.rmSync(d, { recursive: true, force: true });
    // 只有原样副本里通过的具名测试变红才算杀死;文件级失败、超时都不算
    const kills = r.failed.filter((t) => named.has(t) && (!designated || t.startsWith(designated)));
    const countOk = r.passed.length + r.failed.length === clean.passed.length && /^# cancelled 0$/m.test(r.out) && /^# skipped 0$/m.test(r.out) && /^# todo 0$/m.test(r.out);
    if (r.timedOut) {
      ok = false; timeouts++;
      console.log(`✗ ${tag} ${name}:超时 ${secs(TIMEOUT_MS)} 被强制结束,不算杀死(超时前 ${r.passed.length} 绿 / ${r.failed.length} 红)`);
    } else if (countOk && kills.length > 0) {
      killedN++;
      console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs(Date.now() - t0)},被「${kills[0]}」发现`);
    } else {
      ok = false; survived++;
      console.log(`✗ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,存活(或缺指定发现者/完整执行计数不符)`);
    }
   }
  }));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`合计 ${list.length}:杀死 ${killedN},存活 ${survived},超时 ${timeouts}`);
  console.log(ok ? "变异校准通过" : "变异校准失败");
  process.exit(ok ? 0 : 1);
}
await main();
