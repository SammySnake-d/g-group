// 联系人自设定时与常驻承诺(feat/standing-commitments)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑相关测试文件;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(adapter、kernel)测的才是注入后的代码。
// 用法: node packages/server/proof/standing-commitments-mutations.mjs     只核对注入点: MUT_CHECK=1 node …
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/standing-commitments.test.ts",
  "packages/adapter-pi-contact/src/schedule-tools.test.ts",
  "packages/adapter-pi-contact/src/mind.test.ts",
  "packages/server/src/schedules.test.ts",
  "packages/server/src/schedule-views.test.ts",
];
const S = "packages/server/src/standing-commitments.ts";
const SC = "packages/server/src/schedules.ts";
const H = "packages/server/src/host.ts";
const SV = "packages/server/src/service.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const MI = "packages/adapter-pi-contact/src/mind.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  // —— 只能管自己在本会话的(brief 推荐方案)
  ["P01 去掉本会话限制:别的会话里自己的定时也能动", [[S, '    if (room !== roomId) return "这条定时不在本会话,只能管本会话里的";\n', ""]]],
  ["P02 去掉归属核对:别的联系人的定时也能动", [[S, '    if (owner !== contactId) return "不是你的定时";\n', ""]]],
  // —— AC-20:外部 / 转发内容不能让联系人改定时
  ["P03 去掉来源核对:别的联系人、Helper 的话也当用户要求", [[S, "    if (src.sender.kind !== \"user\" || src.sender.id !== this.d.userId) return no(", "    if (false) return no("]]],
  ["P04 不剥引用块:只有转发/引用内容的消息也当用户本人的话", [[S, "    .filter((l) => !/^\\s*[>＞]/.test(l))\n", "    .filter(() => true)\n"]]],
  ["P05 条件触发占位不拦", [[S, '      if (t.kind === "condition") return no("条件触发还没开放(只占位),现在只受理 cron 定时和每 N 条消息");\n', ""]]],
  // —— 时区一律显式
  ["P06 没给时区写死成 Asia/Shanghai,不按用户设置", [[S, "        tz = t.tz ?? this.d.timezone();", '        tz = t.tz ?? "Asia/Shanghai";']]],
  ["P07 工具层丢掉 tz", [[T, '{ kind: "cron" as const, cron: c, tz: sn("tz") }', '{ kind: "cron" as const, cron: c, tz: null }']]],
  ["P08 工具层不查 cron / everyN 二选一", [[T, '    if ((v.cron === null || v.cron === undefined) === (v.everyN === null || v.everyN === undefined)) problems.push("cron 与 everyN 必须且只能给一个");\n    else if', "    if"]]],
  ["P09 schedule_list 不走宿主查询口", [[MI, "          const got = tools?.listSchedules ? await tools.listSchedules(r.value.roomId) : null;", "          const got = null as string | null;"]]],
  ["P10 宿主不给 listSchedules 查询口内容", [[H, "        listSchedules: async (roomId: string) => this.standing.listText(contactId, roomId),", "        listSchedules: async (_roomId: string) => null,"]]],
  // —— 控制指令生效(AC-35①)
  ["P11 停掉不生效", [[S, "        this.d.scheduler.patchTx(o.id, { enabled: false });\n", ""]]],
  ["P12 带 scheduleId 再设不重新启用(恢复不了)", [[S, ', title: text.slice(0, 40), enabled: true });', ", title: text.slice(0, 40) });"]]],
  ["P13 第 5 块不列联系人自己的定时(改不了已有的)", [[H, "      pointers: [...pointers, ...mem.pointers, ...this.standing.pointers(contactId, rooms.map((r) => r.id))],", "      pointers: [...pointers, ...mem.pointers],"]]],
  // —— 常驻承诺:与定时互相引用,一起停
  ["P14 新设定时不登记常驻承诺", [[H, "            if (r.propose) proposals.set(key, [...(proposals.get(key) ?? []), r.propose]);\n", ""]]],
  ["P15 承诺视图不回填 scheduleId", [[H, "scheduleId: this.scheduler.byCommitment(c.id), updatedAt", "scheduleId: null, updatedAt"]]],
  ["P16 承诺了结不停定时与触发器", [[H, '    for (const c of cmds) if (c.type === "close") this.standing.closedTx(c.commitmentId);\n', ""]]],
  ["P17 承诺了结只停定时、不停每 N 条触发器", [[S, '    run(this.d.db, "UPDATE gg_msg_triggers SET enabled = 0 WHERE commitment_id = ?", commitmentId);\n', ""]]],
  ["P18 联系人删定时不了结承诺", [[H, "            if (r.close) push(a.roomId,", "            if (false) push(a.roomId,"]]],
  ["P19 用户在界面删定时不了结承诺", [[H, "      if (c) this.ledgerTx(s.contact_id, s.room_id, [{ type: \"close\", actionId: `schedule-remove:", "      if (false) this.ledgerTx(s.contact_id, s.room_id, [{ type: \"close\", actionId: `schedule-remove:"]]],
  // —— 每 N 条消息(U80)
  ["P20 计数含 Helper 旁白(不看发言者)", [[S, '    if (sender.kind !== "user" && sender.kind !== "contact") return;\n', ""]]],
  ["P21 计数含宿主生成的卡片", [[S, "    if (f.card) return;\n", ""]]],
  ["P22 满 N 条差一(第 N+1 条才触发)", [[S, "      if (counted < t.every_n) {", "      if (counted <= t.every_n) {"]]],
  // 触发后完全不清零会让「触发 → 联系人发言 → 又触发」无限循环,只表现为超时(不算杀死);这里注入可终止的同类故障:清零写成 1
  ["P23 触发后计数没清到 0(从 1 起算,下一次少数一条就触发)", [[S, '"UPDATE gg_msg_triggers SET counted = 0, since_seq = ? WHERE id = ?"', '"UPDATE gg_msg_triggers SET counted = 1, since_seq = ? WHERE id = ?"']]],
  ["P24 消息入库不计数", [[H, "    this.standing.countTx(roomId, e.seq, sender, { card: !!f.card });\n", ""]]],
  // —— schedules.create 幂等
  ["P25 服务层丢掉 clientActionId(幂等键丢失)", [[SV, "host.scheduler.create(p, { clientActionId })", "host.scheduler.create(p)"]]],
  ["P26 同号换了内容不拒", [[SC, "          if (prior.fingerprint !== fingerprint) throw new HostError(", "          if (false) throw new HostError("]]],
  // —— 运行记录写实
  ["P27 运行记录到点即 ok", [[SC, "\"INSERT INTO gg_schedule_runs (schedule_id, due_at, at, status) VALUES (?, ?, ?, 'running')\"", "\"INSERT INTO gg_schedule_runs (schedule_id, due_at, at, status) VALUES (?, ?, ?, 'ok')\""]]],
  ["P28 跑了没发言也记 ok", [[SC, 'seq === null ? "silent" : "ok"', '"ok"']]],
  ["P29 不回填 messageSeq", [[SC, '      run(this.d.db, "UPDATE gg_schedule_run_inbox SET message_seq = ? WHERE run_id = ?", seq, r.run_id);\n', ""]]],
  ["P30 这一轮失败出卡不记 failed", [[H, "      this.scheduler.failRunsTx(contactId, inboxEnd, cls.label);\n", ""]]],
  ["P31 提交时不结算运行记录", [[H, "      this.scheduler.settleRunsTx(inbox.map((ib) => ib.id),", "      void (inbox.map((ib) => ib.id),"]]],
  // —— 唤醒时对齐最新群规(D02②)
  ["P32 第 1 块只放群规、不放当前有效公告", [[H, "      roomRules: rooms.map((r) => ({ roomId: r.id, title: r.title, ...this.announcements.snapshot(r.id, r.rules, r.rules_version) })),", "      roomRules: rooms.map((r) => ({ roomId: r.id, title: r.title, rules: r.rules, version: r.rules_version })),"]]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
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
const count = (s, sub) => s.split(sub).length - 1;
if (process.env.MUT_CHECK) {
  let bad = 0;
  for (const [name, edits] of M) {
    for (const [file, from] of edits) {
      const k = count(fs.readFileSync(path.join(ROOT, file), "utf8"), from);
      if (k !== 1) {
        bad++;
        console.log(`✗ ${name}:${file} 注入点出现 ${k} 次`);
      }
    }
  }
  console.log(bad ? `注入点有 ${bad} 处不合格` : `注入点 ${M.length} 个全部恰好 1 次`);
  process.exit(bad ? 1 : 0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "standing-mut-"));
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

let ok = true;
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
if (!good) ok = false;
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
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
    fs.writeFileSync(f, src.replace(from, to));
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
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
