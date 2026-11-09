// 行为变异校准(R-05 阳性埋雷,AC-21):对共享文档单一提交点逐个注入单一故障,在隔离副本里跑 shared-docs.test.ts(真实 SQLite 文件),
// 每个变异都必须让至少一条具名测试失败;注入点在源码里必须恰好出现 1 次,否则脚本判失败。原样副本必须全绿(阴性对照)。
// 用法: node packages/server/proof/shared-docs-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");
const TESTS = ["src/shared-docs.test.ts"];

const M = [
  ["D01 去掉 CAS:期望版本换成刚读到的当前版本", "shared-docs.ts", "committed = putDoc(this.d.db, KEY(input.docId), input.baseVersion, body);", "committed = putDoc(this.d.db, KEY(input.docId), cur.ver, body);"],
  ["D02 版本冲突时静默覆盖", "shared-docs.ts", "committed = putDoc(this.d.db, KEY(input.docId), input.baseVersion, body);", "try { committed = putDoc(this.d.db, KEY(input.docId), input.baseVersion, body); } catch { committed = putDoc(this.d.db, KEY(input.docId), cur.ver, body); }"],
  ["D03 提交不查重放", "shared-docs.ts", "      if (prior) {\n        // 指纹里含 docId", "      if (prior && false) {\n        // 指纹里含 docId"],
  ["D04 提交重放不比指纹", "shared-docs.ts", "        if (prior.fingerprint !== fp) throw new HostError(\"conflict\", `requestId", "        if (false) throw new HostError(\"conflict\", `requestId"],
  ["D05 指纹不含 docId(换文档也当重放)", "shared-docs.ts", "fingerprint({ docId: input.docId, baseVersion", "fingerprint({ baseVersion"],
  ["D06 提交不记版本链", "shared-docs.ts", "      run(this.d.db, \"INSERT INTO gg_doc_versions (doc_id, ver, title, content, by_kind, by_id, at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)\", input.docId, committed, body.title, body.content, by.kind, by.id, at, input.requestId);\n", ""],
  ["D07 提交不记幂等键", "shared-docs.ts", "      run(this.d.db, \"INSERT INTO gg_doc_requests (request_id, doc_id, ver, fingerprint) VALUES (?, ?, ?, ?)\", input.requestId, input.docId, committed, fp);\n", ""],
  ["D08 读取不修复镜像", "shared-docs.ts", "    const cur = this.authoritative(docId);\n    this.syncMirror(docId, cur.value.content);\n", "    const cur = this.authoritative(docId);\n"],
  ["D09 启动不修复镜像", "host.ts", "    this.docs.repairMirrors();\n", ""],
  ["D10 镜像只看在不在、不比内容", "shared-docs.ts", "if (existsSync(f) && readFileSync(f, \"utf8\") === content) return false;", "if (existsSync(f)) return false;"],
  ["D11 重放也发 doc.updated", "shared-docs.ts", "    if (!replayed) this.d.emit(doc);\n", "    this.d.emit(doc);\n"],
  ["D12 列表不按会话过滤", "shared-docs.ts", ".filter((d) => q.roomId === undefined || d.value.roomId === q.roomId)", ".filter(() => true)"],
  ["D13 提交不在一个事务里(先推进版本、后写版本链)", "shared-docs.ts", "  try {\n    tx(db, fn);\n", "  try {\n    fn();\n"],
  ["D14 新建不查重放", "shared-docs.ts", "      if (prior) {\n        if (prior.fingerprint !== fp)", "      if (prior && false) {\n        if (prior.fingerprint !== fp)"],
  ["D15 新建重放不比内容", "shared-docs.ts", "        if (prior.fingerprint !== fp) throw new HostError(\"conflict\", `clientActionId", "        if (false) throw new HostError(\"conflict\", `clientActionId"],
  ["D16 冲突不带当前版本(提交前就按读到的版本判)", "shared-docs.ts", "      const cur = this.authoritative(input.docId);\n      const at = this.d.now();", "      const cur = this.authoritative(input.docId);\n      if (cur.ver !== input.baseVersion) throw new HostError(\"conflict\", \"版本变了\");\n      const at = this.d.now();"],
  ["D17 新建不校验会话", "shared-docs.ts", "    if (roomId) this.d.checkRoom(roomId);\n", ""],
];

function run(dir) {
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "--test-concurrency=1", ...TESTS], { cwd: dir, encoding: "utf8", timeout: 180_000 });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-docs-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) && !s.includes(`${path.sep}node_modules`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
try {
  const base = run(copy("base"));
  if (base.failed.length || !base.passed.length) {
    console.log(`✗ 原样副本:${base.passed.length} 绿 / ${base.failed.length} 红(应全绿)`);
    ok = false;
  } else console.log(`✓ 原样副本:${base.passed.length} 绿 / 0 红`);
  for (const [name, file, from, to] of M) {
    const d = copy(name.split(" ")[0]);
    const f = path.join(d, "src", file);
    const src = fs.readFileSync(f, "utf8");
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${name}:注入点出现 ${hits} 次(应恰好 1 次)`);
      ok = false;
      continue;
    }
    fs.writeFileSync(f, src.replace(from, to));
    const r = run(d);
    if (r.failed.length) console.log(`✓ ${name}:${r.passed.length} 绿 / ${r.failed.length} 红,被「${r.failed[0]}」发现`);
    else {
      console.log(`✗ ${name}:存活(${r.passed.length} 绿 / 0 红)`);
      ok = false;
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${M.length} 个变异`);
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
