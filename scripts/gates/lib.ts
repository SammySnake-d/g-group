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
  /** 本次合并的 PR 号(merge.sh 传 --pr);豁免必须写明它 */
  pr: number | undefined;
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

// 执行 PR 代码的唯一出口,一律 fail closed:
//  - 设了 GATE_SANDBOX_IMAGE:docker run --network none,只挂这次的临时副本和 node_modules;
//  - macOS:sandbox-exec,拒绝联网,只许写这次的临时副本,拒绝读会话、群聊、凭据目录;
//  - 两者都没有:直接报错停下,绝不回退到宿主执行。
// 子进程只拿最小环境(PATH、HOME/TMPDIR 指向临时副本),不继承任何 token。
// git/node 子进程的统一环境:剥掉全部 GIT_*(pre-push 等 hook 会注入 GIT_DIR/GIT_INDEX_FILE,
// 继承下去会让临时仓库里的 git 命令写到真正的仓库),不读系统级配置,HOME 指向一个空临时目录。
let isolatedHome: string | undefined;
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  isolatedHome ??= fs.mkdtempSync(path.join(os.tmpdir(), "gate-home-"));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", HOME: isolatedHome, ...extra };
}
/** 在临时仓库里跑的 git 一律加上这些 -c:不跑任何 hook */
export const GIT_SAFE_ARGS = ["-c", "core.hooksPath=/dev/null"];

export type SandboxMode = "docker" | "seatbelt";
export function sandboxMode(): SandboxMode {
  // 模拟开关先判:CI 在 job 级设了 GATE_SANDBOX_IMAGE,自检要能在那里验证"没有沙箱就停"
  if (process.env.GATE_SIMULATE_NO_SANDBOX === "1") throw new Error("没有可用沙箱(GATE_SIMULATE_NO_SANDBOX),拒绝在宿主上执行 PR 代码");
  if (process.env.GATE_SANDBOX_IMAGE) return "docker";
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return "seatbelt";
  throw new Error("没有可用沙箱(既没有 GATE_SANDBOX_IMAGE 也不是带 sandbox-exec 的 macOS),拒绝在宿主上执行 PR 代码");
}
const sbq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function seatbeltProfile(work: string): string {
  const home = os.homedir();
  const secret = [".mirasim/sessions", ".mirasim/chat", ".ssh", ".config/gh", ".claude", ".codex", ".gnupg", ".aws", ".npmrc"].map((d) => path.join(home, d));
  for (const v of [process.env.MIRASIM_SESSIONS, process.env.MIRASIM_ROOMS]) if (v) secret.push(v);
  const real = secret.map((d) => { try { return fs.realpathSync(d); } catch { return d; } });
  return [
    "(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
    `(allow file-write* (subpath ${sbq(work)}) (regex #"^/dev/"))`,
    `(deny file-read-data ${[...new Set([...secret, ...real])].map((d) => `(subpath ${sbq(d)})`).join(" ")})`,
  ].join("\n");
}
export function sandboxed(args: string[], work: string, mounts: string[] = []) {
  const mode = sandboxMode();
  const w = fs.realpathSync(work);
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: w, TMPDIR: w };
  if (mode === "docker") {
    // 只有本次副本可写;依赖等其它挂载一律内核只读(R15-04)
    const ro = [...new Set(mounts.map((m) => fs.realpathSync(m)))].filter((m) => m !== w);
    const vols = [["-v", `${w}:${w}`], ...ro.map((m) => ["-v", `${m}:${m}:ro`])].flat();
    const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "1000:1000";
    return spawnSync("docker", ["run", "--rm", "--network", "none", "--user", uid, "-e", `HOME=${w}`, "-e", `TMPDIR=${w}`, ...vols, "-w", w, process.env.GATE_SANDBOX_IMAGE!, "node", ...args], { encoding: "utf8", timeout: 900_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w } });
  }
  const prof = path.join(w, ".gate-sandbox.sb");
  fs.writeFileSync(prof, seatbeltProfile(w));
  return spawnSync("/usr/bin/sandbox-exec", ["-f", prof, process.execPath, ...args], { cwd: w, encoding: "utf8", timeout: 900_000, env });
}

// 把一棵树(不含 .git、node_modules)复制到新的临时目录;依赖目录在副本里重建(第十五轮 R15-03/R15-04):
// 指回 depsRoot 内部的工作区包链接(如 @g-group/domain -> ../../packages/domain)改成指向副本里对应的包,
// 其余依赖逐项软链到宿主依赖目录,该目录在沙箱里只读挂载(见 depMounts、sandboxed)。
// 每次跑 PR 测试都在新副本里跑,测试改不到被检查的原树,也改不到后面门禁要读的依赖。
export function freshCopy(src: string, depsRoot: string = src): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "gate-run-"));
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      if (rel === "" && (e.name === ".git" || e.name === "node_modules")) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { fs.mkdirSync(path.join(dst, r), { recursive: true }); walk(r); }
      else if (e.isFile()) fs.copyFileSync(path.join(src, r), path.join(dst, r));
    }
  };
  walk("");
  mirrorDeps(depsRoot, dst);
  return dst;
}
/** 在副本里建 node_modules 目录(不是整体软链):工作区包链到副本内的同名路径,其余链到宿主依赖的真实路径 */
function mirrorDeps(depsRoot: string, dst: string): void {
  const nm = path.join(depsRoot, "node_modules");
  if (!fs.existsSync(nm)) return;
  const realRoot = fs.realpathSync(depsRoot), realNm = fs.realpathSync(nm);
  const link = (entry: string, to: string) => {
    const from = path.join(nm, entry);
    let target: string;
    try { target = fs.realpathSync(from); } catch { return; } // 断链不提供
    // 工作区链接按链接文字就地解析(依赖目录本身是软链时 realpath 会跑到别处),落在仓库内、依赖目录外就改指副本
    const lexical = fs.lstatSync(from).isSymbolicLink() ? path.resolve(path.dirname(from), fs.readlinkSync(from)) : from;
    const within = (p: string, root: string) => p === root || p.startsWith(`${root}${path.sep}`);
    const rootAbs = path.resolve(depsRoot), nmAbs = path.resolve(nm);
    const dest = within(lexical, rootAbs) && !within(lexical, nmAbs) ? path.join(dst, path.relative(rootAbs, lexical))
      : within(target, realRoot) && !within(target, realNm) ? path.join(dst, path.relative(realRoot, target)) : target;
    fs.symlinkSync(dest, to);
  };
  fs.mkdirSync(path.join(dst, "node_modules"));
  for (const e of fs.readdirSync(nm)) {
    if (e.startsWith("@") && fs.lstatSync(path.join(nm, e)).isDirectory()) {
      fs.mkdirSync(path.join(dst, "node_modules", e));
      for (const c of fs.readdirSync(path.join(nm, e))) link(path.join(e, c), path.join(dst, "node_modules", e, c));
    } else link(e, path.join(dst, "node_modules", e));
  }
}

// 用 node --test 的 TAP 输出解析"每个文件里哪些具名测试通过/失败"。
// 只认测试真的注册并执行后的结果;文件加载失败时 TAP 里只有文件级失败,不会出现具名测试。
/** 沙箱里要只读提供的宿主依赖目录(副本里的依赖链接指向它) */
export const depMounts = (depsRoot: string) => { const nm = path.join(depsRoot, "node_modules"); return fs.existsSync(nm) ? [fs.realpathSync(nm)] : []; };

export function runNodeTests(root: string, files: string[], extraArgs: string[] = [], depsRoot: string = root): TestRun {
  const passed: NamedTest[] = [], failed: NamedTest[] = [];
  let output = "", exitOk = true;
  for (const file of files) {
    const work = freshCopy(root, depsRoot);
    let r: ReturnType<typeof sandboxed>;
    try { r = sandboxed([...extraArgs, "--test", "--test-reporter=tap", "--test-concurrency=1", file], work, depMounts(depsRoot)); }
    finally { fs.rmSync(work, { recursive: true, force: true }); }
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

const git = (root: string, ...args: string[]) => execFileSync("git", [...GIT_SAFE_ARGS, ...args], { cwd: root, encoding: "utf8", env: gitEnv() }).trim();
const gitRaw = (root: string, ...args: string[]) => spawnSync("git", [...GIT_SAFE_ARGS, ...args], { cwd: root, encoding: "utf8", env: gitEnv() });

export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function ctxFromGit(root: string, base: string, branch: string, pr?: number): Ctx {
  const mergeBase = git(root, "merge-base", base, "HEAD");
  const changed = git(root, "diff", "--name-only", "--no-renames", mergeBase, "HEAD").split("\n").filter(Boolean); // 含删除;重命名拆成删+增
  const files = git(root, "ls-files").split("\n").filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  const receiptPath = `${RECEIPT_DIR}/${branchSlug(branch)}.json`;
  const read = (p: string) => { const f = path.join(root, p); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined; };
  let hashMemo: string | undefined;
  const readBase = (p: string) => { const r = gitRaw(root, "show", `${mergeBase}:${p}`); return r.status === 0 ? r.stdout : undefined; };
  return {
    root, branch, changed, files, read, readBase, pr,
    receipt: loadReceipt(root, receiptPath), receiptPath,
    specIds: specIdsFrom(read(SPEC_FILE)),
    runTests: (fs_, cwd) => runNodeTests(cwd ?? root, fs_),
    contentHash: () => (hashMemo ??= hashFiles(root, files, loadReceipt(root, receiptPath))),
    snapshot(ref) {
      const r = gitRaw(root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      if (r.status !== 0) return undefined;
      const sha = r.stdout.trim();
      const isAnc = (a: string, b: string) => gitRaw(root, "merge-base", "--is-ancestor", a, b).status === 0;
      const inRange = isAnc(sha, "HEAD") && !isAnc(sha, mergeBase);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-snap-"));
      git(root, "worktree", "add", "--detach", "-q", dir, sha);
      const nm = path.join(root, "node_modules");
      if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dir, "node_modules"));
      return { dir, inRange, cleanup: () => { git(root, "worktree", "remove", "--force", dir); } };
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
