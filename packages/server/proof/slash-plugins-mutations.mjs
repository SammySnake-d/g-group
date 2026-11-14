// P7 单点变异，真实隔离插件；每次副本串行运行。必须有具名断言失败，加载错误/超时不是杀死。
// 第 2 轮返修（PR85 R1-01…R1-05）：清单只增不改——旧 18 项（M）的注入点、替换与绑定的测试序号一字不动；
// 追加的 20 项（M2）各绑定第二个测试文件里的一条具名测试；两份测试文件一起跑，原样副本要全绿。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/server/src/slash-commands.test.ts", "packages/server/src/slash-commands-boundaries.test.ts"];
const S = "packages/server/src/slash-commands.ts";
const P = "packages/server/src/plugins.ts";
const K = "packages/server/plugins/ketchup/index.mjs";
const H = "packages/server/src/host.ts";
const R = "packages/server/src/plugin-runtime.ts";
const M = [
 ["M01 命令当用户消息", [[S, "if (!command || BUILTIN.has(command.name)) return this.host.send(input);", "if (command || !command) return this.host.send(input);"]]],
 ["M02 摘要起点忽略已读", [[S, 'from === undefined ? host.readSeq(roomId, { kind: "user", id: host.userId }) : from', 'from === undefined ? 0 : from']]],
 ["M03 不过滤摘要自己", [[S, '!commandSeqs.has(m.seq) && !m.retracted && !m.rewound', '!m.retracted && !m.rewound']]],
 ["M04 隐藏原文进入快照", [[S, 'messages: unread.slice(-200).map(m =>', 'messages: host.projected(roomId).map(m =>']]],
 ["M05 同action不比参数", [[S, 'if (prior.fingerprint !== fingerprint)', 'if (false && prior.fingerprint !== fingerprint)']]],
 ["M06 停用命令当用户消息", [[S, 'if (!known.enabled) throw new HostError("conflict", `插件 ${known.pluginId} 已停用`);', 'if (!known.enabled) return this.host.send(input);']]],
 ["M07 无权限也给快照", [[S, 'known.canRead ? commandSnapshot(this.host, input.roomId, args.from) : null', 'commandSnapshot(this.host, input.roomId, args.from)']]],
 ["M08 内置冲突不校验", [[S, 'BUILTIN.has(c.name) || seen.has(c.name)', 'seen.has(c.name)']]],
 ["M09 插件之间命令可重名", [[S, 'existing.some(e => e.name === c.name && e.pluginId !== pluginId)', 'false']]],
 ["M10 不保留停用名称", [[P, 'commands(includeDisabled = false): SlashCommand[] {', 'commands(includeDisabled = false): SlashCommand[] { includeDisabled = false;']]],
 ["M11 更新不校验命令", [[P, 'assertCommandNames(e.manifest.commands ?? [], this.commands(true), id);', 'void id;']]],
 ["M12 摘要丢来源", [[K, 'groups.get(key).lines.push(`#${m.seq} ${firstLine(m.text)}`);', 'groups.get(key).lines.push(firstLine(m.text));']]],
 ["M13 摘要不列交付", [[S, 't.deliveredSeq !== null && (t.state === "T8a_Delivered" || t.state === "T5_InReview")', 'false']]],
 ["M14 摘要不列授权", [[S, 'm.card?.kind === "question" && m.card.state === "open"', 'false']]],
 ["M15 越界起点静默接受", [[S, 'fromSeq > host.lastSeq(roomId)', 'false']]],
 ["M16 截断没有标记", [[S, 'truncated: unread.length > 200', 'truncated: false']]],
 ["M17 失败action被盲目再执行", [[S, 'throw new HostError("unavailable", prior.error ?? "上次命令执行中断,结果未确认;请检查后用新的 action 明确重试");', 'return this.execute(this.host.plugins.commandOwner(command.name)!.pluginId, input, null);']]],
 ["M18 重放又调插件", [[S, 'return this.publish(input, prior.result_text);', 'return this.execute(this.host.plugins.commandOwner(command.name)!.pluginId,input,null);']]],
];
// 第 2 轮追加：R 开头对应 R1-01…R1-04 的修复，S 开头沿用审查方自构故障的编号（S03、S05–S12、S14）。
const T2 = (s) => `P7 返修 ${s}`;
const M2 = [
 ["R01 不分有没有命令入口一律接管", [[P, 'if (!m.kinds.includes("ui-extension") || !m.entry) return null;', ""]], T2("R1-01 市场插件没有命令入口:/rss 与 /push 照原样作为带 command 的用户消息发给联系人,不拉起插件进程")],
 ["R02a 执行前不核成员与解散只读", [[S, "this.host.assertCanPost(input.roomId);", ""]], T2("R1-02 插件命令和普通发送同一道前置校验:不在会话里或群已解散时不执行插件、不落账本、不写消息")],
 ["R02b 发布时不核解散只读", [[H, "userAction: true }", "userAction: false }"]], T2("R1-02 插件执行期间群被解散或用户被移出:结果不发布,账本记失败")],
 ["R02c 发布时不核成员", [[H, "const room = this.userRoom(input.roomId);\n    const sender", "const room = this.roomRow(input.roomId);\n    const sender"]], T2("R1-02 插件执行期间群被解散或用户被移出:结果不发布,账本记失败")],
 ["R02d 不结算草稿", [[H, "if (input.draftVer !== undefined) settled = this.settleDraftTx(room.id, { roomId: room.id, submittedVer: input.draftVer, submitted: input.submitted });", ""]], T2("R1-02 插件命令的草稿与话题:成功只结算提交的那一版草稿且结果留在发起的话题,失败不动草稿")],
 ["R02e 结果落到主流", [[H, "threadRootSeq: input.threadRootSeq, ", "threadRootSeq: null, "]], T2("R1-02 插件命令的草稿与话题:成功只结算提交的那一版草稿且结果留在发起的话题,失败不动草稿")],
 ["R03a 以宿主身份写入", [[H, "const sender = { kind: \"system\" as const, id: `${PLUGIN_SENDER_PREFIX}${input.pluginId}` };", "const sender = SYSTEM_SENDER;"]], T2("R1-03 插件输出带可机读来源,零权限插件的输出不以宿主身份出现在联系人输入里")],
 ["R03b 联系人输入里插件仍叫宿主", [[H, "if (s.kind === \"system\" && s.id.startsWith(PLUGIN_SENDER_PREFIX)) return `插件 ${s.id.slice(PLUGIN_SENDER_PREFIX.length)}`;", ""]], T2("R1-03 插件输出带可机读来源,零权限插件的输出不以宿主身份出现在联系人输入里")],
 ["R03c 不记可机读来源", [[H, "run(this.db, \"INSERT INTO gg_msg_plugin (room_id, seq, plugin_id, command, client_action_id) VALUES (?, ?, ?, ?, ?)\", room.id, appended.seq, input.pluginId, input.command, input.clientActionId);", ""]], T2("R1-03 插件输出带可机读来源,零权限插件的输出不以宿主身份出现在联系人输入里")],
 ["R04 边界时刻只在可见消息里找", [[S, "fromSeq === 0 ? null : one<{ at: string }>(host.db, \"SELECT at FROM events WHERE session = ? AND seq = ?\", `room:${roomId}`, fromSeq)?.at ?? null", "visible.find(m => m.seq === fromSeq)?.at ?? null"]], T2("R1-04 读完上一条摘要后没有新动静,再发 /ketchup 是空态")],
 ["S03 快照带上所有会话的任务", [[S, "host.listTasks({ roomId }).map(", "host.listTasks({}).map("]], T2("S03 快照只含本会话的任务:同一联系人在别群的任务不进入插件")],
 ["S05 空结果与超长结果不拒", [[R, "if (text.length === 0 || text.length > 100_000) throw", "if (false) throw"]], T2("S05 插件结果为空或超过十万字时拒绝且不落消息,恰好十万字照常发布")],
 ["S06 结果到手后插件停用仍发布旧结果", [[P, "if (!current.enabled || current.version !== r.version || current.dir !== r.dir) throw", "if (false) throw"]], T2("S06 插件结果到手后插件被停用,不发布旧结果")],
 ["S07 提问一律标成授权", [[S, 'm.card!.actions.some(a => a.actionId === "approve") ? "authorization" : "question"', '"authorization"']], T2("S07 S14 待办:普通提问标为等你回答,已读之前就挂着的提问仍列出")],
 ["S08 摘要不报失败与取消", [[K, 'if ((!s.boundaryAt || t.updatedAt > s.boundaryAt) && (t.state === "T11_Failed" || t.state === "T10_Cancelled"))', "if (false)"]], T2("R1-04 已读停在本端删掉的消息上:只列已读之后才失败的任务,已读之前失败的不再列")],
 ["S09 已生成未发布的结果不重放", [[S, 'if ((prior.status === "done" || prior.status === "rendered") && prior.result_text !== null)', 'if (prior.status === "done" && prior.result_text !== null)']], T2("S09 已生成未发布的结果:宿主重启后同 action 重放直接发布存下的正文,不再调用插件")],
 ["S10 负数起点放行", [[S, "fromSeq < 0 || ", ""]], T2("S10 负数起点被拒:不执行插件、不落账本、不写消息")],
 ["S11 同一清单内重名命令放行", [[S, "BUILTIN.has(c.name) || seen.has(c.name) ||", "BUILTIN.has(c.name) ||"]], T2("S11 同一清单里命令重名时拒绝安装,名字仍可被别的插件使用")],
 ["S12 撤回的消息计入快照", [[S, "!commandSeqs.has(m.seq) && !m.retracted && !m.rewound", "!commandSeqs.has(m.seq) && !m.rewound"]], T2("S12 撤回的消息不计入新消息条数,也不进快照消息")],
 ["S14 待办只在未读范围里找", [[S, 'const pending = visible.filter(m => m.card?.kind === "question"', 'const pending = unread.filter(m => m.card?.kind === "question"']], T2("S07 S14 待办:普通提问标为等你回答,已读之前就挂着的提问仍列出")],
];
// 每个单点故障预先绑定一条业务断言，不能用其他红或文件加载失败顶替。
const titles = [...fs.readFileSync(path.join(ROOT, TESTS[0]), "utf8").matchAll(/^test\("([^"]+)"/gm)].map(m => m[1]);
const expectedIndex = [0, 3, 2, 11, 6, 8, 9, 7, 7, 13, 13, 2, 4, 5, 9, 15, 10, 6];
if (titles.length !== 16 || expectedIndex.length !== M.length) throw new Error("变异计划与16项固定验收不匹配");
const titles2 = [...fs.readFileSync(path.join(ROOT, TESTS[1]), "utf8").matchAll(/^test\("([^"]+)"/gm)].map(m => m[1]);
if (titles2.length !== 15 || M2.length !== 20 || M2.some(([, , t]) => !titles2.includes(t))) throw new Error("追加变异与第二个测试文件的15项具名测试不匹配");
const PLAN = [...M.map(([name, edits], i) => [name, edits, titles[expectedIndex[i]]]), ...M2];
const outDir = process.env.MUT_OUT;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const evidence = { node: process.version, tests: TESTS, appendOnly: { original: M.length, appended: M2.length }, baseline: null, mutations: [] };
const save = () => { if (outDir) fs.writeFileSync(path.join(outDir, "mutations.json"), JSON.stringify(evidence, null, 2) + "\n"); };
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir, tests = TESTS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...tests], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => { out += d; });
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
      const assertionFailed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].filter(m => {
        const start=m.index; const next=out.indexOf("\n# Subtest:",start); const plan=out.indexOf("\n1..",start);
        const end=Math.min(...[next,plan,out.length].filter(n=>n>=start));
        return /\bERR_ASSERTION\b/.test(out.slice(start,end));
      }).map(m=>m[1]);
      resolve({ code, failed, passed, assertionFailed, timedOut, output: out });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-admin-mut-"));
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
console.log(`node ${process.version},变异 ${PLAN.length} 个(原 ${M.length} + 追加 ${M2.length}),测试文件 ${TESTS.length} 个`);
const cal = path.join(tmp, "parser-calibration"); fs.mkdirSync(cal);
fs.writeFileSync(path.join(cal, "calibration.test.mjs"), `import assert from "node:assert/strict";import {test} from "node:test";test("parser-assertion",()=>assert.equal(1,2));test("parser-runtime",()=>{throw new TypeError("not an assertion")});test("parser-timeout",{timeout:20},async()=>await new Promise(r=>setTimeout(r,1000)));`);
fs.writeFileSync(path.join(cal, "load-error.test.mjs"), 'import "./intentionally-missing.mjs";');
const calibration = await run(cal, ["calibration.test.mjs"]);
const loadError = await run(cal, ["load-error.test.mjs"]);
const parserGood = calibration.code === 1 && JSON.stringify(calibration.assertionFailed) === JSON.stringify(["parser-assertion"]) && calibration.failed.length === 3 && loadError.code === 1 && loadError.assertionFailed.length === 0;
evidence.parserCalibration = { passed: parserGood, mixed: { ...calibration, output: undefined }, loadError: { ...loadError, output: undefined } };
if (outDir) { fs.writeFileSync(path.join(outDir, "parser-calibration.tap"), calibration.output); fs.writeFileSync(path.join(outDir, "parser-load-error.tap"), loadError.output); } save();
if (!parserGood) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error("TAP解析器未区分真实断言/运行异常/超时/加载失败"); }
console.log("✓ TAP解析器阳阴性:真实ERR_ASSERTION识别，TypeError/超时/加载错误均不算杀死");
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length === titles.length + titles2.length;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
evidence.baseline = { ...clean, output: undefined };
if (outDir) fs.writeFileSync(path.join(outDir, "baseline.tap"), clean.output);
save();
if (!good) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`原样对照不是${titles.length + titles2.length}/${titles.length + titles2.length}，停止评变异`); }
const named = new Set(clean.passed);
let killed = 0;
let survived = 0;
for (const [i, [name, edits, expected]] of PLAN.entries()) {
  const tag = `[${i + 1}/${PLAN.length}]`;
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
    evidence.mutations.push({ name, expected, detected: false, injection_error: bad }); save();
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  const detected = !r.timedOut && r.code === 1 && kills.includes(expected) && r.assertionFailed.includes(expected);
  evidence.mutations.push({ name, expected, detected, ...r, output: undefined });
  if (outDir) fs.writeFileSync(path.join(outDir, `M${String(i + 1).padStart(2, "0")}.tap`), r.output);
  save();
  if (detected) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被发现:${kills.map((k) => `「${k}」`).join("")}`);
  } else {
    ok = false;
    survived++;
    console.log(`✗ ${tag} ${name}:${r.timedOut ? "超时" : `${r.passed.length} 绿 / ${r.failed.length} 红,存活(或只有文件级失败)`}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
evidence.killed = killed; evidence.survived = survived; save();
console.log(`合计 ${PLAN.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
