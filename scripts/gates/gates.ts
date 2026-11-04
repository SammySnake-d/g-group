// 各条机械门禁。每个门禁只读 Ctx,返回问题列表;空列表 = 放行。
// 门禁代码本身在 CI 里取自 main(trusted-gates.yml,pull_request_target),PR 里的版本只当被检查的数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { type Ctx, type Gate, type NamedTest, type Problem, copyTree, existing, isGoverned, isSrc, isTest, p, runNodeTests } from "./lib.ts";
import { analyzeTestFile, lintTestFile } from "./testlint.ts";
import { type Vendor, vendorOf } from "./vendor.ts";

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
  id: "G-REVIEW", rule: "R-01:审查人≠作者,自报厂商不同且都认得出,审查钉在当前内容 hash 上(来源真伪由 G-PROVENANCE 核对)",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt) return out;
    const { author, review: rv, waiver } = ctx.receipt;
    if (!author?.agent || !author.model || !author.session) return [p(g, "收据缺作者 agent/model/session")];
    if (!rv) return [p(g, "还没有独立审查")];
    if (rv.verdict !== "approve") out.push(p(g, `审查结论是 ${rv.verdict}`));
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

// ---------------------------------------------------------------- R-01 R-07 R-10(仅本机,由 merge.sh 跑后在 GitHub 上留 provenance 状态)
interface Turn { model?: string; toolCalls?: { name?: string; input?: unknown; result?: unknown }[] }
function readTurns(base: string, session: string): Turn[] | undefined {
  const [harness, id] = session.split(":");
  if (!harness || !id || id.includes("/") || id.includes("..")) return undefined;
  const f = path.join(base, harness, id, "turns.jsonl");
  if (!fs.existsSync(f)) return undefined;
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Turn);
}
const str = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x ?? ""));

export interface RoomEvent { seq: number; by: string; kind: string; text?: string; target?: number }
export function readRoomLog(rooms: string, room: string): RoomEvent[] {
  const dir = path.join(rooms, room, "log");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RoomEvent));
}

export const provenance: Gate = {
  id: "G-PROVENANCE", rule: "R-01 R-07 R-10:作者与审查的厂商以会话原始记录为准;豁免必须是用户本人对这一版的明确批准",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt?.review) return out;
    const { author, review: rv, waiver } = ctx.receipt;
    const base = process.env.MIRASIM_SESSIONS ?? path.join(os.homedir(), ".mirasim/sessions");

    // 作者:会话里每一轮只要碰过本仓库路径,该轮模型就算进产出模型集合(宁多勿少,对应 actual_producer_models[])
    const at = readTurns(base, author.session);
    const producers = new Set<Vendor>();
    if (!at) out.push(p(g, `作者会话记录不存在:${author.session}`));
    else {
      // 只要这一轮的工具调用碰过本仓库(按仓库名匹配,宁多勿少),这一轮的模型就算产出模型
      const repoName = process.env.GATE_REPO_NAME ?? "g-group";
      const esc = repoName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
      const touches = new RegExp(`(^|[^\\w-])${esc}(?![\\w-])`);
      for (const t of at) if ((t.toolCalls ?? []).some((c) => touches.test(str(c.input)))) producers.add(vendorOf(t.model));
      if (producers.size === 0) out.push(p(g, `作者会话 ${author.session} 里找不到对本仓库的任何操作`));
      if (producers.has("unknown")) out.push(p(g, "作者会话里有认不出厂商的产出轮次"));
      if (producers.size && !producers.has(vendorOf(author.model))) out.push(p(g, `作者自报 ${author.model},会话里实际产出厂商是 ${[...producers].join(",")}`));
    }

    // 审查:必须有一次工具调用,命令是 run-all.ts --hash,输出恰好等于 reviewed_hash;审查厂商取那一轮的模型
    const rt = readTurns(base, rv.session);
    let reviewer: Vendor = "unknown";
    if (!rt) out.push(p(g, `审查会话记录不存在:${rv.session}`));
    else {
      const hits = rt.filter((t) => (t.toolCalls ?? []).some((c) => /run-all\.ts/.test(str(c.input)) && /--hash/.test(str(c.input)) && str(c.result).trim() === rv.reviewed_hash));
      if (hits.length === 0) out.push(p(g, "审查会话里没有一次 run-all.ts --hash 的输出等于 reviewed_hash,无法证明审的是这一版"));
      else {
        const vs = new Set(hits.map((t) => vendorOf(t.model)));
        if (vs.size !== 1) out.push(p(g, `算出被审 hash 的轮次模型不一致:${[...vs].join(",")}`));
        reviewer = [...vs][0]!;
        if (reviewer !== vendorOf(rv.model)) out.push(p(g, `审查自报 ${rv.model},算出被审 hash 的那一轮实际是 ${reviewer}`));
      }
    }
    if (reviewer === "unknown" && rt) out.push(p(g, "审查那一轮的厂商认不出"));
    const sameVendor = reviewer !== "unknown" && producers.has(reviewer);

    // 豁免:只认群聊原始日志里用户本人(usr_ 开头)发的原文,包含"批准豁免"和当前内容 hash 前 12 位,且之后没有撤回或改写
    if (waiver) {
      const m = WAIVER_RE.exec(waiver.reason ?? "");
      const rooms = process.env.MIRASIM_ROOMS ?? path.join(os.homedir(), ".mirasim/chat/rooms");
      const log = readRoomLog(rooms, "g-group");
      const seq = m ? Number(m[1]) : -1;
      const msg = log.find((e) => e.seq === seq && e.kind === "message");
      const later = log.filter((e) => e.target === seq && (e.kind === "retract" || e.kind === "edit" || e.kind === "purge"));
      const want = ctx.contentHash().slice(0, 12);
      if (!msg) out.push(p(g, `豁免出处 ${waiver.reason} 在群聊原始日志里找不到`));
      else if (!msg.by.startsWith("usr_")) out.push(p(g, `豁免出处 ${waiver.reason} 不是用户本人发的(发送者 ${msg.by})`));
      else if (later.length) out.push(p(g, `豁免出处 ${waiver.reason} 之后被${later.map((e) => e.kind).join("/")}过,不认`));
      else if (!/批准豁免/.test(msg.text ?? "") || /不批准|拒绝|不同意/.test(msg.text ?? "")) out.push(p(g, `豁免出处 ${waiver.reason} 不是明确的"批准豁免"`));
      else if (!(msg.text ?? "").includes(want)) out.push(p(g, `豁免出处 ${waiver.reason} 没写当前内容 hash 前 12 位 ${want},不能用于这一版`));
      else if (sameVendor) console.log(`[${g}] Waived(by_user ${msg.by}):同厂商 ${reviewer},依据 ${waiver.reason}`);
    }
    if (sameVendor && !waiver) out.push(p(g, `审查厂商 ${reviewer} 在作者的产出厂商集合 {${[...producers].join(",")}} 里`));
    return out;
  },
};

// ---------------------------------------------------------------- R-02
// 本 PR 新增或改动的每一条测试(按文件+测试名识别,和 merge-base 比对测试体)都必须:
// 在收据点名的红提交上按名字失败(加载失败不算),并且现在按名字通过。门禁亲自检出红提交复跑。
export function changedTests(ctx: Ctx): NamedTest[] {
  const res: NamedTest[] = [];
  for (const f of existing(ctx, ctx.changed.filter(isTest))) {
    const now = analyzeTestFile(ctx.read(f) ?? "", f).tests;
    const before = new Map(analyzeTestFile(ctx.readBase(f) ?? "", f).tests.map((t) => [t.name, t.body]));
    for (const t of now) if (before.get(t.name) !== t.body) res.push({ file: f, name: t.name });
  }
  return res;
}

export const red: Gate = {
  id: "G-RED", rule: "R-02:先红后绿,新增/改动的每条测试在红提交上按名字失败、现在按名字通过",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const tests = changedTests(ctx);
    if (tests.length === 0) {
      if (existing(ctx, ctx.changed).some(isSrc)) out.push(p(g, "改了源码却没有新增或改动任何测试"));
      return out;
    }
    const files = [...new Set(tests.map((t) => t.file))];
    const now = ctx.runTests(files);
    const passedNow = new Set(now.passed.map(key));
    for (const t of tests) if (!passedNow.has(key(t))) out.push(p(g, `${key(t)} 现在没有通过`));
    const rr = ctx.receipt?.red;
    if (!rr?.commit) return [...out, p(g, "收据缺 red.commit(只含测试和空壳实现、测试会失败的那个提交)")];
    const snap = ctx.snapshot(rr.commit);
    if (!snap) return [...out, p(g, `红提交 ${rr.commit} 不存在`)];
    try {
      if (!snap.inRange) out.push(p(g, `红提交 ${rr.commit} 不属于本 PR(必须在 base 之后、HEAD 之前)`));
      const then = runNodeTests(snap.dir, files.filter((f) => fs.existsSync(path.join(snap.dir, f))));
      const failedThen = new Set(then.failed.map(key));
      for (const t of tests) if (!failedThen.has(key(t))) out.push(p(g, `${key(t)} 在红提交上没有按名字失败(文件加载失败不算,红提交要带空壳实现)`));
    } finally { snap.cleanup(); }
    return out;
  },
};

// ---------------------------------------------------------------- R-03
// 空实现红基线:每个源码函数体前插入"测试执行期间抛错"。模块加载照常(顶层常量也照常算),
// 只在 beforeEach 打开开关后,被测函数才变成空桩。基线通过的每条测试都必须在桩下按名字失败。
export const ARM_FLAG = "__gGroupGateStubArmed";
export function stubSource(code: string, file = "x.ts"): string {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const guard = `if (Reflect.get(globalThis, "${ARM_FLAG}")) throw new Error("__STUB__");`;
  const edits: [number, number, string][] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
      ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) && n.body) {
      const b = n.body;
      if (ts.isBlock(b)) edits.push([b.getStart(sf) + 1, b.getStart(sf) + 1, ` ${guard} `]);
      else edits.push([b.getStart(sf), b.getEnd(), `{ ${guard} return (${b.getText(sf)}); }`]);
      if (!ts.isBlock(b)) return; // 表达式体整段替换后不再深入,避免重叠编辑
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  edits.sort((a, b) => b[0] - a[0]);
  let s = code;
  for (const [a, b, t] of edits) s = s.slice(0, a) + t + s.slice(b);
  return s;
}

export const stub: Gate = {
  id: "G-STUB", rule: "R-03:空实现红基线,桩下仍通过、加载失败、没执行到的测试都判无效",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const files = existing(ctx, ctx.changed.filter(isTest));
    if (files.length === 0) return out;
    const baseline = ctx.runTests(files);
    if (baseline.passed.length === 0) return [p(g, "改动的测试文件在真实实现上没有任何具名测试通过")];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-stub-"));
    try {
      copyTree(ctx.root, tmp, ctx.files);
      for (const f of ctx.files.filter(isSrc)) fs.writeFileSync(path.join(tmp, f), stubSource(fs.readFileSync(path.join(tmp, f), "utf8"), f));
      const arm = path.join(tmp, "__gate_arm.mjs");
      fs.writeFileSync(arm, `import { beforeEach, afterEach } from "node:test";\nbeforeEach(() => { globalThis.${ARM_FLAG} = true; });\nafterEach(() => { globalThis.${ARM_FLAG} = false; });\n`);
      const stubbed = runNodeTests(tmp, files, ["--import", arm]);
      const failed = new Set(stubbed.failed.map(key));
      for (const t of baseline.passed) {
        if (!failed.has(key(t))) out.push(p(g, `${key(t)} 在全部实现换成空桩后没有按名字失败(仍通过、没执行或文件加载失败),没有测到被测代码`));
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return out;
  },
};

// ---------------------------------------------------------------- R-04
export const tautology: Gate = {
  id: "G-TAUTO", rule: "R-04:拒绝同语反复测试(按 node:test 真实导入识别;无断言、断言不判源码结果、恒定断言、skip/only)",
  run(ctx) {
    const out: Problem[] = [];
    const files = existing(ctx, ctx.changed.filter(isTest));
    for (const f of files) for (const e of lintTestFile(ctx.read(f) ?? "", f)) out.push(p(this.id, `${f} ${e}`));
    // 运行时实际注册的测试必须和静态识别出来的一一对应,否则说明有别名/间接注册绕过了静态分析
    if (files.length) {
      const run = ctx.runTests(files);
      const runtime = new Set([...run.passed, ...run.failed].filter((t) => t.name !== "<文件级失败>").map(key));
      const statik = new Set(files.flatMap((f) => analyzeTestFile(ctx.read(f) ?? "", f).tests.filter((t) => !t.modifiers.some((m) => /^(skip|todo)$/.test(m))).map((t) => key({ file: f, name: t.name }))));
      for (const k of runtime) if (!statik.has(k)) out.push(p(this.id, `${k} 运行时注册了,但静态分析没识别出来(别名或间接注册),无法审查它的断言`));
      for (const k of statik) if (!runtime.has(k)) out.push(p(this.id, `${k} 静态识别到了,但运行时没执行`));
    }
    // 测试文件之外的地方也不许冒出测试(例如源码里偷偷注册 test)
    for (const f of existing(ctx, ctx.changed.filter(isSrc))) if (/["'](?:node:)?test["']/.test(ctx.read(f) ?? "")) out.push(p(this.id, `${f} 不是 .test.ts 却导入了 node:test`));
    return out;
  },
};

// ---------------------------------------------------------------- 工作流防篡改
// PR 自己的 workflow 不许冒充受保护的检查名、不许拿写权限、不许用 pull_request_target
export const PROTECTED_CONTEXTS = ["trusted-gates", "provenance"];
export const workflow: Gate = {
  id: "G-WORKFLOW", rule: "R-18:PR 的 workflow 不得冒充受保护检查、不得申请写权限或 pull_request_target",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!ctx.files.includes(".github/workflows/trusted-gates.yml")) out.push(p(g, "缺 .github/workflows/trusted-gates.yml"));
    for (const f of ctx.files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) && f !== ".github/workflows/trusted-gates.yml")) {
      const y = ctx.read(f) ?? "";
      if (/pull_request_target/.test(y)) out.push(p(g, `${f} 用了 pull_request_target`));
      for (const c of PROTECTED_CONTEXTS) if (new RegExp(`(^|[^\\w-])${c}([^\\w-]|$)`, "m").test(y)) out.push(p(g, `${f} 出现了受保护检查名 ${c}`));
      if (/write-all|:\s*write\b/.test(y)) out.push(p(g, `${f} 申请了写权限`));
      if (/\/statuses\/|check-runs|checks:\s/.test(y)) out.push(p(g, `${f} 在写提交状态或检查结果`));
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
