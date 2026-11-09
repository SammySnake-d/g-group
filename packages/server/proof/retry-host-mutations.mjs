// AC-36 宿主接线的行为变异校准(R-05 阳性埋雷):按验收文档 AC-36「坏实现」列逐个向宿主(host.ts)与注意循环(attention.ts)注入故障,
// 在隔离副本(整仓复制,node_modules 链接)里只跑对应的测试文件;每个变异都必须让指定的具名测试以断言失败或等不到预期结果的方式失败,
// 文件加载失败不算杀死;每处注入点在源码里必须恰好出现 1 次;原样副本必须全绿(阴性对照)。
// 用法: node packages/server/proof/retry-host-mutations.mjs [并发,默认 1,最多 2]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HOST = "packages/server/src/host.ts";
const ATT = "packages/kernel/src/attention.ts";
const T_HOST = "packages/server/src/retry.test.ts";
const T_ATT = "packages/kernel/src/attention-retry.test.ts";

// [编号与说明, 目标文件, [[注入点, 替换为], ...], 测试文件, 应失败的具名测试, 对应坏实现]
const M = [
  ["H01 首次 502 就出卡(不静默退避)", HOST, [['stallJudged: cls.via === "stall" }, this.retryPolicy, this.random);\n    if (d.kind === "retry") {', 'stallJudged: cls.via === "stall" }, this.retryPolicy, this.random);\n    if (false) {']], T_HOST,
    "F1 首次 502 静默恢复:联系人一轮 502 后退避重试成功,0 张失败卡,回复只发 1 次,自动重试不换模型", "F1 首次 502 静默恢复 0 出卡"],
  ["H02 403 当成可自愈自动重试", HOST, [['    const heal = healOf(cls.reasonClass);\n    if (heal === "user_stopped") {\n      // 用户主动中断', '    const heal0 = healOf(cls.reasonClass);\n    const heal = heal0 === "A2" ? "A1" : heal0;\n    if (heal === "user_stopped") {\n      // 用户主动中断']], T_HOST,
    "F2 403 配额耗尽:0 次自动重试;共用同一 Key 的 3 个联系人全群只出 1 张群级卡,冷却过后也不自动探测;修好后点重试三人都续跑", "③ 403 自动重试"],
  ["H03 N 个联系人各出 1 张卡", HOST, [["if (room && (br.opened || !b.card_id)) {", "if (room) {"]], T_HOST,
    "F10 3 个联系人共用同一上游连续 502:共享熔断暂停后台重试,全群只出 1 张群级卡;半开探测恢复后三人都续跑,自动恢复抢先后点卡被拒", "③ N 联系人各出 1 张卡"],
  ["H04 无共享上游熔断(一律放行)", HOST, [['    if (b.state.status === "closed") return true;\n    const r = breakerAdmit(', '    return true;\n    const r = breakerAdmit(']], T_HOST,
    "F10 3 个联系人共用同一上游连续 502:共享熔断暂停后台重试,全群只出 1 张群级卡;半开探测恢复后三人都续跑,自动恢复抢先后点卡被拒", "③ 无共享上游熔断"],
  ["H05 放行一律当用户发起的探测(对 403 自动重试)", HOST, [["manual: this.manualProbe.has(upstream) }", "manual: true }"]], T_HOST,
    "F2 403 配额耗尽:0 次自动重试;共用同一 Key 的 3 个联系人全群只出 1 张群级卡,冷却过后也不自动探测;修好后点重试三人都续跑", "阳性埋雷① 对 403 开启自动重试"],
  ["H06 [跳过本轮]把游标推到最新", HOST, [["const target = skipTarget(Object.fromEntries(rooms.map((r) => [r.id, this.cursor(contactId, r.id)])), JSON.parse(f.batch_end));", "const target = { ok: true as const, cursors: Object.fromEntries(rooms.map((r) => [r.id, this.lastSeq(r.id)])) };"]], T_HOST,
    "A27-05 [跳过本轮]只跳过失败批次:失败期间新到的 m_new 不被吞掉,下一轮正常处理", "④ 跳过吞掉 m_new"],
  ["H07 失败卡无 CAS 领取锁", HOST, [
    ["\"UPDATE gg_cards SET state = 'claimed' WHERE card_id = ? AND state = 'open'\", input.cardId) !== 1)", "\"UPDATE gg_cards SET state = 'claimed' WHERE card_id = ?\", input.cardId) !== 1)"],
    ['    if (card.state !== "open") throw new HostError("conflict", "这张卡已经处理过了");\n', ""],
    ["    if (!current) {\n      if (run(", "    if (false) {\n      if (run("],
    ["{ status: card.state, ownerUserId: this.userId,", '{ status: "open", ownerUserId: this.userId,'],
  ], T_HOST, "A27-05 [重试本轮]连同失败期间新到的消息一起重跑;再失败出新卡,点旧卡被拒;连点只生效一次", "⑦ Callback 无 CAS 领取锁"],
  ["H08 半途换模不进累积生产集合", HOST, [['if (d.action === "switch-model" && d.targetModel && f.compute_id) this.stepTaskTx(taskId, { kind: "ProducerModelAdded", model: d.targetModel, computeId: f.compute_id });', ""]], T_HOST,
    "F13 半途换模:[换模型重试]选了厂商 B 才换,累积生产集合变成 {A, B},T5 审查同时拒绝 A、B 与 unknown,只放第三家", "⑦ 半途换模只记末次厂商"],
  ["H09 去掉 crash_recovery_count 上限", HOST, [["const max = this.opts.maxCrashRecoveries ?? 1;", "const max = 99;"]], T_HOST,
    "F12 同一毒丸输入让宿主连续退出:第 1 次重启自动续跑,第 2 次熔断 CrashLoopBlocked 出卡;新成功轮次清零计数", "⑥ 去掉 crash_recovery_count 上限"],
  ["H10 成功轮次不清在途标记与计数", HOST, [["contactId) > 0;\n      run(this.db, \"DELETE FROM gg_round_guard WHERE contact_id = ?\", contactId);", "contactId) > 0;"]], T_HOST,
    "F12 同一毒丸输入让宿主连续退出:第 1 次重启自动续跑,第 2 次熔断 CrashLoopBlocked 出卡;新成功轮次清零计数", "F12 新成功轮次重置计数"],
  ["H11 重启不补领磁盘上的待领取输入", HOST, [['    for (const c of this.listContacts()) if (this.hasPendingInput(c.id)) this.loop.notify(c.id, "now");\n', ""]], T_HOST,
    "F6 Compute 终态通知丢失(ack 前宿主退出):重启后从磁盘待领取表补领结果交给联系人,不重跑 Compute,不需要人类再发言", "⑤ 回调丢了不补领"],
  ["H12 重启不重跑未提交轮次", HOST, [['    for (const c of this.listContacts()) if (this.hasPendingInput(c.id)) this.loop.notify(c.id, "now");\n', ""]], T_HOST,
    "F4 执行中途杀宿主再重启:未提交轮次自动重跑,已入库的 action_id 不重复出现;已提交的不再重跑", "F4 reconcileRunning"],
  ["H13 副作用不明也自动重发(B2 当 B1)", HOST, [['const effect = effectOf(progressed ? "B1" : "B0", cls.retryClass);', 'const effect = progressed ? "B1" : "B0";']], T_HOST,
    "F9 副作用不明(unknown 且已有进展,UnknownEffect→B2):0 次自动续跑,出卡写明为免重复没有自动重发", "⑤ B2 自动重发"],
  ["H14 Compute 续跑改成从头 spawn", HOST, [['r = (await this.computeTurn(e, f.model_override ? "switch-retry" : "retry")) ? { ok: true } : { ok: false, reason: "这一轮没能送进 Compute(见进度)" };', 'r = (await this.adapterForCompute(f.compute_id)!.spawn({ task: e.text, rules: [], tools: [], credentialRefs: [], placement: "local" })).ok ? { ok: true } : { ok: false, reason: "spawn" };']], T_HOST,
    "Compute 执行器中途崩溃(可自愈):对同一实例 resume 续跑(同一 CLI 会话),不从头 spawn,任务不进 T11,不打断联系人", "② 从第 1 轮重新 spawn"],
  ["H15 续跑提示不带工作区现状", HOST, [['    if (!cwd || !existsSync(cwd)) return "";\n    // 剥掉 GIT_*', '    return "";\n    // 剥掉 GIT_*']], T_HOST,
    "窗口 ② 对账(A27-03 底座):续跑提示带上工作区 git status,已写入的文件不让模型再追加一遍", "② 窗口 ② 补丁重复追加"],
  ["H16 CLI 与宿主重试叠加", HOST, [["const harnessAttempts = ev.signal === null ? Math.max(0, this.opts.computeHarnessRetries ?? 0) : 0;", "const harnessAttempts = 0;"]], T_HOST,
    "F3 统一重试权:Compute 的 CLI 已按 CLAUDE_CODE_MAX_RETRIES 重试过上游错误,宿主不再叠加续跑,直接出 1 张卡", "F3 5×3 重试风暴"],
  ["H28 被信号结束也当 CLI 重试过(进程被杀不续跑)", HOST, [["const harnessAttempts = ev.signal === null ? Math.max(0, this.opts.computeHarnessRetries ?? 0) : 0;", "const harnessAttempts = Math.max(0, this.opts.computeHarnessRetries ?? 0);"]], T_HOST,
    "F3 被信号结束的执行器崩溃(不是 CLI 里的上游错误)不算 CLI 重试过:宿主照常在同一会话续跑", "F3 只统一 CLI 真重试过的部分"],
  ["H17 停止任务不清在途失败", HOST, [["      this.afterCancelTx(taskId);\n      run(this.db, \"UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status' AND state = 'open'\", taskId);", "      run(this.db, \"UPDATE gg_cards SET state = 'done' WHERE task_id = ? AND kind = 'task-status' AND state = 'open'\", taskId);"]], T_HOST,
    "F7 用户主动停止不是失败:Compute 失败后等续跑期间用户停掉任务,不再续跑、不出失败卡,任务落 T10 而不是 T11", "F7 用户中断"],
  ["H18 Compute 失败直接判 T11(不在 T11 前拦)", HOST, [['      if (ev.kind === "failed") handled = this.onComputeFailureTx(row, ev);\n', ""]], T_HOST,
    "Compute 执行器中途崩溃(可自愈):对同一实例 resume 续跑(同一 CLI 会话),不从头 spawn,任务不进 T11,不打断联系人", "F1 Compute 瞬态静默续跑"],
  ["H19 [不重试了]不判失败", HOST, [['          this.stepTaskTx(taskId, { kind: "ExecFailed", computeId: f.compute_id });\n', ""]], T_HOST,
    "Compute 永久故障(平台拒绝):0 次自动续跑、原位出卡;[重试]走同一会话 resume,再失败出新卡;[不重试了]才进 T11 并告诉联系人", "放弃路径"],
  ["H20 换模覆盖不清掉(之后的新消息也用备用模型)", HOST, [["hadFailure = run(this.db, \"DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ?\", contactId) > 0;", "hadFailure = run(this.db, \"UPDATE gg_failures SET status = 'retrying' WHERE scope = 'contact' AND subject = ?\", contactId) > 0;"]], T_HOST,
    "[换模型重试]只有用户显式选了才换:这一批用选中的模型重跑,之后的新消息仍用原模型;清单外的模型被拒", "严禁静默换模"],
  ["H21 自动重试悄悄换成备用模型", HOST, [["const model = prior?.model_override ?? contact.speakingModel;", "const model = prior?.model_override ?? (prior ? (this.settings().models.find((m) => m.id !== contact.speakingModel)?.id ?? contact.speakingModel) : contact.speakingModel);"]], T_HOST,
    "F1 连续 502 耗尽自动重试上限:原位只出 1 张人话失败卡,原文折叠在详情,按钮是重试本轮/跳过本轮/换模型重试", "严禁静默换模"],
  ["H27 换模型重试不把选中的模型交给这一轮", HOST, [["const resolved = base && override ? { ...base, model: override } : base;", "const resolved = base;"]], T_HOST,
    "F13 半途换模:[换模型重试]选了厂商 B 才换,累积生产集合变成 {A, B},T5 审查同时拒绝 A、B 与 unknown,只放第三家", "原则 70 重试路径也要交生效模型"],
  ["H22 自动恢复后群级卡不作废", HOST, [["      if (b.card_id) run(this.db, \"UPDATE gg_cards SET state = 'expired' WHERE card_id = ? AND state = 'open'\", b.card_id);\n", ""]], T_HOST,
    "F10 3 个联系人共用同一上游连续 502:共享熔断暂停后台重试,全群只出 1 张群级卡;半开探测恢复后三人都续跑,自动恢复抢先后点卡被拒", "⑦ 与自动恢复竞争"],
  ["H23 恢复后不交回被暂停的成员", HOST, [["if (kind === \"contact\" && run(this.db, \"DELETE FROM gg_failures WHERE scope = 'contact' AND subject = ? AND status = 'paused'\", id)) contacts.push(id);", "if (false) contacts.push(id);"]], T_HOST,
    "F10 半开探测恢复后,被暂停、没有别的消息叫醒的成员也接着处理(两个私聊共用同一上游)", "F10 半开探测恢复后续跑"],
  ["H24 出卡后新消息照样触发自动重跑", HOST, [['    if (prior?.status === "card") return "done";\n', ""]], T_HOST,
    "A27-05 [跳过本轮]只跳过失败批次:失败期间新到的 m_new 不被吞掉,下一轮正常处理", "④/⑦ 出卡后不停在原位"],
  ["H25 失败后照旧按固定间隔无限重试", ATT, [["const ms = delayAfter(id, failure);", "const ms = retryMs;"]], T_ATT,
    "AC-36 一轮抛错后按 retryAfter 给的延迟重跑;返回 null 不再自动重跑,新的 now 通知照样能触发", "注意循环无限重试"],
  ["H26 策略说不再重跑仍按 retryMs 重跑", ATT, [["      if (ms === null) return null;", "      if (ms === null) return retryMs;"]], T_ATT,
    "AC-36 一轮抛错后按 retryAfter 给的延迟重跑;返回 null 不再自动重跑,新的 now 通知照样能触发", "注意循环无限重试"],
];

function run(dir, testFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", testFile], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } }, 300000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const blocks = new Map([...out.matchAll(/^# Subtest: (.+)\n([\s\S]*?)(?=^# Subtest: |^1\.\.|$(?![\s\S]))/gm)].map((m) => [m[1], m[2]]));
      resolve({ code, failed, passed, blocks });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac36-host-mut-"));
const SKIP = new Set(["node_modules", ".git"]);
const copy = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  for (const e of fs.readdirSync(ROOT)) {
    if (SKIP.has(e)) continue;
    fs.cpSync(path.join(ROOT, e), path.join(dir, e), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  }
  // 依赖目录链接:外部包指向原仓库,@g-group/* 指向副本自己的 packages
  fs.mkdirSync(path.join(dir, "node_modules"));
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group") continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(dir, "node_modules", e));
  }
  fs.mkdirSync(path.join(dir, "node_modules", "@g-group"));
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules", "@g-group"))) fs.symlinkSync(path.join(dir, "packages", e), path.join(dir, "node_modules", "@g-group", e));
  return dir;
};
let success = true;
try {
  for (const t of [T_HOST, T_ATT]) {
    const base = await run(copy(`baseline-${path.basename(t)}`), t);
    const ok = base.code === 0 && base.failed.length === 0 && base.passed.length > 0;
    console.log(`${ok ? "PASS" : "FAIL"} 原样对照 ${t}: ${base.passed.length} 通过 / ${base.failed.length} 失败`);
    if (!ok) success = false;
    const missing = [...new Set(M.filter((m) => m[3] === t).map((m) => m[4]))].filter((n) => !base.passed.includes(n));
    console.log(`${missing.length ? "FAIL" : "PASS"} 指定测试都在原样对照里通过 ${t}; 不存在=${JSON.stringify(missing)}`);
    if (missing.length) success = false;
  }
  const jobs = Math.min(2, Math.max(1, Number(process.argv[2] ?? 1) || 1));
  let next = 0;
  const results = new Array(M.length);
  const worker = async () => {
    while (next < M.length) {
      const i = next++;
      const [name, target, edits, testFile, expected, bad] = M[i];
      const dir = copy(`m${i}`);
      const file = path.join(dir, target);
      let code = fs.readFileSync(file, "utf8");
      let unique = true;
      for (const [from, to] of edits) {
        if (code.split(from).length !== 2) unique = false;
        else code = code.replace(from, () => to);
      }
      if (!unique) { results[i] = `FAIL ${name}: 注入点不是唯一一处`; fs.rmSync(dir, { recursive: true, force: true }); continue; }
      fs.writeFileSync(file, code);
      const r = await run(dir, testFile);
      const block = r.blocks.get(expected) ?? "";
      const asserted = block.includes("ERR_ASSERTION") || block.includes("等不到");
      const killed = r.code !== 0 && r.failed.includes(expected) && asserted && !r.failed.some((n) => n.endsWith(".test.ts"));
      const others = r.failed.filter((n) => n !== expected);
      results[i] = killed
        ? `KILLED ${name}(坏实现 ${bad}): 「${expected}」失败; 同时失败=${JSON.stringify(others)}`
        : `SURVIVED ${name}(坏实现 ${bad}): exit=${r.code} 失败=${JSON.stringify(r.failed)}`;
      console.log(results[i]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  for (const r of results) if (!r.startsWith("KILLED")) success = false;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(success ? `PASS ${M.length}/${M.length} 变异被指定具名测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
