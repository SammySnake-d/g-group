// 片 CA2(feat/contact-call-check)的行为变异校准(R-05 阳性埋雷):逐个注入单一故障,在隔离副本里跑相关测试文件;
// 每个变异都必须让至少一条原样副本里通过的具名测试失败(文件级加载失败、超时不算:单条测试 failureType 为
// testTimeoutFailure 的单列,不计入杀死),每处注入点必须恰好出现 1 次;原样副本必须全绿(阴性对照)。并发 1。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包——跨包注入(kernel / adapter-pi-contact)测的才是注入后的代码。
// 用法: node packages/server/proof/contact-call-check-mutations.mjs     只核对注入点: MUT_CHECK=1 node …
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/server/src/contact-call-check.test.ts",
  "packages/adapter-pi-contact/src/check-action.test.ts",
  "packages/adapter-pi-contact/src/claim-tool.test.ts",
  "packages/server/src/contact-actions.test.ts",
  "packages/adapter-pi-contact/src/mind.test.ts",
];
const C = "packages/server/src/contact-actions.ts";
const H = "packages/server/src/host.ts";
const T = "packages/adapter-pi-contact/src/tools.ts";
const M_ = "packages/adapter-pi-contact/src/mind.ts";
/** [名字, [[文件, 原文, 改成]...]] */
const M = [
  // —— @everyone 展开(US1 §8.4、U14)
  ["E01 展开含发送者自己(不排除 senderId)", [[C, '  return [...named, ...members.filter((m) => m.kind !== "helper" && m.id !== senderId).map((m) => m.id)];', "  return [...named, ...members.map((m) => m.id)];"]]],
  ["E02 展开含 Helper(不按 kind 排除)", [[C, '  return [...named, ...members.filter((m) => m.kind !== "helper" && m.id !== senderId).map((m) => m.id)];', "  return [...named, ...members.filter((m) => m.id !== senderId).map((m) => m.id)];"]]],
  ["E03 不开 @everyone 也展开全体", [[C, "  if (!everyone) return [...named];", "  if (false) return [...named];"]]],
  ["E04 展开的 mentions 与逐个 @ 合并后不去重(同一人列两次)", [[C, "  return [...new Set(ids)].map((id) => ({ id, source: \"manual\" as const }));", "  return [...ids].map((id) => ({ id, source: \"manual\" as const }));"]]],
  ["E05 reply 不把 everyone 展开进消息(只写逐个点名的)", [[H, "            const atIds = replyMentionIds(a.mentions, a.everyone === true, this.members(a.roomId), contactId);", "            const atIds = replyMentionIds(a.mentions, false, this.members(a.roomId), contactId);"]]],
  ["E06 工具层丢掉 everyone(reply 动作不带这个字段)", [[T, "...(all ? { everyone: true } : {}),", "...{},"]]],
  ["E07 工具层缺省就当 @everyone", [[T, "      const all = v.everyone === true;", "      const all = v.everyone !== false;"]]],
  ["E08 工具声明里没有 everyone 字段(改名成 everyoneOff)", [[T, "everyone: f(", "everyoneOff: f("]]],
  // —— 当场校验(AC-31 状态一致)
  ["C01 当场校验不拦:校验口永远说 ok", [[H, "        checkAction: (a: MindAction) => this.precheck(contactId, a, freshMsgs),", "        checkAction: () => ({ ok: true }) as const,"]]],
  ["C02 宿主不给当场校验口(pi 只能等轮末)", [[H, "        checkAction: (a: MindAction) => this.precheck(contactId, a, freshMsgs),\n", ""]]],
  ["C03 pi 侧不调当场校验口(登记完再说)", [[M_, "        const verdict = tools?.checkAction ? await tools.checkAction(r.value.action) : null;", "        const verdict = null;"]]],
  ["C04 当场被拒的动作照样登记", [[M_, "        if (verdict && !verdict.ok) {", "        if (false) {"]]],
  ["C05 当场被拒的动作不进本轮拒绝清单(轮末无从拦)", [[M_, "          refusals.push({ action: r.value.action, reason: verdict.reason });\n", ""]]],
  ["C06 本轮拒绝清单不上报宿主机", [[M_, "    return Object.freeze({ actions: Object.freeze([...actions]), stateNote, ...(refusals.length > 0 ? { inRoundRefusals: Object.freeze([...refusals]) } : {}) });", "    return Object.freeze({ actions: Object.freeze([...actions]), stateNote });"]]],
  ["V01 当场校验不查会话可见性(越权会话也放行)", [[H, '        if (!roomIds.has(a.roomId)) return no("不在这个会话里");\n', ""]]],
  ["V02 当场校验不查认领冲突(已有人负责也放行)", [[H, "        const why = claimRefusal(a.taskId, cur ? { id: cur.task.id, roomId: cur.roomId, sourceSeq: cur.sourceSeq, title: cur.title, state: cur.task.state, owner: cur.task.owner } : undefined, roomIds, leaving);\n        return why !== null ? no(why) : { ok: true };", "        void cur;\n        return { ok: true };"]]],
  ["V03 当场校验不查 seq 是不是本轮输入", [[H, "        return inFresh(a.roomId, a.sourceSeq) ? { ok: true } : no(`来源 ${a.roomId} #${a.sourceSeq} 不是本轮新消息`);", "        return { ok: true };"]]],
  ["V04 当场校验不查任务归属(别人的任务也放行)", [[H, '      return !doc || doc.task.owner !== contactId ? { why: "不是你的任务" } : { doc };', '      return !doc ? { why: "不是你的任务" } : { doc };']]],
  ["V05 当场校验不查 mentions 是不是成员", [[H, "        const atWhy = a.mentions?.length ? mentionRefusal(a.roomId, a.mentions, this.members(a.roomId)) : null;\n        return atWhy ? no(atWhy) : { ok: true };", "        return { ok: true };"]]],
  ["B01 轮末兜底删掉:reply 不查会话可见性", [[H, '            if (!roomIds.has(a.roomId)) { reject("不在这个会话里"); break; }\n            if (!a.text.trim()) { reject("空消息"); break; }', '            if (!a.text.trim()) { reject("空消息"); break; }']]],
  // —— 未落实声明(说了没做成的事)
  ["U01 未落实声明的判据永远不命中", [[C, '  if (action.kind !== "reply") return null;', "  return null;"]]],
  ["U02 轮末不拦宣称已完成的 reply(照常发出)", [[H, "            const over = unfulfilledClaim(a, out.inRoundRefusals ?? []);\n            if (over) { reject(`这一轮里对 ${over.token} 的动作被当场拒了(${over.reason});这句话宣称它已完成,没有发出`); break; }\n", ""]]],
  ["U03 未落实声明不看正文里有没有那个对象(任何 reply 都算)", [[C, '    for (const token of actionTokens(r.action)) if (token !== "" && action.text.includes(token)) return { token, reason: r.reason };', '    for (const token of actionTokens(r.action)) if (token !== "") return { token, reason: r.reason };']]],
  ["U04 被拒动作不认对象 id(认不出该拦哪句)", [[C, '      return [action.taskId];', "      return [];"]]],
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "contact-call-check-mut-"));
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
