// 记忆与笔记的撤回/回退清洗、启动重建与记忆对外接口(feat/memory-hygiene)的行为变异校准(R-05 阳性埋雷):
// 对本片实现逐个注入单一故障,在整仓的隔离副本里跑本片相关测试文件,每个变异都必须让至少一条原样副本里通过的具名测试变红。
// 注入点必须在源码里恰好出现 1 次;原样副本必须全绿(阴性对照);每个变异在独立进程组里跑,超时就杀掉整组、记超时不算杀死;
// 文件级失败(导入、编译失败)不在具名测试集合里,不算杀死。每个变异列出全部变红的具名测试。
// 用法: node packages/server/proof/memory-hygiene-mutations.mjs   (低并发:串行一个一个跑)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const TESTS = ["packages/server/src/memory-hygiene.test.ts", "packages/server/src/memory-api.test.ts", "packages/server/src/profile.test.ts"];
const TIMEOUT_MS = Number(process.env.MUT_TIMEOUT_MS ?? 300_000);
const HO = "packages/server/src/host.ts";
const H = "packages/server/src/memory-hygiene.ts";
const A = "packages/server/src/memory-api.ts";
const V = "packages/server/src/views.ts";

const M = [
  ["M01 rewind 撤下原文不入清洗集合", HO, "[...this.retractedTexts(roomIds), ...rewoundTexts(this.db, roomIds)]", "this.retractedTexts(roomIds)"],
  ["M02 rewind 事务不重洗已落盘笔记", HO, "      rescrubNotes(this.db, this.members(roomId)", "      void (this.db, this.members(roomId)"],
  ["M03 回退后重发的同一句也被清", H, "    return s !== \"\" && !kept.some((k) => k.includes(s));", "    return s !== \"\";"],
  ["M04 来源撤回的记忆仍对联系人可见", H, "    return hidden.size ? entries.filter((e) => !hidden.has(e.id)) : entries;", "    return entries;"],
  ["M05 前缀快照不拿掉来源撤回的条目", H, "  if (keep.length !== doc.value.entries.length) putDoc(", "  if (keep.length < 0) putDoc("],
  ["M06 复述佐证还在也挡下", H, "      if (e.evidence.some((x) => x.roomId !== \"\" && !gone(x.roomId, x.seq))) continue;\n", ""],
  ["M07 启动不核对不重建", H, "    this.checkIndex();\n", ""],
  ["M08 启动只比条目数不比内容", H, "if (this.digest(md) === this.digest(this.listAll(contactId))) continue;", "if (md.length === this.listAll(contactId).length) continue;"],
  ["M09 revoke 物理删除 md 与索引行", A, "  if (e.status !== \"revoked\") host.memory.put(p.contactId, { ...e, status: \"revoked\", version: e.version + 1, updatedAt: host.memory.now() });", "  if (e.status !== \"revoked\") { process.getBuiltinModule(\"node:fs\").rmSync(`${host.memory.dir(p.contactId)}/${e.id}.md`); host.db.store.db.prepare(\"DELETE FROM gg_memory WHERE contact_id = ? AND id = ?\").run(p.contactId, e.id); }"],
  ["M10 revoke 只升版本不改状态", A, "{ ...e, status: \"revoked\", version: e.version + 1,", "{ ...e, version: e.version + 1,"],
  ["M11 不查是不是用户本人", A, "  if (actor.kind !== \"user\" || actor.id !== host.userId) throw", "  if (actor.kind === \"nobody\") throw"],
  ["M12 资料页长期记忆仍是 null", V, "longTerm: longTermMemory(host, contactId)", "longTerm: null"],
  ["M13 memory.rebuild 不重建", A, "entries: host.memory.rebuild(contactId)", "entries: host.memory.listAll(contactId).length"],
  ["M14 list 不标来源已撤回", A, "      state: hidden.has(e.id) ? \"source-retracted\" : e.status,", "      state: e.status,"],
  ["M15 不按准入分前缀/锚点", A, "      scope: e.anchors.includes(GLOBAL_ANCHOR) ? \"prefix\" : \"anchored\",", "      scope: \"anchored\","],
  ["M16 已替代的也能撤销", A, "  if (e.status === \"superseded\") throw new HostError(\"conflict\"", "  if (e.status === \"nope\") throw new HostError(\"conflict\""],
  ["M17 资料页计数含失效条目", A, "all.filter((v) => v.effective && v.scope === scope)", "all.filter((v) => v.scope === scope)"],
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hygiene-mut-"));
// 副本自带 node_modules:第三方依赖链接到原仓库,@g-group/* 链到副本自己的 packages,跨包导入也能看到注入的故障
function copy(name) {
  const d = path.join(tmp, name);
  fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/(^|[/\\])(node_modules|\.git|proof)([/\\]|$)/.test(path.relative(ROOT, s)) });
  const nm = path.join(d, "node_modules");
  fs.mkdirSync(path.join(nm, "@g-group"), { recursive: true });
  for (const e of fs.readdirSync(path.join(ROOT, "node_modules"))) if (e !== "@g-group") fs.symlinkSync(path.join(ROOT, "node_modules", e), path.join(nm, e));
  for (const pkg of fs.readdirSync(path.join(d, "packages"))) fs.symlinkSync(path.join("..", "..", "packages", pkg), path.join(nm, "@g-group", pkg));
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
const ONLY = process.env.MUT_ONLY ? process.env.MUT_ONLY.split(",") : null;
for (const [i, [name, file, from, to]] of M.entries()) {
  if (ONLY && !ONLY.some((p) => name.startsWith(p))) continue;
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
  else if (kills.length > 0) { killed++; console.log(`✓ ${tag} ${name}:用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,被 ${kills.length} 条具名测试发现:${kills.map((k) => `「${k}」`).join("、")}`); }
  else { ok = false; survived++; console.log(`✗ ${tag} ${name}:存活(或只有文件级失败)`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`合计 ${M.length}:杀死 ${killed},存活 ${survived},超时 ${timeouts}`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
