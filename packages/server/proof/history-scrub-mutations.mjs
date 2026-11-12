// G4b 的定点变异校准(T-177 G4b;G6 缺口 k1-g4on-R1 的修法):每个变异只注入一处故障(每个注入点必须恰好出现 1 次),
// 在隔离副本里跑本片两个测试文件 + G4 的相关测试;**指定的具名测试**必须在原样副本里通过、在变异副本里按名失败
// (被 --test-timeout 判掉的不算、文件级加载失败不算);原样副本必须全绿(阴性对照)。并发 1。
// 两个必测的变异:X2「只 scrub 预取/检索这条出口,回读窗口不 scrub」、X3「干脆整条丢掉(而不是只换掉撤回原文)」。
// 副本带整份 packages/,node_modules/@g-group/* 链到副本自己的包(跨包注入内核测的才是注入后的代码);其余依赖(含 acp-kernel)链回原树。
// 用法: node packages/server/proof/history-scrub-mutations.mjs    只跑某几个: MUT_ONLY=X2,X3 node ...
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = [
  "packages/kernel/src/history-scrub.test.ts",
  "packages/server/src/history-scrub.test.ts",
  "packages/kernel/src/history-tools.test.ts",
  "packages/server/src/history-tools.test.ts",
  "packages/server/src/history-prefetch.test.ts",
];
const K = "packages/kernel/src/history-tools.ts";
const S = "packages/server/src/history.ts";
const C = "packages/kernel/src/compact.ts";
// 具名测试(按名字前缀认,前缀须在原样副本里恰好认出 1 条通过的测试)
const KT1 = "已撤回原文的集合:";
const KT2 = "正文里出现已撤回原文:";
const KT3 = "抄写时分不出原样";
const KT4 = "短文本不扫";
const S1 = "预取行不带已撤回原文";
const S2 = "回读窗口不带已撤回原文";
const S3 = "检索结果不带已撤回原文";
const S4 = "抄写时分不出原样(加了空格)时整段正文隐去";
const S5 = "只换抄到撤回原文的那条";

/** [编号, 名字, [[文件, 原文, 改成]...], 必须按名失败的具名测试] */
const M = [
  ["X1", "预取与检索这条出口(verify)不 scrub", [[S, "    return this.scrub(out, retracted);", "    return [...out];"]], [S1, S3]],
  ["X2", "只在预取路径 scrub、漏掉回读路径(移除回读窗口那一遍)", [[S, "    return renderHistoryWindow({ ...w, lines: this.scrub(w.lines, f.retracted) }, this.d.author);", "    return renderHistoryWindow(w, this.d.author);"]], [S2, S4]],
  ["X3", "整条丢掉而不是只换掉撤回原文(命中即把正文清空)", [[K, "  if (r.leaked) return { text: SCRUBBED_BODY, scrubbed: true };\n  return { text: r.text, scrubbed: r.hits > 0 };", '  if (r.hits > 0 || r.leaked) return { text: "", scrubbed: true };\n  return { text: r.text, scrubbed: false };']], [KT2, S5]],
  ["X4", "分不出原样时不隐去(只留替换结果)", [[K, "  if (r.leaked) return { text: SCRUBBED_BODY, scrubbed: true };", "  if (r.leaked) return { text: r.text, scrubbed: true };"]], [KT3, S4]],
  ["X5", "已撤回原文只看消息本体,漏掉撤回前的编辑稿", [[K, "    else if (e.body.kind === \"edit\" && gone.has(e.body.target)) out.push(e.body.text);\n", ""]], [KT1]],
  ["X6", "短文本也照扫(去掉下限)", [[C, "    if ([...sq].length < RETRACT_MIN_CHARS) continue;", "    if (sq === \"\") continue;"]], [KT4]],
  ["X7", "只认撤回事件的原文,不认整条撤回原文集合(拿当前投影当原文)", [[S, "      retracted.push(...f.retracted);", "      retracted.push(...f.lines.filter((l) => l.state === \"retracted\").map((l) => l.text));"]], [S1]],
  ["X8", "scrub 后不标 scrubbed(诊断就报不出来)", [[S, '      return { ...l, text: r.text, scrubbed: true };', "      return { ...l, text: r.text };"]], [S1]],
  ["X9", "正文里出现撤回原文时不动那一段,只把整行正文改成占位(等价于丢掉正文)", [[K, "  const r = scrubRetracted(text, retracted);\n  if (r.leaked) return { text: SCRUBBED_BODY, scrubbed: true };\n  return { text: r.text, scrubbed: r.hits > 0 };", "  if (retracted.some((t) => text.includes(t.trim()))) return { text: SCRUBBED_BODY, scrubbed: true };\n  return { text, scrubbed: false };"]], [S5, KT2]],
];

const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 600_000);
function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", "--test-force-exit", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
      const lines = out.split("\n");
      const failed = [];
      const passed = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^(not ok|ok) \d+ - (.+?)(?: # .*)?$/.exec(lines[i]);
        if (!m) continue;
        if (m[1] === "ok") {
          passed.push(m[2]);
          continue;
        }
        let j = i + 1;
        while (j < lines.length && !/^(?:not )?ok \d+ - /.test(lines[j])) j++;
        failed.push({ name: m[2], timeout: /testTimeoutFailure|test timed out/.test(lines.slice(i + 1, j).join("\n")) });
      }
      resolve({ code, failed, passed, timedOut });
    });
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g4b-scrub-mut-"));
const pkgs = fs.readdirSync(path.join(ROOT, "packages"));
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
const only = process.env.MUT_ONLY ? new Set(process.env.MUT_ONLY.split(",")) : null;
const list = M.filter(([id]) => !only || only.has(id));

let ok = true;
console.log(`node ${process.version},变异 ${list.length} 个,测试文件 ${TESTS.length} 个`);
const clean = await run(copy("clean"));
const good = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`${good ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红${clean.failed.length ? `(${clean.failed.map((f) => f.name).join(";")})` : ""}`);
if (!good) ok = false;
const full = (prefix) => clean.passed.filter((n) => n.startsWith(prefix));
for (const [, , , killers] of list) {
  for (const k of killers) {
    if (full(k).length !== 1) {
      ok = false;
      console.log(`✗ 具名测试前缀「${k}」在原样副本里认出 ${full(k).length} 条通过的测试(要恰好 1 条)`);
    }
  }
}
let killed = 0;
let survived = 0;
for (const [i, [id, name, edits, killers]] of list.entries()) {
  const tag = `[${i + 1}/${list.length}] ${id}`;
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
  const want = killers.flatMap(full);
  const byName = want.filter((n) => r.failed.some((f) => f.name === n && !f.timeout));
  const viaTimeout = want.filter((n) => r.failed.some((f) => f.name === n && f.timeout));
  const red = r.failed.map((f) => f.name).filter((n) => clean.passed.includes(n));
  const fileLevel = r.failed.filter((f) => TESTS.includes(f.name)).map((f) => f.name);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const note = fileLevel.length ? `;另有文件级失败 ${fileLevel.join("、")}` : "";
  if (!r.timedOut && want.length > 0 && byName.length === want.length) {
    killed++;
    console.log(`✓ ${tag} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs}s,指定测试按名失败:${byName.map((k) => `「${k.slice(0, 32)}」`).join("")};全部变红 ${red.length} 条${note}`);
  } else {
    ok = false;
    survived++;
    const why = r.timedOut ? "整组超时" : `指定测试没全部按名失败(按名 ${byName.length}/${want.length},超时 ${viaTimeout.length})`;
    console.log(`✗ ${tag} ${name}:${why},${r.passed.length} 绿 / ${r.failed.length} 红,用时 ${secs}s;变红:${red.map((k) => `「${k.slice(0, 32)}」`).join("")}${note}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${list.length}:杀死 ${killed},存活 ${survived}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
