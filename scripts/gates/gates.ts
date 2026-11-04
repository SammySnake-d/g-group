// 各条机械门禁。每个门禁只读 Ctx,返回问题列表;空列表 = 放行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { type Ctx, type Gate, type Problem, copyTree, isSrc, isTest, p } from "./lib.ts";
import { vendorOf } from "./vendor.ts";

const needsReceipt = (ctx: Ctx) => ctx.changed.some((f) => f.startsWith("packages/") || f.startsWith("scripts/gates/"));
const STATUSES = new Set(["通过", "失败", "未测", "不适用"]);

// R-06/R-08/R-15:改了代码就必须有收据,收据里的每个条目都要对上验收文档,状态只能四选一
export const trace: Gate = {
  id: "G-TRACE", rule: "R-06 R-08 R-15:PR 必须对上验收条目,收据状态四选一,通过要有证据",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx)) return out;
    const r = ctx.receipt;
    if (!r) return [p(g, `改了代码但缺收据 ${ctx.receiptPath}`)];
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

// R-01:写审分离 + 跨厂商审查,审查钉在内容 hash 上,审后改代码即失效
export const review: Gate = {
  id: "G-REVIEW", rule: "R-01:审查人≠作者,审查模型与作者模型不同厂商且都不是 unknown,审查对应当前内容",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt) return out;
    const { author, review: rv, waiver } = ctx.receipt;
    if (!author?.agent || !author.model) return [p(g, "收据缺作者 agent/model")];
    if (!rv) return [p(g, "还没有独立审查")];
    if (rv.verdict !== "approve") out.push(p(g, `审查结论是 ${rv.verdict}`));
    if (rv.agent === author.agent) out.push(p(g, `审查人与作者是同一个(${rv.agent})`));
    const va = vendorOf(author.model), vr = vendorOf(rv.model);
    if (va === "unknown") out.push(p(g, `作者模型厂商认不出:${author.model}`));
    if (vr === "unknown") out.push(p(g, `审查模型厂商认不出:${rv.model}`));
    if (va !== "unknown" && va === vr) {
      if (waiver?.by && /g-group#\d+/.test(waiver.reason)) console.log(`[${g}] Waived(by_user ${waiver.by}):同厂商 ${va},依据 ${waiver.reason}`);
      else out.push(p(g, `作者与审查同为 ${va},且没有带群消息出处的用户豁免`));
    }
    const h = ctx.contentHash();
    if (rv.reviewed_hash !== h) out.push(p(g, `审查对应的内容 ${String(rv.reviewed_hash).slice(0, 12)} ≠ 当前 ${h.slice(0, 12)},审后改过代码,需要重审`));
    return out;
  },
};

// 仅本机:用 mirasim 会话原始记录核对收据里自报的模型,并确认审查会话里真的出现过 reviewed_hash
export const provenance: Gate = {
  id: "G-PROVENANCE", rule: "R-01/R-07:作者与审查的模型以会话原始记录为准,不认自报",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    if (!needsReceipt(ctx) || !ctx.receipt?.review) return out;
    const base = process.env.MIRASIM_SESSIONS ?? path.join(os.homedir(), ".mirasim/sessions");
    const check = (who: string, s: { session: string; model: string }, mustContain?: string) => {
      const [harness, id] = s.session.split(":");
      const f = path.join(base, harness ?? "", id ?? "", "turns.jsonl");
      if (!fs.existsSync(f)) { out.push(p(g, `${who} 会话记录不存在:${f}`)); return; }
      const text = fs.readFileSync(f, "utf8");
      const models = new Set([...text.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]!));
      if (models.size === 0) out.push(p(g, `${who} 会话里没有模型记录`));
      else if (![...models].some((m) => vendorOf(m) === vendorOf(s.model))) out.push(p(g, `${who} 自报 ${s.model},会话里实际是 ${[...models].join(",")}`));
      if (mustContain && !text.includes(mustContain)) out.push(p(g, `${who} 会话里没出现过 reviewed_hash,无法证明审的是这一版`));
    };
    check("作者", ctx.receipt.author);
    check("审查", ctx.receipt.review, ctx.receipt.review.reviewed_hash);
    return out;
  },
};

// R-02:先红后绿。收据指向本 PR 里的一个"红"提交,门禁检出那个提交亲自复跑:
// 点名的测试当时必须按名字失败,现在必须通过;每个改动的测试文件至少有一条被点名。不认贴进来的日志。
export const red: Gate = {
  id: "G-RED", rule: "R-02:先红后绿,门禁复跑红提交,点名测试当时失败、现在通过",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const tests = ctx.changed.filter((f) => isTest(f) && f.startsWith("packages/"));
    if (tests.length === 0) {
      if (ctx.changed.some(isSrc)) out.push(p(g, "改了源码却没有改动任何测试"));
      return out;
    }
    const rr = ctx.receipt?.red;
    if (!rr?.commit || !rr.tests?.length) return [p(g, "收据缺 red.commit / red.tests(先红记录)")];
    const snap = ctx.snapshot(rr.commit);
    if (!snap) return [p(g, `红提交 ${rr.commit} 不存在`)];
    try {
      if (!snap.inRange) out.push(p(g, `红提交 ${rr.commit} 不属于本 PR(必须是 base 之后、HEAD 之前的提交)`));
      const present = tests.filter((f) => fs.existsSync(path.join(snap.dir, f)));
      const then = ctx.runTests(present, snap.dir);
      const failedThen = new Set(then.failed);
      for (const t of rr.tests) if (!failedThen.has(t)) out.push(p(g, `"${t}" 在红提交上没有按名字失败`));
      for (const f of tests) {
        const now = ctx.runTests([f]);
        if (!now.ok) { out.push(p(g, `${f} 现在没通过`)); continue; }
        if (!now.passed.some((n) => rr.tests.includes(n))) out.push(p(g, `${f} 没有任何一条测试被列为先红`));
      }
    } finally { snap.cleanup(); }
    return out;
  },
};

// 把一个源文件的所有函数体换成 throw,用于空实现红基线
export function stubSource(code: string, file = "x.ts"): string {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: [number, number, string][] = [];
  const visit = (n: ts.Node) => {
    const body = (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) ? n.body : undefined;
    if (body) {
      const stub = ts.isConstructorDeclaration(n) ? "{ throw new Error('__STUB__'); }" : "{ throw new Error('__STUB__'); }";
      edits.push([body.getStart(sf), body.getEnd(), ts.isBlock(body) ? stub : `(() => ${stub})()`]);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  edits.sort((a, b) => b[0] - a[0]);
  let s = code;
  for (const [a, b, t] of edits) s = s.slice(0, a) + t + s.slice(b);
  return s;
}

// R-03:所有源码函数体换成 throw 之后,改动的测试必须全部变红;仍然绿的测试没有激活被测代码
export const stub: Gate = {
  id: "G-STUB", rule: "R-03:空实现红基线,桩替换后仍通过的测试判无效",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const tests = ctx.changed.filter((f) => isTest(f) && f.startsWith("packages/"));
    if (tests.length === 0) return out;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-stub-"));
    try {
      copyTree(ctx.root, tmp, ctx.files);
      for (const f of ctx.files.filter(isSrc)) fs.writeFileSync(path.join(tmp, f), stubSource(fs.readFileSync(path.join(tmp, f), "utf8"), f));
      for (const f of tests) {
        const r = ctx.runTests([f], tmp);
        for (const n of r.passed) out.push(p(g, `${f} › "${n}" 在全部实现换成空桩后仍通过,没有测到被测代码`));
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return out;
  },
};

// R-04:每条测试必须有断言,断言不能恒真,测试体必须用到从源码导入的符号
export function lintTestFile(code: string, file: string): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const fromSrc = (spec.startsWith(".") && !/\.test(\.ts)?$/.test(spec) && !spec.includes("fixtures")) || spec.startsWith("@g-group/");
    if (!fromSrc || !st.importClause || st.importClause.isTypeOnly) continue;
    const c = st.importClause;
    if (c.name) imported.add(c.name.text);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imported.add(c.namedBindings.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) imported.add(e.name.text);
  }
  const errs: string[] = [];
  const isLit = (e: ts.Expression) => ts.isLiteralExpression(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword || ts.isNoSubstitutionTemplateLiteral(e);
  const visitTest = (name: string, body: ts.Node) => {
    let asserts = 0, usesSrc = false;
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n) && imported.has(n.text)) usesSrc = true;
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (/^(assert(\.\w+)?|expect|t\.assert(\.\w+)?)$/.test(callee) || /^assert\./.test(callee)) {
          asserts++;
          const args = n.arguments;
          if (args.length > 0 && args.slice(0, Math.min(2, args.length)).every(isLit) && !/throws|rejects|fail/.test(callee)) errs.push(`"${name}":恒真/恒定断言 ${n.getText(sf).slice(0, 60)}`);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    if (asserts === 0) errs.push(`"${name}":没有任何断言`);
    if (!usesSrc) errs.push(`"${name}":没用到任何从源码导入的符号(只测 mock 或复制逻辑)`);
  };
  const find = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(test|it)$/.test(n.expression.text)) {
      const [nameArg, ...rest] = n.arguments;
      const fn = rest.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (nameArg && fn) { visitTest(ts.isStringLiteralLike(nameArg) ? nameArg.text : nameArg.getText(sf), fn); return; }
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  return errs;
}

export const tautology: Gate = {
  id: "G-TAUTO", rule: "R-04:拒绝同语反复测试(无断言、恒真断言、不碰被测源码)",
  run(ctx) {
    const out: Problem[] = [];
    for (const f of ctx.changed.filter((f) => isTest(f) && f.startsWith("packages/"))) {
      for (const e of lintTestFile(ctx.read(f) ?? "", f)) out.push(p(this.id, `${f} ${e}`));
    }
    return out;
  },
};

// 插件化架构的依赖方向:每个包在 package.json 的 gGroup.layer 声明层级,只能依赖更底层;
// 不准用相对路径跨包;插件之间互不依赖,只能经 plugin-api(kernel 层)协作
export const LAYERS = ["domain", "kernel", "adapter", "plugin", "app"] as const;
type Layer = (typeof LAYERS)[number];
const ALLOWED: Record<Layer, Layer[]> = {
  domain: [],
  kernel: ["domain"],
  adapter: ["domain", "kernel"],
  plugin: ["domain", "kernel"],
  app: ["domain", "kernel", "adapter", "plugin"],
};

export const layers: Gate = {
  id: "G-LAYER", rule: "R-M3/插件化:包分层依赖只能向下,禁止相对路径跨包,插件互不依赖",
  run(ctx) {
    const g = this.id, out: Problem[] = [];
    const pkgs = new Map<string, { dir: string; layer: Layer }>();
    for (const f of ctx.files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f))) {
      const j = JSON.parse(ctx.read(f)!) as { name?: string; gGroup?: { layer?: string } };
      const dir = path.posix.dirname(f);
      const layer = j.gGroup?.layer as Layer | undefined;
      if (!j.name || !layer || !LAYERS.includes(layer)) { out.push(p(g, `${f} 缺 name 或合法的 gGroup.layer(${LAYERS.join("/")})`)); continue; }
      pkgs.set(j.name, { dir, layer });
    }
    const ownerOf = (f: string) => [...pkgs.entries()].find(([, v]) => f.startsWith(v.dir + "/"));
    for (const f of ctx.changed.filter((f) => f.startsWith("packages/") && f.endsWith(".ts"))) {
      const own = ownerOf(f);
      if (!own) { out.push(p(g, `${f} 不属于任何声明了层级的包`)); continue; }
      const [ownName, ownInfo] = own;
      const sf = ts.createSourceFile(f, ctx.read(f) ?? "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const specs: string[] = [];
      const walk = (n: ts.Node) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text);
        ts.forEachChild(n, walk);
      };
      walk(sf);
      for (const s of specs) {
        if (s.startsWith(".")) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), s));
          if (!target.startsWith(ownInfo.dir + "/")) out.push(p(g, `${f} 用相对路径 "${s}" 跨出了包 ${ownName}`));
          continue;
        }
        const dep = [...pkgs.entries()].find(([name]) => s === name || s.startsWith(name + "/"));
        if (!dep) continue;
        const [depName, depInfo] = dep;
        if (depName === ownName) continue;
        if (!ALLOWED[ownInfo.layer].includes(depInfo.layer)) out.push(p(g, `${f}:${ownInfo.layer} 层的 ${ownName} 不能依赖 ${depInfo.layer} 层的 ${depName}`));
      }
    }
    return out;
  },
};

export const ALL_GATES: Gate[] = [trace, review, red, stub, tautology, layers];
export const LOCAL_GATES: Gate[] = [provenance];
