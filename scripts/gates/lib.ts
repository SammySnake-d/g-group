// 门禁公共层:把"被检查的仓库状态"抽象成 Ctx,真实运行从 git 构造,自检从夹具目录构造。
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AcceptanceClaim {
  id: string;
  status: "通过" | "失败" | "未测" | "不适用";
  evidence?: string;
  reason?: string;
  approver?: string;
}
export interface Party { agent: string; session: string; model: string }
export interface Review extends Party { verdict: "approve" | "reject"; reviewed_hash: string; notes: string }
export interface Receipt {
  slice: string;
  acceptance: AcceptanceClaim[];
  author: Party;
  review: Review | null;
  red: { commit: string } | null;
  unverifiable: string;
  waiver: { by: string; reason: string } | null;
}

export interface NamedTest { file: string; name: string }
export interface TestRun { exitOk: boolean; passed: NamedTest[]; failed: NamedTest[]; output: string }

export interface Snapshot { dir: string; cleanup(): void; inRange: boolean }

export interface Ctx {
  root: string;
  branch: string;
  changed: string[];
  files: string[];
  read(p: string): string | undefined;
  /** 读 merge-base 时的文件;不存在返回 undefined */
  readBase(p: string): string | undefined;
  receipt: Receipt | undefined;
  receiptPath: string;
  specIds: Set<string>;
  runTests(files: string[], cwd?: string): TestRun;
  contentHash(): string;
  snapshot(ref: string): Snapshot | undefined;
}

export interface Problem { gate: string; msg: string }
export interface Gate {
  id: string;
  rule: string;
  run(ctx: Ctx): Problem[];
}

export const SPEC_FILE = "docs/spec/验收文档-v0.1.md";
export const RECEIPT_DIR = "receipts";
/** 只有这些路径的改动不需要收据与审查;其余一切(含 workflow、hook、脚本、依赖清单)都受管 */
export const UNGOVERNED = [/^docs\//, /^reviews\//, /^receipts\//, /^README\.md$/];
export const isGoverned = (f: string) => !UNGOVERNED.some((re) => re.test(f));
export const isTest = (f: string) => /^packages\/.+\.test\.ts$/.test(f);
export const isSrc = (f: string) => /^packages\/.+\.ts$/.test(f) && !isTest(f) && !f.includes("/fixtures/");
export const existing = (ctx: { files: string[] }, ps: string[]) => ps.filter((x) => ctx.files.includes(x));

export function specIdsFrom(text: string | undefined): Set<string> {
  return new Set((text ?? "").match(/\b(?:AC-\d+|V-\d+|R-M?\d+)\b/g) ?? []);
}

// 用 node --test 的 TAP 输出解析"每个文件里哪些具名测试通过/失败"。
// 只认测试真的注册并执行后的结果;文件加载失败时 TAP 里只有文件级失败,不会出现具名测试。
// 执行 PR 代码的唯一出口。CI 的可信门禁设 GATE_SANDBOX_IMAGE,PR 代码在无网络的容器里跑,
// 只能改它自己挂载的临时目录,碰不到可信门禁的进程和文件。本机不设则直接跑。
export function sandboxed(args: string[], cwd: string, mounts: string[] = []) {
  const image = process.env.GATE_SANDBOX_IMAGE;
  if (!image) return spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 900_000 });
  const vols = [...new Set([cwd, ...mounts].map((m) => fs.realpathSync(m)))].flatMap((m) => ["-v", `${m}:${m}`]);
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "1000:1000";
  return spawnSync("docker", ["run", "--rm", "--network", "none", "--user", uid, "-e", "HOME=/tmp", ...vols, "-w", fs.realpathSync(cwd), image, "node", ...args], { encoding: "utf8", timeout: 900_000 });
}
const nmMount = (root: string) => { const nm = path.join(root, "node_modules"); return fs.existsSync(nm) ? [fs.realpathSync(nm)] : []; };

export function runNodeTests(root: string, files: string[], extraArgs: string[] = []): TestRun {
  const passed: NamedTest[] = [], failed: NamedTest[] = [];
  let output = "", exitOk = true;
  for (const file of files) {
    const r = sandboxed([...extraArgs, "--test", "--test-reporter=tap", "--test-concurrency=1", file], root, nmMount(root));
    output += `### ${file}\n${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status !== 0) exitOk = false;
    const lines = (r.stdout ?? "").split("\n");
    // 只取叶子测试:后面紧跟的缩进更深的 "ok/not ok" 说明它是 describe 容器
    const rows: { depth: number; ok: boolean; name: string; skip: boolean }[] = [];
    for (const line of lines) {
      const m = /^(\s*)(not ok|ok) \d+ - (.+?)(?: # (.*))?$/.exec(line);
      if (m) rows.push({ depth: m[1]!.length, ok: m[2] === "ok", name: m[3]!.trim(), skip: /^(SKIP|TODO)/i.test(m[4] ?? "") });
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.name === file || row.name.endsWith(path.basename(file))) { if (!row.ok) failed.push({ file, name: `<文件级失败>` }); continue; }
      const prevDeeper = i > 0 && rows[i - 1]!.depth > row.depth;
      if (prevDeeper) continue; // 容器
      if (row.skip) continue;
      (row.ok ? passed : failed).push({ file, name: row.name });
    }
  }
  return { exitOk, passed, failed, output };
}

// 审查钉住的内容:仓库全部文件(receipts/ 与 reviews/ 除外)+ 本 PR 收据去掉 review 字段后的内容
export function hashFiles(root: string, files: string[], receipt?: Receipt): string {
  const h = createHash("sha256");
  if (receipt) { const { review: _r, ...rest } = receipt; h.update(`receipt\0${JSON.stringify(rest)}\0`); }
  for (const f of [...files].filter((f) => !f.startsWith(`${RECEIPT_DIR}/`) && !f.startsWith("reviews/")).sort()) {
    h.update(`${f}\0`);
    h.update(fs.readFileSync(path.join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

function loadReceipt(root: string, rel: string): Receipt | undefined {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Receipt;
}

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function ctxFromGit(root: string, base: string, branch: string): Ctx {
  const mergeBase = git(root, "merge-base", base, "HEAD");
  const changed = git(root, "diff", "--name-only", "--no-renames", mergeBase, "HEAD").split("\n").filter(Boolean); // 含删除;重命名拆成删+增
  const files = git(root, "ls-files").split("\n").filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  const receiptPath = `${RECEIPT_DIR}/${branchSlug(branch)}.json`;
  const read = (p: string) => { const f = path.join(root, p); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined; };
  const readBase = (p: string) => { const r = spawnSync("git", ["show", `${mergeBase}:${p}`], { cwd: root, encoding: "utf8" }); return r.status === 0 ? r.stdout : undefined; };
  return {
    root, branch, changed, files, read, readBase,
    receipt: loadReceipt(root, receiptPath), receiptPath,
    specIds: specIdsFrom(read(SPEC_FILE)),
    runTests: (fs_, cwd) => runNodeTests(cwd ?? root, fs_),
    contentHash: () => hashFiles(root, files, loadReceipt(root, receiptPath)),
    snapshot(ref) {
      const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, encoding: "utf8" });
      if (r.status !== 0) return undefined;
      const sha = r.stdout.trim();
      const isAnc = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root }).status === 0;
      const inRange = isAnc(sha, "HEAD") && !isAnc(sha, mergeBase);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-snap-"));
      execFileSync("git", ["worktree", "add", "--detach", "-q", dir, sha], { cwd: root });
      const nm = path.join(root, "node_modules");
      if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, "node_modules"));
      return { dir, inRange, cleanup: () => { execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: root }); } };
    },
  };
}

export function copyTree(src: string, dst: string, files: string[]) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  const nm = path.join(src, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dst, "node_modules"))) fs.symlinkSync(fs.realpathSync(nm), path.join(dst, "node_modules"));
}

export const p = (gate: string, msg: string): Problem => ({ gate, msg });

export interface GateResult { gate: Gate; problems: Problem[] }
// 唯一的执行器:run-all 和自检都走这里,门禁出错算拦下
export function runGates(ctx: Ctx, gates: Gate[]): GateResult[] {
  return gates.map((gate) => {
    try { return { gate, problems: gate.run(ctx) }; }
    catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }
  });
}
