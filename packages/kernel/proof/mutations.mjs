// 行为变异校准(R-05 阳性埋雷):对 kernel 包的实现逐个注入单一故障(第二轮按 PR #6 审查 F-01..F-06 扩充,含审查存活的 M1=K14、M2=K15;第三轮按 RR-01..RR-05 与 AC-39 扩充,含 R2-M1=K51、R2-M2=K52,删掉方向反了的旧 K36;第四轮按 R3-01..R3-07 扩充,含 R3-M1=K86、R3-M2=K87,每个变异有超时;第五轮按 R4-01..R4-07 扩充,含 R4-M1=K92、R4-M2=K91;第六轮按 R5-01..R5-05 扩充,含 R5-M1=K111、R5-M2=K126;第七轮按 R6-01..R6-05 扩充,含 R6-M1=K142、R6-M2=K143;第八轮按 R7-01/02/04/05/06 扩充,含 R7-M1=K156、R7-M2=K157、R7-M3=K158;第九轮按 R8-01..R8-05 扩充,含 R8-M1=K173、R8-M2=K174、R8-M3=K175;第十轮按 R9-02 扩充,含 R9-M1=K188、R9-M2=K177、R9-M3=K189),在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败(文件级加载失败不算杀死)。注入点必须在源码里恰好出现 1 次。
// 原样副本必须全绿(阴性对照)。
// 每个变异在独立进程组里跑,超时(默认 300s,KERNEL_MUT_TIMEOUT_MS 可改)就杀掉整个进程组,记 ✗ 超时,不算被杀死。
// 用法: node packages/kernel/proof/mutations.mjs
//       node packages/kernel/proof/mutations.mjs --canary-hang   注入一个必然卡住的变异,验证脚本能有界退出并把它记成超时
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
  ["K30 同步返回值当回执", "plugins.ts", "if (!isPlainPromise(pending)) { quietRefused(pending); return unknown(", "if (false) { quietRefused(pending); return unknown("],
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
  ["K138 放行数组上的额外属性", "plain.ts", "if (k !== \"length\" && !INDEX.test(k)) return", "if (false) return"],
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
  ["K155 放行带自有 then 的 Promise", "plugins.ts", "  return !Object.hasOwn(x, \"then\") && !Object.hasOwn(x, \"constructor\");", "  return true;"],
  // —— 第八轮:按 PR #6 第七轮审查 R7-01/02/04/05/06 扩充,含审查自造 R7-M1=K156、R7-M2=K157、R7-M3=K158
  ["K156 topFunctions:false 也放行顶层函数(审查 R7-M1)", "plain.ts", "  return value;\n}", "  return true;\n}"],
  ["K157 预算恰好等于所需字节也判超(审查 R7-M2)", "assemble.ts", "if (need > opts.budgetBytes) return", "if (need >= opts.budgetBytes) return"],
  ["K158 同一可见旧消息重复引用重复页入(审查 R7-M3)", "assemble.ts", "if (inHistory.has(seq) || paged.some((p) => p.seq === seq)) continue;", "if (inHistory.has(seq)) continue;"],
  ["K159 pull 不判形态就 await(R7-01 原错)", "plugins.ts", "try { batch = isPlainPromise(returned) ? await returned : returned; }", "try { batch = await returned; }"],
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
  ["K183 拒收的原生 Promise 不挂拒绝处理(R8-04 原错)", "plugins.ts", "  Reflect.apply(Promise.prototype.then, x, [undefined, () => {}]);", "  void x;"],
  ["K184 带自有 constructor 的 Promise 也用内置 then 挂处理(会执行插件访问器)", "plugins.ts", "if (Object.getPrototypeOf(x) !== Promise.prototype || Object.hasOwn(x, \"constructor\")) return;", "if (Object.getPrototypeOf(x) !== Promise.prototype) return;"],
  ["K185 pull 拒收时不挂处理(R8-04 原错)", "plugins.ts", "      if (!isPlainPromise(returned)) quietRefused(returned);\n", ""],
  ["K186 send 拒收时不挂处理(R8-04 原错)", "plugins.ts", "{ quietRefused(pending); return unknown(", "{ return unknown("],
  ["K187 首次单调读数原样存储(R8-03 原错)", "plugins.ts", "        const firstAttemptMonotonic = readClock(monotonic);", "        const firstAttemptMonotonic = monotonic();"],
  // —— 第十轮:按 PR #6 第九轮审查 R9-02 扩充,含审查自造 R9-M1=K188、R9-M3=K189(R9-M2 与 K177 注入点相同,见上)
  ["K188 墙钟只认整数毫秒(审查 R9-M1)", "plugins.ts", "  if (!Number.isFinite(ms)) return undefined;", "  if (!Number.isInteger(ms)) return undefined;"],
  ["K189 原生 Promise 判定不查原型,子类也 await(审查 R9-M3)", "plugins.ts", "  if (Object.getPrototypeOf(x) !== Promise.prototype) return false;\n", ""],
];

const TIMEOUT_MS = Number(process.env.KERNEL_MUT_TIMEOUT_MS ?? 300_000);
const CANARY = process.argv.includes("--canary-hang");

/** 跑一个副本的全部测试;超时杀掉整个进程组,返回 timedOut。 */
function run(dir, timeoutMs = TIMEOUT_MS) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill(); // 回收可能残留的孙进程
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
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
  const named = new Set(clean.passed);
  const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
  console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.timedOut ? ",超时" : ""}`);
  if (!cleanOk) ok = false;
  let killedN = 0, survived = 0, timeouts = 0;
  for (const [i, [name, file, from, to]] of M.entries()) {
    const tag = `[${i + 1}/${M.length}]`;
    const d = copy(`m${i}`);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次(实现已变,更新本脚本)`); continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const t0 = Date.now();
    const r = await run(d);
    fs.rmSync(d, { recursive: true, force: true });
    // 只有原样副本里通过的具名测试变红才算杀死;文件级失败、超时都不算
    const kills = r.failed.filter((t) => named.has(t));
    if (r.timedOut) {
      ok = false; timeouts++;
      console.log(`✗ ${tag} ${name}:超时 ${secs(TIMEOUT_MS)} 被强制结束,不算杀死(超时前 ${r.passed.length} 绿 / ${r.failed.length} 红)`);
    } else if (kills.length > 0) {
      killedN++;
      console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs(Date.now() - t0)},被「${kills[0]}」发现`);
    } else {
      ok = false; survived++;
      console.log(`✗ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`合计 ${M.length}:杀死 ${killedN},存活 ${survived},超时 ${timeouts}`);
  console.log(ok ? "变异校准通过" : "变异校准失败");
  process.exit(ok ? 0 : 1);
}
await main();
