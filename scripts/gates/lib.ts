// 门禁公共层:把"被检查的仓库状态"抽象成 Ctx,真实运行从 git 构造,自检从夹具目录构造。
import { execFileSync, type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
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
//  - macOS:sandbox-exec,拒绝联网,只许写这次的临时副本,拒绝读 HOME 下的点文件(只放行临时副本、依赖)和会话、群聊、凭据目录;
//  - 两者都没有:直接报错停下,绝不回退到宿主执行。
// 子进程只拿最小环境(PATH、HOME/TMPDIR 指向临时副本),不继承任何 token。
// git/node 子进程的统一环境:剥掉全部 GIT_*(pre-push 等 hook 会注入 GIT_DIR/GIT_INDEX_FILE,
// 继承下去会让临时仓库里的 git 命令写到真正的仓库),不读系统级配置,HOME 指向一个空临时目录。
// 同一进程复用一个空 HOME,进程退出时删掉(用户 g-group#2900:测试要及时清理磁盘)。
// 子进程继承到的 HOME 就用它,不再各建一个:有 GATE_ISOLATED_HOME 且确实是我们建的目录就复用,只由建它的进程删。
let isolatedHome: string | undefined;
function ownHome(): string {
  const inherited = process.env.GATE_ISOLATED_HOME;
  if (inherited && path.basename(inherited).startsWith("gate-home-") && fs.existsSync(inherited)) return inherited;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gate-home-"));
  process.on("exit", () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 退出时尽力删 */ } });
  return d;
}
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  isolatedHome ??= ownHome();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", HOME: isolatedHome, GATE_ISOLATED_HOME: isolatedHome, ...extra };
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
const realOr = (d: string) => { try { return fs.realpathSync(d); } catch { return d; } };
// SBPL 正则字面量 #"...":路径里的正则元字符逐个转义;含引号或换行的路径写不进字面量,直接报错停下(fail closed)
const sbRe = (re: string) => { if (/["\n\r]/.test(re)) throw new Error(`沙箱规则写不进含引号或换行的路径:${JSON.stringify(re)}`); return `#"${re}"`; };
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 读隔离(R7-01):seatbelt 按真实路径(realpath)匹配,同一条规则后写的生效。
//  1. HOME 下所有点文件/点目录默认拒读(.git-credentials、.netrc、.ssh、.config/... 以及没列出的凭据位置);
//  2. 只放行运行必需的:这次的临时副本、挂载的依赖(node_modules 真实路径)。node 可执行文件即使在点目录里(~/.nvm)
//     也能启动:exec 不受 file-read-data 约束(自检把 node 放进假 HOME 的点目录核对);
//  3. 最后再拒读固定清单(会话、群聊、凭据目录,含 HOME 之外的 MIRASIM_SESSIONS/ROOMS):放行项落在其中也不放开。
// HOME 取实际值(os.homedir(),即这次的 $HOME),规则同时写原样和 realpath 两份。
const SECRET_IN_HOME = [".mirasim/sessions", ".mirasim/chat", ".ssh", ".config/gh", ".claude", ".codex", ".gnupg", ".aws", ".npmrc", ".git-credentials", ".netrc"];
// R9-03:动态链接的 node(如 Homebrew)按 @loader_path 与 @loader_path/../lib 加载自带的 .dylib;运行时放在 HOME 点目录时
// 这些库会被点文件默认拒读挡住,进程起不来。只逐个放行运行时 bin/ 与 ../lib/ 里的 .dylib 文件(literal,realpath),不放行目录。
export function runtimeLibs(exe: string = process.execPath): string[] {
  const bin = path.dirname(realOr(exe));
  const out: string[] = [];
  for (const d of [bin, path.join(path.dirname(bin), "lib")]) {
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) if (e.isFile() && e.name.endsWith(".dylib")) out.push(realOr(path.join(d, e.name)));
  }
  return [...new Set(out)];
}
function seatbeltProfile(work: string, mounts: string[] = [], exe: string = process.execPath): string {
  const home = path.resolve(os.homedir());
  const homes = [...new Set([home, realOr(home)])];
  const secret = SECRET_IN_HOME.map((d) => path.join(home, d));
  for (const v of [process.env.MIRASIM_SESSIONS, process.env.MIRASIM_ROOMS]) if (v) secret.push(v);
  const runtime = [...[work, ...mounts].map((d) => `(subpath ${sbq(realOr(d))})`), ...runtimeLibs(exe).map((f) => `(literal ${sbq(f)})`)];
  return [
    "(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
    `(allow file-write* (subpath ${sbq(work)}) (regex #"^/dev/"))`,
    `(deny file-read-data ${homes.map((h) => `(regex ${sbRe(`^${reEsc(h)}/\\.`)})`).join(" ")})`,
    `(allow file-read-data ${runtime.join(" ")})`,
    `(deny file-read-data ${[...new Set([...secret, ...secret.map(realOr)])].map((d) => `(subpath ${sbq(d)})`).join(" ")})`,
  ].join("\n");
}
/** 沙箱执行计划:要执行的命令、参数、选项;seatbelt 时带上规则文本和写入位置。纯函数,不执行、不写文件。 */
export interface SandboxPlan { cmd: string; argv: string[]; opts: SpawnSyncOptionsWithStringEncoding; profile?: string; profilePath?: string }
/** exe:沙箱里执行的 node,默认就是当前进程的解释器;自检用假运行时核对规则文本时传入。 */
export function sandboxPlan(args: string[], work: string, mounts: string[] = [], mode: SandboxMode = sandboxMode(), exe: string = process.execPath): SandboxPlan {
  const w = fs.realpathSync(work);
  if (mode === "docker") {
    const vols = [...new Set([w, ...mounts.map((m) => fs.realpathSync(m))])].flatMap((m) => ["-v", `${m}:${m}`]);
    const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "1000:1000";
    return { cmd: "docker", argv: ["run", "--rm", "--network", "none", "--user", uid, "-e", `HOME=${w}`, "-e", `TMPDIR=${w}`, ...vols, "-w", w, process.env.GATE_SANDBOX_IMAGE!, "node", ...args], opts: { encoding: "utf8", timeout: 900_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: w } } };
  }
  const profilePath = path.join(w, ".gate-sandbox.sb");
  return { cmd: "/usr/bin/sandbox-exec", argv: ["-f", profilePath, exe, ...args], opts: { cwd: w, encoding: "utf8", timeout: 900_000, env: { PATH: `${path.dirname(exe)}:/usr/bin:/bin`, HOME: w, TMPDIR: w } }, profile: seatbeltProfile(w, mounts, exe), profilePath };
}
/** R10-04:容器命令逐项核对,返回问题列表(空 = 恰为预期)。work 与 mounts 是真实路径。 */
export function containerPlanProblems(_argv: readonly string[], _work: string, _mounts: readonly string[]): string[] {
  return [];
}
export function sandboxed(args: string[], work: string, mounts: string[] = []) {
  const plan = sandboxPlan(args, work, mounts);
  if (plan.profile !== undefined && plan.profilePath) fs.writeFileSync(plan.profilePath, plan.profile);
  return spawnSync(plan.cmd, plan.argv, plan.opts);
}

// 把一棵树(不含 .git、node_modules)复制到新的临时目录;node_modules 以只读软链提供。
// 每次跑 PR 测试都在新副本里跑,测试改不到被检查的原树,也改不到后面门禁要读的东西。
export function freshCopy(src: string): string {
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
  const nm = path.join(src, "node_modules");
  if (fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(nm), path.join(dst, "node_modules"));
  return dst;
}

// 用 node --test 的 TAP 输出解析"每个文件里哪些具名测试通过/失败"。
// 只认测试真的注册并执行后的结果;文件加载失败时 TAP 里只有文件级失败,不会出现具名测试。
const nmMount = (root: string) => { const nm = path.join(root, "node_modules"); return fs.existsSync(nm) ? [fs.realpathSync(nm)] : []; };

export function runNodeTests(root: string, files: string[], extraArgs: string[] = []): TestRun {
  const passed: NamedTest[] = [], failed: NamedTest[] = [];
  let output = "", exitOk = true;
  for (const file of files) {
    const work = freshCopy(root);
    let r: ReturnType<typeof sandboxed>;
    try { r = sandboxed([...extraArgs, "--test", "--test-reporter=tap", "--test-concurrency=1", file], work, nmMount(work)); }
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
  const testMemo = new Map<string, TestRun>();
  const readBase = (p: string) => { const r = gitRaw(root, "show", `${mergeBase}:${p}`); return r.status === 0 ? r.stdout : undefined; };
  return {
    root, branch, changed, files, read, readBase, pr,
    receipt: loadReceipt(root, receiptPath), receiptPath,
    specIds: specIdsFrom(read(SPEC_FILE)),
    // 同一次门禁运行里,G-RED / G-STUB / G-TAUTO 都要在真实实现上跑同一组测试文件:只跑一遍,结果共用。
    // 每次仍在新副本 + 沙箱里跑;共用的是同一输入(同一棵树、同一组文件)的结果。
    runTests: (fs_, cwd) => {
      if (cwd !== undefined && cwd !== root) return runNodeTests(cwd, fs_);
      const k = JSON.stringify([...fs_].sort());
      let r = testMemo.get(k);
      if (!r) { r = runNodeTests(root, fs_); testMemo.set(k, r); }
      return r;
    },
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
export function runGates(ctx: Ctx, gates: readonly Gate[]): GateResult[] {
  return gates.map((gate) => {
    try { return { gate, problems: gate.run(ctx) }; }
    catch (e) { return { gate, problems: [{ gate: gate.id, msg: `门禁自身出错:${(e as Error).message}` }] }; }
  });
}
