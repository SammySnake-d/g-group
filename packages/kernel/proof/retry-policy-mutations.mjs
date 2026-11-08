// AC-36 纯策略的行为变异校准(R-05 阳性埋雷):按验收文档 AC-36「坏实现」列逐个向 retry-policy.ts 注入单一故障,
// 在隔离副本里只跑 retry-policy.test.ts;每个变异都必须让指定的具名测试以断言失败(ERR_ASSERTION)的方式失败,
// 文件加载失败不算杀死;注入点在源码里必须恰好出现 1 次;原样副本必须全绿(阴性对照)。
// 用法: node packages/kernel/proof/retry-policy-mutations.mjs [并发,默认 1,最多 2]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const TARGET = "retry-policy.ts";
const TEST = "retry-policy.test.ts";

// [编号与说明, 注入点, 替换为, 应失败的具名测试, 对应坏实现]
const M = [
  ["R01 403 也自动重试", 'if (heal === "A2" || heal === "A3") return card("permanent");', 'if (heal === "A3") return card("permanent");', "F2 A2 配额耗尽(403 Insufficient user quota):任意 B 都 0 次自动重试,立即出卡", "③ 403 自动重试"],
  ["R02 A3 也自动重试", 'if (heal === "A2" || heal === "A3") return card("permanent");', 'if (heal === "A2") return card("permanent");', "F2 A3 永久拒绝:0 次自动重试,立即出卡", "③"],
  ["R03 unknown 无上限重试", 'const budget = heal === "A1" ? p.policy.maxAutoRetries : p.policy.unknownMaxRetries;', "const budget = p.policy.maxAutoRetries;", "F8 unknown×(B0|B1) 最多有界重试 1 次即出卡", "阳性埋雷① unknown 无上限重试"],
  ["R04 B2 超时自动重发", 'if (effect === "B2") return card("delivery-unknown");', "", "F9 A1×B2 外部结果未知:0 次自动重发,置 DeliveryUnknown", "⑤ B2 超时自动重发"],
  ["R05 unknown×B2 也重发", 'if (effect === "B2") return card("delivery-unknown");', 'if (effect === "B2" && heal !== "unknown") return card("delivery-unknown");', "F8 unknown×B2 0 次自动重发,置 DeliveryUnknown", "⑤"],
  ["R06 不置 DeliveryUnknown", 'deliveryUnknown: effect === "B2", attempts', "deliveryUnknown: false, attempts", "F9 A1×B2 外部结果未知:0 次自动重发,置 DeliveryUnknown", "⑤"],
  ["R07 CLI 与宿主重试叠加(5×3)", "if (attempts + harness >= budget) return card(\"exhausted\");", "if (attempts >= budget) return card(\"exhausted\");", "F3 统一重试权:harness 已重试的次数计入同一预算,不叠加", "F3 重试风暴"],
  ["R08 耗尽后仍重试", "if (attempts + harness >= budget) return card(\"exhausted\");", "", "F1 耗尽自动重试上限:只出 1 张卡,原因 exhausted", "F1 耗尽不出卡"],
  ["R09 用户中断当失败重试", 'if (f.v.userAborted === true) return { kind: "aborted", clearTransient: true };', "", "F7 用户主动中断不是失败:0 重试 0 出卡,清掉本轮残留的瞬态错误", "F7"],
  ["R10 整轮判卡死后仍静默重试", 'if (f.v.stallJudged === true) return card("stall");', "", "D26 整轮已由宿主判卡死:不再静默重试同一轮,直接出卡", "统一重试权"],
  ["R11 不是指数退避", "policy.baseDelayMs * 2 ** Math.min(k, 52)", "policy.baseDelayMs * (k + 1)", "F1 指数退避:延迟按 2 的幂增长、到封顶为止,抖动只往下收", "F1"],
  ["R12 退避不封顶", "Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(k, 52))", "policy.baseDelayMs * 2 ** Math.min(k, 52)", "F1 指数退避:延迟按 2 的幂增长、到封顶为止,抖动只往下收", "F1"],
  ["R13 抖动往上加", "Math.floor(raw * (1 - policy.jitter * r))", "Math.floor(raw * (1 + policy.jitter * r))", "F1 指数退避:延迟按 2 的幂增长、到封顶为止,抖动只往下收", "F1"],
  ["R14 unknown 上限可设成 2", "if (!isNat(v.unknownMaxRetries) || v.unknownMaxRetries > 1)", "if (!isNat(v.unknownMaxRetries))", "参数可配:上限、基数、封顶、抖动按传入值;unknown 上限只能 0 或 1,非法参数拒收", "阳性埋雷① unknown 无上限"],
  ["R15 入口不判普通数据对象", "const p = plainData(x, at);", "const p = { ok: true as const, value: x as unknown, path: \"\", why: \"\" };", "输入合同:null、缺字段、未知分类一律拒收不抛错;访问器与 Proxy 拒收且不调用", "输入合同"],
  ["R16 默认参数不冻结", "export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ maxAutoRetries: 3, unknownMaxRetries: 1, baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0.2 });", "export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAutoRetries: 3, unknownMaxRetries: 1, baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0.2 };", "导出的默认参数、分类表与初始状态冻结,调用方改不动", "导出的策略对象不能被调用方改写"],
  ["R17 额度错误映射成可自愈", '["auth_or_quota", "A2"],', '["auth_or_quota", "A1"],', "失败原因类别映射到 A 维:瞬态 A1、配置/配额 A2、平台拒绝 A3、认不出 unknown、人停不是失败", "③ 403 自动重试"],
  ["R18 平台拒绝映射成可自愈", '["platform_refused", "A3"],', '["platform_refused", "A1"],', "失败原因类别映射到 A 维:瞬态 A1、配置/配额 A2、平台拒绝 A3、认不出 unknown、人停不是失败", "③"],
  ["R19 副作用不明当 B0", 'if (retryClass === "UnknownEffect") return "B2";', "", "副作用维度:分类器判不知道副作用做没做完(UnknownEffect)一律按 B2;其余按宿主给的 hint", "⑤ B2 自动重发"],
  // —— 共享熔断(F10)
  ["R20 无共享熔断:每次失败都出卡", "return { ok: true, state: freezeState({ ...cur, failures, members }), opened: false };", "return { ok: true, state: freezeState({ ...cur, failures, members }), opened: true };", "F10 同一上游 3 个联系人连续 502:到阈值打开熔断,只在打开那一刻出 1 张群级卡", "③ N 联系人各出 1 张卡或无共享上游熔断"],
  ["R21 打开期间每次失败再出卡", 'if (cur.status === "open") return { ok: true, state: freezeState({ ...cur, failures, manualOnly, members }), opened: false };', 'if (cur.status === "open") return { ok: true, state: freezeState({ ...cur, failures, manualOnly, members }), opened: true };', "F10 同一上游 3 个联系人连续 502:到阈值打开熔断,只在打开那一刻出 1 张群级卡", "③ N 联系人各出 1 张卡"],
  ["R22 403 不立即打开熔断", 'if (heal === "A2" || members.length >= p.policy.memberThreshold) {', "if (members.length >= p.policy.memberThreshold) {", "F2 同一 Key 403 配额耗尽:第一次就打开熔断,N 个联系人合并只出 1 张群级卡", "③ 共用 Key 403 各出卡"],
  ["R23 打开期间不暂停", "if (nowMs < due) return res(false, false, due - nowMs, false, cur);", "", "F10 熔断打开期间暂停后台重试,冷却到期才放 1 个半开探测", "③ 无共享上游熔断"],
  ["R24 半开放多个探测", "if (cur.probeInFlight) return res(false, false, p.policy.cooldownMs, false, cur);", "", "F10 熔断打开期间暂停后台重试,冷却到期才放 1 个半开探测", "③"],
  ["R25 半开失败又出一张卡", 'if (cur.status === "half-open") return { ok: true, state: freezeState({ ...cur, status: "open", failures, openedAt: nowMs, probeInFlight: false, manualOnly, members }), opened: false };', 'if (cur.status === "half-open") return { ok: true, state: freezeState({ ...cur, status: "open", failures, openedAt: nowMs, probeInFlight: false, manualOnly, members }), opened: true };', "F10 半开探测失败:重新打开、重新计冷却,不再出第二张卡", "③"],
  ["R26 半开失败不重新计冷却", 'status: "open", failures, openedAt: nowMs, probeInFlight: false, manualOnly, members }), opened: false };', 'status: "open", failures, probeInFlight: false, manualOnly, members }), opened: false };', "F10 半开探测失败:重新打开、重新计冷却,不再出第二张卡", "③"],
  ["R27 恢复后不交回被暂停的成员", "resume: Object.freeze(recovered ? [...s.state.members] : [])", "resume: Object.freeze([])", "F10 半开探测成功:回到关闭并交回被暂停的成员续跑", "F10 半开探测恢复后续跑"],
  ["R28 内容拒绝也计入上游", 'if (heal === "A3") return { ok: true, state: freezeState(cur), opened: false };', "", "A3 内容拒绝只关乎这次请求,不计入上游熔断", "③"],
  ["R29 成功不清零", "return { ok: true, state: BREAKER_CLOSED, recovered,", "return { ok: true, state: freezeState({ ...s.state, status: \"closed\", openedAt: null, probeInFlight: false }), recovered,", "熔断计数在成功后清零:成功之前失败过的成员不再算进下一次", "F10"],
  ["R30 不校验优先级", 'if (priority !== "interactive" && priority !== "background") return { ok: false, reason: "priority 只能是 interactive/background" };', "", "熔断参数可配;交互关键路径优先级只做接口(被校验、被记录)", "F10 分级接口"],
  ["R52 按失败次数而不是不同成员打开", "|| members.length >= p.policy.memberThreshold) {", "|| failures >= p.policy.memberThreshold) {", "同一个联系人自己反复失败不触发共享熔断,由它自己的重试上限出卡", "F1 单联系人耗尽应出原位卡"],
  ["R53 403 打开的熔断冷却后自动探测", "if (cur.manualOnly) return res(false, false, 0, true, cur);", "", "F2 403 打开的熔断不自动半开探测:冷却到期也暂停,等用户在群级卡上点重试", "阳性埋雷① 对 403 开启自动重试"],
  ["R54 打开后遇到 403 不升级为只能人工", 'const manualOnly = cur.manualOnly || heal === "A2";', 'const manualOnly = cur.status === "closed" ? heal === "A2" : cur.manualOnly;', "F2 403 打开的熔断不自动半开探测:冷却到期也暂停,等用户在群级卡上点重试", "阳性埋雷① 对 403 开启自动重试"],
  ["R55 用户点重试也要等冷却", "if (manual) return res(true, true, 0, false, probe);", "", "用户在群级卡上点[重试]:不等冷却立即放 1 个半开探测", "F10 群级卡重试"],
  ["R56 不校验 manual", 'if (typeof manual !== "boolean") return { ok: false, reason: "manual 必须是布尔" };', "", "用户在群级卡上点[重试]:不等冷却立即放 1 个半开探测", "输入合同"],
  // —— 崩溃循环(F12)
  ["R31 去掉 crash_recovery_count 上限", 'if (count > maxRecoveries) return { ok: true, state: next, decision: "blocked", why: "crash-loop" };', "", "F12 同一失败输入:第 1 次崩溃恢复允许自动续跑,第 2 次熔断 CrashLoopBlocked", "⑥ 去掉 crash_recovery_count 上限"],
  ["R32 同一输入不累计", "const count = s.v.key === f.v.key ? (s.v.count as number) + 1 : 1;", "const count = 1;", "F12 同一失败输入:第 1 次崩溃恢复允许自动续跑,第 2 次熔断 CrashLoopBlocked", "⑥"],
  ["R33 换了输入仍累计", "const count = s.v.key === f.v.key ? (s.v.count as number) + 1 : 1;", "const count = (s.v.count as number) + 1;", "F12 换了失败输入(游标已前进)按新输入从 1 计", "⑥"],
  ["R34 成功轮次不清零", "export function crashCommitted(): CrashState {\n  return CRASH_CLEAN;", "export function crashCommitted(): CrashState {\n  return { key: \"k\", count: 1 };", "F12 新成功轮次清零:之后同一输入再崩溃仍算第 1 次", "⑥"],
  ["R35 B2 在途也自动续跑", 'if (effect === "B2") return { ok: true, state: next, decision: "blocked", why: "delivery-unknown" };', "", "F12 在途的是 B2 外部不幂等动作:不自动续跑", "⑤ B2 自动重发"],
  // —— 休眠宽限门(F11)
  ["R36 去掉 awakeSince 宽限门", "return awakeSince === null || nowMs - awakeSince >= c.p.graceMs;", "return true;", "F11 时钟跳变 +10 分钟:awakeSince 宽限期内不判 stopped-beating", "⑥ 去掉 awakeSince 休眠宽限门"],
  ["R37 宽限门成了总开关", "return mayJudgeStale(wake, nowMs, policy) ? \"stopped-beating\" : \"live\";", "return \"live\";", "F11 宽限期过后真停滞照常检出 stopped-beating", "F11 宽限期过后真停滞正常检出"],
  ["R38 检不出时钟跳变", "const jumped = lastTickMs !== null && (nowMs - lastTickMs > c.p.jumpMs || nowMs < lastTickMs);", "const jumped = false;", "F11 时钟跳变 +10 分钟:awakeSince 宽限期内不判 stopped-beating", "⑥"],
  ["R39 正常采样也当跳变", "const jumped = lastTickMs !== null && (nowMs - lastTickMs > c.p.jumpMs || nowMs < lastTickMs);", "const jumped = lastTickMs !== null;", "F11 没有休眠时心跳超时即 stopped-beating:宽限门不是总开关", "F11"],
  ["R40 时钟回拨不算跳变", "const jumped = lastTickMs !== null && (nowMs - lastTickMs > c.p.jumpMs || nowMs < lastTickMs);", "const jumped = lastTickMs !== null && nowMs - lastTickMs > c.p.jumpMs;", "F11 时钟回拨也按跳变处理;宽限参数可配", "F11"],
  ["R41 进程没了仍判 live", 'if (!pidAlive) return "pid-dead";', "", "存活判定:进程没了是 pid-dead,启动编号对不上是 pid-reused(与宽限门无关)", "F11 证据驱动存活判定"],
  ["R42 不核对启动编号", 'if (!bootMatches) return "pid-reused";', "", "存活判定:进程没了是 pid-dead,启动编号对不上是 pid-reused(与宽限门无关)", "F11"],
  // —— 失败卡(A27-05)
  ["R43 无 CAS 领取锁", 'if (k.status !== "open") return bad("not-open", `卡片已是 ${String(k.status)}`);', "", "A27-05 CAS 领取:连点[重试]第二次被拒(卡片已领走)", "⑦ Callback 无 CAS 领取锁"],
  ["R44 自动恢复与手点都能领", 'if (k.status !== "open") return bad("not-open", `卡片已是 ${String(k.status)}`);', 'if (k.status !== "open" && by.kind === "auto") return bad("not-open", `卡片已是 ${String(k.status)}`);', "A27-05 手点[重试]与后台自动恢复竞争:只成功一次", "⑦"],
  ["R45 不核对代次", "if (q.v.attemptSeq !== k.attemptSeq) return bad(\"stale-attempt\",", "if (false) return bad(\"stale-attempt\",", "A27-05 过期 attempt_seq 的迟到点击一律丢弃", "⑦ 过期 attempt_seq"],
  ["R46 未授权点击放行", 'if (by.kind === "user" && by.id !== k.ownerUserId) return bad("forbidden", "只有卡片主人能处理");', "", "A27-05 未授权点击拒绝", "⑦ 未授权点击"],
  ["R47 重试时静默带上模型", '} else if (target !== null) return bad("model-not-explicit", "只有「换模型重试」能换模型");', "}", "严禁静默换模:只有显式[换模型重试]能带目标模型且须在可选清单里;自动恢复不能换模也不能跳过", "严禁静默换模"],
  ["R48 换模不查可选清单", 'if (!(k.allowedModels as string[]).includes(target)) return bad("model-not-allowed", `模型 ${target} 不在可选清单里`);', "", "严禁静默换模:只有显式[换模型重试]能带目标模型且须在可选清单里;自动恢复不能换模也不能跳过", "严禁静默换模"],
  ["R49 自动恢复能换模能跳过", 'if (by.kind === "auto" && action !== "retry") return bad("auto-not-allowed", "自动恢复只能重试本轮");', "", "严禁静默换模:只有显式[换模型重试]能带目标模型且须在可选清单里;自动恢复不能换模也不能跳过", "严禁静默换模"],
  ["R50 跳过推过失败批次末尾", "out[room] = Math.max(cur, seq);", "out[room] = Math.max(cur, seq + 1);", "A27-05 [跳过本轮]只把游标推到 failed_batch_end_seq,失败期间新到的 m_new 不被吞掉", "④ 跳过吞掉 m_new"],
  ["R51 跳过回退已处理位置", "out[room] = Math.max(cur, seq);", "out[room] = seq;", "跳过不回退已经更靠后的处理位置,各会话分开算", "④"],
];

function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, "src", TEST)], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const blocks = new Map([...out.matchAll(/^# Subtest: (.+)\n([\s\S]*?)(?=^# Subtest: |^1\.\.|$(?![\s\S]))/gm)].map((m) => [m[1], m[2]]));
      resolve({ code, failed, passed, blocks });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac36-policy-mut-"));
const copy = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.cpSync(SRC, path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  return dir;
};
let success = true;
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
try {
  const base = await run(copy("baseline"));
  const baseOk = base.code === 0 && base.failed.length === 0 && base.passed.length > 0;
  log(`${baseOk ? "PASS" : "FAIL"} 原样对照 ${base.passed.length} 通过 / ${base.failed.length} 失败`);
  if (!baseOk) success = false;
  const unknown = [...new Set(M.map((m) => m[3]))].filter((n) => !base.passed.includes(n));
  log(`${unknown.length ? "FAIL" : "PASS"} 指定测试都在原样对照里通过; 不存在=${JSON.stringify(unknown)}`);
  if (unknown.length) success = false;
  const jobs = Math.min(2, Math.max(1, Number(process.argv[2] ?? 1) || 1));
  let next = 0;
  const results = new Array(M.length);
  const worker = async () => {
    while (next < M.length) {
      const i = next++;
      const [name, from, to, expected, bad] = M[i];
      const dir = copy(`m${i}`);
      const file = path.join(dir, "src", TARGET);
      const orig = fs.readFileSync(file, "utf8");
      if (orig.split(from).length !== 2) { results[i] = `FAIL ${name}: 注入点不是唯一一处`; continue; }
      fs.writeFileSync(file, orig.replace(from, to));
      const r = await run(dir);
      const block = r.blocks.get(expected) ?? "";
      const killed = r.code !== 0 && r.failed.includes(expected) && block.includes("ERR_ASSERTION") && !r.failed.some((n) => n.endsWith(".test.ts"));
      const others = r.failed.filter((n) => n !== expected);
      results[i] = killed
        ? `KILLED ${name}(坏实现 ${bad}): 「${expected}」断言失败; 同时失败=${JSON.stringify(others)}`
        : `SURVIVED ${name}(坏实现 ${bad}): exit=${r.code} 失败=${JSON.stringify(r.failed)}`;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  for (const r of results) {
    log(r);
    if (!r.startsWith("KILLED")) success = false;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
log(success ? `PASS ${M.length}/${M.length} 变异被指定具名测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
