// 门禁变异校验(R-18 规则自身可信,针对 F-08):
// 把 scripts/gates 复制到临时目录,逐个注入"跳过门禁/放水"的变异,对副本跑它自己的自检(真实命令行入口)。
// 每个变异都必须让自检失败;原样副本必须通过。任何一个变异存活 → 退出 1。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CaseResult, DIRECT, killedBy, parseCases, RUNNER } from "./judge.ts";
import { gitEnv } from "./lib.ts";
import { CASES } from "./selftest.ts";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");

/**
 * kill:最可能发现这个变异的自检用例名。变异副本的自检先跑它,其余用例按原顺序随后照跑(FAILFAST 下第一个失败即停),
 * 判定口径不变,只是不必等到排在后面的那条用例。名字必须是现存用例,否则本次变异校验失败。
 */
/** target:这个变异改坏的是哪个门禁(G-*),或执行器本身(RUNNER),或直接判定的入口(DIRECT)。判"被发现"只认目标判因(judge.ts)。 */
interface Mutation { name: string; kill?: string; target: string[]; file: string; from: string | RegExp; to: string }
const GATE_KILL: Record<string, string> = {"trace": "改了代码没收据", "review": "作者自审", "red": "收据没写红提交", "stub": "F-07 测试只读顶层常量", "tautology": "恒真断言", "workflow": "PR 的 workflow 冒充受保护检查名"};
const GATE_IDS_ALL = ["G-TRACE", "G-REVIEW", "G-RED", "G-STUB", "G-TAUTO", "G-WORKFLOW", "G-LAYER", "G-PROVENANCE"];
const GATE_ID: Record<string, string> = { trace: "G-TRACE", review: "G-REVIEW", red: "G-RED", stub: "G-STUB", tautology: "G-TAUTO", workflow: "G-WORKFLOW" };
const GATE_NAMES = ["trace", "review", "red", "stub", "tautology", "workflow"]; // layers 是末项,单独一条
export const MUTATIONS: Mutation[] = [
  { name: "CI 模式不跑任何门禁", kill: "合规(CI 模式,不跑来源核对)", target: ["RUNNER"], file: "run-all.ts", from: ": ALL_GATES;", to: ": [];" },
  { name: "本机模式不跑来源核对", kill: "合规:先红后绿、跨厂商审查、来源核对通过", target: ["RUNNER"], file: "run-all.ts", from: "[...LOCAL_GATES, ...ALL_GATES]", to: "ALL_GATES" },
  { name: "有问题也退出 0", kill: "CI 模式下违规同样拦下", target: ["RUNNER"], file: "run-all.ts", from: "results.some((r) => r.problems.length) ? 1 : 0", to: "0" },
  { name: "执行器吞掉问题", kill: "CI 模式下违规同样拦下", target: ["RUNNER"], file: "lib.ts", from: "return { gate, problems: gate.run(ctx) };", to: "gate.run(ctx); return { gate, problems: [] };" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里就是要匹配源码里的模板字符串原文
  { name: "执行器把门禁出错当放行", kill: "RR-02 没有沙箱就停", target: ["RUNNER"], file: "lib.ts", from: "catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }", to: "catch { return { gate, problems: [] }; }" },
  { name: "workflow/依赖清单不算受管", kill: "F-02 只改 workflow 没收据", target: ["G-TRACE"], file: "lib.ts", from: "export const isGoverned = (f: string) => !UNGOVERNED_OWN.some((re) => re.test(f));", to: "export const isGoverned = (f: string) => f.startsWith(\"packages/\");" },
  { name: "来源核对不比对 hash", kill: "审查会话算出的是别的 hash", target: ["G-PROVENANCE"], file: "gates.ts", from: "str(c.result).trim() === rv.reviewed_hash", to: "true" },
  { name: "来源核对看全会话模型", kill: "F-04 历史出现过别家模型,算 hash 那一轮是同厂商", target: ["G-PROVENANCE"], file: "gates.ts", from: "const vs = new Set(hits.map((t) => vendorOf(t.model)));", to: "const vs = new Set([vendorOf(rv.model)]);" },
  { name: "豁免认消息里任意一行指令", kill: "RR-13 指令前另有说明文字", target: ["G-PROVENANCE"], file: "gates.ts", from: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim());", to: "const dm = (msg.text ?? \"\").split(\"\\n\").map((l) => DIRECTIVE.exec(l.trim())).find(Boolean) ?? null;" },
  { name: "红提交只要求点名一条", kill: "红提交上第二条测试本来就绿", target: ["G-RED"], file: "gates.ts", from: "for (const t of tests) if (then.get(key(t)) !== 1)", to: "for (const t of tests.slice(0, 1)) if (then.get(key(t)) !== 1)" },
  { name: "空桩失败不按名字计数", kill: "F-07 测试只读顶层常量", target: ["G-STUB"], file: "gates.ts", from: "if ((stubbed.get(k) ?? 0) !== n)", to: "if (false)" },
  { name: "断言不要求判源码结果", kill: "F-07 断言只判复制的逻辑", target: ["G-TAUTO"], file: "testlint.ts", from: "else if (t.srcAsserts === 0)", to: "else if (false)" },
  { name: "测试只认字面 test", kill: "合规:node:test 别名 + 断言", target: ["G-RED", "G-STUB", "G-TAUTO"], file: "testlint.ts", from: "if (TEST_FNS.has(orig)) testNames.set(e.name.text, \"test\");", to: "if (TEST_FNS.has(orig) && e.name.text === orig) testNames.set(e.name.text, \"test\");" },
  { name: "去掉审查人白名单检查", kill: "审查人 grok 被拦", target: ["G-REVIEW"], file: "gates.ts", from: "if (!POLICY.allowedReviewers.includes(rv.agent))", to: "if (false)" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配源码里的模板字符串原文
  { name: "来源核对不查审查会话 harness", kill: "原则 68 claude 审查会话必须是 claude 会话", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (!rv.session.startsWith(`${harnessOf(rv.agent)}:`))", to: "if (false)" },
  { name: "审查会话 harness 不按审查人区分", kill: "原则 68 claude 审 codex 作者放行(claude 会话)", target: ["G-PROVENANCE"], file: "gates.ts", from: "export const harnessOf = (agent: string) => (Object.hasOwn(POLICY.reviewerHarnessOf, agent) ? POLICY.reviewerHarnessOf[agent]! : POLICY.reviewerHarness);", to: "export const harnessOf = (_agent: string) => POLICY.reviewerHarness;" },
  { name: "claude 不受跨厂商约束", kill: "原则 68 claude 审查照样要跨研发厂商:作者用 Anthropic 模型", target: ["G-REVIEW"], file: "gates.ts", from: "if (va !== \"unknown\" && va === vr && !waiver)", to: "if (va !== \"unknown\" && va === vr && !waiver && rv.agent !== \"claude\")" },
  { name: "claude 可审 claude 作者", kill: "原则 68 claude 审 claude 作者被拦(禁止自审)", target: ["G-REVIEW"], file: "gates.ts", from: "if (rv.agent === author.agent)", to: "if (rv.agent === author.agent && rv.agent !== \"claude\")" },
  { name: "名单漏掉 argon", kill: "原则 68 argon 审 codex 作者放行(claude 会话,g-group#3199 备用审查人)", target: ["G-REVIEW"], file: "policy.json", from: "\"allowedReviewers\":[\"codex\",\"astra\",\"claude\",\"argon\"]", to: "\"allowedReviewers\":[\"codex\",\"astra\",\"claude\"]" },
  { name: "argon 会话回退成 codex", kill: "原则 68 argon 审 codex 作者放行(claude 会话,g-group#3199 备用审查人)", target: ["G-PROVENANCE"], file: "policy.json", from: "\"claude\":\"claude\",\"argon\":\"claude\"}", to: "\"claude\":\"claude\"}" },
  { name: "argon-chat 也进名单", kill: "原则 68 argon-chat 当审查人被拦(不能执行命令)", target: ["G-REVIEW"], file: "policy.json", from: "\"claude\",\"argon\"],", to: "\"claude\",\"argon\",\"argon-chat\"]," },
  { name: "不核对派活卡片", kill: "派活卡片显示会话属于别的助手", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (wrong.length) out.push(", to: "if (false) out.push(" },
  { name: "session 不做 realpath 包含检查", kill: "RR-01 会话文件软链到 PR 里的伪造记录", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (!inside(real)) return", to: "if (false) return" },
  { name: "session harness 不查白名单", kill: "RR-01 harness 不在白名单", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (!HARNESS_LIST.includes(m[1]!)) return", to: "if (false) return" },
  { name: "没有沙箱时回退宿主", kill: "RR-02 没有沙箱就停", target: ["G-RED", "G-STUB", "G-TAUTO"], file: "lib.ts", from: "throw new Error(\"没有可用沙箱(GATE_SIMULATE_NO_SANDBOX),拒绝在宿主上执行 PR 代码\");", to: "return \"seatbelt\";" },
  { name: "workflow 不查写权限", kill: "RR-03 带引号的写权限", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (val !== \"read\" && val !== \"none\")", to: "if (false)" },
  { name: "workflow 不拒绝表达式名字", kill: "RR-03 job 名用表达式拼出受保护名", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (/\\$\\{\\{/.test(n))", to: "if (false)" },
  { name: "不拦自比较断言", kill: "RR-04 自比较断言", target: ["G-TAUTO"], file: "testlint.ts", from: "if (PAIR.test(callee) && args.length >= 2 && norm(args[0]!) === norm(args[1]!))", to: "if (false)" },
  { name: "不拦不可达断言", kill: "RR-04 不可达断言", target: ["G-TAUTO"], file: "testlint.ts", from: "if (!reachable) unreachableAsserts.push(text);", to: "if (false) unreachableAsserts.push(text);" },
  { name: "不做返回值变异校准", kill: "RR-04 断言没检查返回值(返回值变异存活)", target: ["G-STUB"], file: "gates.ts", from: "if (mutable > 0) {", to: "if (false) {" },
  { name: "相对路径写操作不算产出", kill: "RR-05 判不了路径的 shell 轮次也算进去", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (writes && (cands.length === 0 ? !cwd : resolved.some((r) => r === undefined))) return true;", to: "" },
  { name: "测试身份按集合比较(计数去重)", kill: "RR-06 同名间接测试零断言", target: ["G-RED", "G-STUB", "G-TAUTO"], file: "gates.ts", from: "m.set(key(t), (m.get(key(t)) ?? 0) + 1);", to: "m.set(key(t), 1);" },
  { name: "不核对红提交测试体", kill: "RR-07 红提交上是另一份假断言", target: ["G-RED"], file: "gates.ts", from: "else if (redBodies.get(t.name) !== normBody(t.body))", to: "else if (false)" },
  { name: "豁免不核对 uid", kill: "RR-08 冒用所有者名字的另一个 uid", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (msg.by !== own.uid || msg.name !== own.name)", to: "if (false)" },
  { name: "豁免认引用里的文字", kill: "RR-13 整条消息是引用块里的指令", target: ["G-PROVENANCE"], file: "gates.ts", from: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim());", to: "const dm = DIRECTIVE.exec((msg.text ?? \"\").trim().replace(/^>\\s*/, \"\"));" },
  { name: "git 子进程继承 GIT_*", kill: "隔离:hook 环境的 GIT_DIR 指向别的仓库,门禁不碰它", target: ["RUNNER"], file: "lib.ts", from: "if (!k.startsWith(\"GIT_\") && v !== undefined) env[k] = v;", to: "if (v !== undefined) env[k] = v;" },
  { name: "self-check 白名单放给所有文件", kill: "RR-03 别的 workflow 冒充 self-check", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (c === \"self-check\" && f === \".github/workflows/self-check.yml\" && id === \"self-check\") continue;", to: "if (c === \"self-check\") continue;" },
  { name: "不检查 self-check 必需步骤", kill: "RR-09 self-check.yml 只 echo", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (f === SELF_CHECK_WF) for (const m of selfCheckProblems(doc))", to: "if (false) for (const m of selfCheckProblems(doc))" },
  { name: "不检查 self-check 步骤的 if", kill: "RR-09 门禁自检步骤加 if: false", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (s.if !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "不检查 self-check job 的 if", kill: "RR-09 job 加 if", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (job.if !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "不检查 self-check continue-on-error", kill: "RR-09 job 加 continue-on-error", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (job[\"continue-on-error\"] !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "变异命令允许任意后缀", kill: "RR-09 变异命令后接 || true", target: ["G-WORKFLOW"], file: "gates.ts", from: "npm run gates:mutation$/", to: "npm run gates:mutation/" },
  { name: "不检查 package.json 门禁脚本", kill: "RR-09 package.json 把 gates:mutation 改成 true", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (ctx.files.includes(SELF_CHECK_WF)) for (const m of selfCheckScriptProblems(", to: "if (false) for (const m of selfCheckScriptProblems(" },
  { name: "不检查 self-check 的 shell/working-directory", kill: "RR-09 必需步骤换 shell", target: ["G-WORKFLOW"], file: "gates.ts", from: "for (const k of [\"shell\", \"working-directory\"]) if (s[k] !== undefined)", to: "for (const k of [\"shell\", \"working-directory\"]) if (false)" },
  { name: "不检查 self-check 的 defaults", kill: "RR-09 job 用 defaults 换 shell", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (job.defaults !== undefined) out.push(", to: "if (false) out.push(" },
  { name: "红重放不覆盖测试依赖", kill: "RR-11 helper 在红提交上给了错期望值", target: ["G-RED"], file: "gates.ts", from: "for (const d of testDeps(ctx, files)) {", to: "for (const d of [] as string[]) {" },
  { name: "测试依赖只认非源码文件", kill: "RR-11 helper 在红提交上给了错期望值", target: ["G-RED"], file: "gates.ts", from: "if (!isSrc(dep) || data) { out.push(dep); queue.push(dep); }", to: "if (!isSrc(dep)) { out.push(dep); queue.push(dep); }" },
  { name: "返回值变异退回按文件判定", kill: "RR-12 一条强测试 + 一条只断言 typeof", target: ["G-STUB"], file: "gates.ts", from: "for (const k of base.keys()) if (hit.has(k) && (killed.get(k) ?? 0) === 0) out.push(", to: "for (const k of base.keys()) if (false) out.push(" },
  { name: "hash 调用认任意含 run-all --hash 的命令", kill: "RR-14 printf 打印 hash、run-all 只在注释里", target: ["G-PROVENANCE"], file: "gates.ts", from: "(c) => isHashCall(c.input) && str(c.result).trim() === rv.reviewed_hash", to: "(c) => /run-all\\.ts/.test(str(c.input)) && /--hash/.test(str(c.input)) && str(c.result).trim() === rv.reviewed_hash" },
  { name: "hash 调用不拒 shell 元字符", kill: "RR-14 真实 hash 输出被丢弃、再 echo hash", target: ["G-PROVENANCE"], file: "gates.ts", from: "(/[#;&|<>`$()\\\\'\"\\n\\r{}*?!]/.test(cmd) ? undefined : cmd.trim().split(/\\s+/))", to: "cmd.trim().split(/\\s+/)" },
  { name: "hash 调用不要求 node 后紧跟 run-all", kill: "RR-14 node 先跑别的脚本、run-all 只是它的参数", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (!/^(?:\\S*\\/)?scripts\\/gates\\/run-all\\.ts$/.test(argv[1]!)) return false;", to: "if (!argv.some((a) => /run-all\\.ts$/.test(a))) return false;" },
  { name: "产出厂商不认同仓库的另一个 clone", kill: "RR-15 后续轮次写进同仓库的另一个 clone", target: ["G-PROVENANCE"], file: "gates.ts", from: " || clone(abs);", to: " || (clone, false);" },
  { name: "0 用例判通过", kill: "g-group#2538 测试入口 0 条用例判失败", target: ["DIRECT"], file: "test-runner.ts", from: "if (tests === 0) return", to: "if (false) return" },
  { name: "读不到汇总行判通过", kill: "R4-02 判定:读不到汇总行判失败", target: ["DIRECT"], file: "test-runner.ts", from: "if (tests === undefined || pass === undefined) return", to: "if (false) return" },
  { name: "skip 计入用例数", kill: "R4-02 测试入口全部 skip 判失败", target: ["DIRECT"], file: "test-runner.ts", from: "if (pass === 0 || notRun.length) return", to: "if (false) return" },
  { name: "通过数为 0 也算执行", kill: "R4-02 测试入口全部 todo 判失败", target: ["DIRECT"], file: "test-runner.ts", from: "if (pass === 0 || notRun.length) return", to: "if (notRun.length && false) return" },
  { name: "不要求 test 脚本为规范值", kill: "g-group#2538 test 脚本改回裸 node --test(0 用例也判通过)", target: ["G-WORKFLOW"], file: "gates.ts", from: "  test: 'node scripts/gates/test-runner.ts", to: "  _test: 'node scripts/gates/test-runner.ts" },
  { name: "self-check 不要求 npm test 步骤", kill: "g-group#2538 self-check 缺 npm test 步骤", target: ["G-WORKFLOW"], file: "gates.ts", from: "  { label: \"npm test\", ok: (r) => r === \"npm test\" },\n", to: "" },
  { name: "self-check 不查 GATE_* 环境开关", kill: "R4-01 self-check job env 设 GATE_ 开关缩小自检", target: ["G-WORKFLOW"], file: "gates.ts", from: "if (/^GATE_/.test(k) && k !== \"GATE_SANDBOX_IMAGE\")", to: "if (false)" },
  { name: "任意非零即算发现", kill: "R4-01 端到端:中性变异 + 提示用例夹具故障,变异校验必须判存活", target: ["DIRECT"], file: "mutation.ts", from: /const k = killedBy\(m\.target, base, cases\);/, to: "const k = r.code !== 0 ? { case: \"(任意失败)\", ev: \"自检退出码非零\" } : undefined;" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配/注入源码里的模板字符串原文
  { name: "执行故障也算目标判因", kill: "R4-01 提示用例无关夹具故障不算发现", target: ["DIRECT"], file: "judge.ts", from: "if (mut.pass || (mut.kind !== \"verdict\" && mut.kind !== \"side\")) return undefined;", to: "if (mut.pass) return undefined;\n  if (mut.kind !== \"verdict\" && mut.kind !== \"side\") return `${mut.name} 执行故障(${mut.kind})`;" },
  { name: "任何门禁变了都算目标", kill: "R4-01 错的门禁变了不算发现目标", target: ["DIRECT"], file: "judge.ts", from: "for (const g of target) {\n    if (g === RUNNER || g === DIRECT) continue;", to: "for (const g of Object.keys({ ...base.gates, ...mut.gates })) {\n    if (g === RUNNER || g === DIRECT) continue;" },
  { name: "门禁自身出错也算拦下", kill: "R4-01 目标门禁因自身出错拦下不算预期原因", target: ["DIRECT"], file: "judge.ts", from: "if (mut.gateErrors.includes(g) || (base.gateErrors.includes(g) && !expectedError)) continue;", to: "" },
  { name: "预期拦下变成门禁自身出错仍算发现", kill: "R5-01 目标门禁由预期拦下变为门禁自身出错不算发现", target: ["DIRECT"], file: "judge.ts", from: "if (mut.gateErrors.includes(g) || (base.gateErrors.includes(g) && !expectedError)) continue;", to: "if (base.gateErrors.includes(g) && !expectedError) continue;" },
  { name: "目标门禁没跑也参与判定", kill: "R5-01 目标门禁没跑(观测缺失)不算发现", target: ["DIRECT"], file: "judge.ts", from: "if (!base.complete || !mut.complete || (before", to: "if (!base.complete || (!mut.complete && after !== undefined) || (before" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配/注入源码里的模板字符串原文
  { name: "门禁移出执行列表不算发现", kill: "R5-01 目标门禁从完整运行的执行列表里消失算发现", target: ["DIRECT"], file: "judge.ts", from: "return `${g} 从完整运行的执行列表里消失(没有运行)`;", to: "continue;" },
  { name: "输出完整性只看头部", kill: "R4-01 门禁输出解析:注册数与列出数一致且有 CONTENT_HASH 才算完整", target: ["DIRECT"], file: "judge.ts", from: "complete: !!n && Number(n[1]) === Object.keys(gates).length && /^CONTENT_HASH=[0-9a-f]{64}$/m.test(out) };", to: "complete: !!n };" },
  { name: "基线门禁出错一律排除", kill: "R5-01 基线就是按预期以门禁自身出错拦下(fail-closed)、变异后放行算发现", target: ["DIRECT"], file: "judge.ts", from: "const expectedError = base.expectHit.includes(g) && base.gateErrors.includes(g);", to: "const expectedError = false;" },
  { name: "判因不核对退出码", kill: "R5-01 结构化判因与退出码不一致不算发现", target: ["DIRECT"], file: "judge.ts", from: "if (mut.exit !== (anyFail ? 1 : 0)) continue;", to: "" },
  { name: "结构化结果不校验就收", kill: "R5-02 parseCases 遇到 null/数组/缺字段/错类型/非法枚举不抛错且全部拒收", target: ["DIRECT"], file: "judge.ts", from: "const c = validCase(v);", to: "const c = v as CaseResult;" },
  { name: "不拒 Proxy", kill: "R5-02 getter/setter/Proxy 回调 0 次且被拒收", target: ["DIRECT"], file: "judge.ts", from: "if (x === null || typeof x !== \"object\" || types.isProxy(x) || Array.isArray(x)) return undefined;", to: "if (x === null || typeof x !== \"object\" || Array.isArray(x)) return undefined;" },
  { name: "不拒访问器属性", kill: "R5-02 getter/setter/Proxy 回调 0 次且被拒收", target: ["DIRECT"], file: "judge.ts", from: "if (typeof k !== \"string\" || !(\"value\" in d) || !d.enumerable) return undefined;", to: "if (typeof k !== \"string\") return undefined;" },
  { name: "导出策略不冻结", kill: "R5-03 改导出的策略对象不改变后续门禁行为", target: ["DIRECT"], file: "gates.ts", from: "if (x && typeof x === \"object\" && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); }", to: "" },
  { name: "只冻结顶层", kill: "R5-03 改导出的策略对象不改变后续门禁行为", target: ["DIRECT"], file: "gates.ts", from: "for (const v of Object.values(x)) deepFreeze(v);", to: "" },
  { name: "注入点唯一性只查字符串", kill: "R5-04 正则注入点 0 次/多次在变异执行前拒绝,恰 1 次放行", target: ["DIRECT"], file: "mutation.ts", from: "const re = searchRe(from, true);\n  const unicode =", to: "const re = searchRe(from, false);\n  if (!re.test(src)) return 0; return 1;\n  const unicode =" },
  { name: "门禁临时 HOME 退出不删", kill: "磁盘:门禁命令行与一条自检用例跑完不在 TMPDIR 留下 gate-home/gate-run/gate-snap/gate-selftest 目录", target: ["DIRECT"], file: "lib.ts", from: "process.on(\"exit\", () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 退出时尽力删 */ } });", to: "" },
  ...GATE_NAMES.map((g) => ({ name: `从 ALL_GATES 删掉 ${g}`, kill: GATE_KILL[g]!, target: [GATE_ID[g]!], file: "gates.ts", from: new RegExp(`(ALL_GATES: readonly Gate\\[\\] = deepFreeze\\(\\[[^\\]]*?)\\b${g}, ?`), to: "$1" })),
  { name: "从 ALL_GATES 删掉 layers(末项)", kill: "领域层反向依赖内核", target: ["G-LAYER"], file: "gates.ts", from: /, layers\]\);/, to: "]);" },
  // R6-01..R6-04
  { name: "变异侧输出不完整仍判因", kill: "R6-01 目标门禁仍在但变异侧输出不完整(缺 CONTENT_HASH/少列表项/截断)不算发现", target: ["DIRECT"], file: "judge.ts", from: "if (!base.complete || !mut.complete || (before", to: "if (!base.complete || (!mut.complete && after === undefined) || (before" },
  { name: "killedBy 先用 instanceof 判 Map", kill: "R6-02 killedBy 基线 Map 是 Proxy/撤销的 Proxy/伪 Map、结果数组是 Proxy 时 trap 回调 0 次、不抛错、不给判因", target: ["DIRECT"], file: "judge.ts", from: "if (types.isProxy(base) || !types.isMap(base)) return undefined;", to: "if (!(base instanceof Map) || types.isProxy(base)) return undefined;" },
  { name: "数组校验先 Array.isArray 后判 Proxy", kill: "R6-02 killedBy 基线 Map 是 Proxy/撤销的 Proxy/伪 Map、结果数组是 Proxy 时 trap 回调 0 次、不抛错、不给判因", target: ["DIRECT"], file: "judge.ts", from: "if (types.isProxy(x) || !Array.isArray(x) ||", to: "if (!Array.isArray(x) || types.isProxy(x) ||" },
  { name: "ALL_GATES 只冻结数组", kill: "R6-03 改 ALL_GATES/LOCAL_GATES 里的门禁对象(run/id/rule/加属性)不改变后续门禁行为", target: ["DIRECT"], file: "gates.ts", from: "export const ALL_GATES: readonly Gate[] = deepFreeze([", to: "export const ALL_GATES: readonly Gate[] = Object.freeze([" },
  { name: "LOCAL_GATES 只冻结数组", kill: "R6-03 改 ALL_GATES/LOCAL_GATES 里的门禁对象(run/id/rule/加属性)不改变后续门禁行为", target: ["DIRECT"], file: "gates.ts", from: "export const LOCAL_GATES: readonly Gate[] = deepFreeze([", to: "export const LOCAL_GATES: readonly Gate[] = Object.freeze([" },
  { name: "零宽匹配按 UTF-16 单元前进", kill: "R6-04 正则注入计数:零宽 /u 按码点前进不死循环,sticky 与普通搜索计数一致", target: ["DIRECT"], file: "mutation.ts", from: "if (m[0] === \"\") re.lastIndex = advance(src, re.lastIndex, unicode);", to: "if (m[0] === \"\") re.lastIndex++;" },
  { name: "计数保留 sticky", kill: "R6-04 正则注入计数:零宽 /u 按码点前进不死循环,sticky 与普通搜索计数一致", target: ["DIRECT"], file: "mutation.ts", from: "const f = from.flags.replace(/[gy]/g, \"\");", to: "const f = from.flags.replace(/g/g, \"\");" },
  { name: "注入保留 sticky", kill: "R6-04 sticky 正则注入点按计数时的同一语义替换", target: ["DIRECT"], file: "mutation.ts", from: "src.replace(from, to) : src.replace(searchRe(from, false), to);\n}", to: "src.replace(from, to) : src.replace(from, to);\n}" },
  // R7-01:沙箱读隔离
  { name: "沙箱不拒读 HOME 下的点文件", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT"], file: "lib.ts", from: /\n {4}`\(deny file-read-data \$\{homes\.map[^\n]*/, to: "" },
  { name: "点文件拒读只按未规范化的 HOME", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT"], file: "lib.ts", from: "const homes = [...new Set([home, realOr(home)])];", to: "const homes = [home];" },
  { name: "沙箱不放行挂载的依赖", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT", "G-RED"], file: "lib.ts", from: "const runtime = [...[work, ...mounts].map(", to: "const runtime = [...[work].map(" },
  { name: "sandboxed 不把挂载交给 seatbelt", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT", "G-RED"], file: "lib.ts", from: "seatbeltProfile(w, mounts, exe)", to: "seatbeltProfile(w, [], exe)" },
  { name: "放行项盖过拒读清单(去掉末尾的拒读清单)", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT"], file: "lib.ts", from: /\n {4}`\(deny file-read-data \$\{\[\.\.\.new Set\(\[\.\.\.secret[^\n]*/, to: "" },
  { name: "拒读清单漏掉 .git-credentials 与 .netrc", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT"], file: "lib.ts", from: ", \".npmrc\", \".git-credentials\", \".netrc\"];", to: ", \".npmrc\"];" },
  { name: "拒读清单不按 realpath", kill: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", target: ["DIRECT"], file: "lib.ts", from: "[...new Set([...secret, ...secret.map(realOr)])]", to: "[...new Set(secret)]" },
  // R9-01..R9-03:放行范围、联网隔离、动态链接运行时
  { name: "执行计划额外放行 HOME", kill: "R9-01 seatbelt 读放行范围恰为工作副本与挂载的依赖,多出的放行项(如整个 HOME)判失败", target: ["DIRECT"], file: "lib.ts", from: "profile: seatbeltProfile(w, mounts, exe), profilePath", to: "profile: seatbeltProfile(w, [...mounts, os.homedir()], exe), profilePath" },
  { name: "seatbelt 放行联网", kill: "R9-02 联网隔离规则跨平台核对:seatbelt 恰为 deny network*,docker 恰为 --network none 且只挂副本与依赖", target: ["DIRECT"], file: "lib.ts", from: "\"(deny network*)\"", to: "\"(allow network*)\"" },
  { name: "docker 不断网", kill: "R9-02 联网隔离规则跨平台核对:seatbelt 恰为 deny network*,docker 恰为 --network none 且只挂副本与依赖", target: ["DIRECT"], file: "lib.ts", from: "\"--network\", \"none\"", to: "\"--network\", \"host\"" },
  { name: "docker 额外挂载 HOME", kill: "R9-02 联网隔离规则跨平台核对:seatbelt 恰为 deny network*,docker 恰为 --network none 且只挂副本与依赖", target: ["DIRECT"], file: "lib.ts", from: "[...new Set([w, ...mounts.map((m) => fs.realpathSync(m))])]", to: "[...new Set([w, os.homedir(), ...mounts.map((m) => fs.realpathSync(m))])]" },
  { name: "不放行运行时自带的动态库", kill: "R9-03 动态链接运行时:读放行逐个列出 bin/ 与 ../lib/ 下的 .dylib(literal,realpath),不放行目录与其它文件", target: ["DIRECT"], file: "lib.ts", from: "...runtimeLibs(exe).map(", to: "...([] as string[]).map(" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配/注入源码里的模板字符串原文
  { name: "运行时库按目录放行", kill: "R9-03 动态链接运行时:读放行逐个列出 bin/ 与 ../lib/ 下的 .dylib(literal,realpath),不放行目录与其它文件", target: ["DIRECT"], file: "lib.ts", from: "`(literal ${sbq(f)})`", to: "`(subpath ${sbq(path.dirname(f))})`" },
  { name: "运行时库不限 .dylib", kill: "R9-03 动态链接运行时:读放行逐个列出 bin/ 与 ../lib/ 下的 .dylib(literal,realpath),不放行目录与其它文件", target: ["DIRECT"], file: "lib.ts", from: "if (!e.name.endsWith(\".dylib\")) continue;", to: "" },
  // R11:按审查复现逐项注入,具名自检必须发现
  { name: "R11-01 同 remote 当成仓库身份证明", kill: "R11-01 remote 相同但历史不相交仍拒绝,共同历史放行", target: ["DIRECT"], file: "gates.ts", from: "const same = known && ([...id.roots].some((r) => own.roots.has(r)));", to: "const remote = (repo: string) => (spawnSync(\"git\", [...GIT_SAFE_ARGS, \"config\", \"--get\", \"remote.origin.url\"], { cwd: repo, encoding: \"utf8\", env: gitEnv() }).stdout ?? \"\").trim();\n    const remoteHere = remote(d);\n    const same = known && ([...id.roots].some((r) => own.roots.has(r)) || (remoteHere !== \"\" && remoteHere === remote(rootReal)));" },
  { name: "R11-02 混合输出中的提交号当成目录证明", kill: "R11-02 无关仓库输出附带目标提交号,清理前后均拒绝", target: ["DIRECT"], file: "gates.ts", from: "const m = typeof cmd === \"string\" ? exact.exec(cmd) : null;", to: "const m = typeof cmd === \"string\" ? exact.exec(cmd) : null;\n    if (!m && typeof cmd === \"string\") {\n      const cwd = [inp.cwd, inp.workdir, inp.working_directory].find((v): v is string => typeof v === \"string\") ?? _workdir;\n      const ds = gitDirs(cmd, cwd), d0 = ds[0];\n      const toks = strings(c.result).join(\"\\n\").match(/\\b[0-9a-f]{7,40}\\b/g) ?? [];\n      if (d0 && !fs.existsSync(d0) && toks.some(ours)) out.add(d0);\n    }" },
  { name: "R11-03 稀疏数组附带普通属性被收下", kill: "R11-03 稀疏数组加普通属性不得作为判因,密集数组放行", target: ["DIRECT"], file: "judge.ts", from: "function plainArray(x: unknown): unknown[] | undefined {\n  // 先判 Proxy:撤销的 Proxy 上 Array.isArray 会抛错(R6-02)\n  if (types.isProxy(x) || !Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) return undefined;\n  const ds = Object.getOwnPropertyDescriptors(x);\n  const len = (Object.getOwnPropertyDescriptor(x, \"length\") as PropertyDescriptor).value as number;\n  const keys = Reflect.ownKeys(ds);\n  // 长度以外只能有 0..length-1 的自有数据属性;先比数量,避免巨型稀疏数组逐项扫描。\n  if (keys.length !== len + 1) return undefined;\n  for (const k of keys) {\n    if (k === \"length\") continue;\n    if (typeof k !== \"string\" || !/^(0|[1-9]\\d*)$/.test(k)) return undefined;\n    const n = Number(k), d = ds[k]!;\n    if (!Number.isInteger(n) || n < 0 || n >= len || String(n) !== k || !(\"value\" in d)) return undefined;\n  }\n  const out: unknown[] = [];\n  for (let i = 0; i < len; i++) {\n    const d = ds[String(i)];\n    if (!d || !(\"value\" in d)) return undefined;\n    out.push(d.value);\n  }\n  return out;\n}", to: "function plainArray(x: unknown): unknown[] | undefined {\n  // 先判 Proxy:撤销的 Proxy 上 Array.isArray 会抛错(R6-02)\n  if (types.isProxy(x) || !Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) return undefined;\n  const ds = Object.getOwnPropertyDescriptors(x);\n  const out: unknown[] = [];\n  for (const k of Reflect.ownKeys(ds)) {\n    if (k === \"length\") continue;\n    const d = ds[k as string]!;\n    if (typeof k !== \"string\" || !/^(0|[1-9]\\d*)$/.test(k) || !(\"value\" in d)) return undefined;\n    out[Number(k)] = d.value;\n  }\n  const len = (Object.getOwnPropertyDescriptor(x, \"length\") as PropertyDescriptor).value as number;\n  return out.length === len && Object.keys(out).length === len ? out : undefined;\n}" },
  { name: "R11-04 跳过执行前容器计划守卫", kill: "R11-04 真实执行出口拒绝非法计划且不调用执行器,正常计划调用", target: ["DIRECT"], file: "lib.ts", from: "if (bad.length) throw new Error(", to: "if (false && bad.length) throw new Error(" },
  { name: "R11-05 只读调用算作产出", kill: "R11-05 只读不算产出,写操作正控", target: ["DIRECT"], file: "gates.ts", from: "if (SHELL_TOOLS.test(c.name ?? \"\") && command && /^(?:git\\s+status(?:\\s+(?:--short|-s|-sb|--porcelain(?:=v[12])?))*|git\\s+log\\s+--oneline\\s+-1|pwd|ls(?:\\s+(?:-[alhF]+|--|[A-Za-z0-9_./-]+))*|cat(?:\\s+(?:--|[A-Za-z0-9_./-]+))+)\\s*$/.test(command.trim())) continue;", to: "if (false && SHELL_TOOLS.test(c.name ?? \"\") && command && /^(?:git\\s+status(?:\\s+(?:--short|-s|-sb|--porcelain(?:=v[12])?))*|git\\s+log\\s+--oneline\\s+-1|pwd|ls(?:\\s+(?:-[alhF]+|--|[A-Za-z0-9_./-]+))*|cat(?:\\s+(?:--|[A-Za-z0-9_./-]+))+)\\s*$/.test(command.trim())) continue;" },
  { name: "R11-05 未知调用算成已证明作者", kill: "R11-05 未知调用不能单独证明作者产出", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (turnTouchesRepo(t, at.workdir, inRepo)) producers.add(vendor);", to: "if (turnTouchesRepo(t, at.workdir, inRepo)) { producers.add(vendor); confirmed.add(vendor); }" },
  { name: "R11-05 写入不与当前版本逐字节比较", kill: "R11-05 写入内容与受审版本不符时拒绝", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (fs.readFileSync(own).equals(Buffer.from(inp.content, \"utf8\"))) return true;", to: "if (true) return true;" },
  { name: "R11-05 Read 工具算作产出", kill: "R11-05 Read 工具只读文件不计产出", target: ["DIRECT"], file: "gates.ts", from: "if (READ_TOOLS.test(c.name ?? \"\")) continue;", to: "" },
  { name: "R11-05 普通只读命令算作产出", kill: "R11-05 简单 cat、ls、pwd 只读命令不计产出", target: ["DIRECT"], file: "gates.ts", from: "if (SHELL_TOOLS.test(c.name ?? \"\") && command && /^(?:git\\s+status(?:\\s+(?:--short|-s|-sb|--porcelain(?:=v[12])?))*|git\\s+log\\s+--oneline\\s+-1|pwd|ls(?:\\s+(?:-[alhF]+|--|[A-Za-z0-9_./-]+))*|cat(?:\\s+(?:--|[A-Za-z0-9_./-]+))+)\\s*$/.test(command.trim())) continue;", to: "if (SHELL_TOOLS.test(c.name ?? \"\") && command && /^(?:git\\s+status(?:\\s+(?:--short|-s|-sb|--porcelain(?:=v[12])?))*|git\\s+log\\s+--oneline\\s+-1)\\s*$/.test(command.trim())) continue;" },
  // R10-01..R10-05:来源仓库身份、导出策略不可变、容器参数逐项核对、运行库符号链接
  { name: "来源按目录名认仓库", kill: "R11-01 目录标签不足以确认仓库路径", target: ["DIRECT"], file: "gates.ts", from: "return under(abs, rootReal) || proven.some((d) => under(abs, d)) || clone(abs);", to: "return abs.split(path.sep).includes(\"g-group\") || under(abs, rootReal) || proven.some((d) => under(abs, d)) || clone(abs);" },
  { name: "仓库身份判不了按同一仓库算", kill: "R11-01 空仓库身份未知仍拒绝,共同历史放行", target: ["DIRECT"], file: "gates.ts", from: "const same = known && (", to: "const same = id === \"unknown\" || known && (" },
  { name: "git 仓库不比仓库身份", kill: "R11-01 remote 相同但历史不相交仍拒绝,共同历史放行", target: ["DIRECT"], file: "gates.ts", from: "const same = known && (", to: "const same = known || (" },
  { name: "不认宿主记录证明的已清理克隆", kill: "R10-02 清理后:同一记录里 git 输出的本仓库提交号证明是本仓库,来源门禁仍认出", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (proven.length || turnProvesWrite(t, at.workdir, ctx, inRepo)) confirmed.add(vendor);", to: "if (turnProvesWrite(t, at.workdir, ctx, inRepo)) confirmed.add(vendor);" },
  { name: "已清理目录证据不核对受审版本", kill: "R11-02 旧提交文件不再属于受审版本时拒绝", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (!inVersion(sha)) continue;", to: "" },
  { name: "记录证据不看现状", kill: "R11-02 提交后的目录变成非仓库时不得沿用旧身份", target: ["G-PROVENANCE"], file: "gates.ts", from: "if (fs.existsSync(d) && !sameRepoClone(rootReal)(d)) continue;", to: "" },
  { name: "受管范围导出不冻结", kill: "R10-03 改写导出的受管范围策略(数组增删、元素改写)不改变受管判定与门禁结论", target: ["DIRECT"], file: "lib.ts", from: "export const UNGOVERNED: readonly RegExp[] = frozenList(UNGOVERNED_SRC.map((s) => new RegExp(s)));", to: "export const UNGOVERNED: readonly RegExp[] = UNGOVERNED_SRC.map((s) => new RegExp(s));" },
  { name: "受管范围只冻结数组不冻结元素", kill: "R10-03 改写导出的受管范围策略(数组增删、元素改写)不改变受管判定与门禁结论", target: ["DIRECT"], file: "lib.ts", from: "Object.freeze(xs.map((x) => Object.freeze(x)))", to: "Object.freeze([...xs])" },
  { name: "受管判定直接用导出的未冻结数组", kill: "R10-03 真实门禁:同进程改写受管范围策略后,受管改动没收据照样拦下", target: ["G-TRACE"], file: "lib.ts", from: "export const UNGOVERNED: readonly RegExp[] = frozenList(UNGOVERNED_SRC.map((s) => new RegExp(s)));", to: "export const UNGOVERNED: readonly RegExp[] = UNGOVERNED_OWN as RegExp[];" },
  { name: "豁免格式导出不冻结", kill: "R10-03 改写导出的受管范围策略(数组增删、元素改写)不改变受管判定与门禁结论", target: ["DIRECT"], file: "gates.ts", from: "export const WAIVER_RE: RegExp = Object.freeze(new RegExp(WAIVER_OWN));", to: "export const WAIVER_RE: RegExp = new RegExp(WAIVER_OWN);" },
  { name: "豁免格式判定直接用导出的未冻结正则", kill: "R10-03 改写导出的受管范围策略(数组增删、元素改写)不改变受管判定与门禁结论", target: ["DIRECT"], file: "gates.ts", from: "export const WAIVER_RE: RegExp = Object.freeze(new RegExp(WAIVER_OWN));", to: "export const WAIVER_RE: RegExp = WAIVER_OWN;" },
  { name: "git 安全参数不冻结", kill: "R10-03 改写导出的受管范围策略(数组增删、元素改写)不改变受管判定与门禁结论", target: ["DIRECT"], file: "lib.ts", from: "Object.freeze([\"-c\", \"core.hooksPath=/dev/null\"])", to: "[\"-c\", \"core.hooksPath=/dev/null\"]" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 注入源码里的模板字符串原文
  { name: "容器计划多出一处 --mount 只读挂载", kill: "R10-04 容器执行计划逐项核对:只挂工作副本与依赖,另一种挂载形式(--mount/--volume/附着写法/--tmpfs/--volumes-from)、多挂少挂与其它参数判失败", target: ["DIRECT"], file: "lib.ts", from: "...vols, \"-w\", w, process.env.GATE_SANDBOX_IMAGE!", to: "...vols, \"--mount\", `type=bind,source=${path.dirname(w)},target=/fixture-extra,readonly`, \"-w\", w, process.env.GATE_SANDBOX_IMAGE!" },
  { name: "容器核对放过 --mount", kill: "R10-04 容器执行计划逐项核对:只挂工作副本与依赖,另一种挂载形式(--mount/--volume/附着写法/--tmpfs/--volumes-from)、多挂少挂与其它参数判失败", target: ["DIRECT"], file: "lib.ts", from: "    if (a === \"--rm\") continue;", to: "    if (a === \"--rm\" || a === \"--mount\") { i += a === \"--mount\" ? 1 : 0; continue; }" },
  { name: "容器核对不限 -v 集合", kill: "R10-04 容器执行计划逐项核对:只挂工作副本与依赖,另一种挂载形式(--mount/--volume/附着写法/--tmpfs/--volumes-from)、多挂少挂与其它参数判失败", target: ["DIRECT"], file: "lib.ts", from: "if (v === undefined || !want.includes(v)) out.push(", to: "if (v === undefined) out.push(" },
  { name: "运行库符号链接不放行", kill: "R10-05 运行库为符号链接:读放行列出指向运行时内 .dylib 的实际文件,指向运行时之外、目录、非 .dylib 或悬空的链接不放行", target: ["DIRECT"], file: "lib.ts", from: "if (!e.isSymbolicLink()) continue;", to: "continue;" },
  { name: "运行库链接不限运行时目录", kill: "R10-05 运行库为符号链接:读放行列出指向运行时内 .dylib 的实际文件,指向运行时之外、目录、非 .dylib 或悬空的链接不放行", target: ["DIRECT"], file: "lib.ts", from: "if (!t.startsWith(top + path.sep)) continue;", to: "" },
  { name: "运行库链接目标不限 .dylib", kill: "R10-05 运行库为符号链接:读放行列出指向运行时内 .dylib 的实际文件,指向运行时之外、目录、非 .dylib 或悬空的链接不放行", target: ["DIRECT"], file: "lib.ts", from: "if (!t.endsWith(\".dylib\")) continue;", to: "" },
  { name: "运行库链接目标不限普通文件", kill: "R10-05 运行库为符号链接:读放行列出指向运行时内 .dylib 的实际文件,指向运行时之外、目录、非 .dylib 或悬空的链接不放行", target: ["DIRECT"], file: "lib.ts", from: "try { if (!fs.statSync(t).isFile()) continue; } catch { continue; }", to: "" },
];

/**
 * 正则注入点的统一语义(R6-04):在源码里"找"注入点是普通搜索。sticky(y)只在 lastIndex 处匹配,和普通搜索的出现次数不同,
 * 所以计数与替换都去掉 y、按同一个普通搜索正则来做;计数再加 g 全局扫描。
 */
function searchRe(from: RegExp, global: boolean): RegExp {
  const f = from.flags.replace(/[gy]/g, "");
  return new RegExp(from.source, global ? `${f}g` : f);
}
/** 零宽匹配后的推进:Unicode 正则(u/v)按码点前进,不停在代理对中间(否则每次又回到代理对开头匹配,死循环) */
function advance(s: string, i: number, unicode: boolean): number {
  if (unicode && i + 1 < s.length) {
    const hi = s.charCodeAt(i), lo = s.charCodeAt(i + 1);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return i + 2;
  }
  return i + 1;
}
/**
 * 注入点在源码里的匹配次数(R5-04/R6-04):字符串按字面出现次数;正则按 searchRe 的普通搜索全局计数,
 * 零宽匹配按码点推进;匹配位置一旦不再前进就判为无界(返回 Infinity,必然不唯一)。变异执行前要求恰为 1。
 */
export function injectionCount(src: string, from: string | RegExp): number {
  if (typeof from === "string") return from === "" ? Number.POSITIVE_INFINITY : src.split(from).length - 1;
  const re = searchRe(from, true);
  const unicode = re.flags.includes("u") || re.flags.includes("v");
  let n = 0, last = -1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index <= last && m[0] === "") return Number.POSITIVE_INFINITY;
    n++;
    last = m.index;
    if (m[0] === "") re.lastIndex = advance(src, re.lastIndex, unicode);
  }
  return n;
}
/** 注入:和 injectionCount 同一语义(字符串字面替换首处;正则用 searchRe 的普通搜索替换首处,替换模式 $1/$& 照常) */
export function inject(src: string, from: string | RegExp, to: string): string {
  return typeof from === "string" ? src.replace(from, to) : src.replace(searchRe(from, false), to);
}

function copyGates(dst: string) {
  fs.mkdirSync(path.join(dst, "scripts/gates"), { recursive: true });
  for (const f of fs.readdirSync(HERE)) if (f.endsWith(".ts") || f.endsWith(".json")) fs.copyFileSync(path.join(HERE, f), path.join(dst, "scripts/gates", f));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dst, "node_modules"));
  fs.writeFileSync(path.join(dst, "package.json"), JSON.stringify({ type: "module" }));
}

/** 变异并发 × 每个变异自检的并发 ≈ CPU 数,不超订(GATE_SELFTEST_JOBS 显式给了就用它) */
const WIDTH = Math.max(1, Number(process.env.GATE_MUTATION_JOBS ?? 4));
const CHILD_JOBS = Number(process.env.GATE_SELFTEST_JOBS ?? Math.max(1, Math.floor(os.availableParallelism() / WIDTH)));
/** 单个变异的自检上限。超时算"没被发现"(✗):没跑完的自检证明不了门禁拦得住这个变异。 */
const MUTANT_TIMEOUT_MS = Number(process.env.GATE_MUTANT_TIMEOUT_MS ?? 900_000);
function runSelftestAsync(dir: string, m: Mutation, baselineFile: string): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { env: gitEnv({ GATE_SELFTEST_FAILFAST: "1", GATE_SELFTEST_JOBS: String(CHILD_JOBS), GATE_MUTANT_COPY: "1", GATE_SELFTEST_TARGET: m.target.join(","), GATE_SELFTEST_BASELINE: baselineFile, ...(m.kill ? { GATE_SELFTEST_FIRST: m.kill } : {}) }), detached: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-c.pid!, "SIGKILL"); } catch { c.kill("SIGKILL"); } }, MUTANT_TIMEOUT_MS);
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}

/** 原样对照的上限(GATE_CLEAN_TIMEOUT_MS,默认 30 分钟)。超时单独报出,不和"原样自检失败"混在一起。 */
const CLEAN_TIMEOUT_MS = Number(process.env.GATE_CLEAN_TIMEOUT_MS ?? 1_800_000);
function runSelftest(dir: string) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts/gates/run-all.ts"), "--self-test"], { encoding: "utf8", env: gitEnv(), timeout: CLEAN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), timedOut };
}

export async function mutationTest(): Promise<boolean> {
  // kill 提示写错时,副本自检会因"用例不存在"失败,变异就会被误算成被发现:先核对,有错整次失败
  const names = new Set(CASES.map((c) => c.name));
  const targets = new Set([...GATE_IDS_ALL, RUNNER, DIRECT]);
  const badHints = MUTATIONS.filter((m) => m.kill === undefined || !names.has(m.kill) || m.target.length === 0 || m.target.some((t) => !targets.has(t)));
  // 注入点必须唯一:字符串 from 在目标文件里出现多次时(例如改的是 mutation.ts 自己,MUTATIONS 里就有一份同样的字面量),
  // replace 只改第一处,可能改到无关位置,变异等于没注入
  for (const m of MUTATIONS) if (injectionCount(fs.readFileSync(path.join(HERE, m.file), "utf8"), m.from) !== 1) badHints.push(m);
  if (badHints.length) {
    for (const m of badHints) console.log(`✗ 变异「${m.name}」的 kill 提示「${m.kill ?? "(缺)"}」、目标 ${JSON.stringify(m.target)} 不合法或注入点不唯一`);
    console.log("变异校验失败");
    return false;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mutation-"));
  let ok = true;
  try {
    const clean = path.join(tmp, "clean");
    copyGates(clean);
    const tc = Date.now();
    const c = runSelftest(clean);
    console.log(`原样副本自检耗时 ${Math.round((Date.now() - tc) / 1000)}s`);
    const cleanOk = c.code === 0 && c.out.includes("自检通过");
    if (c.timedOut) { console.log(`✗ 原样对照超时:原样副本自检 ${CLEAN_TIMEOUT_MS / 1000}s 内没跑完(GATE_CLEAN_TIMEOUT_MS 可调),变异没有开始,不是变异存活`); console.log(c.out); return false; }
    console.log(`${cleanOk ? "✓" : "✗"} 原样副本自检通过`);
    if (!cleanOk) { console.log(c.out); return false; }
    // 原样基线:每条用例的结构化结果都要在、都要通过
    const baseList = parseCases(c.out);
    const base = new Map<string, CaseResult>(baseList.map((r) => [r.name, r]));
    const onlyRe = process.env.GATE_SELFTEST_ONLY ? new RegExp(process.env.GATE_SELFTEST_ONLY) : undefined;
    const missing = CASES.filter((x) => (!onlyRe || onlyRe.test(x.name)) && !base.get(x.name)?.pass).map((x) => x.name);
    if (missing.length) { console.log(`✗ 原样副本缺少或未通过这些用例的结构化结果:${missing.slice(0, 5).join("、")}${missing.length > 5 ? " 等" : ""}`); return false; }
    const baselineFile = path.join(tmp, "baseline.json");
    fs.writeFileSync(baselineFile, JSON.stringify(baseList));
    // 本机诊断用:GATE_MUTATION_ONLY=<正则> 只跑名字匹配的变异(CI 不设,跑全部)
    const only = process.env.GATE_MUTATION_ONLY ? new RegExp(process.env.GATE_MUTATION_ONLY) : undefined;
    const picked = MUTATIONS.filter((m) => !only || only.test(m.name));
    const jobs = picked.map((m, i) => () => {
      const d = path.join(tmp, `m${i}`);
      copyGates(d);
      const f = path.join(d, "scripts/gates", m.file);
      const src = fs.readFileSync(f, "utf8");
      const mutated = inject(src, m.from, m.to);
      if (mutated === src) return Promise.resolve(`✗ 变异「${m.name}」没能注入(代码已变,更新 MUTATIONS)`);
      fs.writeFileSync(f, mutated);
      const t0 = Date.now();
      return runSelftestAsync(d, m, baselineFile).then((r) => {
        const secs = Math.round((Date.now() - t0) / 1000);
        if (r.timedOut) return `✗ 变异「${m.name}」自检超时(${secs}s),不算被发现`;
        const cases = parseCases(r.out);
        // 只有"目标门禁因预期原因失败"才算发现;任意非零退出码不算(R4-01)
        const k = killedBy(m.target, base, cases);
        if (k) return `✓ 变异「${m.name}」(${secs}s)被「${k.case}」发现:${k.ev}`.slice(0, 220);
        const fails = cases.filter((x) => !x.pass);
        const kinds = [...new Set(fails.map((x) => x.kind))].map((kd) => `${kd} ${fails.filter((x) => x.kind === kd).length}`).join(",");
        return `✗ 变异「${m.name}」(${secs}s)没有被目标判因发现:目标 ${m.target.join("/")},跑了 ${cases.length} 条,失败 ${fails.length} 条${kinds ? `(${kinds},都不是目标判因)` : ""}`;
      });
    });
    const width = Math.max(1, Math.min(WIDTH, jobs.length));
    console.log(`变异 ${jobs.length} 个,并发 ${width},每个变异的自检并发 ${CHILD_JOBS},CPU ${os.availableParallelism()},node ${process.version}`);
    const t0 = Date.now();
    const lines: string[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) { const i = next++; lines[i] = await jobs[i]!(); console.log(`[${lines.filter(Boolean).length}/${jobs.length}] ${lines[i]}`); }
    }));
    console.log(`—— 汇总(总耗时 ${Math.round((Date.now() - t0) / 1000)}s)——`);
    for (const l of lines) { console.log(l); if (l.startsWith("✗")) ok = false; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(ok ? "变异校验通过" : "变异校验失败");
  return ok;
}

if (import.meta.main) process.exit((await mutationTest()) ? 0 : 1);
