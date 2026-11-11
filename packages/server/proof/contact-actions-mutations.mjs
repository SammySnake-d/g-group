// 联系人动作补齐(feat/contact-actions)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑相关测试文件;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算:单条测试 failureType 为 testTimeoutFailure 的单列,不计入杀死),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(adapter-pi-contact)测的才是注入后的代码。
// 用法: node packages/server/proof/contact-actions-mutations.mjs     只核对注入点: MUT_CHECK=1 node …
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/contact-actions.test.ts",
  "packages/adapter-pi-contact/src/claim-tool.test.ts",
  "packages/adapter-pi-contact/src/mind.test.ts",
  "packages/server/src/group-claim.test.ts",
  "packages/server/src/delivery-plain.test.ts",
  "packages/server/src/manual-task.test.ts",
];
const C = "packages/server/src/contact-actions.ts";
const H = "packages/server/src/host.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  // —— 认领已有任务(U14、§8.4 US1)
  ["C01 去掉 CAS 的比较:认领不比对 T1_Open 且无负责人", [[C, '  if (t.state !== "T1_Open" || t.owner !== null) return', "  if (false) return"]]],
  ["C02 认领不查会话归属:不在这个会话的联系人也能认领", [[C, "  if (!rooms.has(t.roomId)) return `任务 ${taskId} 不在你所在的会话里`;\n", ""]]],
  ["C03 认领后不起 Compute(丢掉认领路径的派发副作用)", [[H, "            effects.push(...claimed);\n", "            void claimed;\n"]]],
  ["C04 第 5 块不列可认领的任务", [[H, "      pointers: [...rejectionPointers(shownRejections), ...claimable, ...pointers, ...mem.pointers],", "      pointers: [...rejectionPointers(shownRejections), ...pointers, ...mem.pointers],"]]],
  ["C05 可认领清单不按会话过滤(列出别的会话的任务)", [[C, '    .filter((t) => roomIds.has(t.roomId) && t.state === "T1_Open" && t.owner === null)', '    .filter((t) => t.state === "T1_Open" && t.owner === null)']]],
  ["C06 可认领清单含已有人负责的任务", [[C, '    .filter((t) => roomIds.has(t.roomId) && t.state === "T1_Open" && t.owner === null)', "    .filter((t) => roomIds.has(t.roomId))"]]],
  ["C07 工具层不登记 claim_task", [[T, '    case "claim_task": return act({ kind: "claim", taskId: s("taskId") });', '    case "claim_task": return { ok: false, why: "未登记" };']]],
  // —— 被拒动作回告(AC-31 状态一致;AC-39 ①)
  ["R01 拒绝不回告:宿主不记下本轮的拒绝", [[H, "      this.rejections.recordTx(contactId, roundId, rejected, this.now());\n", ""]]],
  ["R02 回告不进第 5 块(记下了但装配不带)", [[H, "      pointers: [...rejectionPointers(shownRejections), ...claimable, ...pointers, ...mem.pointers],", "      pointers: [...claimable, ...pointers, ...mem.pointers],"]]],
  ["R03 回告只给动作、不给被拒原因", [[C, "text: `${n.action} → 被拒:${n.reason}`", "text: `${n.action} → 被拒`"]]],
  ["R04 回告给过不标记(每轮重复)", [[H, "      if (out.rejectionsShown?.length) this.rejections.markShownTx(contactId, out.rejectionsShown, roundId);\n", ""]]],
  [
    "R05 装配时就算给过(轮次被放弃后不再给)",
    [[H, "    const shownRejections = this.rejections.pending(contactId);\n", '    const shownRejections = this.rejections.pending(contactId);\n    tx(this.db, () => this.rejections.markShownTx(contactId, shownRejections.map((r) => r.actionId), "assembled"));\n']],
  ],
  ["R06 回告写进第 1 块(破坏前缀)", [[H, "      persona: identityOf(contactId, contact),", '      persona: [identityOf(contactId, contact), ...rejectionPointers(shownRejections).map((p) => p.text)].join("\\n"),']]],
  // —— reply 带 @(缺口 7)
  ["A01 mentions 不校验成员", [[C, "  const bad = [...new Set(ids)].filter((id) => !here.has(id));", "  const bad: string[] = [];"]]],
  ["A02 mentions 不写进消息", [[H, "...(a.mentions?.length ? { mentions: toMentions(a.mentions) } : {})", "...{}"]]],
  ["A03 写进消息的 mentions 不去重", [[C, '  return [...new Set(ids)].map((id) => ({ id, source: "manual" as const }));', '  return [...ids].map((id) => ({ id, source: "manual" as const }));']]],
  ["A04 工具层丢掉 mentions", [[T, "...(at !== null ? { mentions: Object.freeze([...new Set(at)]) } : {})", "...{}"]]],
  // —— 一次纠错只升一版(AC-15/AC-45)
  ["V01 升版两次:forward 不查本轮已升版", [[H, "            if (a.sourceSeq !== undefined && rework.has(a.taskId, t.roomId, a.sourceSeq)) {", "            if (false) {"]]],
  ["V02 升版两次:verdict(revise) 不查本轮已升版", [[H, '            if (a.verdict === "revise" && rework.has(a.taskId, d.roomId, a.sourceSeq)) {', "            if (false) {"]]],
  ["V03 verdict(revise) 升版后不登记", [[H, '            if (a.verdict === "revise") rework.mark(a.taskId, d.roomId, src.seq);\n', ""]]],
  ["V04 forward 升版后不登记", [[H, "              rework.mark(a.taskId, t.roomId, a.sourceSeq);\n", ""]]],
  ["V05 后到的原文不并进续接(丢掉 forward 原文)", [[C, "      effects[i] = { ...e, text: `${e.text}\\n\\n${text}` };", "      effects[i] = { ...e };"]]],
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
      // 按 TAP 块切开:超时失败(failureType testTimeoutFailure)单列,不算按名字失败
      const blocks = out.split(/^(?=(?:not )?ok \d+ - )/m);
      const failed = [];
      const timeouts = [];
      const passed = [];
      for (const b of blocks) {
        const h = /^(not ok|ok) \d+ - (.+)$/m.exec(b);
        if (!h) continue;
        if (h[1] === "ok") passed.push(h[2]);
        else if (/failureType: 'testTimeoutFailure'/.test(b)) timeouts.push(h[2]);
        else failed.push(h[2]);
      }
      resolve({ code, failed, passed, timeouts, timedOut });
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contact-actions-mut-"));
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
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.timeouts.length === 0 && clean.passed.length > 0;
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
  const slow = r.timeouts.length ? `;另有 ${r.timeouts.length} 条超时(不算杀死):${r.timeouts.map((k) => `「${k}」`).join("")}` : "";
  if (!r.timedOut && kills.length > 0) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}${slow}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}${slow}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
