// T-177 G3-02「上游边界」验收(审查条件 G3-b):third_party/acp-kernel 与钉住的上游逐文件一致、dist 能按 UPSTREAM.md 重建、
// 全新克隆 npm ci 后运行时能 import、全仓只有一处 import acp-kernel。全部由本脚本判定,不靠人看。
// 用法(仓库根目录):
//   node scripts/t177/g3-upstream-check.ts [--repo 目录]                     离线:① 逐文件哈希 ④ 唯一 import
//        --upstream <billion-context 克隆目录>                               ① 另外直接对上游仓库的钉住提交逐文件比
//        --rebuild                                                           ② 在临时副本里按 UPSTREAM.md 的命令重建 dist 并逐文件比(要联网装上游构建依赖)
//        --fresh-clone <仓库地址或目录> --ref <提交>                         ③ 全新克隆、npm ci、运行时 import 与接缝测试(要联网)
// 任何一项不符退出码 1。每项打印 ✓/✗ 和明细;--sums 把逐文件 sha256 清单另写到给定文件(证据用)。
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import ts from "typescript";

const { values: a } = parseArgs({
  options: {
    repo: { type: "string" }, upstream: { type: "string" }, rebuild: { type: "boolean" },
    "fresh-clone": { type: "string" }, ref: { type: "string" }, sums: { type: "string" },
  },
  strict: true,
});

const VENDOR = "third_party/acp-kernel";
const SEAM = "packages/kernel/src/history-search.ts";
const MANIFEST_OWNER = "packages/kernel/package.json";
const LOCAL = new Set(["UPSTREAM.md", "NOTICE"]); // 本地新增、不来自上游的文件(dist/ 另算)
const CODE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const gitBuf = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, maxBuffer: 1 << 28 });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const root = git(a.repo ?? process.cwd(), "rev-parse", "--show-toplevel").trim();
const vendorDir = path.join(root, VENDOR);

let failed = false;
const report = (name: string, problems: string[], detail = "") => {
  if (problems.length) failed = true;
  console.log(`${problems.length ? "✗" : "✓"} ${name}${detail ? `  ${detail}` : ""}`);
  for (const pr of problems.slice(0, 20)) console.log(`    - ${pr}`);
  if (problems.length > 20) console.log(`    - 另有 ${problems.length - 20} 项`);
};

// ---- UPSTREAM.md:钉住的字段与逐文件清单
const upstreamMd = fs.readFileSync(path.join(vendorDir, "UPSTREAM.md"), "utf8");
const field = (k: string) => {
  const m = new RegExp(`^- ${k}: \`([^\`]+)\``, "m").exec(upstreamMd);
  if (!m) throw new Error(`UPSTREAM.md 缺字段 ${k}`);
  return m[1]!;
};
const block = (name: string) => {
  const m = new RegExp(`<!-- ${name}:begin -->\\n\`\`\`\\n([\\s\\S]*?)\`\`\`\\n<!-- ${name}:end -->`).exec(upstreamMd);
  if (!m) throw new Error(`UPSTREAM.md 缺清单 ${name}`);
  const out = new Map<string, string>();
  for (const line of m[1]!.split("\n").filter(Boolean)) {
    const mm = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!mm) throw new Error(`UPSTREAM.md 清单 ${name} 的行格式不对:${line}`);
    out.set(mm[2]!, mm[1]!);
  }
  return out;
};
const PIN = {
  commit: field("upstream-commit"), path: field("upstream-path"), tree: field("upstream-tree"), srcTree: field("upstream-src-tree"), build: field("build"),
};
const sourceSums = block("source-sha256");
const distSums = block("dist-sha256");

/** 目录下全部文件(相对路径,/ 分隔),跳过 node_modules */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(dir, r)); }
    else out.push(r);
  }
  return out.sort();
}
const sumsOf = (dir: string, files: string[]) => new Map(files.map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))]));
function compare(label: string, want: Map<string, string>, got: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [f, h] of want) if (!got.has(f)) out.push(`${label}:缺 ${f}`); else if (got.get(f) !== h) out.push(`${label}:${f} 内容不同`);
  for (const f of got.keys()) if (!want.has(f)) out.push(`${label}:多出 ${f}`);
  return out;
}

// ---- ① 逐文件哈希:工作区文件 = UPSTREAM.md 清单;提交里去掉本地新增后的树 = 上游 kernel/ 的树;src 树 = 上游 src 树
{
  const all = walk(vendorDir);
  const src = all.filter((f) => !LOCAL.has(f) && !f.startsWith("dist/"));
  const dist = all.filter((f) => f.startsWith("dist/"));
  const got = sumsOf(vendorDir, src);
  const problems = [...compare("源码", sourceSums, got), ...compare("dist", distSums, sumsOf(vendorDir, dist))];
  for (const f of dist) if (f.endsWith(".map")) problems.push(`dist 里不应提交 ${f}`);
  if (fs.existsSync(path.join(vendorDir, "node_modules"))) problems.push(`${VENDOR}/node_modules 存在(上游的构建依赖不该装进仓库目录)`);
  // 提交里的树:按 git 对象判(与工作区无关),去掉本地新增后重建树对象,应恰为上游 kernel/ 的树
  const entries = git(root, "ls-tree", `HEAD:${VENDOR}`).split("\n").filter(Boolean).filter((l) => { const name = l.split("\t")[1]!; return !LOCAL.has(name) && name !== "dist"; });
  const rebuiltTree = execFileSync("git", ["mktree"], { cwd: root, input: `${entries.join("\n")}\n`, encoding: "utf8" }).trim();
  if (rebuiltTree !== PIN.tree) problems.push(`HEAD:${VENDOR} 去掉本地新增后的树 ${rebuiltTree} ≠ 上游 ${PIN.commit.slice(0, 12)}:${PIN.path} 的树 ${PIN.tree}`);
  const srcTree = git(root, "rev-parse", `HEAD:${VENDOR}/src`).trim();
  if (srcTree !== PIN.srcTree) problems.push(`HEAD:${VENDOR}/src 的树 ${srcTree} ≠ 上游 src 树 ${PIN.srcTree}`);
  const dirty = git(root, "status", "--porcelain", "--", VENDOR).trim();
  if (dirty) problems.push(`${VENDOR} 有未提交改动:${dirty.split("\n").slice(0, 3).join(";")}`);
  if (a.upstream) {
    const up = path.resolve(a.upstream);
    const upTree = git(up, "rev-parse", `${PIN.commit}:${PIN.path}`).trim();
    if (upTree !== PIN.tree) problems.push(`上游仓库里 ${PIN.commit}:${PIN.path} 的树是 ${upTree},不是 UPSTREAM.md 记的 ${PIN.tree}`);
    const upFiles = git(up, "ls-tree", "-r", "--name-only", PIN.commit, "--", `${PIN.path}/`).split("\n").filter(Boolean);
    const upSums = new Map(upFiles.map((f) => [f.slice(PIN.path.length + 1), sha(gitBuf(up, "cat-file", "blob", `${PIN.commit}:${f}`))]));
    problems.push(...compare("对上游仓库", upSums, got));
  }
  if (a.sums) fs.writeFileSync(a.sums, `${[...got, ...sumsOf(vendorDir, dist)].map(([f, h]) => `${h}  ${VENDOR}/${f}`).join("\n")}\n`);
  report("① 逐文件哈希与钉住的上游一致", problems, `源码 ${src.length} 个、dist ${dist.length} 个文件;树 ${PIN.tree.slice(0, 12)};src 树 ${PIN.srcTree.slice(0, 12)}${a.upstream ? ";已直接对上游仓库逐文件比" : ""}`);
}

// ---- ② 按 UPSTREAM.md 的命令重建 dist,逐文件与提交的一致
if (a.rebuild) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g3-rebuild-"));
  const problems: string[] = [];
  try {
    for (const f of walk(vendorDir)) {
      if (f.startsWith("dist/") || LOCAL.has(f)) continue;
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(vendorDir, f), path.join(tmp, f));
    }
    const r = spawnSync("sh", ["-c", PIN.build], { cwd: tmp, encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) problems.push(`构建命令失败(退出 ${r.status}):${(r.stderr || r.stdout).slice(-400)}`);
    else problems.push(...compare("重建的 dist", sumsOf(vendorDir, walk(vendorDir).filter((f) => f.startsWith("dist/"))), sumsOf(tmp, walk(tmp).filter((f) => f.startsWith("dist/")))));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  report("② 按 UPSTREAM.md 的命令重建出的 dist 与提交的一致", problems, `命令:${PIN.build};node ${process.version}`);
}

// ---- ③ 全新克隆、npm ci 后运行时能 import,接缝测试能跑
if (a["fresh-clone"]) {
  const problems: string[] = [];
  if (!a.ref) problems.push("--fresh-clone 要同时给 --ref");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g3-fresh-"));
  const dir = path.join(tmp, "repo");
  let detail = "";
  try {
    if (a.ref) {
      const src = a["fresh-clone"];
      git(tmp, "clone", "-q", ...(fs.existsSync(src) ? ["--no-local"] : []), src, dir);
      git(dir, "checkout", "-q", "--detach", a.ref);
      const head = git(dir, "rev-parse", "HEAD").trim();
      const ci = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
      if (ci.status !== 0) problems.push(`npm ci 失败(退出 ${ci.status}):${(ci.stderr || ci.stdout).slice(-400)}`);
      if (fs.existsSync(path.join(dir, VENDOR, "node_modules"))) problems.push("npm ci 往 third_party/acp-kernel 里装了依赖");
      const imp = spawnSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("acp-kernel"); console.log(JSON.stringify({ searchBlocks: typeof m.searchBlocks, messageDocs: typeof m.messageDocs }));'], { cwd: path.join(dir, "packages/kernel"), encoding: "utf8" });
      if (imp.stdout.trim() !== JSON.stringify({ searchBlocks: "function", messageDocs: "function" })) problems.push(`运行时 import acp-kernel 失败:${(imp.stderr || imp.stdout).slice(-400)}`);
      const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "packages/kernel/src/history-search.test.ts", "packages/kernel/src/memory-rank.test.ts"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
      const pass = /^# pass (\d+)$/m.exec(t.stdout)?.[1], fail = /^# fail (\d+)$/m.exec(t.stdout)?.[1];
      if (t.status !== 0 || fail !== "0") problems.push(`接缝测试没全过:pass ${pass} fail ${fail}`);
      const dirty = git(dir, "status", "--porcelain").trim();
      if (dirty) problems.push(`npm ci 之后工作区有改动(锁文件或 dist 被改写):${dirty.split("\n").slice(0, 3).join(";")}`);
      detail = `HEAD ${head};接缝测试 pass ${pass} fail ${fail}`;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  report("③ 全新克隆 npm ci 后运行时能 import acp-kernel", problems, detail);
}

// ---- ④ 全仓只有一处 import acp-kernel(业务代码);依赖声明只在 @g-group/kernel
{
  const problems: string[] = [];
  const tracked = git(root, "ls-files").split("\n").filter(Boolean).filter((f) => !f.startsWith(`${VENDOR}/`) && fs.existsSync(path.join(root, f)));
  const hitsUpstream = (s: string) => s === "acp-kernel" || s.startsWith("acp-kernel/") || s.includes(VENDOR);
  const importers: string[] = [];
  for (const f of tracked.filter((x) => CODE.test(x))) {
    const code = fs.readFileSync(path.join(root, f), "utf8");
    const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true);
    const specs: string[] = [];
    let opaque = false;
    const visit = (n: ts.Node) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) specs.push(n.moduleReference.expression.text);
      if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) specs.push(n.argument.literal.text);
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) specs.push(arg.text);
        else opaque = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (specs.some(hitsUpstream)) importers.push(f);
    else if (opaque && code.includes("acp-kernel") && f !== "scripts/t177/g3-upstream-check.ts") problems.push(`${f} 有非字面量的动态 import/require,且文件里出现 acp-kernel,无法核对`);
  }
  if (importers.length !== 1 || importers[0] !== SEAM) problems.push(`import acp-kernel 的文件应只有 ${SEAM},实际 ${importers.length} 个:${importers.join("、") || "无"}`);
  const declares = tracked.filter((f) => f.endsWith("package.json")).filter((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((k) => Object.hasOwn((j[k] ?? {}) as object, "acp-kernel"));
  });
  if (declares.length !== 1 || declares[0] !== MANIFEST_OWNER) problems.push(`声明 acp-kernel 依赖的应只有 ${MANIFEST_OWNER},实际:${declares.join("、") || "无"}`);
  report("④ 全仓只有一处 import acp-kernel", problems, `扫描 ${tracked.filter((x) => CODE.test(x)).length} 个代码文件;import 方:${importers.join("、") || "无"};依赖声明:${declares.join("、") || "无"}`);
}

console.log(failed ? "上游边界验收:不通过" : "上游边界验收:通过");
process.exit(failed ? 1 : 0);
