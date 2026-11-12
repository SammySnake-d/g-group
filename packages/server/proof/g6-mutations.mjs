// T-177 G6 runner 的一对一定点变异(R-05 阳性埋雷):每个具名判据配一个单点故障,逐个注入,在隔离副本里跑 g6 的测试文件;
// 每个变异都必须让「指定的那条」具名测试失败(原样副本里它是绿的;文件级加载失败、导入失败不算杀死),每处注入点必须恰好出现 1 次;
// 原样副本必须全绿(阴性对照),变异前后各跑一遍。并发 1。
// 副本带整份 packages/(proof 下只带 g6/),node_modules 第三方链到原树,@g-group/* 链到副本自己的包。
// 用法: node packages/server/proof/g6-mutations.mjs   (只跑部分:MUT_ONLY=F01,C03;结果另存:MUT_OUT=文件)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const D = "packages/server/proof/g6";
const TESTS = ["capture", "contracts", "driver", "fixture", "groups", "manifest", "report", "run", "score", "standin"].map((t) => `${D}/${t}.test.ts`);
const F = (n) => `${D}/${n}.ts`;
/** [编号, 说明, 应杀死它的具名测试, [[文件, 原文, 改成]...]] */
const M = [
  ["F01", "题集自检不再拒收复读即答对的追问", "自检拒收复读即答对、needs 出现在问题里、同题重复原文、编辑指向后面的步", [[F("fixture"), 'if (p.expect !== null && compiles(p.expect) && new RegExp(p.expect, "i").test(s.text)) out.push', "if (false) out.push"]]],
  ["F02", "规范化 JSON 不排序键", "规范化 JSON:键排序、去掉 undefined,数组保序", [[F("fixture"), "    .sort()\n", ""]]],
  ["F03", "填充句每步都从头取(不按题内偏移)", "填充句按题内出现顺序轮流取,同一题里不重复", [[F("fixture"), "set.fillers[(offset + k) % n]", "set.fillers[k % n]"]]],
  ["F04", "题集 v1 的摘要不随内容变(只摘 id)", "题集 v1 自检干净,摘要是固定的 64 位十六进制,改一个字就变", [[F("fixture"), "update(canonicalJson(set))", "update(set.id)"]]],
  ["F05", "加载题集不做自检", "题集 v1 含方案要求的题型、故障注入与禁入原文", [[F("fixture"), "  const set = JSON.parse(readFileSync(file, \"utf8\")) as FixtureSet;\n", "  const set = { ...(JSON.parse(readFileSync(file, \"utf8\")) as FixtureSet), items: [] };\n"]]],
  ["C01", "调用归类认不出检查(都当补写笔记)", "请求体解析:system 数组、工具结果都进文字,带工具才算一轮", [[F("capture"), `  if (r.system.includes('"memories"')) return "check";\n`, ""]]],
  ["C02", "截断(max_tokens)当成功", "runner 自己判调用结果:检查要带 memories 的 JSON,截断与空输出都不算成功", [[F("capture"), '  if (r.stopReason === "max_tokens") return "truncated";\n', ""]]],
  ["C03", "故障注入不看第几次,每次都注入", "录制层逐次记账,按联系人与次序注入故障,注入的那次不发上游", [[F("capture"), "f.cls === cls && f.nth === nth)", "f.cls === cls)"]]],
  ["C04", "请求头进了记录", "录制层不记请求头,网关令牌不进记录;非 messages 请求原样转发不记", [[F("capture"), "system: req.system, request: req.request, fault };", "system: req.system, request: `${req.request}${JSON.stringify(init?.headers ?? {})}`, fault };"]]],
  ["C05", "runner 单次超时记成网络错误", "单次调用到 runner 上限按 timeout 记并把错误交还调用方", [[F("capture"), "      push(0, empty, timedOut ? \"timeout\" : \"network_error\", e instanceof Error ? e.message : String(e));\n      throw e;", "      push(0, empty, \"network_error\", e instanceof Error ? e.message : String(e));\n      throw e;"]]],
  ["C06", "message_delta 里的输出用量不读", "流式回复解析出用量、停止原因、文字与工具调用", [[F("capture"), '    if (typeof u.output_tokens === "number") usage.output = u.output_tokens;\n', ""]]],
  ["C07", "注入的 400 不带 x-should-retry:false(SDK 会重试)", "注入的故障回复:400/529 不让 SDK 重试,截断按类区分文字,network 直接抛错", [[F("capture"), '"x-should-retry": "false", ', ""]]],
  ["C08", "读消息不在段落标题处截断", "宿主呈现格式的消息逐条读出,多行原文保留,段落标题处截断", [[F("capture"), "} else if (/^\\[[^\\]]+\\]|^<\\/?block|^〔/.test(line)) cur = null;", "} else if (/^<\\/?block|^〔/.test(line)) cur = null;"]]],
  ["S01", "替身不看 needs 一律答对", "追问时请求里有 needs 原文就答对,没有就答看不到", [[F("standin"), "return p.needs === null || context.includes(p.needs) ? p.standin.answer : UNSEEN;", "return p.standin.answer;"]]],
  ["S02", "替身检查把问句与假设也记成记忆", "检查只记陈述过的长期要求:以后类给全局锚点,问句和假设不记,模型已写笔记时 note 为 null", [[F("standin"), ".filter((l) => REMEMBER.test(l.text) && !NOT_STATED.test(l.text))", ".filter((l) => REMEMBER.test(l.text))"]]],
  ["S03", "替身不理 noNote", "替身写有损笔记(只留最近两条用户原文),noNote 题不写笔记,plainText 追问不走 reply", [[F("standin"), "if (kept.length && item.standin?.noNote !== true) blocks.push", "if (kept.length) blocks.push"]]],
  ["S04", "替身工具往返之后还继续调工具", "同一轮工具往返之后收尾,不再调工具", [[F("standin"), 'if (/"type"\\s*:\\s*"tool_result"/.test(body)) return', "if (false) return"]]],
  ["S05", "替身端点什么路径都应答", "替身端点只接 messages,其余 404", [[F("standin"), 'if (!/\\/v1\\/messages(?:\\?|$)/.test(url) || typeof init?.body !== "string") return', 'if (typeof init?.body !== "string") return']]],
  ["SC01", "运行出错的记录从分母里去掉", "运行出错的那份仍留在分母里,分子不加,运行出错单列", [[F("score"), 'if (rec.status === "error") f.runErrors++;', 'if (rec.status === "error") {\n      f.runErrors++;\n      continue;\n    }']]],
  ["SC02", "覆盖不看检查成败", "覆盖只认 runner 判成功的检查:解析失败的那批记积压,含条数与最老年龄", [[F("score"), 'c.contact === contact && c.outcome === "ok" && texts', "c.contact === contact && texts"]]],
  ["SC03", "注入故障混进模型失败", "注入的故障单列,不记成模型或网关的失败", [[F("score"), "        f.injected++;\n        continue;\n", "        f.injected++;\n"]]],
  ["SC04", "来源与作用域只看来源不看作用域", "来源指到别的消息、全局被收窄成会话,都不算来源与作用域正确", [[F("score"), '(e.scope === "any" || (e.scope === "global") === isGlobal(m))', "true"]]],
  ["SC05", "误写把已替代的记忆也算上", "误写:生效记忆命中禁写条目且作用域相同才算", [[F("score"), 'const active = (ms: readonly MemoryRecord[] | undefined) => (ms ?? []).filter((m) => m.status === "active");', "const active = (ms: readonly MemoryRecord[] | undefined) => ms ?? [];"]]],
  ["SC06", "读后照做不以读回为条件", "读回与读后照做分开算:没读到算读回失败,读到了没答对算照做失败", [[F("score"), "if (o.readBack) follow = add(follow", "follow = add(follow"]]],
  ["SC07", "预取误导不看本轮有没有预取", "预取误导只在追问那轮第 5 块有旧消息标注时计", [[F("score"), "if (o.prefetched && o.misled !== null) misled", "if (o.misled !== null) misled"]]],
  ["SC08", "正确但没走 reply 不计数", "正确但没走 reply:模型直接输出了答案,会话里却没有这条回复", [[F("score"), "      if (o.correctNoReply) correctNoReply++;\n", ""]]],
  ["SC09", "百分位秩偏一位", "百分位按最近秩,空集合为 null", [[F("score"), "Math.ceil((p / 100) * s.length) - 1", "Math.floor((p / 100) * s.length)"]]],
  ["SC10", "答对判定不看 reject", "答对判定:reject 命中就不算对,expect 为 null 只要有回复", [[F("score"), "  return !(p.reject !== null && re(p.reject).test(text));", "  return true;"]]],
  ["SC11", "撤回的消息也算该检查", "该检查的消息按会话成员展开,撤回的不算", [[F("score"), "      if (retracted.has(`${i}:${j}`)) return;\n", ""]]],
  ["SC12", "调用延迟把失败的调用也算进去", "回复延迟按消息发出到被问联系人的第一条回复,调用延迟只算成功的调用", [[F("score"), "      if (c.status === 200) callMs.push(c.ms);", "      callMs.push(c.ms);"]]],
  ["SC13", "截断不记配置不足", "截断记配置不足,超时与网络错误各自单列", [[F("score"), '      else if (c.outcome === "truncated") f.configInsufficient++;\n', ""]]],
  ["SC14", "token 不按调用类分,全记在对话轮上", "全部做对时各项按计划数给出分子分母", [[F("score"), "      tokens.byClass[c.cls] +=", "      tokens.byClass.round +="]]],
  ["K01", "K1 不看「哪步之后」", "K1 指定那步之后原文再进请求即未守住,之前出现不算", [[F("contracts"), "    const t0 = f.afterStep < 0 ? 0 :", "    const t0 = true ? 0 :"]]],
  ["K02", "K1 exceptNote 不起作用", "K1 exceptNote:笔记(第 3 块)里的旧文不算,第 4、5 块与检查材料里的算", [[F("contracts"), "  if (!exceptNote) return `${c.system}\\n${c.request}`;", "  return `${c.system}\\n${c.request}`;"]]],
  ["K03", "K2 前缀变了也不报", "K2 同一联系人的固定前缀变了即未守住", [[F("contracts"), "    else if (first !== c.system) v.push(", "    else if (false) v.push("]]],
  ["K04", "K3 只看对话轮不看后台调用", "K3 后台调用换了模型即未守住", [[F("contracts"), "    if (c.model === null) continue;", '    if (c.model === null || c.cls !== "round") continue;']]],
  ["K05", "K4 不看最终笔记", "K4 截断的补写成了之后的状态笔记即未守住,没截断不适用", [[F("contracts"), "    if (note?.includes(needle)) v.push(", "    if (false) v.push("]]],
  ["K06", "K5 失败的检查也算补查成功", "K5 检查失败后那批消息既没再检查成功、也没留下欠账即未守住,补查成功则守住", [[F("contracts"), "x.n > c.n && x.outcome === \"ok\" && inboundLines", "x.n >= c.n && inboundLines"]]],
  ["K07", "K6 看第 5 块而不是固定前缀", "K6 预取标注进了固定前缀即未守住,只在第 5 块守住,没有预取不适用", [[F("contracts"), "  for (const c of rounds) if (c.system.includes(PREFETCH_MARK)) v.push(", "  for (const c of rounds) if (blockText(c.request, 5).includes(PREFETCH_MARK)) v.push("]]],
  ["K08", "K7 不查负用量", "K7 用量为负或判定不在枚举内即记账不完整", [[F("contracts"), "Number.isFinite(x) && x >= 0)", "Number.isFinite(x))"]]],
  ["K09", "汇总时要全部运行都失败才算失败", "一份记录给出七条合同,汇总时任一运行未守住即未守住,违例带运行号且有上限", [[F("contracts"), 'const verdict = all.some(({ x }) => x.verdict === "fail") ?', 'const verdict = all.every(({ x }) => x.verdict === "fail") ?']]],
  ["G01", "收据路径保留斜杠", "收据路径按分支名把非字母数字换成连字符", [[F("groups"), 'branch.replace(/[^A-Za-z0-9]/g, "-")', 'branch.replace(/[^A-Za-z0-9/]/g, "-")']]],
  ["G02", "不要求收据,分支在就算就绪", "某片分支不存在或还没有收据,该组记未测(分支未就绪)并写明是哪片", [[F("groups"), "inputs.filter((i) => !i.sha || !i.receipt)", "inputs.filter((i) => !i.sha)"]]],
  ["G03", "开关未定的组也算可跑(按序合入这条路径)", "开关未定的组记未测(开关未定)并写明原因;两条路径(按序合入与组提交)都算", [[F("groups"), "    if (bad.length) return { ...head, state: \"未测(分支未就绪)\", reason: bad.join(\";\") };\n    if (def.blocked) return { ...head, state: \"未测(开关未定)\", reason: def.blocked };", "    if (bad.length) return { ...head, state: \"未测(分支未就绪)\", reason: bad.join(\";\") };"]]],
  ["G04", "有收据也不优先,总取第一个解析到的", "同一片远端与本地都有时取带收据的那个,显式覆盖优先", [[F("groups"), "    if (has) return x;\n", ""]]],
  ["G05", "开关表不注明 G3 是③④共同底座", "开关表逐组列开关,并注明 G3 是③④的共同底座", [[F("groups"), '"注:③④都已合入 G3,记忆排序是 BC 检索接缝,不是旧的 overlap 算法;③与④的差只在 G4(历史查询工具与预取),④两行的差只在预取开关。"', '"注:见各片说明。"']]],
  ["G06", "不可跑的组也排运行", "只给可跑的组排运行,顺序为组、模型、题、次", [[F("run"), '    if (g.state !== "可跑") continue;\n    for (const model of models)', "    for (const model of models)"]]],
  ["G07", "driver 没交回记录时补的记录记成 ok", "driver 没交回记录时补一份运行出错的记录,留在分母里", [[F("run"), '    status: "error",\n    error: why,', '    status: "ok",\n    error: why,']]],
  ["G08", "基线解析不到也算可跑", "基线组只要基线能解析就可跑", [[F("groups"), "  if (!base) return { ...head, state: \"未测(分支未就绪)\", reason: `基线 ${o.base ?? BASELINE} 解析不到` };\n", ""]]],
  ["M01", "渠道保留整串地址(含路径令牌)", "渠道只留协议主机端口,路径里的令牌只以摘要出现", [[F("manifest"), "    origin = new URL(baseUrl).origin;", "    origin = new URL(baseUrl).href;"]]],
  ["M02", "认证引用写成令牌值", "真实模式配置不含密钥值,认证只记环境变量名", [[F("manifest"), 'authRef: env.ANTHROPIC_AUTH_TOKEN ? "env:ANTHROPIC_AUTH_TOKEN"', "authRef: env.ANTHROPIC_AUTH_TOKEN ? env.ANTHROPIC_AUTH_TOKEN"]]],
  ["M03", "配置指纹不含设置补丁", "配置指纹:同配置同值,换模型、换渠道或换设置都变", [[F("manifest"), "update(canonicalJson({ ...c, runnerDigest }))", "update(canonicalJson({ ...c, settings: null, runnerDigest }))"]]],
  ["M04", "消息版本不随编辑前进", "源权限与消息版本:编辑、撤回让版本前进,撤回标记保留", [[F("manifest"), "version: o.order,", "version: versions.get(k)?.version ?? o.order,"]]],
  ["R01", "0/0 写成 0%", "比率写成分子/分母(百分比),分母为 0 写不适用", [[F("report"), '  if (r.d === 0) return "0/0(不适用)";\n', '  if (r.d === 0) return "0/0(0.0%)";\n']]],
  ["R02", "未测组不写原因", "报告列出每组状态,未测的写明原因,已跑的写已跑", [[F("report"), '| ${inputs} | ${g.reason ?? ""} |`', '| ${inputs} |  |`']]],
  ["R03", "合同未守住不在组标题上标出", "合同有一条未守住就在组标题上标出,效果指标照常列但不抵消", [[F("report"), "${bad.length ? `:合同未全过(${bad.map((c) => c.id).join(\"、\")})` : \"\"}", ""]]],
  ["R04", "报告抬头写验收结论", "报告不写验收结论,以说明结尾", [[F("report"), "只列测量值:不预设阈值,不给验收结论。", "只列测量值,全部验收通过。"]]],
  ["D01", "driver 不把题集故障交给录制层", "替身跑完一道题:每步都有记录,每次调用都记账并归到联系人,第 1 次检查按题集换成解析失败", [[F("driver"), "    faults: item.faults,", "    faults: [],"]]],
  ["D02", "缺令牌也照跑", "缺网关配置不跑:记 config_insufficient,一次模型调用也没有", [[F("driver"), "  if (!base || (!token && !key) || !o.model) return null;", "  if (!base || !o.model) return null;"]]],
  ["D03", "补写请求不带人设时不归给唯一联系人", "调用归属:认人设 marker;不带人设的补写请求只有一位联系人时归它,两位时记不明", [[F("driver"), "  return hit.length === 0 && item.contacts.length === 1 ? item.contacts[0]!.key : null;", "  return null;"]]],
  ["RU04", "建树时组提交的祖先关系不查(某片被悄悄换掉也算可跑)", "给了只供 G6 的组提交:必须含基线与每片当前提交、带每片收据才可跑,否则写明缺哪片", [[F("groups"), "!git.isAncestor(i.sha, groupCommit) ?", "false ?"]]],
  ["RU05", "组提交里不看每片收据", "给了只供 G6 的组提交:必须含基线与每片当前提交、带每片收据才可跑,否则写明缺哪片", [[F("groups"), "!git.hasFile(groupCommit, receiptPath(i.branch)) ?", "false ?"]]],
  ["RU06", "续跑不看续跑身份(换了模型/选项也沿用旧记录)", "续跑只沿用同一组提交、同一续跑身份、同一题同一次的合法记录;运行出错的重跑,超时与上游失败照常沿用", [[F("run"), "r.reuseKey === want.reuseKey &&", "true &&"]]],
  ["RU07", "续跑把运行出错的记录也沿用", "续跑只沿用同一组提交、同一续跑身份、同一题同一次的合法记录;运行出错的重跑,超时与上游失败照常沿用", [[F("run"), "r.status !== \"error\" && Array.isArray(r.calls)", "Array.isArray(r.calls)"]]],
  ["RU08", "探测不看 429,直接放行", "探测:没准备好(429 或上游错误)就等一段再探,到上限判不跑;拿到正文就放行;记下每次时刻、状态与 retry-after", [[F("run"), "    if (ready) return { ok: true, attempts };", "    return { ok: true, attempts };"]]],
  ["RU11", "探测把「200 但流里是 error 事件」当成功", "探测结果怎么读:429 与「200 但流里是 error 事件」都算没准备好并带上游原话,拿到正文才算好", [[F("run"), "  if (err !== null) {", "  if (false) {"]]],
  ["RU09", "探测 429 不等待(不给上游恢复时间)", "探测:没准备好(429 或上游错误)就等一段再探,到上限判不跑;拿到正文就放行;记下每次时刻、状态与 retry-after", [[F("run"), "    if (i > 0) await o.sleep(o.waitMs);", ""]]],
  ["RU10", "网关在不在恒当真(网关断了也把失败记进分母)", "网关在不在:收到任何 HTTP 回复算在(含 404/500),连试两次都连不上才算不在", [[F("run"), "      const r = await fetchFn(baseUrl, { method: \"GET\", signal: AbortSignal.timeout(timeoutMs) });", "    return true;"]]],
  ["RU12", "网关判活一次失败就判死(偶发连接失败会停整批)", "网关在不在:收到任何 HTTP 回复算在(含 404/500),连试两次都连不上才算不在", [[F("run"), "export async function gatewayUp(baseUrl: string, fetchFn: typeof globalThis.fetch, timeoutMs = 10_000, attempts = 2): Promise<boolean> {", "export async function gatewayUp(baseUrl: string, fetchFn: typeof globalThis.fetch, timeoutMs = 10_000, attempts = 1): Promise<boolean> {"]]],
  ["C09", "一次一个调用不排队(并发发出)", "一次一个调用:第二个调用等第一个读完正文才发出,排队时间记下;注入的故障不排队", [[F("capture"), "    const release = o.serial && !fault ? await lock() : null;", "    const release = null;"]]],
  ["C10", "欠账材料的逐条消息读不出来", "宿主呈现格式的消息逐条读出,多行原文保留,段落标题处截断", [[F("capture"), "    const d = h ? null : DEBT_HEAD.exec(line);", "    const d = null;"]]],
  ["C11", "精筛调用归到检查一类", "请求体解析:system 数组、工具结果都进文字,带工具才算一轮", [[F("capture"), "  if (r.system.includes(REFINE_MARK)) return \"refine\";\n", ""]]],
  ["S06", "替身对精筛请求不给合法空结果", "精筛请求替身给合法空结果,不把标记提升为记忆", [[F("standin"), "  if (req.system.includes(REFINE_MARK)) return", "  if (false) return"]]],
  ["SC15", "写入延迟不记(永远空)", "写入延迟按来源消息发出到宿主写下这条期望记忆;没写到的不算;历史查询工具按对话轮里的 query_history 计数", [[F("score"), "      if (src && written.length) writeMs.push(Math.min(...written) - src.at);", ""]]],
  ["SC16", "历史查询工具次数把后台调用也算进去", "写入延迟按来源消息发出到宿主写下这条期望记忆;没写到的不算;历史查询工具按对话轮里的 query_history 计数", [[F("score"), "      if (c.cls === \"round\") historyToolCalls += c.tools.filter((t) => t.name === \"query_history\").length;", "      historyToolCalls += c.tools.filter((t) => t.name === \"query_history\").length;"]]],
  ["SC17", "精筛 token 记到补写笔记一类", "精筛调用的 token 记在精筛一类", [[F("score"), "      tokens.byClass[c.cls] +=", "      tokens.byClass[c.cls === \"refine\" ? \"compact\" : c.cls] +="]]],
  ["K10", "K5 不看欠账记录(失败检查一律算未守住)", "K5 留下欠账记录也算守住,两者都没有才未守住", [[F("contracts"), "      const debt = c.contact === null ? [] : (rec.hostDebt?.[c.contact]?.refs ?? []).filter((r) => r.roomId === u.roomId && r.seq === u.seq);", "      const debt: never[] = [];"]]],
  ["K11", "K1 违例不写落在哪一块", "K1 的违例写明原文落在哪一块,便于定位", [[F("contracts"), "      if (seen.includes(f.text)) v.push(`调用 ${c.n}(${c.cls},${whereInRequest(c, f.text)}):${f.why}`);", "      if (seen.includes(f.text)) v.push(`调用 ${c.n}(${c.cls}):${f.why}`);"]]],
  ["R05", "模型状态把未测(429)盖成已跑", "模型状态:跑过的记已跑(探测记录照留),没跑过但有 429 探测记录记未测,两者都没有记未跑", [[F("run"), "  if (records.some((r) => r.model === model)) return { state: \"已跑\", attempts };", "  if (records.some((r) => r.model === model)) return { state: existing?.state ?? \"已跑\", attempts };"]]],
  ["R06", "指定对照只比第一组", "指定对照:同模型两组都有结果才列,差值按后者减前者", [[F("report"), "export const COMPARE: readonly (readonly [string, string])[] = Object.freeze([[\"g1\", \"g2\"], [\"g2\", \"g3\"], [\"g3\", \"g4on\"], [\"g4off\", \"g4on\"]] as const);", "export const COMPARE: readonly (readonly [string, string])[] = Object.freeze([[\"g1\", \"g2\"]] as const);"]]],
  ["M05", "续跑身份把渠道地址也算进去(换端口就不能续跑)", "续跑身份:不含渠道地址(网关每次会话换端口与路径),换模型、组级选项、一次一个调用或驱动代码就变", [[F("manifest"), "  const { endpoint: _e, endpointHash: _h, ...rest } = c;", "  const rest = c;"]]],
  ["M06", "驱动代码摘要不看内容(改代码也能续跑)", "驱动代码摘要:与文件顺序无关,改一个字就变", [[F("manifest"), "h.update(`${f.name}\\u0000${f.text}\\u0000`);", "h.update(`${f.name}\\u0000`);"]]],
  ["D04", "组级覆盖只并 opts,不并精筛参数", "组级宿主选项覆盖:并进宿主已有的选项对象与精筛参数,被测提交里没有的字段如实记缺", [[F("driver"), "  merge(\"finePolicy\", \"fineScreen\", patch.fineScreen);", ""]]],
  ["RU01", "@g-group 链到 runner 自己的包", "依赖链接:第三方包链到 runner 的 node_modules,@g-group 链到被测树自己的 packages,file: 依赖链到被测树", [[F("run"), 'symlinkSync(path.join("..", "..", "packages", p), path.join(dst, j.name));', "symlinkSync(path.join(src, j.name), path.join(dst, j.name));"]]],
  ["RU03", "起 git 子进程不剥 GIT_*(在钩子里跑会改到调用方仓库)", "调用方环境里带 GIT_DIR / GIT_WORK_TREE(如在 pre-push 钩子里跑)时,runner 的 git 子进程只动目标仓库,不碰调用方仓库", [[F("run"), '(!k.startsWith("GIT_") || KEEP_GIT_VARS.has(k))', "true"]]],
  ["RU02", "建树不合入各片", "建组工作树:基线上按序合入各片得到新 HEAD,叠上 g6 目录(不含测试);合入冲突报出是哪片、哪些文件", [[F("run"), "  for (const i of g.groupCommit ? [] : g.inputs) {", "  for (const i of [] as typeof g.inputs) {"]]],
];

const only = process.env.MUT_ONLY ? new Set(process.env.MUT_ONLY.split(",")) : null;
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    };
    const timer = setTimeout(kill, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed });
    });
  });
}
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g6-mut-")));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** proof/ 下只带 g6/(被测的 runner 在那里),其余 proof 与 node_modules 不带 */
const keep = (s) => {
  const rel = path.relative(path.join(ROOT, "packages"), s).split(path.sep).join("/");
  if (rel.split("/").includes("node_modules")) return false;
  const i = rel.split("/").indexOf("proof");
  if (i < 0) return true;
  const parts = rel.split("/");
  return parts.length === i + 1 || parts[i + 1] === "g6";
};
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: keep });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) {
    const j = JSON.parse(fs.readFileSync(path.join(d, "packages", p, "package.json"), "utf8"));
    fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", j.name));
  }
  return d;
};
const lines = [];
const say = (s) => {
  console.log(s);
  lines.push(s);
};
let killed = 0;
let survived = 0;
let bad = 0;
try {
  const list = M.filter(([id]) => !only || only.has(id));
  say(`node ${process.version},变异 ${list.length} 个,测试文件 ${TESTS.length} 个,并发 1`);
  const control = async (label) => {
    const r = await run(copy(`control-${label}`));
    say(`${r.failed.length === 0 && r.passed.length > 0 ? "✓" : "✗"} 原样副本(${label}):${r.passed.length} 绿 / ${r.failed.length} 红${r.failed.length ? `:${r.failed.join(" | ")}` : ""}`);
    if (r.failed.length || r.passed.length === 0) bad++;
    return new Set(r.passed);
  };
  const green = await control("变异前");
  for (const [i, [id, what, killer, edits]] of list.entries()) {
    if (!green.has(killer)) {
      say(`✗ [${i + 1}/${list.length}] ${id} 指定的杀手测试「${killer}」在原样副本里不是绿的`);
      bad++;
      continue;
    }
    const d = copy(id);
    let okEdit = true;
    for (const [file, from, to] of edits) {
      const p = path.join(d, file);
      const src = fs.readFileSync(p, "utf8");
      const n = src.split(from).length - 1;
      if (n !== 1) {
        say(`✗ [${i + 1}/${list.length}] ${id} 注入点在 ${file} 出现 ${n} 次(应为 1)`);
        okEdit = false;
        break;
      }
      fs.writeFileSync(p, src.replace(from, to));
    }
    if (!okEdit) {
      bad++;
      continue;
    }
    const t0 = Date.now();
    const r = await run(d);
    const hit = r.failed.includes(killer);
    if (hit) killed++;
    else survived++;
    say(`${hit ? "✓" : "✗"} [${i + 1}/${list.length}] ${id} ${what}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,指定测试「${killer}」${hit ? "失败(杀死)" : "仍通过(存活)"}${r.failed.length ? `;全部变红:${r.failed.join(" | ")}` : ""}`);
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await control("变异后");
  say(`合计 ${list.length}:杀死 ${killed},存活 ${survived},注入或对照异常 ${bad}`);
  say(survived === 0 && bad === 0 ? "变异校准通过" : "变异校准未通过");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (process.env.MUT_OUT) fs.writeFileSync(process.env.MUT_OUT, `${lines.join("\n")}\n`);
}
process.exit(survived === 0 && bad === 0 ? 0 : 1);
