// 同步观察器:Debugger 在真实源码的所有可停位置暂停;每次停下读独立的描述符基线。
// 不冻结对象、不替换内置方法、不代理被测值。只承诺由本文件的双侧控制校准的写法,
// 不声称能观察无停点的任意本机代码。测试和变异都执行同一实际 plugins.ts。
import inspector from 'node:inspector';
import vm from 'node:vm';
import { createHook } from 'node:async_hooks';
import { types } from 'node:util';
import { parentPort } from 'node:worker_threads';

const session = new inspector.Session();
session.connect();
function post(method, params = {}) {
  let result, error, done = false;
  session.post(method, params, (e, r) => { error = e; result = r; done = true; });
  if (!done) throw new Error(`调试协议没有同步返回:${method}`);
  if (error) throw error;
  return result;
}
const scripts = [];
session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params));
post('Runtime.enable');
post('Debugger.enable');
const { createRegistry } = await import('../src/plugins.ts');

// 根不是具名对象清单:globalThis 的全部自有数据属性(含符号键),再沿描述符/原型闭包。
// 不调用访问器;get/set 函数本身入集。Proxy 和可识别的外 realm 原型链停止。
// 无原型记录无法从 JS 判定 realm,按显式根可达的数据记录收录,不声称识别所有 realm。
const isRef = v => v !== null && (typeof v === 'object' || typeof v === 'function');
function sameRealm(v) {
  if (Object.getPrototypeOf(v) === null) return true;
  for (let p = v; p !== null; p = Object.getPrototypeOf(p)) {
    if (types.isProxy(p)) return false;
    if (p === Object.prototype || p === Function.prototype) return true;
  }
  return false;
}
function closure(roots) {
  const all = new Set();
  function add(v) {
    if (!isRef(v) || types.isProxy(v) || !sameRealm(v)) return;
    all.add(v);
    if (all.size > 4096) throw new Error('观察闭包超过 4096,不允许静默截断');
  }
  roots.forEach(add);
  for (const o of all) {
    const ds = Object.getOwnPropertyDescriptors(o);
    for (const key of Reflect.ownKeys(ds)) {
      const d = ds[key];
      if (Object.hasOwn(d, 'value')) add(d.value);
      else { add(d.get); add(d.set); }
    }
    add(Object.getPrototypeOf(o));
  }
  return [...all];
}
const hosts = closure([globalThis]);
// 以下名字只作为标定目标与覆盖断言,不参与根/边的发现算法。
const targets = { JSON, 'Intl.DateTimeFormat.prototype': Intl.DateTimeFormat.prototype,
  Math, 'Intl.Collator.prototype': Intl.Collator.prototype, 'WebAssembly.Table.prototype': WebAssembly.Table.prototype };
const marker = Symbol('neutral-edge'), leaf = {}, hidden = {}, foreign = vm.runInNewContext('({})'), proxy = new Proxy({}, {});
let getterCalls = 0;
const getter = () => { getterCalls++; return hidden; };
const sample = { [marker]: leaf, foreign, proxy };
Object.defineProperty(sample, 'accessor', { get: getter });
const sampled = closure([sample]);
const included = Object.fromEntries(Object.entries(targets).map(([k,v]) => [k, hosts.includes(v)]));
Object.assign(included, { globalThis: hosts.includes(globalThis), 'symbol-edge': sampled.includes(leaf),
 'getter-function': sampled.includes(getter), 'getter-value': sampled.includes(hidden), foreign: sampled.includes(foreign), proxy: sampled.includes(proxy) });
if (getterCalls !== 0) throw new Error('观察闭包意外调用了访问器');
const snap = (o) => ({ proto: Object.getPrototypeOf(o), extensible: Object.isExtensible(o), descriptors: Object.getOwnPropertyDescriptors(o) });
const same = (a, b) => {
  if (a.proto !== b.proto || a.extensible !== b.extensible) return false;
  const ak = Reflect.ownKeys(a.descriptors), bk = Reflect.ownKeys(b.descriptors);
  if (ak.length !== bk.length || ak.some((k) => !Object.hasOwn(b.descriptors, k))) return false;
  return ak.every((k) => {
    const x = a.descriptors[k], y = b.descriptors[k];
    return ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((p) => Object.hasOwn(x, p) === Object.hasOwn(y, p) && Object.is(x[p], y[p]));
  });
};
let armed = false, watched = [], bases = [], changes = new Set(), pauses = 0, events = 0, observerError;
function inspect() {
  for (let i = 0; i < watched.length; i++) if (!same(snap(watched[i]), bases[i])) changes.add(i === 0 && !hosts.includes(watched[i]) ? 'returned' : 'builtin');
}
session.on('Debugger.paused', () => {
  try { if (armed) { pauses++; inspect(); } } catch (e) { observerError = String(e); }
  finally { post('Debugger.resume'); }
});
function breakpoints(script) {
  const { locations } = post('Debugger.getPossibleBreakpoints', { start: { scriptId: script.scriptId, lineNumber: 0 }, end: { scriptId: script.scriptId, lineNumber: script.endLine, columnNumber: script.endColumn } });
  for (const location of locations) post('Debugger.setBreakpoint', { location });
  return locations.length;
}
const product = scripts.find((s) => s.url.endsWith('/src/plugins.ts'));
if (!product) throw new Error('找不到实际 plugins.ts 调试脚本');
const productPoints = breakpoints(product);

// 与实际源码使用同一观察路径;每个写入和恢复都是可停语句,源码变异另作标定。
const control = post('Runtime.compileScript', { expression: `globalThis.__neutral_window_control = (function(o, what, withEvent) {
  if (what === 'value-assign') { const old = o.then; o.then = 1; if (withEvent) void Promise.resolve(); o.then = old; }
  if (what === 'value-define') { const old = Object.getOwnPropertyDescriptor(o, 'then'); Object.defineProperty(o, 'then', { ...old, value: 1 }); if (withEvent) void Promise.resolve(); Object.defineProperty(o, 'then', old); }
  if (what === 'value-reflect') { const old = o.then; Reflect.set(o, 'then', 1); if (withEvent) void Promise.resolve(); Reflect.set(o, 'then', old); }
  if (what === 'map-define') { Object.defineProperty(Map.prototype, '__neutral_temporary__', { value: 1, configurable: true }); if (withEvent) void Promise.resolve(); Reflect.deleteProperty(Map.prototype, '__neutral_temporary__'); }
  if (what === 'weakmap-reflect') { Reflect.defineProperty(WeakMap.prototype, '__neutral_temporary__', { value: 1, configurable: true }); if (withEvent) void Promise.resolve(); Reflect.deleteProperty(WeakMap.prototype, '__neutral_temporary__'); }
  if (what === 'flags') { const d = Object.getOwnPropertyDescriptor(o, 'then'); Object.defineProperty(o, 'then', { ...d, enumerable: !d.enumerable }); if (withEvent) void Promise.resolve(); Object.defineProperty(o, 'then', d); }
  if (what === 'prototype') { const p = Object.getPrototypeOf(o); Object.setPrototypeOf(o, null); if (withEvent) void Promise.resolve(); Object.setPrototypeOf(o, p); }
  if (what === 'extensible') { Object.preventExtensions(o); if (withEvent) void Promise.resolve(); }
  if (what.startsWith('namespace:')) { Object.defineProperty(o, '__neutral_temporary__', { value: 1, configurable: true }); if (withEvent) void Promise.resolve(); Reflect.deleteProperty(o, '__neutral_temporary__'); }
  if (what === 'clean' && withEvent) void Promise.resolve();
  return 'done';
})`, sourceURL: 'neutral-window-controls.js', persistScript: true });
post('Runtime.runScript', { scriptId: control.scriptId });
const controlScript = scripts.find((s) => s.scriptId === control.scriptId);
const controlPoints = breakpoints(controlScript);
const hook = createHook({ init() { if (armed) events++; } });

const make = () => { const p = Promise.resolve([]); Object.defineProperty(p, 'then', { value: function pluginFn() {}, writable: true, configurable: true }); return p; };
function begin(o, plugin) { watched = [...new Set([o, ...hosts, ...closure([o, plugin])])]; bases = watched.map(snap); pauses = 0; events = 0; changes = new Set(); observerError = undefined; armed = true; }
function end() { inspect(); armed = false; return { changed: [...changes], pauses, events, restored: watched.every((o, i) => same(snap(o), bases[i])), observerError }; }
const controls = [];
for (const what of ['clean', 'value-assign', 'value-define', 'value-reflect', 'map-define', 'weakmap-reflect']) for (const withEvent of [false, true]) {
  const o = make();
  hook.enable();
  // 临时引用在基线之前设好,暂停的源码本身不会改它。
  globalThis.__neutral_observer_object = o;
  begin(o);
  const r = post('Runtime.evaluate', { expression: `__neutral_window_control(__neutral_observer_object, ${JSON.stringify(what)}, ${withEvent})` });
  controls.push({ what, withEvent, exception: r.exceptionDetails?.text, ...end() });
}
const namespaceControls = [], shapeControls = [];
for (const [what, target] of [['clean', JSON], ...Object.entries(targets)]) for (const withEvent of [false, true]) {
  hook.enable();
  globalThis.__neutral_observer_object = target;
  begin(make());
  const r = post('Runtime.evaluate', { expression: `__neutral_window_control(__neutral_observer_object, ${JSON.stringify(what === 'clean' ? what : 'namespace:' + what)}, ${withEvent})` });
  namespaceControls.push({ what, withEvent, exception: r.exceptionDetails?.text, ...end() });
}
for (const what of ['clean','flags','prototype','extensible']) for (const withEvent of [false,true]) {
  const o = make();
  hook.enable();
  globalThis.__neutral_observer_object = o;
  begin(o);
  const r = post('Runtime.evaluate', { expression: `__neutral_window_control(__neutral_observer_object, ${JSON.stringify(what)}, ${withEvent})` });
  shapeControls.push({ what, withEvent, exception: r.exceptionDetails?.text, ...end() });
}
const actual = [];
hook.disable();
for (const withHook of [false, true]) for (const key of ['then', 'constructor']) for (const mode of ['send', 'pull']) {
  const o = Promise.resolve([]);
  Object.defineProperty(o, key, { value: function pluginFn() {}, writable: true, configurable: true });
  if (withHook) hook.enable(); else hook.disable();
  const reg = createRegistry({ now: () => 0 });
  const plugin = mode === 'send' ? { kind: 'outbound-channel', id: 'p', endpoint: 'A', idempotency: 'none', send: () => o } : { kind: 'data-source', id: 'p', sources: ['g'], pull: () => o };
  reg.register(plugin);
  const reachable = closure([o, plugin]);
  included['plugin-function'] = reachable.includes(plugin.send ?? plugin.pull);
  included['returned-function'] = reachable.includes(Object.getOwnPropertyDescriptor(o, key).value);
  begin(o, plugin);
  const pending = mode === 'send' ? reg.send('p', { action_id: 'a', payload: 'x' }) : reg.pull('p', 'g');
  const observed = end();
  const result = await pending;
  actual.push({ mode, key, withHook, result, ...observed });
}
hook.disable();
session.disconnect();
const out = { productPoints, controlPoints, hostCount: hosts.length, includesMap: hosts.includes(Map.prototype), includesWeakMap: hosts.includes(WeakMap.prototype), included, namespaceControls, shapeControls, controls, actual };
if (parentPort) parentPort.postMessage(out); else console.log(JSON.stringify(out, null, 2));
