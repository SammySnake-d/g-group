// 行为变异校准(R-05 阳性埋雷):对 adapter-cc-compute 的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败,且全部测试都执行完(文件级失败、超时、强杀、部分执行都不算杀死)。原样副本必须全绿(阴性对照)。
// 注入点必须在源文件里恰好出现 1 次,否则判脚本失效。路径相对本包根目录。
// 用法: node packages/adapter-cc-compute/proof/mutations.mjs
// 并发默认 2;本机同时有别的测试在跑时用 CC_MUT_CONCURRENCY=2 降低并发(只影响调度,不改注入点与判决)。
// CC_MUT_PROGRESS=<文件>:每个变异一出判决就追加一行到该文件(附全部变红的测试名;进程中途被结束也留下已完成的判决);
// CC_MUT_ONLY=M113,M126:只跑列出的编号(原样副本照跑),用于补跑,不改注入点与判决。
// 第九轮起每个变异注入后先做静态检查(.ts 跑 tsc,.mjs 跑 node --check),不通过记为不可编译、不计为杀死。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessTap } from "../test-support/tap-result.ts";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TARGETS = JSON.parse(fs.readFileSync(new URL("./mutation-targets.json", import.meta.url), "utf8"));
const EVIDENCE = process.env.CC_MUT_EVIDENCE;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });

const M = [
  ["M01 brief 放行 memory 等额外字段", "src/brief.ts", "if (extra.length) return refuse(`brief", "if (false) return refuse(`brief"],
  ["M02 brief 放行明文凭据", "src/brief.ts", "if (plaintext.length) return refuse(", "if (false) return refuse("],
  ["M03 --allowedTools 不按 brief.tools", "src/cli.ts", '"--allowedTools", allowedTools(brief).join(","),', '"--allowedTools", ["Read", "Write", "Edit", "Bash", REPORT_TOOL].join(","),'],
  ["M04 没有 milestone 就不报 completed", "src/adapter.ts", 'if (terminal.kind !== "paused-blocked") emit(', 'if (terminal.kind !== "paused-blocked" && (terminal.kind !== "completed" || round.events.some((e) => e.kind === "milestone"))) emit('],
  ["M05 非零退出也报 completed", "src/events.ts", "if (!(exit.code === 0 && exit.signal === null && result?.success)) {", "if (!result?.success) {"],
  ["M06 stop 等主进程退出后才报 stopped(不是 mirasim 的立即报)", "src/adapter.ts", '      round.terminal = "stopped";\n      round.finished = true;', '      await round.done;\n      round.terminal = "stopped";\n      round.finished = true;'],
  ["M07 快照缺 constraintVer 放行", "src/brief.ts", "if (!Number.isInteger(constraintVer) || (constraintVer as number) < 0) return refuse(", "if (false) return refuse("],
  ["M08 handoff 不写进首个提示", "src/cli.ts", "parts.push(`[交接快照]", "void (`[交接快照]"],
  ["M09 env 继承宿主进程环境(带明文)", "src/cli.ts", "    ...hostEnv,", "    ...process.env,\n    ...hostEnv,"],
  ["M10 --tools 不按 brief.tools", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", "default",'],
  ["M11 已受理 blocked 不停在受阻", "src/events.ts", 'if (facts.pausedBlocked) return { kind: "paused-blocked" };', ""],
  ["M12 被拒收的汇报也产出事件", "src/events.ts", "        if (b.is_error === true) {", "        if (b.is_error === true && Boolean(0)) {"],
  ["M13 到期不对进程组发 SIGKILL", "src/adapter.ts", 'const timer = setTimeout(() => signalGroup(round.pid, "SIGKILL"), reapForceMs);', "const timer = setTimeout(() => {}, reapForceMs);"],
  ["M14 handoff 不列进装配清单", "src/cli.ts", 'sections.push({ name: "handoff",', 'void ({ name: "handoff",'],
  ["M15 resume 不带 CLI 会话号", "src/cli.ts", '...(resumeSession ? ["--resume", resumeSession] : []),', ""],
  ["M16 F-01 brief.tools 放行 default 等非内置名", "src/brief.ts", "if (unknown.length) return refuse(", "if (false) return refuse("],
  ["M17 F-01 空集时 --tools 给 default", "src/cli.ts", '"--tools", brief.tools.join(","),', '"--tools", brief.tools.length ? brief.tools.join(",") : "default",'],
  ["M18 F-01 不核对 CLI init 的实际挂载清单", "src/adapter.ts", "if (over.length) { violate(", "if (false) { violate("],
  ["M19 F-02 忽略 Compute 汇报的 failed", "src/events.ts", "if (facts.reportedFailure !== undefined) return fail(", "if (false) return fail("],
  ["M20 F-02 result 行不看 is_error", "src/events.ts", 'success: m.subtype === "success" && m.is_error !== true,', 'success: m.subtype === "success",'],
  ["M21 F-02 被拒收的 blocked 不记为未解决", "src/adapter.ts", 'if (s.kind === "blocked" || s.kind === "failed") st.unresolved = [...st.unresolved, rec];', ""],
  ["M22 CLI 不自成进程组", "src/adapter.ts", "detached: !IS_WINDOWS", "detached: false"],
  ["M23 CLI 正常结束后仍对进程组发 SIGTERM(mirasim 不发)", "src/adapter.ts", "      round.child = null;\n", '      round.child = null;\n      signalGroup(round.pid, "SIGTERM");\n'],
  ["M24 初始 SIGTERM 发给进程组而不是只发主进程", "src/adapter.ts", 'try { p.kill("SIGTERM"); } catch { /* 已退出 */ }', 'signalGroup(round.pid, "SIGTERM");'],
  ["M25 F-04 MCP 服务器不校验 schema", "mcp/report-mcp.mjs", "const errs = reportErrors(a);", "const errs = [];"],
  ["M26 F-04 适配器不做第二道 schema 校验", "src/events.ts", "const errors = reportErrors(input);", "const errors: string[] = [];"],
  ["M27 F-04 needs 只查真假不查类型", "src/report-schema.ts", "if (a.needs !== undefined && !nonEmpty(a.needs))", "if (a.needs !== undefined && !a.needs)"],
  ["M28 F-04 stage 只查真假不查类型", "src/report-schema.ts", "if (a.stage !== undefined && !nonEmpty(a.stage))", "if (a.stage !== undefined && !a.stage)"],
  ["M29 F-04 constraintVer 不校验", "src/report-schema.ts", "if (a.constraintVer !== undefined && !(Number.isInteger(a.constraintVer)", "if (false && !(Number.isInteger(a.constraintVer)"],
  ["M30 F-04 kind 不查枚举", "src/report-schema.ts", 'if (typeof a.kind !== "string" || !REPORT_KINDS.includes(a.kind)) errs.push("kind 非法");', ""],
  ["M31 F-04 放行未知字段", "src/report-schema.ts", "if (extra.length) errs.push(", "if (false) errs.push("],
  // 以下对应 Codex 第二轮 RR-01–RR-05;M06/M13/M22–M24/M34/M39–M42/M44 按 g-group#2309 对齐 mirasim 改写;M13/M23/M24/M40 第三轮按 z2 实际做法再改
  ["M32 RR-01 合规 started 清掉被拒收的 blocked(审查存活变异)", "src/adapter.ts", 'if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);', 'if (r.kind === "blocked" || r.kind === "failed" || r.kind === "started") st.unresolved = [];'],
  ["M33 RR-01 合规 completed 清掉被拒收的 blocked", "src/adapter.ts", 'if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);', 'if (r.kind === "blocked" || r.kind === "failed" || r.kind === "completed") st.unresolved = [];'],
  ["M34 RR-01 受理 blocked 后不对进程组 SIGSTOP", "src/adapter.ts", '      signalGroup(round.pid, "SIGSTOP");', ""],
  ["M35 RR-01 resume 不解除被拒收的受阻", "src/adapter.ts", "      st.unresolved = [];", ""],
  ["M36 RR-02 不要求 host MCP connected", "src/events.ts", 'if (host?.status !== "connected") return', "if (false) return"],
  ["M37 RR-02 不要求工具清单里有 report_progress", "src/events.ts", "if (!m.tools.includes(REPORT_TOOL)) return", "if (false) return"],
  ["M38 RR-02 tools 元素不查类型", "src/events.ts", 'if (!m.tools.every((t) => typeof t === "string")) return', "if (false) return"],
  ["M39 信号只发给进程本身、不发给进程组", "src/procgroup.ts", "process.kill(-pid, sig);", "process.kill(pid, sig);"],
  ["M40 stopped 不带 main-then-group 范围", "src/adapter.ts", 'scope: "main-then-group", violations: [...round.violations] });', 'scope: "process-group" as "main-then-group", violations: [...round.violations] });'],
  ["M41 RR-04 运行中也给快照", "src/adapter.ts", 'if (!quiescent(r) || !terminal) return refuse("not-quiescent");', ""],
  ["M42 RR-04 快照不等主进程退出(只看终态)", "src/adapter.ts", 'if (!quiescent(r) || !terminal) return refuse(', "if (!terminal) return refuse("],
  ["M43 RR-05 违规压过停止", "src/events.ts", "if (facts.stopRequested) return {", "if (facts.stopRequested && violations.length === 0) return {"],
  ["M44 升级间隔不按配置(写死 10 秒)", "src/adapter.ts", "const reapForceMs = resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS);", "const reapForceMs = DEFAULT_REAP_FORCE_MS;"],
  ["M45 RR-05 违规不留痕", "src/adapter.ts", "    round.violations.push(msg);", ""],
  // 以下对应第三轮:停止语义更正为 mirasim z2 的实际做法、R3-01–R3-03
  ["M46 主进程先退出也不取消组 SIGKILL", "src/adapter.ts", '    p.once("exit", () => clearTimeout(timer));', ""],
  ["M47 R3-01 stop 后不封存这一轮", "src/adapter.ts", "      round.halted = true;\n      // 冻结的进程组", "      // 冻结的进程组"],
  ["M48 R3-02 空白续接先杀掉冻结的进程组再报错", "src/adapter.ts", '      if (!text.trim()) return refuse("续接的内容不能为空");', '      if (!text.trim()) { if (st.round && !st.round.exited) signalGroup(st.round.pid, "SIGKILL"); return refuse("续接的内容不能为空"); }'],
  ["M49 R3-03 init 前未认可的输出放行", "src/adapter.ts", 'if (pre.kind === "rejected") { violate(', 'if (pre.kind === "rejected" && Boolean(0)) { violate('],
  ["M50 R3-03 init 前任何 system 帧都放行", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return", "true) return"],
  // 以下对应第四轮 R4-01–R4-05、第四轮补充、磁盘清理与导出常量冻结
  ["M51 R4-04 凭据校验只在数组长度为 1 时执行", "src/brief.ts", "const plaintext = credentialRefs.filter((c) => !isCredentialRef(c));", "const plaintext = credentialRefs.length === 1 ? credentialRefs.filter((c) => !isCredentialRef(c)) : [];"],
  ["M52 补充 删除 openQuestions 校验", "src/report-schema.ts", 'if (a.openQuestions !== undefined && !strArr(a.openQuestions)) errs.push("openQuestions 须为字符串数组");', ""],
  ["M53 补充 删除 doneSideEffects 校验", "src/report-schema.ts", 'if (a.doneSideEffects !== undefined && !strArr(a.doneSideEffects)) errs.push("doneSideEffects 须为字符串数组");', ""],
  ["M54 R4-05 tools/list 返回空数组", "mcp/report-mcp.mjs", "result: { tools: [tool] }", "result: { tools: [] }"],
  ["M55 R4-05 删除 REPORT_LOG 日志追加", "mcp/report-mcp.mjs", "    if (LOG) fs.appendFileSync(LOG,", "    if (false) fs.appendFileSync(LOG,"],
  ["M56 R4-02 非对象请求不拒绝(直接访问 m.method)", "mcp/report-mcp.mjs", 'if (typeof m !== "object" || m === null || Array.isArray(m)) {', "if (false) {"],
  ["M57 R4-01 不先判 Proxy", "src/plain.ts", 'if (types.isProxy(x)) return bad(at, "不允许 Proxy");', ""],
  ["M58 R4-01 访问器不拒收(当作缺失字段)", "src/plain.ts", 'if (isAccessor(d)) return bad(path, "不允许 getter/setter");', ""],
  ["M59 R4-01 不查原型(自定义原型放行)", "src/plain.ts", "if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {", "if (false) {"],
  ["M60 R4-01 不可枚举属性放行", "src/plain.ts", 'if (!d.enumerable) return bad(path, "不允许不可枚举属性");', ""],
  ["M61 R4-01 嵌套值不递归判定", "src/plain.ts", "return walk(d.value, path, depth + 1);", "return { ok: true, value: d.value };"],
  ["M62 R4-01 checkBrief 不过纯数据判定", "src/brief.ts", 'const p = plainData(input, "brief");', 'const p: ReturnType<typeof plainData> = ((value: unknown): ReturnType<typeof plainData> => ({ ok: true, value }))(input);'],
  ["M63 R4-01 reportErrors 不过纯数据判定", "src/report-schema.ts", 'const p = plainData(input, "汇报");', 'const p: ReturnType<typeof plainData> = ((value: unknown): ReturnType<typeof plainData> => ({ ok: true, value }))(input);'],
  ["M64 R4-01 spawn 选项不过纯数据判定", "src/adapter.ts", 'const p = plainData(opts, "spawn 选项");', 'const p: ReturnType<typeof plainData> = ((value: unknown): ReturnType<typeof plainData> => ({ ok: true, value }))(opts);'],
  ["M65 R4-01 适配器选项不过纯数据判定", "src/adapter.ts", 'const p = plainData(options, "适配器选项");', 'const p: ReturnType<typeof plainData> = ((value: unknown): ReturnType<typeof plainData> => ({ ok: true, value }))(options);'],
  ["M66 R4-01 resume 不查状态参数类型", "src/adapter.ts", 'if (typeof computeId !== "string" || typeof text !== "string") return refuse(', "if (false) return refuse("],
  ["M67 R4-01 spawn 选项放行非预期字段", "src/adapter.ts", "if (extra.length) return refuse(`spawn 选项只收", "if (false) return refuse(`spawn 选项只收"],
  ["M68 R4-03 不读 MIRASIM_REAP_FORCE_MS", "src/adapter.ts", "return Number.isFinite(n) && n > 0 ? n : DEFAULT_REAP_FORCE_MS;", "return DEFAULT_REAP_FORCE_MS;"],
  ["M69 R4-03 非正环境值也生效", "src/adapter.ts", "return Number.isFinite(n) && n > 0 ? n : DEFAULT_REAP_FORCE_MS;", "return Number.isFinite(n) ? n : DEFAULT_REAP_FORCE_MS;"],
  ["M70 R4-03 环境值压过显式选项", "src/adapter.ts", "  if (explicit !== undefined) return explicit;\n  const n = Number(env);", "  const n = Number(env);\n  if (Number.isFinite(n) && n > 0) return n;\n  if (explicit !== undefined) return explicit;"],
  ["M71 导出的 CC_BUILTIN_TOOLS 不冻结", "src/brief.ts", 'export const CC_BUILTIN_TOOLS: readonly string[] = Object.freeze(["Read",', 'export const CC_BUILTIN_TOOLS: readonly string[] = (["Read",'],
  ["M72 导出的 REPORT_KINDS 不冻结", "src/report-schema.ts", 'export const REPORT_KINDS: readonly string[] = Object.freeze(["started",', 'export const REPORT_KINDS: readonly string[] = (["started",'],
  ["M73 磁盘清理 CLI 退出后不删 g-group-cc-* 目录", "src/adapter.ts", "      removeDir();\n      round.exited = true;", "      round.exited = true;"],
  ["M74 R5-01 纯数据判定丢弃值为 undefined 的对象自有属性(未声明字段绕过白名单)", "src/plain.ts", "    out[k] = c.value;", "    if (c.value !== undefined) out[k] = c.value;"],
  ["M75 R5-01 spawn 选项 cwd 为 undefined 也拒收(可选字段 undefined 不按没给处理)", "src/adapter.ts", "if (o.cwd !== undefined && (typeof o.cwd !== \"string\" || !o.cwd))", "if (Object.hasOwn(o, \"cwd\") && (typeof o.cwd !== \"string\" || !o.cwd))"],
  ["M76 R5-01 汇报 stage 为 undefined 也报错(可选字段 undefined 不按没给处理)", "src/report-schema.ts", "if (a.stage !== undefined && !nonEmpty(a.stage))", "if (Object.hasOwn(a, \"stage\") && !nonEmpty(a.stage))"],
  ["M77 R5-02 tools/call 不核对工具名", "mcp/report-mcp.mjs", "    if (name !== tool.name) {", "    if (false) {"],
  ["M78 R5-02 缺失或非字符串工具名放行", "mcp/report-mcp.mjs", "    if (name !== tool.name) {", "    if (typeof name === \"string\" && name !== tool.name) {"],
  ["M79 R6-01 firstPrompt 不先判 brief(直接读外部对象)", "src/cli.ts", "const brief = safeBrief(input, \"firstPrompt\");", "const brief = input;"],
  ["M80 R6-01 firstPrompt 不判交接快照", "src/cli.ts", "const h = checkSnapshot(handoffInput);", "const h = { ok: true as const, snapshot: handoffInput, reason: \"\" };"],
  ["M81 R6-01 allowedTools 不判 brief", "src/cli.ts", "return Object.freeze([...safeBrief(input, \"allowedTools\").tools, REPORT_TOOL]);", "return Object.freeze([...input.tools, REPORT_TOOL]);"],
  ["M82 R6-01 toolOverreach 不判 initTools", "src/cli.ts", "const initTools = safeStrings(initToolsInput, \"toolOverreach 的 initTools\");", "const initTools = initToolsInput;"],
  ["M83 R6-01 cliArgs 不判 brief", "src/cli.ts", "const brief = safeBrief(input, \"cliArgs\");", "const brief = input;"],
  ["M84 R6-01 cliArgs 的 prompt 隐式转换", "src/cli.ts", "const prompt = safeString(promptInput, \"cliArgs 的 prompt\");", "const prompt = String(promptInput);"],
  ["M85 R6-01 cliEnv 的 hostEnv 不过纯数据判定", "src/cli.ts", "const p = plainData(hostEnvInput, \"hostEnv\");", "const p: ReturnType<typeof plainData> = { ok: true, value: hostEnvInput };"],
  ["M86 R6-01 cliEnv 的 hostEnv 值不查字符串", "src/cli.ts", " || !Object.values(p.value).every((v) => typeof v === \"string\")) throw new TypeError(\"cliEnv", ") throw new TypeError(\"cliEnv"],
  ["M87 R6-01 cliEnv 的 computeId 隐式转换", "src/cli.ts", "const computeId = safeString(computeIdInput, \"cliEnv 的 computeId\");", "const computeId = String(computeIdInput);"],
  ["M88 R6-01 streamParser 不判输入行类型", "src/events.ts", "    if (typeof line !== \"string\") throw new TypeError(\"streamParser 的输入行必须是字符串\");\n", ""],
  ["M89 R6-01 terminalFor 参数不过纯数据判定", "src/events.ts", "const p = plainData(x, name);", "const p: ReturnType<typeof plainData> = ((value: unknown): ReturnType<typeof plainData> => ({ ok: true, value }))(x);"],
  ["M90 R6-01 terminalFor 的 stderrTail 不判类型", "src/events.ts", "  if (typeof stderrTailInput !== \"string\") throw new TypeError(\"terminalFor 的 stderrTail 必须是字符串\");\n", ""],
  ["M91 R6-01 resolveReapForceMs 显式值不判类型", "src/adapter.ts", "  if (explicit !== undefined && !(typeof explicit === \"number\" && Number.isFinite(explicit) && explicit >= 0)) throw new TypeError(\"reapForceMs 必须是非负有限数\");\n", ""],
  ["M92 R6-01 resolveReapForceMs 环境值隐式转换", "src/adapter.ts", "  if (env !== undefined && typeof env !== \"string\") throw new TypeError(\"MIRASIM_REAP_FORCE_MS 必须是字符串\");\n", ""],
  ["M93 R6-02 对外事件只冻外壳、violations 共用可变数组(旧行为)", "src/adapter.ts", "const snapshot = freezeDeep(eventCopy(e));", "const snapshot = Object.freeze(e);"],
  ["M94 R6-02 rejectedReports 的 kind 不冻结", "src/adapter.ts", "const rec = freezeDeep({ kind: structuredClone(s.kind), reason });", "const rec = Object.freeze({ kind: s.kind, reason });"],
  ["M95 R6-03 工具名先 trim(近似名当成已声明工具)", "mcp/report-mcp.mjs", "const name = m.params?.name;", "const name = typeof m.params?.name === \"string\" ? m.params.name.trim() : m.params?.name;"],
  ["M96 R6-03 工具名大小写不敏感", "mcp/report-mcp.mjs", "const name = m.params?.name;", "const name = typeof m.params?.name === \"string\" ? m.params.name.toLowerCase() : m.params?.name;"],
  // 以下对应第七轮 R7-01–R7-03(Astra 第七轮):续接认领与 stop 复核、外部 JSON 字段的安全说明与受控边界、init 前认可帧的邻接放宽
  ["M97 R7-01 resume 不做认领检查(已有续接在途也受理)", "src/adapter.ts", "if (st.resuming) return refuse(", "if (false) return refuse("],
  ["M98 R7-01 认领不置位(检查形同虚设)", "src/adapter.ts", "      st.resuming = true;\n", ""],
  ["M99 R7-01 认领在等上一轮退出之前就释放", "src/adapter.ts", "          await prev.done;", "          st.resuming = false;\n          await prev.done;"],
  ["M100 R7-01 跨 await 不核对 stop(stop 确认后仍起 CLI)", "src/adapter.ts", "if (prev.stopRequested) return refuse(", "if (false) return refuse("],
  ["M101 R7-02 preInitFrame 对 type 做隐式字符串转换", "src/events.ts", "`${describe(m.type)}${", "`${String(m.type)}${"],
  ["M102 R7-02 preInitFrame 对 subtype 做隐式字符串转换", "src/events.ts", "`/${describe(m.subtype)}`", "`/${String(m.subtype)}`"],
  ["M103 R7-02 checkInit 对 host 状态做隐式字符串转换", "src/events.ts", "host 状态 ${describe(host?.status ?? \"缺失\")}", "host 状态 ${String(host?.status ?? \"缺失\")}"],
  ["M104 R7-02 拒收回执的 text 不判类型就拼接", "src/events.ts", "return typeof t === \"string\" ? t : \"\";", "return (t as string | undefined) ?? \"\";"],
  ["M105 R7-02 安全说明对对象与数组仍做隐式转换", "src/events.ts", "      : Array.isArray(v) ? \"(数组)\" : \"(对象)\";", "      : String(v);"],
  ["M106 R7-02 去掉 stdout 行的受控边界(异常逸出 readline 回调)", "src/adapter.ts", "        try {\n          onLine(st, round, parse, line, resumeSession !== undefined, (x) => { result = x; });\n        } catch (err) {\n          violate(round, `处理 CLI 输出时出错:${errorText(err)}`);\n        }", "        onLine(st, round, parse, line, resumeSession !== undefined, (x) => { result = x; });"],
  ["M107 R7-02 受控边界吞掉异常、不记违规", "src/adapter.ts", "          violate(round, `处理 CLI 输出时出错:${errorText(err)}`);", "          void err;"],
  ["M108 R7-03 init 前 hook 前缀一律放行(审查 S04)", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return { kind: \"allowed\" }", "(PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype) || m.subtype.startsWith(\"hook\"))) return { kind: \"allowed\" }"],
  ["M109 R7-03 认可帧按前缀匹配(延长的子类型放行)", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return { kind: \"allowed\" }", "PRE_INIT_SYSTEM_SUBTYPES.some((s) => (m!.subtype as string).startsWith(s))) return { kind: \"allowed\" }"],
  ["M110 R7-03 认可帧大小写不敏感", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return { kind: \"allowed\" }", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype.toLowerCase())) return { kind: \"allowed\" }"],
  ["M111 R7-03 认可帧先去掉首尾空白", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return { kind: \"allowed\" }", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype.trim())) return { kind: \"allowed\" }"],
  ["M112 R7-03 认可帧按子串匹配(截短的子类型放行)", "src/events.ts", "PRE_INIT_SYSTEM_SUBTYPES.includes(m.subtype)) return { kind: \"allowed\" }", "PRE_INIT_SYSTEM_SUBTYPES.some((s) => s.includes(m!.subtype as string))) return { kind: \"allowed\" }"],
  // 以下对应第八轮 R8-01–R8-04(Codex 第八轮):数组逐键与逐下标核对、report MCP 的 id 核对与单个请求的受控边界、
  // host 状态与空白字段的邻接放宽。第八轮 plain.ts 拆成 walkValue/walkRecord/walkArray,M61、M74 的注入点随之改写,含义不变
  ["M113 R8-01 审查 R8-B:放行单个空位(下标键只比 length 少一个时跳过空位)", "src/plain.ts", '    if (!d) return bad(path, "不允许稀疏数组");', '    if (!d && Reflect.ownKeys(x).length - 1 !== length - 1) return bad(path, "不允许稀疏数组");\n    if (!d) continue;'],
  ["M114 R8-01 空位一律跳过", "src/plain.ts", '    if (!d) return bad(path, "不允许稀疏数组");', "    if (!d) continue;"],
  ["M115 R8-01 不查下标上界(越界数字键放行)", "src/plain.ts", "if (!INDEX.test(k) || Number(k) >= length) return", "if (!INDEX.test(k)) return"],
  ["M116 R8-02 JSON-RPC id 不核对类型(其它类型原样回显)", "mcp/report-mcp.mjs", '  if (typeof id !== "number") return undefined;', '  if (typeof id !== "number") return JSON.stringify(id);'],
  ["M117 R8-02 小数 id 放行", "mcp/report-mcp.mjs", "return src !== undefined && integerSource(src) ? src : undefined;", "return src;"],
  ["M118 R8-02 null id 放行", "mcp/report-mcp.mjs", '  if (typeof id !== "number") return undefined;', '  if (typeof id !== "number") return id === null ? "null" : undefined;'],
  ["M119 R8-02 日志照写原始参数", "mcp/report-mcp.mjs", "...loggedArgs(a), ts:", "...a, ts:"],
  ["M120 R8-02 日志参数不合格时仍原样展开", "mcp/report-mcp.mjs", "? p.value : { omitted:", "? p.value : a || { omitted:"],
  ["M121 R8-02 日志的 ts/valid/errs 写在参数之前(参数能改写判定)", "mcp/report-mcp.mjs", "JSON.stringify({ ...loggedArgs(a), ts: new Date().toISOString(), valid: errs.length === 0, errs })", "JSON.stringify({ ts: new Date().toISOString(), valid: errs.length === 0, errs, ...loggedArgs(a) })"],
  ["M122 R8-02 去掉每行的受控边界(异常越过这一行)", "mcp/report-mcp.mjs", "    // 受控边界:这一条请求处理失败只回 -32603,不越过这一行;进程继续处理后续请求\n", "    throw err;\n"],
  ["M123 R8-02 受控边界不回复", "mcp/report-mcp.mjs", "    send(wire, { error: { code: -32603,", "    void (wire, { error: { code: -32603,"],
  ["M124 R8-02 受控边界的回复不带请求 id", "mcp/report-mcp.mjs", "    send(wire, { error: { code: -32603,", '    send("null", { error: { code: -32603,'],
  ["M125 R8-02 initialize 原样回显 protocolVersion", "mcp/report-mcp.mjs", 'typeof pv === "string" && pv ? pv : PROTOCOL_VERSION', "pv || PROTOCOL_VERSION"],
  ["M126 R8-03 审查 R8-A:放行 host connecting", "src/events.ts", 'if (host?.status !== "connected") return', 'if (host?.status !== "connected" && host?.status !== "connecting") return'],
  ["M127 R8-03 host 状态去空白、大小写不敏感", "src/events.ts", 'if (host?.status !== "connected") return', 'if (typeof host?.status !== "string" || host.status.trim().toLowerCase() !== "connected") return'],
  ["M128 R8-04 审查 R8-C:放行空白汇报字段", "src/report-schema.ts", 'typeof x === "string" && x.trim() !== ""', 'typeof x === "string" && x !== ""'],
  ["M129 R8-04 只去掉普通空格(制表、换行、全角空格仍放行)", "src/report-schema.ts", 'typeof x === "string" && x.trim() !== ""', 'typeof x === "string" && x.replaceAll(" ", "") !== ""'],
  // 以下对应第九轮 R9-01–R9-04(Codex 第九轮):请求编号原文、协议版本、请求与通知之分、空白任务与凭据引用方案名的邻接
  ["M130 R9-01 审查 S01:零编号拒收", "mcp/report-mcp.mjs", '  if (digits === "") return true;', '  if (digits === "") return false;'],
  ["M131 R9-01 数值编号按浮点值回显(丢精度,第八轮行为)", "mcp/report-mcp.mjs", "return src !== undefined && integerSource(src) ? src : undefined;", "return src !== undefined && integerSource(src) ? JSON.stringify(id) : undefined;"],
  ["M132 R9-01 按解析后的浮点值判整数", "mcp/report-mcp.mjs", "return src !== undefined && integerSource(src) ? src : undefined;", "return src !== undefined && Number.isInteger(id) ? src : undefined;"],
  ["M133 R9-01 只收安全整数范围(大整数拒收)", "mcp/report-mcp.mjs", "return src !== undefined && integerSource(src) ? src : undefined;", "return src !== undefined && integerSource(src) && Number.isSafeInteger(id) ? src : undefined;"],
  ["M134 R9-01 重复的顶层 id 取第一个", "mcp/report-mcp.mjs", '    if (key === "id") found = line.slice(start, i);', '    if (key === "id" && found === undefined) found = line.slice(start, i);'],
  ["M135 R9-01 嵌套值不整段跳过(内层同名字段也算)", "mcp/report-mcp.mjs", '      else if (c === "{" || c === "[") { depth++; i++; }', '      else if (c === "{" || c === "[") { i++; }'],
  ["M136 R9-01 空字符串编号拒收", "mcp/report-mcp.mjs", '  if (typeof id === "string") return JSON.stringify(id);', '  if (typeof id === "string") return id === "" ? undefined : JSON.stringify(id);'],
  ["M137 R9-01 带小数点的整数写法(10.0)拒收", "mcp/report-mcp.mjs", "  if (!m) return false;", "  if (!m || m[2] !== undefined) return false;"],
  ["M138 R9-01 指数写法(1E2)不认", "mcp/report-mcp.mjs", "(?:[eE]([+-]?[0-9]+))?$/;", "$/;"],
  ["M139 R9-02 不核对 jsonrpc 版本", "mcp/report-mcp.mjs", '    if (m.jsonrpc !== "2.0") {', "    if (false) {"],
  ["M140 R9-02 缺失版本放行", "mcp/report-mcp.mjs", '    if (m.jsonrpc !== "2.0") {', '    if (m.jsonrpc !== undefined && m.jsonrpc !== "2.0") {'],
  ["M141 R9-02 版本宽松比较(数字 2、\"2\" 放行)", "mcp/report-mcp.mjs", '    if (m.jsonrpc !== "2.0") {', "    if (m.jsonrpc != 2) {"],
  ["M142 R9-02 版本先去首尾空白", "mcp/report-mcp.mjs", '    if (m.jsonrpc !== "2.0") {', '    if (String(m.jsonrpc).trim() !== "2.0") {'],
  ["M143 R9-02 只对 tools/call 核对版本", "mcp/report-mcp.mjs", '    if (m.jsonrpc !== "2.0") {', '    if (m.method === "tools/call" && m.jsonrpc !== "2.0") {'],
  ["M144 R9-03 不区分通知(无编号消息也进入编号核对并被回复)", "mcp/report-mcp.mjs", '    if (!Object.hasOwn(m, "id")) return;\n', ""],
  ["M145 R9-03 通知照常派发、只是不回复(无编号汇报仍入日志)", "mcp/report-mcp.mjs", '    if (!Object.hasOwn(m, "id")) return;', '    if (!Object.hasOwn(m, "id")) { handle(m, () => {}); return; }'],
  ["M146 R9-03 只把 notifications/ 开头的方法当通知", "mcp/report-mcp.mjs", '    if (!Object.hasOwn(m, "id")) return;', '    if (!Object.hasOwn(m, "id") && String(m.method).startsWith("notifications/")) return;'],
  ["M147 R9-03 编号为 null 也按通知处理(不回复)", "mcp/report-mcp.mjs", '    if (!Object.hasOwn(m, "id")) return;', "    if (m.id === undefined || m.id === null) return;"],
  ["M148 R9-04 hy4 H9-01:去掉 task 的非空白判断", "src/brief.ts", 'if (typeof task !== "string" || !task.trim()) return refuse(', 'if (typeof task !== "string" || !task) return refuse('],
  ["M149 R9-04 审查 S04:放行的 task 去掉首尾空白", "src/brief.ts", "      task,\n      rules: Object.freeze([...rules]),", "      task: task.trim(),\n      rules: Object.freeze([...rules]),"],
  ["M150 R9 补充 审查 S03:凭据引用方案名只收字母", "src/brief.ts", "const CREDENTIAL_REF = /^[a-z][a-z0-9+.-]*:", "const CREDENTIAL_REF = /^[a-z][a-z]*:"],
  ["M151 R10-01 退回仅按结果行计数的旧判决", "test-support/tap-result.ts", "const valid = problems.length === 0;", "const valid = !run.timedOut && !run.signal && rows.length === total;"],
  ["M152 R10-02 审查 S04 不解码转义的键名", "mcp/report-mcp.mjs", "const key = JSON.parse(str());", "const key = str().slice(1, -1);"],
  ["M153 R10-03 hy4 H10-01 仅对带编号请求核对版本", "mcp/report-mcp.mjs", "if (m.jsonrpc !== \"2.0\") {", "if (Object.hasOwn(m, \"id\") && m.jsonrpc !== \"2.0\") {"],
  ["M154 R10-01 不核对计划和总数", "test-support/tap-result.ts", "if (total <= 0 || rows.length !== total || summary(\"tests\") !== total || summary(\"suites\") !== 0) problems.push(\"计划/测试总数/扁平结构不符\");", ""],
  ["M155 R10-01 不核对通过失败汇总", "test-support/tap-result.ts", "if (summary(\"pass\") !== passed.length || summary(\"fail\") !== failed.length) problems.push(\"通过/失败汇总不符\");", ""],
  ["M156 R10-01 不核对跳过待办取消汇总", "test-support/tap-result.ts", "if (summary(\"skipped\") !== 0 || summary(\"todo\") !== 0 || summary(\"cancelled\") !== 0) problems.push(\"跳过/待办/取消非零或缺失\");", ""],
  ["M157 R10-01 不核对行内指令", "test-support/tap-result.ts", "if (rows.some((m) => /\\s#\\s*(?:SKIP|TODO)\\b/i.test(m[3]!))) problems.push(\"结果行含跳过/待办指令\");", ""],
  ["M158 R10-01 不核对结果序号", "test-support/tap-result.ts", "rows.some((m, i) => Number(m[2]) !== i + 1)", "false"],
  ["M159 R10-01 不比对基线具名清单", "test-support/tap-result.ts", "if (expected && (names.length !== expected.length || names.some((name, i) => name !== expected[i]))) problems.push(\"具名测试与基线不一致\");", ""],
  ["M160 R10-01 不核对进程状态", "test-support/tap-result.ts", "if (run.timedOut || run.signal !== null || run.code !== (failed.length ? 1 : 0)) problems.push(\"超时/信号/退出码不符\");", ""],
  ["M161 R10-01 不核对失败类型", "test-support/tap-result.ts", "if (value(\"failureType\") !== \"testCodeFailure\") problems.push(`非测试代码失败:${row[3]}`);", ""],
  ["M162 R10-01 用无关具名失败代替目标", "test-support/tap-result.ts", "row[3] === target.name", "true"],
  ["M163 R10-01 不核对目标错误码", "test-support/tap-result.ts", "value(\"code\") === target.code", "true"],
  ["M164 R10-01 不核对目标异常类型", "test-support/tap-result.ts", "(!target.errorName || value(\"name\") === target.errorName)", "true"],
  ["M165 R10-01 把文件加载失败当具名失败", "test-support/tap-result.ts", "if (names.some((name) => /^\\/|\\.test\\.[cm]?[jt]s$/.test(name))) problems.push(\"文件级失败\");", ""],
  ["M166 R10-01 完整阳性被误拒收", "test-support/tap-result.ts", "killed: valid && matched", "killed: false"],
  ["M167 R11-01 主进程退出代替同组确认", "src/adapter.ts", "r?.exited === true && groupExited(r.pid)", "r?.exited === true"],
  ["M168 R11-01 快照省略同组确认", "src/adapter.ts", "if (!quiescent(r) || !terminal)", "if (!r?.exited || !terminal)"],
  ["M169 R11-01 新一轮省略停止确认", "src/adapter.ts", "        if (!quiescent(prev)) return refuse(\"旧轮停止尚未确认，等同组进程退出后再续接\");", ""],
  ["M170 R11-01 存在的进程组也当作已退出", "src/procgroup.ts", "try { process.kill(-pid, 0); return false; }", "try { process.kill(-pid, 0); return true; }"],
  ["M171 R11-01 已确认不存在的组仍不放行", "src/procgroup.ts", "return (err as NodeJS.ErrnoException).code === \"ESRCH\";", "return (err as NodeJS.ErrnoException).code === \"NEVER_CONFIRMED\";"],
  ["M172 R11-02 不在回收前检查 NUL 续接", "src/adapter.ts", "      if (text.includes(\"\\0\")) return refuse(\"续接内容不能含 NUL\");", ""],
  ["M173 R11-02 接受含 NUL 的 CLI 会话号", "src/events.ts", "  if (m.session_id.includes(\"\\0\")) return { type: \"bad-init\", reason: \"init 的 session_id 含 NUL\" };", ""],
  ["M174 R11-02 启动错误被报告为成功", "src/adapter.ts", "resolve(refuse(`CLI 启动失败:${errorText(err)}`));", "resolve({ ok: true });"],
  ["M175 R11-02 启动错误不保留旧轮", "src/adapter.ts", "          if (st.round === round) st.round = previous;", "          if (st.round === round && previous === null) st.round = previous;"],
  ["M176 R11-03 审查 F1 汇报版本用真假判断", "src/adapter.ts", "if (r.constraintVer !== undefined) st.constraintVer = r.constraintVer;", "if (r.constraintVer) st.constraintVer = r.constraintVer;"],
  ["M177 R11-03 审查 F2 快照版本零被排除", "src/brief.ts", "(constraintVer as number) < 0", "(constraintVer as number) <= 0"],
];

// 不用 --test-timeout:在 node --test <file> 下它限制的是整个文件,文件超过上限会被整体取消(部分执行)。
// 单条测试由测试文件自己的 within() 限时,整个文件由测试文件内 240 秒的看门狗限时,这里再加 TIMEOUT_MS 外层上限。
// RR-06:每个变异在自己的进程组里跑,有界超时;超时、被信号结束、或没有跑完全部测试都不算按名杀死。
// 只清理本变异副本目录下起的进程(命令行里带副本路径),不碰其它会话。
const TIMEOUT_MS = 360_000;
function reapDir(dir) {
  // 带上路径分隔符:否则 .../m4 会匹配到 .../m40 等别的变异副本,误杀它们的测试进程
  const needle = `${dir}${path.sep}`;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) > 1 && Number(m[1]) !== process.pid && m[2].includes(needle)) { try { process.kill(Number(m[1]), "SIGKILL"); } catch {} }
  }
}
function run(dir, id) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join("src", f));
  return new Promise((resolve) => {
    // 每个副本自己的 TMPDIR(在副本目录里):被测代码与测试建的 g-group-cc-* / fake-cc-* 都落在这里,
    // 变异体即使不清理目录(M73)也随副本一起删掉,不往系统临时目录漏(g-group#2900,原则 67)
    const tmpdir = path.join(dir, ".tmp");
    fs.mkdirSync(tmpdir, { recursive: true });
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmpdir } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, TIMEOUT_MS);
    // close 而非 exit:exit 可能先于 stdout 读完触发,TAP 输出会被截断
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reapDir(dir);
      if (EVIDENCE) {
        fs.writeFileSync(path.join(EVIDENCE, `${id}.tap`), out);
        fs.writeFileSync(path.join(EVIDENCE, `${id}.stderr`), err);
        fs.writeFileSync(path.join(EVIDENCE, `${id}.json`), JSON.stringify({ code, signal, timedOut }));
      }
      resolve({ code, signal, timedOut, out });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compute-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
// 第九轮起:注入后先做静态检查,变异体必须能编译/能加载,才进入行为判决(审查第九轮发现原清单 7 个 .ts 变异不可编译)
const TSC = path.join(ROOT, "node_modules", ".bin", "tsc");
const ROOT_TSCONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
function staticCheck(dir, file) {
  if (file.endsWith(".mjs")) {
    const c = spawnSync(process.execPath, ["--check", path.join(dir, file)], { encoding: "utf8" });
    return { ok: c.status === 0, what: "node --check", detail: (c.stderr ?? "").trim().split("\n")[0] ?? "" };
  }
  const cfg = path.join(dir, "tsconfig.mut.json");
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ compilerOptions: ROOT_TSCONFIG.compilerOptions, include: ["src/**/*.ts"] }));
  const c = spawnSync(TSC, ["-p", cfg], { cwd: dir, encoding: "utf8", timeout: 180_000 });
  return { ok: c.status === 0 && !c.signal, what: "tsc 类型检查", detail: `${c.stdout ?? ""}${c.stderr ?? ""}`.trim().split("\n").slice(0, 2).join(" / ") };
}
let ok = true;
const cleanDir = copy("clean");
const cleanTsc = staticCheck(cleanDir, "src/adapter.ts");
console.log(`${cleanTsc.ok ? "✓" : "✗"} 原样副本 tsc 类型检查${cleanTsc.ok ? "通过" : `失败:${cleanTsc.detail}`}`);
if (!cleanTsc.ok) ok = false;
const clean = await run(cleanDir, "clean");
const baseline = assessTap(clean);
const total = baseline.names.length;
const cleanOk = cleanTsc.ok && baseline.valid && clean.code === 0 && baseline.failed.length === 0;
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${baseline.passed.length} 绿 / ${baseline.failed.length} 红,完整 ${total} 条,退出码 ${clean.code}`);
if (!cleanOk) {
  console.log(`无效基线,停止校准:${JSON.stringify(baseline.problems)};失败:${JSON.stringify(baseline.failed)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
const CONCURRENCY = Number(process.env.CC_MUT_CONCURRENCY) > 0 ? Math.floor(Number(process.env.CC_MUT_CONCURRENCY)) : 2;
console.log(`并发 ${CONCURRENCY}`);
const ONLY = (process.env.CC_MUT_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const PROGRESS = process.env.CC_MUT_PROGRESS;
const results = new Array(M.length);
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= M.length) return;
    const [name, file, from, to] = M[i];
    if (ONLY.length && !ONLY.includes(name.split(" ")[0])) continue;
    const d = copy(`m${i}`);
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      results[i] = `✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`;
      if (PROGRESS) fs.appendFileSync(PROGRESS, `${results[i]}\n`);
      continue;
    }
    fs.writeFileSync(f, src.replace(from, to));
    const compiled = staticCheck(d, file);
    if (!compiled.ok) {
      results[i] = `✗ ${name}:注入后${compiled.what}不通过,不计为杀死:${compiled.detail}`;
      if (PROGRESS) fs.appendFileSync(PROGRESS, `${results[i]}\n`);
      continue;
    }
    const id = name.split(" ")[0];
    const target = TARGETS[id];
    if (!target || !baseline.names.includes(target.name)) throw new Error(`${id} 缺少有效具名目标`);
    const r = await run(d, id);
    const judged = assessTap(r, baseline.names, target);
    const verdict = judged.killed
      ? `✓ ${name}:${judged.passed.length} 绿 / ${judged.failed.length} 红,被「${target.name}」发现(${target.code})`
      : `✗ ${name}:不计为杀死:${JSON.stringify(judged.problems)},指定目标未匹配或执行无效`;
    results[i] = verdict;
    // 落盘时附上全部变红的测试名:负载高时偶发的计时类失败与真正杀死它的具名测试可以分开核对
    if (PROGRESS) fs.appendFileSync(PROGRESS, `${verdict}\t全部红:${JSON.stringify(judged.failed)}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const line of results.filter(Boolean)) { console.log(line); if (!line.startsWith("✓")) ok = false; }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ONLY.length ? `${M.length} 个变异,本次只跑 ${results.filter(Boolean).length} 个(CC_MUT_ONLY)` : `${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
