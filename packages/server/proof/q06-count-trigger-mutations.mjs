// Q06-1 按消息数触发的联系人承诺(U80,D21.3 第 14 项)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑相关测试文件;
// 每个变异点名一条必须发现它的具名测试——这条没按名字失败就算存活(别的测试红了不算);每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入测的才是注入后的代码。
// 用法: node packages/server/proof/q06-count-trigger-mutations.mjs   (MUT_ONLY=R01,T03 只跑点名的几个;MUT_DRY=1 只核对注入点)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TAG = "q06-ct-mut";
const TESTS = ["packages/server/src/count-triggers.test.ts", "packages/adapter-pi-contact/src/commit-every-n.test.ts"];
const R = "packages/server/src/chat-range.ts";
const C = "packages/server/src/count-triggers.ts";
const H = "packages/server/src/host.ts";
const P = "packages/adapter-pi-contact/src/tools.ts";
/** [名字, [[文件, 原文, 改成]...], 必须发现它的那条测试(标题开头)] */
const M = [
  ["R01 system 通知也计数", [[R, "    if (m.retracted || m.sender.kind === \"system\") continue;\n", "    if (m.retracted) continue;\n"]], "不算群聊发言的不计数"],
  ["R02 撤回的消息也计数", [[R, "    if (m.retracted || m.sender.kind === \"system\") continue;\n", "    if (m.sender.kind === \"system\") continue;\n"]], "不算群聊发言的不计数"],
  ["R03 任务事实卡也计数", [[R, "    if (TASK_EVENT_CARDS.has(cards.get(m.seq) ?? \"\")) continue;\n", ""]], "不算群聊发言的不计数"],
  ["R04 提出人本端删除的也计数", [[R, "    if (q.hidden?.(m.seq)) continue;\n", ""]], "不算群聊发言的不计数"],
  ["R05 rewind 撤下的消息也计数", [[R, "    if (inRanges(rewound, m.seq) || notices.has(m.seq)) continue;\n", "    if (notices.has(m.seq)) continue;\n"]], "私聊 rewind 撤下的消息"],
  ["R06 回退说明那条也计数", [[R, "    if (inRanges(rewound, m.seq) || notices.has(m.seq)) continue;\n", "    if (inRanges(rewound, m.seq)) continue;\n"]], "私聊 rewind 撤下的消息"],
  ["R07 左端不排除(coveredSeq 那条重复计入下一段)", [[R, "    if (m.seq <= q.afterSeq) continue;\n", "    if (m.seq < q.afterSeq) continue;\n"]], "一段正好 N 条"],
  ["T01 攒到 N+1 条才冻结", [[C, "    while (lines.length >= t.everyN) {", "    while (lines.length > t.everyN) {"]], "没人开就没有触发"],
  ["T02 窗口终点取第 N+1 条(一段多吃一条)", [[C, "      const to = lines[t.everyN - 1]!.seq;", "      const to = (lines[t.everyN] ?? lines[t.everyN - 1]!).seq;"]], "消息已落盘但没来得及计数"],
  ["T03 一次只冻结一段(攒了两个 N 也只冻一段)", [[C, "    while (lines.length >= t.everyN) {", "    if (lines.length >= t.everyN) {"]], "消息已落盘但没来得及计数"],
  ["T04 冻结后不推进 coveredSeq", [[C, "    if (covered !== t.coveredSeq) {\n      run(this.d.db, \"UPDATE gg_count_triggers SET covered_seq = ?, updated_at = ? WHERE id = ? AND covered_seq = ?\", covered, this.d.now(), t.id, t.coveredSeq);", "    if (covered !== t.coveredSeq) {"]], "没人开就没有触发"],
  ["T05 数的时候不看该不该关(移出、解散、承诺了结后照数)", [[C, "    const why = this.d.closedWhy(t);\n    if (why !== null) {", "    const why = null;\n    if (why !== null) {"]], "联系人移出群、群解散后触发关闭"],
  ["T06 关闭时不取消没处理的窗口", [[C, "    run(this.d.db, \"UPDATE gg_count_windows SET status = 'cancelled', settled_at = ? WHERE trigger_id = ? AND status = 'pending'\", this.d.now(), t.id);\n", ""]], "触发关闭时没处理的窗口一并取消"],
  ["T07 关闭时连已结算的窗口也改成取消", [[C, "SET status = 'cancelled', settled_at = ? WHERE trigger_id = ? AND status = 'pending'\", this.d.now(), t.id);", "SET status = 'cancelled', settled_at = ? WHERE trigger_id = ?\", this.d.now(), t.id);"]], "触发关闭时没处理的窗口一并取消"],
  ["T08 已关闭的触发还能再关一次(原因被改写)", [[C, "WHERE id = ? AND status = 'active'\", reason, this.d.now(), t.id) !== 1) return;", "WHERE id = ?\", reason, this.d.now(), t.id) !== 1) return;"]], "触发关闭时没处理的窗口一并取消"],
  ["T09 同一窗口在一次运行里反复交给消费方", [[C, "      if (this.announced.has(key)) continue;\n", ""]], "没处理的窗口每次宿主运行只交给消费方一次"],
  ["T10 已结算的窗口重启后还交给消费方", [[C, "WHERE w.status = 'pending' AND t.status = 'active' ORDER BY", "WHERE t.status = 'active' ORDER BY"]], "没处理的窗口每次宿主运行只交给消费方一次"],
  ["T11 结算不看窗口是不是还在等(重复结算、已取消的也认)", [[C, "WHERE trigger_id = ? AND to_seq = ? AND status = 'pending'\", status,", "WHERE trigger_id = ? AND to_seq = ?\", status,"]], "没处理的窗口每次宿主运行只交给消费方一次"],
  ["T12 已关闭的触发还在数(onAppend 不筛状态)", [[C, "\"SELECT * FROM gg_count_triggers WHERE room_id = ? AND status = 'active' ORDER BY created_at, id\", roomId)", "\"SELECT * FROM gg_count_triggers WHERE room_id = ? ORDER BY created_at, id\", roomId)"], [C, "    const why = this.d.closedWhy(t);\n    if (why !== null) {", "    const why = t.status === \"closed\" ? null : this.d.closedWhy(t);\n    if (why !== null) {"]], "撤销承诺后不再触发"],
  ["T13 N 允许 0", [[C, "n < EVERY_N_MIN || n > EVERY_N_MAX) return", "n < 0 || n > EVERY_N_MAX) return"]], "N 不合格整条拒收"],
  ["T14 N 不设上限", [[C, "n < EVERY_N_MIN || n > EVERY_N_MAX) return", "n < EVERY_N_MIN) return"]], "N 不合格整条拒收"],
  ["T15 N 允许小数", [[C, "!Number.isSafeInteger(n) || n < EVERY_N_MIN", "n < EVERY_N_MIN"]], "N 不合格整条拒收"],
  ["T16 视图:不再数了还报攒了几条", [[C, "count: active ? this.pendingLines(t).length : 0, active, windows", "count: this.pendingLines(t).length, active, windows"]], "联系人移出群、群解散后触发关闭"],
  ["T17 视图:只看触发自己的状态,不看承诺和成员(刚移出还显示在数)", [[C, "const active = t.status === \"active\" && this.d.closedWhy(t) === null;", "const active = t.status === \"active\";"]], "联系人移出群、群解散后触发关闭"],
  ["T18 视图:已冻结段数恒为 0", [[C, "\"SELECT count(*) AS n FROM gg_count_windows WHERE trigger_id = ?\", t.id)?.n ?? 0;", "\"SELECT count(*) AS n FROM gg_count_windows WHERE trigger_id = ? AND 0\", t.id)?.n ?? 0;"]], "没人开就没有触发"],
  ["T19 状态变了不通知(冻结后不推承诺事件)", [[C, "      this.dirty.delete(c);\n      this.d.changed(c);", "      this.dirty.delete(c);"]], "一段正好 N 条"],
  ["T20 启动时不补数", [[C, "\"SELECT * FROM gg_count_triggers WHERE status = 'active' ORDER BY created_at, id\")) this.evaluateTx(toTrigger(r));", "\"SELECT * FROM gg_count_triggers WHERE status = 'active' AND 0 ORDER BY created_at, id\")) this.evaluateTx(toTrigger(r));"]], "消息已落盘但没来得及计数"],
  ["H01 宿主写消息时不计数", [[H, "    this.countTriggers.onAppendTx(roomId);\n", ""]], "没人开就没有触发"],
  ["H02 宿主发完消息不交窗口、不推事件", [[H, "    this.countTriggers.announce();\n    const msgs = this.projected(roomId);", "    const msgs = this.projected(roomId);"]], "没人开就没有触发"],
  ["H03 登记时从会话开头数(coveredSeq 取 0)", [[H, "coveredSeq: lastEventSeq(this.db, p.roomId) });", "coveredSeq: 0 });"]], "没人开就没有触发"],
  ["H04 不是用户提出的也不拒收", [[H, "?? (src.sender.kind === \"user\" ? null : \"按消息数触发的承诺要由用户提出\");", "?? null;"]], "不是用户提出的不算"],
  ["H05 N 不合格不拒收,记成普通承诺", [[H, "              if (badN) { reject(badN); break; }\n", ""]], "N 不合格整条拒收"],
  ["H06 带 N 的承诺不登记触发(原文出自用户消息)", [[H, "            if (everyN !== undefined) countPlans.push({ commitmentId, roomId: a.roomId, everyN, requesterId: src.sender.id, sourceSeq: a.sourceSeq });\n", ""]], "没人开就没有触发"],
  ["H07 带 N 的承诺不登记触发(原文出自自己的回复)", [[H, "        if (oc.trigger) countPlans.push({ commitmentId: ownId, roomId: oc.roomId, ...oc.trigger });\n", ""]], "承诺原文出自联系人自己的回复"],
  ["H08 撤销承诺时不关触发", [[H, "        this.countTriggers.closeTx(commitmentId, \"承诺已撤销\");\n", ""]], "撤销承诺后不再触发"],
  ["H09 承诺视图不带触发信息", [[H, "...(trigger ? { trigger } : {}) });", "});"]], "没人开就没有触发"],
  ["H10 该不该数:不看承诺状态", [[H, "    if (c?.status !== \"active\") return \"承诺已了结或撤销\";\n", ""]], "私聊 rewind 把提出承诺的那句撤下"],
  ["H11 该不该数:不看联系人还在不在群里", [[H, "if (!this.isMember(roomId, { kind: \"contact\", id: contactId }) || this.exits.isLeaving(roomId, contactId)) return \"联系人已不在这个会话\";", "if (this.exits.isLeaving(roomId, contactId)) return \"联系人已不在这个会话\";"]], "联系人移出群、群解散后触发关闭"],
  ["H12 该不该数:不看联系人是不是正在移出", [[H, "if (!this.isMember(roomId, { kind: \"contact\", id: contactId }) || this.exits.isLeaving(roomId, contactId)) return \"联系人已不在这个会话\";", "if (!this.isMember(roomId, { kind: \"contact\", id: contactId })) return \"联系人已不在这个会话\";"]], "正在移出的联系人"],
  ["H13 该不该数:不看群是不是解散了", [[H, "    if (this.chatAdmin.isClosed(roomId)) return \"会话已解散\";\n    return null;\n  }\n  /** 推一条承诺的当前视图", "    return null;\n  }\n  /** 推一条承诺的当前视图"]], "联系人移出群、群解散后触发关闭"],
  ["H14 计数不按提出人本端的删除过滤(宿主不给隐藏判定)", [[H, "      hidden: (roomId, viewerId) => this.chatAdmin.hidden(roomId, viewerId),\n      changed: (commitmentId) => this.emitCommitment(commitmentId),", "      hidden: () => () => false,\n      changed: (commitmentId) => this.emitCommitment(commitmentId),"]], "不算群聊发言的不计数"],
  ["H15 启动时不补数", [[H, "    tx(this.db, () => this.countTriggers.reconcileTx());\n", ""]], "消息已落盘但没来得及计数"],
  ["H16 启动时不把没处理的窗口交出去", [[H, "    tx(this.db, () => this.countTriggers.reconcileTx());\n    this.countTriggers.announce();\n", "    tx(this.db, () => this.countTriggers.reconcileTx());\n"]], "消息已落盘但没来得及计数"],
  ["P01 commit 工具丢掉 everyNMessages", [[P, "...(every !== null ? { everyNMessages: every } : {}) });", "});"]], "发给模型的 commit 工具声明里"],
  ["P02 commit 工具没填 N 也带上字段(null)", [[P, "...(every !== null ? { everyNMessages: every } : {}) });", "everyNMessages: every } as never);"]], "commit 工具的 everyNMessages 省略或给 null"],
  ["P03 工具声明里没有 everyNMessages", [[P, "      everyNMessages: f(\"seqOrNull\", false,", "      everyNMessagesX: f(\"seqOrNull\", false,"]], "发给模型的 commit 工具声明里"],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const ONLY = process.env.MUT_ONLY ? new Set(process.env.MUT_ONLY.split(",")) : null;
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
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
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${TAG}-`));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
/** 副本:整份 packages/(不含 proof)+ node_modules(第三方链到原树,@g-group/* 链到副本自己的包) */
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  fs.mkdirSync(path.join(d, "node_modules", "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e === ".bin" || e.startsWith(".")) continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(d, "node_modules", e));
  }
  for (const p of pkgs) fs.symlinkSync(path.join("..", "..", "packages", p), path.join(d, "node_modules", "@g-group", p));
  return d;
};
const count = (s, sub) => s.split(sub).length - 1;

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
// MUT_DRY=1:只核对每处注入点在原文里恰好出现 1 次,不跑测试
if (process.env.MUT_DRY) {
  for (const [name, edits] of M) {
    const seen = new Map();
    for (const [file, from, to] of edits) {
      const src = seen.get(file) ?? fs.readFileSync(path.join(ROOT, file), "utf8");
      const n = count(src, from);
      if (n !== 1) {
        ok = false;
        console.log(`✗ ${name}:${file} 注入点出现 ${n} 次`);
      }
      seen.set(file, src.replace(from, () => to));
    }
  }
  console.log(ok ? `注入点核对通过(${M.length} 个变异)` : "注入点核对失败");
  process.exit(ok ? 0 : 1);
}
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits, expect]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  if (ONLY && !ONLY.has(name.split(" ")[0])) continue;
  const d = copy(`m${i}`);
  let bad = null;
  for (const [file, from, to] of edits) {
    const f = path.join(d, file);
    const src = fs.readFileSync(f, "utf8");
    const n = count(src, from);
    if (n !== 1) {
      bad = `${file} 注入点出现 ${n} 次`;
      break;
    }
    fs.writeFileSync(f, src.replace(from, () => to));
  }
  if (bad) {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  // 每个变异点名一条必须发现它的测试(标题开头);这条没红,别的红了也算存活
  const hit = kills.some((k) => k.startsWith(expect));
  if (!r.timedOut && hit) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(指定的「${expect}」没红${kills.length ? `;红的是:${kills.map((k) => `「${k}」`).join("")}` : ""})`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${killed + survived}${killed + survived === M.length ? "" : `(清单共 ${M.length},这次只跑点名的)`}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
