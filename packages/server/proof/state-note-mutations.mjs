// 状态笔记切片(feat/g-state-note)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片相关测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死。
// 用法: node packages/server/proof/state-note-mutations.mjs   (低并发:串行一个一个跑)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/kernel/src/compact.test.ts", "packages/adapter-pi-contact/src/compact.test.ts", "packages/server/src/state-note.test.ts"];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const K = "packages/kernel/src/compact.ts";
const P = "packages/adapter-pi-contact/src/compact.ts";
const H = "packages/server/src/host.ts";
const A = "packages/server/src/assemble.ts";

const M = [
  // —— 压缩材料
  ["S01 材料漏掉本轮新输入", K, 't += fresh.length === 0 ? "(无)\\n" : fresh.map(renderInboundText).join("");', 't += "(无)\\n";'],
  ["S02 材料漏掉联系人动作", K, 't += actions.length === 0 ? "(无)\\n" : actions.map(renderAction).join("");', 't += "(无)\\n";'],
  ["S03 reply 动作丢掉引用号", K, '${a.replyToSeq === null ? "" : ` ↩#${a.replyToSeq}`}', ""],
  // —— 撤回移除
  ["S04 撤回下限设为 0(短语也扫)", K, "export const RETRACT_MIN_CHARS = 4;", "export const RETRACT_MIN_CHARS = 0;"],
  ["S05 不做精确替换", K, "        text = parts.join(PLACEHOLDER);", ""],
  ["S06 不逐行移除多行原文", K, '...raw.split(/\\r?\\n/).map((l) => l.trim()).filter((l) => [...squash(l)].length >= RETRACT_MIN_CHARS)', ""],
  ["S07 不做去空白泄漏判定", K, "  const leaked = needles.some((n) => hay.includes(n));", "  const leaked = false && needles.some((n) => hay.includes(n));"],
  ["S08 替换次数只记 1", K, "        hits += parts.length - 1;", "        hits = 1;"],
  // —— pi 压缩器
  ["S09 不核对说话模型", P, "if (speaking !== cfg.model) throw", "if (false) throw"],
  ["S10 系统提示不带笔记写法", P, "  STATE_NOTE_GUIDE,\n", ""],
  ["S11 用户消息不带旧笔记", P, "return `[旧状态笔记]\\n${prev}\\n\\n${req.material}", "return `[旧状态笔记]\\n\\n\\n${req.material}"],
  ["S12 不写字节上限", P, 'const limit = req.maxBytes === null ? "" : `\\n新笔记不超过 ${req.maxBytes} 字节(UTF-8)。`;', 'const limit = "";'],
  ["S13 空笔记当成功", P, 'if (text === "") throw new PiContactMindError("provider-error", "压缩器返回了空笔记");', ""],
  ["S14 报错不隐去密钥", P, 'const redact = (s: string) => s.split(cfg.apiKey).join("[密钥已隐去]");', "const redact = (s: string) => s;"],
  ["S15 Bearer 头丢失", P, '...(cfg.bearer ? { headers: { authorization: `Bearer ${cfg.apiKey}` } } : { apiKey: cfg.apiKey }),', "apiKey: cfg.apiKey,"],
  // —— 宿主
  ["S16 模型没写笔记也不补写", H, "if (note === null && compactor && fresh.length > 0) {", "if (false) {"],
  ["S17 模型写了笔记仍压缩", H, "    let note = out.stateNote;\n", "    let note: string | null = null;\n"],
  ["S18 补写不带旧笔记", H, 'kind: "round-note", previous: prev,', 'kind: "round-note", previous: null,'],
  ["S19 压缩失败当空笔记清掉旧笔记", H, '        this.report("compact-failed", { contactId, kind: "round-note", error: e instanceof Error ? e.message : String(e) });\n        note = null;', '        this.report("compact-failed", { contactId, kind: "round-note", error: e instanceof Error ? e.message : String(e) });\n        note = "";'],
  ["S20 超上限不缩写", H, "if (note !== null && max !== null && Buffer.byteLength(note, \"utf8\") > max) {", "if (false) {"],
  ["S21 缩写结果更长也采用", H, 'if (Buffer.byteLength(shorter, "utf8") < Buffer.byteLength(note, "utf8")) note = shorter;', "note = shorter;"],
  ["S22 超上限不报告", H, 'if (Buffer.byteLength(note, "utf8") > max) this.report("state-note-over-limit"', 'if (false) this.report("state-note-over-limit"'],
  ["S23 落盘前不移除撤回原文", H, "return note === null ? null : this.scrubNote(contactId, note, roomIds);", "return note;"],
  ["S24 装配前不再扫已存笔记", H, "if (clean !== note.value.text) {", "if (false) {"],
  ["S25 泄漏不作废", H, "    if (r.leaked) {", "    if (false) {"],
  ["S26 不收撤回前的编辑稿", H, '        if (e.body.kind === "edit" && gone.has(e.body.target)) out.push(e.body.text);\n', ""],
  ["S27 工具声明漏 update_state_note", A, '  "update_state_note(note) — 写状态笔记(下一轮第 3 块)",\n', ""],
  ["S28 系统提示不带笔记写法", A, "  STATE_NOTE_GUIDE,\n].join", "].join"],
];

function run(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...TESTS], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      resolve({ code, timedOut, failed: [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]), passed: [...out.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]) });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-note-mut-"));
function copy(name) {
  const d = path.join(tmp, name);
  fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/(^|[/\\])(node_modules|\.git|proof)([/\\]|$)/.test(path.relative(ROOT, s)) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
}

let ok = true;
const clean = await run(copy("clean"));
const named = new Set(clean.passed);
const cleanOk = !clean.timedOut && clean.code === 0 && clean.failed.length === 0 && clean.passed.length > 0;
console.log(`node ${process.version}`);
console.log(`${cleanOk ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (!cleanOk) ok = false;
let killed = 0, survived = 0, timeouts = 0;
for (const [i, [name, file, from, to]] of M.entries()) {
  const tag = `[${i + 1}/${M.length}]`;
  const d = copy(`m${i}`);
  const f = path.join(d, file);
  const src = fs.readFileSync(f, "utf8");
  const n = src.split(from).length - 1;
  if (n !== 1) { ok = false; survived++; console.log(`✗ ${tag} ${name}:注入点出现 ${n} 次,必须恰好 1 次`); fs.rmSync(d, { recursive: true, force: true }); continue; }
  fs.writeFileSync(f, src.replace(from, to));
  const t0 = Date.now();
  const r = await run(d);
  fs.rmSync(d, { recursive: true, force: true });
  const kills = r.failed.filter((t) => named.has(t));
  if (r.timedOut) { ok = false; timeouts++; console.log(`✗ ${tag} ${name}:超时,不算杀死`); }
  else if (kills.length > 0) { killed++; console.log(`✓ ${tag} ${name}:用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被「${kills[0]}」发现`); }
  else { ok = false; survived++; console.log(`✗ ${tag} ${name}:存活(或只有文件级失败)`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived},超时 ${timeouts}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
