// 行为变异校准(R-05 阳性埋雷):对 followups.ts / authorization.ts / routing.ts 逐个注入单一故障,在隔离副本里只跑这三份测试,
// 每个变异都必须让至少一条具名测试失败;原样副本必须全绿(阴性对照)。AI 前缀对应 AC-15/16/45,AZ 对应 AC-17/19/20,AR 对应 AC-18。
// 用法: node packages/domain/proof/auth-intent-mutations.mjs   (并发由环境变量 MUT_JOBS 控制,默认 2)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const TESTS = ["followups.test.ts", "authorization.test.ts", "routing.test.ts"];
const M = [
  ["AI01 送达直接记 Applied(收到当落实)", "followups.ts", 'state: "Received", ver: m.ver, appliedIn: null', 'state: "Applied", ver: m.ver, appliedIn: "delivered"'],
  ["AI02 产物不看版本,把所有 Received 都标落实", "followups.ts", 'l.state === "Received" && l.ver <= artifactVer ?', 'l.state === "Received" ?'],
  ["AI03 空产物引用也能标落实", "followups.ts", '  if (!isText(n.value.artifact)) return fail("产物引用不能为空:Applied 必须指向具体产物");\n', ""],
  ["AI04 不核对 Applied 必须带产物版本", "followups.ts", 'if (l.state === "Applied" && (!isText(l.appliedIn) || !isNat(l.appliedVer)))', "if (false)"],
  ["AI05 登记允许版本倒退", "followups.ts", "if (m.ver < maxVer(fu)) return fail(", "if (false) return fail("],
  ["AI06 改挂时取消源任务(停执行器)", "followups.ts", "const ba = bump(from.task, c.by, c.computeResumable);", 'const ba = (() => { const r = applyTask(from.task, { kind: "Cancel", by: c.by }); return r.ok ? { ok: true as const, task: r.task, effects: r.effects, ver: from.task.constraintVer + 1 } : r; })();'],
  ["AI07 改挂只报新版本、不真推进源任务版本", "followups.ts", "return { ok: true, task: r.task, effects: r.effects, ver: r.task.constraintVer };", "return { ok: true, task: t, effects: [], ver: r.task.constraintVer };"],
  ["AI08 改挂新版本不要求单调递增", "followups.ts", "if (newVer !== null && newVer <= maxVer(fu)) return fail(", "if (false) return fail("],
  ["AI09 重放清单只剩 #m 之前(丢 #n)", "followups.ts", "  const requirements = requirementsOf(links);\n", "  const requirements = requirementsOf(links.slice(0, i));\n"],
  ["AI10 重放清单仍含被移走的 #m", "followups.ts", 'if (j === i) return { ...l, state: "Rebound", appliedIn: null, appliedVer: null, reboundTo: c.toTaskId };', 'if (j === i) return l;'],
  ["AI11 关联版本不比对", "followups.ts", "if (c.expectedBindingVer !== fu.bindingVer) return `关联版本已变", "if (false) return `关联版本已变"],
  ["AI12 重复改挂不幂等(再推进版本)", "followups.ts", '  if (pre === "idempotent") {\n    const same', '  if (pre === "idempotent" && false) {\n    const same'],
  ["AI13 已落实也不等停止就回滚", "followups.ts", "  if (computeId) return done(next({ roomId: m.roomId, beforeSeq: m.seq, ver: newVer, computeId }), [{ kind: \"stop-for-rollback\", taskId: fu.taskId, computeId }]);\n", ""],
  ["AI14 停止确认不认执行器(任何确认都回滚)", "followups.ts", "if (!rb || rb.computeId !== computeId) return done(fu);", "if (!rb) return done(fu);"],
  ["AI15 回滚期间产物也算落实", "followups.ts", '  if (fu.pendingRollback) return fail("等待旧执行器停止并回滚工作区,期间的产物不算落实");\n', ""],
  ["AI16 回滚时 #n 不退回重做", "followups.ts", 'if (wasApplied && j > i && l.state === "Applied" && newVer !== null)', "if (false)"],
  ["AI17 改挂到已结束任务也收", "followups.ts", "  if (NO_VERSION_STATES.has(to.task.state)) return { ok: false, reason: `目标任务", "  if (false) return { ok: false, reason: `目标任务"],
  ["AI18 改条件另开执行器而不是原位升版", "followups.ts", "const b = bump(side.task, c.by, c.computeResumable);", "const b = bump(side.task, c.by, false);"],
  ["AI19 已改挂走的消息能直接挂回", "followups.ts", '    if (l.state === "Rebound") return fail(`${keyOf(m.roomId, m.seq)} 已改挂到', '    if (false) return fail(`${keyOf(m.roomId, m.seq)} 已改挂到'],
  ["AI20 目标任务不重新激活被改挂走的那条", "followups.ts", 'if (i >= 0 && fu.links[i]!.state !== "Rebound") return done(fu);', "if (i >= 0) return done(fu);"],
  ["AZ01 先问时不收写工具", "authorization.ts", "askFirst && !granted ?", "false ?"],
  ["AZ02 写工具清单漏了 Bash", "authorization.ts", '"NotebookEdit", "Bash"]', '"NotebookEdit"]'],
  ["AZ03 群规识别失效", "authorization.ts", "if (line && ASK_BEFORE.some((re) => re.test(line))) return line;", "if (line && false) return line;"],
  ["AZ04 联系人的「同意」也算授权", "authorization.ts", 'if (m.sender.kind !== "user") return freeze', 'if (m.sender.kind === "system") return freeze'],
  ["AZ05 转发也算授权", "authorization.ts", "  if (m.forwarded) return freeze(", "  if (false) return freeze("],
  ["AZ06 外部材料也算授权", "authorization.ts", "  if (m.external) return freeze(", "  if (false) return freeze("],
  ["AZ07 引用块里的旧同意算数", "authorization.ts", '.filter((l) => !/^\\s*[>＞]/.test(l))', ".filter(() => true)"],
  ["AZ08 引号里的话算数", "authorization.ts", '.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’/g, " ")', ""],
  ["AZ09 带条件的同意也放行", "authorization.ts", "  if (HEDGE.test(own.trim())) return \"unclear\";\n", ""],
  ["AZ10 只要有一句同意就放行(混合不追问)", "authorization.ts", "if (cs.every(isApprove)) return \"approve\";", "if (cs.some(isApprove)) return \"approve\";"],
  ["AZ11 否定词不拦(「不要同意」算同意)", "authorization.ts", "(!NEGATOR.test(c) && CONSENT_VERB.test(c))", "CONSENT_VERB.test(c)"],
  ["AZ22 否定 + 同意动词不算拒绝", "authorization.ts", "REJECT_WORDS.has(c) || (NEGATOR.test(c) && CONSENT_VERB.test(c))", "REJECT_WORDS.has(c)"],
  ["AZ12 多个待授权时擅自选第一个", "authorization.ts", "  if (mine.length > 1) return freeze({ kind: \"ambiguous\"", "  if (mine.length > 1) return bind(mine[0]!);\n  if (false) return freeze({ kind: \"ambiguous\""],
  ["AZ13 不要求授权人本人", "authorization.ts", "r.state === \"pending\" && r.principal === m.sender.id && r.askedSeq < m.seq", "r.state === \"pending\" && r.askedSeq < m.seq"],
  ["AZ14 答复早于提问也算", "authorization.ts", "r.principal === m.sender.id && r.askedSeq < m.seq", "r.principal === m.sender.id"],
  ["AZ15 了结时不核对版本", "authorization.ts", "  if (task.constraintVer !== req.constraintVer) return expired(", "  if (false) return expired("],
  ["AZ16 了结时不看任务状态(取消后迟到同意放行)", "authorization.ts", '  if (task.state !== "T4b_BlockedOnHuman") return expired(', "  if (false) return expired("],
  ["AZ17 答复版本不比对", "authorization.ts", "  if (binding.constraintVer !== req.constraintVer) return expired(", "  if (false) return expired("],
  ["AZ18 已了结的请求能被另一条答复改写", "authorization.ts", "return same ? { ok: true, request: req, effective: false } : { ok: false, reason:", "return { ok: true, request: req, effective: !same } as never; void { ok: false, reason:"],
  ["AZ19 授权不分版本", "authorization.ts", 'r.state === "granted" && r.constraintVer === constraintVer', 'r.state === "granted"'],
  ["AZ20 前提变了不过期", "authorization.ts", '    return freeze({ ...r, state: "expired" as const, reason: "前提已变,过期·未执行" });', "    return r;"],
  ["AZ21 授权人不比对", "authorization.ts", "  if (binding.authorizer !== req.principal) return { ok: false", "  if (false) return { ok: false"],
  ["AR01 两件以上在途不追问", "routing.ts", 'if (policy === "ask-when-ambiguous") return Object.freeze({ kind: "ask"', 'if (false) return Object.freeze({ kind: "ask"'],
  ["AR02 追问不计数", "routing.ts", 'if (d.kind === "ask") clarifyAsks++;', ""],
  ["AR03 纠正过的挂错也算未纠正", "routing.ts", "if (!r.corrected) misattachedUncorrected++;", "misattachedUncorrected++;"],
  ["AR04 该挂没挂不算挂错", "routing.ts", '  if (d.kind === "none") return truth !== null;\n', ""],
  ["AR07 问过的也算挂错", "routing.ts", "  return false;\n}\n\nexport function routingReport(", "  return true;\n}\n\nexport function routingReport("],
  ["AR05 阈值不判", "routing.ts", "report.misattachedUncorrected > maxMisattachedUncorrected", "false"],
  ["AR06 引用锚点不优先", "routing.ts", "if (input.anchorTaskId !== null && live.includes(input.anchorTaskId)) return", "if (false) return"],
];

const run = (dir) => new Promise((res) => {
  const p = spawn(process.execPath, ["--test", "--test-reporter=tap", ...TESTS.map((t) => path.join(dir, t))], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("close", () => {
    const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
    res({ pass, failed });
  });
});
const copySrc = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-mut-"));
  fs.cpSync(path.join(PKG, "src"), dir, { recursive: true });
  return dir;
};
const seen = new Set();
for (const [name, file, from, to] of M) {
  const k = JSON.stringify([file, from, to]);
  if (seen.has(k)) throw new Error(`重复变异 ${name}`);
  seen.add(k);
}
const base = copySrc();
const control = await run(base);
fs.rmSync(base, { recursive: true, force: true });
const lines = [`阴性对照(原样副本):${control.pass} 绿 / ${control.failed.length} 红`];
let bad = control.failed.length > 0 || control.pass === 0;
const jobs = Math.max(1, Number(process.env.MUT_JOBS ?? 2));
const results = new Array(M.length);
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < M.length) {
    const i = next++;
    const [name, file, from, to] = M[i];
    const dir = copySrc();
    const f = path.join(dir, file);
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes(from)) { results[i] = `✗ ${name}:注入点不存在`; bad = true; fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, to));
    const r = await run(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.failed.length === 0) { results[i] = `✗ ${name}:存活(${r.pass} 绿)`; bad = true; }
    else results[i] = `✓ ${name}:${r.pass} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`;
  }
}));
lines.push(...results);
const killed = results.filter((x) => x.startsWith("✓")).length;
lines.push(`合计 ${M.length} 个变异:杀死 ${killed},存活/无效 ${M.length - killed}`);
lines.push(bad ? "变异校准未通过" : "变异校准通过");
console.log(lines.join("\n"));
process.exit(bad ? 1 : 0);
