// P1 删除类变异:恢复旧入口/事件/初始化,必须被指定具名测试发现。原样副本作阴性对照。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const BASE = "4efdee0be6d161060099b5ce488e3344c70305ee";
const tests = ["packages/server/src/shared-doc-removed.test.ts", "packages/api-contract/src/shared-doc-removed.test.ts"];
const old = (file) => execFileSync("git", ["show", `${BASE}:${file}`], { cwd: ROOT, encoding: "utf8" });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-p1-mut-"));
const edit = (dir, file, from, to) => {
  const p = path.join(dir, file), s = fs.readFileSync(p, "utf8");
  if (s.split(from).length !== 2) throw new Error(`注入点不唯一: ${file} ${from}`);
  fs.writeFileSync(p, s.replace(from, to));
};
const api = "packages/api-contract/src/api.ts", entities = "packages/api-contract/src/entities.ts";
const host = "packages/server/src/host.ts", svc = "packages/server/src/service.ts";
const events = "packages/api-contract/src/events.ts";
const restoreTypes = (d) => {
  const s = old(entities), chunk = s.slice(s.indexOf("// ---------- 共享文档"), s.indexOf("// ---------- 定时"));
  edit(d, entities, "// ---------- 定时", chunk + "// ---------- 定时");
};
const mutations = ["list", "get", "create", "commit", "history"].map((name) => ({
  name: `恢复 docs.${name}`, target: `P1 docs.${name} 返回 unknown_method`, apply(d) {
    restoreTypes(d);
    fs.writeFileSync(path.join(d, "packages/server/src/shared-docs.ts"), old("packages/server/src/shared-docs.ts"));
    const h = old(host), chunk = h.slice(h.indexOf("    this.docs = new SharedDocs("), h.indexOf("    this.worktrees ="));
    fs.writeFileSync(path.join(d, host), 'import { SharedDocs } from "./shared-docs.ts";\n' + fs.readFileSync(path.join(d, host), "utf8"));
    edit(d, host, "  readonly worktrees:", "  readonly docs: SharedDocs;\n  readonly worktrees:");
    edit(d, host, "    this.worktrees =", chunk + "    this.worktrees =");
    edit(d, svc, '    "schedules.list":', old(svc).split("\n").find((l) => l.startsWith(`    "docs.${name}":`)) + '\n    "schedules.list":');
    const a = old(api), start = a.indexOf(`  "docs.${name}":`);
    const end = name === "commit" ? a.indexOf('\n  ),', start) + 6 : a.indexOf("\n", start);
    edit(d, api, "  // ---- 定时", a.slice(start, end) + '\n\n  // ---- 定时');
    fs.writeFileSync(path.join(d, api), 'import { SharedDocView, SharedDocVersionView } from "./entities.ts";\n' + fs.readFileSync(path.join(d, api), "utf8"));
  },
}));
for (const table of ["gg_doc_versions", "gg_doc_requests"]) mutations.push({
  name: `恢复 ${table} 建表`, target: "P1 新宿主没有共享文档专用表和镜像目录", apply(d) {
    edit(d, host, "    this.worktrees =", `    this.db.store.db.exec("CREATE TABLE ${table} (id TEXT)");\n    this.worktrees =`);
  },
});
mutations.push({ name: "恢复 doc.updated 事件", target: "P1 合同拒绝 doc.updated 事件", apply(d) {
  restoreTypes(d);
  edit(d, events, "import { CommitmentView", "import { SharedDocView, CommitmentView");
  edit(d, events, '  "room.updated":', '  "doc.updated": ev("doc.updated", { doc: SharedDocView }),\n  "room.updated":');
} });
mutations.push({ name: "恢复镜像目录初始化", target: "P1 新宿主没有共享文档专用表和镜像目录", apply(d) {
  edit(d, host, "    this.worktrees =", '    mkdirSync(join(opts.dataDir ?? dirname(opts.file), "shared-docs"), { recursive: true });\n    this.worktrees =');
} });
function copy(id) {
  const d = path.join(tmp, id); fs.mkdirSync(d);
  fs.cpSync(path.join(ROOT, "packages"), path.join(d, "packages"), { recursive: true, filter: (p) => !p.includes("/node_modules") && !p.includes("/proof") });
  fs.writeFileSync(path.join(d, "package.json"), '{"type":"module"}');
  fs.mkdirSync(path.join(d, "node_modules/@g-group"), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (name === "@g-group") continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", name), path.join(d, "node_modules", name));
  }
  for (const name of fs.readdirSync(path.join(d, "packages"))) fs.symlinkSync(path.join(d, "packages", name), path.join(d, "node_modules/@g-group", name));
  return d;
}
function run(d) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...tests], { cwd: d, encoding: "utf8", timeout: 180000 });
  const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const passed = [...r.stdout.matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed, output: r.stdout + r.stderr };
}
let killed = 0;
try {
  const control = run(copy("control"));
  console.log(JSON.stringify({ control: { code: control.code, passed: control.passed.length, failed: control.failed } }));
  if (control.code !== 0 || control.passed.length !== 8) throw new Error(control.output);
  for (const [i, m] of mutations.entries()) {
    const d = copy(`m${i}`); m.apply(d); const r = run(d);
    const pass = r.code !== 0 && r.failed.includes(m.target) && r.failed.every((name) => name.startsWith("P1 ")) && r.passed.length + r.failed.length === 8 && r.output.includes("ERR_ASSERTION");
    console.log(JSON.stringify({ name: m.name, target: m.target, killed: pass, code: r.code, passed: r.passed.length, failed: r.failed }));
    if (!pass) console.log(r.output);
    killed += Number(pass);
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`变异 ${mutations.length} / 杀死 ${killed} / 存活 ${mutations.length - killed}`);
process.exitCode = killed === mutations.length ? 0 : 1;
