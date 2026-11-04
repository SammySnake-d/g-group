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
export interface Receipt {
  slice: string;
  acceptance: AcceptanceClaim[];
  author: Party;
  review: (Party & { verdict: "approve" | "reject"; reviewed_hash: string; notes: string }) | null;
  red: { commit: string; tests: string[] } | null;
  unverifiable: string;
  waiver: { by: string; reason: string } | null;
}

export interface TestRun { ok: boolean; passed: string[]; failed: string[]; output: string }

export interface Ctx {
  root: string;
  changed: string[];
  files: string[];
  read(p: string): string | undefined;
  receipt: Receipt | undefined;
  receiptPath: string | undefined;
  specIds: Set<string>;
  runTests(files: string[], cwd?: string): TestRun;
  contentHash(): string;
  /** 取某个提交时的仓库快照目录(用于复跑"先红"),调用方负责 cleanup */
  snapshot(ref: string): { dir: string; cleanup(): void; inRange: boolean } | undefined;
}

export interface Problem { gate: string; msg: string }
export interface Gate {
  id: string;
  rule: string;
  run(ctx: Ctx): Problem[];
}

export const SPEC_FILE = "docs/spec/验收文档-v0.1.md";
export const RECEIPT_DIR = "receipts";
export const isTest = (p: string) => /\.test\.ts$/.test(p);
export const existing = (ctx: { files: string[] }, ps: string[]) => ps.filter((x) => ctx.files.includes(x));
export const isSrc = (p: string) => /^packages\/.+\.ts$/.test(p) && !isTest(p) && !p.includes("/fixtures/");

export function specIdsFrom(text: string | undefined): Set<string> {
  return new Set((text ?? "").match(/\b(?:AC-\d+|V-\d+|R-M?\d+)\b/g) ?? []);
}

export function runNodeTests(root: string, files: string[]): TestRun {
  if (files.length === 0) return { ok: true, passed: [], failed: [], output: "" };
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: root, encoding: "utf8", timeout: 300_000 });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  const passed: string[] = [], failed: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(not ok|ok) \d+ - (.+?)(?: # .*)?$/.exec(line);
    if (m) (m[1] === "ok" ? passed : failed).push(m[2]!.trim());
  }
  return { ok: r.status === 0, passed, failed, output };
}

// 审查钉住的内容:仓库全部文件(receipts/ 与审查人自己写的 reviews/ 除外)+ 本 PR 收据去掉 review 字段后的内容
function hashFiles(root: string, files: string[], receipt?: Receipt): string {
  const h = createHash("sha256");
  if (receipt) { const { review: _r, ...rest } = receipt; h.update("receipt\0" + JSON.stringify(rest) + "\0"); }
  for (const f of [...files].filter((f) => !f.startsWith(RECEIPT_DIR + "/") && !f.startsWith("reviews/")).sort()) {
    h.update(f + "\0");
    h.update(fs.readFileSync(path.join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

function loadReceipt(root: string, rel: string | undefined): Receipt | undefined {
  if (!rel) return undefined;
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
  return {
    root, changed, files, read,
    receipt: loadReceipt(root, receiptPath), receiptPath,
    specIds: specIdsFrom(read(SPEC_FILE)),
    runTests: (fs_, cwd) => runNodeTests(cwd ?? root, fs_),
    contentHash: () => hashFiles(root, files, loadReceipt(root, receiptPath)),
    snapshot(ref) {
      let sha: string;
      try { sha = git(root, "rev-parse", "--verify", ref + "^{commit}"); } catch { return undefined; }
      const isAnc = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root }).status === 0;
      const inRange = isAnc(sha, "HEAD") && !isAnc(sha, mergeBase);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-snap-"));
      execFileSync("git", ["worktree", "add", "--detach", "-q", dir, sha], { cwd: root });
      const nm = path.join(root, "node_modules");
      if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, "node_modules"));
      return { dir, inRange, cleanup: () => execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: root }) };
    },
  };
}

// 自检夹具:目录里放一棵迷你仓库 + _ctx.json({ changed, receipt })
export function ctxFromDir(dir: string): Ctx {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "_ctx.json"), "utf8")) as { changed: string[]; receipt?: string };
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name !== "_ctx.json") files.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  const read = (p: string) => { const f = path.join(dir, p); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined; };
  return {
    root: dir, changed: meta.changed, files, read,
    receipt: loadReceipt(dir, meta.receipt), receiptPath: meta.receipt,
    specIds: specIdsFrom(read(SPEC_FILE)),
    runTests: (fs_, cwd) => runNodeTests(cwd ?? dir, fs_),
    contentHash: () => hashFiles(dir, files, loadReceipt(dir, meta.receipt)),
    snapshot(ref) {
      const d = path.join(dir, "..", "_snap", ref);
      if (!fs.existsSync(d)) return undefined;
      const nm = path.join(dir, "node_modules");
      if (fs.existsSync(nm) && !fs.existsSync(path.join(d, "node_modules"))) fs.symlinkSync(fs.realpathSync(nm), path.join(d, "node_modules"));
      return { dir: d, inRange: true, cleanup: () => {} };
    },
  };
}

export function copyTree(src: string, dst: string, files: string[]) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  const nm = path.join(src, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dst, "node_modules"))) fs.symlinkSync(nm, path.join(dst, "node_modules"));
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
