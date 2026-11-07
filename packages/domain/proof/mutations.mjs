// 行为变异校准(R-05 阳性埋雷):对 domain 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败。M01–M09 对应 Astra 审查 reviews/feat-domain-core.md 的变体清单,
// M10–M12 是这次修复新增的不可变性埋雷。原样副本必须全绿(阴性对照)。
// 用法: node packages/domain/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["M01 verify 删除前驱关联检查", "log.ts", "if (e.prev !== prev || hashOf(rest) !== hash)", "if (hashOf(rest) !== hash)"],
  ["M02 放行 compute 发言", "log.ts", 'if (!SENDERS.has(s.kind)) throw new DomainError("sender-not-allowed", s.kind);', ""],
  ["M03 commit 删除版本检查", "cas.ts", 'if (cur.ver !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };', ""],
  ["M04 commitIn 删除版本检查", "cas.ts", 'if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };', ""],
  ["M05 编辑时原地改写旧消息", "log.ts", "  if (body.kind !== \"message\") checkTarget(log, sender, body.target);", "  if (body.kind !== \"message\") checkTarget(log, sender, body.target);\n  if (body.kind === \"edit\") { const i = log.events.findIndex((e) => e.seq === body.target); if (i >= 0) (log.events as LogEvent[])[i] = { ...log.events[i]!, body: { kind: \"message\", text: body.text } }; }"],
  ["M06 commitIn 已有文档保留旧内容", "cas.ts", "out.set(key, { value: next, ver: curVer + 1 });", "out.set(key, { value: cur ? cur.value : next, ver: curVer + 1 });"],
  ["M07 commitIn 原地改输入 Store", "cas.ts", "const out = new Map(store);", "const out = store as Map<string, Versioned<T>>;"],
  ["M08 verify 删除正文 hash 校验", "log.ts", "if (e.prev !== prev || hashOf(rest) !== hash)", "if (e.prev !== prev)"],
  ["M09 prev 一律为创世值", "log.ts", "prev: last?.hash ?? GENESIS,", "prev: GENESIS,"],
  ["M10 body 不做快照直接引用", "log.ts", "body: snapshotBody(body),", "body,"],
  ["M11 sender 不做快照直接引用", "log.ts", "sender: Object.freeze({ kind: sender.kind, id: String(sender.id) }),", "sender: sender as Sender,"],
  ["M12a 事件对象不冻结", "log.ts", "const event: LogEvent = Object.freeze({ ...draft, hash: hashOf(draft) });", "const event: LogEvent = { ...draft, hash: hashOf(draft) };"],
  ["M12b sender 不冻结", "log.ts", "sender: Object.freeze({ kind: sender.kind, id: String(sender.id) }),", "sender: { kind: sender.kind, id: String(sender.id) },"],
  ["M12c message body 不冻结", "log.ts", 'case "message": return Object.freeze({ kind: "message", text: String(b.text) });', 'case "message": return { kind: "message", text: String(b.text) };'],
  ["M12d 事件数组不冻结", "log.ts", "return Object.freeze({ events: Object.freeze([...log.events, event]) });", "return Object.freeze({ events: [...log.events, event] });"],
  ["M12e 日志外壳不冻结", "log.ts", "return Object.freeze({ events: Object.freeze([...log.events, event]) });", "return { events: Object.freeze([...log.events, event]) };"],
  ["M07b 冲突时偷偷推进输入版本", "cas.ts", 'if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };', 'if (curVer !== expectedVer) { if (cur) (store as Map<string, Versioned<T>>).set(key, { value: cur.value, ver: curVer + 1 }); return { ok: false, reason: "version-conflict", currentVer: curVer }; }'],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, encoding: "utf8" });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domain-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = run(copy("clean"));
console.log(`${clean.code === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  if (!src.includes(from)) { ok = false; console.log(`✗ ${name}:注入点不存在(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
