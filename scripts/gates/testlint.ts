// 测试文件静态分析:按 node:test / node:assert 的真实导入绑定找测试和断言(别名、命名空间都认)。
import ts from "typescript";

export interface TestDecl {
  name: string;
  body: string; // 测试函数源码,用来判断"新增或改过"
  modifiers: string[]; // skip / todo / only
  asserts: number;
  srcAsserts: number; // 断言参数里引用了被测源码结果的断言数
  constAsserts: string[];
}
export interface TestFileInfo { tests: TestDecl[]; errors: string[] }

const TEST_FNS = new Set(["test", "it"]);
const CONTAINER_FNS = new Set(["describe", "suite"]);

export function isSrcSpecifier(spec: string): boolean {
  if (spec.startsWith("@g-group/")) return true;
  return spec.startsWith(".") && !/\.test(\.ts)?$/.test(spec) && !spec.includes("fixtures");
}

export function analyzeTestFile(code: string, file: string): TestFileInfo {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const testNames = new Map<string, "test" | "container">(); // 本地名 → 种类
  const testNs = new Set<string>(); // import * as nt from "node:test" / import nt from "node:test"
  const assertFns = new Set<string>(); // 直接调用即断言的本地名(assert、equal、ok…)
  const assertNs = new Set<string>(); // 命名空间,其成员调用是断言
  const src = new Set<string>();

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    const c = st.importClause;
    const named = c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.filter((e) => !e.isTypeOnly) : [];
    const nsName = c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? c.namedBindings.name.text : undefined;
    if (spec === "node:test" || spec === "test") {
      if (c.name) { testNames.set(c.name.text, "test"); testNs.add(c.name.text); }
      if (nsName) testNs.add(nsName);
      for (const e of named) {
        const orig = (e.propertyName ?? e.name).text;
        if (TEST_FNS.has(orig)) testNames.set(e.name.text, "test");
        else if (CONTAINER_FNS.has(orig)) testNames.set(e.name.text, "container");
      }
    } else if (/^(node:)?assert(\/strict)?$/.test(spec)) {
      if (c.name) { assertFns.add(c.name.text); assertNs.add(c.name.text); }
      if (nsName) assertNs.add(nsName);
      for (const e of named) assertFns.add(e.name.text);
    } else if (isSrcSpecifier(spec)) {
      if (c.name) src.add(c.name.text);
      if (nsName) src.add(nsName);
      for (const e of named) src.add(e.name.text);
    }
  }

  // 识别 test(...) / it.skip(...) / nt.test(...) / test.only(...) 等调用形式
  const classify = (callee: ts.Expression): { kind: "test" | "container"; modifiers: string[] } | undefined => {
    const mods: string[] = [];
    let e = callee;
    while (ts.isPropertyAccessExpression(e)) {
      const nm = e.name.text;
      if (ts.isIdentifier(e.expression) && testNs.has(e.expression.text) && (TEST_FNS.has(nm) || CONTAINER_FNS.has(nm))) {
        return { kind: TEST_FNS.has(nm) ? "test" : "container", modifiers: mods };
      }
      mods.unshift(nm);
      e = e.expression;
    }
    if (ts.isIdentifier(e) && testNames.has(e.text)) return { kind: testNames.get(e.text)!, modifiers: mods };
    return undefined;
  };

  const isLit = (e: ts.Expression) => ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand));

  const analyzeBody = (fn: ts.ArrowFunction | ts.FunctionExpression) => {
    // 测试上下文参数 t:t.assert.xxx 也是断言
    const ctxName = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : undefined;
    // 污点:直接或间接由被测源码符号算出来的局部变量
    const tainted = new Set<string>();
    const mentions = (n: ts.Node): boolean => {
      let hit = false;
      const w = (x: ts.Node) => { if (hit) return; if (ts.isIdentifier(x) && (src.has(x.text) || tainted.has(x.text))) hit = true; ts.forEachChild(x, w); };
      w(n);
      return hit;
    };
    for (let changed = true; changed;) {
      changed = false;
      const w = (x: ts.Node) => {
        let target: string | undefined, value: ts.Node | undefined;
        if (ts.isVariableDeclaration(x) && x.initializer) { value = x.initializer; if (ts.isIdentifier(x.name)) target = x.name.text; else { const names: string[] = []; const collect = (b: ts.Node) => { if (ts.isIdentifier(b)) names.push(b.text); ts.forEachChild(b, collect); }; collect(x.name); for (const nm of names) if (!tainted.has(nm) && mentions(value)) { tainted.add(nm); changed = true; } } }
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(x.left)) { target = x.left.text; value = x.right; }
        if (target && value && !tainted.has(target) && mentions(value)) { tainted.add(target); changed = true; }
        ts.forEachChild(x, w);
      };
      w(fn.body);
    }
    let asserts = 0, srcAsserts = 0;
    const constAsserts: string[] = [];
    const isAssertCallee = (e: ts.Expression): boolean => {
      if (ts.isIdentifier(e)) return assertFns.has(e.text);
      if (ts.isPropertyAccessExpression(e)) {
        let root: ts.Expression = e;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && assertNs.has(root.text)) return true;
        if (ctxName && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === ctxName && e.expression.name.text === "assert") return true;
      }
      return false;
    };
    const w = (x: ts.Node) => {
      if (ts.isCallExpression(x) && isAssertCallee(x.expression)) {
        asserts++;
        const callee = x.expression.getText(sf);
        const args = [...x.arguments];
        const judged = /throws|rejects/.test(callee) ? args.slice(0, 1) : args.slice(0, 2);
        if (judged.some((a) => mentions(a))) srcAsserts++;
        if (args.length > 0 && args.slice(0, Math.min(2, args.length)).every(isLit) && !/throws|rejects|fail/.test(callee)) constAsserts.push(x.getText(sf).slice(0, 60));
      }
      ts.forEachChild(x, w);
    };
    w(fn.body);
    return { asserts, srcAsserts, constAsserts };
  };

  const tests: TestDecl[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const k = classify(n.expression);
      if (k) {
        const [nameArg, ...rest] = n.arguments;
        const fn = rest.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        const name = nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
        if (k.kind === "test") {
          if (!name) errors.push(`第 ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} 行的测试名不是字面字符串,无法稳定识别`);
          else if (!fn) errors.push(`"${name}":测试体不是内联函数,无法分析`);
          else tests.push({ name, body: fn.getText(sf), modifiers: k.modifiers, ...analyzeBody(fn) });
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // 绑定之外还有人调用叫 test/it 的东西:多半是别名没识别出来,宁可报出来
  if (tests.length === 0) errors.push("没识别出任何 node:test 测试(测试函数必须从 node:test 导入)");
  const seen = new Set<string>();
  for (const t of tests) { if (seen.has(t.name)) errors.push(`测试名 "${t.name}" 在同一文件里重复,身份不唯一`); seen.add(t.name); }
  return { tests, errors };
}

/** R-04 的判定:每条测试必须有断言、至少一条断言判的是被测源码的结果、没有恒定断言、不许 skip/todo/only */
export function lintTestFile(code: string, file: string): string[] {
  const { tests, errors } = analyzeTestFile(code, file);
  const out = [...errors];
  for (const t of tests) {
    if (t.modifiers.some((m) => /^(skip|todo|only)$/.test(m))) out.push(`"${t.name}":不许提交 .${t.modifiers.join(".")} 的测试`);
    if (t.asserts === 0) out.push(`"${t.name}":没有任何断言`);
    else if (t.srcAsserts === 0) out.push(`"${t.name}":没有一条断言判的是被测源码的结果(只测 mock 或复制逻辑)`);
    for (const c of t.constAsserts) out.push(`"${t.name}":恒真/恒定断言 ${c}`);
  }
  return out;
}
