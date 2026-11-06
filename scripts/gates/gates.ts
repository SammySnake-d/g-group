// 各条机械门禁。每个门禁只读 Ctx,返回问题列表;空列表 = 放行。
// 门禁代码本身在 CI 里取自 main(trusted-gates.yml,pull_request_target),PR 里的版本只当被检查的数据。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import YAML from "yaml";
import { type Ctx, type Gate, GIT_SAFE_ARGS, gitEnv, type NamedTest, type Problem, copyTree, existing, isGoverned, isSrc, isTest, p, runNodeTests } from "./lib.ts";
import { analyzeTestFile, lintTestFile } from "./testlint.ts";
import { type Vendor, vendorOf } from "./vendor.ts";

// 门禁策略取自裁判自己所在目录(CI 里是 main 上那份),PR 改不了它
export interface Policy { allowedReviewers: string[]; defaultReviewer: string; reviewerHarness: string; reviewerHarnessOf: Record<string, string>; assistantIds: Record<string, string>; source: string }
/** 审查人对应的会话 harness:codex/astra 跑在 codex,claude 跑在 claude;没登记的退回默认 */
export const harnessOf = (agent: string) => (Object.hasOwn(POLICY.reviewerHarnessOf, agent) ? POLICY.reviewerHarnessOf[agent]! : POLICY.reviewerHarness);
/** 递归冻结(R5-03/R6-03):导出的策略、常量与门禁对象参与判定,外部赋值、push、删除、改嵌套、换 run/id/rule、加属性都不能改变后续门禁行为 */
export function deepFreeze<T>(x: T): Readonly<T> {
  if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); }
  return x;
}
export const POLICY: Readonly<Policy> = deepFreeze(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "policy.json"), "utf8")) as Policy);

const needsReceipt = (ctx: Ctx) => ctx.changed.some(isGoverned);
const STATUSES = new Set(["通过", "失败", "未测", "不适用"]);
const key = (t: NamedTest) => `${t.file} › ${t.name}`;
export const WAIVER_RE = /^g-group#(\d+)$/;

// ---------------------------------------------------------------- R-06 R-08 R-15
export const trace: Gate = {
  id: "G-TRACE", rule: "R-06 R-08 R-15:受管改动必须有收据,条目对上验收文档,状态四选一,通过要有证据",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx)) return out;
    const r = ctx.receipt;
    if (!r) return [p(g, `有受管改动(${ctx.changed.filter(isGoverned).slice(0, 3).join(", ")}…)但缺收据 ${ctx.receiptPath}`)];
    if (!Array.isArray(r.acceptance) || r.acceptance.length === 0) out.push(p(g, "收据没有任何验收条目"));
    for (const a of r.acceptance ?? []) {
      if (!ctx.specIds.has(a.id)) out.push(p(g, `${a.id} 不在验收文档里`));
      if (!STATUSES.has(a.status)) out.push(p(g, `${a.id} 状态 "${a.status}" 不是 通过/失败/未测/不适用`));
      if (a.status === "通过") {
        if (!a.evidence) out.push(p(g, `${a.id} 标了通过但没写证据路径`));
        else if (!ctx.files.includes(a.evidence)) out.push(p(g, `${a.id} 的证据 ${a.evidence} 不在仓库里`));
      }
      if (a.status === "未测" && !a.reason) out.push(p(g, `${a.id} 未测但没写原因`));
      if (a.status === "不适用" && (!a.reason || !a.approver)) out.push(p(g, `${a.id} 不适用但缺理由或批准人`));
    }
    if (!r.unverifiable || !/\b(?:AC|V|R)-M?\d+\b/.test(r.unverifiable)) out.push(p(g, "收据第 7 栏(unverifiable)缺失或没点到具体条目 ID"));
    return out;
  },
};

// ---------------------------------------------------------------- R-01(CI 可查的部分)
export const review: Gate = {
  id: "G-REVIEW", rule: "R-01:审查人限 Codex/Astra/Claude/Argon(g-group#1531、g-group#2943、g-group#3199 原则 68,默认 Codex;Claude 审 Codex 写的 PR,Argon 备用),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt) return out;
    const { author, review: rv, waiver } = ctx.receipt;
    if (!author?.agent || !author.model || !author.session) return [p(g, "收据缺作者 agent/model/session")];
    if (!rv) return [p(g, "还没有独立审查")];
    if (rv.verdict !== "approve") out.push(p(g, `审查结论是 ${rv.verdict}`));
    if (!POLICY.allowedReviewers.includes(rv.agent)) out.push(p(g, `审查人必须是 ${POLICY.allowedReviewers.join(" 或 ")} 之一(用户 ${POLICY.source} 定的,默认 ${POLICY.defaultReviewer}),实际是 ${rv.agent}`));
    if (rv.agent === author.agent) out.push(p(g, `审查人与作者是同一个(${rv.agent})`));
    const va = vendorOf(author.model), vr = vendorOf(rv.model);
    if (va === "unknown") out.push(p(g, `作者模型厂商认不出:${author.model}`));
    if (vr === "unknown") out.push(p(g, `审查模型厂商认不出:${rv.model}`));
    if (waiver && !WAIVER_RE.test(waiver.reason ?? "")) out.push(p(g, `豁免出处格式应为 g-group#<消息号>,实际 "${waiver.reason}"`));
    if (va !== "unknown" && va === vr && !waiver) out.push(p(g, `作者与审查同为 ${va},且没有用户豁免`));
    const h = ctx.contentHash();
    if (rv.reviewed_hash !== h) out.push(p(g, `审查对应的内容 ${String(rv.reviewed_hash).slice(0, 12)} ≠ 当前 ${h.slice(0, 12)},审后改过受管内容,需要重审`));
    return out;
  },
};

// ---------------------------------------------------------------- R-01 R-07 R-10(仅本机,merge.sh 跑通后在 GitHub 上写 provenance 状态)
// 本门禁在 --local 模式下排在所有门禁之前:会话与群聊记录在执行任何 PR 代码之前读完;PR 代码另在沙箱里跑,读写不到这些目录。
interface ToolCall { name?: string; input?: unknown; result?: unknown }
interface Turn { model?: string; toolCalls?: ToolCall[] }
// 判定用的是内部私有快照;导出的只是冻结数组副本,改它不影响判定(R5-03:Set 冻结不住 add/delete)
const HARNESS_LIST: readonly string[] = deepFreeze(["claude", "codex", "pi"]);
export const HARNESSES: readonly string[] = HARNESS_LIST;
const SESSION_RE = /^([a-z]+):([A-Za-z0-9-]+)$/;
const realHome = () => os.userInfo().homedir;
export const sessionsRoot = () => process.env.MIRASIM_SESSIONS ?? path.join(realHome(), ".mirasim/sessions");
export const roomsRoot = () => process.env.MIRASIM_ROOMS ?? path.join(realHome(), ".mirasim/chat/rooms");

type Loaded = { ok: true; turns: Turn[]; workdir: string | undefined } | { ok: false; why: string };
/** 严格解析 <harness>:<id>,realpath 之后必须仍在会话根目录里(防 ../ 与软链逃逸) */
export function loadSession(base: string, session: string): Loaded {
  const m = SESSION_RE.exec(typeof session === "string" ? session : "");
  if (!m) return { ok: false, why: `格式必须是 <harness>:<id>(id 只含字母、数字和 -),实际 "${session}"` };
  if (!HARNESS_LIST.includes(m[1]!)) return { ok: false, why: `harness "${m[1]}" 不在白名单 ${HARNESS_LIST.join("/")} 里` };
  let root: string;
  try { root = fs.realpathSync(base); } catch { return { ok: false, why: `会话根目录 ${base} 不存在` }; }
  const inside = (f: string) => f.startsWith(root + path.sep);
  let real: string;
  try { real = fs.realpathSync(path.join(root, m[1]!, m[2]!, "turns.jsonl")); } catch { return { ok: false, why: `会话记录不存在:${session}` }; }
  if (!inside(real)) return { ok: false, why: `会话记录经软链指到了会话根目录之外(${real})` };
  const turns = fs.readFileSync(real, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Turn);
  let workdir: string | undefined;
  try {
    const rec = fs.realpathSync(path.join(path.dirname(real), "record.json"));
    if (inside(rec)) { const r = JSON.parse(fs.readFileSync(rec, "utf8")) as { workdir?: unknown }; if (typeof r.workdir === "string") workdir = r.workdir; }
  } catch { /* 没有 record.json:工作目录未知 */ }
  return { ok: true, turns, workdir };
}
const str = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x ?? ""));
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}
function parseInput(x: unknown): Record<string, unknown> {
  if (typeof x === "string") {
    try { const j: unknown = JSON.parse(x); if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>; } catch { /* 不是 JSON,按原文处理 */ }
    return { raw: x };
  }
  return (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
}
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|applypatch|str_replace|fs_write|create_file|write_file|patch)$/i;
const SHELL_TOOLS = /^(bash|shell|execute_bash|exec_command|run_shell|local_shell|terminal)$/i;
/**
 * 这一轮有没有改过本仓库:路径按工具 cwd、会话 workdir 解析成绝对路径再判断;
 * 写操作类工具(文件写入、补丁、shell)只要有一个路径判定不了,就按"改过"算(宁多勿少)。
 */
export function turnTouchesRepo(t: Turn, workdir: string | undefined, inRepo: (abs: string) => boolean): boolean {
  for (const c of t.toolCalls ?? []) {
    const inp = parseInput(c.input);
    const cwd = [inp.cwd, inp.workdir, inp.working_directory].find((v): v is string => typeof v === "string") ?? workdir;
    const resolve = (p: string): string | undefined => {
      const q = p.replace(/^["']|["']$/g, "");
      if (q.startsWith("~/")) return path.join(realHome(), q.slice(2));
      if (path.isAbsolute(q)) return path.normalize(q);
      return cwd ? path.resolve(cwd, q) : undefined;
    };
    const cands: string[] = [];
    for (const k of ["file_path", "path", "notebook_path", "filePath", "target_file"]) if (typeof inp[k] === "string") cands.push(inp[k] as string);
    for (const s of strings(inp)) {
      for (const m of s.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) cands.push(m[1]!.trim());
      for (const m of s.matchAll(/^\*\*\* Move to: (.+)$/gm)) cands.push(m[1]!.trim());
      for (const m of s.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm)) cands.push(m[1]!);
      for (const m of s.matchAll(/(?:^|[\s"'=:(])((?:~\/|\/)[^\s"';|&<>()]+)/g)) cands.push(m[1]!);
    }
    const resolved = cands.map(resolve);
    if (cwd && path.isAbsolute(cwd) && inRepo(path.resolve(cwd))) return true;
    if (resolved.some((r) => r !== undefined && inRepo(r))) return true;
    const writes = WRITE_TOOLS.test(c.name ?? "") || SHELL_TOOLS.test(c.name ?? "");
    if (writes && (cands.length === 0 ? !cwd : resolved.some((r) => r === undefined))) return true;
  }
  return false;
}

/**
 * RR-14:这次工具调用是不是真的执行了 `node <…>scripts/gates/run-all.ts … --hash`。
 * 只认一条简单命令:没有 shell 元字符(注释、分隔、管道、重定向、替换、引号、换行),第一个词是 node,
 * node 后面紧跟的第一个参数就是 run-all.ts(不许先跑别的脚本或 -e),参数里有 --hash。
 * 这仍是对命令文本的解析;宿主结构化执行记录(可执行文件、argv、退出码)不在本片。
 */
export function isHashCall(input: unknown): boolean {
  const inp = parseInput(input);
  const cmd = [inp.command, inp.cmd, inp.raw].find((v) => typeof v === "string" || Array.isArray(v));
  const argv = Array.isArray(cmd) ? cmd.map(String) : typeof cmd === "string" ? (/[#;&|<>`$()\\'"\n\r{}*?!]/.test(cmd) ? undefined : cmd.trim().split(/\s+/)) : undefined;
  if (!argv || argv.length < 3) return false;
  if (!/^(?:\S*\/)?node$/.test(argv[0]!)) return false;
  if (!/^(?:\S*\/)?scripts\/gates\/run-all\.ts$/.test(argv[1]!)) return false;
  return argv.slice(2).some((a) => a === "--hash");
}

/**
 * RR-15:路径所在目录是不是同一仓库的另一个 clone。按"根提交有交集或 remote 指向同一地址"判断;
 * 不在任何 git 仓库里 → 不是;git 判不了(读不出根提交、命令出错) → 按是处理(保守)。
 */
type RepoId = { roots: Set<string>; remotes: Set<string> };
const normRemote = (u: string) => u.trim().replace(/\.git$/, "").replace(/\/+$/, "").replace(/^git@([^:]+):/, "$1/").replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "").toLowerCase();
function repoIdAt(dir: string): RepoId | null | "unknown" {
  const g = (...a: string[]) => spawnSync("git", [...GIT_SAFE_ARGS, "-c", "core.fsmonitor=false", ...a], { cwd: dir, encoding: "utf8", env: gitEnv(), timeout: 30_000 });
  const top = g("rev-parse", "--show-toplevel");
  if (top.status !== 0) return /not a git repository/i.test(top.stderr ?? "") ? null : "unknown";
  const roots = g("rev-list", "--max-parents=0", "--all");
  const remotes = g("remote", "-v");
  if (roots.status !== 0 || remotes.status !== 0) return "unknown";
  const rs = new Set(roots.stdout.split("\n").filter(Boolean));
  if (rs.size === 0) return "unknown";
  return { roots: rs, remotes: new Set(remotes.stdout.split("\n").map((l) => l.split(/\s+/)[1]).filter((u): u is string => !!u).map(normRemote)) };
}
export function sameRepoClone(rootReal: string): (abs: string) => boolean {
  const own = repoIdAt(rootReal);
  const memo = new Map<string, boolean>();
  return (abs) => {
    let d = abs;
    while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) return false; d = up; }
    try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch { return true; }
    const hit = memo.get(d);
    if (hit !== undefined) return hit;
    const id = repoIdAt(d);
    let same: boolean;
    if (id === null) same = false;
    else if (id === "unknown" || own === null || own === "unknown") same = true;
    else same = [...id.roots].some((r) => own.roots.has(r)) || [...id.remotes].some((r) => own.remotes.has(r) || r === rootReal.toLowerCase());
    memo.set(d, same);
    return same;
  };
}

export interface RoomEvent { seq: number; by: string; name?: string; kind: string; text?: string; target?: number; reply?: number; via?: unknown; forward?: unknown; quotes?: unknown }
export function readRoomLog(rooms: string, room: string): RoomEvent[] {
  const dir = path.join(rooms, room, "log");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RoomEvent));
}
/** 唯一有权批准豁免的人:仓库所有者。自检可用环境变量换成假身份。 */
export const OWNER = () => ({ name: process.env.GATE_OWNER_NAME ?? "39impacts.talent", uid: process.env.GATE_OWNER_UID ?? "usr_4f6ca5e0d86b4a73b5575724ab172bb0" });
const DIRECTIVE = /^批准豁免 PR#(\d+) ([0-9a-f]{12})$/;
/** 豁免只认结构化授权;返回 undefined 表示有效,否则返回不认的原因 */
export function waiverProblem(log: RoomEvent[], seq: number, by: string, pr: number | undefined, hash12: string): string | undefined {
  const own = OWNER();
  if (by !== own.name) return `的豁免人 ${by} 不是仓库所有者 ${own.name},无权批准`;
  const msg = log.find((e) => e.seq === seq && e.kind === "message");
  if (!msg) return "在群聊原始日志里找不到";
  if (msg.by !== own.uid || msg.name !== own.name) return `不是仓库所有者 ${own.name}(${own.uid}) 本人发的(实际发送者 ${msg.name ?? "?"} / ${msg.by})`;
  if (msg.via !== undefined || msg.forward !== undefined) return "是转发或代发的消息,不认";
  const later = log.filter((e) => e.seq > seq && (e.target === seq || e.reply === seq || (Array.isArray(e.quotes) && e.quotes.includes(seq))));
  if (later.length) return `之后被${[...new Set(later.map((e) => (e.kind === "message" ? "引用" : e.kind)))].join("/")}过,不认`;
  // 整条消息(去掉首尾空白)必须恰为指令这一行:任何说明、否定、引用符号、代码块都让它不算授权
  const dm = DIRECTIVE.exec((msg.text ?? "").trim());
  if (!dm) return `不是一条格式为"批准豁免 PR#<号> <hash前12位>"的消息(整条消息去掉首尾空白后必须恰为这一行,不能有其他文字)`;
  const [, prs, h] = dm;
  if (pr === undefined) return "合并时没有传 --pr,无法核对豁免是不是给这个 PR 的";
  if (Number(prs) !== pr) return `批准的是 PR#${prs},不是本次的 PR#${pr}`;
  if (h !== hash12) return `批准的 hash 前 12 位 ${h} ≠ 当前 ${hash12},不能用于这一版`;
  return undefined;
}

export const provenance: Gate = {
  id: "G-PROVENANCE", rule: "R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是仓库所有者对这个 PR 这一版的结构化批准",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt?.review) return out;
    const { author, review: rv, waiver } = ctx.receipt;
    const base = sessionsRoot();
    if (author.session === rv.session) out.push(p(g, "作者和审查用的是同一个会话"));

    const repoName = process.env.GATE_REPO_NAME ?? "g-group";
    const rootReal = fs.realpathSync(ctx.root);
    const clone = sameRepoClone(rootReal);
    const inRepo = (abs: string) => abs.split(path.sep).includes(repoName) || abs === rootReal || abs.startsWith(rootReal + path.sep) || clone(abs);
    const at = loadSession(base, author.session);
    const producers = new Set<Vendor>();
    if (!at.ok) out.push(p(g, `作者会话不可信:${at.why}`));
    else {
      for (const t of at.turns) if (turnTouchesRepo(t, at.workdir, inRepo)) producers.add(vendorOf(t.model));
      if (producers.size === 0) out.push(p(g, `作者会话 ${author.session} 里找不到对本仓库的任何操作`));
      if (producers.has("unknown")) out.push(p(g, "作者会话里有认不出厂商的产出轮次"));
      if (producers.size && !producers.has(vendorOf(author.model))) out.push(p(g, `作者自报 ${author.model},会话里实际产出厂商是 ${[...producers].join(",")}`));
    }

    // 审查:必须有一次工具调用,命令是 run-all.ts --hash,输出恰好等于 reviewed_hash;审查厂商取那一轮的模型
    const rt = loadSession(base, rv.session);
    let reviewer: Vendor = "unknown";
    // 审查人限 Codex/Astra/Claude/Argon(g-group#1531、#2943、#3199):会话 harness 按 policy.reviewerHarnessOf(codex/astra → codex,claude/argon → claude),厂商按会话里实际的模型核对(下面),不认自报。
    // record.json 没有区分助手的字段;群聊日志里宿主写的派活卡片(session → assistant)若存在,必须与收据的审查人一致。
    if (!rv.session.startsWith(`${harnessOf(rv.agent)}:`)) out.push(p(g, `审查人 ${rv.agent} 的审查会话必须是 ${harnessOf(rv.agent)} 会话(${POLICY.source}),实际 ${rv.session}`));
    else {
      const want = POLICY.assistantIds[rv.agent];
      const cards = readRoomLog(roomsRoot(), "g-group").flatMap((e) => {
        const c = (e as { card?: { type?: string; session?: string; assistant?: string } }).card;
        return e.by.startsWith("ai-") && c?.type === "dispatch" && c.session === rv.session ? [c.assistant] : [];
      });
      const wrong = cards.filter((a) => a !== want);
      if (wrong.length) out.push(p(g, `审查会话 ${rv.session} 是派给 ${wrong.join(",")} 的,和收据里的审查人 ${rv.agent}(${want ?? "未登记"}) 对不上`));
    }
    if (!rt.ok) out.push(p(g, `审查会话不可信:${rt.why}`));
    else {
      const hits = rt.turns.filter((t) => (t.toolCalls ?? []).some((c) => isHashCall(c.input) && str(c.result).trim() === rv.reviewed_hash));
      if (hits.length === 0) out.push(p(g, "审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash,无法证明审的是这一版"));
      else {
        const vs = new Set(hits.map((t) => vendorOf(t.model)));
        if (vs.size !== 1) out.push(p(g, `算出被审 hash 的轮次模型不一致:${[...vs].join(",")}`));
        reviewer = [...vs][0]!;
        if (reviewer !== vendorOf(rv.model)) out.push(p(g, `审查自报 ${rv.model},算出被审 hash 的那一轮实际是 ${reviewer}`));
      }
      if (reviewer === "unknown") out.push(p(g, "审查那一轮的厂商认不出"));
    }
    const sameVendor = reviewer !== "unknown" && producers.has(reviewer);

    if (waiver) {
      const m = WAIVER_RE.exec(waiver.reason ?? "");
      const why = m ? waiverProblem(readRoomLog(roomsRoot(), "g-group"), Number(m[1]), waiver.by, ctx.pr, ctx.contentHash().slice(0, 12)) : "格式不对";
      if (why) out.push(p(g, `豁免出处 ${waiver.reason} ${why}`));
      else if (sameVendor) console.log(`[${g}] Waived(by_user ${waiver.by}):同厂商 ${reviewer},依据 ${waiver.reason}`);
    }
    if (sameVendor && !waiver) out.push(p(g, `审查厂商 ${reviewer} 在作者的产出厂商集合 {${[...producers].join(",")}} 里`));
    return out;
  },
};

// ---------------------------------------------------------------- 计数工具:测试身份按 file+name 计数(multiset),同名重复不会被去重吞掉
export function countKeys(ts_: NamedTest[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of ts_) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return m;
}
const normBody = (b: string) => b.replace(/\s+/g, "");

// ---------------------------------------------------------------- R-02
// 本 PR 新增或改动的每一条测试(按文件+测试名识别,和 merge-base 比对测试体)都必须:
// 红提交上的测试体与现在逐条一致(规范化后);把"现在的测试文件"放到红提交的实现上跑,按名字失败;现在按名字通过。
export function changedTests(ctx: Ctx): NamedTest[] {
  const res: NamedTest[] = [];
  for (const f of existing(ctx, ctx.changed.filter(isTest))) {
    const now = analyzeTestFile(ctx.read(f) ?? "", f).tests;
    const before = new Map(analyzeTestFile(ctx.readBase(f) ?? "", f).tests.map((t) => [t.name, normBody(t.body)]));
    for (const t of now) if (before.get(t.name) !== normBody(t.body)) res.push({ file: f, name: t.name });
  }
  return res;
}

/**
 * RR-11:测试的规格不只在测试体里,也在它静态 import 的测试依赖里(helper、fixtures、期望值)。
 * 测试依赖 = 测试文件(递归经由测试依赖)相对 import 的本仓库文件中,非源码的那些(isSrc 为假,含 fixtures/、.mjs/.js),
 * 以及没有任何函数体的源码模块(纯数据,换空桩也不变)。红重放时这些文件一律用现在的版本覆盖到红快照。
 */
export function testDeps(ctx: Ctx, testFiles: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const queue = [...testFiles];
  while (queue.length) {
    const f = queue.shift()!;
    const code = ctx.read(f) ?? "";
    const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (seen.has(dep) || !ctx.files.includes(dep) || isTest(dep)) continue;
      seen.add(dep);
      const depCode = ctx.read(dep) ?? "";
      const data = isSrc(dep) && stubSource(depCode, dep) === depCode;
      if (!isSrc(dep) || data) { out.push(dep); queue.push(dep); }
    }
  }
  return out;
}

export const red: Gate = {
  id: "G-RED", rule: "R-02:先红后绿,红提交上的测试与现在相同,现在的测试放到红提交实现上按名字失败、现在按名字通过",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const tests = changedTests(ctx);
    if (tests.length === 0) {
      if (existing(ctx, ctx.changed).some(isSrc)) out.push(p(g, "改了源码却没有新增或改动任何测试"));
      return out;
    }
    const files = [...new Set(tests.map((t) => t.file))];
    const now = countKeys(ctx.runTests(files).passed);
    for (const t of tests) if (now.get(key(t)) !== 1) out.push(p(g, `${key(t)} 现在没有恰好通过一次(通过 ${now.get(key(t)) ?? 0} 次)`));
    const rr = ctx.receipt?.red;
    if (!rr?.commit) return [...out, p(g, "收据缺 red.commit(只含测试和空壳实现、测试会失败的那个提交)")];
    const snap = ctx.snapshot(rr.commit);
    if (!snap) return [...out, p(g, `红提交 ${rr.commit} 不存在`)];
    try {
      if (!snap.inRange) out.push(p(g, `红提交 ${rr.commit} 不属于本 PR(必须在 base 之后、HEAD 之前)`));
      // 同一份规格:红提交上的测试体必须和现在逐条一致
      for (const f of files) {
        const redFile = path.join(snap.dir, f);
        const redTests = fs.existsSync(redFile) ? analyzeTestFile(fs.readFileSync(redFile, "utf8"), f).tests : [];
        const redBodies = new Map(redTests.map((t) => [t.name, normBody(t.body)]));
        for (const t of analyzeTestFile(ctx.read(f) ?? "", f).tests) {
          if (!tests.some((x) => x.file === f && x.name === t.name)) continue;
          if (!redBodies.has(t.name)) out.push(p(g, `${f} › ${t.name} 在红提交上不存在`));
          else if (redBodies.get(t.name) !== normBody(t.body)) out.push(p(g, `${f} › ${t.name} 在红提交上的测试体和现在不同(先红的不是同一份规格)`));
        }
        // 把现在的测试文件放到红提交的实现上跑
        fs.mkdirSync(path.dirname(redFile), { recursive: true });
        fs.writeFileSync(redFile, ctx.read(f) ?? "");
      }
      for (const d of testDeps(ctx, files)) {
        const target = path.join(snap.dir, d);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, ctx.read(d) ?? "");
      }
      const then = countKeys(runNodeTests(snap.dir, files).failed);
      for (const t of tests) if (then.get(key(t)) !== 1) out.push(p(g, `${key(t)} 放到红提交的实现上没有按名字失败(文件加载失败不算,红提交要带空壳实现)`));
    } finally { snap.cleanup(); }
    return out;
  },
};

// ---------------------------------------------------------------- R-03
// 空实现红基线:每个源码函数体前插入"测试执行期间抛错"。模块加载照常(顶层常量也照常算),
// 只在 beforeEach 打开开关后,被测函数才变成空桩。基线通过的每条测试都必须在桩下按名字失败。
export const ARM_FLAG = "__gGroupGateStubArmed";
type FnNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration;
const isFn = (n: ts.Node): n is FnNode => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
export function stubSource(code: string, file = "x.ts"): string {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const guard = `if (Reflect.get(globalThis, "${ARM_FLAG}")) throw new Error("__STUB__");`;
  const edits: [number, number, string][] = [];
  const visit = (n: ts.Node) => {
    if (isFn(n) && n.body) {
      const b = n.body;
      if (ts.isBlock(b)) edits.push([b.getStart(sf) + 1, b.getStart(sf) + 1, ` ${guard} `]);
      else { edits.push([b.getStart(sf), b.getEnd(), `{ ${guard} return (${b.getText(sf)}); }`]); return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  edits.sort((a, b) => b[0] - a[0]);
  let s = code;
  for (const [a, b, t] of edits) s = s.slice(0, a) + t + s.slice(b);
  return s;
}

// 返回值变异:声明返回 number / string / boolean 的函数,测试执行期间把每个 return 的值换成同类型的错误值(不抛错)。
// 抛错只能证明"测试调用了它",换错值才能证明"测试检查了它算出来的结果"。
export const MUT_HIT = "__gGroupGateMutHit";
export const MUT_MARK = "__GATE_MUT_HIT__";
export function mutateReturns(code: string, file = "x.ts"): { code: string; count: number } {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: [number, number, string][] = [];
  const wrong = (kind: string, expr: string) => {
    // 打开开关时先记下"这条测试碰到了被变异的 return",再返回错值
    const armed = `(Reflect.get(globalThis, "${ARM_FLAG}") && Reflect.set(globalThis, "${MUT_HIT}", true))`;
    if (kind === "number") return `(${armed} ? ((${expr}) + 7919) : (${expr}))`;
    if (kind === "string") return `(${armed} ? (String(${expr}) + "\\u0000mut") : (${expr}))`;
    return `(${armed} ? !(${expr}) : (${expr}))`;
  };
  const kindOf = (t: ts.TypeNode | undefined): string | undefined => {
    if (!t) return undefined;
    if (t.kind === ts.SyntaxKind.NumberKeyword) return "number";
    if (t.kind === ts.SyntaxKind.StringKeyword) return "string";
    if (t.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
    return undefined;
  };
  const visit = (n: ts.Node) => {
    if (isFn(n) && n.body) {
      const k = kindOf(n.type);
      if (k) {
        if (!ts.isBlock(n.body)) edits.push([n.body.getStart(sf), n.body.getEnd(), wrong(k, n.body.getText(sf))]);
        else {
          const rets = (x: ts.Node) => {
            if (x !== n && isFn(x)) return;
            if (ts.isReturnStatement(x) && x.expression) edits.push([x.expression.getStart(sf), x.expression.getEnd(), wrong(k, x.expression.getText(sf))]);
            ts.forEachChild(x, rets);
          };
          rets(n.body);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // 去掉被外层编辑包住的内层编辑(表达式体里的嵌套函数)
  const kept = edits.filter((e, i) => !edits.some((o, j) => j !== i && o[0] <= e[0] && o[1] >= e[1] && (o[0] !== e[0] || o[1] !== e[1])));
  kept.sort((a, b) => b[0] - a[0]);
  let s = code;
  for (const [a, b, t] of kept) s = s.slice(0, a) + t + s.slice(b);
  return { code: s, count: kept.length };
}

const ARM_SRC = `import { beforeEach, afterEach } from "node:test";\nbeforeEach(() => { globalThis.${MUT_HIT} = false; globalThis.${ARM_FLAG} = true; });\nafterEach((t) => { globalThis.${ARM_FLAG} = false; if (globalThis.${MUT_HIT}) console.log("${MUT_MARK}" + JSON.stringify(t.name)); });\n`;
/** 从 TAP 输出里读出"哪些测试执行时碰到了被变异的 return"(按 runNodeTests 的 ### 文件 分段) */
export function mutHits(output: string): Set<string> {
  const hits = new Set<string>();
  let file = "";
  for (const line of output.split("\n")) {
    const h = /^### (.+)$/.exec(line);
    if (h) { file = h[1]!; continue; }
    const i = line.indexOf(MUT_MARK);
    if (i < 0) continue;
    try { hits.add(`${file} › ${JSON.parse(line.slice(i + MUT_MARK.length).trim()) as string}`); } catch { /* 标记残缺:不算命中 */ }
  }
  return hits;
}
function runTransformed(ctx: Ctx, files: string[], transform: (code: string, f: string) => string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-xform-"));
  try {
    copyTree(ctx.root, tmp, ctx.files);
    for (const f of ctx.files.filter(isSrc)) fs.writeFileSync(path.join(tmp, f), transform(fs.readFileSync(path.join(tmp, f), "utf8"), f));
    fs.writeFileSync(path.join(tmp, "__gate_arm.mjs"), ARM_SRC);
    return runNodeTests(tmp, files, ["--import", "./__gate_arm.mjs"]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const stub: Gate = {
  id: "G-STUB", rule: "R-03 R-04:空实现红基线 + 返回值变异校准,桩下或错值下仍通过、没执行、加载失败的测试都判无效",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const files = existing(ctx, ctx.changed.filter(isTest));
    if (files.length === 0) return out;
    const baseline = ctx.runTests(files);
    if (baseline.passed.length === 0) return [p(g, "改动的测试文件在真实实现上没有任何具名测试通过")];
    const base = countKeys(baseline.passed);
    for (const [k, n] of base) if (n !== 1) out.push(p(g, `${k} 在真实实现上通过了 ${n} 次,测试身份不唯一`));
    const stubbed = countKeys(runTransformed(ctx, files, stubSource).failed);
    for (const [k, n] of base) if ((stubbed.get(k) ?? 0) !== n) out.push(p(g, `${k} 在全部实现换成空桩后没有按名字失败(仍通过、没执行或文件加载失败),没有测到被测代码`));
    // 返回值变异(RR-12,按测试判定):执行时碰到被变异 return 的每一条测试,都必须在错值下按名字失败。
    // 只断言 typeof、只判一部分结果的测试会在错值下仍通过,同文件里有强测试也掩盖不了。
    let mutable = 0;
    const mutated = runTransformed(ctx, files, (c, f) => { const r = mutateReturns(c, f); mutable += r.count; return r.code; });
    if (mutable > 0) {
      const killed = countKeys(mutated.failed);
      const hit = mutHits(mutated.output);
      for (const k of base.keys()) if (hit.has(k) && (killed.get(k) ?? 0) === 0) out.push(p(g, `${k} 在被测函数返回错误值(不抛错)时仍通过,没有检查计算结果`));
      for (const f of files) {
        const mine = [...base.keys()].filter((k) => k.startsWith(`${f} › `));
        if (mine.length && !mine.some((k) => hit.has(k) || (killed.get(k) ?? 0) > 0)) out.push(p(g, `${f} 的测试在被测函数返回错误值(不抛错)时全部仍通过,没有检查计算结果`));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- R-04
export const tautology: Gate = {
  id: "G-TAUTO", rule: "R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、自比较、恒真、不可达、不判源码结果、skip/only;运行时与静态逐条计数一致)",
  run(ctx) {
    const out: Problem[] = [];
    const files = existing(ctx, ctx.changed.filter(isTest));
    for (const f of files) for (const e of lintTestFile(ctx.read(f) ?? "", f)) out.push(p(this.id, `${f} ${e}`));
    // 运行时实际注册的测试必须和静态识别出来的逐条计数一致,否则说明有别名/间接注册绕过了静态分析
    if (files.length) {
      const run = ctx.runTests(files);
      const runtime = countKeys([...run.passed, ...run.failed].filter((t) => t.name !== "<文件级失败>"));
      const statik = countKeys(files.flatMap((f) => analyzeTestFile(ctx.read(f) ?? "", f).tests.filter((t) => !t.modifiers.some((m) => /^(skip|todo)$/.test(m))).map((t) => ({ file: f, name: t.name }))));
      for (const k of new Set([...runtime.keys(), ...statik.keys()])) {
        const r = runtime.get(k) ?? 0, s = statik.get(k) ?? 0;
        if (r > 1) out.push(p(this.id, `${k} 运行时注册了 ${r} 次,测试名重复`));
        if (r > s) out.push(p(this.id, `${k} 运行时注册了 ${r} 次,静态只识别出 ${s} 条(别名或间接注册),无法审查多出来的断言`));
        else if (s > r) out.push(p(this.id, `${k} 静态识别到 ${s} 条,运行时只执行了 ${r} 次`));
      }
    }
    // 测试文件之外的地方也不许冒出测试(例如源码里偷偷注册 test)
    for (const f of existing(ctx, ctx.changed.filter(isSrc))) if (/["'](?:node:)?test["']/.test(ctx.read(f) ?? "")) out.push(p(this.id, `${f} 不是 .test.ts 却导入了 node:test`));
    return out;
  },
};

// ---------------------------------------------------------------- 工作流防篡改(R-18)
// 结构化解析 YAML(含锚点合并、引号、折叠标量);受保护检查名查 job id 和 name,name 含表达式一律拒绝。
export const PROTECTED_CONTEXTS: readonly string[] = deepFreeze(["trusted-gates", "provenance", "self-check"]);
const PERM_KEYS = ["actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses"];
function permProblems(where: string, perms: unknown): string[] {
  if (perms === undefined || perms === null) return [];
  if (typeof perms === "string") return /^read-all$/.test(perms.trim()) ? [] : [`${where} 的 permissions 是 "${perms}",只允许 read-all 或逐项 read/none`];
  if (typeof perms !== "object" || Array.isArray(perms)) return [`${where} 的 permissions 不是对象`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(perms as Record<string, unknown>)) {
    if (!PERM_KEYS.includes(k)) out.push(`${where} 申请了未知权限 ${k}`);
    const val = typeof v === "string" ? v.trim() : v;
    if (val !== "read" && val !== "none") out.push(`${where} 申请了写权限 ${k}: ${JSON.stringify(v)}`);
  }
  return out;
}
function events(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}
// RR-09:self-check 由 PR 自己的 YAML 运行,所以由 main 上的裁判结构化断言它无条件跑门禁自检与变异校验。
// self-check.yml 不存在时不在这里报:分支保护要求的 self-check 检查会挡住。
const SELF_CHECK_WF = ".github/workflows/self-check.yml";
const REQUIRED_SELF_CHECK_STEPS: { label: string; ok: (run: string) => boolean }[] = [
  { label: "npm test", ok: (r) => r === "npm test" },
  { label: "npm run gates:selftest", ok: (r) => r === "npm run gates:selftest" },
  { label: "npm run gates:mutation", ok: (r) => /^(GATE_MUTATION_JOBS=\d+ )?npm run gates:mutation$/.test(r) },
];
export const REQUIRED_GATE_SCRIPTS: Readonly<Record<string, string>> = deepFreeze({
  // g-group#2538:裸 node --test 在 glob 没匹配到文件时也退出 0;test-runner.ts 在 0 条用例时判失败
  test: 'node scripts/gates/test-runner.ts "packages/**/*.test.ts" "scripts/gates/*.test.ts"',
  "gates:selftest": "node scripts/gates/run-all.ts --self-test",
  "gates:mutation": "node scripts/gates/mutation.ts",
});
function selfCheckProblems(doc: Record<string, unknown>): string[] {
  const f = SELF_CHECK_WF;
  const jobs = doc.jobs && typeof doc.jobs === "object" ? (doc.jobs as Record<string, unknown>) : {};
  const jv = jobs["self-check"];
  if (!jv || typeof jv !== "object") return [`${f} 缺 job self-check`];
  const job = jv as Record<string, unknown>;
  const out: string[] = [];
  if (job.if !== undefined) out.push(`${f} 的 job self-check 带了 if,门禁自检与变异校验必须无条件运行`);
  if (job["continue-on-error"] !== undefined) out.push(`${f} 的 job self-check 带了 continue-on-error`);
  // shell / working-directory / defaults 都能让 run 的文字不变、实际不执行它
  if (doc.defaults !== undefined) out.push(`${f} 顶层带了 defaults,可能改掉必需步骤的 shell 或工作目录`);
  // GATE_* 是门禁/自检/变异的运行开关(只跑子集、超时、并发等),只许设沙箱镜像;并发只许写在变异命令前缀里
  const envs: [string, unknown][] = [["顶层", doc.env], ["job self-check", job.env], ...(Array.isArray(job.steps) ? (job.steps as unknown[]) : []).map((s, i) => [`第 ${i + 1} 步`, s && typeof s === "object" ? (s as Record<string, unknown>).env : undefined] as [string, unknown])];
  for (const [where, e] of envs) {
    if (e === undefined) continue;
    if (!e || typeof e !== "object" || Array.isArray(e)) { out.push(`${f} ${where}的 env 不是对象,无法核对门禁开关`); continue; }
    for (const k of Object.keys(e)) if (/^GATE_/.test(k) && k !== "GATE_SANDBOX_IMAGE") out.push(`${f} ${where}设置了门禁开关 ${k},self-check 只许设 GATE_SANDBOX_IMAGE`);
  }
  if (job.defaults !== undefined) out.push(`${f} 的 job self-check 带了 defaults,可能改掉必需步骤的 shell 或工作目录`);
  const steps = Array.isArray(job.steps) ? (job.steps as unknown[]) : [];
  for (const req of REQUIRED_SELF_CHECK_STEPS) {
    const hits = steps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as Record<string, unknown>).run === "string" && req.ok(((s as Record<string, unknown>).run as string).trim()));
    if (hits.length === 0) { out.push(`${f} 的 job self-check 缺必需步骤:run 为 ${req.label}`); continue; }
    for (const s of hits) {
      if (s.if !== undefined) out.push(`${f} 的必需步骤「${req.label}」带了 if,必须无条件运行`);
      if (s["continue-on-error"] !== undefined) out.push(`${f} 的必需步骤「${req.label}」带了 continue-on-error`);
      for (const k of ["shell", "working-directory"]) if (s[k] !== undefined) out.push(`${f} 的必需步骤「${req.label}」带了 ${k}`);
    }
  }
  return out;
}
function selfCheckScriptProblems(raw: string | undefined): string[] {
  let scripts: Record<string, unknown> = {};
  try { const j: unknown = raw === undefined ? {} : JSON.parse(raw); scripts = (j && typeof j === "object" && (j as { scripts?: unknown }).scripts && typeof (j as { scripts?: unknown }).scripts === "object" ? (j as { scripts: Record<string, unknown> }).scripts : {}); }
  catch { return ["package.json 解析失败,无法核对门禁脚本"]; }
  return Object.entries(REQUIRED_GATE_SCRIPTS).filter(([k, v]) => scripts[k] !== v).map(([k, v]) => `package.json 的 scripts["${k}"] 必须是 ${JSON.stringify(v)},现在是 ${JSON.stringify(scripts[k])}`);
}
export const workflow: Gate = {
  id: "G-WORKFLOW", rule: "R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限、不得写提交状态、不得用 pull_request_target",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!ctx.files.includes(".github/workflows/trusted-gates.yml")) out.push(p(g, "缺 .github/workflows/trusted-gates.yml"));
    for (const f of ctx.files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) && f !== ".github/workflows/trusted-gates.yml")) {
      const raw = ctx.read(f) ?? "";
      let doc: Record<string, unknown>;
      try {
        const d: unknown = YAML.parse(raw, { merge: true, uniqueKeys: true, maxAliasCount: 50 });
        if (!d || typeof d !== "object" || Array.isArray(d)) { out.push(p(g, `${f} 顶层不是对象`)); continue; }
        doc = d as Record<string, unknown>;
      } catch (e) { out.push(p(g, `${f} 解析失败:${(e as Error).message.split("\n")[0]}`)); continue; }
      const on = doc.on ?? doc.true; // YAML 1.1 里 on 会被读成 true
      if (events(on).some((e) => e === "pull_request_target" || e === "workflow_run")) out.push(p(g, `${f} 用了 pull_request_target 或 workflow_run`));
      for (const m of permProblems(`${f}`, doc.permissions)) out.push(p(g, m));
      if (typeof doc.name === "string" && /\$\{\{/.test(doc.name)) out.push(p(g, `${f} 的 workflow name 含表达式,无法静态确认它不是受保护检查名`));
      const jobs = doc.jobs && typeof doc.jobs === "object" ? (doc.jobs as Record<string, unknown>) : {};
      for (const [id, jv] of Object.entries(jobs)) {
        const job = (jv && typeof jv === "object" ? jv : {}) as Record<string, unknown>;
        const names = [id, ...(typeof job.name === "string" ? [job.name] : job.name !== undefined ? [JSON.stringify(job.name)] : [])];
        for (const n of names) {
          if (/\$\{\{/.test(n)) out.push(p(g, `${f} 的 job ${id} 名字含表达式 ${n},无法静态确认它不是受保护检查名`));
          const norm = n.trim().toLowerCase();
          for (const c of PROTECTED_CONTEXTS) {
            if (!(norm === c || norm.endsWith(` / ${c}`) || norm.endsWith(`/${c}`))) continue;
            // self-check 本来就由 PR 自己的 self-check.yml 产出;只许它在这一个文件里、以这一个 job 出现
            if (c === "self-check" && f === ".github/workflows/self-check.yml" && id === "self-check") continue;
            out.push(p(g, `${f} 的 job ${id} 冒充受保护检查名 ${c}`));
          }
        }
        for (const m of permProblems(`${f} 的 job ${id}`, job.permissions)) out.push(p(g, m));
        if (job.uses !== undefined) out.push(p(g, `${f} 的 job ${id} 调用了可复用 workflow,无法静态核对`));
      }
      if (/\/statuses\/|check-runs|check_runs|createCommitStatus|checks\.create/i.test(raw)) out.push(p(g, `${f} 在写提交状态或检查结果`));
      if (f === SELF_CHECK_WF) for (const m of selfCheckProblems(doc)) out.push(p(g, m));
    }
    if (ctx.files.includes(SELF_CHECK_WF)) for (const m of selfCheckScriptProblems(ctx.read("package.json"))) out.push(p(g, m));
    return out;
  },
};

// ---------------------------------------------------------------- 插件化分层
export const LAYERS = deepFreeze(["domain", "kernel", "adapter", "plugin", "app"] as const);
type Layer = (typeof LAYERS)[number];
const ALLOWED: Record<Layer, Layer[]> = {
  domain: [], kernel: ["domain"], adapter: ["domain", "kernel"], plugin: ["domain", "kernel"], app: ["domain", "kernel", "adapter", "plugin"],
};
type Manifest = { name?: string; gGroup?: { layer?: string } } & Partial<Record<"dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies", Record<string, string>>>;

export const layers: Gate = {
  id: "G-LAYER", rule: "插件化:包分层只能向下依赖,插件互不依赖,禁止相对路径跨包(import 与依赖声明都查)",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const pkgs = new Map<string, { dir: string; layer: Layer }>();
    const manifests: [string, Manifest][] = [];
    for (const f of ctx.files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f))) {
      const j = JSON.parse(ctx.read(f)!) as Manifest;
      manifests.push([f, j]);
      const layer = j.gGroup?.layer as Layer | undefined;
      if (!j.name || !layer || !LAYERS.includes(layer)) { out.push(p(g, `${f} 缺 name 或合法的 gGroup.layer(${LAYERS.join("/")})`)); continue; }
      pkgs.set(j.name, { dir: path.posix.dirname(f), layer });
    }
    for (const [f, j] of manifests) {
      const own = j.name ? pkgs.get(j.name) : undefined;
      if (!own) continue;
      for (const dep of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies, ...j.optionalDependencies })) {
        const d = pkgs.get(dep);
        if (d && dep !== j.name && !ALLOWED[own.layer].includes(d.layer)) out.push(p(g, `${f}:${own.layer} 层的 ${j.name} 在依赖声明里引用了 ${d.layer} 层的 ${dep}`));
      }
    }
    const ownerOf = (f: string) => [...pkgs.entries()].find(([, v]) => f.startsWith(`${v.dir}/`));
    for (const f of ctx.files.filter((f) => f.startsWith("packages/") && f.endsWith(".ts"))) {
      const own = ownerOf(f);
      if (!own) { out.push(p(g, `${f} 不属于任何声明了层级的包`)); continue; }
      const [ownName, ownInfo] = own;
      const sf = ts.createSourceFile(f, ctx.read(f) ?? "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const specs: string[] = [];
      const walk = (n: ts.Node) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
          const a = n.arguments[0];
          if (a && ts.isStringLiteralLike(a)) specs.push(a.text);
          else if (a) out.push(p(g, `${f} 有非字面量的动态 import/require,无法核对依赖方向`));
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
      for (const s of specs) {
        if (s.startsWith(".")) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), s));
          if (!target.startsWith(`${ownInfo.dir}/`)) out.push(p(g, `${f} 用相对路径 "${s}" 跨出了包 ${ownName}`));
          continue;
        }
        const dep = [...pkgs.entries()].find(([name]) => s === name || s.startsWith(`${name}/`));
        if (!dep || dep[0] === ownName) continue;
        if (!ALLOWED[ownInfo.layer].includes(dep[1].layer)) out.push(p(g, `${f}:${ownInfo.layer} 层的 ${ownName} 不能依赖 ${dep[1].layer} 层的 ${dep[0]}`));
      }
    }
    return out;
  },
};

// R6-03:数组与其中每个门禁对象(及嵌套)都深冻结;单独导出的 trace/review/... 是同一批对象,也一并不可改
export const ALL_GATES: readonly Gate[] = deepFreeze([trace, review, red, stub, tautology, workflow, layers]);
export const LOCAL_GATES: readonly Gate[] = deepFreeze([provenance]);
