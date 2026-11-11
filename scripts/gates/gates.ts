// 各条机械门禁。每个门禁只读 Ctx,返回问题列表;空列表 = 放行。
// 门禁代码本身在 CI 里取自 main(trusted-gates.yml,pull_request_target),PR 里的版本只当被检查的数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import YAML from "yaml";
import { type Ctx, type Gate, type NamedTest, type Problem, copyTree, existing, isGoverned, isSrc, isTest, p, runNodeTests } from "./lib.ts";
import { analyzeTestFile, lintTestFile } from "./testlint.ts";
import { type Vendor, vendorOf } from "./vendor.ts";

// 门禁策略取自裁判自己所在目录(CI 里是 main 上那份),PR 改不了它
export interface Policy { allowedReviewers: string[]; defaultReviewer: string; reviewerHarness: string; assistantIds: Record<string, string>; source: string }
export const POLICY: Policy = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "policy.json"), "utf8")) as Policy;

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
  id: "G-REVIEW", rule: "R-01:审查人限 Codex 或 Astra(g-group#1531,默认 Codex),审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)",
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
export const HARNESSES = new Set(["claude", "codex", "pi"]);
const SESSION_RE = /^([a-z]+):([A-Za-z0-9-]+)$/;
const realHome = () => os.userInfo().homedir;
export const sessionsRoot = () => process.env.MIRASIM_SESSIONS ?? path.join(realHome(), ".mirasim/sessions");
export const roomsRoot = () => process.env.MIRASIM_ROOMS ?? path.join(realHome(), ".mirasim/chat/rooms");

type Loaded = { ok: true; turns: Turn[]; workdir: string | undefined } | { ok: false; why: string };
/** 严格解析 <harness>:<id>,realpath 之后必须仍在会话根目录里(防 ../ 与软链逃逸) */
export function loadSession(base: string, session: string): Loaded {
  const m = SESSION_RE.exec(typeof session === "string" ? session : "");
  if (!m) return { ok: false, why: `格式必须是 <harness>:<id>(id 只含字母、数字和 -),实际 "${session}"` };
  if (!HARNESSES.has(m[1]!)) return { ok: false, why: `harness "${m[1]}" 不在白名单 ${[...HARNESSES].join("/")} 里` };
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
  const text = msg.text ?? "";
  const lines: string[] = [];
  let fence = false;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("```")) { fence = !fence; continue; }
    if (!fence && !l.startsWith(">")) lines.push(l);
  }
  const directive = lines.filter((l) => DIRECTIVE.test(l));
  if (directive.length !== 1 || text.split("批准豁免").length !== 2) return `不是一条格式为"批准豁免 PR#<号> <hash前12位>"的独立指令行(要整行、不在引号或代码块里、全文只此一处)`;
  const [, prs, h] = DIRECTIVE.exec(directive[0]!)!;
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
    const inRepo = (abs: string) => abs.split(path.sep).includes(repoName) || abs === rootReal || abs.startsWith(rootReal + path.sep);
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
    // 审查人限 Codex 或 Astra(g-group#1531):会话 harness 必须是 codex,厂商按会话里实际的模型核对(下面),不认自报。
    // record.json 没有区分助手的字段;群聊日志里宿主写的派活卡片(session → assistant)若存在,必须与收据的审查人一致。
    if (!rv.session.startsWith(`${POLICY.reviewerHarness}:`)) out.push(p(g, `审查会话必须是 ${POLICY.reviewerHarness} 会话(${POLICY.source}),实际 ${rv.session}`));
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
      const hits = rt.turns.filter((t) => (t.toolCalls ?? []).some((c) => /run-all\.ts/.test(str(c.input)) && /--hash/.test(str(c.input)) && str(c.result).trim() === rv.reviewed_hash));
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
      const then = countKeys(runNodeTests(snap.dir, files, [], ctx.root).failed);
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
export function mutateReturns(code: string, file = "x.ts"): { code: string; count: number } {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: [number, number, string][] = [];
  const wrong = (kind: string, expr: string) => {
    const armed = `Reflect.get(globalThis, "${ARM_FLAG}")`;
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

const ARM_SRC = `import { beforeEach, afterEach } from "node:test";\nbeforeEach(() => { globalThis.${ARM_FLAG} = true; });\nafterEach(() => { globalThis.${ARM_FLAG} = false; });\n`;
function runTransformed(ctx: Ctx, files: string[], transform: (code: string, f: string) => string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-xform-"));
  try {
    copyTree(ctx.root, tmp, ctx.files);
    for (const f of ctx.files.filter(isSrc)) fs.writeFileSync(path.join(tmp, f), transform(fs.readFileSync(path.join(tmp, f), "utf8"), f));
    fs.writeFileSync(path.join(tmp, "__gate_arm.mjs"), ARM_SRC);
    return runNodeTests(tmp, files, ["--import", "./__gate_arm.mjs"], ctx.root);
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
    // R15-05:基线逐文件、逐测试名核对,任一文件加载失败、退出异常、应执行的测试缺失或被 skip/todo,都不能拿别的文件的绿掩盖
    if (!baseline.exitOk) out.push(p(g, "真实实现上的基线运行退出异常(有文件加载失败或测试失败),不能据此校准"));
    for (const t of baseline.failed) out.push(p(g, t.name === "<文件级失败>" ? `${t.file} 在真实实现上文件加载失败,里面的测试没有执行` : `${key(t)} 在真实实现上失败`));
    for (const f of files) {
      const want = analyzeTestFile(ctx.read(f) ?? "", f).tests.map((t) => `${f} › ${t.name}`);
      if (![...base.keys()].some((k) => k.startsWith(`${f} › `))) out.push(p(g, `${f} 在真实实现上没有任何具名测试通过`));
      for (const k of want) if (!base.has(k)) out.push(p(g, `${k} 应执行但在真实实现上没有通过(缺失、skip 或 todo)`));
    }
    if (out.length) return out;
    const stubbed = countKeys(runTransformed(ctx, files, stubSource).failed);
    for (const [k, n] of base) if ((stubbed.get(k) ?? 0) !== n) out.push(p(g, `${k} 在全部实现换成空桩后没有按名字失败(仍通过、没执行或文件加载失败),没有测到被测代码`));
    // 返回值变异:只要源码里有可变异的 return,改动的测试文件里至少要有一条在错值下失败
    let mutable = 0;
    const mutated = runTransformed(ctx, files, (c, f) => { const r = mutateReturns(c, f); mutable += r.count; return r.code; });
    if (mutable > 0) {
      const killed = countKeys(mutated.failed);
      const ran = countKeys([...mutated.passed, ...mutated.failed]);
      for (const [k, n] of base) if ((ran.get(k) ?? 0) !== n) out.push(p(g, `${k} 在返回值变异下没有执行(缺失或文件加载失败),执行计数 ${ran.get(k) ?? 0}`));
      for (const f of files) {
        const mine = [...base.keys()].filter((k) => k.startsWith(`${f} › `));
        if (mine.length && !mine.some((k) => (killed.get(k) ?? 0) > 0)) out.push(p(g, `${f} 的测试在被测函数返回错误值(不抛错)时全部仍通过,没有检查计算结果`));
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
export const PROTECTED_CONTEXTS = ["trusted-gates", "provenance", "self-check"];
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
    }
    return out;
  },
};

// ---------------------------------------------------------------- 插件化分层
export const LAYERS = ["domain", "kernel", "adapter", "plugin", "app"] as const;
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

export const ALL_GATES: Gate[] = [trace, review, red, stub, tautology, workflow, layers];
export const LOCAL_GATES: Gate[] = [provenance];
