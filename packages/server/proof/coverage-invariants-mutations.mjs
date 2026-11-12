// Q02 单点错误行为对照；仅在独占临时副本注入。具名 ERR_ASSERTION 才算杀死。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const TEST = "packages/server/src/coverage-invariants.test.ts";
const HOST = "packages/server/src/host.ts";
const titles = [...fs.readFileSync(path.join(ROOT, TEST), "utf8").matchAll(/^test\("([^"]+)"/gm)].map(m => m[1]);
const M = [
  ["M01 身份前缀丢失", 0, 'return [`你是「${c.name}」(联系人 id ${contactId})。消息里的 @ 列的是联系人 id。`, c.persona].filter((x) => x.trim()).join("\\n");', 'return "错误身份红对照";'],
  ["M02 公开记忆查询丢失", 0, 'return this.memory.list(contactId);', 'return [];'],
  ["M03 普通群消息不送联系人", 1, 'this.loop.notify(mem.id, urgency);', 'if (direct) this.loop.notify(mem.id, urgency);'],
  ["M04 普通群消息错误直送在途Compute", 1, 'const room = this.roomRow(roomId);\n    const repliedTo = view.replyToSeq', `const room = this.roomRow(roomId);
    if (from.kind === "user" && room.kind === "group") {
      for (const r of all<{ compute_id: string }>(this.db, "SELECT compute_id FROM gg_compute WHERE room_id = ?", roomId)) {
        const a = this.adapterForCompute(r.compute_id);
        if (a) void a.resume(r.compute_id, view.text);
      }
    }
    const repliedTo = view.replyToSeq`],
  ["M05 进度查询忽略limit", 2, 'taskId,\n      limit,\n    ).map((p) => ({ computeId:', 'taskId,\n      200,\n    ).map((p) => ({ computeId:'],
  ["M06 进度输出逆序", 2, 'ORDER BY id DESC LIMIT ?) ORDER BY id",', 'ORDER BY id DESC LIMIT ?) ORDER BY id DESC",'],
  ["M07 原问题回答被静默忽略", 3, 'answerTask(taskId: string, qId: string, clientActionId: string, answer: string): TaskView {', 'answerTask(taskId: string, qId: string, clientActionId: string, answer: string): TaskView { return this.taskView(this.taskDoc(taskId).value, this.taskDoc(taskId).ver);'],
  ["M08 普通插话使当前卡过期", 3, 'const room = this.roomRow(roomId);\n    const repliedTo = view.replyToSeq', `const room = this.roomRow(roomId);
    if (from.kind === "user" && room.kind === "group") run(this.db, "UPDATE gg_cards SET state = 'expired' WHERE room_id = ? AND state = 'open'", roomId);
    const repliedTo = view.replyToSeq`],
];
const OUT = path.resolve(process.env.MUT_OUT ?? process.argv[2] ?? path.join(os.tmpdir(), `q02-invariants-evidence-${Date.now()}`));
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q02-invariants-mut-"));
const sha = s => createHash("sha256").update(s).digest("hex");
const original = fs.readFileSync(path.join(ROOT, HOST));
const report = { node: process.version, test: TEST, testSha256: sha(fs.readFileSync(path.join(ROOT, TEST))), hostSha256: sha(original), total: M.length, mutations: [], killed: 0, survived: 0 };
const save = () => fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(report, null, 2) + "\n");
const parse = out => {
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
  const passed = [...out.matchAll(/^ok \d+ - (.+)$/gm)].map(m => m[1]);
  const assertionFailed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].filter(m => {
    const start = m.index;
    const ends = [out.indexOf("\n# Subtest:", start), out.indexOf("\n1..", start), out.length].filter(n => n >= start);
    return /\bERR_ASSERTION\b/.test(out.slice(start, Math.min(...ends)));
  }).map(m => m[1]);
  return { failed, passed, assertionFailed };
};
const run = (dir, tests = [TEST]) => new Promise(resolve => {
  const cmd = ["--test", "--test-concurrency=1", "--test-timeout=120000", "--test-force-exit", "--test-reporter=tap", ...tests];
  const p = spawn(process.execPath, cmd, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let timedOut = false;
  p.stdout.on("data", d => { output += d; }); p.stderr.on("data", d => { output += d; });
  const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* 已退出 */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, 150000);
  p.on("close", code => { clearTimeout(timer); kill(); resolve({ code, timedOut, ...parse(output), output }); });
});
const writeRun = (name, r) => { fs.writeFileSync(path.join(OUT, `${name}.tap`), r.output); const { output, ...rest } = r; return { ...rest, logSha256: sha(output) }; };
const copy = name => {
  const d = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: s => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  const mods = path.join(d, "node_modules"); fs.mkdirSync(path.join(mods, "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (e === "@g-group" || e.startsWith(".")) continue;
    fs.symlinkSync(fs.realpathSync(path.join(ROOT, "node_modules", e)), path.join(mods, e));
  }
  for (const e of fs.readdirSync(path.join(d, "packages"))) {
    if (fs.existsSync(path.join(d, "packages", e, "package.json"))) {
      const link = path.join(mods, "@g-group", e); fs.symlinkSync(path.join(d, "packages", e), link);
      if (fs.realpathSync(link) !== fs.realpathSync(path.join(d, "packages", e))) throw new Error(`workspace link escaped copy: ${e}`);
    }
  }
  return d;
};
try {
  const cal = path.join(tmp, "parser"); fs.mkdirSync(cal);
  fs.writeFileSync(path.join(cal, "calibration.test.mjs"), `import assert from "node:assert/strict";import {test} from "node:test";test("parser-assertion",()=>assert.equal(1,2));test("parser-runtime",()=>{throw new TypeError("not assertion")});test("parser-timeout",{timeout:20},async()=>await new Promise(r=>setTimeout(r,1000)));`);
  fs.writeFileSync(path.join(cal, "load.test.mjs"), 'import "./intentionally-missing.mjs";');
  const c = await run(cal, ["calibration.test.mjs"]); const l = await run(cal, ["load.test.mjs"]);
  report.parserCalibration = { mixed: writeRun("parser-calibration", c), load: writeRun("parser-load", l), passed: c.code === 1 && c.failed.length === 3 && JSON.stringify(c.assertionFailed) === JSON.stringify(["parser-assertion"]) && l.code === 1 && l.assertionFailed.length === 0 };
  save(); if (!report.parserCalibration.passed) throw new Error("assertion/runtime/timeout/load parser calibration failed");
  const clean = await run(copy("clean")); report.baseline = writeRun("baseline", clean); save();
  if (clean.timedOut || clean.code !== 0 || clean.failed.length !== 0 || clean.passed.length !== 4) throw new Error("unchanged copy is not 4/4 green");
  for (const [name, index, from, to] of M) {
    const d = copy(name.slice(0, 3)); const f = path.join(d, HOST); const s = fs.readFileSync(f, "utf8");
    const expected = titles[index]; const count = s.split(from).length - 1;
    if (count !== 1) { report.mutations.push({ name, expected, detected: false, injectionCount: count }); report.survived++; save(); continue; }
    fs.writeFileSync(f, s.replace(from, to)); const r = await run(d);
    const detected = !r.timedOut && r.code === 1 && r.assertionFailed.includes(expected);
    report.mutations.push({ name, expected, injectionCount: count, detected, ...writeRun(name.slice(0, 3), r) });
    if (detected) report.killed++; else report.survived++;
    fs.rmSync(d, { recursive: true, force: true }); save(); console.log(`${detected ? "KILLED" : "SURVIVED"} ${name} expected=${expected}`);
  }
} catch (e) { report.error = String(e); }
finally {
  report.sourceUnchanged = original.equals(fs.readFileSync(path.join(ROOT, HOST)));
  report.complete = !report.error && report.sourceUnchanged && report.killed === 8 && report.survived === 0;
  save(); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify({ out: OUT, killed: report.killed, survived: report.survived, complete: report.complete, error: report.error }));
process.exit(report.complete ? 0 : 1);
