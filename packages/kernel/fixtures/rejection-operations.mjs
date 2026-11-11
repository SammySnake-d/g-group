// 测试专用、fail-closed 的拒收操作语法检查;不进入产品运行时。
// 这是固定窗口的可维护操作白名单,不是任意 JavaScript 的纯度证明。边界见 proof/r18-notes.md。
import fs from 'node:fs';
import ts from 'typescript';

export function auditRejectionSource(code) {
  const sf = ts.createSourceFile('plugins.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems = [];
  if (sf.parseDiagnostics.length) problems.push('拒绝无法解析的源码');
  const bad = (n, why) => problems.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${why}`);
  const printer = ts.createPrinter({ removeComments: true });
  const text = n => printer.printNode(ts.EmitHint.Unspecified, n, sf);
  const compact = n => text(n).replace(/\s/g, '');
  const all = [];
  function walk(n) { all.push(n); ts.forEachChild(n, walk); }
  walk(sf);
  const one = (name, pred) => {
    const ns = all.filter(n => pred(n) && n.name && text(n.name) === name);
    if (ns.length !== 1) { problems.push(`窗口绑定 ${name} 必须恰好一个`); return; }
    return ns[0];
  };
  const bindings = new Map();
  function binding(n) {
    if (ts.isIdentifier(n)) bindings.set(n.text, [...(bindings.get(n.text) ?? []), n]);
    else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) for (const e of n.elements) if (ts.isBindingElement(e)) binding(e.name);
  }
  for (const n of all) {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportClause(n)) {
      // Binding patterns are handled from their owning declaration only.
      if (!ts.isBindingElement(n) && n.name) binding(n.name);
    }
  }
  for (const name of ['Object','Reflect','Promise','Set','undefined']) if (bindings.has(name)) problems.push(`不许遮蔽原生绑定 ${name}`);
  for (const name of ['types','TRACKING','isTracking','safeId','isPlainPromise','unknown']) if (bindings.get(name)?.length !== 1) problems.push(`保护绑定 ${name} 缺失或被遮蔽`);
  const util = all.filter(n => ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'node:util');
  if (util.length !== 1 || util[0].importClause?.namedBindings?.elements?.some(n => n.name.text === 'types' && (!n.propertyName || n.propertyName.text === 'types')) !== true) problems.push('types 必须直接来自 node:util');
  const constant = one('NON_PROMISE_PULL',ts.isVariableDeclaration);
  if (!constant?.initializer || !ts.isStringLiteral(constant.initializer) || !(constant.parent.flags & ts.NodeFlags.Const)) problems.push('拒收 detail 必须来自模块私有 const 字符串');
  const tracking = one('TRACKING', ts.isVariableDeclaration);
  if (!tracking?.initializer || compact(tracking.initializer) !== 'newSet(["async_id_symbol","trigger_async_id_symbol"])' || !(tracking.parent.flags & ts.NodeFlags.Const)) problems.push('TRACKING 必须为模块私有的固定 const Set');
  // 禁止别名泄露和其它用途,不仅仅是禁止直接 add/delete。
  for (const n of all.filter(n => ts.isIdentifier(n) && ['TRACKING','isTracking','safeId','isPlainPromise','unknown'].includes(n.text))) {
    const p = n.parent;
    if (p.name === n && (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p))) continue;
    if (n.text === 'TRACKING' && ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'has' && ts.isCallExpression(p.parent) && p.parent.expression === p) continue;
    if (n.text !== 'TRACKING' && ts.isCallExpression(p) && p.expression === n) continue;
    bad(n, `保护绑定 ${n.text} 不能重赋值或取别名`);
  }
  // 类型节点不执行;值语法只认以下封闭集合,默认拒绝新语法。
  const calls = new Map([
    ['types.isPromise',1], ['types.isProxy',1], ['Object.getPrototypeOf',1], ['Object.hasOwn',2],
    ['Object.isExtensible',1], ['Reflect.ownKeys',1], ['Object.getOwnPropertyDescriptor',2],
    ['TRACKING.has',1], ['isTracking',1], ['safeId',1], ['isPlainPromise',1], ['unknown',2],
  ]);
  const callArgs = new Map([
    ['types.isPromise', ['x']], ['types.isProxy', ['x']], ['Object.getPrototypeOf', ['x']],
    ['Object.hasOwn', ['x,"then"', 'x,"constructor"']], ['Object.isExtensible', ['x']],
    ['Reflect.ownKeys', ['x']], ['Object.getOwnPropertyDescriptor', ['x,k']],
    ['TRACKING.has', ['k.description??""']], ['isTracking', ['k']], ['safeId', ['d.value']],
    ['isPlainPromise', ['pending', 'returned']],
  ]);
  const reads = new Set(['Promise.prototype','k.description','d.value']);
  const ops = new Set(['===','!==','&&','||','??','in']);
  function expr(n, vars, object = false) {
    if (!n) return;
    if (ts.isParenthesizedExpression(n)) return expr(n.expression,vars,object);
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || [ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(n.kind)) return;
    if (ts.isIdentifier(n)) { if (!vars.has(n.text) && n.text !== 'undefined') bad(n,`非本地值 ${n.text}`); return; }
    if (ts.isTypeOfExpression(n)) return expr(n.expression,vars);
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return expr(n.operand,vars);
    if (ts.isBinaryExpression(n) && ops.has(text(n.operatorToken))) { expr(n.left,vars); expr(n.right,vars); return; }
    if (ts.isPropertyAccessExpression(n) && reads.has(text(n)) && (text(n) === 'Promise.prototype' || vars.has(text(n.expression)))) return;
    if (ts.isCallExpression(n) && !n.questionDotToken && calls.get(text(n.expression)) === n.arguments.length) {
      // 调用名与参数来源一起约束,不能把 Promise 当作 Symbol 传给 isTracking。
      const callee = text(n.expression);
      if (callee === 'unknown') {
        if (!n.arguments.every(a => ts.isStringLiteral(a))) bad(n,'拒收 unknown 的参数必须是静态字符串');
      } else if (!callArgs.get(callee)?.includes(n.arguments.map(compact).join(','))) bad(n,'只读调用参数不在已证明的值域');
      // 只准点号调用,禁止 computed、call/apply、别名、回调及动态求值。
      for (const a of n.arguments) expr(a,vars);
      return;
    }
    if (object && ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) expr(p.initializer,vars);
        else if (ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer) expr(p.name,vars);
        else bad(p,'结果只准普通静态数据属性');
      }
      return;
    }
    bad(n,`操作不在白名单: ${ts.SyntaxKind[n.kind]} ${text(n).slice(0,100)}`);
  }
  function stmt(n, vars, ledger = false) {
    if (ts.isBlock(n)) { for (const s of n.statements) stmt(s,new Set(vars),ledger); return; }
    if (ts.isIfStatement(n)) { expr(n.expression,vars); stmt(n.thenStatement,vars,ledger); if (n.elseStatement) stmt(n.elseStatement,vars,ledger); return; }
    if (ts.isReturnStatement(n)) { expr(n.expression,vars,true); return; }
    if (ts.isContinueStatement(n) && !n.label) return;
    if (ts.isVariableStatement(n) && n.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== 'd' || !d.initializer || compact(d.initializer) !== 'Object.getOwnPropertyDescriptor(x,k)') bad(d,'只允许新的局部描述符 d');
        else { expr(d.initializer,vars); vars.add('d'); }
      }
      return;
    }
    if (ts.isForOfStatement(n) && !n.awaitModifier && compact(n.initializer) === 'constk' && compact(n.expression) === 'Reflect.ownKeys(x)') {
      expr(n.expression,vars); const inner = new Set([...vars,'k','d']); stmt(n.statement,inner,ledger); return;
    }
    if (ledger && ts.isExpressionStatement(n) && compact(n.expression) === 'entry.state="delivery-unknown"') return;
    bad(n,`语句不在白名单: ${ts.SyntaxKind[n.kind]}`);
  }
  for (const name of ['isPlainPromise','isTracking','safeId','unknown']) {
    const d = one(name, name === 'isPlainPromise' ? ts.isFunctionDeclaration : ts.isVariableDeclaration);
    const fn = name === 'isPlainPromise' ? d : d?.initializer;
    const expectedParams = { isPlainPromise: 'x', isTracking: 'k', safeId: 'v', unknown: 'reason,detail' };
    if (fn?.parameters?.map(p => text(p.name)).join(',') !== expectedParams[name]) problems.push(`${name} 参数绑定变化,需重新审查值域`);
    if (fn?.asteriskToken || fn?.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) problems.push(`${name} 不允许异步或生成器改变返回值域`);
    if (fn?.parameters) for (const p of fn.parameters) if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) bad(p,'保护函数参数不得有默认求值或解构');
    if (d && ts.isVariableDeclaration(d) && !(d.parent.flags & ts.NodeFlags.Const)) bad(d,'保护闭包必须为 const');
  }
  const plain = one('isPlainPromise', ts.isFunctionDeclaration);
  if (plain?.body) {
    const first = plain.body.statements[0];
    if (!first || compact(first) !== 'if(!types.isPromise(x)||types.isProxy(x))returnfalse;') problems.push('对象反射前必须先排除非 Promise 和 Proxy');
    stmt(plain.body,new Set(['x','k','d']));
  }
  for (const name of ['isTracking','safeId']) {
    const d = one(name,ts.isVariableDeclaration);
    if (!d?.initializer || !ts.isArrowFunction(d.initializer) || ts.isBlock(d.initializer.body)) { problems.push(`${name} 必须是纯表达式箭头函数`); continue; }
    if (name === 'isTracking' && compact(d.initializer.body) !== 'typeofk==="symbol"&&TRACKING.has(k.description??"")') problems.push('Symbol.description 之前必须按固定短路顺序保证 k 是 symbol');
    expr(d.initializer.body,new Set(name === 'isTracking' ? ['k'] : ['v']));
  }
  const unknown = one('unknown',ts.isVariableDeclaration);
  if (!unknown?.initializer || !ts.isArrowFunction(unknown.initializer) || !ts.isBlock(unknown.initializer.body)) problems.push('unknown 必须是局部结果构造闭包');
  else stmt(unknown.initializer.body,new Set(['reason','detail']),true);
  for (const [name,variable,method] of [['attemptOnce','pending','send'],['pull','returned','pull']]) {
    const fn = one(name, name === 'pull' ? ts.isMethodDeclaration : ts.isFunctionDeclaration);
    if (!fn?.body) continue;
    const ss = fn.body.statements;
    const positions = [...ss.keys()].filter(i => ts.isTryStatement(ss[i]) && ss[i].tryBlock.statements.some(s => ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && text(s.expression.left) === variable));
    if (positions.length !== 1) { problems.push(`${name} 找不到唯一交回边界`); continue; }
    const i = positions[0], t = ss[i], statements = t.tryBlock.statements;
    const assign = statements[0]?.expression;
    if (statements.length !== 1 || !assign || !ts.isBinaryExpression(assign) || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isCallExpression(assign.right) || text(assign.right.expression) !== `p.${method}` || t.finallyBlock) problems.push(`${name} 插件交回之后不能夹带其它操作`);
    const guard = ss[i+1];
    if (!guard || !ts.isIfStatement(guard) || compact(guard.expression) !== `!isPlainPromise(${variable})` || guard.elseStatement || !ts.isReturnStatement(guard.thenStatement)) { problems.push(`${name} 插件交回后必须立即判定并拒收返回`); continue; }
    expr(guard.expression,new Set([variable]));
    stmt(guard.thenStatement,new Set([variable,'NON_PROMISE_PULL']));
  }
  return problems;
}

const file = new URL('../src/plugins.ts', import.meta.url);
const code = fs.readFileSync(file,'utf8');
const branch = 'if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) return false;';
const add = (target,event=false) => `{ Object.defineProperty(${target}, "__neutral_temporary__", { value: 1, configurable: true }); ${event ? 'void Promise.resolve();' : ''} Reflect.deleteProperty(${target}, "__neutral_temporary__"); return false; }`;
const cases = [
 ['R14-M1',branch,branch.replace('return false;',add('x',true))],
 ['R15-1',branch,branch.replace('return false;',add('x'))],
 ['R15-2',branch,branch.replace('return false;',add('Promise.prototype'))],
 ['R16-1',branch,branch.replace('return false;','{ const d = Object.getOwnPropertyDescriptor(x, "then"); if (d) { Object.defineProperty(x,"then",{...d,value:1}); Object.defineProperty(x,"then",d); } return false; }')],
 ['R16-2',branch,branch.replace('return false;',add('Map.prototype'))],
 ['R17-JSON',branch,branch.replace('return false;',add('JSON'))],
 ['R17-Intl',branch,branch.replace('return false;',add('Intl.DateTimeFormat.prototype'))],
 ['alias',branch,branch.replace('return false;','{ const f = Object.defineProperty; f(JSON,"__neutral__",{value:1,configurable:true}); Reflect.deleteProperty(JSON,"__neutral__"); return false; }')],
 ['computed',branch,branch.replace('return false;','{ Object["defineProperty"](JSON,"__neutral__",{value:1,configurable:true}); Reflect.deleteProperty(JSON,"__neutral__"); return false; }')],
 ['safeId','typeof v === "number" || v === undefined','(Reflect.set(JSON,"__neutral__",1), typeof v === "number" || v === undefined)'],
 ['new-Function',branch,branch.replace('return false;','{ new Function("o", "o.__neutral__=1; delete o.__neutral__")(JSON); return false; }')],
 ['eval',branch,branch.replace('return false;','{ eval("JSON.__neutral__=1; delete JSON.__neutral__"); return false; }')],
 ['shadow-Object','function isPlainPromise(x: unknown): x is Promise<unknown> {','function isPlainPromise(x: unknown): x is Promise<unknown> { const Object = globalThis.Object;'],
 ['after-return','if (!isPlainPromise(returned))','Reflect.set(JSON,"__neutral__",1); if (!isPlainPromise(returned))'],
];
const controls = cases.map(([name,from,to]) => ({name, problems: code.split(from).length === 2 ? auditRejectionSource(code.replace(from,to)) : ['注入点不唯一(当前源码已有变异)']}));
console.log(JSON.stringify({problems: auditRejectionSource(code), controls}));
