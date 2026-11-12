// P7 单点变异，真实隔离插件；每次副本串行运行。必须有具名断言失败，加载错误/超时不是杀死。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/server/src/slash-commands.test.ts"];
const S = "packages/server/src/slash-commands.ts";
const P = "packages/server/src/plugins.ts";
const K = "packages/server/plugins/ketchup/index.mjs";
const M = [
 ["M01 命令当用户消息", [[S, "if (!command || BUILTIN.has(command.name)) return this.host.send(input);", "if (command || !command) return this.host.send(input);"]]],
 ["M02 摘要起点忽略已读", [[S, 'from === undefined ? host.readSeq(roomId, { kind: "user", id: host.userId }) : from', 'from === undefined ? 0 : from']]],
 ["M03 不过滤摘要自己", [[S, '!commandSeqs.has(m.seq) && !m.retracted && !m.rewound', '!m.retracted && !m.rewound']]],
 ["M04 隐藏原文进入快照", [[S, 'messages: unread.slice(-200).map(m =>', 'messages: host.projected(roomId).map(m =>']]],
 ["M05 同action不比参数", [[S, 'if (prior.fingerprint !== fingerprint)', 'if (false && prior.fingerprint !== fingerprint)']]],
 ["M06 停用命令当用户消息", [[S, 'if (!known.enabled) throw new HostError("conflict", `插件 ${known.pluginId} 已停用`);', 'if (!known.enabled) return this.host.send(input);']]],
 ["M07 无权限也给快照", [[S, 'known.canRead ? commandSnapshot(this.host, input.roomId, command.args.from) : null', 'commandSnapshot(this.host, input.roomId, command.args.from)']]],
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
// 每个单点故障预先绑定一条业务断言，不能用其他红或文件加载失败顶替。
const titles = [...fs.readFileSync(path.join(ROOT, TESTS[0]), "utf8").matchAll(/^test\("([^"]+)"/gm)].map(m => m[1]);
const expectedIndex = [0, 3, 2, 11, 6, 8, 9, 7, 7, 13, 13, 2, 4, 5, 9, 15, 10, 6];
if (titles.length !== 16 || expectedIndex.length !== M.length) throw new Error("变异计划与16项固定验收不匹配");
const outDir = process.env.MUT_OUT;
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const evidence = { node: process.version, tests: TESTS, baseline: null, mutations: [] };
const save = () => { if (outDir) fs.writeFileSync(path.join(outDir, "mutations.json"), JSON.stringify(evidence, null, 2) + "\n"); };
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ code, failed, passed, timedOut, output: out });
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
console.log(`node ${process.version},变异 ${M.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length === 16;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.join(";")})` : ""}`);
evidence.baseline = { ...clean, output: undefined };
if (outDir) fs.writeFileSync(path.join(outDir, "baseline.tap"), clean.output);
save();
if (!good) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error("原样对照不是16/16，停止评变异"); }
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
    evidence.mutations.push({ name, expected: titles[expectedIndex[i]], detected: false, injection_error: bad }); save();
    console.log(`✗ ${tag} ${name}:${bad},必须恰好 1 次`);
    fs.rmSync(d, { recursive: true, force: true });
    continue;
  }
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const expected = titles[expectedIndex[i]];
  const kills = r.failed.filter((t) => named.has(t));
  const detected = !r.timedOut && r.code === 1 && kills.includes(expected);
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
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
